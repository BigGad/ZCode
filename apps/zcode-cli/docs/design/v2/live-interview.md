# Live Interview（本地麦克风 + 摄像头实时访谈记录）

## 背景

`stream-input.md` 已定义 live capture 通路与 RTSP Continuous watch mode，但有两个缺口：

- **采集 adapter 只规划了 Electron / browser**（`MediaDevices` / `MediaRecorder`），纯 CLI（Node 进程）没有系统级摄像头/麦克风入口。
- **watch mode 的分析是"每 segment 一个 model 判定 turn"**，面向异常告警；访谈场景需要的是"边录边转写、随时提问、结束总结"，分析节奏由用户驱动，不是每段必跑模型。

典型场景：用户在 CLI 里开始一次访谈（1-2 小时），麦克风录音分块转写成持续增长的 transcript，摄像头按策略抽帧记录访谈对象表情；访谈期间用户随时提问（"他刚才这段什么态度？"），并可以**预先订阅关注事件**（如关键词命中）获得预警；访谈结束后生成总结。表情帧用于辅助决策，不是独立分析目标。

用户已确认的关键取舍：

- **边录边处理**：转写随录制推进，不等访谈结束。
- **纯被动**：agent 不主动输出分析；仅预定的规则命中时提示。
- **摄像头必要**：记录访谈对象表情，辅助总结与决策。
- **随时提问**：访谈期间用户打字提问，agent 基于"到目前为止"的内容回答。

## 当前实现状态

Status as of 2026-10-16: 本文为新建 spec，处于"设计完成、待落地"状态。相关分 spec：

- [`stream-input.md`](./stream-input.md)：LiveCapturePort 契约、per-segment commit 语义、watch mode 所有者与事件顺序、告警 JSONL。本文复用其语义并做两处显式修订（见下）。
- [`audio-input.md`](./audio-input.md)：AudioPort / AudioTranscriptionPort 契约、后台转写 worker、transcript variant 持久化。
- [`video-frames.md`](./video-frames.md)：VideoFramePort 契约、ffmpeg 抽帧 adapter（随 RTSP 监控首发）。
- [`multimodal-platform.md`](./multimodal-platform.md)：总体架构。

### 对既有 spec 的修订

1. `stream-input.md` 非目标"不在本期交付实时转写（live captioning）"修订为：**CLI 设备采集 + 分块转写**场景交付"分块转录"（每 chunk 落盘后转写、transcript 增长），仍不交付逐字实时字幕 UI（live captioning 渲染）。
2. `stream-input.md` 实施步骤 Phase 6.5 的 adapter 列表增加 Node device capture adapter（本文定义）；`LiveCaptureSource` 增加 `"mic"` / `"camera"` 的 **Node 进程可用性**（原契约已定义 source 枚举，本文只落地其 Node adapter，不改枚举）。
3. `audio-input.md` 的 `AudioTranscriptionPort` 增补可选 diarization 能力字段（请求端 `diarize?: boolean`，结果段 `speaker?: string`）；该增补为 additive，不影响无 diarization 的既有调用。

## 目标

1. **Node device capture adapter**：ffmpeg 承载本地麦克风与摄像头采集，跨平台（macOS / Windows / Linux），分块落盘（`-f segment`），复用 watch mode 的 per-segment commit 语义。
2. **分块转写**：每个音频 chunk 关段后立即交给转写 worker（`AudioTranscriptionPort`），transcript 以 resource index variant 持续追加；用户提问与总结都读同一份 transcript。
3. **表情帧采样**：每个视频 chunk 关段后抽帧（默认 2-4 帧/chunk，策略可配），帧作为 image block 进入模型输入，按时间戳与 transcript 对齐。
4. **预定事件规则（预警）**：用户在采集会话启动时（或中途）订阅规则；规则在数据落盘时由进程内 watcher 求值，命中即写告警事件并在 UI 提示（CLI/TUI notice 与协议 V4 客户端投影，见"告警的事件通路"）。**规则命中不唤醒 agent**（纯被动）。
5. **说话人分离（diarization）**：transcript 分段携带说话人标签（"Speaker 1/2"），供提问、笔记与总结区分"你 / 对方"；能力由转写 provider 决定，不支持时降级为无标签全文（见"分块转写"）。
6. **滚动消化与随时提问**：transcript 与笔记分层持久化；提问时 agent 以"已消化笔记 + 未消化 transcript 回查"作答；访谈结束（`stop`）后生成全量总结。
7. **规则模型对所有监控源通用**：规则定义与告警通路不绑定访谈场景，RTSP watch mode 的告警与未来屏幕流/传感器监控共用同一 shape（v1 规则类型只有 transcript 关键词，见"规则模型"）。

