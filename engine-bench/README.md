# engine-bench

轻内核的性能与功能对照：Lightpanda、Obscura、Moli，同设备、同任务、重复取样。

```sh
npm run setup             # 下载锁定版本的运行时到 .local/runtimes
npm run compare           # 逐引擎跑 DOM/JS 往返、存储、渲染挑战与资源采样
```

外部二进制可用环境变量指定：`MOLI_INSTALLED_PATH`、`LIGHTPANDA_PATH`、`OBSCURA_PATH`；未指定时按 PATH 查找。

## 结论（本机，三次取样中位数）

| 引擎 | DOM/JS 往返 | 引擎树峰值 RSS | 真实 CSS 像素 |
|---|---:|---:|---|
| Lightpanda | 2.46ms | 59.7MiB | 文本式输出，单独评价 |
| Obscura | 8.20ms | 94.1MiB | 通过 |
| Moli | 11.95ms | 129.2MiB | 通过 |

速度优势来自省掉图形管线与资源下载，不是省掉了浏览器语义。这组数字只描述吞吐与开销，不代表反追踪能力。
