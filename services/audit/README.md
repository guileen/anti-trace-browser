# audit

本地浏览器审判台。用同一套探针与任务给访问者打分，作为产品验收的可重复基线。

在 `services/audit` 目录执行：

```sh
npm start                 # http://127.0.0.1:8765/
npm test                  # node --test
```

## 评分口径

四个轴各自独立计分，固定分母，缺证据记零：

| 轴 | 测什么 |
|---|---|
| 反追踪 | 局部暴露收敛证据；跨站保护、字体匿名集等缺少独立证据时保持未测 |
| 自动化可见性 | 页面/HTTP/realm 声明、webdriver 与几何一致性；不是挑战通行证明 |
| 功能 | 真实像素/音频、存储往返、DOM、布局与 Worker/iframe 挑战 |
| 性能 | 校验工作量后的确定性 CPU 与 DOM 构建/布局耗时；进程资源另测 |

## 边界

分数只证明**本地探针观测到的事实**。跨站关联、真实 WAF 挑战与账号风险不在计分范围内，结果按覆盖状态单列。第三方站点（AmIUnique、EFF、BrowserLeaks）的证据由 `anti-trace audit --fp/--leaks` 归档，不并入本地得分。

## 版本化必测清单与 CLI 契约

唯一产品验收定义为 `src/manifest.mjs` 的 `MANIFEST`，当前套件 `2026.11.04.2`。
`GET /api/manifest` 返回同一 JSON；`GET /api/suite` 中的 `manifest` 也指向它。
页面四轴评分保留其局部用途，但报告的 `acceptance.status` 明确为 `outstanding`；
高分、API 缺失、零设备或 `[native code]` 字样均不能取消 required gate。

`GET /acceptance.js` 提供 `window.AcceptanceProbes.collect(options)`，只采集原始值，不给出验收结论：

```js
await AcceptanceProbes.collect({
  input: { challenge: 17341, frequency: 337, rotation: 0.43,
           color: [63, 147, 213, 255], text: 'Independent Ω 你好' },
  environment: 'A', run_id: 'harness-issued-id', storage_mode: 'write'
});
```

调用方在独立宿主生成并保存输入。只在 A1/B1 每个站点首次采集使用 `write`，
其余生命周期用 `read`，避免重启后重写掩盖丢失。返回
`{feature_id:{status,observed,detail?}}`；Canvas 的 decoded RGBA 与 PNG 分开，
text 与 geometry 是两项；Audio 保留四组 Float32 样本（原频、倍频、半增益、断开图）；
GL 编译链接真实 shader、绘制两个 uniform 颜色、读回并检查对象和错误语义。
Worker/iframe 使用服务端静态脚本和独立挑战通道，不做页面 API 替换。
CLI fixture 加载 `/acceptance.html`，由正常页面 realm 的 `/acceptance-driver.js` 执行探针。
显式 `acceptance-collect` DOM 事件携带 JSON 字符串请求，结果通过 DOM 文本返回隔离世界；
这避免 Firefox automation Xray 的 TypedArray 边界错误，且不打开任意 main-world eval。
直接在隔离 eval 内调用图像/音频 API 的结果须保留为不同采集上下文，不能冒充页面观测。

原始 envelope 为 `{schema:1,suite_version,inputs,runs:[...]}`。每条 run 是
`{run_id,environment,phase,lifecycle,site,features,server_evidence?}`。
phase 为 A1/B1/A2/B2；每个 phase 在 `http://127.0.0.1` 与 `http://localhost`
各采 initial/repeat/refresh/new_page。端口不构成新 site。七项身份特征逐项检查
同环境稳定 AND A/B 差异；GL 标识、参数、像素必须分别差异，不以其中一项代替全部。
所有 `fail|unsupported|error|not_tested|review_required` 必需项继续 outstanding。

### 独立服务端 HTTP 证据

导航到 `/?context=navigation&run_id=ID`；受控端点为：

- `/api/echo?context=fetch&run_id=ID`：实际请求头、HTTP 版本。
- `/api/echo/redirect?context=redirect&run_id=ID`：真实 302 后返回 echo。
- `/api/echo/pixel?context=subresource&run_id=ID`：真实 PNG 子资源。
- `/acceptance-worker.js?context=worker&run_id=ID`：实际 Worker 脚本请求。
- `/api/echo/events?run_id=ID`：宿主通过自己的 HTTP 客户端读取收件记录，
  与页面/协议自报分离后写入 `run.server_evidence`，并附到 headers 的 observed.receipts。

