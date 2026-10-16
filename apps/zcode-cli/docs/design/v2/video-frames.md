# Video Frame Sampling

## 背景

`message-attachments.md` 已经定义 video 的端到端通路：`ZCodePromptAttachment.kind === "video"` → `attachment-video.ts` resolver → `ModelVideoContentBlock`（base64 dataUrl）→ provider projection。

但当前 video 没有"按页部分读取"的能力：

- 不支持 video 的模型直接 strip → 没有 image-frame fallback（PDF 可以"按页"）。
- 长 video（> 30 MiB）整段 base64 超过 media budget 时，整段 strip → 用户看到 `[Video omitted]` 而不是"这段视频中的几帧关键画面"。
- 没有抽帧 worker；video 无法按 `.zcode/resource-policy.yaml` 的 frame sampling 策略被处理。

本文为 video 增加**抽帧采样**能力：长 video 自动按策略抽帧，生成 `frame` variant；不支持 video 的模型自动用 frame image blocks 替换。

## 当前实现状态

Status as of 2026-10-15: 本文为新建 spec，处于"设计完成、待落地"状态。相关分 spec：

- [`multimodal-platform.md`](./multimodal-platform.md)：总体架构。
- [`workspace-resource-index.md`](./workspace-resource-index.md)：frame variant 持久化。
- [`audio-input.md`](./audio-input.md)：audio 转写 worker 的相邻形态。

### 落地范围（2026-10-16，随 RTSP 持续监控首发）

本阶段（stream-input.md Continuous watch mode 配套）只交付：

- `packages/contracts/src/interfaces/video-frame.port.ts` 契约（下文原文落地）。
- `packages/adapters/src/video/ffmpeg-frames.ts`：one-shot `extractFrames`（Node/ffmpeg，模板 = Poppler adapter：availability probe 缓存、argv 无 shell、mkdtemp scratch、finally 清理、typed errors）。
- frame → image-block 的消费管线只由 stream-monitor 使用：每帧经 `imageProcessorPort.prepareForModel` 预算处理（40 MiB 聚合 / 单帧 > 5 MiB 剥离，规则照抄本文投影表）。

**后续阶段**（不在本阶段交付）：浏览器抽帧 worker（`packages/services` 包尚不存在，届时决定落点）、`attachment-video.ts` 的 framesMs 扩展、provider 投影分支（supportsVideo→video block / false→frames）、`meta.frameSamplingStatus` 占位 UI、OFFICIAL_PLUGIN_DEFINITIONS bundle。

## 目标

1. **video 抽帧**：按 `policy.video.frameSampling` 策略自动从 video 抽取 frame（image/jpeg）。
2. **多模型降级**：支持 video 的模型走 `ModelVideoContentBlock`；不支持的模型走多帧 `ModelImageContentBlock`；frame 还没出来时显示"Frame sampling in progress"占位。
3. **资源持久化**：video 与 frames 都作为 Workspace Resource Index entry 的 variant；跨 session 复用。
4. **策略驱动**：抽帧频率 / 上限 / 模式由 `.zcode/resource-policy.yaml` 控制。

## 非目标

- 不在本期交付 video 生产端（video generation），由 `video-output.md` 单独提案。
- 不在本期交付"实时流式 video capture"（screen / camera），由 `stream-input.md` 单独提案。
- 不在本期交付 video editing / 拼接 / 转场，仅消费端。
- 不在本期重写 ZCode app-server `session/send` 的 video 边界。

## 端口契约

### VideoFramePort

```typescript
// contracts/src/interfaces/video-frame.port.ts
export interface VideoFrameRequest {
  videoRef: string;            // file path 或 artifact URI
  mime: string;
  timesMs: number[];           // 抽帧时间点
  trace: TraceContext;
}

export interface VideoFrame {
  timeMs: number;
  imageDataUrl: string;        // image/jpeg base64
  width: number;
  height: number;
}

export type VideoFrameErrorCode =
  | "video_frame_extract_failed"
  | "video_unsupported_codec"
  | "video_unsupported_container"
  | "cancelled"
  | "io_error"
  | "permission_denied"
  | "process_failed"
  | "timeout"
  | "unavailable";

export class VideoFramePortError extends Error {
  constructor(
    readonly code: VideoFrameErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "VideoFramePortError";
  }
}

export interface VideoFramePort {
  extractFrames(
    req: VideoFrameRequest,
    options?: { signal?: AbortSignal },
  ): Promise<{ frames: VideoFrame[] }>;
}
```

