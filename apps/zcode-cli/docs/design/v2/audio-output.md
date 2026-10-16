# Audio Output (Speech Synthesis)

## 背景

ZCode 当前 attachment pipeline 仅覆盖**消费端**（audio / video 输入）。`audio-input.md` 已定义 audio 附件进入模型的通路。

本文定义 audio 的**生产端**：当模型输出文本或用户主动合成语音，把 audio 字节写入 artifact store，作为 workspace resource index entry 的 variant，并提供 inline 播放。

`AI SDK` 已暴露 `experimental_generateSpeech` 等 API（参见 `packages/adapters/node_modules/ai/dist/index.d.ts:5689`），本文将其适配为 ZCode 的契约端口。

## 当前实现状态

Status as of 2026-10-15: 本文为新建 spec，处于"设计完成、待落地"状态。相关分 spec：

- [`multimodal-platform.md`](./multimodal-platform.md)：总体架构。
- [`audio-input.md`](./audio-input.md)：audio 输入端。
- [`workspace-resource-index.md`](./workspace-resource-index.md)：generated_output variant 持久化。

## 目标

1. **speech synthesis 走端口契约**：模型输出 / 用户显式调用都通过 `AudioOutputPort.synthesize`。
2. **Workspace Resource Index variant**：synthesized audio 作为 `sourceOrigin: "generated_output"` 的 entry 持久化。
3. **inline 播放**：≤ 64 KiB 音频走 inline `<audio>`；> 64 KiB 走 path reference。
4. **复用现有 audio 输入**：synthesized audio 可以再次被用户引用作为下一轮 attachment。

## 端口契约

```typescript
// contracts/src/interfaces/audio-output.port.ts
export interface AudioOutputRequest {
  text: string;
  voice?: string;             // provider-specific（alloy / shimmer / echo）
  format: "mp3" | "wav" | "ogg" | "opus";
  speed?: number;             // 0.5-2.0
  trace: TraceContext;
}

export type AudioOutputErrorCode =
  | "audio_output_synthesize_failed"
  | "audio_output_provider_unavailable"
  | "audio_output_voice_unavailable"
  | "audio_output_quota_exceeded"
  | "cancelled" | "io_error" | "permission_denied"
  | "process_failed" | "timeout" | "unavailable";

export class AudioOutputPortError extends Error {
  constructor(
    readonly code: AudioOutputErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AudioOutputPortError";
  }
}

export interface AudioOutputPort {
  synthesize(
    req: AudioOutputRequest,
    options?: { signal?: AbortSignal },
  ): Promise<{
    data: Uint8Array;
    mime: string;
    durationMs: number;
  }>;
}
```

## AudioOutputSkill

### 文件位置

`apps/zcode-cli/packages/audio-bidirectional-plugin/skills/audio-output/SKILL.md` + 同目录下的 `agent.md`（可选 agent）。

### Skill 形态

```yaml
---
name: audio-output
description: |
  生成语音 / 合成音频。把文本转成可播放音频，保存到当前 workspace 资源库。
  Use when: 用户要求 "念出来" / "用语音回答" / "导出语音" 时。
  Do not use when: 用户只是要文本回复。
---
```

### Skill 指令

skill 文档说明：

1. 通过 `await askOpenAiSpeech({ text, voice, format })` 调用 audio output。
2. skill 不直接调端口；端口是 AgentRuntime 注入后通过 `Tool` 暴露（参照 `TuiReadClipboardImage` precedent）。
3. `Tool` 名：`AudioOutput`（不在当前 tool pool；新加）。

### 实际 tool 形态

新增一个 `AudioOutput` tool：