内存保留 10 分钟、最多 256 个 run、每 run 最多 64 个请求；Cookie/Authorization/
Proxy-Authorization 永不写入 echo。运行器保存私有原始文件；公开分享须另行脱敏。
当前 echo 只证明本地 HTTP/1.1；HTTPS/H2、出口与挑战凭据仍是显式缺口。
普通 `/api/reports` 评分保存独立 `.raw.json`，可用 `/api/reports/:id/raw` 读取；
没有原始文件的历史报告返回 404，不从判分结果伪造原始提交。

### 执行与历史重评

从仓库总目录执行：

```sh
node browsers/engine-bench/acceptance/camoufox-cli.mjs \
  --output browsers/engine-bench/.local/acceptance/camoufox-current
node browsers/engine-bench/acceptance/evaluate.mjs RAW.json NEW-VERDICT.json
node browsers/engine-bench/acceptance/revalidate.mjs \
  services/audit/.local/reports/audits browsers/engine-bench/.local/acceptance/history-current
```

CLI fixture 使用已有 `cli/bin/anti-trace` 和本机已有 Camoufox，
`--cli` / `--executable` 可选；不会安装浏览器。创建私有 A/B 存储，按 A1/B1/A2/B2
交错真实启动、采集和停止。保留宿主/运行时版本、二进制 SHA256、配置快照、命令日志、
输入及逐次 raw，最终 `raw.json` 与 `verdict.json` 分开，输出拒绝覆盖既有文件。
此运行不是性能基准，不提供 GUI 人审、HTTPS/H2、公网出口或挑战回执通过结论。
私有 Profile 位于 `browsers/engine-bench/.local/a-<随机8位>`，`raw.profile_home` 指向它，
以免长报告名称超过 macOS AF_UNIX socket 路径限制；创建前落盘的完整配置和字体列表
保留在该目录下的 `profiles/acceptA|acceptB/config.json`，不是公开分享文件。

比较 API：`import {MANIFEST,SUITE_VERSION,evaluateAcceptance,compareRuns}`
from `services/audit/src/manifest.mjs`，或从 `browsers/engine-bench/acceptance/evaluate.mjs` 重新导出。
结果含 source_suite_version、raw_sha256、逐项 checks、coverage 和完整 gaps。
历史重评写入全新目录，保留原字节/原套件/原分数来源；旧 hash 无法恢复像素、样本、
缺失输入或生命周期，故这些当前门槛保持 not_tested，不改变历史记录，也不补造采样。

### 2026-11-04 本机实际回执

- `node --test test/*.test.mjs`：21 项行为测试通过；随后新增的 main-page bridge
  由下述完整真实 CLI 运行覆盖。无性能或反机器人通行结论。
- 历史目录 60 份报告在
  `browsers/engine-bench/.local/acceptance/history-2026-11-04-suite2/` 写入新规则重评；
  原始历史规则为 `2026.11.03.1`，当前 434 项均缺少完整新套件证据，保持 outstanding。
- 完整 page-realm 实测位于
  `browsers/engine-bench/.local/acceptance/camoufox-2026-11-04-suite2-page-realm/`：
  A1/B1/A2/B2 × 两个 site × 四个生命周期 = 32 份观察，409/434 通过，25 项 outstanding。
  Camoufox 158.0.1-beta.41 / Python 包 0.5.9 / Playwright 1.62.0，
  主机 darwin 27.0.0 arm64、12 核、32 GiB。二进制 SHA256 与完整输入见 raw.json。
- 本地功能、三类持久存储、realm/HTTP 一致性与七项同环境稳定检查通过；
  A/B 只有字体度量和屏幕满足本次规定差异。text/geometry Canvas 的 decoded pixels
  相同，但 PNG bytes 不同；Audio samples 相同；GL 标识/参数/像素均相同；
  请求核心数为 A=4/B=8，实际两者均为 8。以上五项差异每轮每站点失败，共 20 个 gate。
  其余 5 个缺口是 GUI、HTTPS/H2、公网出口、挑战回执、GUI 人审。
- 首次长 Profile 路径的 AF_UNIX 启动失败，以及第二次 isolated-eval 的 Audio Xray
  采集错误分别保留在 `camoufox-2026-11-04-suite2/` 和
  `camoufox-2026-11-04-suite2-short-home/`；它们不替代 page-realm 回执，
  不当作原生 Audio 不可用或内核启动缺陷的证据。
