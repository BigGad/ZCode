# Stream Input (Live Capture)

## 背景

`audio-input.md` / `video-frames.md` / `audio-output.md` 已经定义 audio / video 的端到端通路，但**全部基于文件形式**（本地 path / artifact URI / base64 inline）。

ZCode 还需扩展到**实时 capture**：

- 麦克风录制（用户正在说话）
- 摄像头录制（视频会议 / 录屏讲解）
- 屏幕录制（演示 / 录屏）
- 系统音频录制

本期不重新造 capture stack；通过 `LiveCapturePort` 抽象 + 平台 adapter：

- Desktop (Electron): `MediaDevices` API + `getDisplayMedia`
- Web: `MediaStream` / `MediaRecorder` / `WebRTC`
- Mobile: 受 sandbox 限制，仅 mic-only

流式数据按 chunk 上传到 artifact store，再走 audio / video 主线处理（转写 / 抽帧）。

## 当前实现状态

Status as of 2026-10-15: 本文为新建 spec，处于"设计完成、待落地"状态。2026-10-16 增补 `network-stream` source 与 Continuous watch mode（RTSP 持续监控），该增补部分进入实施。相关分 spec：

- [`multimodal-platform.md`](./multimodal-platform.md)：总体架构。
- [`audio-input.md`](./audio-input.md)：流式 audio 进入主线的下游链路。

## 目标

1. **LiveCapturePort 抽象**：capture 启动 / 解锁 / 拉流 chunk / 持久化 / 终止的统一契约。
2. **平台 adapter 隔离**（Node / Web / Native），不破坏 IPlatformService 边界。
3. **流式数据落 artifact store**：chunked upload；session lifecycle 不丢数据。
4. **session 化 stream session**：开始 → 持续捕获 → 收尾（streamId）；commit 后形成的 audio / video entry 走 audio-input / video-frames 主线。

## 非目标

- 不在本期交付实时转写（live captioning）；用户提交后走 audio-input.md 的离线转写 worker。
- 不在本期交付实时视频分析（live Q&A）；抽帧按 video-frames.md 离线走。
- 不在本期交付 WebRTC 这类传输；仅本地 capture + chunked upload。
- 不在本期交付屏幕识别 / OCR / 图像理解。

## 端口契约

```typescript
// contracts/src/interfaces/live-capture.port.ts
export type LiveCaptureSource =
  | "mic" | "camera" | "screen" | "system-audio" | "app-window"
  | "network-stream"; // 2026-10-16 增补：RTSP 等网络流，Node/ffmpeg adapter 承载

export interface LiveCaptureConstraints {
  video?: {
    width?: { min?: number; ideal?: number; max?: number };
    height?: { min?: number; ideal?: number; max?: number };
    frameRate?: { min?: number; ideal?: number; max?: number };
    facingMode?: "user" | "environment";
  };
  audio?: {
    sampleRate?: { ideal?: number };
    channels?: { ideal: 1 | 2 };
    echoCancellation?: boolean;
    noiseSuppression?: boolean;
    autoGainControl?: boolean;
  };
  screen?: {
    frameRate?: { ideal: number };
    displaySurface?: "browser" | "monitor" | "window";
  };
  networkStream?: {
    // url 不出现在本契约中：凭据由受控配置（~/.zcode/cli/streams.json，0600）持有，
    // adapter 在 spawn 时经窄接口取用；日志 / 事件 / prompt 只允许出现脱敏 URL。
    transport?: "tcp" | "udp";
    segmentSeconds?: number; // 分段时长，默认 30s
  };
}

export interface LiveCaptureStartRequest {
  source: LiveCaptureSource;
  constraints?: LiveCaptureConstraints;
  chunkDurationMs?: number;        // 切片时长，默认 25_000（25s）
  trace: TraceContext;
}

export interface LiveCaptureStartResult {
  sessionId: string;               // 内部标识，commit 时携带
  source: LiveCaptureSource;
  startedAt: number;
}

export interface LiveCaptureChunk {
  sessionId: string;
  sequenceNumber: number;
  startedAt: number;              // chunk 起始时间戳
  endedAt: number;                // chunk 结束时间戳
  bytes: Uint8Array;
  mime: string;                   // audio/webm | video/webm 等
}

export interface LiveCaptureCommitRequest {
  sessionId: string;
  title: string;
  trace: TraceContext;
}

export interface LiveCaptureCommitResult {
  sessionId: string;
  resourceId: string;            // workspace resource index id
  totalBytes: number;
  totalDurationMs: number;
  mime: string;
}

export type LiveCaptureErrorCode =
  | "live_capture_denied"        // 平台权限拒绝（macOS TCC / Windows privacy）
  | "live_capture_failed"        // capture 设备错误
  | "live_capture_unsupported_source"
  | "live_capture_already_running"
  | "live_capture_not_found"
  | "live_capture_chunk_upload_failed"
  | "cancelled" | "io_error"
  | "permission_denied"
  | "process_failed" | "timeout"
  | "unavailable";

export class LiveCapturePortError extends Error {
  constructor(
    readonly code: LiveCaptureErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LiveCapturePortError";
  }
}

export interface LiveCapturePort {
  start(
    req: LiveCaptureStartRequest,
    options?: { signal?: AbortSignal },
  ): Promise<LiveCaptureStartResult>;
  // 持续调用 chunk 直到 signal abort；内部维护 session。
  pullChunks(
    sessionId: string,
    options?: { signal?: AbortSignal },
  ): AsyncIterable<LiveCaptureChunk>;
  // 收尾：把累积 chunks 合并为单一 entry，落 artifact + resource index。
  commit(
    req: LiveCaptureCommitRequest,
    options?: { signal?: AbortSignal },
  ): Promise<LiveCaptureCommitResult>;
  // 放弃：不 commit，删除临时 state。
  cancel(
    sessionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}
```

