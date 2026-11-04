---
name: camoufox-configuration
description: 为 anti-trace-browser 选择、持久化和验证 Camoufox 配置；核对 Canvas 重启稳定性、A/B 环境差异、原生能力与配置代价时使用。
---

# Camoufox 配置与验收

## 适用范围与事实归属

核对日期：2026-11-03。项目实测组合：Camoufox Python 0.5.9、浏览器 158.0.1-beta.41、Playwright 1.62.0、fpgen 1.3.0。下列官方资料固定到浏览器发行 tag；安装包源码与实际运行结果共同确认能力。升级后重新验收组合。

- **官方事实**：以下链接中的行为与 API。
- **项目要求**：长期持久环境的稳定性、差异、隔离与一致性门槛。
- **已测事实**：§实测锚点所链接的原始报告。
- **待验能力**：配置入口已核实，效果、作用域或生命周期尚待对应实验。

优先完成官方配置层实验，再按差距决定原生补丁或 Obscura 的开发范围。

## 联合验收：环境内稳定 AND 环境间差异

两项为同时成立的硬门槛，适用于最终配置及必测的页面可观察特征。配置文件哈希与真实输出分别核验。

- 环境内：A1=A2、B1=B2，涵盖刷新、新页面及浏览器重启；相同输入与固定版本条件下比较。
- 环境间：A1≠B1、A2≠B2，逐项检查规定的差异字段；Canvas 检查像素及解码后图像，PNG 字节另列。
- 联合通过：`same_runtime AND fixed_configuration AND within_environment_stable AND between_environments_different`，再叠加功能、一致性与隔离门槛。缺失观察登记为待验。
- 当前默认组：环境内稳定通过，必测环境间差异失败，联合结果为失败。后续配置组继续使用同一联合门槛。


## 产品层：身份、设备与网络（anti-trace-cli）

`anti-trace-cli` 把下列规则固化进代码，改动这些规则前先读对应模块。

| 规则 | 实现 | 依据 |
|---|---|---|
| 指纹只生成一次 | `identity.new_identity` → `config.identity.fingerprint`；每次启动原样传入 | 不传 `fingerprint` 时 `identity_salt()` 为 `secrets.randbits(64)`，屏幕/字体/语音/媒体设备会随启动漂移 |
| 设备类别决定屏幕/DPR/核心数 | `DEVICES[os]` 表 + `next_device()` 取未使用类别；`engine.build_options` 下发 `screen.*`、`window.*`、`window.devicePixelRatio` | `screen.width` 等键在 `properties.json` 中可覆写；实测 `(min-resolution: 2dppx)`、`device-width` 随配置变化 |
| 字体两档 | `host`（默认，沿用宿主真实字体）；`subset:N`（校准池固定子集，始终含核心家族，配 `custom_fonts_only`） | `host` 下 Canvas 文本跨环境相同；`subset` 下不同、重启稳定，但未列出字体全部回退（可检测） |
| Canvas 不开随机读回 | 不设 `canvas_noise` | 实测 `canvas_noise=True` 每次读回都不同，违反重启稳定门槛 |
| 时区/语言来自真实出口 | `net.probe_egress` + 浏览器内 `ipinfo.io` 自测；`config.timezone`、`locale=[tag]` | 上游 `geoip` 的区域语言表会产出 `fil-US`/`pl-GB`/`nds-NL` 等不合理组合，故自行映射 |
| 出口漂移处理 | `network.follow_egress` 为假：保留身份并告警；为真：改写并重启一次 | 轮换 IP 池无法同时满足身份固定与地理一致 |
| 地理位置权限默认拒绝 | `permissions.default.geo=2`，不下发坐标 | 放行但取不到位置时 `permissions.query` 与实际行为矛盾（实测 `granted` + `User denied geolocation prompt`） |
| 控制面仅本用户 | `engine.sock` 0600 + `.lock`/`.spawn` 双锁；引擎 fail-fast 抢锁 | HTTP `127.0.0.1` 端口可被任意网页跨源 POST 驱动（已复现 `eval`） |
| 快照不写 DOM | `actions.SNAPSHOT_JS` 只读遍历，返回唯一 CSS 路径 | 写 `data-atb-ref` 会被页面脚本观测，且不是无障碍树 |
| `eval` 默认隔离世界 | `--main-world` 需环境开启 | 隔离世界读页面 TypedArray 会触发 Xray 限制；音频 RMS 需 `buf.copyFromChannel` 到自有数组 |

