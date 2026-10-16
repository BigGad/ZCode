# Audio Input 与转写

## 背景

ZCode 当前 attachment pipeline 已经覆盖 image / PDF / video，但 **audio 没有 attachment resolver**：

- `ZCodePromptAttachment.kind` 联合类型已经有 `audio` 分支（参见 `packages/shared/src/zcode-task-types-core.ts:196`），但 `ModelMessageContentBlock` 没有 audio 分支（参见 `packages/contracts/src/model/index.ts:403`）。
- 没有 `AudioPort` / `AudioTranscriptionPort` 契约；桌面 / TUI / CLI 不能添加音频附件。
- 没有后台转写 worker；audio 进入 provider 时无稳定的 transcript 文本兜底。
- 不支持 audio 的模型直接 strip，无法像 PDF "按页读取" 那样降级。

本文定义 audio attachment 的端到端通路：端口契约 → 附件解析 → 后台转写 → provider 投影。

## 当前实现状态

Status as of 2026-10-15: 本文为新建 spec，处于"设计完成、待落地"状态。相关分 spec：

- [`multimodal-platform.md`](./multimodal-platform.md)：总体架构。
- [`workspace-resource-index.md`](./workspace-resource-index.md)：transcript variant 持久化。
- [`audio-output.md`](./audio-output.md)：生产端（speech synthesis）。

## 目标

1. **audio 附件端到端**支持：CLI / TUI / Desktop GUI / Bot / ZCode app-server 都可添加音频；运行时 worker 转写 worker；sm provider projection。
2. **后台异步转写**：用户提交后立即返回（不等转写），后台 worker 跑完再回写 transcript variant。
3. **多模型降级**：支持 audio 的模型走 `ModelAudioContentBlock`；不支持的模型走 `ModelTextContentBlock(transcript)`；transcript 还没出来时显示"Transcription in progress"占位。
4. **资源持久化**：audio 与 transcript 都作为 Workspace Resource Index entry 的 variant；跨 session 复用。

## 非目标

- 不在本期交付 audio 的实时流式输入（live capture），由 `stream-input.md` 单独提案。
- 不在本期交付 audio 生产端（speech synthesis），由 `audio-output.md` 单独提案。
- 不在本期交付音频处理（EQ / 噪声抑制 / VAD），由后续 audio-effects spec 单独提案。
- 不在本期重写 ZCode app-server `session/send` 的 audio 边界；audio 进入 runtime 走 V4 协议 attachment。

## 端口契约

### AudioPort

```typescript
// contracts/src/interfaces/audio.port.ts
export type AudioFormat = "wav" | "mp3" | "m4a" | "ogg" | "flac" | "opus" | "any";

export interface AudioMetadata {
  durationMs: number;
  sampleRate: number;
  channels: 1 | 2;
  bitsPerSample?: number;
  codec?: string;
}

export interface AudioDecodeRequest {
  data: Uint8Array;
  mime: string;
  targetSampleRate?: number;
  targetChannels?: 1 | 2;
  trace: TraceContext;
}

export interface AudioCaptureRequest {
  source: "mic" | "system" | "file";
  durationMs?: number;
  outputFormat?: AudioFormat;
  trace: TraceContext;
}

export type AudioErrorCode =
  | "audio_decode_failed" | "audio_encode_failed"
  | "audio_capture_failed" | "audio_capture_denied"
  | "audio_too_long" | "audio_unsupported_mime"
  | "cancelled" | "io_error" | "permission_denied"
  | "process_failed" | "timeout" | "unavailable";

export class AudioPortError extends Error {
  constructor(
    readonly code: AudioErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AudioPortError";
  }
}

export interface AudioPort {
  decode(
    req: AudioDecodeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<{ samples: Float32Array; metadata: AudioMetadata }>;
  encode(
    samples: Float32Array,
    metadata: AudioMetadata,
    format: AudioFormat,
  ): Promise<Uint8Array>;
  capture(
    req: AudioCaptureRequest,
    options?: { signal?: AbortSignal },
  ): Promise<{ data: Uint8Array; mime: string; metadata: AudioMetadata }>;
}
```