## 非目标

- 不交付逐字实时字幕 UI（live captioning 渲染）。
- 不交付本地 diarization 模型（pyannote 等本地声纹管线）；说话人分离依赖转写 provider 的能力（见"分块转写"），后续如需 provider 无关的本地分离再单独提案。
- 不交付主动式会议助理（agent 周期性主动提醒、观点冲突检测）；除预定规则命中提示外，agent 一切输出由用户输入驱动。
- 不交付视觉事件规则（表情/动作识别触发）；v1 规则求值不跑模型。摄像头帧只进入提问/总结的上下文，不参与规则求值。
- 不交付音频处理（EQ / 噪声抑制 / VAD 优化），照抄 `stream-input.md` 的 constraints 透传。
- 不交付外部告警通道（webhook / 邮件），沿用 watch mode 的 JSONL 对接面。
- 不修改 ZCode app-server `session/send` 边界；设备采集是 CLI/TUI 本地场景。

## 架构与所有者

### 组件与职责

| 组件 | 落点 | 职责 |
|---|---|---|
| `nodeDeviceCapture` adapter | `packages/adapters/src/live-capture/node-device.ts` | ffmpeg 设备采集、分块、设备枚举、权限错误归一 |
| `LiveCapturePort` | `packages/contracts/src/interfaces/live-capture.port.ts` | 契约不变；补充 Node 可用性说明 |
| interview monitor 循环 | `packages/core/src/runtime/interview-session.ts` | chunk 消费编排：转写、抽帧、规则求值、cursor 推进；**作为当前交互 session 的会话内后台任务运行**（见"进程与会话模型"） |
| 转写 adapter + worker | 复用 `audio-input.md` 定义，**本 spec 实施范围内落地** | chunk → transcript 文本（`AudioTranscriptionPort`） |
| 抽帧 | 复用 `video-frames.md` ffmpeg adapter | chunk → frames（`VideoFramePort`） |
| monitor rule watcher | `packages/core/src/runtime/monitor-rules.ts` | 规则求值（进程内、无模型）、告警事件 |
| 告警持久化 | `~/.zcode/cli/stream-events/<interviewId>.jsonl` | 与 watch mode 同一存储与格式 |
| transcript / 笔记持久化 | workspace resource index | transcript variant 追加；digest 笔记 entry |
| 命令面 | `packages/cli` command-center | `/capture` slash 命令族（会话内） |

### 进程与会话模型

- **会话内后台任务**，不是独立守护进程：`/capture start` 在当前交互 session 的 runtime 进程内启动 monitor loop（复用既有 background task 形态）。理由：跨回合事件订阅（`subscribeEvents`）、resource index 写入、提问上下文装配全部天然单进程，不需要新建 IPC/控制面；`/capture status|rule|stop` 是同一 session 的命令，直接触达 loop。
- **伞形 interview**：一次 `/capture start --mic --camera` 创建一个 interview（`interviewId = capture-<uuid>`），挂 mic / camera 两个子 capture session（各自 chunk 序号与 cursor）；transcript（mic 侧）与 frames（camera 侧）以**共享 t0**（interview 启动墙钟）归一 `timeMs`，保证时间轴对齐。
- **单路失败即终止**：任一路流断（设备丢失 / TCC 撤权 / ffmpeg 崩溃、重连耗尽）即**优雅终止本次 interview**——flush 尾段、commit 已有资源、写 `source_down` 生命周期事件并经 UI 提示；**不做自动降级续录**。是否继续（重新开一场）由用户在 UI 决定，新 interview 从新 t0 开始，旧 interview 的资源独立保留。
- **崩溃恢复**：重启后按现存 segments 重扫（cursor 幂等，同 watch mode）；interview 归属当前交互 session，session 结束而 capture 未 stop 时按 stop（无 summary）处理，资源保留。

