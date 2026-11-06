# anti-trace

同一 CLI 管理 Camoufox、Obscura、Lightpanda 三个真实运行时。三者并行接受相同硬门槛，没有预选胜者；可创建、可导航或某个局部检查通过，不等于完整反追踪、持久化、GUI、兼容性与挑战验收通过。完整证据未齐全时严格状态为 **NOT_PASS**，不能视为已完成承诺。版本化要求见 [OpenSpec](../openspec/changes/evaluate-lightweight-runtime/proposal.md)；历史实验报告保留其原始日期与范围。

2026-11-04三路已完成同版459项/22场景采集，结论均为`NOT_PASS`；最终结果、已测失败与未测项见[本轮回执](../openspec/changes/evaluate-lightweight-runtime/tasks.md#验证口径与本轮回执)。Obscura的Canvas/Audio语义与Camoufox崩溃租约缺口保持显式；不把真实组件接入称为完整浏览器验收。

## 安装与运行时

```sh
cd anti-trace-browser/cli
uv sync
./bin/anti-trace setup
./bin/anti-trace create work --runtime camoufox --seed work-identity
./bin/anti-trace start work --url https://example.com/
./bin/anti-trace axtree work --json
./bin/anti-trace stop work
```

`setup` 获取锁定的 Camoufox Python 包对应浏览器，并校准实际宿主字体。Camoufox 默认运行时可用 `ANTI_TRACE_BROWSER` 指定；`create --native-binary PATH` 也可显式指定其可执行文件。Obscura 与 Lightpanda 使用固定上游提交对应的本地源码构建，默认路径与提交见 `anti_trace/native_spec.py` 的 `PINS`。可用 `ANTI_TRACE_OBSCURA_BINARY`、`ANTI_TRACE_LIGHTPANDA_BINARY` 或 `--native-binary PATH` 显式选择可执行文件；缺少可执行文件、字体或真实能力时返回明确错误，不使用替身浏览器。

```sh
./bin/anti-trace create rust-env --runtime obscura --seed rust-identity \
  --native-binary /absolute/path/to/obscura --allow-private-network
./bin/anti-trace create zig-env --runtime lightpanda --seed zig-identity \
  --native-binary /absolute/path/to/lightpanda --allow-private-network
```

字体来自真实 SFNT/TTC 文件：`--fonts host` 使用资产中的实际家族，`--fonts subset:N` 以种子确定固定子集（N 至少为8）。原生路线可重复 `--font-file PATH` 替换宿主字体集合；例如 `../browsers/engine-bench/candidates/lightpanda/assets/fonts/NotoSansCJKsc-Regular.otf` 是已固定摘要、附OFL-1.1许可的真实Noto CJK 2.004资产。Camoufox不支持直接加载该独立字体文件，宿主字体经过本机校准；同机结果不是跨宿主可移植保证。系统字体的再分发权不随归档自动获得。

## 命令面

```text
anti-trace create NAME [--runtime camoufox|obscura|lightpanda] [--seed SEED]
    [--overrides JSON|@FILE] [--native-binary PATH] [--fonts host|subset:N] [--font-file PATH ...]
    [--cores N] [--os macos|windows|linux] [--webrtc spoof|block]
    [--proxy URL|env:VARIABLE|DIRECT] [--egress-policy strict|observe]
    [--allow-private-network] [--force] [--json]
anti-trace start NAME [--headless] [--url URL] [--foreground] [--timeout SECONDS] [--json]
anti-trace stop NAME [--timeout SECONDS] [--json]
anti-trace list [--json]
anti-trace info NAME [--json]
anti-trace reset NAME [--json]
anti-trace rm NAME [--force] [--json]
anti-trace run NAME FILE.py [--args JSON] [--timeout SECONDS] [--max-output-bytes N] [--json]
anti-trace control NAME status|pause|resume|reclaim|cancel [--json]
anti-trace viewer NAME [--json]
anti-trace axtree NAME [--frame CSS] [--json]
anti-trace exec NAME ACTION [ARGUMENTS] [FLAGS]
anti-trace export NAME [FILE] [--include-credentials] [--json]
anti-trace import FILE [--name NAME] [--proxy URL|env:VARIABLE|DIRECT] [--native-binary PATH] [--json]
anti-trace migrate NAME [--native-binary PATH] [--overrides JSON|@FILE] [--json]
anti-trace migrate NAME --rollback SNAPSHOT [--json]
anti-trace attach NAME --cdp URL [--json]
anti-trace measure FILE.py (--browser chromium|--cdp URL) [--args JSON]
    [--timeout SECONDS] [--max-output-bytes N] [--headful] [--out DIR] [--json]
anti-trace audit NAME [--local] [--headers] [--echo-url URL] [--leaks] [--fp] [--all] [--json]
anti-trace field [NAME] [--sites URL,URL|--site-config FILE] [--out DIR]
    [--browser chromium|--cdp URL] [--settle SECONDS] [--timeout SECONDS] [--json]
anti-trace doctor [--json]
```

默认 `create` 为 Camoufox。`--os` 与 `--webrtc` 是 Camoufox 能力；原生运行时不接受未实现的 OS/WebRTC 改写。`--overrides` 是运行时验证的显式输入，不支持的字段必须报错。种子可为文本或十六进制；文本稳定归一化为 SHA-256。同运行时身份碰撞被拒绝。`--force` 仅替换已停止、无属主的环境，不绕过 lease。

Camoufox 配置代理且使用 `--egress-policy strict` 时，WebRTC 默认 `block`，防止代理之外的直连 UDP；显式 `--webrtc spoof` 被拒绝并返回 `capability_unavailable`，不会静默改写用户策略。直连或 `observe` 保留默认 `spoof`，也可显式选择 `block`。

JSON 错误提供稳定 `status=error`、`code`、`message`，返回非零。运行脚本保留完整错误证据：`ok/partial/error/paused/cancelled`、已完成操作、失败源码位置、stdout/stderr、输出预算与副作用状态。失败不是自动重试或新建浏览器的理由。

启动失败若有本次引擎写入的新 `ERROR` 状态，CLI 保留其实际 `error.code/message`（如 `network_unavailable`），不统一降为 `startup_failed`；旧错误状态不能冒充本次失败，凭据也不会随错误输出。

## 真实 Python 脚本

`run` 仅接收可信本地 `.py` 文件，入口必须为 `async main(page, context, tools)`。没有行式动作 DSL、内联脚本、stdin 或 JSON 动作列表兼容层。脚本在独立受监督子进程执行，但不是 Python 沙箱：不要执行来自网页或不可信输入的 Python。

```python
# flow.py
async def main(page, context, tools):
    await page.goto(tools.args["url"])
    title = await page.title()
    observation = await tools.axtree()
    return {"title": title, "observation": observation}
```

```sh
./bin/anti-trace run work flow.py --args '{"url":"https://example.com/"}' \
  --timeout 60 --max-output-bytes 1048576 --json
./bin/anti-trace measure flow.py --browser chromium \
  --args '{"url":"https://example.com/"}' --json
```

`run` 与 `measure` 共用 `runner.run_script` 和真实对象 `ScriptOperations`，支持声明的 Page、Locator、Context、Mouse、Keyboard 子集与有界 axtree，不能任意关闭管理器上下文。`tools.args` 为 JSON 输入；操作、最终 JSON 返回值和 stdout/stderr 共享输出上限。超时、输出超限、脚本异常或动作异常为终止结果，不重放有副作用的动作；终止脚本进程组不等于重启浏览器。`measure` 只启动真实安装的 Chrome/Brave/Edge/Chromium（可用 `ANTI_TRACE_CHROMIUM` 指定）或连接给定 CDP；不是加固运行时成绩。

`page.evaluate("document.title")` 与 `page.evaluate("(x)=>x", value)` 均在真实页面执行；表达式只求值一次，非函数返回值不会再被当作函数调用。

## 人机协作与观察

三路托管后端均无裸浏览器窗口，GUI统一为独占输入的共享viewer，避免原生窗口绕过控制租约。默认 `start` 返回私有 `viewer_url`；`--headless` 不自动启动viewer，但仍可按需 `viewer`。状态分别报告实际后端 `headless` 与GUI `gui`。URL仅供本机调用者，不应记录或公开。像素与输入来自同一运行时，没有第二个浏览器执行被测页面。`control status/pause/resume/reclaim/cancel` 管理输入权；缺少真实截图或输入时明确报错。

`axtree` 返回 `page_id/frame_id/observation_id/elements/source/coverage`；`--frame CSS` 选择实际子 frame。DOM 源与原生 accessibility 源分别标明，截断与缺失覆盖不能当作完整观察。`@ref` 绑定观察版本、页面与 frame；变化、导航或 frame 失效时，在派发动作前拒绝过期引用，不能重新编号后点击别的元素。

画面观察绑定实际主文档及可访问子frame的DOM、滚动和viewport；未变化的观察不因抓取另一张PNG而失效，避免鼠标移动误取消紧随其后的点击。截图保留页面caret状态，不通过临时样式改变DOM。人切到另一标签后，控制状态立即同步实际page/frame并清除旧观察，旧run不得暗中切回写入：目标不匹配返回 `stale_reference`，新run从人工选定页面开始。断线仍暂停，须显式恢复。

`exec` 保留单次动作：`goto axtree click type press hover select scroll wait back reload screenshot eval cookies tabs use tab_new`。`use INDEX` 按标签索引切换；axtree 可带 `--frame CSS`。`eval --main-world` 仅在环境显式授权时可用。

`attach` 保留外部浏览器所有权：`start` 拒绝，`stop` 不关闭外部进程。`run/field/audit` 使用实际附加上下文；附加浏览器的能力与身份声明不等于托管 schema3、跨调用引用或 GUI 验收通过。

### Panda Flow 原生帧接口（LPFR v2）

`lightpanda-headless --native-socket /private/session/control.sock --frame-shm /private/session/frame`
启用独立 UDS 控制面；两个绝对路径须处于同一当前用户所有、权限 `0700` 的短路径目录。
不传这两个选项时，原有 stdin/stdout NDJSON 客户端及 PNG screenshot API 保持原协议；
原生模式 stdout 仅输出现有 ready/error 事件，不承载像素。Socket 与帧文件为 `0600`。

原生模式新增 CDP `Page.captureRawFrame`：

```text
params: {path: absolute LPFR file path, slot: 0|1|2}
result: {width: u32, height: u32, stride: width*4, dpr_milli: u32,
         theme_edge_rgba: u32, format: "premultiplied-rgba8",
         render_fingerprint: hex64, focused_frame_id: string, focused_element_id: string|null,
         caret_rect: [x_css,y_css,width_css,height_css], caret_kind: string}
C ABI: bool lp_document_raw_frame(Document*, const uint8_t* path, size_t path_len,
       uint32_t slot, uint32_t css_width, uint32_t css_height, float scale, RawFrame*);
RawFrame = repr(C) {uint32_t width,height,stride,theme; uint8_t fingerprint[32];} // 48 bytes
bool lp_document_frame_fingerprint(Document*, uint32_t css_width, uint32_t css_height,
                                   float scale, uint8_t out_sha256[32]);
bool lp_document_caret(const Document*, size_t node_key, size_t offset, bool control, Rect*);
Rect = repr(C) {double x,y,width,height;} // 32 bytes, CSS viewport coordinates
```

该命令调用真实布局器的 raw region paint，直接将 tiny-skia 的预乘 RGBA8888 写入当前
producer-owned slot，不调用 PNG 编码、解码或 Base64；CDP/UDS 都只返回控制元数据。
命令验证文件尺寸、权限、目录、LPFR magic/version/capacity、slot 和实际像素上限。
它**不发布** slot：Python 在 DOM/子 frame/viewport 观察验证成功后才由 C11 原子 helper
执行 `middle.exchange(back|0x100, acq_rel)`，旧 middle 的低两位成为新的 back。
consumer 初始 front=0，middle=1，back=2；消费 dirty middle 时以 `acq_rel` 交换自己的
front，直到下次交换前所持 slot 均不可被 producer 改写。`published_seq` 为 release-store
的发布提示；以取得的 slot header 序号为准。桌面打包可预编译 `frame_atomic.c` 并用绝对路径
`LIGHTPANDA_FRAME_ATOMICS=/path/to/libframe_atomic.dylib` 指定；此时启动不需要编译器。
源码服务默认首次在私有本机 cache 以 `cc -std=c11` 编译，拒绝非 lock-free 32/64 位原子；
源码随 Python wheel 分发。macOS 打包命令为 `cc -std=c11 -O2 -dynamiclib -fPIC
lightpanda-headless/lightpanda_headless/frame_atomic.c -o /absolute/path/libframe_atomic.dylib`。

```text
control[64], little endian:
  0 magic:u32=0x4c504652; 4 version:u16=2; 6 reserved:u16=0;
  8 middle:AtomicU32 (index low2, DIRTY=0x100); 12 capacity_bytes:u32;
  16 published_seq:AtomicU64; 24..63 reserved.
3 × slot[64 + capacity_bytes], capacity_bytes=3840*2160*4:
  0 seq:u64; 8 width:u32; 12 height:u32; 16 stride:u32; 20 dpr_milli:u32;
  24/28/32/36 dirty x/y/w/h:u32; 40 theme_edge_rgba:u32;
  44/48/52/56 caret x/y/w/h:f32; 60 reserved:u32.
```

目前 dirty rect 为完整 viewport，theme 为实际左上角 RGBA 像素，**不是**推断的 CSS
theme-color。`caret_rect` 直接来自 native renderer，不再由页面 JS 的元素边界覆盖。
`caret_kind="native-shaped-insertion"` 表示使用实际布局/完整文本 shaping buffer 的插入点，
`"focused-element-bounds"` 明确表示仅有元素边界的 IME fallback，`"none"` 表示没有可用
editable anchor。消费者不能把 fallback 标为精确 caret，也不能把宽度为零的插入线当成缺失。
control caret 使用 live value 的 UTF-8 selection focus，contenteditable 使用 native DOM selection
端点与原有 shaped DOM caret API；只读取实际 paint 后的 geometry。iframe 的轴向缩放、
content inset 与 scroll 走 native embedding geometry；旋转/skew 或无当前 paint 的文档不会
冒充精确插入点。匿名 control caret 与值绘制共用完整 shaping item，而非按字符宽度或另测
prefix 推断；支持范围以对应 regression 与实际 native smoke 为准。

UDS 每条消息为 `u32 LE byte_length` 加 UTF-8 JSON，双向至多 256 KiB，只有一个连接拥有者，
逐条执行；部分 body 与输出写入有界超时。请求 `{id,method,params}` 支持原有
`state/frame/control/action/shutdown` 和
`resize {width,height,device_scale_factor,page_id,owner_revision}`。resize 是目标页面的人工写操作：
Agent 持有输入权时拒绝，page/owner revision 不匹配也拒绝，先使旧观察失效再派发。
`frame` 在同一个 observation 边界内返回页面列表 `pages`、profile/runtime、当前 page_id，
以及 `frame_seq/image_id/frame_id/observation_id/viewport/width/height/stride/dpr_milli/
theme_edge_rgba/caret_rect/caret_kind/owner_revision/document_epoch/viewport_epoch/
focused_frame_id/focused_element_id/render_fingerprint/state` 和
`shm:{path,version:2,capacity_bytes}`，没有图片字段，不需要先请求另一次 state 来拼装页面列表。
`document_epoch` 是真实 NativePage 文档代数；focused IDs 来自 native focused frame 和实际
DOM node identity，需结合文档代数使用，不是 CSS selector。resize 响应后客户端重新请求 frame。
action 可附 `frame_seq/document_epoch/viewport_epoch/focused_frame_id/focused_element_id`，
仍须携带原有 image、页面、观察和 owner_revision；携带的额外范围标识不匹配即拒绝。
最近 32 帧只在相同页面、文档、viewport、owner、renderer fingerprint 范围内可用。
`trust.proxy_mode` 只报告已启动 NativeSession.config 的已提交代理配置 `DIRECT/PROXY`，
缺少配置时为 null；不公开代理引用、凭据或环境值。`trust.region` 目前为 null，不把配置代理
当作已验证出口、城市或安全保证。

DOM observer 仅是刷新提示，**不作为像素坐标安全证据**。raw capture 的 C ABI fingerprint 是
实际预乘像素 SHA-256；Zig 再将其与当前主/子 frame 的 loader/frame identity、完整 native
layout projection digest 和 style revision 一起 SHA-256，生成返回的 `render_fingerprint`。
原生输入使用 `Input.dispatchNativeAction`：

```text
params: {expectedRenderFingerprint: hex64,
         events: [{method: "dispatchMouseEvent"|"dispatchKeyEvent"|"insertText", params: CDP params}]}
result: {}
error: -32042 => stale_reference (before dispatch if rendered pixels/semantic tree differ)
```

Python 将既有鼠标/键盘语义收集为至多 32 个原生事件，在同一 native event-loop turn 中
重绘/校验实际 renderer fingerprint，然后按顺序派发；不在多个 CDP 请求之间让 timer 重新
定向一个 click/key sequence。派发期间发生文档切换则终止剩余事件。输入校验的重绘只在
实际输入时执行，不是后台截图轮询；没有重放已接受输入。程序设置 input/textarea.value、
CSSOM、Canvas 和子文档变化不依赖 MutationObserver 是否观察到了它们。

`{event:"invalidated"}` 为非响应事件。`Page.subscribeNativeFrames` 启用真正 native 的
`Page.nativeFrameInvalidated`：`Runner._tick` 在已有 native turn 结束时比较
`native_layout.revision`，包含 page DOM/style revision、viewport、主/子 frame identity、
scroll 与 `_render_resource_version`（包括 worker Canvas 的原子 epoch），只有变化才发事件。
这条路径只扫描原生 revision，不 rasterize 或编码图片；没有订阅者时不扫描。
CSSOM/Input setter 走 `Frame.styleChanged`，textarea setter 补齐同样 invalidation，
Canvas/资源更新走原生 resource epoch。文档/网络事件及 isolated-world observer 是附加提示：
observer/binding 位于真实 `__panda_native_observation` world，当前主/子文档及后续导航均注册。
提示事件按 40 ms 合并，客户端按需拉取 frame，没有常驻截图定时器；不宣称连续动画/视频
逐帧采样。导航失败沿用运行时真实错误文档，人工租约不交回 Agent。

父 stdin 在 native 模式仅作为生命周期 lease（不是控制 wire），从启动前即监控 EOF；
即使父进程在 UDS 连接前死亡也会取消启动并持久清理。原生子进程退出/CDP reader 结束有
event-driven watcher，空闲时也会生成 sanitized terminal error 并清理。Socket EOF、
SIGTERM/SIGINT 或 shutdown 进行持久退出并 unlink 帧/socket/owner lock；SIGKILL 后由下一次
取得目录 owner flock 的启动回收遗留文件，绝不覆盖活 owner。

原生源码与重建（仓库根目录；macOS arm64、已准备的离线依赖及 Zig 0.17 工具链）：

```sh
# source checkout: browsers/engine-bench/.local/lightpanda-cost/source
# restore source from pinned commit using browsers/engine-bench/candidates/lightpanda/runtime.patch;
# shared renderer also requires browsers/engine-bench/candidates/obscura/runtime-environment.patch.
node browsers/engine-bench/candidates/lightpanda/native-build.mjs build
# output: browsers/engine-bench/.local/lightpanda-cost/source/zig-out/bin/lightpanda
# provenance: browsers/engine-bench/candidates/lightpanda/current-build.json
```

构建驱动导出完整 fork patch 并记录源/renderer/二进制摘要；已有 profile 的二进制 pin
变化须显式迁移或创建新 profile。编译成功不等于原生 UI、并发或性能验收通过。


## schema3、迁移与私有存储

每个托管环境的 `config.json` 是 schema3 的唯一持久输入：`id/seed/revision/generator_version/runtime/resolved/overrides/assets/storage/network/permissions`。规范 JSON 为排序键、紧凑 UTF-8、禁止 NaN，并以换行结束。启动只验证和重放，不重新生成旧 schema，也不根据当前出口偷偷改写身份。旧 schema、二进制或字体资产变化必须显式 `migrate`，且只能同引擎迁移；迁移保存快照与前一 revision，`--rollback` 恢复真实快照。

```text
~/.anti-trace/
  profiles/NAME/
    config.json       # 0600，不嵌入代理口令
    data/             # storage.path 的实际持久存储目录
    state.json        # pid + process_start、STARTING/READY/STOPPING、socket
    engine.log
  .leases/            # 库级 spawn -> engine -> catalog 锁，移除目录也不会失效
```

`ANTI_TRACE_HOME` 可改变库位置；socket 位于当前用户私有、哈希命名的短路径目录，不受 Profile 全路径长度限制。`config.json` 与 `storage.path=PROFILE/data` 是兄弟关系。`info` 输出实际 config 文件 SHA-256、完整路径、schema、种子、revision、resolved、资产摘要及运行时 id/version/artifact_sha256/executable（binary 别名）。

启动/停止/重置/移除由lease协调；PID与创建时间共同验证属主。缺失/不匹配的创建时间不证明环境空闲：停止须取得engine lease后才能清理旧状态；锁被持有则busy，绝不向未验证PID发信号。socket消失不表示退出，超时保留状态。原生子进程继承真实锁FD，管理器stdin断开后执行持久化退出，退出前保留锁；脚本进程组通过OS父进程退出通知清理。动作错误不触发第二个daemon。崩溃恢复是否通过仍以独立进程/锁/存储门槛为准。

代理由 `--proxy URL` 或 `env:VARIABLE` 绑定，配置仅留引用；托管口令位于Profile外的私有 `.secrets/proxies/`，推荐env引用避免命令行口令。原生子进程仅在环境变量中接收代理，不放入长期argv。`DIRECT` 显式直连；strict/observe不改变固定身份，出口另记。`--allow-private-network` 是原生访问本地/私有地址的授权。`export --include-credentials` 才归档所配置代理，归档仍是敏感材料。导入校验manifest、实际文件摘要及资产，`--proxy/--native-binary` 可重绑本地资源；物理路径变化不伪装成旧文件摘要。原生字体随包搬运，Camoufox仍依赖宿主字体加载。

## 证据与验收

```sh
./bin/anti-trace audit work --local --json
./bin/anti-trace audit work --headers --echo-url https://trusted.example/api/echo --json
./bin/anti-trace field work --site-config private-sites.json --out /private/evidence --json
.venv/bin/python -m unittest discover -s tests
.venv/bin/python tests/acceptance.py
```

`audit --headers` 区分 identity/build/request/family/protocol/policy/origin 责任，未知或证据不足为 `review_required`，不是 pass。`field` 的 reached/cleared/challenge/blocked/error/not_tested 分开记录：到达页面或 HTTP 200 不证明挑战已通过，`cleared` 需要本次访问绑定的可信服务端验证回执。普通重定向不算通过。私有 site config 可保存回执认证信息，勿提交或公开。

统一suite4固定459项，包含全部22个产品场景：身份稳定与差异、自洽、功能、失败关闭、持久化、迁移、GUI、挑战与成本/发布证据。任一必需项缺失、失败、unsupported、error或review_required仍为 **NOT_PASS**。编译、组件测试、单站分数及旧同机报告均不能替代当前三路完整验收。
