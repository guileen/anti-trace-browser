# Tasks

状态：实施与严格复验持续记账，三路均未获产品放行。范围、状态机及唯一I/O契约见[design](design.md)，场景见[spec](specs/lightweight-runtime/spec.md)。局部实现、完整验收、外部授权分别登记；当前不选赢家。

## 0. 已完成的规划证据

- [x] 0.1 核对当前 field/audit/actions/attached 实现与项目文档；2026-11-04 直接调用得到 ordinary_redirect=cleared、no_observation=reached、unknown header=pass，作为后续修复的失败前证据。
- [x] 0.2 完成 M1–M16 Mind-Test；补齐 GUI、全部必测差异项、控制租约、挑战回执、代理/迁移/构建与维护成本，形成修订后复推路径。
- [x] 0.3 建立本 change，保持实施状态独立；同步 README/技能的现行决策与历史结果适用范围。

## 1. P0 判据校准（先于选型得分）

- [x] 1.1 修复 `anti_trace/field.py` 与 CLI 退出状态，真实 CLI 验证普通重定向 reached、403活动挑战 challenge、采集超时 error、认证合成门禁 cleared；回执绑定同次 visit/run、hostname/action/kind/有效期，跳转不转发访问令牌。场景 E1/E2；证据：`cli/.local/evidence-rules-20261104-delivery/`。
- [x] 1.2 `services/audit/src/manifest.mjs`为唯一版本化manifest，Node consumer与HTTP `/api/manifest`共用；当前 `2026.11.04.4` 固定459项、22场景，绑定真实adapter/viewer/collector源码。独立文字/几何像素、音频输入响应、shader/readback、realm、两site和持久状态保留原始数据；生产者自报pass无效。早期60份报告按当时版本另存重算，原件保留；本轮42项audit回归通过。场景 E3/I1/C1/C3；证据：`browsers/engine-bench/acceptance/`与当前三路raw/verdict；旧`.local/acceptance/history-2026-11-04-suite2/`不作当前通过证据。
- [x] 1.3 Header 按请求/协议/隐私策略校验，unknown与缺预期=review_required；CLI支持独立 `--echo-url`，非完整通过返回非零。实际 HTTP/H1、HTTPS/H1/H2 的 navigation/redirect/fetch/image/Worker 取证；自签证书绕过仅限 fixture。场景 C2；证据同1.1，真实对照组Headless差异/policy pending仍保留。
- [x] 1.4 实际 Camoufox CLI A1/B1/A2/B2×两schemeful site×四lifecycle共32格完成，套件3结果413/434通过、21 outstanding；配置8/12核有效配对。套件2保留4核被上游修为8核的诊断，输入/resolved/实际分别记录。完整联合门槛保持 outstanding。场景 I1/E3/K3；证据：`browsers/engine-bench/.local/acceptance/camoufox-2026-11-04-suite3-native-realms/{raw,verdict}.json`；Camoufox持续安全维护。

## 2. P0 同任务改造实验（与靶场集成可并行）

2.1–2.3为早期同任务实验回执，保留其输入/版本与当时缺口；后续真实双路实现和新增验证另见4及本轮回执，不能混用成本或功能成绩。

