# 能力模型选择（Capability Model Selection）

Status: L1 已实现。配置面（Personal Provider Config 的 `capabilityModelSelections`）、
解析（`resolveCapabilityModelSelection` / `resolveConfiguredCapabilityModelSelections`）、
bootstrap 注入（`runtimeConfig.capabilityModelSelections`）、主路径图片委派
（`resolveTurnAttachments` 附件解析阶段）与 `zcode recognize` 的四级优先级都已落地。
未做：GUI 配置入口、按能力以外维度路由、PDF/视频/音频能力键。

## 1. Purpose & Scope

CLI 需要支持**额外 LLM 配置**：主 LLM 之外，按**能力**单独指定模型。

典型场景：主 LLM 走另一个 provider（纯文本模型），**图片理解**走 MiMo。二者互不影响：

- 主 LLM 仍由 `defaultModelSelection` 决定（Personal Provider Config）。
- 图片理解由 `capabilityModelSelections.image` 决定。

**适用场景**

- 主模型不支持图片（`inputFormat.supportsImage === false`），但希望附件里的图片仍然进入上下文。
- 主模型支持图片，但成本/延迟更高，希望图片走更便宜或更准的专用视觉模型。

**不适用**（显式排除）

- 不改变主 LLM 的选择规则；主模型仍是 `defaultModelSelection`。
- 不覆盖 PDF / 视频 / 音频的媒体能力判定（当前只有 `image` 一个能力键）。
- 不做「按附件类型自动挑模型」以外的路由（如按 token 预算、按 provider 成本）。
- 不提供 GUI 配置入口；本轮只落 CLI / 运行时可见的配置面。

## 2. Config Surface

配置写在 **Personal Provider Config**（`~/.zcode/v2/provider_config.json`）的 `config` 对象下：

```json
{
  "schemaVersion": 1,
  "config": {
    "providerOrder": ["new-provider", "mimo"],
    "providerConfigRules": { "providerRules": [] },
    "modelConfigRules": {},
    "defaultModelSelection": { "providerId": "new-provider", "modelId": "<main-llm>" },
    "capabilityModelSelections": {
      "image": { "providerId": "mimo", "modelId": "mimo-v2.6-pro" }
    }
  }
}
```

- `capabilityModelSelections` 是**可选**键；缺席等价于「没有能力模型」，行为与本 spec 之前完全一致。
- 值复用 `ModelSelection`（`providerId` / `modelId` / `options.reasoningLevel?`），不引入新的选择形态。
- 能力键当前只有 `image`。键是**开放的字符串**：新增能力不需要改文件 schema；未知键保留在用户文件里但没有消费方，
  不会因为拼错一个键就让整份 Personal Provider Config 读取失败。
- 文件 schema 版本不变（仍是 `schemaVersion: 1`）。旧读档器读到顶层 `capabilityModelSelections` 会因 strict parse 失败
  ——这是「回退到旧版本 CLI」时的显式失败，不是静默降级。

## 3. State Owners

| 事实 | 唯一所有者 | 说明 |
| --- | --- | --- |
| `capabilityModelSelections` 的持久化值 | Personal Provider Config 文件 | 与 `defaultModelSelection` 同一份文件、同一份 revision |
| 能力选择是否可用 | `packages/provider` 的 `resolveCapabilityModelSelection` | 只读校验，不写 |
| 本轮实际生效的能力模型 | `AgentRuntimeConfig.capabilityModelSelections` | bootstrap 从 registry 解析后冻结进 runtime config |
| 图片描述请求 | core runtime（`resolveTurnAttachments` 的附件解析阶段） | 每个附件一次，结果进 message history |

不引入第二条写入路径：能力模型与默认模型共用 Personal Provider Config 的 update 事务。

## 4. Resolution

`resolveCapabilityModelSelection({ capability, configured, registry })`：

1. `configured` 缺席 → `{ issue: "capability-not-configured" }`。
2. `providerId` 不在 registry 快照里 → `{ issue: "provider-not-found" }`。
3. `modelId` 不在该 provider 下 → `{ issue: "model-not-found" }`。
4. 该模型的 `properties.inputFormat` 不支持该能力（`image` → `supportsImage !== true`） → `{ issue: "capability-not-supported" }`。
5. 全部通过 → `{ selection }`。

能力位取**解析后的** `model.config.properties.inputFormat`（与 `recognize-model.ts` 一致）：规则文件是 match/overlay 的输入，只有解析结果才是某个具体模型的真实能力。

解析失败**不抛异常**：调用方按「没有能力模型」处理，走既有降级路径。

解析成功时还要**补齐推理档位**：Model Factory 只接受完整执行选择，缺档位会抛
`Reasoning level is required`，因此补齐必须发生在创建 Model 之前，不能等 Model 建好再 bind。
规则：配置里显式声明的档位且模型支持就保留；缺失或不支持时用该模型的**最低公开档位**
（能力模型承担的是「读一张图」这类旁路调用，最低档够用且更便宜）。

整份配置一次性解析用 `resolveConfiguredCapabilityModelSelections({ configured, registry })`：
逐个已知能力键独立解析，返回 `{ selections, issues }`。`selections` 只含解析成功的键；
`issues` 逐条给出 `{ capability, issue }`。未知能力键保留在配置里但不被消费，也不报错。

