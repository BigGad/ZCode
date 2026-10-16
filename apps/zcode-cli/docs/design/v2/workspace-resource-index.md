# Workspace Resource Index

## 背景

`message-attachments.md` 已经定义 session-scoped 的附件持久化（`FilePart + zcode-artifact://`）。它的边界明确：服务当前 session 的 prompt expansion / provider projection / rewind / fork。

但当前架构无法回答"workspace 内之前上传过的图 / PDF / 音频 / 视频"—— 这些资源在新 session 中找不到。`FilePart` 不会跨 session 保留，artifact store 的字节虽然持久化，但每个 session 都要重新走完整的 inbound → upsert → outbound 链路才能用，且无法被新 session 引用。

本文定义一个 **workspace 维度的跨 session 持久资源库**，作为后续多模态扩展（audio / video / streaming / hardware）的统一持久基础。

## 当前实现状态

Status as of 2026-10-15: 本文为新建 spec，处于"设计完成、待落地"状态。相关分 spec：

- [`multimodal-platform.md`](./multimodal-platform.md)：总体架构。
- [`audio-input.md`](./audio-input.md) / [`video-frames.md`](./video-frames.md)：attachment resolver 触发资源库 upsert。

## 目标

1. workspace 维度持久资源库，跨 session 复用。
2. 同一 resource 同一 workspace 下：原始 + 转写后 + 缩略图等多 variant 同时保留（transform + maintainer + audit）。
3. fork / rewind reference 计数驱动 GC。
4. 跨 workspaceIdentity 隔离（key 一律为 `workspaceIdentity?.trim() || workspacePath`）。
5. 业务策略通过 `.zcode/resource-policy.yaml` 驱动。

## 非目标

- 不在本期交付远端 workspace 的同步；远端 workspace 通过现有 remote bridge alias 化请求，资源在本机副本上索引，不重复。
- 不在本期交付跨 workspaceIdentity 共享；需要共享时另写 spec。
- 不在本期重写 `FilePart`；`FilePart` 保持 session 内事实源，与 resource index 是 **相互补充** 关系。

## 资源库形态

### 索引条目

```typescript
// contracts/src/interfaces/workspace-resource-index.port.ts
export type WorkspaceResourceKind =
  | "image" | "pdf" | "audio" | "video" | "stream" | "hardware"
  | "transcript" | "frame";

export interface WorkspaceResourceVariant {
  kind: "original" | "transcript" | "frame" | "thumbnail" | "waveform";
  mime: string;
  bytes: number;
  sha256?: string;
  artifactUri?: string;        // zcode-artifact://
  path?: string;                // request-local，仅 preview / 读取
  meta?: Record<string, unknown>;
}

export interface WorkspaceResourceIndexEntry {
  id: string;                  // ULID
  workspaceIdentity: string;
  workspacePath: string;
  kind: WorkspaceResourceKind;
  title: string;
  filename?: string;
  sourceOrigin:
    | "user_upload"           // 用户主动上传 / 粘贴
    | "bot_attachment"         // bot 收到的远程附件
    | "tool_result"            // tool 产物
    | "screen_capture"         // 屏幕录制
    | "recording"              // 麦克风录制
    | "device_stream"          // 实时 capture
    | "generated_output";      // 生产端产出（语音合成等）
  addedAt: number;
  updatedAt: number;
  lastReferencedAt?: number;
  variants: WorkspaceResourceVariant[];  // 原始 + 转写后 + ...
  references: number;                       // 引用计数
  tags?: string[];                          // 用户可见标签
  meta?: {
    durationMs?: number;
    pageCount?: number;
    width?: number; height?: number;
    sampleRate?: number; channels?: number;
    policyTag?: string;            // .zcode/resource-policy.yaml 命中键
    policySource?: "explicit" | "auto-detected" | "default";
    transcriptStatus?: "pending" | "ready" | "failed";
    frameSamplingStatus?: "pending" | "ready" | "failed";
  };
}
```

### 端口契约