### FrameSamplingPolicy（已定义在 workspace-resource-index.md，复用）

```typescript
export interface FrameSamplingPolicy {
  intervalSec?: number;        // uniform 模式使用
  maxFrames?: number;          // 上限
  mode?: "uniform" | "keyframes" | "firstlast" | "explicit";
  manualTimesMs?: number[];    // explicit 模式使用
}
```

## attachment-video.ts 扩展

现有 `attachment-video.ts` 仅支持整段 base64 解析。本期加 `framesMs` 参数：

```typescript
// core/src/runtime/helpers/attachment-video.ts (扩展，不破坏现有契约)
export interface ResolveVideoAttachmentOptions {
  // ... 既有字段
  framesMs?: number[];        // 新增：调用方要求的帧时间点
  videoFramePort?: VideoFramePort;
  workspaceResourceIndexPort?: WorkspaceResourceIndexPort;
}

// resolver 增加分支：
// - 若 options.framesMs 提供：
//   1. 解析 video（与现有 path 相同）
//   2. 调 videoFramePort.extractFrames(timesMs)
//   3. 把 frames 作为 ModelImageContentBlock[] 返回
//   4. upsert ResourceIndex addVariant({ kind: "frame", mime: "image/jpeg", ... })
// - 否则：保持现有行为，返回 ModelVideoContentBlock
```

> 重要：扩展 `framesMs` 不破坏现有 video attachment；默认仍走整段 base64。

## runtime 集成

### Resolver 入口

```typescript
// core/src/runtime/helpers/attachment-media-resolver.ts
// 新分支在 inline-media-resolver.ts 与 local-media-resolver.ts 加

export async function resolveInlineVideoAttachment(
  attachment: TurnAttachment,
  index: number,
  parsedMediaType: string | undefined,
  options: InlineMediaResolverOptions & {
    videoFramePort?: VideoFramePort;
    workspaceResourceIndexPort?: WorkspaceResourceIndexPort;
    policyResolver?: PolicyResolver;
  },
): Promise<ResolvedTurnAttachment | undefined> {
  // 与现有 video resolver 同结构；额外：
  // 1. parseInlineVideoDataUrl 校验
  // 2. mime 校验
  // 3. sizeBytes 校验（≤ VIDEO_INPUT_MAX_BYTES）
  // 4. 调 policyResolver.resolveFrameSamplingPolicy(entry)
  // 5. 计算抽帧时间点
  // 6. videoFramePort.extractFrames
  // 7. persistAttachmentDataUrl 给每帧
  // 8. upsert ResourceIndex (variant="original" + addVariant("frame", ...))
  // 9. 返回 contentBlocks:
  //    - 若 options.framesMs 提供 → ModelImageContentBlock[] (frames)
  //    - 否则 → ModelVideoContentBlock (整段)
}
```

### Frame 时间点计算

由 `policyResolver.resolveFrameSamplingPolicy(entry, policy)` 返回 `FrameSamplingPolicy`，再计算 timesMs：

```typescript
// core/src/runtime/helpers/video-frame-sampler.ts
export function computeFrameTimes(
  durationMs: number,
  policy: FrameSamplingPolicy,
): number[] {
  if (policy.mode === "explicit" && policy.manualTimesMs) {
    return policy.manualTimesMs.filter((t) => t <= durationMs);
  }
  if (policy.mode === "firstlast") {
    return [0, durationMs];
  }
  // uniform / keyframes
  const interval = (policy.intervalSec ?? 10) * 1000;
  const max = policy.maxFrames ?? 60;
  const times: number[] = [];
  for (let t = 0; t <= durationMs && times.length < max; t += interval) {
    times.push(t);
  }
  return times;
}
```