## Canvas：固定环境的稳定输出

本项目主线为**稳定环境身份**。相同浏览器/OS/驱动/字体/渲染策略版本，相同顶层站点、绘制输入、尺寸和色彩条件下：

| 对照 | 像素要求 | 另记证据 |
|---|---|---|
| A，同页重复 | 相同 | 输入变化后输出确实响应 |
| A，刷新/新页面 | 相同 | 页面与绘制条件保持一致 |
| A，浏览器退出并重启 | 相同 | 配置及 Profile 复用 |
| B，退出并重启 | 各自相同 | 同上 |
| A 与 B，同一测试任务 | 项目要求可区分 | 功能和参数一致性同时验收 |
| A，不同顶层站点 | 按声明的站点作用域策略判定 | 跨站关联专项 |
| 浏览器/OS/驱动/字体升级 | 新版本实验组 | 记录迁移差异与兼容性 |

把 Canvas 输出拆成三路：
1. `getImageData` 像素及其哈希；同时保存控制像素、文字/图形及输入响应。
2. `toDataURL` / `toBlob` 的原始 PNG 字节哈希；保留编码及数据块信息。
3. PNG 解码后的像素；用于与读回路径交叉检查。

**官方事实**：默认同宿主 OS/GPU 的真实渲染路径保留像素，PNG 导出带会话级 `deBG` 数据块。原始 PNG 字节随会话变化可单独解释，固定环境的像素稳定性仍按上表判定。哈希记录必须带算法、输入与采集路径；现有本地探针为 FNV-1a32，严格复验可增加 SHA-256/实际像素比较。

**待验能力**：`canvas_noise=True` 开启 Firefox RFP 的 Canvas/WebGL 随机读回保护；官方描述的是保护开关。其同页、刷新、跨站和重启作用域需要实验确认。固定配置复用与固定噪声生命周期分别验收。当前属性表把 `canvas:seed` 标为已移除；稳定环境的可配置 seed 实现列为待补能力。

随机读回实验属于独立策略组。主线“重启像素相同”的门槛继续保留，实验结果按实际变化范围记录。

## 配置层建议

以下“建议”为项目选择；“官方行为”来自固定版本资料。

