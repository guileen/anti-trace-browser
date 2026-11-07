"""Page primitives for agents: read-only axtree, refs, and interaction."""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

from playwright.async_api import Page

from mioa_core.refs import ActionError, MAX_ELEMENTS, MAX_TEXT, RefStore


def references(page: Any) -> RefStore:
    value = getattr(page, "_anti_trace_references", None)
    if value is None:
        value = RefStore()
        page._anti_trace_references = value
    return value


async def axtree(page: Page, screenshot: Path | None = None, *, refs: RefStore | None = None,
                 max_elements: int = MAX_ELEMENTS, max_text: int = MAX_TEXT,
                 frame: str | None = None) -> dict[str, Any]:
    result = await (refs or references(page)).capture(page,max_elements=max_elements,max_text=max_text,frame=frame)
    if screenshot is not None:
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        await page.screenshot(path=str(screenshot), timeout=20000, caret="initial")
        result["screenshot"] = str(screenshot.resolve())
    return result


async def resolve(page: Page, target: str, refs: RefStore | None = None) -> Any:
    target = target.strip()
    if not target:
        raise ActionError("empty target")
    if target.startswith("@"):
        return await (refs or references(page)).resolve(page,target)
    if target.startswith("xpath="):
        raise ActionError("xpath targets are not supported; use css= or @ref")
    return page.locator(target[4:] if target.startswith("css=") else target if target.startswith("text=") else "text="+target).first


async def _settle(page: Page, timeout: int = 5000) -> None:
    try:
        await page.wait_for_load_state("domcontentloaded", timeout=timeout)
    except Exception:  # noqa: BLE001 - navigation may not happen
        pass


async def run(page: Page, action: str, args: dict[str, Any], workdir: Path, *, refs: RefStore | None = None) -> dict[str, Any]:
    timeout = int(args.get("timeout") or 20000)

    if action == "goto":
        url = str(args.get("url") or "")
        if not url:
            raise ActionError("goto needs a url")
        if "://" not in url and url != "about:blank":
            url = "https://" + url
        response = await page.goto(url, wait_until="domcontentloaded", timeout=timeout)
        return {
            "status": "ok", "action": "goto", "url": page.url, "title": await page.title(),
            "http_status": response.status if response is not None else None,
        }


    if action == "axtree":
        return await axtree(page,refs=refs,frame=args.get("frame"))

    if action == "click":
        locator = await resolve(page, str(args.get("target") or ""), refs)
        await locator.click(timeout=timeout)
        await _settle(page)
        return {"status": "ok", "action": "click", "target": args.get("target"), "url": page.url, "title": await page.title()}

    if action == "type":
        locator = await resolve(page, str(args.get("target") or ""), refs)
        text = str(args.get("text") or "")
        await locator.fill(text if args.get("fill") else "",timeout=timeout)
        if not args.get("fill"):
            await locator.press_sequentially(text,delay=int(args.get("delay") or 12),timeout=timeout)
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
        locator = await resolve(page, str(args.get("target") or ""), refs)
        await locator.hover(timeout=timeout)
        return {"status": "ok", "action": "hover", "target": args.get("target")}

    if action == "select":
        locator = await resolve(page, str(args.get("target") or ""), refs)
        values = args.get("value") or args.get("values")
        values = values if isinstance(values, list) else [values]
        selected = await locator.select_option(values, timeout=timeout)
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
            locator = await resolve(page, str(args["selector"]), refs)
            if str(args["selector"]).startswith("@"):
                await locator.wait_for_element_state("visible",timeout=timeout)
            else:
                await locator.wait_for(timeout=timeout)
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
        await page.screenshot(path=str(target), full_page=bool(args.get("full_page")), timeout=timeout, caret="initial")
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
