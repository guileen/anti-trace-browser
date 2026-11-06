"""Run with: anti-trace run work examples/flow.py -- https://example.com/

Only run scripts you trust: main has the same local permissions as you do.
The optional first script argument chooses the URL. All page observations are
ordinary data, not Python instructions. There are no automatic action retries.
"""


async def main(page, context, tools):
    arguments = tools.args or []
    url = arguments[0] if isinstance(arguments, list) and arguments else (
        arguments.get("url", "https://example.com/") if isinstance(arguments, dict)
        else "https://example.com/"
    )
    navigation = await page.goto(url, wait_until="domcontentloaded", timeout=20000)
    await page.locator("body").wait_for(state="visible", timeout=10000)

    # This loop and branch run in the script process, in one live session.
    links = page.get_by_role("link")
    rows = []
    for index in range(min(await links.count(), 5)):
        link = links.nth(index)
        if await link.is_visible():
            rows.append({
                "text": await link.inner_text(),
                "href": await link.get_attribute("href"),
            })

    observation = await tools.axtree(max_elements=30, max_text=80)
    await context.refresh_pages()
    return {
        "navigation": navigation,
        "title": await page.title(),
        "url": page.url,
        "links": rows,
        "pages": len(context.pages),
        "observation": observation,
    }