## StreamSession lifecycle（runtime 内）

StreamSession 是 LiveCapturePort 之上的 L2 抽象：

```typescript
// core/src/runtime/stream-session.ts (新文件)
export class StreamSession {
  constructor(
    private readonly deps: {
      liveCapture: LiveCapturePort;
      artifactStore: ToolArtifactStorePort;
      workspaceResourceIndex: WorkspaceResourceIndexPort;
      logger: Logger;     // createServiceLogger("stream-session")
    },
    public readonly sessionId: string,
    public readonly source: LiveCaptureSource,
    private readonly options: {
      title?: string;
      chunkDurationMs: number;
      traceContext: TraceContext;
    },
  ) {}

  async start(signal: AbortSignal): Promise<void>;
  async pullChunks(signal: AbortSignal): AsyncIterable<LiveCaptureChunk>;
  async commit(title: string): Promise<LiveCaptureCommitResult>;
  async cancel(): Promise<void>;
}
```

行为：

- `start()`：调 `liveCapture.start`；得到 `LiveCaptureStartResult`。
- `pullChunks()`：调 `liveCapture.pullChunks(sessionId, { signal })`，对每个 chunk 调 `artifactStore.writeToolArtifactBinary`；本地累积 chunks 列表。
- `commit(title)`：把所有 chunks 拼成单一 mp4 / webm file（adapter 决定）；写最终 artifact；upsert resource index entry。
- `cancel()`：删除临时 state；不 commit。

### Trace 传播

traceId 从 `LiveCaptureStartRequest.trace` 进入；后续 `commit` 的 TraceContext 与 start 一致。

## 入口适配

### CLI

```
zcode stream mic --prompt "把刚才我说的话总结一下"
zcode stream screen --policy screen-recording
```

行为：CLI 启动 stream session → 持续 stream 到文件结束（用户 Ctrl+C / Enter 提交） → 走 audio-input / video-frames 主线。

### CLI（network-stream，2026-10-16）

```
zcode stream analyze --stream <id> --once   # 抓一个 segment 做一次分析（最小垂直切片）
zcode stream watch --stream <id>            # 长驻持续监控 + 异常告警（Ctrl+C 干净退出）
zcode stream watch --stream <id> --duration 2h   # 定时结束（也支持 --until <ISO|epoch-ms>）
zcode stream watch --stream <id> --forever       # 后台常驻（detached 子进程 + 日志文件），立即返回
zcode stream stop --stream <id>             # 停止后台常驻 watch
zcode stream events [--stream <id>] [--since <t>] [--limit <n>] [--json]
zcode stream list                           # 列出 streams.json 中已配置的流（脱敏 URL）
```

`watch` 是第一个 CLI 优先入口；TUI / Desktop / bundle（OFFICIAL_PLUGIN_DEFINITIONS）对 network-stream 为非目标，后续阶段再评估。

### TUI

`ctrl+shift+m` 启动 mic 流；`ctrl+shift+s` 启动 screen 流。
（具体快捷键由 TUI input 配置决定。）

### Desktop GUI

composer 旁边新增 "🎙️" 按钮启动 mic 流、"🖥️" 按钮启动 screen 流。

### Mobile (Android)

仅 mic 流；受 sandbox 限制，screen 流不在本期范围。

