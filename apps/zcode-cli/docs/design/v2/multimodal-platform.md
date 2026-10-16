# 多模态能力平台

## 背景

本文为 `apps/zcode-cli/docs/design/v2/message-attachments.md` 之后的下一代多模态总架构。

`message-attachments.md` 已经覆盖：图片 / PDF / 视频的输入通路、`FilePart + zcode-artifact://` 持久化、provider 投影与媒体预算。但有以下结构性问题：

- 缺乏 **跨 session 的资源库**：当前 `FilePart` 只在当前 session 上下文内可读；workspace 内"上次上传过的图"无法在新 session 重用。
- audio 完全没有 attachment resolver，虽然 `ZCodePromptAttachment.kind` 联合类型已经有 `audio`，但 `ModelMessageContentBlock` 没有 audio 分支，没有 `AudioPort` / `AudioTranscriptionPort`，桌面 / TUI / CLI 不能添加音频附件。
- video 只能整段 base64 发送，没有 frame 采样；不支持 video 的模型直接 strip，无 PDF "按页部分读取" 同级能力。
- 没有 production 端：不能合成语音 / 生成视频产出。
- 没有 streaming / hardware 输入通路；不支持实时麦克风 / 摄像头 / 屏幕录制。
- 客户端变体（Desktop / Web / Mobile / TUI / CLI / Hardware）与能力的装配关系是隐式的，没有显式的 capability bundle 装配契约。

本文在不破坏 `message-attachments.md` 已落地形态的前提下，补齐**多模态能力平台**作为后续 audio / video / streaming / hardware 扩展的总体架构。

## 当前实现状态

Status as of 2026-10-15: 本文为新建 spec，下列六篇条目均处于"设计完成、待落地"状态：

- [`workspace-resource-index.md`](./workspace-resource-index.md)：workspace 维度的跨 session 持久资源库。
- [`audio-input.md`](./audio-input.md)：audio 附件输入、转写 worker、provider 投影。
- [`video-frames.md`](./video-frames.md)：video 抽帧采样、frame worker、provider 投影。
- [`audio-output.md`](./audio-output.md)：语音生产端与播放路径。
- [`stream-input.md`](./stream-input.md)：live capture（麦克 / 摄像头 / 屏幕）通路。
- [`hardware-sensor.md`](./hardware-sensor.md)：硬件传感器输入（GPS / 加速度 / 等等）。

`message-attachments.md` 已落地的 image / PDF / video 主线**保持不变**，本文新增的所有能力都走 attachment pipeline 的同一套 contract-first 端口契约。

## 架构总览（六层）

```
┌──────────────────────────────────────────────────────────────────────┐
│ L5 客户端变体 (Desktop / Web / Mobile / TUI / Hardware / CLI)         │
│    └ 装配每个 capability bundle，按客户端形态选择性引入                │
├──────────────────────────────────────────────────────────────────────┤
│ L4 Capability Bundle                                                  │
│    @zcode/bundle-audio-bidirectional  (input+output)                 │
│    @zcode/bundle-video-bidirectional  (input+output)                 │
│    @zcode/bundle-streaming            (live capture)                  │
│    @zcode/bundle-hardware             (sensors)                       │
├──────────────────────────────────────────────────────────────────────┤
│ L3 Attachment Resolver (runtime/helpers/)                            │
│    attachment-audio.ts  attachment-video.ts  attachment-stream.ts     │
│    → ModelMessageContentBlock [text | image | video | audio | file]  │
├──────────────────────────────────────────────────────────────────────┤
│ L2 Workspace Resource Index (workspace 范围持久资源库)                │
│    resource://<workspaceIdentity>/<resourceId>                        │
│    原始 + transcript + frame + thumbnail + meta                       │
├──────────────────────────────────────────────────────────────────────┤
│ L1 Port (cross-cutting contract)                                       │
│    AudioPort · AudioTranscriptionPort · AudioOutputPort                │
│    VideoFramePort · LiveCapturePort · HardwareSensorPort              │
│    WorkspaceResourceIndexPort                                         │
├──────────────────────────────────────────────────────────────────────┤
│ L0 Adapter (Node / Browser / Native / SEA)                          │
│    ffmpeg / whisper / Web Audio / Electron media / PyMuPDF            │
└──────────────────────────────────────────────────────────────────────┘
```

