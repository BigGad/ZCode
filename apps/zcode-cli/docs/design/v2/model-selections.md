# 命名模型选择与模型类型（Model Selections / Model Types）

Status: L1 已实现。配置面（Personal Provider Config 的 `modelSelections`）、解析
（`resolveModelTypeSelection` / `resolveCapabilityModelSelections`）、bootstrap 注入
（`runtimeConfig.capabilityModelSelections`）、能力委派（主模型不支持图片时由 `image`
类型代为理解）、CLI `--model-type`（无头 / TUI 启动 / `zcode recognize`）与 TUI 会话内
`/model-type` 都已落地。未做：GUI 配置入口、按能力以外维度路由、PDF/视频/音频能力键。

## 1. Purpose & Scope

用户要**额外配置多套大模型**，并在 CLI 调用时按**模型类型名**点名。

配置面是**一张表**：`modelSelections`（类型名 → `ModelSelection`）。两类消费方共用它：

- **人点名**：`--model-type fast` / `/model-type fast` → 用 `modelSelections.fast`。
- **运行时自动取**（能力委派）：主模型不支持图片时，取 `modelSelections.image`。

不点名时用 `defaultModelSelection`（既有字段，保持不变）。

**适用场景**

- 一个 provider 之外再配几套（快/慢/便宜/贵/某领域专用），调用时按场景点名。
- 主 LLM 走另一个 provider（纯文本模型），图片理解走另一个 provider。

**不适用**（显式排除）

- 不改变 `defaultModelSelection` 的语义：它仍是「不点名时的默认」。
- 不覆盖 PDF / 视频 / 音频的媒体能力判定（当前只有 `image` 一个能力键）。
- 不做「按附件类型自动挑模型」以外的路由（按 token 预算、按 provider 成本等）。
- 不提供 GUI 配置入口。

## 2. Config Surface

配置写在 **Personal Provider Config**（`~/.zcode/v2/provider_config.json`）的 `config` 对象下：

```json
{
  "schemaVersion": 1,
  "config": {
    "providerOrder": ["minimax", "mimo"],
    "providerConfigRules": { "providerRules": [] },
    "modelConfigRules": {},
    "defaultModelSelection": {
      "providerId": "minimax",
      "modelId": "MiniMax-M2.7",
      "options": { "reasoningLevel": "enabled" }
    },
    "modelSelections": {
      "main": {
        "providerId": "minimax",
        "modelId": "MiniMax-M2.7",
        "options": { "reasoningLevel": "enabled" }
      },
      "fast": {
        "providerId": "mimo",
        "modelId": "mimo-v2.6-pro",
        "options": { "reasoningLevel": "enabled" }
      },
      "image": {
        "providerId": "mimo",
        "modelId": "mimo-v2.6-pro",
        "options": { "reasoningLevel": "enabled" }
      }
    }
  }
}
```

- `modelSelections` 是**可选**键；缺席等价于「没有命名类型」，行为与本 spec 之前完全一致。
- 值复用 `ModelSelection`（`providerId` / `modelId` / `options.reasoningLevel?`），不引入新的选择形态。
- 类型名是**开放的字符串**：新增类型不需要改文件 schema；未知类型名保留在用户文件里但没有消费方，
  不会因为拼错一个键就让整份 Personal Provider Config 读取失败。
- `defaultModelSelection` **必须**带 `options.reasoningLevel`，否则 Registry 判为不可选，
  会静默回退到列表第一个模型（实测表现为 `Unsupported model <modelId>`）。这一约束对
  `modelSelections` 的每一项同样成立 —— 解析阶段会补齐档位，见 §4。
- 文件 schema 版本不变（仍是 `schemaVersion: 1`）。旧读档器读到顶层 `modelSelections`
  会因 strict parse 失败 —— 这是「回退到旧版本 CLI」时的显式失败，不是静默降级。

## 3. State Owners

| 事实 | 唯一所有者 | 说明 |
| --- | --- | --- |
| `modelSelections` 的持久化值 | Personal Provider Config 文件 | 与 `defaultModelSelection` 同一份文件、同一份 revision |
| 某个类型名是否可用 | `packages/provider` 的 `resolveModelTypeSelection` | 只读校验，不写 |
| 某个能力是否有可用模型 | `packages/provider` 的 `resolveCapabilityModelSelections` | 同上，逐能力独立 |
| 本轮实际生效的能力模型 | `AgentRuntimeConfig.capabilityModelSelections` | bootstrap 从 registry 解析后冻结进 runtime config |
| 图片描述请求 | core runtime（`resolveTurnAttachments` 的附件解析阶段） | 每个附件一次，结果进 message history |

