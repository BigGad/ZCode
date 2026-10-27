# `zcode recognize` — 图片文件夹多模态识别 CLI

## 1. Purpose & Scope

`zcode recognize <folder>` 是新增的 CLI 子命令，对一个本地图片文件夹（jpg/png/webp/gif）做批量多模态识别，按 `--schema` 输出描述 / 问答 / 结构化字段三类结构化结果。

**适用场景**

- 截图批量描述 / 分类
- 票据 / 表单按字段抽取（`--schema structured --fields invoice_number --fields total`）
- 对一组图片问同一组问题（`--schema qa --questions "..."`）
- 视觉模型的批量回归测试

**不适用**（v1 显式排除）

- 远程 URL 自动下载（`message-attachments.md:332` 第一阶段不做）
- PDF / HTML / 视频混入（只走图片附件通道）
- EXIF 方向校正（`inline-media-resolver.ts` 不解析 EXIF）
- 实时直播（与 `stream watch` 流水线无关）
- 桌面 GUI 集成（仅 CLI 子命令；Renderer 暂不接）

## 2. Command Surface

```
zcode recognize <folder> [flags]
```

| Flag                | 类型            | 默认 | 说明                                                                              |
| ------------------- | --------------- | ---- | --------------------------------------------------------------------------------- |
| `--model`           | string          | 见 §4 | Picker 串 `providerId/modelId[$reasoningLevel]`，复用 `parseModelPickerValue`      |
| `--schema`          | enum            | `description` | `description` / `qa` / `structured` 三选一                                  |
| `--fields`          | string[]        | —    | 仅 structured 模式，从图片中提取的字段名（可重复）                              |
| `--questions`       | string[]        | —    | 仅 qa 模式，要问的问题（可重复）                                                  |
| `--max-concurrency` | int             | `4`  | 并发上限，clamp 到 `[1, totalImages]`                                            |
| `--recursive`       | bool            | `false` | 递归子目录（默认不开避免误扫大目录）                                          |
| `--image-glob`      | string          | —    | 额外的 glob 过滤（默认按扩展名白名单）                                          |
| `--output-format`   | enum            | `text` | `text` / `json` / `stream-json`（全局 flag 已存在）                            |
| `--json`            | bool            | `false` | 等价 `--output-format json`（全局）                                          |
| `--no-color`        | bool            | `false` | 关闭 ANSI（全局）                                                              |

**Scope 错误**（exit 1 + stderr）：

- `--schema structured` 但缺 `--fields`
- `--schema qa` 但缺 `--questions`
- `--fields` 与 `--schema` 不匹配
- `--questions` 与 `--schema` 不匹配
- `--schema` 取值不在 `description|qa|structured` 内
- 缺少 `<folder>` 位置参数

新 flag 全部在 `arguments.ts` 的 `parseArgs({ strict: true })` 全局预注册（数组类 `multiple: true`）；`--output-format` / `--json` / `--no-color` 是既有全局 flag，本命令只消费不新增。

**退出码**：

| 码 | 含义 |
| --- | --- |
| `0` | 至少一张图片识别成功 |
| `1` | scope 错误、全部失败、`subagents.enabled=false` |
| `2` | 目录不存在 / 不可读 / 无支持的图片 |

**示例**

```bash
zcode recognize ./screenshots
zcode recognize ./invoices --schema structured --fields invoice_number --fields total
zcode recognize ./catalog --schema qa --questions "What is the SKU?" --questions "What is the unit price?"
zcode recognize ./photos --output-format stream-json --max-concurrency 8 > results.ndjson
```

## 3. State Owners