**关键约束**：

- **L1 是 contract-first 端口**：调用方拿到的是稳定的 input / output / error / cancellation / retry / idempotent / side-effect 契约。业务层不直接调用 L0 adapter。
- **L2 是 workspace 维度资源库**：复用现有 `ToolArtifactStorePort` 写 variant bytes；SQLite 主存 `<storageRoot>/cli/resources/<workspaceIdentity>.db`；key 一律为 `workspaceIdentity?.trim() || workspacePath`，跨 session 复用、fork / rewind reference 计数。
- **L3 attachment resolver 是 session 内事务**：与现有 `attachment-media-resolver.ts` 的 inline / local 分支同构；新模态只是新增分支，不改既有 image / PDF / file 分支。
- **L4 bundle 是静态可选**：每个 bundle 是独立的 npm-style package（参照 `pdf-plugin` / `image-search-plugin`），`defaultEnabled: false`，TUI/CLI / Mobile 等资源不足客户端只默认开 audio input。
- **L5 客户端变体不变**：现有 `packages/desktop` / `packages/web` / `apps/zcode-cli` / `packages/zcode-cua` 等不变；能力差异通过 bundle 的 `defaultEnabled` 与 client-specific wiring 表达，不开新仓库。

## 客户端变体与 bundle 装配策略

| 客户端 | 默认启用 bundle | 备注 |
| --- | --- | --- |
| `packages/desktop` (Electron) | audio-bidirectional + video-bidirectional + streaming | native access 完整；可调用本地 ffmpeg / Electron media / Web Audio |
| `packages/web` | audio-bidirectional + video-bidirectional（部分） | 浏览器 Web Audio / WebRTC；服务端转写 |
| `packages/android` (mobile) | audio-input + streaming (mic-only) | 受限于移动端 sandbox |
| `apps/zcode-cli` (CLI/TUI) | audio-input only | 默认装配；production 端与 streaming 通过显式 `--enable` flag 开启 |
| `packages/zcode-cua` (remote control) | 仅 audio-input | 复用 desktop host attachment；不为 mobile / remote 单独起 audio/video bundle |
| `hardware` | streaming + hardware | phase 1 暂未交付客户端；预留入口 |

bundle 装配的 contract 是 `OFFICIAL_PLUGIN_DEFINITIONS` 数组（`apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts:88+`）。新 bundle 加 entry 时设 `defaultEnabled: false`，由客户端特定 wiring 决定启用与否。

## 与既有 attachment pipeline 的关系

`message-attachments.md` 是事实源。本次新增不重复造轮子：

| 既有设施 | 新模块怎么复用 |
| --- | --- |
| `FilePart + zcode-artifact://` | 资源库 variant bytes 直接走 `ToolArtifactStorePort`，不另存 |
| `attachment-media-resolver.ts` 的 inline / local 分支 | 新 audio / video frame 走同一种 dispatch，不另写一套 |
| `ModelMessageContentBlock` 联合类型 | 加 `audio` 分支，union 顺序保持 text → reasoning → image → file → audio → video → resource_link |
| `MediaBudget (40 MiB)` | audio / video frame 同样受请求级预算门控；超预算抛 `MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE` |
| `ProviderTransform` | 现有 `media-policy.ts` 加 audio 分支 |
| `createServiceLogger(scope)` | 所有新 worker 用此标准名 |

## 设计要点

### 端口契约原则

每个新端口必须：

1. `xxx-port.ts` 一个文件，≤ 100 行，参照 `pdf-document.port.ts` 的 Shape A 模板：
   - `XxxPortError extends Error` with `readonly code`
   - `XxxErrorCode` literal union
   - 接口方法 `portMethod(req, options?: { signal?: AbortSignal })`
   - 请求 / 结果类型为 discriminated union 或 readonly interface
