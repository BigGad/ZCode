# cli-capability-blocks

能力积木的**对外契约**：业务侧 spawn `zcode <族> <动词>` 子进程后要解析的东西。
完整规则见 `apps/zcode-cli/docs/design/v2/capability-cli-blocks.md` §5 / §6。

不变量：

- **信封只有一个**：`{version, key, ok, output | error, metrics}`。`ok` 是判别子 ——
  成功必带 `output`，失败必带 `error`；两者不同时出现。
- **`key` 是闭集**：`ocr.inspect` / `ocr.parse` / `ocr.doctor` / `ocr.models.download`。
  它是**积木 id**，与注册表能力键（`ocr` / `doc.parse` …）是两套命名空间，不要混用。
- **`error.code` 只取 8 个值**：`unsupported_input` / `invalid_input` / `unavailable` /
  `not_found` / `permission_denied` / `cancelled` / `timeout` / `internal`。
  引擎内部码只出现在 `details.engineCode`。
- **退出码由 `error.code` 决定**：成功 `0`，`timeout` `124`，`cancelled` `130`，其余 `1`。
  运维面动词（`doctor`）例外：恒 `ok: true`、恒退出码 `0`（D14）。
- **降级不是错误**：档位降级、部分页失败都进 `metrics.warnings` / `metrics.degradedFrom`，
  `ok` 仍是 `true`。
- **`output` 只放产物引用**（sidecar 路径、产物相对路径、缓存命中标记），产物本体在磁盘上。
- **sidecar 版本号不复用**：当前统一格式是 `3`；`1`（tesseract 变体）与 `2`（MinerU 变体）
  是**已废止**的历史变体。
- **sidecar 路径基准写死**：`artifactsDir` 相对 sidecar 所在目录；`elements[].imagePath`
  与 `text.markdownPath` 相对 `artifactsDir`。
- **`elements[].type` 是开放字符串**（随引擎档位变化），分类靠 `category`，不靠字符串直比。