### AudioTranscriptionPort

```typescript
// contracts/src/interfaces/audio-transcription.port.ts
export interface AudioTranscriptionSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string;
  confidence?: number;
}

export interface AudioTranscriptionRequest {
  audioRef: string;       // file path 或 artifact URI
  mime: string;
  language?: string;     // "zh-CN", "en-US"
  trace: TraceContext;
}

export type AudioTranscriptionErrorCode =
  | "transcription_engine_unavailable"
  | "transcription_failed"
  | "transcription_timeout"
  | "transcription_cancelled"
  | "audio_decode_failed"            // 复用 AudioPortErrorCode
  | "audio_unsupported_mime"
  | "cancelled" | "io_error"
  | "permission_denied"
  | "process_failed" | "timeout";

export class AudioTranscriptionPortError extends Error {
  constructor(
    readonly code: AudioTranscriptionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AudioTranscriptionPortError";
  }
}

export interface AudioTranscriptionPort {
  transcribe(
    req: AudioTranscriptionRequest,
    options?: { signal?: AbortSignal },
  ): Promise<{
    segments: AudioTranscriptionSegment[];
    fullText: string;
    detectedLanguage?: string;
  }>;
}
```

## attachment-audio.ts（与 attachment-pdf.ts 同构）

```typescript
// core/src/runtime/helpers/attachment-audio.ts (≤ 120 行)
export const AUDIO_INPUT_MAX_BYTES = 50 * 1024 * 1024;     // 50 MiB
export const AUDIO_INPUT_MAX_DURATION_MS = 30 * 60 * 1000;  // 30 min

export type AudioInputMimeType =
  | "audio/wav" | "audio/x-wav"
  | "audio/mpeg" | "audio/mp3"
  | "audio/mp4" | "audio/x-m4a"
  | "audio/ogg"
  | "audio/flac" | "audio/x-flac"
  | "audio/opus";

const AUDIO_EXT_MAP: Record<string, AudioInputMimeType> = {
  ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
  ".ogg": "audio/ogg", ".flac": "audio/flac", ".opus": "audio/opus",
};

export function inferAudioMimeFromPath(path: string): AudioInputMimeType | undefined {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[0];
  return ext ? AUDIO_EXT_MAP[ext] : undefined;
}

export interface ParsedAudioDataUrl {
  mediaType: AudioInputMimeType;
  sizeBytes: number;
  bytes: Uint8Array;
}

export function parseInlineAudioDataUrl(dataUrl: string): ParsedAudioDataUrl | undefined {
  // 复用 attachment-data-url.ts 的 parseDataUrlHeader + isStrictBase64Payload
  // 不再重复实现；调用方先验证 mime 在白名单内
  // ... (省略具体实现；与 attachment-pdf.ts 的 parseInlinePdfDataUrl 同结构)
}
```

不直接调用端口；端口由 resolver 注入（参照 `attachment-pdf.ts` 的"纯解析 + size 常量"原则）。

## runtime 集成

### Resolver 入口

```typescript
// core/src/runtime/helpers/attachment-media-resolver.ts
// （Phase 1 先拆出 inline-media-resolver.ts / local-media-resolver.ts 后，
//  新分支加入新文件，保持主调度文件 ≤ 250 行）

export async function resolveInlineAudioAttachment(
  attachment: TurnAttachment,
  index: number,
  parsedMediaType: string | undefined,
  options: InlineMediaResolverOptions & {
    audioPort?: AudioPort;
    audioTranscriptionPort?: AudioTranscriptionPort;
    workspaceResourceIndexPort?: WorkspaceResourceIndexPort;
  },
): Promise<ResolvedTurnAttachment | undefined> {
  // 与 resolveInlineMediaAttachment 中 image / pdf / video 同结构：
  // 1. parseInlineAudioDataUrl 校验
  // 2. mime 校验（必须 AudioInputMimeType 之一）
  // 3. sizeBytes 校验（≤ AUDIO_INPUT_MAX_BYTES）
  // 4. AudioPort.decode 获取 metadata（durationMs 等）
  // 5. durationMs 校验（≤ AUDIO_INPUT_MAX_DURATION_MS）
  // 6. persistAttachmentDataUrl → artifact URI
  // 7. upsert ResourceIndex (variant="original", sourceOrigin="user_upload")
  // 8. 返回 contentBlock: ModelAudioContentBlock (base64)
}

export async function resolveLocalAudioAttachment(
  context: LocalMediaContext & {
    audioPort?: AudioPort;
    audioTranscriptionPort?: AudioTranscriptionPort;
    workspaceResourceIndexPort?: WorkspaceResourceIndexPort;
  },
): Promise<ResolvedTurnAttachment> {
  // 与 resolveLocalPdfAttachment 同结构：
  // 1. stat 文件
  // 2. sizeBytes 校验
  // 3. readBinaryFile + AudioPort.decode 校验
  // 4. persistAttachmentDataUrl
  // 5. upsert ResourceIndex
  // 6. 返回 contentBlock
}
```