```typescript
export interface WorkspaceResourceIndexPort {
  upsert(entry: WorkspaceResourceIndexEntry): Promise<WorkspaceResourceIndexEntry>;
  getById(workspaceKey: string, id: string): Promise<WorkspaceResourceIndexEntry | undefined>;
  query(req: WorkspaceResourceIndexQuery): Promise<WorkspaceResourceIndexQueryResult>;
  addVariant(req: {
    workspaceKey: string; id: string; variant: WorkspaceResourceVariant;
  }): Promise<WorkspaceResourceIndexEntry>;
  incrementReferences(req: {
    workspaceKey: string; ids: string[]; delta: number;
  }): Promise<void>;
  removeIfNotOrphaned(req: {
    workspaceKey: string; ids: string[];
  }): Promise<{ removed: string[] }>;
}

export interface WorkspaceResourceIndexQuery {
  workspaceKey: string;
  kinds?: WorkspaceResourceKind[];
  tags?: string[];
  textSearch?: string;            // 命中 title / filename / tags
  limit?: number;
  cursor?: string;
}

export interface WorkspaceResourceIndexQueryResult {
  entries: WorkspaceResourceIndexEntry[];
  nextCursor?: string;
}
```

### 错误码

```typescript
export type WorkspaceResourceIndexErrorCode =
  | "resource_index_corrupt"
  | "resource_index_storage_full"
  | "resource_index_write_conflict"
  | "resource_not_found"
  | "workspace_key_invalid";

export class WorkspaceResourceIndexPortError extends Error {
  constructor(
    readonly code: WorkspaceResourceIndexErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WorkspaceResourceIndexPortError";
  }
}
```

## 持久化

### 主存文件

`<storageRoot>/cli/resources/<workspaceIdentity>.db` (SQLite)。`workspaceIdentity` 为 key 时不 trim（直接用 trim 后的值）。

> `<storageRoot>` 默认 `${HOME}/.local/share/zcode` (Linux) / `~/Library/Application Support/zcode` (macOS) / `%APPDATA%/zcode` (Windows)，由现有 storage resolver 提供。

### variant bytes

复用 `ToolArtifactStorePort`，namespace 形式：

```
<storageRoot>/cli/resources/<workspaceIdentity>/<resourceId>/<variant-kind>-<nodeOr-contentHash>
```

不另起 dedup / retry / transactional 逻辑；`ToolArtifactStorePort` 已具备这些能力。

### Schema 初始版本（v1）

```sql
CREATE TABLE resource_entries (
  id              TEXT NOT NULL,
  workspace_identity TEXT NOT NULL,
  workspace_path  TEXT NOT NULL,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  filename        TEXT,
  source_origin   TEXT NOT NULL,
  added_at        INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_referenced_at INTEGER,
  tags            TEXT,                        -- JSON-encoded string[]
  meta            TEXT,                        -- JSON-encoded object
  PRIMARY KEY (id)
);
CREATE INDEX ON entries(workspace_identity, kind);

CREATE TABLE resource_variants (
  entry_id        TEXT NOT NULL REFERENCES resource_entries(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,             -- original / transcript / frame / thumbnail / waveform
  mime            TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  sha256          TEXT,
  artifact_uri    TEXT,
  path            TEXT,
  meta            TEXT,                        -- JSON object
  PRIMARY KEY (entry_id, kind)
);

CREATE TABLE resource_references (
  entry_id        TEXT NOT NULL REFERENCES resource_entries(id) ON DELETE CASCADE,
  ref_count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id)
);
```

后续版本（v2+）通过 migration 演进；migration 表沿用现有 storage 的 migration 工具。

### 远端 workspace

远端 workspace 不直接接入 SQLite；远端资源通过现有 `RemoteWorkspaceBridge` alias 化请求，远端 attachment 实际落地为本机或远端的副本，本机副本上的 file system 路径作为 `path` variant 字段。

详细同步语义与冲突解决留待后续 remote-resource-sync spec 单独提案。本期范围**仅本机**。

## 生命周期

### 写入入口

资源库不主动"scan" workspace；只在以下入口触发 upsert：