### 所有者与事件顺序

单一所有者：interview monitor 循环归**当前交互 session 的 runtime 进程**（会话内后台任务，见"进程与会话模型"；循环本体是 core helper，与 watch mode 的 `createStreamMonitor` 同构，Desktop Host 将来接管时挂同一 helper）。

```text
用户                    runtime 进程（交互 session）      resource index        转写/抽帧 worker
 │                          │                                │                     │
 │ /capture start ─────────►│ monitor loop（后台任务）        │                     │
 │                          │   ffmpeg spawn (mic + camera)  │                     │
 │                          │   每 25s 关段 ──► segment 落盘  │                     │
 │                          │      ├─ 音频 chunk ────────────┼────────────────────►│ 转写
 │                          │      ├─ 视频 chunk ────────────┼────────────────────►│ 抽帧
 │                          │      ├─ 规则求值(transcript 命中?)                   │
 │                          │      │    └─ 命中 ► 告警 JSONL + MonitorAlertRaised   │
 │                          │      └─ transcript variant 追加 / frame variant 落盘 ◄┤
 │                          │      └─ cursor 推进 (lastProcessedSegmentSeq)        │
 │ 提问（普通 prompt）──────►│ agent turn：笔记 + 未消化 transcript 自动注入         │
 │ /capture frame <t> ─────►│ agent turn：帧回查工具取最近帧                        │
 │ notice 提示 ◄─────────────┤ （MonitorAlertRaised 事件，不唤醒 agent）             │
 │ /capture stop ──────────►│ flush 尾段 → 消化剩余 transcript → 总结 turn          │
 │                          │ commit resource entry（audio/video/transcript/notes） │
```

顺序约束（与 watch mode 相同，逐段固定）：

**关段判定 → artifact 写入 → 音频转写派发 / 视频抽帧派发 → transcript 追加 → 规则求值 → cursor 推进 → 旧 segment 清理。**

- **幂等边界**：cursor（`lastProcessedSegmentSeq`，tmp+rename 原子写）+ deterministic entry id（`capture-<sessionId>-<seq>`）。崩溃重启重扫现存 segments，转写/抽帧以 chunk 序号幂等（同 chunk 重跑覆盖同 variant，不重复追加）。
- **规则求值只读已追加的 transcript**，与转写完成顺序解耦：转写慢于关段时，规则在新 transcript 文本落盘时求值（以 transcript 追加为触发，不以关段为触发），保证关键词不因转写延迟漏报。
- **提问与消费互不阻塞**：提问 turn 读"已消化笔记 + cursor 之后的新 transcript"，不阻塞 monitor 循环；monitor 循环不写会话对话状态。

## 端口契约增补

### Node 采集形态（2026-10-16 落地修正）

`LiveCapturePort` 契约不变（面向未来 Electron / Web adapter）。Node 侧设备采集的落地形态是 **`createFfmpegDeviceSegmenter`**，与已验证的 `createFfmpegRtspSegmenter`（`packages/adapters/src/video/ffmpeg-rtsp.ts`）同接口：`start(request)` / `watchClosedSegments(signal)` / `readSegment(path)` / `stop()`。理由：interview monitor 需要 per-segment commit（watch mode 同构），LiveCapturePort 的 session-commit 语义与之冲突；设备选择（audioDevice / videoDevice）走 segmenter start 参数与 slash 命令配置，**不新增** `nodeDevice` constraints 字段。

`LiveCaptureErrorCode` 复用，补充映射：

- `live_capture_denied`：macOS TCC（终端 App 未授权麦克风/摄像头）、Windows 隐私设置关闭。错误消息引导用户到系统 Privacy 设置。
- `live_capture_failed`：设备被占用、ffmpeg 不存在、设备名无效。
- `live_capture_unsupported_source`：平台无对应输入后端。