```typescript
// core/src/tool/types.ts (ToolEntry 注册)
export const audioOutputToolEntry: ToolEntry<AudioOutputInput, AudioOutputOutput> = {
  metadata: {
    name: "AudioOutput",
    description: "Synthesize speech from text. Saves result to workspace; sync tool returns it for inline playback.",
    modelInstructions: `
        当用户明确要求"念出来" / "用语音回答" / "导出语音" 时，调用本工具。
        参数：
          text:   string，必填
          voice:  string，可选（alloy | shimmer | echo | nova | onyx | fable）
          format: "mp3" | "wav" | "ogg" | "opus"，默认 "mp3"
        不要在用户未要求时主动调用。
      `,
    capability: "audio_output",
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    requiresUserInteraction: false,
    sideEffectScope: "workspace",           // 生成 entry.resources/index 内容
    riskLevel: "low",
    needsApproval: false,
    permission: "audio_output",
    resultBudget: { maxBytes: 5 * 1024 * 1024 },   // 不超过 5 MiB
    timeout: { defaultMs: 30_000, maxMs: 60_000 },
    cancellation: { cancellable: true },
    trace: true,
    handler: audioOutputHandler,
  },
  inputSchema: AudioOutputInputSchema,
  outputSchema: AudioOutputOutputSchema,
  runtimeInputSchema: AudioOutputRuntimeInputSchema,
  runtimeOutputSchema: AudioOutputRuntimeOutputSchema,
  formatModelContent: formatAudioOutputModelContent,
};
```

详细 tool spec 见 `docs/design/v2/tool/audio-output.md`（按 `00-tool-change-chain.md` 第 1-7 步走）。

### handler 行为

```typescript
// core/src/tool/handlers/audio-output.ts
export const audioOutputHandler: ToolHandler = async (input, context) => {
  // 1. validate input
  // 2. policyResolver.resolveAudioOutputPolicy(entry) → { voice, format }
  // 3. audioOutputPort.synthesize({ text, voice, format, trace })
  // 4. 计算 sha256 / bytes
  // 5. artifactStore.writeToolArtifactBinary({ mime, bytes, sha256 })
  // 6. workspaceResourceIndex.upsert({
  //      kind: "audio",
  //      sourceOrigin: "generated_output",
  //      variants: [{ kind: "original", mime, bytes, sha256, artifactUri }],
  //      meta: { durationMs, policyTag, ... },
  //    })
  // 7. 返回 { dataUrl (≤ 64 KiB inline) OR path (>64 KiB reference), resourceId, mime, durationMs }
};
```

## Workspace Resource Index 集成

### Entry 形态

synthesized audio 创建一条新的 entry：

```typescript
{
  id: ulid(),
  workspaceIdentity,
  workspacePath,
  kind: "audio",
  title: "Voice response",                  // 用户可见
  sourceOrigin: "generated_output",
  addedAt: now,
  updatedAt: now,
  variants: [
    {
      kind: "original",
      mime: "audio/mpeg",
      bytes: 12345,
      sha256: "...",
      artifactUri: "zcode-artifact://...",
    },
  ],
  references: 1,                            // 当前 session 引用
  meta: {
    durationMs: 4321,
    policyTag: "voice-default",
    policySource: "auto-detected",
  },
}
```

### 跨 session 复用

下次新 session 用户可以直接引用 `resource://<workspaceIdentity>/<id>`，走 audio-input 的同一管线（与 upload 进来的 audio 完全相同）。

## Provider 投影

synthesized audio 不进入模型（除非用户明确要求 "把这段话念出来再念出来"）。tool result 仅作为 tool result content，不当作 user message。

## UI 展示

### inline 播放

tool result 中若 `bytes ≤ 64 KiB`，UI 字段加上 `inline_player: dataUrl`；UI 用 `<audio controls playsInline>` 展示。

> inline `<audio>` 与 message-attachments.md 中 video 的 inline player 同 precedent。

### path reference

tool result 中若 `bytes > 64 KiB`，UI 不直接 inline；走 path reference 协议（同 image / video 大文件），用户点击下载。

### GeneratedOutput 卡片

tool row 显示 "Voice response: <title>" 卡片，含：

- 音频文件 widget
- "来源: synthesized" 标识
- 时长显示
- "保存到资源库"标识
- "在引用中以这条 audio 重新提问" 入口（触发新 turn）

## 入口适配

### CLI

```
zcode attach ... --output voice          # 后续 turn 的模型回复要求用语音输出
```

不在本期交付 CLI flag；由 skill 的自然调用触发。

