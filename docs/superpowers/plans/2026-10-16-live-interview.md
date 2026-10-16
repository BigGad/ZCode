# Live Interview 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ZCode CLI 交付本地麦克风+摄像头的实时访谈记录：分块转写、随时提问、预定关键词规则预警、结束总结。

**Architecture:** 会话内后台 monitor loop（core helper，与已实现的 RTSP stream-monitor 同构）；ffmpeg 设备采集（segmenter 形态）；云端 STT 转写；resource index 持久化 transcript/frames/notes；告警走 JSONL + `MonitorAlertRaised` live-only 事件；`/capture` slash 命令族。

**Tech Stack:** TypeScript / Node.js, vitest, zod, node:sqlite（既有 resource index adapter）, ffmpeg（外部进程,经 executionPort）。

**Spec:** `apps/zcode-cli/docs/design/v2/live-interview.md`（执行时同时阅读；计划与 spec 冲突时以 spec 为准并回报）。

## Global Constraints

- 单源文件 ≤400 行；超限按高内聚拆分。常量提取命名，不散落字面量。
- 异步 IO；子进程一律 `executionPort`（argv 数组，无 shell 拼接）；不直接用 `fetch`/`child_process`（adapter 边界内除外，且须经 `HttpClientPort`/`ExecutionPort`）。
- **不新增环境变量**。ffmpeg 路径复用 `ZCODE_STREAM_FFMPEG_PATH`；其余配置走文件与 CLI 参数。
- 日志红线：transcript 文本、告警摘录、`transcription.json` 的 apiKey **不得进入任何日志、错误消息、测试 fixture**。摘录只允许出现在告警 JSONL 与事件 payload。
- 每个功能级变更一个独立提交；提交信息以 `feat:`/`test:`/`docs:` 开头，结尾加 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- 每任务收尾运行：`pnpm --dir apps/zcode-cli typecheck && pnpm --dir apps/zcode-cli lint`（在 `/Users/imissu/Documents/coding/libo/ZCode` 执行），再加该任务指定的测试命令。
- core 不得 import adapters/bootstrap；contracts 不 import core/adapters。跨包走公开入口（`index.ts` barrel）。
- 中文测试用例名（仓库惯例）；测试用 `mkdtemp(join(tmpdir(), ...))` + `afterEach` 清理。
- 工作目录：除注明外所有路径相对 `/Users/imissu/Documents/coding/libo/ZCode/apps/zcode-cli`。

## Review Focus

以下输入类是 spec 隐含但常规测试不覆盖、最容易咬人的（每条已钉进对应任务的测试）：

1. **设备名含空格/非英文/引号**（Windows dshow 尤甚）→ argv 必须参数数组直传设备名，不做 shell 转义。测试：Task 4。
2. **关键词跨 chunk 边界被切断**（词被 25s 分段切开）→ v1 接受漏报，但已匹配词不得因重扫重复告警。测试：Task 5。
3. **`transcription.json` 泄密** → 错误消息与日志只报文件路径不报 key。测试：Task 2/3。
4. **TCC 中途撤权/设备拔出** → 整场优雅终止，已落盘资源完整可查。测试：Task 8。
5. **访谈期间无关 prompt**（如同 session 里写代码）→ 注入块有明确边界标记且仅在 interview active 时注入，模型可忽略。测试：Task 10。

---

### Task 1: contracts — MonitorRule/MonitorAlert 契约 + audio 端口导出 + diarize 字段

**Files:**
- Create: `packages/contracts/src/interfaces/monitor-rule.ts`
- Modify: `packages/contracts/src/interfaces/index.ts`（追加导出）
- Modify: `packages/contracts/src/interfaces/audio-transcription.port.ts`（`AudioTranscriptionRequest` 加 `diarize?: boolean`）
- Test: `packages/contracts/tests/monitor-rule.test.ts`

**Interfaces:**
- Produces: `MonitorRule`、`MonitorAlert`、`MonitorAlertSource`、`monitorRuleSchema`、`monitorAlertSchema`（Task 5/6/7/12/13/14 消费）；`AudioTranscriptionRequest.diarize?: boolean`（Task 3 消费）。

- [ ] **Step 1: 写失败测试**