## Node 采集 adapter（ffmpeg）

不重造 capture stack；argv 直传、无 shell（与 `ffmpeg-frames.ts` / watch mode segmenter 同一纪律：availability probe 缓存、argv 数组、mkdtemp scratch、finally 清理、typed errors）。

各平台输入后端（spec 全覆盖，**macOS 首先验证**，Windows/Linux 尽力验证并声明剩余风险）：

| 平台 | 麦克风 | 摄像头 |
|---|---|---|
| macOS | `-f avfoundation -i ":<audioIdx>"` | `-f avfoundation -i "<videoIdx>:"` |
| Windows | `-f dshow -i audio="<device>"` | `-f dshow -i video="<device>"` |
| Linux | `-f pulse -i <sink>`（退路 alsa） | `-f v4l2 -i /dev/video<N>` |

- 设备枚举：macOS `ffmpeg -f avfoundation -list_devices true -i ""` 解析 stderr；Windows `-list_devices`（dshow）；Linux 枚举 `/dev/video*` + `pactl list sources`。枚举失败不阻塞默认设备采集。
- 分块：`-f segment -segment_time 25 -reset_timestamps 1`，音频输出 `audio/wav`（转写友好），视频输出 `video/webm`（vp8/vp9，与抽帧 adapter 对齐）。
- 音频统一转 16kHz mono wav（`-ar 16000 -ac 1`），消除设备差异对转写 worker 的影响。
- 停止语义：SIGINT/`q` 优雅收尾，ffmpeg 写出最后半个 segment；进程退出后 flush 尾段再 commit。
- 环境变量：沿用 `ZCODE_STREAM_FFMPEG_PATH`（复用，不新增）；本 spec 不新增环境变量，设备选择走 CLI 参数与会话配置。

## 分块转写与 transcript 持久化

### 转写通路落地范围

**代码事实**（2026-10-16 核对）：`AudioTranscriptionPort` 仅有契约，无 adapter 实现、无 worker、provider_config 无转写配置域。本 spec 的实施范围**包含**把转写通路建起来（adapter + per-chunk 派发 + provider 配置域），`audio-input.md` 的整体 worker 架构仍是其后续阶段；两者共享 port 契约与 provider 配置，不重复建设。

**转写引擎（已确认，2026-10-16）**：**云端 STT API**，要求支持 diarization（如 Deepgram / 阿里云 / 腾讯云 STT 等，具体供应商接入时按能力与成本选定）。凭据与选型存独立受控配置 **`~/.zcode/cli/transcription.json`**（沿用 `streams.json` 先例：0600、zod 校验、显式 path 参数注入、不进 provider_config 编解码域——模型凭据域与流/转写凭据域分离是既有决策），配置 adapter 落点 `packages/adapters/src/config/transcription-config.adapter.ts`，转写 provider adapter 落点 `packages/adapters/src/audio/`（**不新建** `packages/services` 包——该包在 CLI monorepo 不存在，`audio-input.md` 的全量 worker 阶段再议包落点）。`AudioTranscriptionPort` 请求端增补 `diarize?: boolean`（结果段 `speaker?` 已在契约中）。用户已确认访谈内容可出本机。25s chunk 的转写耗时超过产 chunk 速度时，chunk 排队顺序转写，规则求值以 transcript 追加为触发不受影响；队列深度进 `capture status` 展示。

### 说话人分离

