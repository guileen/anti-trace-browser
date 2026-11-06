# obscura-runtime（实验，未进入产品）

在 Obscura 上验证「用持久化 EnvironmentSpec 换取稳定身份」的可行性。

```sh
npm test
node scripts/paired_environments.mjs             # A1 -> B1 -> A2 -> B2 对照
```

## 状态：仅作证据保留

数值层面达标（双环境区分、重启稳定、~90MB、1.66s 四轮），但实现方式是 CDP 注入的 JS 层：

- `src/preload.mjs` 用 `Page.addScriptToEvaluateOnNewDocument` 重写 `OfflineAudioContext`、`WebGLRenderingContext` 与 `_Canvas2D.fillText`（5×7 点阵字形）；
- 上游 `crates/obscura-js/js/bootstrap.js` 本身就是 JS 实现的伪随机指纹，`_fpSeed` 每次导航重算。

因此 `gl instanceof WebGLRenderingContext`、`getParameter.toString()`、缺失的 `createShader` 都会暴露注入；复杂页面也会因空壳 WebGL 直接失败。

反追踪主线因此交由 [`../../cli`](../../cli/README.md)（Camoufox 原生实现）承担；本目录保留为轻量抓取路线的度量与教训。