不引入第二条写入路径：命名类型与默认模型共用 Personal Provider Config 的 update 事务。

## 4. Resolution

### 4.1 单个类型名

`resolveModelTypeSelection({ name, configured, registry })`：

1. `name` 不在 `configured` 里 → `{ issue: "model-type-not-configured" }`。
2. `providerId` 不在 registry 快照里 → `{ issue: "provider-not-found" }`。
3. `modelId` 不在该 provider 下 → `{ issue: "model-not-found" }`。
4. 全部通过 → `{ selection }`。

### 4.2 能力键

`resolveCapabilityModelSelections({ configured, registry })`：对**已知能力键**
（当前只有 `image`）逐个独立解析，额外要求该模型的 `properties.inputFormat`
支持该能力，否则 `{ issue: "capability-not-supported" }`。返回 `{ selections, issues }`：
`selections` 只含解析成功的键；`issues` 逐条给出 `{ capability, issue }`。

能力位取**解析后的** `model.config.properties.inputFormat`（与 `recognize-model.ts` 一致）：
规则文件是 match/overlay 的输入，只有解析结果才是某个具体模型的真实能力。

### 4.3 推理档位补齐

解析成功时还要**补齐推理档位**：Model Factory 只接受完整执行选择，缺档位会抛
`Reasoning level is required`，因此补齐必须发生在创建 Model 之前，不能等 Model 建好再 bind。
规则：配置里显式声明的档位且模型支持就保留；缺失或不支持时用该模型的**最低公开档位**
（能力委派承担的是「读一张图」这类旁路调用，最低档够用且更便宜）。

解析失败**不抛异常**：调用方按「没有该类型」处理，走既有降级路径。

## 5. Consumption A：能力委派（主路径的图片理解）

### 5.1 触发条件

同时满足才委派：

1. 本轮生效模型的 `inputFormat.supportsImage !== true`（**显式**为 false；`undefined` 视为未知，不委派）。
2. 本轮附件里存在 image 类型的附件。
3. `modelSelections.image` 解析成功。

主模型本身支持图片时**完全不触发**：图片照旧以 image block 进入请求，能力模型不被调用，零额外成本。

### 5.2 委派动作

在 `resolveTurnAttachments` 的附件解析阶段（**每回合一次**，不是每次 provider 请求）：

1. 用 `modelSelections.image` 的选择发起一次 `generateText`，消息里带该图片的 data URL
   + 一段固定指令（描述图片内容）。
2. 拿到文本后，把该附件的 content block 从 `image` 换成 `text`：
   - 正文 = 模型返回的描述文本；
   - 追加原图片的可读引用（`[Image: source: <path>]`），让主模型知道有一张图存在。
     引用取图片来源的 `path`；没有路径时退到 `placeholder`（内联图片是 `attachment-N`），再退到 artifact `uri`。
3. 描述文本进入 message history 并被持久化 —— **后续回合与恢复后看到的都是描述文本**，不会重复调用能力模型。

### 5.3 失败与降级

能力模型调用失败（网络、鉴权、超时、空响应、**建不出 Model**）时：

- 该附件保持 image block；
- 请求投影阶段按既有 `projectMessagesForInputFormat` 替换成 omitted-media 文本
  （`[Media omitted from provider request because the selected model does not support image.]`）。

即：**能力模型不可用不改变本轮行为**，只是回到本 spec 之前的状态。失败记 `warn` 日志
（含 providerId/modelId/错误摘要），不重试到影响用户。

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

## 6. Consumption B：`--model-type`

### 6.1 旗标

`--model-type <名字>` 是**全局**旗标（严格解析器要求全局注册；作用域校验在各入口）。
它与 `zcode recognize` 自己的 `--model <providerId>/<modelId>[$reasoningLevel]` 完全不冲突，
两者取值格式不同、职责不同。

### 6.2 生效范围与优先级