- [x] 2.1 两候选commit/toolchain/依赖/命令/许可声明清单已固定，clean与no-change incremental均实际成功，制品和patch SHA独立核对。Rust许可335项声明，Zig含98项当前host Rust依赖声明及原生依赖；3个本地包缺Cargo license字段、完整分发notice继续5.2。缓存边界、下载和失败阶段分开记录。场景 K1/K3；证据：两份cost-card、Lightpanda recovery.json与原始build日志。
- [x] 2.2 两候选原始 CDP 与上游 Puppeteer 均已实际完成 context/target、导航、读取；Lightpanda STARTUP 为特定适配路径问题，原始协议可用。场景 K1；证据：两候选 `cost-card.json` 关联 raw CDP/HTTP 日志。
- [x] 2.3 Obscura 宿主配置与冷 IndexedDB 存储补丁完成，8模块 +184/-11；Rust优化构建136.442s、无变更增量0.129s（共享下载缓存），A1/B1/A2/B2验证配置/网络/Cookie/LS/IDB与真实截图、坐标和中文值输入。页面CJK为tofu、Canvas伪字形、Audio忽略输入、Worker可访问document/window、GL缺席均保留产品gap。场景 I2/L2/C1/G1/K1；证据：`browsers/engine-bench/candidates/obscura/cost-card.json`、`source-review.json`及可重放patch；存储仅已证正常退出，崩溃提交待验。
- [x] 2.4 Lightpanda原生配置/持久链与真实可视接入已执行：DOM/网络/存储为唯一权威，共享Rust组件只布局/绘制；实际CSS、字体、Canvas/GL、坐标、滚动与子frame输入进入统一GUI。32格及完整459项报告已生成；DPR2真GUI完成Meta+A中文替换、按钮/子frame点击和交回Agent；新增2项原生SessionStorage回归通过。旧11模块构建233.052s/增量0.571s仅为早期输入，保留cost-card原件；身份差异、不同出口/主机、IME与发布门槛仍未通过。场景 I2/L2/C1/G1/K1；证据见本轮回执与`browsers/engine-bench/candidates/lightpanda/`。
- [ ] 2.5 发布版基线已完成；两路源码能力补齐后均跑相同完整DOM/JS与可视任务、完整资源加载和统一CLI链路，2预热＋10测量，原始samples/median/p95/CPU/RSS/IPC/输出分别保留。场景 K2；现有证据：`browsers/engine-bench/.local/performance/native-2026-11-04.json`、`camoufox-2026-11-04/report.json`；不是完成后的性能结论。
- [ ] 2.6 仅在两路完整实现及三路严格验收后比较最终选型，记录满足项、待补项、维护/许可成本、性能和不确定性。用户明确当前不二选一，此项不阻断4.x。场景 K1/K2；证据：三路同版本完整验收与成本卡。

## 3. P1 自有靶场（依赖 1.1；独立于内核选择）

- [ ] 3.1 诊断与回滚快照完成：token active、widget GET200/count0、POST创建403/code10000；token policy读取403/code9109。目标 account 的 widget 写授权为外部依赖，生产资源维持原状。待授权后独立widget/secret store/部署；WAF另行增量审批。场景 T2；证据：`services/challenges/.local/deployments/20261104T101549Z/manifest.json`和旧Worker快照。
- [ ] 3.2 验证核心与 `AttemptObject` 已实现：SQL compare-and-set、run级Bearer、Siteverify success/host/action/cdata、5分钟有效与24小时alarm。8项SQLite＋HTTP回归通过；实际本地Workers runtime创建201、无凭据404、验证上游错误502/状态error、重放409。生产新token成功/重放验收待widget授权。场景 T1/T2；证据：`services/challenges/.local/qa/durable-runtime.json`、`services/challenges/test/attempt.test.mjs`。
- [ ] 3.3 主动开始页面、脱敏echo与CLI `--site-config` 回执消费已接入；本地HTTP与浏览器origin错误页已验，生产闭环、人审与实际widget回执待3.1。SEO首页/robots/sitemap路由维持，旧客户端cookie放行Worker已移除。场景 E2/T1/T2；证据：`services/challenges/.local/qa/`、1.1 CLI证据。
- [ ] 3.4 获得可用不同出口后，按时间交错/随机顺序重复引擎×出口×headless 对照；记录出口漂移和置信范围，更新网络归因。场景 N2；证据：受控实验表。住宅出口凭据属于外部依赖，其余自有靶场工作继续。

## 4. P1 双路线完整实现与共享产品接入（依赖1，不依赖2.6）