| 触发点 | 来源 upsert | sourceOrigin |
| --- | --- | --- |
| `attachment-{image,pdf,video,file}` resolver | session 内 `resolveInlineXxxAttachment` / `resolveLocalXxxAttachment` 完成后 | `user_upload` / `tool_result` |
| `attachment-audio` resolver（Phase 3） | 同上 | `user_upload` |
| bot 附件落盘（已有） | `botsService.cacheResolvedAttachment` 完成后 | `bot_attachment` |
| AudioTranscriptionWorker 完成转写 | `addVariant({ kind: "transcript" })` | 不变 entry.sourceOrigin |
| VideoFrameWorker 完成抽帧 | `addVariant({ kind: "frame" })` | 不变 entry.sourceOrigin |
| AudioOutputSkill 完成合成 | `upsert({ kind: "audio", sourceOrigin: "generated_output" })` | `generated_output` |
| LiveCaptureWorker 完成签名 | `upsert({ kind: "stream", sourceOrigin: "device_stream" })` | `device_stream` |
| 屏幕录制 worker | `upsert({ kind: "video", sourceOrigin: "screen_capture" })` | `screen_capture` |
| 麦克风录制 worker | `upsert({ kind: "audio", sourceOrigin: "recording" })` | `recording` |

### Reference 计数

| 事件 | references 变化 |
| --- | --- |
| entry 第一次 upsert | 1 |
| file part 创建并引用 entry | +1 |
| Fork child session 继承 | +1 |
| Rewind 越过 attachment | -1 |
| session 关闭 / exit | -（属于该 session 的全部 entry）-N |
| RefCount == 0 | `removeIfNotOrphaned` 自动清理；variant bytes 同步删除 |

### GC

- 每个 session 关闭时遍历该 session 引用的 entry id 列表，统一 `incrementReferences({ ids, delta: -1 })`。
- GC tick（每 5 分钟，或 explicit 调用）：`removeIfNotOrphaned` 扫所有 `ref_count == 0` 的 entry，连同 variants + artifact bytes 删除。
- 用户主动删除 entry：显式 `removeIfNotOrphaned`（强制 references=-1 后调用），不等待 GC tick。

### 跨 session 复用

新 session 引用旧 entry：

1. UI / 输入层提供 `resource://<workspaceIdentity>/<id>` URI。
2. resolver 解析 URI → `WorkspaceResourceIndexPort.getById(workspaceKey, id)`。
3. 若找到且 variant 齐全（原始 + transcript / frame 等按 model capability 选），直接走 provider projection。
4. 若找不到或 variant 缺失 → 走 inbound path（重新解析本地路径或 inline base64）。

URI 形式稳定：

```
resource://<workspaceIdentity>/<resourceId>
resource://<workspaceIdentity>/<resourceId>?variant=transcript
resource://<workspaceIdentity>/<resourceId>?variant=frame&timeMs=10000
```

## 业务策略（`.zcode/resource-policy.yaml`）

### 位置

workspace 根目录 `/.zcode/resource-policy.yaml`，提交 git 可分享给团队。

### Schema（v1）

```yaml
version: 1
video:
  frameSampling:
    default:
      intervalSec: 10
      maxFrames: 60
      mode: uniform            # uniform | keyframes | firstlast | explicit
    byTag:
      screen-recording:      { intervalSec: 2, maxFrames: 300, mode: uniform }
      security-camera:       { intervalSec: 5, maxFrames: 200, mode: keyframes }
      lecture-recording:     { intervalSec: 30, maxFrames: 30, mode: uniform }
      product-walkthrough:   { mode: explicit, manualTimesMs: [0, 8000, 15500] }
audio:
  transcription:
    default: { engine: whisper-local, language: auto }
    byTag:
      meeting:     { engine: whisper-local, language: zh-CN }
      interview:   { engine: whisper-local, language: auto, diarize: true }
      podcast:     { engine: whisper-api,    language: en-US }
audioOutput:
  default: { voice: alloy, format: mp3 }
  byTag:
    voice-default: { voice: shimmer, format: mp3 }
```

### 优先级