- `AudioTranscriptionPort` 增补可选能力字段（对 `audio-input.md` 的显式修订）：请求端 `diarize?: boolean`，结果段增加 `speaker?: string`（provider 原生标签，如 `"1"` / `"2"`，不做语义化改名）。
- **能力协商**：adapter 查询 provider 是否支持 diarization（转写前 probe 或 provider 能力声明）；不支持时请求端静默降级为无标签转写，transcript variant meta 记 `diarization: "unsupported"`，CLI `capture status` 如实展示。不做本地声纹分离（非目标）。
- **标签稳定性**：diarization 按 chunk 独立跑，跨 chunk 的标签可能不一致（本段 Speaker 1 在下段变 Speaker 2）。v1 **不做跨 chunk 声纹对齐**；标签一致性由消化层兜底（见下）。
- **角色映射（你 / 对方）**：标签到角色的映射由 digest 层推断——digest turn 依据内容（提问者/回答者语义）推断 `label → "你" | "对方"` 并在笔记中固化；笔记固化后，后续提问/总结/规则展示统一使用角色名。映射随会话持久化（notes variant 内），用户可通过 `zcode capture speaker map <label> 你|对方` 显式覆盖。
- **规则联动**：`transcript-keyword` 规则可选 `speakers?: string[]` 过滤（按角色名匹配，如只监控"对方"的发言）；digest 未固化映射前按原始标签匹配。
- 剩余风险：diarization 质量完全取决于 provider（短句、抢话、远场人声易错）；替代方案（双声道分别录入访谈者与对方）依赖硬件且超出本 spec，留作后续提案。

### transcript 追加与持久化

- transcript 在 resource index 以 **transcript variant 追加**（复用 `workspace-resource-index.md` 的 variant 模型）：entry id `capture-<interviewId>-transcript`，分段格式 `[mm:ss] [Speaker N] text`（无 diarization 时省略标签），新段 append 后原子写回。**所有权排他**：capture 产出的 audio entry 统一打 meta `captureOwned: true`——`audio-input.md` 将来的后台转写 worker 扫描缺 transcript 的 audio entry 时必须跳过 `captureOwned` entry（转写由 interview monitor 独家派发），避免两条写入路径争同一 variant（项目"唯一所有者"红线）。
- 转写失败：chunk 标记 `transcriptStatus: "failed"`，不阻塞后续 chunk；该段文本以占位符保留时间轴。用户可事后对失败段重跑转写（`/capture retranscribe <seq>`，尽力而为，不作为本期验收项）。
- 转写未就绪时提问：占位段如实进入上下文，agent 回答需声明该段时间轴尚缺。

## 表情帧采样

- 每个视频 chunk 关段后经 `VideoFramePort.extractFrames` 抽帧，默认均匀 3 帧（起点偏移避开头尾黑帧），走 `imageProcessorPort.prepareForModel` 预算处理（40 MiB 聚合 / 单帧 5 MiB 剥离，规则照抄 `video-frames.md`）。
- **存储形态**：现有 `WorkspaceResourceIndex.addVariant` 对 `(entry_id, kind)` 唯一（DO UPDATE），单 entry 无法承载逐 chunk 追加的帧。帧按 **chunk 一条 entry**：`capture-<interviewId>-frames-<seq>`，variant 内含该 chunk 的 ≤3 帧（`timeMs`、imageDataUrl、宽高），deterministic id 保证重跑幂等。"最近 N 帧"按 seq 倒序取最近几条 entry 装配。
- 频率与预算由 workspace `resource-policy.yaml` 扩展 `policy.capture`（`framesPerChunk` 默认 3、`chunkDurationMs` 默认 25_000、`mediaBudget` 复用既有）。
- **帧不自动进 prompt**：提问 turn 只注入文本上下文；agent 通过帧回查工具按需取最近帧（见"滚动消化"），总结 turn 注入抽样帧。帧是 image block，自动注入会持续吃媒体预算且污染无关 prompt。

## 滚动消化与随时提问