## Provider 投影

### 不修改内容块

`ModelVideoContentBlock` 与 `ModelImageContentBlock` 已存在。本文不引入新内容块类型。

### 媒体策略

```typescript
// contracts/src/model/media-policy.ts
export function isProviderVisibleVideoModelInputBlock(block: ModelMessageContentBlock): boolean {
  // 既有：video 或 file mediaType=video/* 且 dataUrl !== undefined
}

export function getUnsupportedModelInputMediaKind(
  block: ModelMessageContentBlock,
  inputFormat: ModelInputFormat,
): UnsupportedModelInputMediaKind | undefined {
  // ... 同先前模式
  // video block 走既有逻辑
}
```

不修改 `media-policy.ts`；本期新增的是 "video block → frame image blocks 转换"，发生在 `provider-request-messages.ts`。

### 投影规则

| 模型 capability | Resource Index 状态 | 投影 |
| --- | --- | --- |
| `supportsVideo = true` | original ready | `ModelVideoContentBlock` (整段 base64) + `[Video: source: <path>]` |
| `supportsVideo = false` | frame ready | `ModelImageContentBlock[]` (frames 数组) |
| `supportsVideo = false` | frame pending | `ModelTextContentBlock` (placeholder: "Frame sampling in progress") |
| `supportsVideo = false` | frame failed | `ModelTextContentBlock` (placeholder: "Frame sampling failed: <reason>") |
| `supportsVideo = true` + frame also ready | original ready + frame ready | `ModelVideoContentBlock` + `ModelImageContentBlock[]` 优先 video |
| 都不支持 | metadata_only | path reference 占位 |

视频原始 + 一个 `ModelVideoContentBlock` + 多帧 `ModelImageContentBlock` 同时进入 provider 是否合适？

- 默认：不同时发；按 capability 选一种。
- 多模态启用 `supportBothVideoAndImage = true`：本期不交付，预留。

frame ready 判定：

```typescript
function isFrameReady(entry: WorkspaceResourceIndexEntry): boolean {
  return entry.meta?.frameSamplingStatus === "ready"
      && entry.variants.some((v) => v.kind === "frame");
}
```

### Media budget

frame image blocks 同样受 40 MiB 媒体预算限制：

```typescript
// 单帧 image data URL bytes 与原 video bytes 一起算；
// frame 总数 = maxFrames（policy）；
// 单帧超 5 MiB（极少；通常 < 500 KiB）→ strip。
```

单帧超 5 MiB 的处理：保留 video block（即使 model 不支持，仍作为 path reference 占位）。

## 后台抽帧 worker

### 文件位置

`apps/zcode-cli/packages/services/src/video-frame-worker.ts`（≤ 400 行）。

### Worker 行为

```typescript
// 伪代码
export async function startVideoFrameWorker(
  deps: {
    workspaceResourceIndex: WorkspaceResourceIndexPort;
    videoFrame: VideoFramePort;
    videoFrameQueues: VideoFrameQueueRegistry;
    policyResolver: PolicyResolver;
    logger: Logger; // createServiceLogger("video-frame-worker")
  },
  options?: { signal?: AbortSignal },
): Promise<void> {
  // 1. 启动时扫一次：所有 entry.kind === "video" 且不含 frame variant 的 entry 入队
  // 2. 订阅 workspaceResourceIndex.subscribeUpserts
  // 3. 收到 event 时过滤 entry.kind === "video" 且不含 frame variant 的入队
  // 4. 队列：
  //    - per-workspace FIFO
  //    - 同 sha256 不重复（跨 session 复用）
  //    - 单条执行失败 3 次后跳过；frameSamplingStatus = "failed"
  // 5. 调 videoFrame.extractFrames(videoRef, mime, timesMs)
  // 6. addVariant({ kind: "frame", mime: "image/jpeg", bytes: ..., sha256: ..., meta: { timeMs, width, height } })
  // 7. 更新 entry.meta.frameSamplingStatus = "ready" | "failed"
  // 8. logger.info / warn / error
}
```

