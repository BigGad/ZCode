# zcode-cli 多模型配置指南（命名模型类型 / `--model-type`）

> 面向：在自己的机器上配置多套大模型，并让 zcode-cli 按名字选用其中一套。
> 配套 spec：`apps/zcode-cli/docs/design/v2/model-selections.md`（实现细节与验收口径）。

## 1. 这是什么

zcode-cli 的主模型选择从「只有一个 `defaultModelSelection`」扩成了「一张命名表」：

- 配置里可以写**多套**模型，各自起一个名字（`main` / `fast` / `vision` / 任意名字）；
- 调用时用 `--model-type <名字>` 点名本次跑哪一套；
- 不点名就用 `defaultModelSelection`（老行为不变）；
- 表里叫 `image` 的那一项还有额外含义：主模型**不支持图片**时，自动由它代为读图
  （详见 §6）。

## 2. 怎么配（CLI 生成 / 手写）

### 第 0 步（可选）：让 CLI 帮你生成

已经配好 provider、只是想要「几套能点名的模型」时，让 CLI 生成：

```bash
zcode providers init --dry-run   # 先看会写什么
zcode providers init             # 写入 ~/.zcode/v2/provider_config.json
```

生成规则：

| 类型名 | 指向 |
| --- | --- |
| `main` | 当前 `defaultModelSelection`；没有默认就用第一个可选模型 |
| `image` | 当前默认选择支持图像时就是它；否则取第一个支持图像输入的模型 |
| `<providerId>` | 该 provider 的第一个可选模型 —— 多套模型地址各自有个能点名的类型 |

**写回是合并语义**：已有的同名类型不动，已有的 provider 规则与凭据也一律不动；
只有缺失的类型被补上。命令**幂等**，再跑一次不会改任何东西。

生成的类型立刻可用（指向的都是 registry 里真实可选的模型，档位已补齐）：

```bash
zcode -p "跑一下" --model-type main
```

### 第 1 步：写配置

文件位置：**`~/.zcode/v2/provider_config.json`**（每台机器各一份，不在仓库里）。

最小改动（机器上已经配好 provider、只缺具名选择）：

```json
{
  "schemaVersion": 1,
  "config": {
    "defaultModelSelection": {
      "providerId": "mimo",
      "modelId": "mimo-v2.6-pro",
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
      "image-cheap": {
        "providerId": "mimo",
        "modelId": "mimo-v2.6-pro",
        "options": { "reasoningLevel": "enabled" }
      },
      "image-best": {
        "providerId": "another-provider",
        "modelId": "another-vision-model",
        "options": { "reasoningLevel": "enabled" }
      }
    }
  }
}
```

新机器（provider 也要自己定义）——完整模板：

```json
{
  "schemaVersion": 1,
  "config": {
    "providerOrder": ["my-provider"],
    "providerConfigRules": {
      "providerRules": [
        {
          "providerId": "my-provider",
          "providerName": "我的供应商",
          "config": {
            "group": "standard-personal",
            "access": { "type": "api-key", "apiKey": "<你的 key>" },
            "api": {
              "type": "anthropic-messages",
              "baseUrl": "https://api.example.com/anthropic"
            },
            "personalModelIds": ["my-model"],
            "modelOrder": ["my-model"]
          }
        }
      ]
    },
    "modelConfigRules": {
      "providerModelRules": [
        {
          "providerId": "my-provider",
          "modelId": "my-model",
          "config": {
            "enabled": true,
            "properties": {
              "contextWindow": 200000,
              "inputFormat": {
                "supportsText": true,
                "supportsImage": false,
                "supportsVideo": false,
                "supportsPdf": false
              }
            },
            "optionSpecs": {
              "reasoningLevel": { "values": ["disabled", "enabled"] },
              "maxOutputTokens": { "max": 131072 }
            }
          }
        }
      ],
      "manualProviderModelRules": []
    },
    "defaultModelSelection": {
      "providerId": "my-provider",
      "modelId": "my-model",
      "options": { "reasoningLevel": "enabled" }
    },
    "modelSelections": {
      "main": {
        "providerId": "my-provider",
        "modelId": "my-model",
        "options": { "reasoningLevel": "enabled" }
      }
    }
  }
}
```

字段说明：

| 字段 | 作用 |
| --- | --- |
| `defaultModelSelection` | 不点名时的默认主模型。**语义没变** |
| `modelSelections` | 类型名 → 模型选择。键是**开放的字符串**，随便起名 |
| `providerConfigRules.providerRules` | provider 定义：接入方式、key、baseUrl、有哪些模型 |
| `modelConfigRules.providerModelRules` | 模型的能力与档位定义（上下文长度、支不支持图片、推理档位） |

`api.type` 只能取 `anthropic-messages` / `openai-chat-completions` / `openai-responses`。

### 第 2 步：验证

```bash
zcode -p "只回复两个字：正常" --model-type main --no-color
```