```ts
// packages/contracts/tests/monitor-rule.test.ts
import { describe, expect, it } from "vitest";
import { monitorAlertSchema, monitorRuleSchema } from "../src/interfaces/monitor-rule.js";

describe("monitor-rule 契约", () => {
  it("规则：type 仅 transcript-keyword，keywords 非空数组，speakers 可选", () => {
    const parsed = monitorRuleSchema.parse({ id: "r1", type: "transcript-keyword", enabled: true, keywords: ["价格"] });
    expect(parsed.keywords).toEqual(["价格"]);
    expect(() => monitorRuleSchema.parse({ id: "r2", type: "transcript-keyword", enabled: true, keywords: [] })).toThrow();
  });
  it("告警：interviewId/source/matchedKeyword/timeMs/chunkSeq/excerpt(≤200) 必填，zod 拒绝超长 excerpt", () => {
    const alert = { ruleId: "r1", type: "transcript-keyword", interviewId: "capture-abc", source: "mic", matchedKeyword: "价格", chunkSeq: 3, timeMs: 75_000, excerpt: "x".repeat(200) };
    expect(monitorAlertSchema.parse(alert).excerpt).toHaveLength(200);
    expect(() => monitorAlertSchema.parse({ ...alert, excerpt: "x".repeat(201) })).toThrow();
    expect(() => monitorAlertSchema.parse({ ...alert, source: "screen" })).toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败** — `pnpm --dir apps/zcode-cli test -- packages/contracts/tests/monitor-rule.test.ts`，预期 FAIL（模块不存在）。

- [ ] **Step 3: 实现 `monitor-rule.ts`** — 按 spec「规则模型」节的 `MonitorRule`/`MonitorAlert` 形状 + 上述 schema；`MonitorAlert` 含 `chunkSeq: number`（去重键组成部分，spec 的 dedupeKey 语义）。文件 ≤100 行。

- [ ] **Step 4:** `packages/contracts/src/interfaces/index.ts` 追加 `export * from "./monitor-rule.js";`，并**补上缺失的** `export * from "./audio.port.js";` 与 `export * from "./audio-transcription.port.js";`（探索确认两者未导出）。`audio-transcription.port.ts` 的 `AudioTranscriptionRequest` 加可选 `diarize?: boolean;`（注释注明 spec 来源 live-interview.md）。

- [ ] **Step 5: 测试 + typecheck 通过后提交**

```bash
git add packages/contracts
git commit -m "feat: monitor-rule contract and audio port exports for live interview"
```

---

### Task 2: 转写受控配置 adapter（transcription.json）

**Files:**
- Create: `packages/adapters/src/config/transcription-config.adapter.ts`
- Modify: `packages/adapters/src/config/index.ts`（按既有导出方式追加）
- Test: `packages/adapters/tests/transcription-config.test.ts`

**Interfaces:**
- Produces: `TranscriptionProviderConfig { provider: "deepgram" | "openai-compatible"; apiKey: string; model?: string; language?: string; diarize: boolean; baseUrl?: string }`、`loadTranscriptionConfig(path?: string): TranscriptionProviderConfig`（缺文件抛 `TranscriptionConfigError("not_found")`）、`resolveTranscriptionConfigPath(explicitPath?: string): string`（默认 `~/.zcode/cli/transcription.json`）、`class TranscriptionConfigError extends Error { code: "not_found" | "invalid" | "io_error" }`。
- 照抄先例：`packages/adapters/src/config/stream-config.adapter.ts`（zod schema、错误类、路径解析；不需要 write 与 0600——本文件用户手写）。

- [ ] **Step 1: 写失败测试** — 断言：合法文件 parse 成功且 `diarize` 缺省为 `true`；缺文件 → `not_found`；坏 JSON / version 非 1 → `invalid`；**错误消息只含文件路径，绝不含文件内容**（写入含 `"apiKey": "sk-secret"` 的坏文件，断言 `error.message` 不含 `sk-secret`）；`resolveTranscriptionConfigPath` 显式路径优先。

- [ ] **Step 2: 运行确认失败** — `pnpm --dir apps/zcode-cli test -- packages/adapters/tests/transcription-config.test.ts`。

- [ ] **Step 3: 实现** — zod：`{ version: z.literal(1), provider: z.enum(["deepgram", "openai-compatible"]), apiKey: z.string().min(1), model: z.string().optional(), language: z.string().optional(), diarize: z.boolean().default(true), baseUrl: z.string().url().optional() }`；读取走 node:fs/promise；路径解析 `~` 展开（照抄 stream-config 的 `resolvePath`）。

- [ ] **Step 4: 通过后提交** `feat: transcription controlled config adapter`。

---

### Task 3: 云端 STT adapter

**Files:**
- Create: `packages/adapters/src/audio/cloud-transcription.ts`
- Create: `packages/adapters/src/audio/index.ts`（barrel）
- Test: `packages/adapters/tests/audio-cloud-transcription.test.ts`

**Interfaces:**
- Consumes: `AudioTranscriptionPort`（contracts，Task 1 已导出；`transcribe(req: AudioTranscriptionRequest): Promise<AudioTranscriptionResult>`，`AudioTranscriptionSegment { startMs; endMs; text; speaker?; confidence? }`）；`HttpClientPort`（contracts/src/interfaces，**实现前先读其方法签名**，测试 fake 按其真实接口写）；Task 2 的 `TranscriptionProviderConfig`。
- Produces: `createCloudTranscriptionAdapter(options: { httpClientPort: HttpClientPort; config: TranscriptionProviderConfig }): AudioTranscriptionPort`。

- [ ] **Step 1: 写失败测试**（fake `HttpClientPort`，无网络）：

  - deepgram：请求带 `Authorization: Token <key>`、`Content-Type: audio/wav`、query 含 `diarize=true`（config.diarize 为 true 时）；响应 `results.channels[0].alternatives[0].words` 按 `speaker` 标签聚段 → `segments[].speaker` 保留 provider 标签、`startMs/endMs` 来自 word 时间；`req.diarize === false` 时覆盖 config 不带 diarize 参数。
  - openai-compatible：POST `<baseUrl|https://api.openai.com/v1>/audio/transcriptions`，结果无 speaker 字段。
  - HTTP 401/429/5xx → `AudioTranscriptionPortError`，code 分别 `permission_denied` / `timeout`(含 retry-after 语义) / `transcription_failed`；**错误消息不含 apiKey**。
  - mime 非 wav → `audio_unsupported_mime`。