### 抽帧频率（policy）

| mode | 行为 |
| --- | --- |
| `uniform` | 固定间隔（默认 10s），上限 maxFrames（默认 60） |
| `keyframes` | 由 adapter 自行判断关键帧；adapter 可选实现（ffmpeg `-vf select="eq(pict_type\,I)"` 等） |
| `firstlast` | 仅 0 与最后一帧 |
| `explicit` | 用户显式指定 timesMs 列表 |

policy 缺省时返回默认 `uniform 10s/60 frames`。

### Trace 传播

worker 与 audio-transcription-worker 一致：从 `entry.meta?.traceId` 读取 traceId，传播到 `videoFrame.extractFrames`。

### 日志

- `debug`：每条入队、出队、抽帧进度（仅本地开发模式开启）
- `info`：worker 启动 / 退出；新 frame variant 入库
- `warn`：单次重试、可恢复
- `error`：worker 进程退出、抽帧失败上限

### Cancellation

worker 整体由 `AbortSignal` 控制。

## 入口适配

### CLI

```text
zcode attach recording.mp4 --prompt "总结这段视频的关键画面"
zcode attach recording.mp4 --policy screen-recording
```

`--attach <path>` 按扩展名分流（既有）：

- `.mp4` / `.mov` / `.webm` / `.mkv` / `.avi` → `video`

`--policy <tag>` 把 `policyTag` 注入 entry。

### TUI / Desktop GUI / Bot

video 既有通路不变；frame sampling 在 attachment resolver 透明触发。

### ZCode app-server

不在本期范围。

## Bundle 装配

`apps/zcode-cli/packages/video-bidirectional-plugin/`：

- `package.json`：`{ "name": "@zcode/video-bidirectional-plugin", "private": true }`
- `.zcode-plugin/plugin.json`：metadata
- `skills/video-frames/SKILL.md`：描述如何用 video 抽帧（实际由 built-in tool pool 暴露）
- `agents/video-summary.md`：可选摘要 agent（参照 pdf-plugin precedent）

在 `OFFICIAL_PLUGIN_DEFINITIONS` 加 entry，`defaultEnabled`：

- Desktop / Web：true
- TUI / CLI：false（保持不变，video 仍由 attachment 主线处理，不暴露视频相关 skill）
- Mobile：false（保持不变）

## 与现有 message 流的一致性

### Compact / summary

- `stripMedia: true` 时，video 整段 strip；frame variants 也 strip（保留 path）。
- transcript-like 文本不在 video frame 范畴；video 不产生 transcript。
- 实现：与 audio 同构。

### Resume / rewind / fork

- frame variant 与 original variant 一样 reference 计数。

### Policy 一致性

- 同一 video entry 的 frame sampling policy 与 transcript policy 来自同一 `.zcode/resource-policy.yaml`；policyTag 命中后两份都从 `byTag[tag]` 取。

## 安全

- video bytes 抽帧到 frame image 后，frame image bytes 仍走原 video 的 lifecycle；不复制到新 namespace。
- frame 不内联到日志；日志只记 frame count / total bytes / sha256 前缀。
- 平台权限（camera / screen）失败走 IPlatformService；端口报错 `VideoFramePortError.code === "permission_denied"`。

## 错误码

| code | 含义 | 重试 |
| --- | --- | --- |
| `video_frame_extract_failed` | ffmpeg 等 adapter 出错 | 最多 3 次 |
| `video_unsupported_codec` | codec 不支持（H.265 等） | 不重试 |
| `video_unsupported_container` | 容器不支持（MKV 等） | 不重试 |
| `policy_not_configured` | policy 缺 default | 不重试 |
| `policy_invalid` | yaml 非法 | 不重试 |
| `bundle_disabled` | bundle defaultEnabled=false | 不重试 |
| `cancelled` | 用户取消 | 不重试 |

## 实施步骤

### Phase 4.1：spec 自审 + fixture

- 完整 spec 自审；确保无 TODO / 占位。
- 增加 test fixture：短 MP4（10s）、长 MP4（5min）、损坏视频、超大 codec（HEVC）、keyFrame / firstLastLast frame 测试。