- [ ] 4.1a Obscura真实宿主配置/持久状态、字体/Canvas/Audio/Worker/GL和统一GUI均已构建运行，旧模拟输出已替换；原生输入、私有特权与完整459项已复验。此项不勾：C1仍检出Canvas context品牌及Canvas/Audio非法操作异常缺口，I1规定差异未满足；不能把真实组件接入称作完整浏览器合格。场景 I1/I2/C1/C3/G1；证据：最终制品ac6e3490、427/459、真实PNG/DOM与raw/verdict。
- [x] 4.1b Lightpanda：宿主EnvironmentSpec=3/回执/迁移，接入真实CSS/图像/Canvas/GL，布局/截图/坐标/滚动共用结果；保留原生Worker与Audio并完成固定矩阵复验。LP DOM/网络/存储为唯一权威，渲染缓存不另执行页面或发网。真实GUI、进程级崩溃/锁/提交、迁移/回退及跨tab SessionStorage已验；实现完成不等于I1差异或发布放行。场景 I1/I2/C1/C3/G1；证据：本轮源码制品、PNG/DOM、原生回归与完整raw/verdict。
- [x] 4.1c `anti_trace/native.py,native_spec.py`接入两路线单CDP连接和Playwright风格已实现子集；native回执绑定输入文件、runtime与assets摘要，READY前验证。CLI `create --runtime`统一两路typed overrides/seed/resolved与权限。两路首脚本/iframe/Worker/HTTP与错误输入、真实多tab Python任务、普通evaluate表达式及参数函数已验；不宣称完整Playwright或浏览器标准。场景 I1/I2/C1/L1；证据：本轮三路矩阵及smoke。
- [ ] 4.2 落地单进程租约、持久存储提交、冷导出/安全导入及显式迁移/回退；扩展实际 CLI 测并发 start、异常退出、目录冲突、跨版本/跨主机兼容检查。场景 L1/L2/I3；证据：进程树、锁、存储 hash、归档及迁移报告。
- [ ] 4.3 `viewer.py`与实际GUI接入三路统一人机控制，固定page/frame/observation ID；缓存真实引用，变化返回stale_reference；axtree标source/coverage并遮蔽密码。场景 G1/G2/A2；证据：真实画面、动态DOM/iframe/Shadow DOM、切tab、中文IME、断线暂停和人审录屏。
- [ ] 4.4 `runner.py,script_worker.py`实现受信Python Playwright风格脚本子进程与单认证连接，循环/分支/locator等待、JSON、取消/期限/输出边界；迁移所有旧步骤脚本调用者与示例，删除旧解析器及过时测试。三路均实际执行。场景 A1/A2；证据：完整任务、报错行号、人工中断及IPC/输出对照。
- [ ] 4.5 在运行时网络层应用代理和 strict/observe 策略，保留稳定身份、分别记录出口；用受控 DNS/HTTP/UDP/IPv6/WebRTC 端点或包观测验证断线行为。场景 N1/I2；证据：代理断线后的请求记录、DNS归属与泄露覆盖。

## 5. P2 发布验收（依赖以上实施项）

- [ ] 5.1 Camoufox、Obscura、Lightpanda分别生成同版本完整门槛报告：A1/B1/A2/B2、两schemeful site、重复/刷新/新页/重启、GUI↔Agent、网络失败、迁移、挑战回执、性能。全部22场景逐项映射当前可比证据；缺失/unsupported/error/review_required保持未通过。场景 E1–K3 全集；证据：三路raw/verdict、遗留项、GUI人审；任何一路不借另一条成绩放行。
- [ ] 5.2 完成依赖/license/安全更新清单与恶意页面隔离评估、干净机器安装构建运行、CLI help/错误/JSON规范、敏感信息扫描、产物 digest 和上游升级演练；更新唯一总入口，实施验收通过后归档 change。场景 K3/T2；证据：发行包、构建日志、端到端记录、签收。

## 6. 独立 Mioa Headless 服务（2026-11-04 用户新增）

桌面客户端已迁入独立私有仓库维护，本开源仓库仅保留并维护固定提交的 `core/` 子模块（`core/mioa-headless`）无头服务。

- [x] 6.1 `core/mioa-headless`（`mioa-core@fff9c4f` 子模块）独立 Python 3.12 / uv 项目与本地会话服务完成：复用单 Engine、ControlState、原生适配和持久目录，支持 LPFR v2 共享内存原始 RGBA 帧环（C11 acquire/release 原子同步）与 `0600` UDS 控制面，独立运行无桌面端依赖。72 项单元与生命周期回归通过，包含占用冲突、旧帧拒绝、中文输入、history/tabs、100 页并发隔离上下文（0 主世界泄漏）、持久关闭/重开和 EOF 退出。场景 D2/D3。