| 状态 / 事件流 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 文件夹目录扫描 | `recognize-walker.ts` | 纯 IO，一次性产出 `images` + `byExtension`，不持有状态 |
| 批次编排 / 并发调度 | `recognize-command.ts` | worker pool（`next` 计数器 + 按 index 回填），不是分片 `Promise.all` |
| 批次身份合成 | `recognize-signer.ts` | 由 traceId 派生 `parentToolCallId` / `runtimeSessionId` / `agentLabel` / `shortId` |
| 父 runtime 事件订阅 | `recognize-command.ts` 的 `createProgressSink` | 经 `readRuntimeEventSubscriber` 单点订阅；拿不到订阅能力就不订阅（不静默降级） |
| 事件 → 进度行翻译 | `recognize-progress.ts` | 纯函数式翻译 + 250ms 节流；不持有 plan、不碰 IO |
| 子代理模型调用 | `recognize-agent.ts` 的 `image-recognizer` profile | 走既有 `AgentRuntime.runSubagent` → `SubagentPort.run` → 模型 |
| 运行时装配 / 单图派发 | `recognize-runtime.ts` | bootstrap、权限 broker、模型候选集、`modelOverride` 注入 |
| 模型选择 | `recognize-model.ts` | 三级优先，见 §4；无候选时抛 `NO_VISION_MODEL_MESSAGE` |
| 结构化结果校验 | `recognize-schema.ts` | JSON Schema 文本嵌入 + 手写结构校验；失败降级为 failure envelope |
| 输出契约 | `recognize-output.ts` | plan / results / summary 三种格式的统一格式化，无 IO |
| 进程退出码 | `recognize-command.ts` | 唯一出口；不直接调 `process.exit`，返回 exit code 给 `run.ts` |

**两处刻意的非默认装配**（`recognize-runtime.ts`）：

- `subagents.autoBackgroundMs: 0` —— 强制前台。本命令的契约是「跑完再聚合」，中途转后台会让 `Results` 在打印时残缺。
- `permissionBroker: createRecognizePermissionBroker()` —— 只放行 `Read`，其余委托回 `createDenyPermissionBroker()`。子代理按构造是只读的（`tools: ["Read"]`），但 `Read` 本身仍要走权限；不重写拒绝语义，只覆盖这一个工具。

**避免的反模式**：

- 不在 walker 里调模型（保持纯 IO）
- 不在 progress 里持有 plan（plan 由 command 持有，progress 只翻译事件）
- 不让多个 sub-agent 互相通信（每个独立跑，结果由 command 聚合）

## 4. Model Selection

`recognize-model.ts` 四级优先，全部可解释：

1. `--model <providerId>/<modelId>[$reasoningLevel]` —— 直接走 `parseModelPickerValue`；解析失败（缺 `/`、空 id）在 `pickRecognizeModelSelection` 里原样上抛（不吞成兜底选择），由命令层转成 stderr 一行 + exit 1。
2. 能力模型配置 `capabilityModelSelections.image`（`registryRuntime.configuredCapabilityModelSelections.image`，见 [capability-model-selection.md](./capability-model-selection.md)）**且**它支持图像输入。
3. 会话已配置的默认选择（`registryRuntime.configuredDefaultModelSelection`）**且**它支持图像输入。
4. provider registry 快照里第一个 `supportsImage: true` 的模型。

第 2 级是 opt-in：只有用户在 Personal Provider Config 里显式配了能力模型才会改变行为；配置里写错模型 id（不在候选集里、或不支持图像）时不委派，直接落到下一级。

**不硬编码**模型 id：候选集由 `registryService.getSnapshot()` 的解析结果展平而来，能力位取 `model.config.properties?.inputFormat?.supportsImage`（规则文件是 match/overlay 的输入，只有解析结果才是某个具体模型的能力）。内置模型表变化时选择自动跟着变。

四级都挑不出来时抛 `NO_VISION_MODEL_MESSAGE`（`No image-capable model found. Pass --model <providerId>/<modelId> explicitly.`），由 `recognize-command.ts` 就地捕获、写 stderr 并返回 exit 1 —— 与 scope 错误同级，不把裸异常抛给顶层兜底。

子代理 dispatch 时通过 `SubagentRunOptions.modelOverride: { selection, background: "deny" }` 透传；`background: "deny"` 是必填位，保证单次执行的模型不脱离父 loop 生命周期。

## 5. Sub-agent Profile

profile 定义在 `recognize-agent.ts` 里，是 **TS 常量而不是 `agents/*.md`**：

- agent profile 的发现根只有 `<storageRoot>/agents`、`<cwd>/.zcode/agents` 和「已启用插件的 `agents/`」（`bootstrap/src/subagents.ts`），CLI 包自身的 `agents/` 不在其中；
- `scripts/build.mjs` 只 stage `dist/provider/zcode-builtin.json`，没有通用资源拷贝，SEA 单文件里也不存在可读的 md。