### 与 Resource Index 的联动

每个 attachment resolver 完成 upsert original variant 后：

```
audio resolved → resource_index.upsert({ ... entry, variants: [original] })
              → audio_transcription_worker 收到 entry
              → 调用 AudioTranscriptionPort.transcribe
              → resource_index.addVariant({ kind: "transcript", ... })
              → 更新 entry.meta.transcriptStatus = "ready"
```

## Provider 投影

### ModelAudioContentBlock

```typescript
// contracts/src/model/index.ts
export interface ModelAudioContentBlock {
  type: "audio";
  mediaType: string;
  dataUrl: string;
  durationMs?: number;
  transcript?: {               // 可选同步交付的转写文本
    startTs?: number;
    endTs?: number;
    provider: string;          // whisper-local | whisper-api
  };
  source?: AttachmentRef;
}
```

联合类型位置：在 `ModelFileContentBlock` 后、`ModelVideoContentBlock` 前；union 顺序保持 text → reasoning → image → file → audio → video → resource_link。

### 媒体策略

```typescript
// contracts/src/model/media-policy.ts
export type UnsupportedModelInputMediaKind =
  | "image input" | "PDF input" | "video input" | "audio input";

export function isProviderVisibleAudioModelInputBlock(
  block: ModelMessageContentBlock,
): boolean {
  return block.type === "audio" && block.dataUrl !== undefined;
}

export function getUnsupportedModelInputMediaKind(
  block: ModelMessageContentBlock,
  inputFormat: ModelInputFormat,
): UnsupportedModelInputMediaKind | undefined {
  // ... 同先前模式
  if (isProviderVisibleAudioModelInputBlock(block) && !inputFormat.supportsAudio) {
    return "audio input";
  }
  // ...
}
```

### 投影规则

| 模型 capability | Resource Index 状态 | 投影 |
| --- | --- | --- |
| `supportsAudio = true` | original ready | `ModelAudioContentBlock` (base64) + `[Audio: source: <path>]` |
| `supportsAudio = false` | transcript ready | `ModelTextContentBlock` (transcript.fullText) |
| `supportsAudio = false` | transcript pending | `ModelTextContentBlock` (placeholder: "Transcription in progress") |
| `supportsAudio = false` | transcript failed | `ModelTextContentBlock` (placeholder: "Transcription failed: <reason>") |
| 都不支持 | metadata_only | path reference 占位 |

transcript ready 的判定：
- `entry.meta.transcriptStatus === "ready"` 且 `entry.variants.find(v => v.kind === "transcript")` 存在。

transcript 失败后是否再次尝试：`addVariant` 不重复触发；用户主动重试需显式 `port.addVariant({ reRun: true })`，本期不实现。

### Media budget

audio / video / image 共用 40 MiB 请求预算（参照 `media-budget.ts`）。audio 超预算：

```typescript
throw new Error("MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE");
```

audio 损坏 / 拒绝 audio：

```typescript
throw new Error("audio_decode_failed");
```

错误码语义与 `MEDIA_BUDGET_CURRENT_VIDEO_TOO_LARGE_ERROR_CODE` 同构。

## 后台转写 worker

### 文件位置