| 配置/能力 | 官方行为 | 项目建议与验证 |
|---|---|---|
| 运行时配对 | 包发布配对浏览器与模型；可覆写版本 | 使用锁定依赖、制品 SHA-256 与模型 pin。为升级新建实验组 |
| `os` / `ff_version` | OS 驱动多处行为；版本默认随内核 | 基准选宿主 OS；UA 随真实版本。其他 OS 单独实验并检查数学、字体、输入行为与传输声明 |
| `fingerprint` / `fingerprint_preset` | 使用生成器结果或记录的设备配置 | 建环境时生成一次，持久化最终解析配置；比较真实输出后再采用 |
| `persistent_context` / `user_data_dir` | 保存浏览器状态 | 每环境一个目录及占用锁；浏览器状态与身份配置分别保存 |
| `launch_options` / `from_options` | 生成解析后的参数；后者直接复用参数 | 复用本项目双环境运行器路径；保存配置版本、哈希及来源，启动前校验运行时 |
| `canvas_noise` | 同宿主 OS/GPU 默认真实读回；其他 OS/GPU 默认开启随机读回 | 默认组、保护组分别测试；记录像素功能、稳定性与作用域。稳定 Canvas 身份以实际重启证据验收 |
| `webgl_config` | 指定已记录的 Firefox OS/GPU 对，联动参数/扩展/精度；需 `os` | 从支持集合选择并整体验证。其他 GPU 会联动 Canvas 保护；同时读 GL 像素、shader precision、WebGPU 适配器及功能 |
| `fonts` | 在 OS 字体集合上增加字体 | 使用实际可渲染字体；保留 OS 基础集合、字形回退与 CJK/emoji 测试 |
| `custom_fonts_only` | 仅使用指定集合，官方提示 OS 一致性代价 | 单独对照。字体枚举、`system-ui`、实际度量与 Canvas 一起测；标准字体在不同设备上相同的宽度保留为自然共同属性 |
| Audio 配置 | 原生提供采样率、延迟、最大通道数；离线样本保留宿主计算 | 分开验证设备属性与固定输入的样本响应。样本差异需求另评估原生实现成本 |
| `screen` / `window` | 限定抽样屏幕或外窗尺寸 | 固定最终值，检查 JS、CSS 媒体查询、DPR、真实窗口及截图尺寸 |
| `pin_cpu_cores` | Linux/Windows 可将可测并行度匹配声明；消耗 CPU 并串行化启动 | macOS 按实际能力登记。比较核心声明、Worker 与真实并行响应；性能对照使用相同资源预算 |
| `proxy` / `geoip` / `locale` | GeoIP 可联动时区、位置、语言与 WebRTC IP；含额外查询/数据库 | 明确出口和外部查询；保留最小权限。GeoIP 相关定位授权按实际启动配置审计，网络泄露另测 |
| `block_images` / `block_webgl` / `block_webrtc` | 关闭对应能力；部分选项官方提示兼容/可见性代价 | 基准保留目标任务需要的功能；每个关闭项单独观察性能、暴露与兼容性 |
| `disable_coop` | 关闭跨源 opener 隔离，官方提示代价 | 基准沿用浏览器隔离；授权兼容实验单列开关与恢复步骤 |
| `main_world_eval` | 显式允许 `mw:` 页面世界执行 | 本地审计按需使用；Agent 授权与页面权限独立管理 |
| `enable_cache` | 保留缓存，增加内存 | 冷进程与暖缓存分开测量；缓存归属与 Profile 一致 |
| `humanize` | 调整鼠标移动 | 作为交互体验实验；风险判定仍依赖目标任务证据 |
| `i_know_what_im_doing` | 静默官方告警 | 实验保留告警并归档，便于追踪配置代价 |

### 原生属性与兼容性

通过固定版本 `properties.json` 核验名称、类型与 `removed` 标记。原始配置覆盖自动生成值，修改前后运行完整一致性检查。

- Audio 当前键：`AudioContext:sampleRate`、`AudioContext:outputLatency`、`AudioContext:maxChannelCount`。
- GL 当前键使用 `webGl:` / `webGl2:` 大小写，例如 `webGl:renderer`、`webGl:parameters`、`webGl:shaderPrecisionFormats`；优先使用 `webgl_config` 的成套生成路径。
- 历史 `canvas:seed`、`fonts:spacing_seed`、`audio:seed` 已标为移除。旧文章里的固定 seed 示例归档为版本历史。
- 字体源有“所有上报字体可渲染”和“OS 字体可达范围”两项约束；macOS/Windows 走 allowlist 路径。上游字体文档的验证主要在 fontconfig 层，运行浏览器的真实结果按本项目证据更新。

## 固定配置的保存边界

1. 绑定环境 ID、独立 Profile、运行时 SHA-256、模型版本、最终解析配置和策略版本。
2. 保留 `CAMOU_CONFIG_*` / 必要浏览器配置变量及配置哈希，宿主凭据保持进程内；配置文件权限 0600。
3. 从已保存参数启动；生成器重抽样属于新建环境或显式迁移。
4. 配置升级先在测试副本验收，再执行明确的环境迁移。
5. 一浏览器多 Context 与一环境一进程分别评价：Canvas 开关归浏览器；部分 OS 行为也归浏览器。当前持久环境基准采用一环境一进程。

