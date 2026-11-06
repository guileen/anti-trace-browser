# challenges

靶场分别记录合成 PoW、Turnstile Siteverify、WAF 观察。服务端回执绑定 run、nonce、hostname、action 和有效期；仅已验证回执产生 `cleared`。规格见 [OpenSpec](../../openspec/changes/evaluate-lightweight-runtime/design.md)。

| 形态 | 命令 | 用途 |
|---|---|---|
| 本地门禁 | `node src/local.mjs --port 8788` | 离线、确定、可进 CI；无 JS 客户端拿 `403`，浏览器靠解 SHA-256 前缀拿到签名 Cookie |
| Cloudflare Turnstile | 受信 Wrangler 部署 | Siteverify 验证；使用独立实验 widget、路由与密钥 |

对照组只用本机真实安装的浏览器或 `--cdp`；Playwright 自带的 Chrome for Testing 已删除，它的 `HeadlessChrome` UA 与 `navigator.webdriver` 会污染结论。

在 `services/challenges` 目录执行：

```sh
npm start                      # 本地，默认 8788
npm test                        # 单测 + 一次完整门禁流程

# 用环境去打靶
../../cli/bin/anti-trace start <env> --headless
../../cli/bin/anti-trace field <env> --sites http://127.0.0.1:8788/
../../cli/bin/anti-trace field --cdp ws://127.0.0.1:9222/devtools/browser/... --sites http://127.0.0.1:8788/  # 对照组
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/          # 403
```

field 使用 reached/cleared/challenge/blocked/error/not_tested；普通跳转为 reached，采集失败为 error，活动挑战保留 challenge（含 HTTP 403）。回执经独立受信端点读取，页面输出与 Cookie/URL 变化作为观察保存。

## 本地门禁做什么

1. 首次访问返回 `403` 与一个带 nonce 的挑战页；
2. 页面在 `crypto.subtle` 上找满足 `sha256(nonce:counter)` 前导零的 counter；
3. `POST /solve` 校验 PoW，发放 HMAC 签名 Cookie（nonce 一次性）；
4. `GET /ok` 校验签名，返回 `user_agent`、`accept_language`、Cookie 名单。

没有 JS 的客户端停在 `403`；改 Cookie 会被签名校验拒绝；nonce 重放返回 `400`。

## 已部署：fingerprint-test.ipub.io

| 路径 | 行为 |
|---|---|
| `/` | 可索引的说明页（title/description/canonical/JSON-LD/sitemap/robots），**不放挑战**，给爬虫与读者 |
| `/check` | 已实现主动开始的 Turnstile 实验页面；线上当前版本仍为历史请求观测页，部署待 widget 写入授权 |
| `/robots.txt`、`/sitemap.xml` | 已生成 |

从仓库根目录执行部署命令：

```sh
cd services/challenges
export CLOUDFLARE_ACCOUNT_ID=...
"$WRANGLER_BIN" deploy -c wrangler.public.toml   # 受信固定版本；secret 进入该 Worker 的 secret store
```

DNS：`fingerprint-test.ipub.io` → 代理的 A 记录（占位 `192.0.2.1`），由 Worker 路由接管。

**2026-11-04 本轮诊断**：token active；目标 account 下 widget 列表 GET 200、数量 0；创建 POST 返回 403/code10000 Authentication error。权限需求为目标 account 的 `Turnstile Sites Write` 或 `Account Settings Write`。Worker 代码/设置已保存到 `.local/deployments/20261104T101549Z/`，资源 diff 与回滚在 manifest；本轮线上资源保持原状。

部署顺序：独立 widget → secret store → 服务端校验 success/hostname/action/nonce → 单次兑换回执 → 实际浏览器与人审。WAF Managed Challenge 作为独立实验；若启用，先保存完整规则快照，再按规则 ID 增量修改并保留回滚，现有生产规则维持原状。

## 部署 Turnstile 版本对账号的影响

- 使用自有测试域、合成数据和有界访问，记录配额、限流、账单与账号政策检查。
- 子域/路由隔离实验流量；账号和 zone 级配置另行核对变更范围。
- `TURNSTILE_SECRET` 存放受控 secret store，日志和公开报告脱敏；凭据通过受信工具处理。
- 本轮 `node --test test/*.test.mjs`：8 项通过；真实 SQLite＋HTTP 验证受控 authority 的成功、单次/并发重放、过期、错误 hostname/action/cdata、上游失败和访问令牌。此证据对应本地验证逻辑。

## 实验与回执接口

- `POST /attempts`：同源 JSON 请求，返回 `run_id/nonce/access_token/expires_at/sitekey`；每 IP 每分钟 10 次，过期结果 24 小时清理。
- `POST /verify`：Bearer run 凭据＋`{run_id,nonce,token}`；SQLite compare-and-set 在 Siteverify 外联前消费执行权，重放返回 409。
- `GET /attempts/<run_id>`：Bearer 凭据读取状态及服务端回执。凭据放 Authorization；报告只记录回执，原始 token、Cookie、IP 留在受控范围。
- `GET /echo`：独立请求 Header 观察，过滤认证/Cookie/IP 字段；与 CDP 观测分别保存。
- `AttemptObject` 是每 run 独立的 SQLite Durable Object；新 migration `attempts-v1`。历史仅检查 `lab_pass=1` 的旧 Worker 已移除，统一部署配置为 `wrangler.public.toml`。

本地 Worker 冒烟（启动命令明确覆盖 origin/upstream，避免生产路由的 Host 重写）：

```sh
npx --yes wrangler@4.109.0 dev -c wrangler.public.toml --local --port 8791 \
  --local-upstream 127.0.0.1:8791 --var LAB_ORIGIN:http://127.0.0.1:8791
```

实际 HTTP 观察：`/`、`/check` 为 200；缺生产 widget/secret 时 `/attempts` 为 503 `capability_unavailable`；错误 origin 为 403。浏览器验证主动启动与错误状态显示，截图在 `.local/qa/origin-check.png`。包解析运行仅用于无凭据本地开发；云端凭据通过受信工具处理。

## 已知边界

Turnstile 的判定还依赖出口 IP 与浏览器声誉，本地门禁不模拟这些；两者回答的是不同问题：本地门禁问“浏览器能否执行挑战”，Turnstile 问“Cloudflare 是否认为这条连接可信”。