`apps/zcode-cli/packages/services/src/audio-transcription-worker.ts`（≤ 400 行）。

### Worker 行为

```typescript
// 伪代码
export async function startAudioTranscriptionWorker(
  deps: {
    workspaceResourceIndex: WorkspaceResourceIndexPort;
    audioTranscription: AudioTranscriptionPort;
    audioTranscriptionQueues: AudioTranscriptionQueueRegistry; // per-workspace
    policyResolver: PolicyResolver;
    logger: Logger; // createServiceLogger("audio-transcription-worker")
  },
  options?: { signal?: AbortSignal },
): Promise<void> {
  // 1. 启动时扫一次：所有 entry.kind === "audio" 且不含 transcript variant 的 entry 全部入队
  // 2. 订阅 workspaceResourceIndex.subscribeUpserts
  // 3. 收到 event 时过滤 entry.kind === "audio" 且不含 transcript variant 的入队
  // 4. 队列：
  //    - per-workspace FIFO
  //    - 同 sha256 不重复（跨 session 复用）
  //    - 单条执行失败 3 次后跳过，下个 GC tick 删除 transcriptStatus === "failed"
  // 5. 调 audioTranscription.transcribe(audioRef, mime, language)
  // 6. addVariant({ kind: "transcript", mime: "text/plain", bytes: ..., sha256: ... })
  // 7. 更新 entry.meta.transcriptStatus = "ready" | "failed"
  // 8. logger.info / warn / error
}
```

### Trace 传播

worker 从 `WorkspaceResourceIndexEntry.addedAt` 关联的 original 输入 trace；新增 `traceId` 从 resource index 的 `event.meta.traceId` 读取；port.transcribe 接收 `trace: TraceContext`。

```typescript
const traceContext: TraceContext = {
  traceId: entry.meta?.traceId ?? randomUUID(),
  // ... 其他
};
```

### 日志

- `debug`：每条入队、出队、转写进度（frequency high，仅本地开发模式开启）
- `info`：worker 启动 / 退出；新 variant 入库（`transcript ready: <resourceId>`）
- `warn`：单次重试、可恢复
- `error`：worker 进程退出、转写失败上限、artifact store 满

### Cancellation

worker 整体由 `AbortSignal` 控制；进入下一 entry 时若 signal 已 abort，立即退出。

## 入口适配

### CLI

```text
zcode attach sample.mp3 --prompt "总结这段音频"
zcode attach sample.mp3 --policy meeting
```

`--attach <path>` 按扩展名分流：

- `.wav` / `.mp3` / `.m4a` / `.ogg` / `.flac` / `.opus` → `audio` attachment
- `.jpg` / `.jpeg` / `.png` / `.gif` / `.webp` → `image`（不变）
- `.pdf` → `pdf`（不变）
- `.mp4` / `.mov` / `.webm` → `video`（不变）
- 其它 → `file`（不变）

`--policy <tag>` 把 `policyTag` 注入 entry；CLI 覆盖 `.zcode/resource-policy.yaml`。

### TUI

保留 `TuiReadClipboardImage` precedent；新增 `TuiReadClipboardAudio` 入口（macOS / Windows / Linux 各自剪贴板读取；本期不交付，预留接口）。

### Desktop GUI

composer 附件支持 audio mime；V4 上传沿用现有 20MiB 边界。本期不重新生成 audio buffer — 走 desktop localPath + 上传到 host（同 video）。

### Bot

飞书 / Telegram / 其它 bot provider：

- image mime → `image` attachment（已有）
- voice / audio → `audio` attachment（本期新增）
- file → `file`（不变）

实现位于 `packages/services/src/bots/providers/{feishu,telegram}.ts`，按 mime 命中 audio。

### ZCode app-server

不在本期范围；audio 进入 runtime 走 V4 协议 attachment 边界；后续 `zcode-protocol-agent-server` 单独提案。

## Bundle 装配

`apps/zcode-cli/packages/audio-bidirectional-plugin/`：

