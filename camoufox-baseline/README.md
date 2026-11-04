# camoufox-baseline

Camoufox 原生行为的参考实验。产品实现见 [`../anti-trace-cli`](../anti-trace-cli/README.md)，本目录保留可复跑的对照脚本。

```sh
uv sync
uv run python scripts/setup_camoufox.py
uv run python scripts/paired_environments.py     # A1 -> B1 -> A2 -> B2 双环境对照
uv run python scripts/amiunique_baseline.py      # AmIUnique 官方采集
uv run python scripts/camoufox_baseline.py       # 单环境冒烟
```

报告写入 `.local/reports/`（已忽略）。

## 它回答了什么问题

- 同一内核的两个环境，在同版本、同输入下能否稳定区分（屏幕、核心数、字体、Canvas 像素）。
- Camoufox 的哪些字段由传入指纹决定，哪些随会话变化（PNG 字节、Audio 样本）。
- 哪些"保护"会破坏重启稳定性（`canvas_noise` 每次读回都不同）。

脚本里的默认配置**不满足**产品的双环境门槛，结论已记录在根 [README](../README.md) §4.5；产品侧用设备类别表与字体子集满足它。