## Workspace Resource Index 集成

### Entry

```typescript
{
  id: ulid(),
  workspaceIdentity,
  workspacePath,
  kind: "audio" | "video",                    // 由 source 决定
  title: "Live mic recording",
  sourceOrigin: "recording" | "screen_capture" | "device_stream",
  addedAt: now,
  updatedAt: now,
  variants: [
    {
      kind: "original",
      mime: "audio/webm" | "video/webm",
      bytes: 12345,
      sha256: "...",
      artifactUri: "zcode-artifact://...",
    },
  ],
  references: 1,
  meta: {
    durationMs: 60000,
    policyTag: "meeting" | "screen-recording",
    policySource: "auto-detected",
    source: "mic" | "camera" | "screen" | "system-audio" | "app-window" | "network-stream",
  },
}
```

### 后续处理

commit 后，audio / video entry 走 audio-input / video-frames 现有的转写 / 抽帧 worker（前提是 entry 已存在，policy 已配置）。无需新 worker。

## 安全

### 平台权限

- macOS TCC：`NSMicrophoneUsageDescription` / `NSCameraUsageDescription` / `NSScreenCaptureUsageDescription` 在 `Info.plist` 中声明。
- Windows：Privacy settings → Microphone / Camera。
- Linux：PulseAudio / PipeWire 权限；Wayland screen capture 受 compositor 限制。

权限拒绝走 IPlatformService，不绕过：

```typescript
if (platformService.getMediaAccessStatus(source) === "denied") {
  throw new LiveCapturePortError("live_capture_denied", ...);
}
```

### 数据 lifecycle

- chunks 落 artifact store（私有 `<storageRoot>/cli/stream-cache/<sessionId>/`），不写入 workspace 公开目录。
- `commit` 之后：从 stream-cache 移入到 `cli/attachments/<workspaceIdentity>/<resourceId>/`，原 chunks 删除。
- 中途用户取消（cancel）：全部删除。
- session 中断（机器关机 / 进程崩溃）：重启时 GC tick 删除未提交的 stream-cache。

### 不直接发数据

- 实时 chunk 不发送给 provider；必须 commit 后形成的 entry 才能进入模型显式输入。
- 限制：不允许用户在 active capture 期间把 stream 直接给模型（避免凭据 / 隐私问题）。

### 凭据管理（network-stream，2026-10-16）

- RTSP 凭据存独立受控配置 `~/.zcode/cli/streams.json`（创建时 chmod 0600；Windows 无 POSIX 权限模型，尽力而为并文档注明剩余风险）。不并入 provider 配置（模型凭据域），也不进 workspace `resource-policy.yaml`（per-workspace 业务策略）；两者靠 `policyTag` 关联——streams.json 保存 tag，resource-policy.yaml 定义抽帧策略。
- URL 脱敏统一走 `redactUrlCredentials`（`core/src/util/redact-url.ts`，从 webfetch-url.ts 提升）；stream 全链路（CLI 输出、日志字段、alert JSONL、错误消息、事件 payload）只允许出现脱敏 URL。
- 凭据传给 ffmpeg 的通道：argv 直传（`mode: "argv"` 无 shell 拼接）。ffmpeg 不支持从文件/stdin 读输入 URL，故无替代通道；残余风险：子进程 URL 对同机其他用户经 ps 可见——与 PDF 密码先例（Poppler argv，pdf/index.ts）同一声明，spec 显式接受。
- 凭据不进 prompt（分析 turn 文本只含 stream id/title 与判定指令）、不进测试 fixture（fixture 用 `rtsp://user:***@host` 形态）。
- 环境变量：`ZCODE_STREAM_CONFIG`（覆盖 streams.json 路径，优先级高于默认路径，用于测试与多配置）与 `ZCODE_STREAM_FFMPEG_PATH`（覆盖 ffmpeg 可执行文件发现，应对不在 PATH 的 Windows 场景）。两者仅在此处定义，配置文件与 CLI 参数能表达的能力不新增环境变量。

## Continuous watch mode（RTSP 持续监控，2026-10-16）

使用形态：定时从网络流抓片段 → 抽帧 → in-process 分析 turn → 结构化判定 → 异常告警。与上文的「录制后 commit」语义有**一处显式偏离**：

### 输入 URL 与协议（2026-10-16 增补）