## 5. Consumption A：主路径的图片理解

### 5.1 触发条件

同时满足才委派：

1. 本轮生效模型的 `inputFormat.supportsImage !== true`（**显式**为 false；`undefined` 视为未知，不委派）。
2. 本轮附件里存在 image 类型的附件。
3. `capabilityModelSelections.image` 解析成功。

主模型本身支持图片时**完全不触发**：图片照旧以 image block 进入请求，能力模型不被调用，零额外成本。

### 5.2 委派动作

在 `resolveTurnAttachments` 的附件解析阶段（**每回合一次**，不是每次 provider 请求）：

1. 用能力模型句柄发起一次 `generateText`，消息里带该图片的 data URL + 一段固定指令（描述图片内容）。
2. 拿到文本后，把该附件的 content block 从 `image` 换成 `text`：
   - 正文 = 模型返回的描述文本；
   - 追加原图片的可读引用（`[Image: source: <path>]`），让主模型知道有一张图存在。
     引用取图片来源的 `path`；没有路径时退到 `placeholder`（内联图片是 `attachment-N`），再退到 artifact `uri`。
3. 描述文本进入 message history 并被持久化——**后续回合与恢复后看到的都是描述文本**，不会重复调用能力模型。

### 5.3 失败与降级

能力模型调用失败（网络、鉴权、超时、空响应、**建不出 Model**）时：

- 该附件保持 image block；
- 请求投影阶段按既有 `projectMessagesForInputFormat` 替换成 omitted-media 文本（`[Media omitted from provider request because the selected model does not support image.]`）。

即：**能力模型不可用不改变本轮行为**，只是回到本 spec 之前的状态。失败记 `warn` 日志（含 providerId/modelId/错误摘要），不重试到影响用户。

Model 创建也在降级边界内：建不出 Model 不能让整轮失败，只按「描述失败」处理。

### 5.4 时序

```text
turn 开始
  -> 解析生效模型（submissionModel / admittedModel）
  -> resolveTurnAttachments
       -> 图片附件 -> 能力模型描述 -> text block
  -> message history 落库（描述文本）
  -> provider 请求（不再含 image block）
```

描述请求是**独立于主 loop 的旁路调用**：它不占用主模型的重试预算，也不进入主 loop 的流式输出。

## 6. Consumption B：`zcode recognize`

`zcode recognize` 的默认视觉模型优先级更新为四级（`recognize-model.ts`）：

1. `--model <providerId>/<modelId>[$reasoningLevel]`。
2. `capabilityModelSelections.image`（解析成功时）。
3. 会话已配置的默认选择（`configuredDefaultModelSelection`）**且**它支持图像输入。
4. provider registry 快照里第一个 `supportsImage: true` 的模型。

第 2 级是新增的 opt-in 项：只有用户显式配置了能力模型才会改变行为。

第 2 级用的是**Registry 解析后**的选择（含补齐的推理档位）：识别子代理走 `modelOverride`，
和主链路一样要求完整执行选择；配置里写错模型 id、或该模型不支持图像时，这一级直接跳过。

## 7. Observability

- 能力模型解析失败：`warn`，事件 `capability_model_selection.unresolved`，带 capability + issue code。
- 描述成功：`info`，事件 `capability_image_understanding.completed`，带 providerId/modelId/耗时/字符数。
- 描述失败：`warn`，事件 `capability_image_understanding.failed`，带 providerId/modelId/错误摘要。
- 启动期 `runtimeConfig` 日志上下文带 `capabilityModel`（`<providerId>/<modelId>`），
  直接回答「这次生效的图片模型是哪个」。

日志不含图片内容、data URL 或凭据。

## 8. Acceptance

1. 未配置 `capabilityModelSelections` 时，行为与本 spec 之前**逐字节一致**（含 omitted-media 文本）。
2. 主模型不支持图片 + 配置了能力模型 + 附一张图：provider 请求里**没有** image block，含能力模型产出的描述文本与图片路径引用。
3. 主模型不支持图片 + 配置了能力模型 + 能力模型调用失败：provider 请求里没有 image block，含既有 omitted-media 文本；本轮不失败。
4. 主模型**支持**图片：provider 请求里保留 image block，能力模型**不被调用**。
5. `capabilityModelSelections.image` 指向不存在的 provider / model / 不支持图片的模型：解析返回对应 issue，主路径按「未配置」处理，`zcode recognize` 落到下一级优先级。
6. `zcode recognize` 不带 `--model` 且配置了能力模型：子代理跑在能力模型上。
7. 能力模型选择没写 `options.reasoningLevel`：解析时补齐为模型最低公开档位，**不**抛
   `Reasoning level is required`；主路径与 `zcode recognize` 都能正常执行。

## 9. 验证记录

真实链路（Personal Provider Config：主模型 `minimax/MiniMax-M2.7`（`supportsImage: false`），
能力模型 `mimo/mimo-v2.6-pro`（`supportsImage: true`））：

- `zcode -p "这张图片里有什么？" --attach <三条横色带的合成 PNG>` → 答出「红/绿/蓝三条横色带，无文字」，
  证明能力模型先读图、主模型据此作答。
- `zcode recognize <目录> --json` → `plan.model = mimo/mimo-v2.6-pro`，识别跑在能力模型上。
