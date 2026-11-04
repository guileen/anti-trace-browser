---
name: kernel-port
description: 自建/轻内核的验收要求、取舍与改造边界；涉及 Obscura、Lightpanda、Camoufox 分工时先读。
---

# 内核移植：要求与取舍

## 0. 目标与判据

**目标**：看起来像普通用户，跨站不可关联，可被 Agent 稳定驱动。

**判据不靠口碑，靠可核对的检查项**：

| 组 | 检查项 | 现有实现 |
|---|---|---|
| Header | 6 类（identity/build/universal/family/protocol/origin），11–14 个具体头 | `audit <env> --headers` |
| 本地身份 | 时区、语言、核心数、屏幕、DPR、权限、存储、音频、WebGL | `audit <env> --local` |
| 站点判定 | reached / cleared / challenge / blocked | `field` + `lab/` |
| 驱动 | CDP 能建页、能取请求头、能截图 | `attach` + `measure` |

## 1. 要求（修订版）

- **R1 参数化**：seed → 全套身份参数；可持久、可重放、可校验；重启不变。
- **R2 真实性优先**：能真实计算就不要伪造。做不到的能力，必须作为“低配设备”自洽声明（WebGL 缺席要同时体现在 UA/CH/GPU 声明里），而不是返回一个空壳对象。
- **R3 协议完整**：CDP 至少支持建页（`Target.createTarget`）、文档请求头可见、截图。
- **R4 构建预算**：CI 内 10 分钟出制品。
- **R5 增量可控**：自研改动 < 30k LOC；不与上游长期对抗。
- **R6 人群一致**：默认身份贴近主流（Chrome on Windows/macOS），而不是小众组合。

## 2. 两个候选的实测代价

| 维度 | Obscura 0.2.6（Rust） | Lightpanda 1.0.2（Zig） |
|---|---|---|
| 代码量 | ~186k Rust ＋ 19.5k 行 `bootstrap.js` | ~302k Zig（692 文件） |
| 身份逻辑位置 | JS 层，42 处 `_fpRand/_fpSeed`；UA 硬编码 `Chrome/145` | `Config.zig` + `HttpClient.zig:494`，集中 |
| 渲染真实性 | 无 WebGL（`class WebGLRenderingContext {}`）；Canvas 仅点阵文字；音频合成 | 无图形管线，输出文本式 |
| CDP | 可驱动；**不暴露请求头** | 只有 STARTUP 目标，建不出页 |
| 上游立场 | 作者本身在做反指纹，方向一致 | `Config.zig` 主动拒绝 Mozilla UA，反伪装 |

**结论**：两者都不满足 R2/R3 全量。差别在“补谁更便宜、更不打架”。

- Obscura：Tier A 改动集中在 JS 身份层＋暴露请求头，**与上游方向一致**，fork 成本低；Tier B（真实图形/音频）不在它能力范围内。
- Lightpanda：构建简单、速度快，但**上游明确拒绝伪装**，我们每次改造都在与作者意图对抗，长期合并成本高；且没有渲染栈，补 Tier B 等于自己带一套图形系统。

## 3. 决策

| 层 | 承担者 | 理由 |
|---|---|---|
| Tier B（Canvas/WebGL/Audio 真值、复杂站点） | **Camoufox**（已收尾冻结） | 原生 Gecko，真计算，无需编译 |
| Tier A（Header、时区/语言、存储、权限、CDP 驱动、高并发抓取） | **Obscura fork** | 改动集中在 JS 身份层，方向与上游一致 |
| 无图抓取吞吐 | **Lightpanda** | 不投入身份改造，保持上游纯净 |

**不做**：把 Camoufox 的全部能力“复刻”到轻内核；Tier B 需要真实图形与音频子系统，那不是补丁量级。

## 4. 落地顺序

1. Obscura：时区/语言跟随出口 → UA 与 `navigator.platform`/CH 一致 → CDP 暴露文档请求头 → WebGL 改为“低配设备”自洽缺席。
2. 每次改动后用同一组检查项验收：`audit --headers` / `audit --local` / `field` 四站表。
3. Lightpanda 仅做一实验：补 `Target.createTarget`，确认其 CDP 是否能承载我们的脚本；不通过就维持“抓取引擎”定位。