写成常量后 profile 与命令同生共死，与打包形态无关。

约束：

- 唯一工具：`Read`（读本地图片路径；与 `pdf-plugin/agents/visual-judge.md` 范式一致）
- `injectAgentsMd: false`：识别只吃 dispatch message 里的图像路径与 schema，注入项目 AGENTS.md 只会稀释指令
- 模型：不写死，由 dispatch 时 `modelOverride` 注入
- `color: cyan`（UI 端 agent 卡片色，headless 不显）
- 无 `thoughtLevel`（识别是单次结构化输出，无需扩展推理）
- 失败时按约定回 `{"status":"error","reason":"unreadable","message":"…"}`，由后置解析透传

## 6. Structured Output

三种 schema 互斥，由 `--schema` 选一。**不引入 zod**：CLI 包无该依赖，且 `contracts`（v3）与 `adapters`（v4）混用，加依赖会踩 build 的 zod-dedupe 门禁。改为在 `recognize-schema.ts` 里定义纯 JSON Schema 对象 → `JSON.stringify` 嵌入 prompt → 手写轻量结构校验做后置解析，达成与「prompt 嵌入 schema + 后置 parse」相同的目标，零新依赖、自包含、可测。

### Description

```ts
{
  status: "success",
  description: string,        // 主描述
  observations?: string[],    // 短观察
  confidence?: number         // 0..1
}
```

### QA

```ts
{
  status: "success",
  answers: Array<{ q: string; a: string }>,
  confidence?: number
}
```

### Structured

```ts
{
  status: "success",
  fields: Record<string, string | number | boolean | null>,
  confidence?: number
}
```

`fields` 的 key 必须与 `--fields` 给出的列表完全一致（多/少都算 schema_mismatch）。

### Failure Envelope

```ts
{
  status: "error",
  reason: "unreadable" | "no_text" | "model_refusal" | "schema_mismatch" | "timeout" | "other",
  message: string
}
```

联合类型：

```ts
type RecognizeResult = DescriptionResult | QaResult | StructuredResult | FailureResult
```

### response_format（follow-up）

v1 不在 `SubagentPort` 透传 `response_format`，靠 prompt 嵌入 schema + 后置解析。模型严格 JSON 输出留 follow-up（见 §10）。

## 7. Concurrency & Ordering

- **扇出策略**：worker pool，不是分片 `Promise.all`。`maxConcurrency` 个 worker 共用一个 `next` 计数器取下一个未开始的 index，结果按下标回填到定长数组。因此**输出顺序恒等于 walker 的确定性顺序**，而并发数严格等于 `clamp(maxConcurrency, 1, totalImages)`（默认 4）。
- **失败隔离**：`recognizeImage` 的契约是「不抛，失败也返回 envelope」；即使它抛了，`runOne` 也把异常翻译成 `reason: "other"` 的 failure envelope。单张失败不中断兄弟。
- **子会话 id 合成**：`sess_recognize_${traceIdShort}_${index}`（`recognize-signer.ts`，经 `createSessionId` 铸成带 brand 的 `SessionId`）；`traceIdShort` = `sha256(traceId)` 前 8 位。
- **parentToolCallId 合成**：`recognize-${traceIdShort}-${index}`（CLI 不来自真实 tool call，合成以满足 `SubagentRunRequest.parentToolCallId` 必填约束）。
- **进度归并键有两个，不能互换**（运行时证据：`core/src/subagent/runner.ts` 的 `createSubagentLifecycle` / `runExploreAgent`）：`SubagentSpawned` / `SubagentStopped` 载荷里带的是合成的 `parentToolCallId`；而子会话流式事件（`ModelStreaming`）的 `event.sessionId` 是 runner **另铸**的 `sess_subagent_<agentId>`——runner 无视 `request.sessionId`，一律用 `lifecycle.childSessionId` 建子 runtime。所以流式归并键只能在收到 `SubagentSpawned`（载荷带 `childSessionId`）时学到，不能预先合成；`stopped` 时出栈，迟到的同 id 事件不再归并。
- **实时正文来源**：`SubagentMessage` 类型已定义但 core 未从该路径 emit（见 §10），所以 `message` 行只认 `ModelStreaming` 的 `kind: "text_delta"`，由 `subagent.ts` 的 `eventSink` 经 `notifyEventSinks(event, { sessionId: childSessionId })` 扇出到父 runtime 的外部 sink。
- **中止传播**：`SubagentRunOptions.signal` 接 `AbortController`；worker 在取到 index 时检查 `signal.aborted`，命中则回填 `aborted before dispatch` 的 failure item。全局 SIGINT 归 `shutdown.ts`，本命令不注册第二个 handler（AGENTS.md 收敛外 I/O 边界）。
- **订阅顺序**：`writePlan` 之后、任何派发之前建立订阅（避免首个 `SubagentSpawned` 漏到 handler 之前），批次结束在 `finally` 里 detach。

