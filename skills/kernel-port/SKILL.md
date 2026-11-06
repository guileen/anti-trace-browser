---
name: kernel-port
description: 自建/轻内核的验收要求、取舍与改造边界；涉及 Obscura、Lightpanda、Camoufox 分工时先读。
---

# 轻内核改造入口

当前后续工作以 [OpenSpec change](../../openspec/changes/evaluate-lightweight-runtime/proposal.md) 为唯一规格来源；[设计与 Mind-Test](../../openspec/changes/evaluate-lightweight-runtime/design.md)、[实施任务](../../openspec/changes/evaluate-lightweight-runtime/tasks.md) 分别记录架构与验收状态。

## 产品目标

反追踪、抗审查的多环境管理与AI headless自动化，保留基本GUI、人机接管和二次开发。seed＋显式覆盖＋代理＋隔离持久存储；真实Canvas/Audio/GL计算、输入相关统计语义、同环境稳定和真实配置导致的A/B特征组合差异共同验收。Chrome提供兼容/经验参考，跨引擎逐字节一致退出硬门槛；性能和维护成本独立实测。

## 当前决策

- Camoufox：固定每轮基准版本，吸收配置生成、跨域一致性、权限和存储策略；持续安全维护与回归。
- 用户2026-11-04明确三路赛马：Obscura与Lightpanda两路都实现，Camoufox同场复验；最终选择延后，不再作为实施前依赖。功能缺席、未测与review_required均不能算整体通过。
- 客户端失败先用原始协议和上游示例分层定位；JS/原生实现分别验证功能、对象语义和状态所有权。
- 现有 `obscura-runtime` 注入实验保留为历史证据；后续产品配置由宿主在页面执行前传入。
- Moli/Fury 保留历史/外部对照；MCP 在明确调用方需求出现后另作适配决策。

## 执行纪律

1. 先修检查项：正常跳转、缺证据、未知 Header、挑战回执分别记录。
2. 逐项保存真实像素/编码、Audio图/样本、GL执行与软件语义；按OpenSpec F1–F3结合独立输入、语义/统计、负例和生命周期验证，差异成因绑定实际配置，原始样本和历史判分分别保留。
3. 页面真实画面、坐标输入、中文输入、人工接管属于选型门槛。纯 DOM 和可视任务性能分榜。
4. Header 按请求/协议/隐私策略校验；locale 可由用户选择，WebGL 能力独立声明；cf-ray 用于请求关联。
5. 持久 resolved 与 runtime/generator/assets 版本共同决定重放；迁移先做兼容检查。
6. 保留原始样本、失败分母、来源与人工验收。测试集合按独立输入和新观察更新；规格通过与运行通过分别登记。

## 历史执行证据（2026-11-04）

- 判据版本 `2026.11.04.3`；普通跳转=reached、采集错误=error、活动挑战=challenge，cleared 由受信服务端同次run回执决定。unknown Header及缺构建/策略预期=review_required。
- JS胶水可维护性与功能语义分开评估。Obscura固定源码的Canvas伪字形、忽略输入的Audio、Worker访问document/window均属于具体gap；采用真实字体/光栅化、DSP、realm组件补齐。`[native code]`文本单独作为诊断。
- Obscura宿主配置＋IndexedDB冷持久化补丁已编译并实跑，成本卡：[`obscura`](../../browsers/engine-bench/candidates/obscura/cost-card.json)。代码切片通过与产品全门槛分开登记。
- Lightpanda源码patch已clean-built并验证原生配置与三类冷持久存储；Worker无document/window，Audio频率、连线、增益与start/stop响应实测成立。文字PNG/诊断viewer和CSS真实页面分开；构建传输、源码编译与运行时性能分别记账，详见[`成本卡`](../../browsers/engine-bench/candidates/lightpanda/cost-card.json)。
- Camoufox完整32格新套件413/434通过、21 outstanding；同环境稳定与三类存储成立，硬件差异逐项保留缺口。源版本/输入/字体条件决定结论适用范围。

## 当前实现（2026-11-05）

- `authenticity-2`单独判真实计算与输入语义，三路各32/32生命周期格通过；[当前回执](../../README.md#512-真实计算与稳定环境2026-11-05)。历史套件不重判。Worker Canvas/GL只测实际支持路径，缺席单列；比例/等宽字体响应先满足真实字体库存条件。
- 重放：`node browsers/engine-bench/acceptance/authenticity-race.mjs --runtime <runtime> --seed <seed>`。固定seed/非字体配置/资产/backend，只干预真实字体选择；保留共有物理输出，不加假噪声。源码快照、build绑定、配置原始字节、独立HTTP回执与显示像素共同留证。
- 性能：`node browsers/engine-bench/acceptance/task-performance.mjs --runtime <runtime>`，顺序两预热加十测；固定实际内容视口而非只固定screen。正确样本超预算仍计统计，功能与预算分别记账；CPU/RSS/IPC口径见[design §7](../../openspec/changes/evaluate-lightweight-runtime/design.md#7-真实性实现2026-11-05)。
- Obscura Deno Worker保留current-thread reactor；同步import的I/O另由一线程驱动，所有Rc/V8仍在所属线程。切成multi-thread Deno reactor会触发deno_unsync断言；真实导入/取消/错误与HTTP一致性回归需随修改重跑。