1. **CLI `--policy <name>` flag** — 把 `policyTag=name` 注入 entry。
2. **Entry `meta.policyTag` 命中 `byTag`** — 命中策略；未命中转下层。
4. **`.zcode/resource-policy.yaml` 的 `default`** — 工作区共享默认值。
5. **Bundle 内置默认** — 最后 fallback。

### 错误行为

- 策略文件不存在 → 走 bundle default，不崩溃。
- 策略文件解析失败（非法 yaml / 非法 schema） → worker 报错 `policy_invalid`，不默默猜测。
- `policyTag` 不在 byTag 也无 default → 报错 `policy_not_configured`，entry 保留但不进入 worker。

### 解析器契约

```typescript
// core/src/runtime/helpers/resource-policy/parser.ts
export interface ResourcePolicy {
  version: 1;
  video?: {
    frameSampling?: {
      default?: FrameSamplingPolicy;
      byTag?: Record<string, FrameSamplingPolicy>;
    };
  };
  audio?: {
    transcription?: {
      default?: TranscriptionPolicy;
      byTag?: Record<string, TranscriptionPolicy>;
    };
  };
  audioOutput?: {
    default?: AudioOutputPolicy;
    byTag?: Record<string, AudioOutputPolicy>;
  };
}

export interface FrameSamplingPolicy {
  intervalSec?: number;
  maxFrames?: number;
  mode?: "uniform" | "keyframes" | "firstlast" | "explicit";
  manualTimesMs?: number[];
}

export interface TranscriptionPolicy {
  engine?: "whisper-local" | "whisper-api" | "auto";
  language?: string | "auto";
  diarize?: boolean;
}

export interface AudioOutputPolicy {
  voice?: string;
  format?: "mp3" | "wav" | "ogg" | "opus";
}

export function parseResourcePolicy(yamlText: string): ResourcePolicy;
export function loadResourcePolicy(
  workspaceRoot: string,
  options?: { cliOverride?: string }
): ResourcePolicy;
export function resolvePolicyForEntry(
  policy: ResourcePolicy,
  entry: WorkspaceResourceIndexEntry,
  kind: "video" | "audio" | "audioOutput",
  field: "frameSampling" | "transcription" | undefined,
): FrameSamplingPolicy | TranscriptionPolicy | AudioOutputPolicy | undefined;
```

## 与 attachment pipeline 的关系

### 现有 fact source

```
SQLite: MessageInfo + Part[]    ←── FilePart { mime, url, source, sizeBytes, sha256, ... }
```

FilePart 是 session 内的事实源，session 关闭后仍可被 resume / rewind / fork 读回。

### 新增资源库

```
SQLite: resource_entries / resource_variants / resource_references
        ↑ 在 attachment resolver 中触发 upsert
        ↑ 在 fork / rewind child reference 中传播引用
```

资源库是**workspace 维度长期的事实源**；FilePart 是 session 维度事项目源。

### 同步时序

```
用户上传 image/audio.mp3
   ↓
attachment resolver 触发
   ↓
   ├─ upsert ResourceIndex (variant="original")
   └─ 创建 FilePart (zcode-artifact://<id>) → 落 SQLite session
   ↓
session start, provider request
   ↓
attachment resolver 投影 ModelMessageContentBlock
   ├─ 命中 transcript variant  → ModelTextContentBlock (transcript)
   └─ 命中 original variant    → ModelAudioContentBlock (audio)
```

### Fork / Replay

- Fork child session 启动时，复制父 session 的 `useResourceIds`，增加 `references += 1`。
- Replay（session 重连）按 `lastReferencedAt` 重新触摸 ref。

## 错误处理

- `attach_url_invalid`：URI 解析失败时，UI 报错并提示"resource://<workspaceId>/<resourceId> 不可解析"；不进入 worker。
- `variant_missing`：命中 entry 但 variant 不存在时，触发对应的转写 / 抽帧任务（异步），期间 UI 显示 "Transcription in progress"。
- `workspace_key_invalid`：`workspaceIdentity` 与 `workspacePath` 同时为空时，端口拒绝写入。
- `resource_index_corrupt`：SQLite 文件损坏时，**不自动恢复**；记录 `error` 日志，要求用户手动删除资源库（不影响当前 session 的 FilePart，因为 FilePart 已有自己的 `zcode-artifact://`）。
- `resource_index_storage_full`：artifact store 报告存储满时，写入转写 / 抽帧失败，提示用户清理。