2. 同时导出 `export * from "./<port>.port.js"` 到 `packages/contracts/src/interfaces/index.ts` 和 `packages/contracts/src/index.ts` 两个 barrel。
3. 不引入 native binary / sharp / `.node` addon 到默认 SEA runtime（参照 `sea-cross-target-packaging.md:114` 的 Jimp precedent）。

### 资源库（Resource Index）原则

- Workspace 维度持久化；不重复 session 内 file store 的事实。
- variant 包括 `original / transcript / frame / thumbnail / waveform`；每条 variant 都有自己的 mime / bytes / sha256 / artifactUri。
- reference 计数驱动 GC；fork / rewind child resume references += 1，session 关闭 / rewind references -= 1；归零 entry 删除，variant bytes 同步清理。
- 业务策略（`./.zcode/resource-policy.yaml`）按 `policyTag` 命中分支；`policy_not_configured` 报错，不默默回退。

### 后台 worker 原则

- 每个 worker 一个文件，≤ 400 行；命名 `audio-transcription-worker` / `video-frame-worker` / `audio-output-worker` / `stream-capture-worker`。
- 订阅 Resource Index upsert 事件；幂等（同 sha256 跨 session 复用）。
- 公平队列（per-workspace）、可取消、可重试、可观察。
- 全部走 `createServiceLogger(scope)`；traceId 从入口传播。
- 日志等级：
  - `debug`：upsert 查询、variant add、request sizeBytes、转写进度（高频，生产环境不落盘）
  - `info`：worker 启动 / 退出、转写完成、新 variant 入库
  - `warn`：单次重试、可恢复
  - `error`：worker 进程退出、转写失败上限、artifact store 满

### Provider 投影原则

每个新模态必须：

1. 在 `ModelMessageContentBlock` 加新分支。
2. 在 `media-policy.ts` 加 capability gate 函数。
3. 在 `provider-request-messages.ts` 的 provider projection 里按 `properties.input_format.supports<X>` 门控；不支持时 strip 媒体、保留 `[Attached ...]` 占位。
5. 接受现有 media budget（40 MiB）；超出抛 `MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE`。

### Bundle 装配原则

参照 `pdf-plugin` / `image-search-plugin`：

- `apps/zcode-cli/packages/<bundle-name>-plugin/`、`private: true`、`description: ...`。
- `.zcode-plugin/plugin.json` 描述 metadata；不需要 mcp server 就不写 `mcpServers`。
- `skills/<skill>/SKILL.md` 描述 agent 该怎么用能力；不直接调端口，端口是 AgentRuntime 注入后通过 built-in tool pool 暴露（参见 `pdf-plugin/agents/visual-judge.md` 的 `tools: [Read, Bash]` precedent）。
- 在 `OFFICIAL_PLUGIN_DEFINITIONS` 加 entry，`defaultEnabled: false` 直到对应客户端 wiring 准备好。

### 测试原则

每个新端口 / resolver / worker / bundle 必须有单测。模板：

- **端口契约单测**：`vitest` + `vi.fn<Port["method"]>()` inline mock；断言输入 / 输出 / error code / cancellation 行为。
- **resolver 单测**：参照 `packages/core/tests/prompt-attachments.test.ts`；断言 `contentBlock.type` / `metadata.artifactUri` / `storageKind`。
- **end-to-end runtime 单测**：参照 `packages/core/tests/runtime-read-pdf.test.ts`；用 `createTestAgentRuntime` 模拟 provider request，验证 message 中含预期的 content blocks。
- **worker 单测**：mock 端口，断言幂等 / 重试 / 完成时调用 `addVariant`。
- **bundle 单测**：验证 `defaultEnabled` / `requiredSeedPaths` 配置正确。

## 目标

第一阶段实现多模态能力平台骨架，包含 workspace resource index、audio+video 输入与生产端、streaming+hardware 入口预留：