- [ ] **Step 2: 运行确认失败** — `pnpm --dir apps/zcode-cli test -- packages/adapters/tests/audio-cloud-transcription.test.ts`。

- [ ] **Step 3: 实现** — 网络经 `HttpClientPort`（AGENTS.md 统一请求入口）；word→segment 聚段算法：连续相同 `speaker` 的 words 合并为一段，段边界即 speaker 变化点。文件 ≤400 行，超限拆 `deepgram.ts` / `openai-compat.ts`。

- [ ] **Step 4: 通过后提交** `feat: cloud speech-to-text adapter with diarization`。

---

### Task 4: ffmpeg 设备采集 segmenter + 设备枚举

**Files:**
- Create: `packages/adapters/src/live-capture/device-argv.ts`（纯函数）
- Create: `packages/adapters/src/live-capture/device-enumerate.ts`
- Create: `packages/adapters/src/live-capture/node-device.ts`
- Create: `packages/adapters/src/live-capture/index.ts`
- Test: `packages/adapters/tests/live-capture-device.test.ts`

**Interfaces:**
- Consumes: `ExecutionPort`（`run({ command: { mode: "argv", file, args }, timeoutMs })` 与 `start`/`cancelBackgroundTask`/`getBackgroundTask`，签名照抄 `video/ffmpeg-rtsp.ts` 用法）；`probeFfmpegAvailable`（`video/ffmpeg-frames.ts` 已导出，直接复用）。
- Produces（Task 13 的 `deviceSegmenterFactory` 依赖）:

```ts
export type DeviceCaptureSource = "mic" | "camera";
export interface FfmpegDeviceSegmenterStartRequest {
  source: DeviceCaptureSource;
  outDir: string;              // segment 输出目录
  segmentSeconds: number;      // 默认 25
  device?: string;             // 平台设备名/索引；缺省系统默认
  platform?: NodeJS.Platform;  // 测试注入，默认 process.platform
}
export interface FfmpegDeviceSegmenter {
  start(request: FfmpegDeviceSegmenterStartRequest, options?: { signal?: AbortSignal }): Promise<void>;
  watchClosedSegments(signal: AbortSignal): AsyncIterable<{ seq: number; path: string }>;
  readSegment(path: string): Promise<Uint8Array>;
  stop(): Promise<void>;
}
export function createFfmpegDeviceSegmenter(options: {
  executionPort: ExecutionPort; ffmpegPath?: string; pollIntervalMs?: number;
}): FfmpegDeviceSegmenter;
export function buildDeviceCaptureArgv(platform: NodeJS.Platform, source: DeviceCaptureSource, req: { outDir: string; segmentSeconds: number; device?: string }): string[];
export async function enumerateMediaDevices(executionPort: ExecutionPort, ffmpegPath?: string): Promise<{ audio: DeviceInfo[]; video: DeviceInfo[] }>;
export interface DeviceInfo { id: string; name: string }
```

- [ ] **Step 1: 写失败测试**：
  - **argv 纯函数表**（不真开设备）：darwin mic → `["-f","avfoundation","-i",":<device>","-ar","16000","-ac","1","-c:a","pcm_s16le","-f","segment","-segment_format","wav","-segment_time","25","-reset_timestamps","1",<outDir>/audio%05d.wav]`；darwin camera → `-i "<device>:0"`（仅视频）、`-c:v libvpx -b:v 1M -f segment -segment_format webm`、输出 `video%05d.webm`；win32 → `-f dshow -i audio="<device>"` / `video="<device>"`（设备名含空格与中文原样直传）；linux mic → `-f pulse`、camera → `-f v4l2 -i <device>`。
  - **枚举解析**：darwin stderr 混入噪声行与法文设备名 `"FaceTime HD Camera (04ab)"` → 解析出正确 id/name；解析失败 → 返回空数组不抛错（不阻塞默认设备）。
  - **真 ffmpeg**（`requireFfmpegOrSkip()` 先例，缺席跳过）：`start` → `watchClosedSegments` 收到 seq 0 → `stop` 尾段写出。
  - closed-segment 判定与 `RtspSegmenter` 一致（seg(seq+1) 存在或进程结束）。

- [ ] **Step 2: 确认失败** — `pnpm --dir apps/zcode-cli test -- packages/adapters/tests/live-capture-device.test.ts`。

- [ ] **Step 3: 实现** — `node-device.ts` 结构照抄 `ffmpeg-rtsp.ts`（spawn 经 `executionPort.start`、poll 循环、`readSegment` 用 fs.readFile、stop 先 SIGINT 后强杀）；probe 失败 → `LiveCapturePortError("live_capture_failed")`；平台不支持 → `LiveCapturePortError("live_capture_unsupported_source")`。TCC 拒绝检测：ffmpeg stderr 含 `"Permission denied"`/`"not authorized"`（darwin）→ `LiveCapturePortError("live_capture_denied")`，消息含系统设置引导文案。

- [ ] **Step 4: 通过 + typecheck/lint 后提交** `feat: ffmpeg device capture segmenter for mic and camera`。

---

### Task 5: 规则求值器（core，纯函数）