## 7. 真实指纹、统计语义与稳定环境（2026-11-04用户修订）

- [x] 7.1 固定输入、条件、原始数据和参考范围；分别采集Chrome/Camoufox与两候选的Canvas像素/PNG/文字度量、Audio实际图/样本、GL编译/纹理/读回，标注OS/backend/字体/DPR/色彩/realm/生命周期。为每项实现实验固定成本与资源预算。场景F1；证据为采样清单及原始文件，全球统计覆盖独立登记。
- [x] 7.2 新增独立版本化真实性判据，结合功能断言、输入变换、颜色/alpha/空间/边缘与频谱/能量统计；阈值来源、适用输入和参考样本先固定。有效纯色图应通过，固定输出、直方图相同的乱序像素、忽略音频输入应失败；保留未公开输入交叉验证。场景F1/F3；历史矩阵保持原判。
- [x] 7.3 两路按实际缺口补齐真实字体/绘图/DSP/GL和跨realm语义，修正HTTP/JS声明与实际能力的一致性；先处理已观察到的Chrome124 UA与Lightpanda Client Hints声明组合。逐项记录修改前后功能、统计、稳定、源码和成本。场景F1/C1/C2/C3；精确复刻Chrome输出退出交付门槛。
- [x] 7.4 持久保存真实配置/资产/backend，验证A1/B1/A2/B2、刷新/新页/支持Worker/iframe，同环境稳定与预定义A/B特征组合差异同时成立。每项差异给出真实成因；共有物理输出与缺口单列。场景F2/I1/I2；保留raw与独立裁定。
- [x] 7.5 组合验证Desktop/headless/Agent同会话、隔离和实际任务；按K2同能力同资源测量两预热加十次任务的median/p95/CPU/RSS/IPC。真实性、稳定/差异、网络、第三方挑战和人工签收各自记账；高成本后端扩展按实际收益复审。场景F1–F3/G1/K2/K3。

## 验证口径与本轮回执

2026-11-04最终同版复验：`2026.11.04.4`，固定459项、22场景；同race/input/source绑定，三路采集均无collector error。每路独立判分，不以多数项或另一条路线代替硬门槛。

| 运行时 | 必需项通过 | Outstanding | 完整场景通过 | 裁定 |
|---|---:|---:|---:|---|
| Camoufox | 428/459 | 31 | 7/22 | NOT_PASS |
| Obscura | 427/459 | 32 | 6/22 | NOT_PASS |
| Lightpanda | 428/459 | 31 | 7/22 | NOT_PASS |

唯一本轮汇总：[`scoreboard.json`](../../../browsers/engine-bench/.local/acceptance/strict-three-runtime-suite4-1793814768117424000/scoreboard.json)；对应原始目录为`camoufox/`、`obscura-r3/`、`lightpanda-r2/`，历史报告不覆盖。winner=null；这不是完成的性能排名。

- 已测失败：三路纯几何Canvas、Audio、GL渲染输出未全部形成规定A/B差异；不添加假噪声过关。Camoufox仅杀manager后子进程仍活着时lease已可获取，L1失败；两原生路线继承lease并在EOF后退出/提交的同测通过。Obscura另有上述C1语义缺口。
- 用户阶段决策（2026-11-04）：暂接受Canvas/Audio/GL环境间输出差异不足，暂缓I1差异化改造，不为填满判据修改像素/采样值。后续先追溯真实字体、布局、色彩、GPU驱动/backend及DSP差异，评估显示/读回一致性、功能兼容、稳定性、可识别性与跨realm一致性；无安全依据或风险更高则不改。原始fail及严格总判保留；此决策不豁免API语义、特权隔离、崩溃租约或网络安全问题。
- 当前提案修订（2026-11-04，承接上述阶段决策）：以真实Canvas/Audio/GL计算、输入相关统计语义、同环境稳定和真实配置组合差异为目标；Chrome提供兼容及经验参考，逐字节输出相同退出硬门槛。历史报告与前轮精确Chrome提案保持原始语境；§7新增判据与运行回执独立记账。
- 未通过与未测分开：不同出口locale冲突、跨主机恢复、完整HTTPS/H2与DNS/IPv4/IPv6/UDP/WebRTC证据、外部浏览器存活、生产挑战闭环、完整任务性能、隔离/许可/干净安装与人工IME/手感签收仍保持各自gate，不借历史局部回执补成通过。
- 最终Obscura真实HTTP首脚本不能取得trusted marker或伪造isTrusted；独立HTTP与Worker特权回归各1项通过，CDP输入6项通过。实际DPR2 GUI完成Meta+A中文替换、Tab到计数按钮、原始子frame点击与交回Agent；PNG与DOM一致。完整操作/脚本/版本见[`runtime-smoke-final.json`](../../../browsers/engine-bench/.local/acceptance/product-smoke-1793802818047430000/runtime-smoke-final.json)。JS实现可维护性不能替代特权隔离、标准语义与恶意页面隔离证明。