- **digest 笔记**：对 transcript 按 digest 窗口（默认 10 分钟一段）生成"阶段笔记"（时间戳区间 + 说话人角色 + 要点 + 表情观察 + 对应帧引用），以 notes variant 持久化（`capture-<interviewId>-notes`）。
- **digest turn 的执行形态**：**内部辅助 turn**——不出现在对话流，仅在 CLI 显示一行状态（"digesting 10:00–20:00 …"）；使用 session 主模型；主模型不支持图片时表情观察降级为 transcript-only 并在笔记中注明。成本计入 usage-observability，meta 标 `captureDigest`。
- **惰性消化（lazy digest）**：笔记在交互时点生成——用户提问或 stop 时，digest cursor（`lastDigestedSegmentSeq`）之前的未消化 transcript 分批生成笔记后推进 cursor。默认不后台定时跑模型（成本与"纯被动"一致）；`digestIntervalMs` 可选配置允许后台定时消化，默认关闭。用户提问需等积压消化完成后才得到回答，等待期间 CLI 显示消化进度。
- **提问 turn 的上下文注入**：capture 活跃期间，本 session 的**每条** prompt 自动注入文本上下文：全部 digest 笔记（压缩摘要态）+ cursor 之后未消化的 transcript 原文（有界，超预算时最旧优先进笔记）。理由：会话内启动访谈即声明意图，期间 prompt 默认访谈相关；预算由既有媒体/上下文预算承担。**帧不自动注入**——agent 可调用**帧回查工具**（新增 tool，走 `00-tool-change-chain.md` 链路登记）按 `interviewId + 时间区间` 取帧；总结 turn 注入抽样帧。
- **总结 turn**：stop 后强制消化剩余 transcript → 全量笔记 + 抽样帧 → 结构化总结（议题、双方立场与角色、表情观察、待办）。总结 turn 是用户驱动的对话回合（可见），与提问 turn 同权限 profile。

## 规则模型（预定事件触发预警）

对所有监控源通用的最小模型。规则是**声明式谓词**，求值发生在数据落盘点，不跑模型：

```typescript
// packages/contracts/src/interfaces/monitor-rule.ts
export type MonitorRuleType = "transcript-keyword"; // v1；后续: "frame-visual" | "silence" | ...

export interface MonitorRule {
  id: string;
  type: MonitorRuleType;
  enabled: boolean;
  /** transcript-keyword: 关键词/短语列表，大小写不敏感字面匹配；v1 不含正则（防 ReDoS 与误配） */
  keywords: string[];
  /** 可选说话人过滤：按角色名（"你" / "对方"）或原始标签匹配；缺省 = 所有说话人 */
  speakers?: string[];
  /** 命中后同一 (ruleId, chunkSeq, keyword) 不重复告警 */
  dedupeKey?: string;
}

export interface MonitorAlert {
  ruleId: string;
  type: MonitorRuleType;
  interviewId: string;     // 伞形 interview id
  source: "mic" | "camera" | "network-stream";
  matchedKeyword: string;
  timeMs: number;          // interview t0 起的时间轴位置
  excerpt: string;         // ≤200 字符摘录（本地文件，含用户内容可接受；日志不得含）
}
```

- **求值点**：transcript variant 每次追加后，watcher 对新增文本段求值。与关段解耦（转写慢不漏报，见事件顺序）。规则带 `speakers` 过滤时，按段携带的说话人标签/角色匹配。
- **告警通路（三态同存）**：
  1. 追加写 `~/.zcode/cli/stream-events/<interviewId>.jsonl`——与 watch mode **同一目录、同一保留策略**（30 天、append-only、tmp+rename 无关的追加写）；行 schema 为 interviewId 维度的独立 zod（`monitorAlertRowSchema`：stream 行 schema 以 `streamId` 为必选键，直接复用会错绑；shape 字段与 watch mode 收敛为同一 `MonitorAlert` 模型）——这是**唯一持久化记录**；
  2. 运行中的 UI 提示走**既有 session 事件链路**（见下节"告警的事件通路"），不发明新通道；
  3. **不产生 agent turn**（纯被动红线）。用户看到提示后自行提问。

### 告警的事件通路（UI 反馈）

watcher 命中后由 interview monitor 循环（唯一所有者）发出一条 `SessionEvent`：

- **事件类型**：`SessionEventType` 新增 `MonitorAlertRaised: "monitor_alert_raised"`，payload 为上述 `MonitorAlert`（strict 类型，`contracts/src/events/session.events.ts` 定义，事件枚举追加处注明 spec 来源）。
- **分发链路**（全部复用既有机制）：
  - runtime 经 `subscribeEvents`（跨回合会话事件订阅，`cli/src/runtime-event-subscriber.ts` 是两个 venue 共用的能力读取器）推给 sink；
  - **TUI**：`tui-session-event-relay` 收到后渲染 notice 行（时间戳 + 命中词 + 角色名 + 摘录），不打断用户正在输入的内容；
  - **headless**：`prompt-command.ts` 既有订阅路径打印 notice 行到 stdout；
  - **协议 V4 客户端（Desktop / Web / 手机）**：`bootstrap/src/zcode-protocol-v4/event-normalizer.ts` 将其投影为协议事件；协议侧类型同步加入 `packages/shared/src/zcode-protocol/index.ts`，严格类型 + 运行时校验（AGENTS.md 协议边界要求）。