正常就打印模型的回答。**注意**：先确认不带 `--model-type` 也能跑（那说明 provider 本身配好了），
再逐个类型试；某个类型失败通常是那个 provider 的问题，不是具名机制的问题。

### 第 3 步：日常使用

```bash
zcode -p "跑一下" --model-type fast     # 无头单次
zcode --model-type fast                 # TUI 启动时的初始模型
zcode recognize ./imgs --model-type vision   # 批量识图的视觉模型
```

TUI 里随时切：

```
/model-type list      # 列出所有具名类型
/model-type fast      # 切到 fast
/model list           # 按 provider/model 选（目录里的任意模型）
```

### 第 4 步（可选）：同一张图，这次用便宜的、下次用更好的

主模型固定不变，只换**图片理解**用哪个模型：

```bash
# 主模型 minimax（纯文本），图交给便宜的那个
zcode -p "这张图里有什么？" --model-type main --capability image=image-cheap

# 同一张图，下次换成效率更好的
zcode -p "这张图里有什么？" --model-type main --capability image=image-best
```

`--capability <能力键>=<类型名>` 是**启动期**旋钮（能力选择随 runtime config 冻结），
TUI 会话中途换不了，重开 CLI 即可。

## 3. 四个入口的优先级

| 入口 | 优先级 |
| --- | --- |
| `zcode -p` | `--model-type` > `defaultModelSelection`；`--capability` 覆盖能力键的默认绑定 |
| `zcode`（TUI 启动） | 同上 |
| TUI 会话内 `/model-type` | 用户显式指令，最高；切换后会保存为默认选择 |
| `zcode recognize` | `--model` > `--model-type` > `image` 能力键（可被 `--capability` 覆盖） > 默认选择 > registry 里第一个支持图像的模型 |

`--model` 和 `--model-type` 取值格式不同、不冲突：`--model` 是 `providerId/modelId[$reasoningLevel]`，
`--model-type` 是配置里的类型名。

## 3.1 多个模型地址（多个 provider）

一个 provider 一个地址；要多个地址就写多条 provider 规则，各自带 baseUrl + key + 模型列表：

```json
"providerConfigRules": {
  "providerRules": [
    {
      "providerId": "cheap",
      "config": {
        "group": "standard-personal",
        "access": { "type": "api-key", "apiKey": "..." },
        "api": { "type": "anthropic-messages", "baseUrl": "https://a.example" },
        "personalModelIds": ["m1"],
        "modelOrder": ["m1"]
      }
    },
    {
      "providerId": "pro",
      "config": {
        "group": "standard-personal",
        "access": { "type": "api-key", "apiKey": "..." },
        "api": { "type": "anthropic-messages", "baseUrl": "https://b.example" },
        "personalModelIds": ["m2"],
        "modelOrder": ["m2"]
      }
    }
  ]
},
"modelSelections": {
  "cheap": { "providerId": "cheap", "modelId": "m1", "options": { "reasoningLevel": "enabled" } },
  "pro":   { "providerId": "pro",   "modelId": "m2", "options": { "reasoningLevel": "enabled" } }
}
```

之后 `--model-type cheap` / `--model-type pro` 就能在两个地址之间切换。

## 4. 必填项与常见坑

这几条是实际踩过的，写配置前先对一遍：

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `Unsupported model xxx` | 选择**缺 `options.reasoningLevel`**。Registry 判为不可选后会静默回退到列表第一个模型，于是请求打到了别的模型上 | `defaultModelSelection` 和 `modelSelections` 的**每一项**都要带 `options.reasoningLevel`；档位值必须在该模型的 `optionSpecs.reasoningLevel.values` 里 |
| 类型名配了但选不了 | 模型 id 不在 provider 的 `personalModelIds` / `modelOrder` 里 | 把模型 id 加进 `personalModelIds`（自有模型）或 `modelOrder`（排序） |
| provider 存在但一个模型都没有 | 只写了 `providerId`、没给 `templateId` 也没给 `personalModelIds` | 给 `templateId`（继承内建模型的完整能力定义）或显式给 `personalModelIds` + 对应的 `modelConfigRules.providerModelRules` |
| 模型在列表里但请求报「不支持该档位」 | `optionSpecs.reasoningLevel.values` 与实际档位对不上 | 对齐 `values` 与实际档位 |
| 类型名写错 | — | 报错会列出所有已配置的类型名 |

**要点**：`defaultModelSelection` 与 `modelSelections` 每一项都要带 `options.reasoningLevel`，
且档位值必须在该模型 `optionSpecs.reasoningLevel.values` 内。缺了不会立刻报「配置错」，
而是静默换成别的模型 —— 这是最容易踩的一个坑。

## 5. 报错怎么读