## 执行与判分

从集合根目录执行：

```sh
npm --prefix audit-service start
# 另一个终端；默认组，A1 → B1 → A2 → B2
uv run --project camoufox-baseline --locked python camoufox-baseline/scripts/paired_environments.py
# 单个新测试环境访问官方参考站
uv run --project camoufox-baseline --locked python camoufox-baseline/scripts/amiunique_baseline.py
```

先读运行器和已有报告再改变参数。保护配置组是后续实验，当前双环境入口执行默认组。每个实验组独立输出目录并保存解析配置、原始结果、截图、时序与关闭回执。

验收顺序：同内核 → 配置复用 → A/B 存储隔离 → 同页重复/输入响应 → 刷新/新页面 → A/B 差异 → 重启稳定 → Worker/iframe/HTTP/CSS 一致性 → 外部站新采集 → 目标任务与性能。

官方页面结果有“本次新 API 采集”和“Cookie 对应的已有结果页”两种来源，逐次标注。Unique 属于样本稀有性；独立环境差异、跨站关联、目标站挑战和账号风险各用自己的证据栏。完整执行、本地高分和功能通过各自保留原始含义。

## 实测锚点与下一次实验

- [默认基准对照报告](../../camoufox-baseline/.local/reports/paired/20261103-153902/comparison.json)：同内核/配置复用/局部重启稳定/LocalStorage 隔离通过；Canvas 像素、Audio、GL、字体、核心数相同。
- [靶向隔离实测报告](../../camoufox-baseline/.local/reports/paired/20261103-161902/comparison.json)：**联合验收通过** (`joint_acceptance: true`)。
  - **同环境重启稳定 (A1=A2, B1=B2)**：Canvas 像素哈希、Audio 样本、WebGL 渲染器及参数、字体宽度、屏幕尺寸、核心数 100% 保持一致。
  - **跨环境硬件差异化 (A≠B)**：
    - Canvas 像素哈希：`b78371f3` vs `e538d72c` (由字体度量隔离生成确定性渲染差异)
    - WebGL 渲染器：`Apple M1, or similar` vs `Intel(R) HD Graphics, or similar`
    - WebGL 参数：`subpixel_bits: 4` vs `8`
    - 字体度量：`Arial 519.1` vs `423.9`，两组字体度量完全区分
    - 屏幕尺寸：`1512x945` vs `1470x918`
    - 硬件核心数：`8` vs `12`
    - 官方 AmIUnique 采集：Canvas、WebGL Data、Fonts 哈希均完全区分
    - Audio 样本：受限于 stock Firefox 架构级 IEEE-754 浮点实现，保持宿主 ARM64 一致 (`609a8af8`)。
  - **功能与一致性控制**：四轮会话功能评分与自动化一致性评分均为 100/100，存储隔离 100%。
- [项目文档](../../README.md)：完整方法、范围与历史回执。

Camoufox 现已建立首个通过联合验收的可用配置基线。下一步重点在 Obscura 等自建轻内核中实现原生多身份环境管理。

## 固定版本来源

- [S1 Python 配置指南](https://github.com/daijro/camoufox/blob/v158.0.1-beta.41/python/README.md)：持久 Context、多 Context、Canvas 开关、启动选项与配对。
- [S2 原生机制与 Canvas](https://github.com/daijro/camoufox/blob/v158.0.1-beta.41/README.md#canvas)：真实像素、会话 PNG 数据块、GPU 与读回联动、Audio 样本语义。
- [S3 属性及移除记录](https://github.com/daijro/camoufox/blob/v158.0.1-beta.41/browser/settings/properties.json)：键名、类型、版本移除。
- [S4 字体机制](https://github.com/daijro/camoufox/blob/v158.0.1-beta.41/docs/FONTS.md)：字体包、OS 门控、度量、验证范围。