- **投影语义**：只进 **live 投影**（v4Gateway.ingest，seq 0），**不落盘、不进冷恢复**——与 `PluginUiResourceUpdated` 同一先例。理由：告警的持久化记录在 JSONL（观测数据），不属可恢复/分叉的会话状态（watch mode 已确立该边界）；手机 `web-remote-replayable` 恢复链路因此不包含告警回放，重连后的告警历史经 `zcode capture events` / `capture status` 按需拉取。
- **事件顺序约束**：JSONL 先追加、SessionEvent 后发出（先落盘后通知，通知丢失不丢数据）；两步同在 monitor 循环内，无跨进程竞态。
- **规则来源**：`/capture start --rule <file|json>` 或启动后 `/capture rule add|remove <...>`（slash 命令，会话内）；规则随 capture 会话生命周期，不入全局配置（会话级意图）。中途增删规则从当前 cursor 起生效，不回扫历史。
- **watch mode 收敛**：RTSP watch 的异常判定 turn 是"模型求值型规则"，与本文"谓词求值型规则"并存；两者共用 `MonitorAlert` shape 与 JSONL 通路。watch mode 改造为其告警写入同 shape 属后续小改动，不阻塞本 spec。

## 权限与隐私

- 麦克风/摄像头是高敏权限：`capture start` 必须显式声明来源（默认不开任何设备，无 `--mic` / `--camera` 则报参数错误）。
- macOS TCC：终端宿主 App 未授权时 port 报 `live_capture_denied`，CLI 输出引导（系统设置 → 隐私与安全性 → 麦克风/摄像头）。
- **日志红线**：transcript、摘录、音频内容不得进入任何日志（`createServiceLogger` 全链路）；告警 JSONL 是唯一含摘录的持久化位置（用户本机）。traceId 贯穿 capture 会话与 worker 派发。
- 留存：audio/video chunk 与 transcript/notes/frames 均为 workspace resource index entry，默认随会话保留、用户手动清理（复用 resource index 既有清理面）；不做自动过期（访谈记录是用户资产）。
- 总结/提问 turn 不携带原始音频/视频，只带 transcript 文本与帧图片，与既有媒体预算一致。

## 命令面（slash commands，会话内）

capture 是交互 session 内的后台任务，命令走 command-center slash 命令族（键盘优先，符合 TUI 规范）：

```text
/capture start --mic [--camera] [--rule <file|json>]... [--name <title>]
/capture status                # 当前 interview、两路进度、cursor、转写队列深度、规则与角色映射
/capture rule add|remove|list  # 中途增删规则
/capture speaker map <label> 你|对方   # 显式覆盖说话人角色映射（缺省由 digest 推断）
/capture devices               # 枚举可用麦克风/摄像头
/capture stop [--summary]      # 停止采集；--summary 触发总结 turn（默认触发）
/capture events [--since <t>] [--json]  # 对齐 zcode stream events
```

- 访谈期间的"随时提问"就是普通 prompt：提问 turn 自动注入文本上下文（见"滚动消化"）；帧经 agent 的帧回查工具按需取。
- headless 场景：capture 依赖交互（提问、规则增删），headless 不提供 capture 入口；无头自动化场景由 RTSP watch mode 覆盖。
- CLI / TUI / Desktop bundle 装配与 `OFFICIAL_PLUGIN_DEFINITIONS` entry 沿用 `stream-input.md` Bundle 装配节（TUI/CLI defaultEnabled 与其对齐）。

## 实施步骤

> 任何 tool 面改动（capture 相关工具暴露、schema、权限）落地前，按 AGENTS.md 先阅读并更新 `docs/design/v2/tool/00-tool-change-chain.md`。

