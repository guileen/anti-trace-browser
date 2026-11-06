# engine-bench

Obscura/Rust 与 Lightpanda/Zig 的源码定制成本和发布版性能实验。Moli 保留历史重放。检查通过数、构建传输失败和语言偏好各自记录，选择按相同产品要求的补齐成本进行。
以下命令从 `browsers/engine-bench` 目录运行。迁移前的构建回执保留原始路径和哈希；重新构建会生成使用新目录路径的回执。


```sh
npm run setup             # 下载锁定版本的运行时到 .local/runtimes
npm run compare           # 逐引擎跑 DOM/JS 往返、存储、渲染挑战与资源采样
```

外部二进制可用环境变量指定：`MOLI_INSTALLED_PATH`、`LIGHTPANDA_PATH`、`OBSCURA_PATH`；未指定时按 PATH 查找。

## 历史性能（3次中位数）

| 引擎 | DOM/JS 往返 | 引擎树峰值 RSS | 真实 CSS 像素 |
|---|---:|---:|---|
| Lightpanda | 2.46ms | 59.7MiB | 文本式输出，单独评价 |
| Obscura | 8.20ms | 94.1MiB | 通过 |
| Moli | 11.95ms | 129.2MiB | 通过 |

这组数字覆盖各引擎的实际工作量；图形管线和资源支持不同，具体速度来源尚未由消融实验分离，不作为等能力或反追踪结论。

## 2026-11-04 源码成本切片

| 项目 | Obscura | Lightpanda |
|---|---|---|
| 可重放补丁 | `candidates/obscura/runtime-environment.patch`，8模块 +184/−11 | `candidates/lightpanda/runtime.patch`，11模块 +137/−64 |
| 构建 | Rust优化profile136.442s，无变更增量0.129s，共享Cargo下载缓存 | 优化干净对象缓存233.052s、无变更增量0.571s；保留已锁定依赖与预编译V8，实际离线编译 |
| 实跑 | patched优化制品A1/B1/A2/B2、配置/HTTP/三类冷持久存储 | clean-built源码制品A1/B1/A2/B2、配置/HTTP/三类冷持久存储；发布版协议与上游客户端也通过 |
| GUI成本 | 已有真实CSS/文字截图、坐标和字符串输入；CJK、图像加载、滚动与接管继续验收 | AppKit诊断viewer已运行，内容为文本预览；真实CSS/画面/坐标/滚动需要渲染组件 |
| 关键语义 | Canvas伪字形、Audio忽略输入、Worker可访问document/window | Worker无document/window且brand正确；Audio440/880Hz非零且向量不同；Canvas透明、GL为null |

成本卡：[Rust](candidates/obscura/cost-card.json)、[Zig](candidates/lightpanda/cost-card.json)；Zig分阶段失败/恢复见[回执](candidates/lightpanda/recovery.json)。下载超时只属于传输条件，最终源码构建已成功。固定tag1.0.2源码自报1.1.0-dev.1+c5f7bb2，与下方发行版性能分开。两候选保持experimental，生产发布沿完整required gates。

Lightpanda原始功能数据：`.local/lightpanda-cost/release-functional/results.json`。独立图控制 `.local/lightpanda-cost/audio-graph-controls/report.json` 另验证断线静音、gain=0、gain=0.25、stop(0)、延迟start五项行为，均符合输入关系；不扩展为完整Audio一致性或规定跨环境差异验收。Obscura的bootstrap有私有闭包；风险判断依据实际运行语义，而非“JS必然公开seed”。

## 发布版性能（2次预热＋10次测量）

共同表达式唯一输入：`scripts/common-workload.json`，校验整数计算和1000个DOM节点结果。表中为页面内部计时；本机精度随引擎时钟而异，Camoufox有1ms量化。

| 引擎 | DOM/JS内部中位数 | p95 | 真实CSS像素挑战 |
|---|---:|---:|---|
| Lightpanda 1.0.2 | 1.8425ms | 1.875ms | 文本预览，单独记录 |
| Obscura 0.2.6 | 6ms | 8ms | 10/10通过 |
| Camoufox 158 CLI参照 | 3ms | 3ms | 10/10通过 |

原始：[native](.local/performance/native-2026-11-04.json)、[Camoufox CLI](.local/performance/camoufox-2026-11-04/report.json)。冷进程发现、IPC往返、CPU、采样RSS、协议/输出bytes另存。Camoufox树含Python/Playwright且RSS从READY后开始；原生树不含Node驱动。视口/DPR与封装启动路径不同，可视耗时与驻留资源保持各自口径。源码patch的完整产品任务性能留待功能完成后复验。

```sh
# 已安装固定发行版；服务独立启动
PORT=8785 node ../../services/audit/src/server.mjs
node scripts/compare.mjs --url http://127.0.0.1:8785/ --runs 10 --warmups 2 --output .local/performance/new-native.json
node acceptance/camoufox-performance.mjs --url http://127.0.0.1:8785/ --output .local/performance/new-reference
node acceptance/camoufox-cli.mjs --output .local/acceptance/new-run
```

性能运行器只给观察，`selection.selected`保持null；主线选择需要GUI/身份能力与完整成本卡。新产物放独立目录，历史原始记录保持原状。