1. **L1 port 完整**：audio / video / streaming / hardware 五类端口契约 + 错误码。
2. **L2 resource index**：跨 session 持久资源库，policy 文件驱动策略。
3. **L3 attachment resolver**：audio / video frame 分支接入；与既有 image / PDF / file 共用 dispatcher。
4. **L4 bundle 装配**：4 个 capability bundle，按客户端变体启用。
5. **L5 客户端变体接入**：Desktop / TUI / CLI 默认 wiring 同步切换到 `OFFICIAL_PLUGIN_DEFINITIONS` 驱动。

## 非目标

- 不在 SEA 默认运行时引入 sharp / NAPI addon（参照 `sea-cross-target-packaging.md:114` 的图片能力 precedent）。
- 不绕过 IPlatformService 直接调用 Electron / Web Audio；所有平台能力通过 port 抽象。
- 不直接读 `fs` / `fetch` / `child_process`；业务层只表达意图，IO 走 port / adapter。
- 不新增 `ZCODE_*` 环境变量；策略 / 引擎选择通过 `.zcode/resource-policy.yaml` 或显式 `--enable` flag。
- 不在本期重写 audio / video 在 `ZCode app-server` 的 `session/send` 边界 — 当前支持 `text` + `image` + `resource_link`，audio / video / stream / hardware 通过后续 app-server spec 单独提案。
- 不在本期重写 mobile 端 UI；mobile 装配随客户端能力系统完成。

## 契约

### 新端口契约清单

```typescript
// contracts/src/interfaces/audio.port.ts
export interface AudioPort {
  decode(req: { data: Uint8Array; mime: string; targetSampleRate?: number;
                targetChannels?: 1|2; trace: TraceContext },
         options?: { signal?: AbortSignal })
    : Promise<{ samples: Float32Array; metadata: AudioMetadata }>;
  encode(samples: Float32Array, metadata: AudioMetadata, format: AudioFormat)
    : Promise<Uint8Array>;
  capture(req: { source: "mic" | "system" | "file"; durationMs?: number;
                 outputFormat?: AudioFormat; trace: TraceContext },
          options?: { signal?: AbortSignal })
    : Promise<{ data: Uint8Array; mime: string; metadata: AudioMetadata }>;
}

// contracts/src/interfaces/audio-transcription.port.ts
export interface AudioTranscriptionPort {
  transcribe(req: { audioRef: string; mime: string; language?: string; trace: TraceContext },
             options?: { signal?: AbortSignal })
    : Promise<{ segments: AudioTranscriptionSegment[]; fullText: string;
                 detectedLanguage?: string }>;
}

// contracts/src/interfaces/audio-output.port.ts
export interface AudioOutputPort {
  synthesize(req: { text: string; voice?: string; format: AudioFormat; trace: TraceContext },
             options?: { signal?: AbortSignal })
    : Promise<{ data: Uint8Array; mime: string; durationMs: number }>;
}

// contracts/src/interfaces/video-frame.port.ts
export interface VideoFramePort {
  extractFrames(req: { videoRef: string; mime: string;
                       timesMs: number[]; trace: TraceContext },
                options?: { signal?: AbortSignal })
    : Promise<{ frames: Array<{ timeMs: number; imageDataUrl: string; // image/jpeg
                                width: number; height: number }> }>;
}

// contracts/src/interfaces/live-capture.port.ts (Phase 6)
export interface LiveCapturePort {
  start(req: { source: "mic" | "camera" | "screen" | "system-audio";
               constraints?: MediaStreamConstraints; trace: TraceContext },
        options?: { signal?: AbortSignal })
    : Promise<{ sessionId: string }>;
  // ... chunk pull / stop
}

// contracts/src/interfaces/hardware-sensor.port.ts (Phase 6)
export interface HardwareSensorPort {
  read(req: { sensor: "gps" | "accelerometer" | "gyroscope" | "barometer" | ...;
              durationMs?: number; trace: TraceContext },
       options?: { signal?: AbortSignal })
    : Promise<{ samples: Array<{ ... }> }>;
}

// contracts/src/interfaces/workspace-resource-index.port.ts
export interface WorkspaceResourceIndexPort {
  upsert(entry: WorkspaceResourceIndexEntry): Promise<WorkspaceResourceIndexEntry>;
  getById(workspaceKey: string, id: string): Promise<WorkspaceResourceIndexEntry | undefined>;
  query(req: WorkspaceResourceIndexQuery): Promise<WorkspaceResourceIndexQueryResult>;
  addVariant(req: { workspaceKey: string; id: string; variant: WorkspaceResourceVariant })
    : Promise<WorkspaceResourceIndexEntry>;
  incrementReferences(req: { workspaceKey: string; ids: string[]; delta: number })
    : Promise<void>;
  removeIfNotOrphaned(req: { workspaceKey: string; ids: string[] })
    : Promise<{ removed: string[] }>;
}
```