### Phase 1：契约与类型

- `monitor-rule.ts` 契约（新文件）+ barrel。
- `live-capture.port.ts` 增补 `nodeDevice` constraints 与错误映射注释。

### Phase 2：Node device capture adapter

- `packages/adapters/src/live-capture/node-device.ts`（≤400 行，超限拆 `device-enumerate.ts` / `segmenter-argv.ts`）。
- 设备枚举、availability probe、TCC 错误归一、SIGINT 收尾。

### Phase 3：interview monitor 循环

- `packages/core/src/runtime/interview-session.ts` + `monitor-rules.ts`：chunk 编排、转写/抽帧派发、transcript 追加、规则求值、cursor 幂等。

### Phase 4：digest 与提问装配

- digest cursor、笔记 variant、内部 digest turn、提问/总结 turn 上下文装配、帧回查工具（登记 `00-tool-change-chain.md`）。

### Phase 5：命令面

- `/capture` slash 命令族、notice 事件输出、bundle entry。

### Phase 6：测试

## 测试要求

必测场景：

### Node adapter（跨平台差异点逐平台断言 argv）

- macOS/Windows/Linux 各自的输入 argv 构造（纯函数化，不真开设备）。
- 设备枚举解析（含非英文设备名、stderr 噪声行）。
- ffmpeg 不存在 / 设备被占 / 权限拒绝 → 错误码归一。
- SIGINT 收尾写出尾段；强杀（SIGKILL 模拟）后重启重扫幂等。

### interview monitor

- chunk 关段 → 转写派发 → transcript 追加 → cursor 推进的顺序与幂等（同 chunk 重跑不重复追加）。
- 转写失败段占位，时间轴不断裂。
- 抽帧预算：超 5 MiB 单帧剥离、40 MiB 聚合截断。

### 说话人分离

- provider 支持 diarization：结果段带 `speaker` 标签；不支持：降级为无标签，meta 记 `diarization: "unsupported"`，不报错。
- 角色映射：digest 推断固化；`capture speaker map` 显式覆盖生效于后续展示与规则过滤。
- 跨 chunk 标签漂移：消化层按笔记固化的映射统一角色名，原始标签保留。

### 规则

- 关键词命中 → JSONL 追加 + `MonitorAlertRaised` 事件 + **不产生 agent turn**。
- 事件顺序：JSONL 先落盘、SessionEvent 后发出；通知通路失败（无订阅者）不影响 JSONL。
- V4 投影：事件只进 live 投影（seq 0），不落 session store、不进冷恢复；协议 schema 校验通过。
- 同 (ruleId, chunkSeq, keyword) 去重；中途增删规则不回扫。
- `speakers` 过滤：按角色名与原始标签均可命中；映射未固化时按原始标签匹配。
- 转写延迟晚于关段：transcript 追加时补求值，不漏报。

### 消化与提问

- lazy digest：cursor 推进、笔记 variant 内容、提问 turn 上下文构成（笔记 + 未消化原文 + 最近帧）。
- 超预算 transcript 最旧优先进笔记。
- stop --summary 生成总结 turn 且消化剩余段。

### 验证命令

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test
```

## 提交条件

每个功能级变更单独提交（契约 / adapter / monitor 循环 / digest / CLI / 测试各自成提交），每提交后跑上述验证命令。macOS 实机验证麦克风+摄像头 E2E 后方可关闭本 spec；Windows/Linux 实机验证结果以剩余风险形式记录在本文末尾。

## 开放问题

（无——转写引擎已于 2026-10-16 确认为云端 STT API，见"转写通路落地范围"。）

## 决策记录（用户确认，2026-10-16）

- 边录边处理（分块转写），随时提问，纯被动 + 预定规则预警。
- 摄像头必要：表情帧辅助决策，帧不自动进 prompt，按需回查。
- 说话人分离需要：云端 STT diarization，digest 层固化"你 / 对方"角色映射。
- 转写走云端 STT API，内容可出本机。
- 流断即终止本次 interview，不自动降级续录；是否继续由用户在 UI 决定（新开一场）。