**Files:**
- Create: `packages/core/src/runtime/interview/monitor-rules.ts`
- Test: `packages/core/tests/interview-monitor-rules.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `MonitorRule` / `MonitorAlert`。
- Produces（Task 7 消费）:

```ts
export interface MonitorRuleEvalInput {
  text: string;                 // 本次新增 transcript 文本段
  interviewId: string; source: MonitorAlertSource;
  chunkSeq: number; timeMs: number;   // timeMs = interview t0 起
  speakerRole?: string; speakerLabel?: string;
}
export function evaluateMonitorRules(rules: readonly MonitorRule[], input: MonitorRuleEvalInput): MonitorAlert[];
```

- [ ] **Step 1: 写失败测试**：命中产出 alert（excerpt ≤200 且含命中词上下文）；大小写不敏感（"Price" 命中 `keywords:["价格","price"]`）；`speakers:["对方"]` 按角色过滤、映射未固化时按原始标签命中；同 `(ruleId, chunkSeq, keyword)` 跨规则同段只出一次；**同 keyword 在不同 chunkSeq 各告警一次**（跨 chunk 不去重）；禁用规则跳过。

- [ ] **Step 2–4: 红→实现→绿** — 字面匹配（`text.toLowerCase().includes(kw.toLowerCase())`），excerpt 取命中位置前后各 100 字符。

- [ ] **Step 5: 提交** `feat: monitor rule evaluator for interview keywords`。

---

### Task 6: 告警 JSONL store（core）

**Files:**
- Create: `packages/core/src/runtime/interview/alert-store.ts`
- Test: `packages/core/tests/interview-alert-store.test.ts`

**Interfaces:**
- Produces（Task 7 消费）:

```ts
export const monitorAlertRowSchema = z.object({
  v: z.literal(1), ts: z.number(), interviewId: z.string(),
  ruleId: z.string(), type: z.literal("transcript-keyword"),
  source: z.enum(["mic", "camera", "network-stream"]),
  matchedKeyword: z.string().max(200), chunkSeq: z.number(), timeMs: z.number(),
  excerpt: z.string().max(200), severity: z.enum(["info", "low", "medium", "high"]).optional(),
});
export interface MonitorAlertStore {
  append(input: MonitorAlert): Promise<{ row: z.infer<typeof monitorAlertRowSchema> }>;
  query(q?: { since?: number; limit?: number }): Promise<z.infer<typeof monitorAlertRowSchema>[]>;
  pruneExpired(now: number): Promise<number>;
}
export function createMonitorAlertStore(options: { alertStoreDir: string; interviewId: string; clock?: () => number; logger?: ServiceLogger }): MonitorAlertStore;
```

- [ ] **Step 1: 写失败测试**：append 写 `<alertStoreDir>/<interviewId>.jsonl` 且每行过 zod；坏行跳过不抛（照抄 stream alert-store 容错）；query `since` 过滤 + limit；`pruneExpired` 清 30 天前行（`STREAM_ALERT_RETENTION_DAYS = 30` 同值常量）；append 无去重（去重是 Task 5/7 的职责）。

- [ ] **Step 2–4: 红→实现→绿** — 结构照抄 `core/src/runtime/stream-monitor/alert-store.ts`。

- [ ] **Step 5: 提交** `feat: interview alert jsonl store`。

---

### Task 7: interview session（mic 转写管线 + 状态）

**Files:**
- Create: `packages/core/src/runtime/interview/interview-state.ts`
- Create: `packages/core/src/runtime/interview/interview-session.ts`（本任务只实现 mic 侧；camera 在 Task 8）
- Modify: `packages/core/src/index.ts`（barrel 追加 interview 导出）
- Test: `packages/core/tests/interview-session-transcript.test.ts`

**Interfaces:**
- Consumes: `StreamMonitorCapture`（`core/src/runtime/stream-monitor/monitor-loop.ts` 已导出的接口，形状见下）、Task 1/5/6 产物、`WorkspaceResourceIndexPort`（`upsert`/`addVariant`/`getById`）、`ToolArtifactStorePort.writeToolResultBinaryArtifact`、`AudioTranscriptionPort`。
- Produces:

```ts
export interface InterviewInfo { id: string; title?: string; t0: number; sources: { mic: boolean; camera: boolean } }
export interface InterviewSessionDeps {
  interview: InterviewInfo;
  micCapture?: StreamMonitorCapture;    // { start, watchClosedSegments, readSegment, stop }
  cameraCapture?: StreamMonitorCapture; // Task 8 消费
  transcriptionPort?: AudioTranscriptionPort;
  rules: MonitorRule[];
  alertStore: MonitorAlertStore;
  workspaceResourceIndexPort: WorkspaceResourceIndexPort;
  artifactStore?: ToolArtifactStorePort;
  stateDir: string;
  runDigestTurn?(req: { prompt: string; imageDataUrls: string[]; signal?: AbortSignal }): Promise<string>; // Task 9
  emitEvent?(event: { type: SessionEventType; payload: unknown; traceId: string }): void;                  // Task 11
  onAlert?(alert: MonitorAlert): void;
  logger?: ServiceLogger; clock?: () => number;
}
export interface InterviewSession {
  run(signal: AbortSignal): Promise<{ stoppedReason: "aborted" | "stream_down" | "completed" }>;
  getTranscriptText(): string;        // 已追加 transcript 原文（Task 10/12 消费）
  getRules(): readonly MonitorRule[]; setRules(rules: readonly MonitorRule[]): void;
}
export function createInterviewSession(deps: InterviewSessionDeps): InterviewSession;
export function interviewTranscriptEntryId(interviewId: string): string; // `capture-<id>-transcript`
export function interviewAudioEntryId(interviewId: string, seq: number): string; // `capture-<id>-audio-<seq 六位补零>`（对齐 streamEntryId 先例）
```

- [ ] **Step 1: 写失败测试**（fake capture/port，风格照抄 `core/tests/stream-monitor-loop.test.ts`）：
  - **正常链路**：mic capture 吐 2 个关段 → 每段：artifact 写入 → `upsert` audio entry（`kind:"audio"`、`sourceOrigin:"recording"`、`meta.captureOwned === true`）→ transcribe（`diarize: true`，audioRef 为 artifact uri）→ transcript variant 追加（`addVariant`，entry kind `"transcript"`，variant kind `"transcript"`，文本含 `[mm:ss] [Speaker 1]` 前缀，timeMs = `chunk.startedAt - t0`）→ 规则求值 → 命中时 JSONL append + `emitEvent`（type `MonitorAlertRaised`，先 JSONL 后事件，断言顺序）+ `onAlert` → state 游标推进。
  - **重跑幂等**：同 seq 再处理 → `addVariant` 覆盖同 entry，transcript 不重复追加（确定性 entry id）。
  - **转写失败**：该段 transcript 写占位 `[mm:ss] [transcription failed]`，后续段继续。
  - **规则在 transcript 追加时求值**（非关段时）：transcribe 慢于关段不漏报。
  - **流断终止**：`micCapture.watchClosedSegments` 抛错 → `stoppedReason: "stream_down"`。

- [ ] **Step 2: 确认失败** — `pnpm --dir apps/zcode-cli test -- packages/core/tests/interview-session-transcript.test.ts`。

- [ ] **Step 3: 实现** — `interview-state.ts` 照抄 `watch-state.ts`（tmp+rename 原子写、损坏重置；state 形状 `{ interviewId; lastProcessedMicSeq; lastProcessedCameraSeq; lastDigestedMicSeq; updatedAt }`）。循环结构照抄 `monitor-loop.ts`：单信号驱动、逐段顺序固定（spec「所有者与事件顺序」）、`Promise.race([chunk 流, signal abort])`。transcript 文本先读现有 variant（`getById`）再拼接写回。`interview-session.ts` 超 400 行时拆 `transcript-pipeline.ts`。

- [ ] **Step 4: 通过后提交** `feat: interview session transcript pipeline`。

---

### Task 8: interview session（camera 抽帧管线 + 单路失败终止）

**Files:**
- Modify: `packages/core/src/runtime/interview/interview-session.ts`
- Test: `packages/core/tests/interview-session-frames.test.ts`

**Interfaces:**
- Consumes: `VideoFramePort.extractFrames({ videoRef, mime, timesMs })` → `{ frames: VideoFrame[] }`（`VideoFrame { timeMs; imageDataUrl; width; height }`）；`ImageProcessorPort.prepareForModel`（签名照抄 `stream-monitor/segment-pipeline.ts` 用法：预算 5MiB base64/单帧、40MiB 聚合，剥离即丢弃）。

- [ ] **Step 1: 写失败测试**：
  - camera 关段 → artifact（`contentType:"video/webm"`）→ `upsert` entry `capture-<id>-video-<seq>`（kind `"video"`、captureOwned）→ `extractFrames` timesMs 为段内均匀 3 帧（`framesPerChunk` 常量，避开首尾 5%）→ 预算处理 → `upsert` entry `capture-<id>-frames-<seq>`（kind `"frame"`，variant mime `"image/jpeg"`，`variant.meta.frames = [{ timeMs, artifactUri, width, height }]` 逐帧 artifact）。
  - **时间轴对齐**：camera `timeMs` 同样 = `chunk.startedAt - t0`（与 transcript 同源）。
  - **单帧 >5MiB 剥离**、**聚合 >40MiB 截断**（fake imageProcessor 计数）。
  - **单路失败整场终止**：camera capture 抛错 → 另一路 stop 被调用、`stoppedReason: "stream_down"`、已处理段资源完整（entry 可查）。
  - 帧不产生规则求值、不产生 transcript 写入。

- [ ] **Step 2–4: 红→实现→绿** — mic/camera 两个子循环 `Promise.any`-ish 并行（各自 `run`，任一 stream_down 触发共同终止）；帧 timesMs 计算：`startOffset + i * span / framesPerChunk`，`FRAME_HEAD_TAIL_TRIM_RATIO = 0.05`。

- [ ] **Step 5: 提交** `feat: interview camera frame sampling pipeline`。

---

### Task 9: digest 消化与角色映射（core）

**Files:**
- Create: `packages/core/src/runtime/interview/digest.ts`
- Modify: `packages/core/src/runtime/interview/interview-session.ts`（暴露 `digestPending(): Promise<void>`）
- Test: `packages/core/tests/interview-digest.test.ts`

**Interfaces:**
- Produces:

```ts
export const DIGEST_WINDOW_MS = 600_000;
export interface DigestNote { startMs: number; endMs: number; highlights: string[]; expressionObservations: string[]; }
export function buildDigestPrompt(input: { startMs: number; endMs: number; transcriptText: string; priorNotesSummary: string; fixedSpeakerMap: Record<string, string> }): string;
export function parseDigestResponse(response: string, input: { startMs: number; endMs: number }): DigestNote;  // JSON 解析失败 → 仅 highlights 含原文截断的降级笔记
export function loadSpeakerMap(stateDir: string, interviewId: string): Promise<Record<string, string>>;
export function saveSpeakerMap(stateDir: string, interviewId: string, map: Record<string, string>): Promise<void>;  // tmp+rename
```

- [ ] **Step 1: 写失败测试**：transcript 按 10 分钟窗口切分；`digestPending()` 调 `runDigestTurn` 并把笔记以 `addVariant` 追加到 entry `capture-<id>-notes`（kind `"transcript"`、variant kind `"transcript"`、meta `noteStartMs/noteEndMs`）；**speaker map 固化**：响应含 `speakerMap` 时 `saveSpeakerMap` 且后续 prompt 的 `fixedSpeakerMap` 使用它；用户显式 map（`setSpeakerMap`）覆盖推断；cursor（`lastDigestedMicSeq`）推进后重跑不重复消化；主模型返回垃圾时降级笔记不抛错。

- [ ] **Step 2–4: 红→实现→绿**。digest 窗口超出单 turn 上下文时按窗口逐个调 `runDigestTurn`（顺序，非并行）。

- [ ] **Step 5: 提交** `feat: lazy digest notes and speaker role mapping`。

---

### Task 10: 提问上下文注入（core）

**Files:**
- Create: `packages/core/src/runtime/interview/prompt-injection.ts`
- Modify: `packages/core/src/runtime/helpers/conversation.ts`（注入点：**先读该文件**找到最新 user message 物化处）
- Test: `packages/core/tests/interview-prompt-injection.test.ts`

**Interfaces:**
- Produces:

```ts
export const CAPTURE_CONTEXT_BOUNDARY = "<interview-context>";
export function buildCaptureContextBlock(input: { interviewTitle?: string; notesText: string; undigestedTranscript: string; }): string;
// 返回 `${CAPTURE_CONTEXT_BOUNDARY}\n…notes…\n…undigested…\n</interview-context>`；
// undigestedTranscript 为空时省略该小节；notes 为空且无未消化段时返回 ""（不注入）。
```

- [ ] **Step 1: 写失败测试**：块含边界标记与两小节；无内容返回空串；**帧永不出现**在块内。集成测试：fake runtime 挂 active interview session → `sendInput` 产出的模型消息 user 内容含边界块；interview 无 active → 不含。

- [ ] **Step 2–4: 红→实现→绿**。注入点规则：interview active 且本 session 的每条 prompt；注入内容 = 全部笔记（压缩态）+ cursor 后未消化 transcript（超预算最旧优先进笔记——调 `digestPending()` 后重取）。

- [ ] **Step 5: 提交** `feat: inject live interview context into prompts`。

---

### Task 11: MonitorAlertRaised 事件全链路

**Files:**
- Modify: `packages/contracts/src/events/session.events.ts`（枚举 + payload + union）
- Modify: `packages/bootstrap/src/zcode-protocol-v4/cold-event-merge.ts`（`MEMORY_ONLY_EVENT_TYPES` 与 `LIVE_ONLY_EVENT_TYPES` 各加 `SessionEventType.MonitorAlertRaised`）
- Modify: `packages/bootstrap/src/zcode-protocol-v4/product-projection.ts`（新 case → op `capture.alertRaised`，payload 原样透传）
- Modify: `packages/tui/src/app-events.ts`（`applySessionEventToState` 新 case：notice 行，格式 `[mm:ss] ⚡ <命中词> <摘录≤80字>`，**摘录不得进 reducer 状态以外的日志**）
- Test: `packages/contracts/tests/event-reducer.test.ts`（追加 case）、`packages/bootstrap/tests/monitor-alert-projection.test.ts`（新建）

**Interfaces:**
- Produces: `SessionEventType.MonitorAlertRaised = "monitor_alert_raised"`；`MonitorAlertRaisedPayload = { interviewId: string; ruleId: string; type: "transcript-keyword"; source: "mic" | "camera" | "network-stream"; matchedKeyword: string; chunkSeq: number; timeMs: number; excerpt: string }`。发射方（Task 7）以 `sequenceNumber: 0` 构造（live-only 先例：`PluginUiResourceUpdated`）。

- [ ] **Step 1: 写失败测试**：contracts——枚举与 payload union 成员存在、reducer 忽略不崩；bootstrap——`ingest` 一个 `MonitorAlertRaised`（seq 0）→ 投影产出 `capture.alertRaised` op；cold hydration 不产出该事件（LIVE_ONLY）；TUI——`applySessionEventToState` 收到该事件产生 notice 文本、未知事件仍静默忽略。

- [ ] **Step 2–4: 红→实现→绿**（三处修改按测试各自驱动）。

- [ ] **Step 5: 提交** `feat: monitor alert raised live session event`。

---

### Task 12: CaptureFrames 工具（agent 帧回查）

> 前置：按 AGENTS.md 先阅读 `docs/design/v2/tool/00-tool-change-chain.md`，本任务落地时同步更新该文档的链路登记。

**Files:**
- Create: `packages/contracts/src/tools/capture-frames.ts`
- Create: `packages/core/src/tool/handlers/capture-frames.ts`
- Modify: `packages/core/src/tool/handlers/index.ts`（`builtInTools` 追加 + `registerBuiltInTools` 选项 `includeCaptureTools?: boolean` 门控）
- Modify: `packages/core/src/runtime/helpers/runtime-tools.ts`（从 deps 读门控）
- Modify: `packages/core/src/runtime/types.ts`（`AgentRuntimeDeps.interviewFrameLookup?: InterviewFrameLookup`）
- Modify: `docs/design/v2/tool/00-tool-change-chain.md`
- Test: `packages/core/tests/capture-frames-tool.test.ts`

**Interfaces:**
- Consumes: `VideoFrame`（contracts）；runtime 注入的查询函数。
- Produces:

```ts
// contracts/src/tools/capture-frames.ts
export const CaptureFramesInputSchema = z.object({
  interviewId: z.string().min(1),
  sinceMs: z.number().int().nonnegative().optional(),
  untilMs: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(12).default(6),
});
export type CaptureFramesInput = z.infer<typeof CaptureFramesInputSchema>;
export const CaptureFramesOutputSchema = z.object({
  interviewId: z.string(),
  frames: z.array(z.object({ timeMs: z.number(), imageDataUrl: z.string(), width: z.number(), height: z.number() })),
});
export const CaptureFramesErrorCode = ["capture_not_found", "capture_inactive", ...共享错误码] as const;