## 8. Failure Semantics

| 失败类型 | 表现 | 退出码 |
| --- | --- | --- |
| 目录不存在 / 不可读 | stderr 一行 `Cannot read folder "…"`，stdout 空 | 2 |
| 目录无支持图片（含 glob 过滤后为空） | stderr 一行 `No supported images found in "…"`，stdout 空 | 2 |
| Scope 错误（schema/fields/questions 不匹配、缺 folder） | stderr 一行，stdout 空 | 1 |
| 配置无 vision 模型 / `--model` 串非法 | stderr 一行（`NO_VISION_MODEL_MESSAGE` 或解析错误原文），stdout 空 | 1 |
| `subagents.enabled=false` | 每张图各得一条 `reason: "other"` 的失败（message 为 `Subagents are disabled in this runtime (subagents.enabled=false).`）；因无成功项而 exit 1。见 §10 | 1 |
| 单图 sub-agent 抛错 | 该条 `status: "error"`，reason 走 failure envelope | 不影响兄弟 |
| 子代理返回文本不能 parse 成 schema | 该条 `status: "error"`, `reason: "schema_mismatch"`，原文本丢弃（`--verbose` 时保留 evidence） | 不影响兄弟 |
| 全部图片失败 | 正常打印 Plan + Results + Summary，exit 1 | 1 |
| 部分图片失败 | 正常打印 Plan + Results + Summary，exit 0 | 0 |
| 全部成功 | 正常打印，exit 0 | 0 |

## 9. Output Formats

三种格式共用同一批对象（`recognize-output.ts`），只有信封不同。`results[].image` 是相对 `folder` 的展示路径，绝对路径只在 `absolutePath` 里出现 —— operator 读的是「哪张图」，机器需要的是可再定位的绝对路径，两者不混在同一个字段里。

### Text（默认）

stdout 三段：

```
Plan:
  folder:              ./screenshots
  total_images:        24
  by_extension:        jpg=18  png=6
  model:               bigmodel-individual-coding-plan/GLM-5.3-Flash
  schema:              description
  max_concurrency:     4
  recursive:           false
  estimated_subagents: 24
---

Results (24):
  [1/24] 01.jpg  ok    "A bustling night market with…" (1.2s)
  [2/24] 02.png  FAIL  schema_mismatch: description missing

Summary:
  succeeded: 22   failed: 2   totalDurationMs: 28173
```

`by_extension` 按扩展名排序、`k=v` 双空格分隔；`fields` / `questions` 行只在对应模式出现（`questions` 只给数量，不展开）。`Results` 的序号宽度按总位数补零；成功行带耗时，失败行不带。

stderr 实时进度：

```
[01/24 image-1 a3f] started
[01/24 image-1 a3f] message   "A bustling night market with …"
[01/24 image-1 a3f] stopped   ok 1.2s
[02/24 image-2 b71] stopped   FAIL 0.4s schema_mismatch: description missing
```

`message` 行是**此刻已累积正文**的快照：第一条 `text_delta` 立刻放行，节流窗口内的后续 delta 只累积不输出，窗口过后再放行一次（单行 + 80 字符截断）。`started` / `stopped` 是相位端点，任何节流都不得吃掉。

颜色：`supportsColor(stdout, noColor)` 检测 + `color.bold/cyan/...`（`packages/core/src/output.ts:7`）。

### JSON

stdout 一个对象（`plan` 不单独打印）：

```json
{
  "plan": { /* RecognizePlan */ },
  "results": [ /* RecognizeFinalItem[] */ ],
  "summary": { "total": 24, "succeeded": 22, "failed": 2, "totalDurationMs": 28173 }
}
```