- Mind-Test M1–M27按实际失败更新；Worker独立global、调度/终止与配置一致性分别记账，人工换tab后旧run不得暗中切回，控制状态同步实际所选page/frame。
- 前轮CLI59/audit22/lab8与Camoufox32格仅适用于原输入。本轮82项Python回归、42项Node审计/判据回归通过；这些不是三路产品通过证据。
- 基准缺陷维护：修正socket消失被当作进程退出的stop→start竞态；IPC观察不删除所有权，STOPPING保留状态，start/stop协调并等待真实lease；reset保留锁inode，rm --force共用正常停止流程。旧CLI acceptance全部通过（81.79s，局部契约）；最新真实CLI完成两轮停止/启动、活动环境拒绝reset/rm、停止→reset→重启→force rm，最后Profile不存在且原PID已退出。证据 `cli/.local/lifecycle-delivery/`；长socket路径fixture失败另存，修为短/tmp路径；完整崩溃/迁移门槛继续4.2。
- 2026-11-04三路均由同一真实CLI创建/启动，Obscura与LP源码制品均已编译；同一个异步Python脚本在Camoufox/LP成功，Obscura暴露真实tab激活缺口继续修复。真实主/子frame引用、密码遮蔽、中文DOM输入、同会话HTTP输入回执、冷Cookie/LS/IDB搬运及显式迁移/回退已做局部smoke；输入字体与iframe实画等缺口保留。证据：`browsers/engine-bench/.local/acceptance/product-smoke-1793802818047430000/smoke.json`及同目录PNG。
- 首轮Camoufox诊断suite4为425/459、34 outstanding，不放行。随后加强真实adapter源码绑定、修复独立负例之间显式reclaim和实际代理/归档取证；旧诊断不充作新源快照的最终报告。三路最终矩阵仍见5.1。
- 2026-11-04追加真实回执：Camoufox与LP在独立Ego QA空间完成中文输入、计数按钮、子frame点击、交回Agent，实际DOM与PNG一致。Obscura默认字体启动、完整Python多tab脚本、原始子frame引用点击、私有身份状态反射通过；GUI发现子raster错位，仍不放行。另修复并实际复验控制状态page同步与Native evaluate把普通表达式返回值误当函数的问题。原始操作记录、输入与失败PNG保留，不用局部回执覆盖固定矩阵结论。
- 当前生产CF权限：读取widget可用，创建写403；权限修复和用户GUI签收属于外部依赖，其余源码实验继续。
- 构建/性能仅按所记录的版本、工具链、缓存与工作量解释；源代码构建时间与运行时吞吐分开。旧1.66s/96s等保留原语境。
- 本轮双路赛马文档经OpenSpec1.16.0 `validate evaluate-lightweight-runtime --strict`实际通过；只证明规格结构。9条Requirement、22场景；当前三路产品仍NOT_PASS，change不归档。独立QA空间15、10个自建合成Profile和本地fixture已关闭/移除；脚本内容与原始回执保留，见smoke目录`cleanup.json`。

### 2026-11-05真实性规则与参考