- `package.json`：`{ "name": "@zcode/audio-bidirectional-plugin", "private": true }`
- `.zcode-plugin/plugin.json`：metadata
- `skills/audio-input/SKILL.md`：描述如何调 audio 能力（实际由 built-in tool pool 暴露，不直接调端口）
- `agents/audio-summary.md`：可选摘要 agent（参照 pdf-plugin/agents/visual-judge.md 形态）

在 `OFFICIAL_PLUGIN_DEFINITIONS` 加 entry，`defaultEnabled`：

- Desktop / Web：true
- TUI / CLI：true（仅 audio-input 子集，streaming 由 hardware 层处理）
- Mobile：true（仅 audio-input）
- Hardware：true（仅 streaming）

## 与既有消息流的一致性

### Prompt expansion

audio 不直接走 fullText（raw bytes 转 text 不合适）。audio 提供：

1. base64 data → `ModelAudioContentBlock`
2. transcript text → `ModelTextContentBlock`
3. path reference → `ModelTextContentBlock([Audio: source: <path>])`

provider projection 三选一，按 model capability 决定。

### Compact / summary

compact boundary 记录 `attachmentMessageIds`；summary 模型默认 `stripMedia: true`，audio / image / video / pdf 都被 strip 成 placeholder。**transcript 是否保留？**

- 默认 transcript 在 compact 中**保留**（因为是文本，不是 raw media）。
- 实现：在 `stripMedia` 时，audio entry 仅 strip original variant，保留 transcript variant 的文本引用。

### Resume / rewind / fork

与现有 file part 一致；不引入新规则。

## 安全

- audio bytes 不离开宿主机的本地 transcription（whisper-local）；走 whisper-api 等远端时遵循 `ZCODE_PROVIDER_*` provisioning；不带凭据。
- audio capture 时 macOS TCC、Windows 隐私权限请求失败走 IPlatformService；端口报错 `audio_capture_denied`，不重试。
- transcript 文本中的 PII 不进入日志；debug 日志只记 sizeBytes / durationMs / sha256 前缀。

## 错误码

| code | 含义 | 重试 |
| --- | --- | --- |
| `audio_decode_failed` | 损坏音频 / mime 不匹配 | 不重试 |
| `audio_encode_failed` | 编码失败（output 路径） | 不重试 |
| `audio_capture_failed` | capture 设备错误 | 不重试 |
| `audio_capture_denied` | 平台权限拒绝 | 不重试（需用户授权） |
| `audio_too_long` | durationMs > 30 min | 不重试 |
| `audio_unsupported_mime` | mime 不在白名单 | 不重试 |
| `transcription_engine_unavailable` | whisper 未安装 / token 缺失 | 可重试（每次启动时再测） |
| `transcription_failed` | whisper 返回错误 | 最多 3 次 |
| `transcription_timeout` | whisper 超时 | 最多 3 次 |
| `transcription_cancelled` | 用户取消 | 不重试 |
| `policy_not_configured` | policy 缺 default | 不重试（用户需修配置） |
| `policy_invalid` | yaml 非法 | 不重试 |
| `bundle_disabled` | bundle defaultEnabled=false | 不重试 |

## 实施步骤

### Phase 3.1：spec 自审 + fixture

- 完整 spec 自审；确保无 TODO / 占位。
- 增加 test fixture：小 WAV (1s)、长 MP3 (5min)、损坏音频、超 30 min 音频、超 50 MiB 音频。

### Phase 3.2：port 契约

- 新文件 `packages/contracts/src/interfaces/{audio,audio-transcription}.port.ts`，各 ≤ 100 行。
- `export * from "./<port>.port.js"` 到 barrel。

### Phase 3.3：runtime types

- `runtime/types.ts` 加 `audioPort?`、`audioTranscriptionPort?`、`workspaceResourceIndexPort?` 字段。
- `agent-runtime.ts` 同步添加 private 字段 + 赋值。

### Phase 3.4：attachment-audio.ts

- 新文件 `core/src/runtime/helpers/attachment-audio.ts`，≤ 120 行。

### Phase 3.5：resolver

- `inline-media-resolver.ts` / `local-media-resolver.ts`（Phase 1 拆分后文件）加 audio 分支。
- `attachment-media-resolver.ts` 调度。