### TUI / Desktop GUI

tool result 自动展示 inline audio player；与 video / image 同。

### Bot

不在本期范围；Bot 输出走 message reply。

## 与现有消息流的一致性

### Tool call flow

```
模型回复中包含 tool_call { name: "AudioOutput", args: { text, voice, format } }
   ↓
tool executor 调 audioOutputHandler
   ↓
audioOutputPort.synthesize
   ↓
artifactStore.write + resourceIndex.upsert
   ↓
tool result 行追加 inline player
   ↓
模型可以再次调 AudioOutput（多段语音回复）或 user message（用户追问）
```

### Resume / rewind / fork

synthesized audio 的 references 计数与现有 variant 一致。

## 安全

- 不本地保存凭据；走 provider provisioning 现有规则。
- 合成文本中的 PII 不进入日志；只记 sizeBytes / sha256 前缀。
- 平台 fence（sandbox）保留。

## 错误码

| code | 含义 | 重试 |
| --- | --- | --- |
| `audio_output_synthesize_failed` | provider 返回错误 | 最多 3 次 |
| `audio_output_provider_unavailable` | provider 不可用（credential 缺失） | 不重试（用户需配置） |
| `audio_output_voice_unavailable` | 指定的 voice 不存在 | 不重试 |
| `audio_output_quota_exceeded` | quota 耗尽 | 不重试 |
| `cancelled` | 用户取消 | 不重试 |
| `timeout` | provider 超时 | 最多 3 次 |

## 实施步骤

### Phase 5.1：spec 自审 + fixture

- 完整 spec 自审。
- 增加 test fixture：mock provider 的 synthesize 输出固定 mp3 bytes。

### Phase 5.2：port 契约

- 新文件 `packages/contracts/src/interfaces/audio-output.port.ts`，≤ 100 行。

### Phase 5.3：runtime types

- `runtime/types.ts` 加 `audioOutputPort?` 字段。
- `agent-runtime.ts` 同步。

### Phase 5.4：tool 接入

- 新增 `AudioOutput` ToolEntry + tool handler。
- 走 `00-tool-change-chain.md` 的 7 步：design → contracts → core → modelInstructions → adapter → permission → executor。

### Phase 5.5：handler

- `packages/core/src/tool/handlers/audio-output.ts`。
- 接入 resource index upsert。

### Phase 5.6：adapter

- `packages/adapters/src/audio/{openaiSpeech,elevenLabs,index}.ts`。
- 沿用现有 provider adapter 模式（不动 user key，由 provider provisioning 提供）。

### Phase 5.7：CLI / TUI / Desktop 入口

- CLI：tool pool 自然包含。
- TUI / Desktop：tool result 展示 inline audio player。

### Phase 5.8：bundle

- `packages/audio-bidirectional-plugin/skills/audio-output/SKILL.md`。
- agent 注册。

## 测试要求

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test
```

必测场景：

### 端口契约

- `AudioOutputPort.synthesize`：正常 / provider 不可用 / quota 耗尽 / voice 不存在。

### Handler

- 正常路径：synthesize → artifact write → resource index upsert → 返回 tool result。
- sizeBytes > 64 KiB：返回 path reference，不返回 inline dataUrl。
- 重复调用同 text + voice：sha256 不变 → 不重复 upsert。
- 错误码：provider 错误 → 报错；cancellation → 输入无效。

### Tool 集成

- 模型调 AudioOutput → tool result 含 inline player → 用户可以引用 audio 作为下轮 attachment。
- 同 tool 在同一个 model turn 调多次：每个 output 单独 entry + references。

### 现状不退化

- 现有 tool 不受影响。

## 提交条件

每个功能级变更单独提交：

1. port 契约 + barrel（commit 1）
2. runtime types + agent runtime wiring（commit 2）
3. AudioOutput tool spec + tool entry + 接入（commit 3）
4. tool handler（commit 4）
5. Node adapter（commit 5）
6. bundle skill（commit 6）
7. 单测（commit 7）

每提交后跑：

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test -- packages/core/tests/audio-output-tool.test.ts
```