// core/src/runtime/types.ts
export interface InterviewFrameLookup {
  (req: { interviewId: string; sinceMs?: number; untilMs?: number; limit: number }):
    Promise<{ interviewId: string; frames: { timeMs: number; imageDataUrl: string; width: number; height: number }[] }>;
}
```

- [ ] **Step 1: 写失败测试**：schema 校验（limit 缺省 6、超 12 拒）；ToolEntry 断言 `readOnly: true, needsApproval: false, sideEffectScope: "none", riskLevel: "low", concurrentSafe: true, timeoutMs: 15_000`；handler 调 `interviewFrameLookup` 且按 `timeMs` 升序返回；lookup 未注入 → `capture_inactive` 错误结果（不抛）；`includeCaptureTools: false` 时 `registerBuiltInTools` 不注册。

- [ ] **Step 2–4: 红→实现→绿**。ToolEntry 结构照抄 `handlers/glob.ts`（含 `permission` 块）。interview session（Task 8 完成后）在 runtime 内实现 `interviewFrameLookup`：查 `capture-<id>-frames-<seq>` entries（内存索引 + resource index 兜底）。

- [ ] **Step 5: 提交** `feat: CaptureFrames tool for interview frame lookup`（含 00-tool-change-chain 更新）。

---

### Task 13: runtime interview 方法 + 端口装配

**Files:**
- Modify: `packages/core/src/runtime/types.ts`（Deps 加 `transcriptionPort?: AudioTranscriptionPort`、`deviceSegmenterFactory?: (req: { source: DeviceCaptureSource; outDir: string; segmentSeconds: number; device?: string }) => DeviceSegmenterCap`）
- Create: `packages/core/src/runtime/methods/interview.ts`
- Modify: `packages/core/src/runtime/internal-methods.ts` + `agent-runtime.ts`（方法挂载与 deps 存储）
- Modify: `packages/bootstrap/src/app/port-wiring.ts`（`transcriptionPort`：`loadTranscriptionConfig()` 成功才创建 adapter，缺文件置 undefined 并 logger.info 一次）
- Test: `packages/core/tests/runtime-interview-methods.test.ts`、`packages/bootstrap/tests/interview-port-wiring.test.ts`

**Interfaces:**
- Produces（Task 14 的 `CommandCenterApp` 能力消费）:

```ts
// runtime 公开方法（this 绑定风格照抄 methods/config.ts）
startInterviewSession(options: { mic?: boolean; camera?: boolean; title?: string; rules?: MonitorRule[]; audioDevice?: string; videoDevice?: string }): Promise<{ interviewId: string }>;
stopInterviewSession(options?: { summary?: boolean }): Promise<{ interviewId: string }>;
getInterviewStatus(): Promise<InterviewStatus | null>;  // { interview; micSeq; cameraSeq; digestSeq; rules; transcriptionQueueDepth; speakerMap }
addInterviewRule(rule: MonitorRule): Promise<void>; removeInterviewRule(ruleId: string): Promise<void>;
mapInterviewSpeaker(label: string, role: "你" | "对方"): Promise<void>;
listInterviewAlerts(options?: { since?: number }): Promise<MonitorAlertRow[]>;
```

- [ ] **Step 1: 写失败测试**：core——`startInterviewSession` 校验 `mic/camera` 至少一路（否则参数错误）；经 `deviceSegmenterFactory` 建 capture、`runDigestTurn` 注入（懒 digest 闭包）、装 interview state/alertStore 目录（`<cliStorageRoot>/interview-cache/<interviewId>/`）；缺 `transcriptionPort` 且要 mic → 抛 `transcription not configured`（消息不含路径细节之外的任何凭据）；stop → flush + commit + summary（`summary: true` 时调一次 `runDigestTurn` + 追加总结 turn——经 `emitEvent` 之外的正常 `sendInput` 路径由 bootstrap 注入的 `requestSummaryTurn` 依赖承担：Deps 加 `requestSummaryTurn?: (req: { interviewId: string }) => Promise<void>`）。bootstrap——temp home 写 `transcription.json` 后 wiring 产出 adapter；无文件时 `transcriptionPort === undefined`。

- [ ] **Step 2–4: 红→实现→绿**。interview 会话内状态（当前 session、rules）归 runtime（单一所有者）；session 结束未 stop → 自动按 stop（无 summary）处理。

- [ ] **Step 5: 提交** `feat: runtime interview session methods and port wiring`。

---

### Task 14: /capture 命令族 + facade + help

**Files:**
- Modify: `packages/cli/src/command-center/slash-command-types.ts`（union 加 `capture` 成员）
- Modify: `packages/cli/src/command-center/slash-commands.ts`（`rawName === "capture"` 分支）
- Create: `packages/cli/src/command-center/handlers/capture.ts`
- Modify: `packages/cli/src/command-center/create.ts`（dispatch 分支）
- Modify: `packages/cli/src/command-center/types.ts`（`CommandCenterApp` 可选能力：`startInterview?` / `stopInterview?` / `getInterviewStatus?` / `addInterviewRule?` / `removeInterviewRule?` / `mapInterviewSpeaker?` / `listInterviewAlerts?` / `listMediaDevices?`）
- Modify: `packages/bootstrap/src/app/types.ts` + `packages/bootstrap/src/app/session-facade.ts`（实现转发 runtime 方法；`listMediaDevices` 经 `deviceSegmenterFactory` 所在 adapter 的 `enumerateMediaDevices`——由 port-wiring 一并注入 `mediaDeviceEnumerator?`）
- Modify: **repo 根** `packages/shared/src/zcode-slash-command-help.ts`（`name: "capture"` 帮助条目）
- Test: `packages/cli/tests/command-center-capture.test.ts`（若 cli 包现有命令测试在别处，跟随其位置与风格）

**Interfaces:**
- Consumes: Task 13 的 runtime 方法（经 facade）。
- Produces: `handleCaptureCommand(args: string, deps: CommandCenterDeps): Promise<TuiSubmitPromptResult>`。

- [ ] **Step 1: 写失败测试**：子命令分发 `start/status/rule/speaker/devices/stop/events`；`start` 无 `--mic` 无 `--camera` → response 含参数错误提示；能力缺失（老 app 无 `startInterview`）→ `"capture is not available in this client."`（照抄 mcp handler 模式）；`status` 渲染两路进度/cursor/队列深度/规则/角色映射；help 条目出现在 `SLASH_COMMAND_HELP_ENTRIES`。

- [ ] **Step 2–4: 红→实现→绿**。handler 输出全部走 `response` 字符串（TUI 直接打印）；`events` 复用 Task 6 `query` 的格式化。

- [ ] **Step 5: 提交** `feat: /capture slash command family`。

---

### Task 15: resource policy capture 节 + E2E 实机验证

**Files:**
- Modify: resource-policy 解析器（**先定位**：`grep -rn "resource-policy\|policyTag" packages/adapters/src packages/core/src`，找到 `resource-policy.yaml` 的 zod/parser，追加 `policy.capture`：`{ framesPerChunk: int 1..8 default 3; chunkDurationMs: int 10_000..60_000 default 25_000 }`）
- Modify: Task 7/8 的帧数与段长常量改为读 policy（缺省值不变）
- Modify: `docs/design/v2/live-interview.md`（末尾「Windows/Linux 实机验证结果 / 剩余风险」小节）
- Test: policy 解析测试（追加到该 parser 既有测试文件）

**Steps:**

- [ ] **Step 1:** policy 解析失败/缺省回退默认值（失败测试→实现→通过）。
- [ ] **Step 2:** macOS 实机验证清单（人工，逐项记录到 spec 末尾）：`/capture start --mic --camera` 授权弹窗 → 说话 → `/capture status` transcript 增长 → 说含关键词句子 → notice 出现 → 提问"他刚才说了什么" → `/capture stop --summary` 总结产出。无法自动化 TCC 授权，此步为人工验收。
- [ ] **Step 3:** 全量验证：`pnpm --dir apps/zcode-cli typecheck && pnpm --dir apps/zcode-cli lint && pnpm --dir apps/zcode-cli test`，如实报告结果。
- [ ] **Step 4: 提交** `feat: capture resource policy and e2e verification records`。

---

## Self-Review 结论

- **Spec 覆盖**：目标 1–7 ↔ Task 4（采集）/3（转写+diarization）/7（分块转写+持久化）/8（抽帧）/5·6·11（规则+预警+事件）/9（消化+映射）/10（提问）/13·14（stop 总结+命令面）/15（policy+验收）。修订 stream-input.md 的两处为文档声明，随 Task 15 的 spec 末尾更新一并落（Task 15 已含）。
- **类型一致性**：`interviewId` 贯穿 Task 1/5/6/7/11/12/13；`MonitorAlert`（含 `chunkSeq`）是 Task 5→6→7→11 的唯一告警形态；`DeviceSegmenterCap` 与 Task 4 `FfmpegDeviceSegmenter` 结构一致（start/watchClosedSegments/readSegment/stop）。
- **Review Focus**：5 条已分别钉进 Task 4/5/2+3/8/10 的测试。
- **比例**：计划以签名+断言为主，无实现体转写。