| 报错 | 含义 |
| --- | --- |
| `Unknown model type: xxx. Available types: a, b, c` | 类型名不存在。列出的就是配置里实际存在的类型名。退出码 1（TUI 启动时直接退出，不开 TUI） |
| `Unknown model type: xxx. Available types: (none)` | 一个类型都没配 |
| `Provider Registry 中不存在 Provider: xxx` | 类型指向的 provider 在 Registry 里不存在（多半是没在 `providerConfigRules` 里定义） |
| `Reasoning level is required for xxx/yyy` | 见 §4 的第一行 |
| `Unsupported model xxx` | provider 明确拒绝这个模型 id（模型名写错、或该账号套餐不含这个模型） |
| `Unknown capability: pdf. Available capabilities: image` | `--capability` 的能力键当前只支持 `image` |
| `Capability model type "xxx" is not usable for image: model-type-not-configured` | `--capability` 指的类型不存在 |
| `Capability model type "xxx" is not usable for image: capability-not-supported` | `--capability` 指的类型不支持图像能力（换个支持图像的模型） |
| `Invalid --capability value: …` | 语法应为 `<能力键>=<类型名>` |
| `Duplicate --capability for image.` | 同一个能力给了两次 |

TUI 会话内 `/model-type` 写错时**不退出**，只在界面上给一行同样的提示。

## 6. `image` 类型：主模型不支持图片时的自动接管

`modelSelections` 里叫 `image` 的那一项有特殊含义：

- 主模型 `supportsImage` 是 `false`（**显式** false）→ 附件里的图片先由 `image` 类型读成文字，
  再把描述交给主模型作答；
- 主模型自己支持图片 → `image` 类型**完全不被调用**，零额外成本；
- `image` 类型调不通（网络/鉴权/超时/建不出模型）→ 保留原图，走既有的「媒体不支持」降级，本轮不失败。

所以「主 LLM 用 A、图片理解用 B」的配置就是：

```json
"modelSelections": {
  "main":  { "providerId": "A", "modelId": "…", "options": { "reasoningLevel": "enabled" } },
  "image": { "providerId": "B", "modelId": "…", "options": { "reasoningLevel": "enabled" } }
}
```

`image` 是**默认**绑定；`--capability image=image-cheap` 可以在本次运行里改指到别的类型，
于是「主 LLM 固定 A、图片模型这次便宜下次贵」也能表达（见 §2 第 4 步）。

**注意**：主模型不支持图片时，图片**不会**发给主模型（请求投影会把它换成
`[Media omitted from provider request because the selected model does not support image input.]`）。
但主模型若本身带工具，仍可能自己 `Read` 那个文件路径、用脚本解码图片 —— 那是模型自己的选择，
CLI 拦不住；能力模型代读的价值在于给模型一段**现成的描述**，而不是替它读文件。

## 7. 恢复会话时的模型归属

`--model-type` 决定**本次运行的初始模型**。用 `--resume <sessionId>` 或 `-c` 恢复会话时，
**会话已存的有效模型优先**——这是 zcode-cli 既有的恢复契约，`--model-type` 不改它。

要在恢复的会话里换模型：TUI 里用 `/model` 或 `/model-type`；无头下先恢复、再发 prompt 即可
（`/model` 是交互式命令，无头没有替代品）。

## 8. 给要改代码的人

| 位置 | 职责 |
| --- | --- |
| `packages/shared/src/model-selection.ts` | `modelSelectionsSchema` / `ModelSelections` / `readModelSelection` |
| `packages/provider/src/model-selection-types.ts` | `resolveModelTypeSelection`（按名字解析）/ `resolveCapabilityModelSelection`（解析类型并校验能力位）/ `resolveCapabilityModelSelections`（批量解析能力键）；三者都补齐推理档位 |
| `packages/provider-node/src/provider-config-file-codec.ts` | `modelSelections` 的文件读写（strict schema，未知类型名保留不报错） |
| `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts` | 把能力键解析结果冻结进 `runtimeConfig.capabilityModelSelections`；能力覆盖优先于默认绑定；解析失败记 `capability_model_selection.unresolved` |
| `apps/zcode-cli/packages/core/src/runtime/methods/capability-image-understanding.ts` | 图片描述端口（旁路调用，失败降级） |
| `apps/zcode-cli/packages/core/src/runtime/helpers/capability-image-description.ts` | 附件解析阶段把 image block 换成描述文本 |
| `apps/zcode-cli/packages/cli/src/model-type.ts` | CLI 侧的具名类型解析与提示文案 |
| `apps/zcode-cli/packages/cli/src/capability-override.ts` | `--capability` 的语法解析与覆盖项解析 |
| `apps/zcode-cli/packages/cli/src/providers-command.ts` | `zcode providers init`（生成/合并具名类型） |
| `apps/zcode-cli/packages/cli/src/command-center/handlers/model-type.ts` | `/model-type` 命令 |

设计口径（为什么是一张表、为什么补档位、为什么恢复时不覆盖）见
`apps/zcode-cli/docs/design/v2/model-selections.md`。

## 9. 改完要跑的校验

```bash
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
```

受影响包的测试：`packages/provider`、`packages/provider-node`、`apps/zcode-cli/packages/{core,bootstrap,cli}`。