stderr 仍写实时进度（除非 `--output-format stream-json`，见下）。

### Stream-JSON

stdout NDJSON，顺序固定为 `plan` → 任意条 `progress` → `result`：

1. `{"type":"plan","plan":{...}}`
2. `{"type":"progress","subagentId":"image-1","index":0,"shortId":"a3f","stage":"started","at":…}`
3. `{"type":"progress",…,"stage":"message","preview":"…","at":…}`（节流后，含 `at` 供消费者复核节流）
4. `{"type":"progress",…,"stage":"stopped","outcome":"ok|error","durationMs":…,"at":…}`
5. `{"type":"result","results":[…],"summary":{…}}`

消费者按 `subagentId` 归并。**stderr 在此模式下不写进度**（避免双写）。

## 10. Acceptance

`apps/zcode-cli/packages/cli/tests/recognize-command.test.ts`（`node:test` + `node:assert/strict`）：

| 场景 | 断言 |
| --- | --- |
| walker | jpg + 大写 `.PNG` 计入、`.txt` 过滤；`--recursive` 收子目录并正确计数 |
| prompt | 三种模式都把 `jsonSchema` 文本嵌进 dispatch prompt |
| parse | 合法输出接受；非 JSON → `schema_mismatch`；缺字段 → `schema_mismatch`；空文本 → `no_text` |
| progress | 同一毫秒内多条 delta 只放行 1 条 `message`，跨窗口再放行 1 条；`started`/`stopped` 不被节流；preview 为累积快照 |
| `--json` | 单个 `{plan,results,summary}`，stderr 为空 |
| stream-json | 恰好两行 NDJSON，`type` 依次为 `plan` / `result` |
| 退出码 | 缺目录 2、无图片 2、scope 错误 1、无视觉模型 1、部分失败 0、全部失败 1 |
| 并发 | `--max-concurrency 2` 时实测峰值并发为 2；结果顺序与 walker 顺序一致 |
| 过滤 | `--image-glob` 生效、`--recursive` 生效、`--model` 覆盖默认选择 |

集成测试通过 `deps.modelResolution` + `deps.recognizeImage` 两个注入点驱动，不建 app、不连真实模型。

**不测**（防合成断言）：真实模型调用、EXIF、subagent 内部工具路由、跨平台路径边角。

## 11. Open Questions / Follow-ups

1. **`response_format` 严格输出**：`SubagentPort` 暂未透传 `response_format`；严格 JSON 输出靠 prompt 嵌入 + 后置解析。若希望多模型兼容，follow-up 在 `subagent.ts` 的 model override 链上增加 `responseFormat?: JsonSchema` 字段。
2. **EXIF 方向校正**：`inline-media-resolver.ts` 不解析 EXIF Orientation tag，手机/相机竖向拍摄的照片可能被模型误读。follow-up 引入 `exifr` 之类做旋转 + mirror。
3. **远程 URL 自动下载**：`message-attachments.md:332` 第一阶段不做；如要支持 `https://...` 图片 CLI 自动下载，单独 spec。
4. **递归扫大目录 OOM**：默认 `--recursive false`；如未来开启，配 `--max-files` 上限。
5. **`SubagentMessage` 事件**：`core/subagent/runner.ts` 未实际 emit `subagent_message`（类型已定义但未从该路径发出），所以实时 `message` 预览实际来自 `ModelStreaming` 的 `text_delta`。
6. **stderr 字符级交错**：同一毫秒内两个 subagent 各打一行，OS 层可能切片；operator 走文件/scrollback 消费，不是真同屏阅读。
7. **多 sub-agent 真实可观察并发**：24 个 sub-agent 的 stderr 并发是「事件驱动」，不是 OS 线程真并行。消费方按 `subagentId` 归并，不要假定行序即完成序。
8. **`subagents.enabled=false` 的诊断粒度**：目前每张图各得一条失败，而不是命令启动时一句总诊断 —— 需要 `AgentRuntime` 暴露一个「子代理是否可用」的只读能力位，才能在派发前 fail fast。
9. **`Read` 是否真的把图交给视觉模型**：v1 假定可行（visual-judge 范式）。若某 provider 下不成立，需要在 `SubagentRunRequest` 增加 `attachments: TurnAttachment[]` 字段直接注入图像块。