### Phase 4.2：port 契约

- 新文件 `packages/contracts/src/interfaces/video-frame.port.ts`，≤ 100 行。
- `export * from "./video-frame.port.js"` 到 barrel。

### Phase 4.3：runtime types

- `runtime/types.ts` 加 `videoFramePort?` 字段。
- `agent-runtime.ts` 同步添加。

### Phase 4.4：attachment-video.ts 扩展

- 加 `framesMs` 参数 + `videoFramePort` + `workspaceResourceIndexPort` + `policyResolver`。
- 不破坏现有 API。

### Phase 4.5：resolver

- inline-media-resolver / local-media-resolver 加 video frame 分支。

### Phase 4.6：provider projection

- `provider-request-messages.ts` 加 video → frames image blocks 转换分支。
- `media-budget.ts` 加 frame bytes 计算。

### Phase 4.7：worker

- `packages/services/src/video-frame-worker.ts`，≤ 400 行。

### Phase 4.8：adapter

- `packages/adapters/src/video/{ffmpegFrames,browserNative,index}.ts`。

### Phase 4.9：CLI 入口

- CLI `--policy <tag>` flag（与 audio 共用）。

### Phase 4.10：bundle

- `packages/video-bidirectional-plugin/{package.json,.zcode-plugin/plugin.json,skills/,agents/}`。
- `OFFICIAL_PLUGIN_DEFINITIONS` 加 entry。

### Phase 4.11：单测

- `packages/core/tests/attachment-video-frames.test.ts`。
- `packages/core/tests/runtime-read-video-frames.test.ts`。
- `packages/services/tests/video-frame-worker.test.ts`。

## 测试要求

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test
```

必测场景：

### 端口契约

- `VideoFramePort.extractFrames`：正常 MP4 / 损坏 video / codec 不支持。
- policy `mode = "explicit"`：手动 timesMs 命中。
- policy `mode = "uniform"`：durationMs + intervalSec + maxFrames 计算正确。
- policy `mode = "firstlast"`：仅 0 与最后。

### Resolver

- inline base64 video + framesMs：frames image blocks 返回。
- local path video + framesMs：file stat + read + videoFramePort.extractFrames。
- 超 VIDEO_INPUT_MAX_BYTES：占位符。
- mime 不在白名单：占位符。

### Worker

- 启动时扫一次入队：所有缺 frame 的 video entry。
- 新 upsert：自动入队。
- 幂等：同 sha256 不重复。
- 重试：抽帧失败 3 次后跳过。
- traceId 传播。

### Provider 投影

- supportsVideo=true：ModelVideoContentBlock + path placeholder。
- supportsVideo=false + frame ready：ModelImageContentBlock[] (frames 数组)。
- supportsVideo=false + frame pending：placeholder。
- media budget：frames 总 bytes 超 40 MiB → strip。

### CLI

- `zcode attach recording.mp4 --policy screen-recording` → policyTag 注入 → frame sampler 按 2s 间隔抽帧。
- `zcode attach lecture.mp4 --policy lecture-recording` → 按 30s 间隔抽帧，上限 30 帧。
- `zcode attach product.mp4 --policy product-walkthrough` → mode=explicit，按 manualTimesMs 抽帧。

### 现状不退化

- 现有 video（不带 framesMs）行为完全保持：仍返回 ModelVideoContentBlock。
- `pnpm --dir apps/zcode-cli test` 全绿。

## 提交条件

每个功能级变更单独提交：

1. port 契约 + barrel（commit 1）
2. runtime types + agent runtime wiring（commit 2）
3. attachment-video.ts 扩展（commit 3）
4. resolver video frame 分支（commit 4）
5. provider projection（commit 5）
6. video-frame-worker（commit 6）
7. Node adapter（commit 7）
8. CLI `--policy` 扩展（commit 8）
9. bundle + OFFICIAL_PLUGIN_DEFINITIONS（commit 9）
10. 单测（commit 10）

每提交后跑：

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test -- packages/core/tests/attachment-video-frames.test.ts
```