### 新内容块

```typescript
// contracts/src/model/index.ts
export interface ModelAudioContentBlock {
  type: "audio";
  mediaType: string;          // audio/wav | audio/mpeg | audio/ogg
  dataUrl: string;            // base64
  durationMs?: number;
  transcript?: {              // 同步交付的转写文本（可选）
  startTs?: number; endTs?: number;
    provider: string;         // whisper-local | whisper-api
  };
  source?: AttachmentRef;
}
```

### 媒体策略

```typescript
// contracts/src/model/media-policy.ts
export type UnsupportedModelInputMediaKind =
  | "image input" | "PDF input" | "video input" | "audio input";

export function isProviderVisibleAudioModelInputBlock(block: ModelMessageContentBlock): boolean {
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

## 资源策略（`.zcode/resource-policy.yaml`）

```
详细规格见 `workspace-resource-index.md` 与 `audio-input.md` 的对应章节。
```

策略文件位置：workspace 根目录 `/<repo>/.zcode/resource-policy.yaml`；提交 git 可分享给团队。

策略优先级（从高到低）：
1. CLI `--policy <name>` flag
2. workspace `.zcode/resource-policy.yaml` 中匹配的 `byTag`
3. workspace `.zcode/resource-policy.yaml` 的 `default`
4. bundle 内置默认

## 安全与错误

### 错误码（统一约定）

```typescript
export type MultimediaErrorCode =
  | "audio_decode_failed"        | "audio_encode_failed"
  | "audio_too_long"             | "audio_unsupported_mime"
  | "audio_capture_failed"       | "audio_capture_denied"
  | "transcription_engine_unavailable" | "transcription_failed"
  | "transcription_timeout"      | "transcription_cancelled"
  | "audio_output_synthesize_failed" | "audio_output_provider_unavailable"
  | "video_frame_extract_failed" | "video_unsupported_codec"
  | "video_output_provider_unavailable"
  | "live_capture_denied"        | "live_capture_failed"
  | "hardware_sensor_unavailable"
  | "resource_index_corrupt"     | "resource_index_storage_full"
  | "resource_index_write_conflict"
  | "policy_not_configured"      | "policy_invalid"
  | "bundle_disabled";
