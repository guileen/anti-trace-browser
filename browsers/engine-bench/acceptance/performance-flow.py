"""One real managed session, equal DOM/JS and separately measured visual work."""
from pathlib import Path
import time


async def main(page, context, tools):
    stages = {}
    started = time.perf_counter()
    await page.goto(tools.args["url"])
    await page.wait_for_load_state("load")
    stages["navigation_ms"] = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    common = await page.evaluate(tools.args["expression"])
    stages["dom_js_roundtrip_ms"] = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    visual = await page.evaluate("""() => {
      const box = document.createElement('div'); box.id = 'performance-real-surface';
      box.style.cssText = 'position:fixed;left:0;top:0;width:240px;height:160px;background:rgb(240,20,30);z-index:2147483647';
      const canvas = document.createElement('canvas'); canvas.width=120;canvas.height=80;
      canvas.style.cssText='position:absolute;left:80px;top:50px;width:120px;height:80px';
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,120,80);
      ctx.fillStyle='#1462bd';ctx.beginPath();ctx.arc(55,35,20,0,Math.PI*2);ctx.fill();
      ctx.fillStyle='black';ctx.font='14px sans-serif';ctx.fillText('Real 你好 Ω',4,74);
      box.appendChild(canvas);document.body.appendChild(box);
      const r=box.getBoundingClientRect();
      return {viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,box:{x:r.x,y:r.y,width:r.width,height:r.height},canvas_pixel:Array.from(ctx.getImageData(55,35,1,1).data)};
    }""")
    images = []
    for index in range(2):
        if index:
            await page.evaluate("() => document.getElementById('performance-real-surface').style.background='rgb(10,40,230)'")
        image = await page.screenshot()
        path = Path(tools.args["output"]) / (tools.args["sample"] + "-" + str(index) + ".png")
        path.write_bytes(image)
        images.append({"path": str(path), "bytes": len(image)})
    stages["visual_roundtrip_ms"] = (time.perf_counter() - started) * 1000
    await page.evaluate("() => document.getElementById('performance-real-surface').remove()")
    return {"common": common, "visual": visual, "images": images, "stages": stages}
