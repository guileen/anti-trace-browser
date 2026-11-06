"""Run the independent fixture in an installed production Chrome, in a fresh context."""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path

from playwright.async_api import async_playwright


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", required=True)
    parser.add_argument("--url", required=True)
    parser.add_argument("--seed", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    output = Path(args.output)
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(executable_path=args.executable, headless=True)
        try:
            context = await browser.new_context(viewport={"width": 1280, "height": 800}, device_scale_factor=1,
                                                locale="en-US", timezone_id="UTC")
            page = await context.new_page()
            await page.goto(args.url)
            request_id = "chrome-reference"
            request = {"request_id": request_id, "options": {"seed": args.seed, "run_id": request_id}}
            await page.evaluate("request => { document.documentElement.setAttribute('data-authenticity-request', JSON.stringify(request)); document.dispatchEvent(new Event('authenticity-collect')); }", request)
            await page.wait_for_function("() => {const out=document.getElementById('authenticity-output');return out?.getAttribute('data-status')==='complete' && out.getAttribute('data-request-id')==='chrome-reference'}", timeout=100000)
            raw = json.loads(await page.locator("#authenticity-output").text_content())
            if raw.get("error"):
                raise RuntimeError(raw["error"])
            with (output / "raw.json").open("x") as file:
                json.dump(raw, file, ensure_ascii=False)
            image = await page.screenshot()
            (output / "viewport.png").write_bytes(image)
            print(json.dumps({"version": browser.version, "executable": args.executable,
                              "raw": str(output / "raw.json"), "screenshot": str(output / "viewport.png"),
                              "screenshot_sha256": hashlib.sha256(image).hexdigest(),
                              "mode": "headless installed production Chrome; Playwright default automation flags; reference computation, not challenge baseline",
                              "conditions": {"viewport": [1280, 800], "dpr": 1, "timezone": "UTC", "locale": "en-US", "fonts": "Host-installed fonts; not claimed byte-identical to native asset set"}}))
        finally:
            await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