```

### 安全约束

- audio / video bytes 不离开宿主机的本地 transcription（whisper-local）；走 whisper-api / openai-speech 等远端时遵循现有 `ZCODE_PROVIDER_*` provisioning；不带凭据。
- 平台权限请求失败（majorOS TCC、Windows 隐私）走 IPlatformService，不绕过 sandbox。
- Resource Index 中的 `originalUrl` 不进入日志；日志只记 hash 前缀和 sizeBytes。
- Live capture 流式数据走本地 lifecycle；不直接交给 model provider；chunked upload 到 artifact store 后再考虑下一步处理。

## 实施阶段

### Phase 0：spec 与 fixture

1. 完成本文 + 6 份分 spec（resource-index / audio-input / audio-output / video-frames / video-output / stream-input / hardware-sensor）。
2. 更新 `message-attachments.md` 加 audio / video frame / resource index 段落。
3. 增加 test fixture：小 WAV / MP3 / OGG、损坏音频、> 30 min 音频、短 / 长 / 损坏视频。
4. 定义错误码与默认尺寸常量（`AUDIO_INPUT_MAX_BYTES = 50 MiB`、`AUDIO_INPUT_MAX_DURATION_MS = 30 min`）。

### Phase 1：refactor 既有超长文件

- 拆 `attachment-media-resolver.ts`（512 行）→ `attachment-media-resolver.ts`（薄壳）+ `inline-media-resolver.ts` + `local-media-resolver.ts`。
- 拆 `bootstrap/src/app/create-app.ts`（1407 行）→ 抽出 `port-wiring.ts`，port 接线逻辑全集中。

### Phase 2：resource-index + resource-policy

1. 实现 `WorkspaceResourceIndexPort` + Node SQLite adapter。
2. 实现 resource-policy yaml 解析 + 优先级合并。
3. 接入 `attachment-{image,pdf,video,file}` resolver：每次 upsert 都触发 resource index upsert。
4. 接入 fork/rewind reference 计数。

### Phase 3：audio input

1. `AudioPort` + `AudioTranscriptionPort` + `ModelAudioContentBlock` + provider 投影。
2. `attachment-audio.ts` resolver；inline / local 双分支。
3. `audio-transcription-worker`：订阅 resource index upsert，幂等转写，写 transcript variant。
4. whisper-local + whisper-api adapter。
5. CLI `--attach` + `--policy` flag。
6. TUI / Desktop GUI 入口（增量）。

### Phase 4：video frames

1. `VideoFramePort` + 扩展 `attachment-video.ts` 加 `framesMs` 参数。
2. `video-frame-worker`：按 resource-policy 抽帧。
3. ffmpeg / browser-native adapter。
4. provider 投影：supports_video=false 时，多帧 image block 替换 video block。

### Phase 5：audio output

1. `AudioOutputPort` + provider adapter（openai-speech / elevenlabs）。
2. `AudioOutputSkill` + `ResourceIndex.addVariant({ sourceOrigin: "generated_output" })`。
3. UI inline player。

### Phase 6：streaming + hardware

1. `LiveCapturePort` + `HardwareSensorPort` 端口契约。
2. 平台 capability 抽离（Electron media / WebRTC / Browser MediaDevices）。
3. bundle 注册与客户端变体接入。

### Phase 7：客户端变体 / bundle 装配

1. `OFFICIAL_PLUGIN_DEFINITIONS` 加 4 条 entry。
2. Desktop / TUI / CLI / Web 默认 wiring。
3. SEA 打包白名单同步更新。

### Phase 8：测试与提交

1. 单测：每个端口 / resolver / worker 至少 3 个测试。
2. E2E：本地手工 + 自动化 E2E。
3. 跑 `pnpm --dir apps/zcode-cli typecheck`、`pnpm --dir apps/zcode-cli lint`、`pnpm --dir apps/zcode-cli test` 全绿。
4. 拆分多个提交；每个提交后跑对应测试。

## 测试要求

完成实现前至少运行：

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test
```

必测场景：

- 每个新端口契约：输入 / 输出 / error code / idempotent / cancellation。
- 每个新 resolver：inline base64 / local path / artifact URI；超 sizeBytes / 超 durationMs / 损坏 bytes / mime 不匹配。
- 每个新 worker：幂等 / 重试 / abort；traceId 传播。
- provider 投影：supportsAudio / supportsVideo / 不支持三档；每档至少 1 case。
- 资源库：跨 session 引用 / fork reference / rewind reference / 跨 workspaceIdentity 隔离 / GC。
- resource-policy：yaml 不存在 / yaml 非法 / CLI override / byTag 命中。
- bundle 默认 disabled 时所有调用方收到 `bundle_disabled`，不崩溃。
- 现有 image / PDF / video 路径不退化；`message-attachments.md` 的"测试要求"全部 case 仍通过。