### Phase 3.6：provider projection

- `ModelAudioContentBlock` 加到 `model/index.ts`。
- `media-policy.ts` 加 audio 分支。
- `provider-request-messages.ts` 加 audio 投影分支。
- `media-budget.ts` 加 audio 计算。

### Phase 3.7：worker

- `packages/services/src/audio-transcription-worker.ts`，≤ 400 行。
- 订阅 resource index upsert；幂等转写。

### Phase 3.8：adapter

- `packages/adapters/src/audio/{whisperLocal,whisperApi,index}.ts`。
- Node 默认实现；SEA runtime 不引入 native binary。

### Phase 3.9：CLI / TUI / Desktop 入口

- CLI `--attach` 扩展：audio 扩展名 → audio attachment。
- CLI `--policy <tag>` flag。
- TUI 暂不交付 audio 输入；下版本预留。
- Desktop composer 入口扩展。

### Phase 3.10：bundle

- `packages/audio-bidirectional-plugin/{package.json,.zcode-plugin/plugin.json,skills/,agents/}`。
- `OFFICIAL_PLUGIN_DEFINITIONS` 加 entry。

### Phase 3.11：单测

- `packages/core/tests/attachment-audio.test.ts`（参照 `prompt-attachments.test.ts`）。
- `packages/core/tests/runtime-read-audio.test.ts`（参照 `runtime-read-pdf.test.ts`）。
- `packages/services/tests/audio-transcription-worker.test.ts`。

## 测试要求

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test
```

必测场景：

### 端口契约

- `AudioPort.decode`：正常 WAV / 损坏 bytes / mime 不匹配。
- `AudioPort.capture`：要监听的设备存在 / 不存在 / 权限拒绝。
- `AudioTranscriptionPort.transcribe`：正常输出 / 超时 / 取消 / engine unavailable。

### Resolver

- inline base64 audio：contentBlock.type === "audio"；artifactUri 写入 artifact store；resource index upsert 触发。
- local path audio：file stat + read + audio.decode + persist。
- 超 sizeBytes：占位符 `audio_too_long`,不进入 worker。
- 超 durationMs：占位符 `audio_too_long`，不进入 worker。
- mime 不在白名单：占位符 `audio_unsupported_mime`，不进入 worker。
- 损坏音频：占位符 `audio_decode_failed`，不进入 worker。

### Worker

- 启动时扫一次入队：所有缺 transcript 的 audio entry。
- 新 upsert：自动入队。
- 幂等：同 sha256 不重复。
- 重试：transcription 失败 3 次后跳过。
- traceId 传播：worker log 与 port.transcribe 用同一个 traceId。

### Provider 投影

- supportsAudio=true：ModelAudioContentBlock + path placeholder。
- supportsAudio=false + transcript ready：ModelTextContentBlock (transcript.fullText)。
- supportsAudio=false + transcript pending：placeholder "Transcription in progress"。
- supportsAudio=false + transcript failed：placeholder "Transcription failed: <reason>"。
- media budget：超 40 MiB 抛 `MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE`。

### CLI / TUI / Bot

- CLI `--attach sample.mp3` → audio attachment。
- CLI `--attach sample.mp3 --policy meeting` → policyTag 注入。
- Bot `feishuProvider.onVoiceMessage` → audio attachment。
- 不支持 audio 的模型不报错。

### 现状不退化

- 现有 image / PDF / video / file / ZCode app-server 回放 E2E 矩阵全过。

## 提交条件

每个功能级变更单独提交：

1. 端口契约 + barrel export（commit 1）
2. runtime types + agent runtime wiring（commit 2）
3. attachment-audio.ts + inline/local resolver（commit 3）
4. provider projection（commit 4）
5. audio-transcription-worker（commit 5）
7. Node adapter（commit 7）
8. CLI / Bot / Desktop 入口（commit 8）
9. bundle + OFFICIAL_PLUGIN_DEFINITIONS（commit 9）
10. 单测（commit 10）

每提交后跑：

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test -- packages/core/tests/attachment-audio.test.ts
```