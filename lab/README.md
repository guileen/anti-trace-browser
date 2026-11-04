# lab

靶场：把“有没有通过”变成我们自己的信号，而不是对厂商页面的推测。

两个形态，判定口径一致：

| 形态 | 命令 | 用途 |
|---|---|---|
| 本地门禁 | `node src/local.mjs --port 8788` | 离线、确定、可进 CI；无 JS 客户端拿 `403`，浏览器靠解 SHA-256 前缀拿到签名 Cookie |
| Cloudflare Turnstile | `wrangler deploy` | 真实 Turnstile 判定，独立子域，不影响主站 |

对照组只用本机真实安装的浏览器或 `--cdp`；Playwright 自带的 Chrome for Testing 已删除，它的 `HeadlessChrome` UA 与 `navigator.webdriver` 会污染结论。

```sh
npm start                      # 本地，默认 8788
npm test                        # 单测 + 一次完整门禁流程

# 用环境去打靶
../anti-trace start <env> --headless
../anti-trace field <env> --sites http://127.0.0.1:8788/
../anti-trace field --cdp ws://127.0.0.1:9222/devtools/browser/... --sites http://127.0.0.1:8788/  # 对照组
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8788/          # 403
```

判定：`cleared`（被拦之后解开）、`challenge`（停在挑战页）、`blocked`（挑战页且仍被拒）、`reached`（未遇挑战）。

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
| `/check` | 判定页：返回实际收到的请求头与 `cf-ray`；WAF 的 Managed Challenge 规则应挂在这一条路径上 |
| `/robots.txt`、`/sitemap.xml` | 已生成 |

部署命令：

```sh
cd lab
export CLOUDFLARE_API_TOKEN=...   # 或使用 ~/.cf 里的 token
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler@4 deploy -c wrangler.public.toml
```

DNS：`fingerprint-test.ipub.io` → 代理的 A 记录（占位 `192.0.2.1`），由 Worker 路由接管。

**2026-11-04 实际部署结果**：`/` 与 `/check` 均 200，`anti-trace field` 判定 `reached`。**Managed Challenge 尚未启用**：当前 token 的权限足以部署 Workers 与写 DNS，但创建 Turnstile 组件与编辑 Zone WAF 均返回 `Authentication error`。补齐这两项后，只需一条规则：

```sh
# 需要 Zone WAF:Edit
curl -X PUT .../zones/$ZONE/rulesets/phases/http_request_firewall_custom/entrypoint \
  -d '{"rules":[{"action":"managed_challenge","expression":"(http.host eq \"fingerprint-test.ipub.io\" and starts_with(http.request.uri.path, \"/check\"))","enabled":true}]}'
```

之后同一命令 `anti-trace field <env> --sites https://fingerprint-test.ipub.io/check` 会给出 `challenge` / `cleared`，而不是 `reached`。

## 部署 Turnstile 版本对账号的影响

- 这是 Turnstile 的**正常用法**：一个子域、一个探测页、免费额度足够；
- 与主站隔离：独立子域、独立路由，主站流量与规则不变；
- 唯一成本是额度与误伤自己的自动化；`wrangler.toml` 里的 `LAB_ORIGIN` 只是占位，部署前改成真实域名；
- 不要把 `TURNSTILE_SECRET` 写进 `wrangler.toml`，用 `wrangler secret put`。

## 已知边界

Turnstile 的判定还依赖出口 IP 与浏览器声誉，本地门禁不模拟这些；两者回答的是不同问题：本地门禁问“浏览器能否执行挑战”，Turnstile 问“Cloudflare 是否认为这条连接可信”。