- `authenticity-2` / `authenticity-inputs-2`：命令颜色/几何、正弦DSP、2×2纹理shader的解析预期独立于被测引擎。统计保留颜色/alpha分布、4×4空间均值、边缘、频率/能量/拟合残差；不以熵或Chrome字节相同判通过。O/I拓扑与同长度多文字重排排除矩形伪字形。
- PNG/readback：不透明RGB及全部alpha精确，透明RGB为零；仅alpha128的RGB允许±1，来源为8-bit预乘/反预乘量化半步界。正式Chrome在两站点的[v2参考](../../../browsers/engine-bench/.local/authenticity/chrome-reference-1793861475707/report.json)通过；参考范围为本机两次采样，非全球分布。Camoufox与两候选另跑完整32格。
- Window/iframe三类能力必需；Worker的Canvas/GL按实际支持路径测，缺席明确unsupported；Window-only OfflineAudioContext不移植到Worker冒充支持。字体响应输入要求实际配置含可用比例/等宽字体；单字体别名回落按清单适用性解释，不重判既有失败。
- 服务端每格独立run ID，保存导航/fetch/Worker原始请求；真实viewport PNG另验显示色块。源码快照、native补丁、制品与编译回执、配置原始字节和资产摘要绑定到每轮报告。
- 本轮实际回归：审计58、CLI82、headless13通过。负例包含常量/忽略输入、空间乱序、同能量方波、错误PNG、矩形字形、O/I互换与输入/版本污染；不是产品全部gate通过。
- F1/F2实际矩阵：[Camoufox](../../../browsers/engine-bench/.local/authenticity/camoufox-1793865475421/report.json)、[Lightpanda](../../../browsers/engine-bench/.local/authenticity/lightpanda-1793866069834/report.json)、[Obscura](../../../browsers/engine-bench/.local/authenticity/obscura-1793866069818/report.json)各32/32格通过。Obscura四个Worker图形稳定项保持optional/unsupported；其余必需HTTP、配置、存储、支持特征稳定、字体因果差异与source/build绑定通过。
- 已构建native制品：LP `7ce7053e` / patch `be74064a`，Obscura `f5acf336` / patch `866c2822`；完整摘要与实际回执见各候选`current-build.json`。LP真实rgba/DITHER及共享比例/等宽字体修复，Obscura frame绘图/Audio私有receiver/经典Worker导入与原生CH修复均进入实际矩阵，不依赖测试专用输出。
- 原生回归：Obscura真实性13项、另行实际Arial/Menlo字体1项、isolated-context真实wire1项通过；LP原生Identity、RGBA各1项通过。初次Worker改为multi-thread reactor触发deno_unsync CurrentThread断言；保留失败并修为Deno current-thread加独立I/O reactor，原测试及实际32格通过。
- 历史桌面专项证据不在本公开文档披露。
- 最终完整任务按LP→Obscura→Camoufox顺序、相同collector/source/workload执行，每路两预热加十测；实际inner与PNG均1280×800@1。三路任务正确性10/10，两原生预算10/10、Camoufox因RSS预算0/10；全部正确样本保留统计。median/p95/CPU/RSS、冷/热启动、资源、8次操作IPC及6次CLI调用见[交叉绑定汇总](../../../browsers/engine-bench/.local/authenticity/implementation-1793868323575.json)与[README成本表](../../../README.md#512-真实计算与稳定环境2026-11-05)。此前Obscura776px配置失败保留；按既有available-area模型补偿24px后用同源三路完整重测，不改输出或阈值。
- 最终同制品[独立headless11项smoke](../../../browsers/engine-bench/.local/authenticity/gui-1793862573993/final-headless/headless-smoke.json)通过，含Agent同会话、真实输入、占用冲突、存储重开、stale frame拒绝与EOF/native退出。当前新规则与单机成本已完成；外部网络/挑战、异机迁移、发行和真实IME/手感gate继续独立，不归档change。OpenSpec1.16.0 strict实际通过。
- 收尾：[执行脚本与清理回执](../../../browsers/engine-bench/.local/authenticity/cleanup-1793868674267/verification.json)保留精确输入，14个尚存自建home先归档后移除、10个已由collector清理；4份临时执行脚本删除、自有GUI fixture停止。所有raw、失败裁定、source快照及native构建缓存保留；既有审计服务、用户窗口与Profile未改动。