## 实施步骤

### Phase 2.1：spec 自审 + fixture

- 完整 spec 自审；确保无 TODO / 占位。
- 增加 test fixture：本地 SQLite，3-5 个 entry / 2-3 个 variant / reference 计数。

### Phase 2.2：port 契约

- 新文件 `packages/contracts/src/interfaces/workspace-resource-index.port.ts`，≤ 100 行。
- `export * from "./workspace-resource-index.port.js"` 到 barrel。

### Phase 2.3：Node adapter

- 新文件 `packages/adapters/src/storage/workspaceResourceIndex.ts`，实现 `WorkspaceResourceIndexPort`。
- SQLite via `better-sqlite3`；schema v1 migration；原子 upsert / variant add / reference increment。

### Phase 2.4：resource-policy parser

- 新文件 `packages/core/src/runtime/helpers/resource-policy/{parser.ts,resolver.ts}`。
- YAML via `yaml` package；优先级合并。

### Phase 2.5：attachment resolver 接入

- 在 `attachment-{image,pdf,video,file}.ts` resolver 中插入 resource index upsert 调用；触发后不返回错误（即失败也不影响当前 attachment 主线）。

### Phase 2.6：fork / rewind reference

- 在 fork 创建逻辑中加 `incrementReferences({ delta: +1 })`。
- 在 rewind 越过 attachment 时加 `incrementReferences({ delta: -1 })`。

### Phase 2.7：GC

- 加 GC tick（每 5 分钟）；扫 `ref_count == 0`，调用 `removeIfNotOrphaned`。
- session 关闭时手动触发一次 GC（仅扫当前 session 的 ids）。

## 测试要求

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test
```

必测场景：

- 同一 workspace 两次上传同一张图：entry 合并而非重复；variants 累加。
- Fork / rewind child session：references 累加正确。
- Replay / rewind 到旧 message：entry 仍可解析。
- 跨 workspaceIdentity 隔离：A workspace 的 id 在 B workspace 不可查。
- GC：最后一次引用归零后，entry 与 variants 都删除。
- 与 attachment resolver 一致性：artifactUri 不漂移；hash 不变。
- resource-policy：
  - yaml 不存在 → bundle default
  - yaml 非法 → `policy_invalid`，不默默猜测
  - CLI `--policy` 覆盖 yaml
  - byTag 命中
- entry query：按 kind 过滤、按 tag 过滤、textSearch 命中 title / filename / tags。
- 端口契约：
  - 输入 / 输出 / error code
  - cancellation / signal
  - idempotent：同 sha256 + 同 workspaceKey 多次 upsert 不重复

## 与 message-attachments.md 的关系

`message-attachments.md` 不变；resource index 是它**上面**的横向能力。两份 spec 共用：

- `ToolArtifactStorePort`（variant bytes 存储）
- `ModelMessageContentBlock` union（provider projection）
- `createServiceLogger(scope)`（observability）

新增的接口设计参数（如 `policyTag` / `transcriptStatus`）走 resource index，不污染 `FilePart`。

## Bundle 装配

本文不直接交付 bundle；resource index 是 L2 能力，被 audio / video / streaming / hardware bundle 共享。

## 提交条件

每个功能级变更单独提交：

1. 端口契约 + barrel export（commit 1）
2. Node adapter + SQLite migration（commit 2）
3. resource-policy parser + resolver（commit 3）
4. attachment resolver 接入（commit 4）
5. fork / rewind reference（commit 5）
6. GC tick（commit 6）

每提交后跑：

```text
pnpm --dir apps/zcode-cli typecheck
pnpm --dir apps/zcode-cli lint
pnpm --dir apps/zcode-cli test -- packages/core/tests/resource-index.test.ts
```