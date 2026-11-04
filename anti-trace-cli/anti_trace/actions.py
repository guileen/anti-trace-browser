"""Page primitives for agents: read-only axtree, refs, and interaction."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from playwright.async_api import Page

MAX_ELEMENTS = 300
MAX_TEXT = 120

SNAPSHOT_JS = """() => {
  const cssPath = (el) => {
    if (el.id) {
      const sel = '#' + CSS.escape(el.id);
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
      if (parts.length >= 10) break;
    }
    return 'html > ' + parts.join(' > ');
  };
  const selector = 'a, button, input, textarea, select, summary, [role="button"], [role="link"], '
    + '[role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="switch"], '
    + '[role="textbox"], [role="combobox"], [contenteditable=""], [contenteditable="true"], '
    + '[tabindex]:not([tabindex="-1"])';
  const vh = window.innerHeight, vw = window.innerWidth;
  const rows = [];
  for (const el of document.querySelectorAll(selector)) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (el.disabled) continue;
    const text = (el.innerText || el.value || el.placeholder
      || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ');
    const inView = rect.bottom > 0 && rect.top < vh && rect.right > 0 && rect.left < vw;
    rows.push({
      el,
      inView,
      row: {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        name: (el.getAttribute('name') || undefined),
        text: text.slice(0, %d),
        placeholder: el.getAttribute('placeholder') || undefined,
        value: (typeof el.value === 'string' && el.value) ? el.value.slice(0, 40) : undefined,
        disabled: el.disabled || undefined,
        checked: (typeof el.checked === 'boolean' && el.tagName === 'INPUT') ? el.checked : undefined,
      },
    });
  }
  rows.sort((a, b) => (a.inView === b.inView ? 0 : a.inView ? -1 : 1));
  const out = rows.slice(0, %d).map((entry, index) => ({
    ref: '@' + (index + 1), ...entry.row, selector: cssPath(entry.el), in_viewport: entry.inView,
  }));
  return {
    title: document.title,
    url: location.href,
    elements: out,
    total: rows.length,
    truncated: rows.length > out.length,
    frames: document.querySelectorAll('iframe').length,
  };
}""" % (MAX_TEXT, MAX_ELEMENTS)


class ActionError(RuntimeError):
    pass


async def axtree(page: Page, screenshot: Path | None = None) -> dict[str, Any]:
    data = await page.evaluate(SNAPSHOT_JS)
    result: dict[str, Any] = {"status": "ok", "action": "axtree", **data}
    if screenshot is not None:
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        await page.screenshot(path=str(screenshot), timeout=20000)
        result["screenshot"] = str(screenshot.resolve())
    return result


async def _walk(page: Page) -> list[dict[str, Any]]:
    return (await page.evaluate(SNAPSHOT_JS))["elements"]


async def resolve(page: Page, target: str) -> str:
    """Turn a ref/text/css/xpath target into a CSS selector for Playwright."""
    target = target.strip()
    if not target:
        raise ActionError("empty target")
    if target.startswith("@"):
        elements = await _walk(page)
        index = int(target[1:]) - 1 if target[1:].isdigit() else -1
        if index < 0 or index >= len(elements):
            raise ActionError(f"{target} is not in the current axtree ({len(elements)} elements); run axtree again")
        return elements[index]["selector"]
    if target.startswith("css="):
        return target[4:]
    if target.startswith("xpath="):
        raise ActionError("xpath targets are not supported; use css= or @ref")
    if target.startswith("text="):
        quoted = target[5:].strip().strip('"')
        return f"text={quoted}"
    return f"text={target}"


async def _settle(page: Page, timeout: int = 5000) -> None:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=timeout)
    except Exception:  # noqa: BLE001 - navigation may not happen
        pass


async def run(page: Page, action: str, args: dict[str, Any], workdir: Path) -> dict[str, Any]:
    timeout = int(args.get("timeout") or 20000)

    if action == "goto":
        url = str(args.get("url") or "")
        if not url:
            raise ActionError("goto needs a url")
        if "://" not in url:
            url = "https://" + url
        response = await page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        return {
            "status": "ok", "action": "goto", "url": page.url, "title": await page.title(),
            "http_status": response.status if response is not None else None,
        }

    if action == "batch":
        # One IPC call for a whole sequence: the round trip a caller pays is the
        # process boundary, not the browser work.
        steps = args.get("steps") or []
        if not isinstance(steps, list) or not steps:
            raise ActionError("batch needs a non-empty list of steps")
        results: list[dict[str, Any]] = []
        for index, step in enumerate(steps):
            if not isinstance(step, dict) or "action" not in step:
                raise ActionError(f"step {index} needs an 'action'")
            try:
                results.append({"step": index, **await run(page, str(step["action"]), step.get("args") or {}, workdir)})
            except Exception as exc:  # noqa: BLE001 - report the failing step, keep the rest
                results.append({"step": index, "status": "error", "action": step.get("action"), "message": str(exc)})
                return {"status": "partial", "action": "batch", "failed_step": index, "results": results}
        return {"status": "ok", "action": "batch", "results": results}

    if action == "axtree":
        return await axtree(page, workdir / "axtree.png")

    if action == "click":
        selector = await resolve(page, str(args.get("target") or ""))
        locator = page.locator(selector).first
        await locator.wait_for(state="visible", timeout=timeout)
        await locator.click(timeout=timeout)
        await _settle(page)
        return {"status": "ok", "action": "click", "target": args.get("target"), "url": page.url, "title": await page.title()}

    if action == "type":
        selector = await resolve(page, str(args.get("target") or ""))
        text = str(args.get("text") or "")
        locator = page.locator(selector).first
        await locator.wait_for(state="visible", timeout=timeout)
        await locator.fill("", timeout=timeout)
        if args.get("fill"):
            await locator.fill(text, timeout=timeout)
        else:
            await locator.click(timeout=timeout)
            await locator.press_sequentially(text, delay=int(args.get("delay") or 12), timeout=timeout)
        if args.get("enter"):
            await locator.press("Enter", timeout=timeout)
            await _settle(page)
        return {"status": "ok", "action": "type", "target": args.get("target"), "length": len(text), "url": page.url}

    if action == "press":
        keys = str(args.get("keys") or "")
        if not keys:
            raise ActionError("press needs keys, e.g. Control+A or Enter")
        await page.keyboard.press(keys)
        await _settle(page)
        return {"status": "ok", "action": "press", "keys": keys, "url": page.url}

    if action == "hover":
        selector = await resolve(page, str(args.get("target") or ""))
        await page.locator(selector).first.hover(timeout=timeout)
        return {"status": "ok", "action": "hover", "target": args.get("target")}

    if action == "select":
        selector = await resolve(page, str(args.get("target") or ""))
        values = args.get("value") or args.get("values")
        values = values if isinstance(values, list) else [values]
        selected = await page.locator(selector).first.select_option(values, timeout=timeout)
        return {"status": "ok", "action": "select", "target": args.get("target"), "selected": selected}

    if action == "scroll":
        direction = str(args.get("direction") or "down")
        amount = int(args.get("amount") or 600)
        if direction == "up":
            await page.mouse.wheel(0, -amount)
        elif direction == "down":
            await page.mouse.wheel(0, amount)
        elif direction in {"top", "bottom"}:
            await page.evaluate(f"() => window.scrollTo(0, {0 if direction == 'top' else 'document.body.scrollHeight'})")
        else:
            raise ActionError(f"unknown scroll direction {direction!r}")
        return {"status": "ok", "action": "scroll", "direction": direction, "amount": amount}

    if action == "wait":
        if args.get("selector"):
            await page.locator(await resolve(page, str(args["selector"]))).first.wait_for(timeout=timeout)
            return {"status": "ok", "action": "wait", "selector": args["selector"]}
        if args.get("url_substring"):
            await page.wait_for_url(f"**{args['url_substring']}**", timeout=timeout)
            return {"status": "ok", "action": "wait", "url": page.url}
        await page.wait_for_timeout(int(args.get("ms") or 500))
        return {"status": "ok", "action": "wait", "ms": int(args.get("ms") or 500), "url": page.url}

    if action == "back":
        await page.go_back(wait_until="domcontentloaded", timeout=timeout)
        return {"status": "ok", "action": "back", "url": page.url, "title": await page.title()}

    if action == "reload":
        await page.reload(wait_until="domcontentloaded", timeout=timeout)
        return {"status": "ok", "action": "reload", "url": page.url, "title": await page.title()}

    if action == "screenshot":
        target = Path(args.get("file") or (workdir / f"screenshot-{int(time.time())}.png"))
        target = target if target.is_absolute() else (workdir / target)
        target.parent.mkdir(parents=True, exist_ok=True)
        await page.screenshot(path=str(target), full_page=bool(args.get("full_page")), timeout=timeout)
        return {"status": "ok", "action": "screenshot", "file": str(target.resolve()), "url": page.url}

    if action == "eval":
        code = str(args.get("js") or "")
        if not code:
            raise ActionError("eval needs js")
        if args.get("main_world"):
            code = "mw:" + code
        value = await page.evaluate(code)
        return {"status": "ok", "action": "eval", "result": value}

    if action == "cookies":
        cookies = await page.context.cookies()
        return {"status": "ok", "action": "cookies", "count": len(cookies), "cookies": cookies}

    if action == "tabs":
        pages = page.context.pages
        rows = []
        for index, item in enumerate(pages):
            try:
                title = await item.title()
            except Exception:  # noqa: BLE001
                title = ""
            rows.append({"index": index, "active": item is page, "url": item.url, "title": title})
        return {"status": "ok", "action": "tabs", "tabs": rows}

    if action == "tab_new":
        url = str(args.get("url") or "about:blank")
        if "://" not in url and url != "about:blank":
            url = "https://" + url
        await page.context.new_page()
        created = page.context.pages[-1]
        await created.goto(url, wait_until="domcontentloaded", timeout=timeout)
        return {"status": "ok", "action": "tab_new", "index": len(page.context.pages) - 1, "url": created.url}

    raise ActionError(f"unknown action {action!r}")