| 入口 | 行为 | 优先级 |
| --- | --- | --- |
| `zcode -p "…" --model-type fast` | 本次无头运行的主模型 = `modelSelections.fast` | 高于 `defaultModelSelection` |
| `zcode --model-type fast`（TUI 启动） | TUI 打开时的初始模型 = `modelSelections.fast` | 同上 |
| TUI 会话内 `/model-type fast` | 立刻切到该类型（等价于 `/model` 选中的那次切换） | 用户显式指令，最高 |
| `zcode recognize ./imgs --model-type vision` | 识别子代理跑在 `modelSelections.vision` | **低于** recognize 自己的 `--model` |

`zcode recognize` 的完整优先级：`--model` > `--model-type` > `capabilityModelSelections` 里的
`image` 类型 > 会话默认（须支持图像） > registry 快照里第一个 `supportsImage: true` 的模型。

### 6.3 恢复会话时的归属

`--model-type` 决定**本次运行的初始模型**。恢复会话（`--resume` / `-c`）时，
会话已存的有效模型选择仍然优先 —— 这是既有恢复契约，不因本 spec 改变。
要在恢复的会话里换模型，用 TUI 的 `/model` 或 `/model-type`。

### 6.4 找不到类型时的行为

无头入口（`-p` / `recognize`）：

```
Unknown model type: <名字>. Available types: fast, image, main
```

写 stderr 一行，退出码 1 —— 与 scope 错误同级，不把裸异常抛给顶层兜底。
列表来自用户配置里**实际存在**的类型名，按字典序排列；没有类型时写 `Available types: (none)`。

TUI 启动时同理：报错并退出 1，不打开 TUI。
TUI 会话内 `/model-type` 未知类型时，在 TUI 里回一行同样的提示，**不**退出。

## 7. Observability

- 能力模型解析失败：`warn`，事件 `capability_model_selection.unresolved`，带 capability + issue code。
- 描述成功：`info`，事件 `capability_image_understanding.completed`，带 providerId/modelId/耗时/字符数。
- 描述失败：`warn`，事件 `capability_image_understanding.failed`，带 providerId/modelId/错误摘要。
- 启动期 `runtimeConfig` 日志上下文带 `capabilityModel`（`<providerId>/<modelId>`），
  直接回答「这次生效的图片模型是哪个」。
- `--model-type` 解析出来的模型随 `runtimeConfig` 日志上下文里的 `model` 出现。

日志不含图片内容、data URL 或凭据。

## 8. Acceptance

1. 未配置 `modelSelections` 时，行为与本 spec 之前**逐字节一致**（含 omitted-media 文本）。
2. 主模型不支持图片 + 配置了 `image` 类型 + 附一张图：provider 请求里**没有** image block，
   含能力模型产出的描述文本与图片路径引用。
3. 主模型不支持图片 + 配置了 `image` 类型 + 能力模型调用失败：provider 请求里没有 image block，
   含既有 omitted-media 文本；本轮不失败。
4. 主模型**支持**图片：provider 请求里保留 image block，能力模型**不被调用**。
5. `modelSelections.image` 指向不存在的 provider / model / 不支持图片的模型：解析返回对应 issue，
   主路径按「未配置」处理，`zcode recognize` 落到下一级优先级。
6. `zcode recognize` 不带 `--model` 但带 `--model-type vision`：子代理跑在该类型上。
7. `--model-type` 指向的类型没写 `options.reasoningLevel`：解析时补齐为模型最低公开档位，
   **不**抛 `Reasoning level is required`。
8. `--model-type` 指向不存在的类型：无头入口 stderr 一行 + exit 1，提示里列出可用类型。
9. TUI 内 `/model-type fast` 与 `/model <provider>/<model>` 一样会保存为会话的默认选择。

## 9. 验证记录

真实链路（Personal Provider Config：主模型 `minimax/MiniMax-M2.7`（`supportsImage: false`），
`image` 类型 `mimo/mimo-v2.6-pro`（`supportsImage: true`））：

- `zcode -p "这张图片里有什么？" --attach <三条横色带的合成 PNG>` → 答出「红/绿/蓝三条横色带，无文字」，
  证明能力模型先读图、主模型据此作答。
- `zcode recognize <目录> --json` → `plan.model = mimo/mimo-v2.6-pro`，识别跑在能力模型上。