- `network-stream` 的 `url` 支持 `rtsp://`、`rtmp://`、`http(s)://`（FLV/TS 等直播封装）：ffmpeg 按输入自动探测，segmenter 一条链路共用（实测 http-flv HEVC 2592×1620 切片正常）。transport 字段（`tcp`/`udp`）仅对 rtsp 族 scheme 有意义，非 rtsp 输入忽略。
- argv 构造规则：仅当 URL scheme 为 `rtsp://`/`rtsps://` 时追加 `-rtsp_transport <tcp|udp>`（该选项是 RTSP demuxer 私有的，非 rtsp 输入会报 `Option rtsp_transport not found` 直接失败——2026-10-16 实测修正）。

### Segment 编号全局单调（2026-10-16 增补）

- 问题：ffmpeg 每次重启都从 `%05d` 的 0 开始覆盖写，而 watch-state 游标与告警去重键 `(streamId, segmentSeq)` 都假设 seq 全局单调。实测后果：重启后新内容被游标跳过、`analyze --once` 的「新判定」检测撞旧 seq 空等超时。
- 规则：segmenter 每次 `start()` 时取起始编号 = max(持久化 marker, 现存文件 max + 1)，经 `-segment_start_number` 传给 ffmpeg；marker 写在 outDir 内 `.segment-next-seq`（tmp+rename 原子写，与 watch-state 同一先例），`start` 时先落 marker，`watchClosedSegments` 随关段推进。
- segment 文件在游标推进后由 capture `deleteSegment` 删除（best-effort）：artifact 已持有提交副本，长驻 watch 不允许原始文件无限累积；删除失败只延迟磁盘回收，不影响幂等门。

### 运行时长与后台常驻（2026-10-16 增补）

- 旗标（仅 `watch`；`analyze` 携带报错）：
  - `--duration <n[s|m|h]>`（如 `30m`、`2h`、`90s`、纯数字按秒）与 `--until <ISO8601|epoch-ms>` 互斥，均为未来时刻，超时触发 abort 走正常收尾（stopped 生命周期事件 + ffmpeg 回收），退出码 0。
  - `--forever`：父进程校验配置/旗标后 spawn 自身（detached，stdout/stderr 追加到 `~/.zcode/cli/stream-logs/<streamId>.log`，日志不承诺轮转）并立即返回；子进程带内部旗标 `--daemon` 重新走完整装配。
- pid 文件：`~/.zcode/cli/stream-run/<streamId>.pid`，daemon 子进程启动时写入、退出时清理（仅当仍指向自身，防误删后继进程）。`--forever` 发现同流已在运行时报错不重复启动；陈旧 pid（进程已死）在 `stop` 时清理。
- 停止通道（跨平台）：`zcode stream stop --stream <id>` 移除 pid 文件并尽力发 SIGTERM；daemon 子进程每 5s 轮询 pid 文件缺失作为跨平台优雅停止通道（Windows 无可靠信号语义，残余风险：信号路径不可用时最多延迟一个轮询周期）。前台 watch 仍由 Ctrl+C 结束，无 pid 文件。
- 截止时刻由 CLI runner（监控所有者的装配层）持有 timer → abort → monitor 正常收尾；`--duration` 相对 daemon 子进程启动时刻计时（父进程仅做校验）。
- 中断语义：abort 信号贯穿抽帧与分析 turn（sendInput abortSignal），进行中的段立即中断；游标不推进、不写 `analysis_failed`（shutdown 中断不是分析失败），该段在下次启动时重放。
- 所有者与事件顺序不变：stop / deadline / Ctrl+C 都汇入同一 abortController，`runMonitor` 的 stopped 事件与 ffmpeg 回收路径唯一。

### Per-segment commit 语义偏离

- 原语义：一次 session 的全部 chunks 合并为**单一 entry**（commit 时）。
- watch 模式：ffmpeg 以 `-f segment -segment_time N` 分段，**每个 segment 独立 commit**为一条 resource index entry（kind `"video"` 或按策略、sourceOrigin `"device_stream"`、meta.source `"network-stream"`）。理由：持续监控是长期运行（天级），单一 entry 无法承载；且「committed entry 才能进模型输入」的红线要求每个片段在关段后立即成为合法输入。

### 所有者与事件顺序

- 监控循环所有者 = `zcode stream watch` 长驻 CLI 进程；循环本体是 core helper（`createStreamMonitor`）。Desktop Host 将来接管时挂同一 helper（CLI watch 是其单机子集）。不用 automation（cron 在 Host 侧，纯 CLI 场景不可用）。
- 每 segment 顺序固定：关段判定 → artifact 写入（retention `"temporary"`）→ 抽帧 → 预算 → index upsert → 分析 turn → 告警落盘 → watch-state 推进 → 旧 segment 清理。
- 幂等边界：watch-state cursor（`lastProcessedSegmentSeq`，tmp+rename 原子写）+ deterministic entry id（`stream-<monitorId>-<seq>`）。崩溃重启重扫现存 segments，`getById` 二次幂等；重跑最多重复一次分析 turn，alert-store 以 `(streamId, segmentSeq)` 为去重键。

