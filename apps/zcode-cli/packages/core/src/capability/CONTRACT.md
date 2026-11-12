# cli-capability

能力积木的**实现层**：统一信封、错误码归一、sidecar v3 的组装与缓存判据。

不变量：

- **纯逻辑，不碰 IO**：读文件、算指纹、落盘都在调用方（命令面 / adapter）。
  这一层只把「已经读好的东西」变成 sidecar —— 便于单元测试，也避免两条写入路径。
- **分类只认映射表**：`type` → `category` 走 `OCR_ELEMENT_TYPE_CATEGORIES`，
  表里没有的一律 `other`，**不静默吞掉**（计数进 `otherElements`）。
  `type` 是开放字符串（随引擎档位变），所以**不能**拿字符串直比做分类。
- **页成分判定是全函数**：(hasText, hasImage, hasOther) 的 8 种组合全部有定义，
  没有「未覆盖」的分支。
- **失败页 ≠ 空白页**：`status: "failed"` ⇒ `composition: null`、`elements: []`；
  `status: "ok"` 且没有元素 ⇒ `composition: "empty"`。
- **缓存四条判据全满足才算命中**：版本、源文件**内容** sha256、档位、积木所需产物。
  命中 ⇒ **不重跑引擎**（这是「业务只传原始路径」的前提）。
- **错误码单向归一**：引擎内部码 → 8 个能力码，原始码进 `details.engineCode`。
  降级不是错误（进 `metrics.warnings` / `metrics.degradedFrom`）。
- **sidecar 路径基准**：`artifactsDir` 相对 sidecar 所在目录；`imagePath` 与
  `markdownPath` 相对 `artifactsDir`。
