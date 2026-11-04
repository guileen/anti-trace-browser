# audit-service

本地浏览器审判台。用同一套探针与任务给访问者打分，作为产品验收的可重复基线。

```sh
npm start                 # http://127.0.0.1:8765/
npm test                  # node --test
```

## 评分口径

四个轴各自独立计分，固定分母，缺证据记零：

| 轴 | 测什么 |
|---|---|
| 反追踪 | Canvas/WebGL/Audio/字体/Navigator 等可读值与跨环境一致性 |
| 自动化可见性 | `navigator.webdriver`、原型纯净度、事件与几何行为 |
| 功能 | 页面渲染、存储、Worker、媒体等真实可用性 |
| 性能 | 首屏与探针完成的耗时、帧与内存采样 |

## 边界

分数只证明**本地探针观测到的事实**。跨站关联、真实 WAF 挑战与账号风险不在计分范围内，结果按覆盖状态单列。第三方站点（AmIUnique、EFF、BrowserLeaks）的证据由 `anti-trace audit --fp/--leaks` 归档，不并入本地得分。