### 失败恢复

- ffmpeg 断流：指数退避重连（1s→2s→…→60s 封顶），每次写 `reconnect` 生命周期事件；连续失败写一次 `stream_down` 告警（状态翻转去重，防风暴）。
- 分析 turn 失败：写 `analysis_failed` 事件，segment 标记已处理（不阻塞后续），entry.meta 记 `analysisStatus: "failed"`。
- RTSP 无历史回看：宕机窗口的流数据不可恢复；恢复语义 = 从现存 segment 继续，宕机间隙写一行 `gap` 事件。判定阈值：启动时 watch-state `updatedAt` 距今超过一个 `segmentSeconds` 周期即视为中断（正常快速重启不写）；`updatedAt` 由 watch-state 保存方在每次游标推进时刷新。

### 告警持久化

- `~/.zcode/cli/stream-events/<streamId>.jsonl`（append-only，每行 zod 校验）；不写 session store（告警是观测数据，不是可恢复/分叉的对话状态）。
- 保留 30 天，复用 adapters 侧 logging retention 的按天清理先例。
- 外部通道（webhook / 邮件）为非目标；JSONL 是对外稳定对接面。

### 权限面

- 分析 turn 走 deny permission broker（只读图、禁工具），权限语义独立于交互 session 的 profile（用户配置 yolo 不影响监控 turn）。

## Bundle 装配

`apps/zcode-cli/packages/streaming-plugin/`：

- `package.json`：`{ "name": "@zcode/streaming-plugin", "private": true }`
- `.zcode-plugin/plugin.json`：metadata
- `skills/streaming/SKILL.md`：何时启动流、如何 commit / cancel

在 `OFFICIAL_PLUGIN_DEFINITIONS` 加 entry，`defaultEnabled`：

- Desktop：true
- Web：true
- Mobile：true（仅 mic）
- TUI / CLI：false

## 实施步骤

### Phase 6.1：spec 自审 + fixture

- 完整 spec 自审。

### Phase 6.2：port 契约

- 新文件 `packages/contracts/src/interfaces/live-capture.port.ts`，≤ 100 行。

### Phase 6.3：runtime types

- `runtime/types.ts` 加 `liveCapturePort?` 字段。
- `agent-runtime.ts` 同步。

### Phase 6.4：StreamSession

- `core/src/runtime/stream-session.ts`，≤ 200 行。
- chunked upload + commit / cancel lifecycle。

### Phase 6.5：adapter

- `packages/adapters/src/live-capture/{electronMedia,browserMediaRecorder,index}.ts`。

### Phase 6.6：CLI / TUI / Desktop 入口

- CLI `zcode stream <source>`。
- TUI 快捷键。
- Desktop GUI 按钮。

### Phase 6.7：bundle

- `packages/streaming-plugin/{package.json,.zcode-plugin/plugin.json,skills/}`。
- `OFFICIAL_PLUGIN_DEFINITIONS` 加 entry。

## 测试要求

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test
```

必测场景：

### 端口契约

- `LiveCapturePort.start`：权限拒绝 / 设备不存在 / 设备错误。
- `LiveCapturePort.pullChunks`：取消 / 中断。
- `LiveCapturePort.commit`：空 session / 异常 session。
- `LiveCapturePort.cancel`：删除临时文件。

### StreamSession

- start → pullChunks → commit：entry 持久化到 resource index。
- start → cancel：临时文件删除；不写 entry。
- 中断（AbortSignal）：chunks 落 artifact；GC 后删除。

### 权限拒绝

- macOS TCC 拒绝：port 报 `live_capture_denied`；UI 引导用户到 Privacy 设置。

### 跨 session 复用

- 上次 stream session 的 entry 在新 session 中作为 audio / video attachment 引用，走 audio-input / video-frames 主线。

## 提交条件

每个功能级变更单独提交：

1. port 契约 + barrel（commit 1）
2. runtime types + agent runtime wiring（commit 2）
3. StreamSession lifecycle（commit 3）
4. Node adapter（commit 4）
5. CLI / TUI / Desktop 入口（commit 5）
6. bundle + OFFICIAL_PLUGIN_DEFINITIONS（commit 6）
7. 单测（commit 7）

每提交后跑：

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test -- packages/core/tests/stream-session.test.ts
```