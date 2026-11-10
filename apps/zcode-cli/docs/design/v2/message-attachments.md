# 消息附件与多模态输入

## 背景

本文最初记录的缺口是：ZCode 的对外输入和 provider-visible history
基本仍是纯文本。原始问题包括：

- `ZCodeApp.submitPrompt(prompt: string)` / `sendInput(input: string)` 只接收文本。
- `AgentRuntime.executeTurn(input, attachments?)` 已有附件参数，但 bootstrap、CLI、TUI、ZCode app-server 没有传入附件。
- `ModelInputMessage.content` 是 `string`，`toAiSdkMessages()` 直接把 user/system 内容转成字符串。
- session store 已有 `FilePart`，`persistUserPrompt()` 也会把附件落成 `file` part，但 resume 时 `session-history-hydrator` 只把 file part 恢复成 `[Attached file: ...]` 文本。
- ZCode app-server spec 明确拒绝 embedded resources、images、audio，直到 runtime attachments 有稳定 schema。

## 当前实现状态

Status as of 2026-05-08: 图片输入主线已经落地，文件/资源/大媒体仍是分阶段能力。

已实现：

- `PromptInput = string | { text, attachments }` 已在 bootstrap 暴露；`submitPrompt()` 和 `sendInput()` 都会把附件传给 runtime。active turn steering 仍是文本队列，带附件输入在 active turn 时被稳定拒绝。
- CLI 支持 `--attach <path>`，按扩展名把常见图片传为 `image`，其它路径传为 `file`；TUI 图片粘贴通过 `TuiReadClipboardImage` 传入 data URL-backed `image` attachment。
- ZCode app-server `prompt` 已声明 image capability，并把 ZCode app-server `image` content block 转成 runtime `image` attachment；`text` 和 `resource_link` 仍按文本内容处理，不自动读取远程资源。
- `ModelInputMessage.content` 已扩展为 `string | ModelMessageContentBlock[]`，并有运行时 JSON schema 覆盖 `text`、`reasoning`、`image`、`file` 和 `resource_link` block。
- runtime resolver 会把 inline/local image attachment 转成 provider-neutral image block，图片进入模型前通过 `ImageProcessorPort.resizeToFit` 限制最长边 2000 像素；WebP 在 Jimp adapter 中保持原始 bytes，不做 resize/transcode。
- local text/file attachment 当前按 `text/plain` 预算读取为 text block；超限会写 preview 和 truncated fallback。非文件、超大图片、坏 data URL 或读取失败会转成稳定文本占位和 metadata，而不是把坏 payload 交给 provider。
- user message 持久化为 text part 加 file parts；file part 保存 `mime`、`url`、`source`、size/hash/preview/image/error metadata。`session-history-hydrator` 已能把可用 image file part 恢复为结构化 user image block。
- `toAiSdkMessages()` 已支持 user image block、PDF file block、`stripMedia` 占位、空/坏 data URL fallback，并按 Active Model 的 `properties.input_format.support_image` / `support_pdf` 生成模型可见错误文本。

仍未实现或只部分实现：

- 还没有独立的用户附件 artifact store；小 data URL 和解析后图片仍可内联进 file part，大媒体 snapshot、GC、fork 引用计数和缺失 artifact fallback 仍按本文后续阶段设计推进。
- TUI 占位符绑定仍靠 exact placeholder 字符串保留，不是 `TextElement` byte range。
- local file resolver 目前只覆盖文本文件和图片；PDF/SVG/目录/resource 的完整 prompt expansion、MIME sniff、artifact 化和 provider capability gate 还不是统一 resolver 能力。
- compact boundary 还没有记录附件统计、`attachmentMessageIds`、strip refs 或 context overflow 后的专门 media-strip replay。
- debug/trace 还没有完整展示附件 storageKind、projection result、降级原因和 hash 前缀。

Status update as of 2026-05-14: provider request 前的媒体预算投影已进入当前阶段。ZCode 会在真正调用模型前统计 provider-visible image/PDF data URL 字节数，优先保留最新真实用户消息里的媒体，把较旧媒体替换成可读 placeholder；如果最新用户消息本身已经超过预算，则本地抛出可恢复的 invalid input 错误，不把请求打到 provider。

Status update as of 2026-06-06: 桌面 GUI 的文件选择入口改为优先传 `localPath`，不再把普通文件序列化成 `dataBase64` 附件。ZCode app-server 会在 `session/send` 边界把 GUI 的 `kind/localPath/dataBase64/textContent` 协议附件转换成 core 的 `TurnAttachment { type, path/content }`。TUI/CLI 与 GUI 共用 core resolver：小文本仍按 `inlineTextMaxBytes = 64 KiB` 内联为 synthetic Read 结果；超过该阈值的文本、非文本普通文件和超过 `INLINE_MEDIA_ATTACHMENT_MAX_BYTES = 20 MiB` 的图片只交付本地路径引用，让模型按需使用读取工具，而不是把大文件内容塞进 prompt。

Status update as of 2026-07-31: inline/paste 图片继续把 data URL artifact 作为恢复事实，同时在
`<storageRoot>/cli/image-cache/<sessionId>/` 中 eager 物化可重建的真实图片文件；durable artifact
仍保存在 `<storageRoot>/cli/artifacts/<sessionId>/`。模型请求前按 artifact URI
singleflight ensure 该路径：支持图片时 user content 为 query、image block、
`[Image: source: <path>]`；明确不支持图片时 image block 替换为既有 omitted 文本，但保留 path。
path 是 request-local 的普通 user text，不持久化，也不进入 system reminder、runtime attachment
或 MCS。resume 缓存缺失时从 durable data URL artifact 重建；已有 local file path 时直接复用。
派生缓存只处理能够生成真实图片扩展名的 MIME；不支持的图片 MIME 继续沿原 image/base64
provider 链路发送，但不生成 cache/path，也不因此中断请求。受支持 MIME 的真实读写或 durable
artifact 故障仍在 provider 调用前明确失败，避免发送失效 path。
只有带 `zcode-artifact://` URI 的 inline 图片，以及带真实 `path` 的 local-file 图片参与上述
path 投影；其他 provider-ready inline 图片（包括缺少 URI 或 URI 为 data URL）保留原 image block，
仅继续走既有媒体能力投影，不尝试生成 path，也不因缺少 durable artifact 身份阻断模型请求。
本次路径隔离不新增定期清理或旧路径迁移语义。

Status update as of 2026-08-20: user video 与 image 共用 request-local path 投影。已有 local file path
直接复用；inline video 在模型请求前从 durable data URL artifact lazy 物化到
`<storageRoot>/cli/video-cache/<sessionId>/`。`properties.input_format.support_video=true` 时保留 video block 与
`[Video: source: <path>]`，为 `false` 时 video block 替换为既有 omitted 文本并保留 path。
video path 与 image 一样不持久化；冷恢复时从 durable artifact 重新 ensure。仅带
`zcode-artifact://` URI 的 inline video 或带真实 path 的 local-file video 参与投影，不支持的 MIME
保持原 base64/capability 链路且不生成 path。本次不新增缓存清理、迁移或其他媒体类型语义。

Status update as of 2026-08-19: video 输入已作为独立 modality 接入当前主线。CLI、V4
`AttachmentRef`、composer inline upload 与 Read 均可生成 provider-neutral video block；模型 catalog
能力与 provider wire 能力分别门控，不支持时 strip。模型能力由 Active Model 的
`properties.input_format.support_video` 表达，30MiB 输入上限是与 image 同类的 ZCode 全局产品策略，不随 catalog、session 或
turn model 配置。用户与 tool-result
video 都以 `FilePart + zcode-artifact://` 作为跨 provider/cold-resume 的 durable 事实，当前 provider
需要的 base64 只在请求期投影。core/Read 的 video 输入策略为 30MiB；V4 上传继续沿用既有 20MiB、
64 chunks 与 64MiB staging 边界，desktop continuous、mobile replayable 和 shared-host 边界不变。
Web/mobile 大视频传输不在本期范围。本文后续“第一阶段不做 video”仅描述最初阶段，不再代表当前实现状态。

Status update as of 2026-08-21: composer 与已发送 user row 的 image/video 共用媒体预览
Dialog。video 不按容器或 codec 建 UI 白名单，统一交给浏览器原生 `<video controls playsInline>`；
原生解码失败只显示“当前设备不支持预览”提示，不改变附件上传、发送、持久化和模型输入。
已发送附件读取以当前 row 稳定身份和附件序号授权；目标 FilePart 已持久化时优先解析该轮的
durable artifact。新消息尚未形成持久 message 锚点，或旧历史没有 artifact 时，才读取已授权的
原稳定 ref。因此热态、冷恢复与同一路径重复发送都不会
因源文件删除或变化而漂移。热态 original ref 与 hydrate 后 previewRef 均可证明同一 row/index
附件，但不授权其他路径；session store 按 session/message 精确读取目标 message/parts，不为一次
预览扫描或解码整段会话。单次读取失败只在 Dialog 内反馈，不永久禁用预览入口。上传与图片读取
继续沿用 V4 20MiB 总量边界。Desktop 本地会话预览已发送视频时先查询经过当前 row/index 授权的
本地播放源：durable artifact 优先复用 `cli/video-cache/<sessionId>` 派生文件；没有 artifact 的
`metadata_only/local_ref` 才使用已持久化的稳定路径。两者都通过 Desktop 专用媒体协议交给原生
`<video>`，不会把文件完整读进 gateway/renderer，因此不受 30MiB 模型输入上限约束。artifact
存在但无法物化播放路径时不得退回可变原路径，只能降级为既有分片读取。Web、手机远控与
SSH/WSL/Docker workspace 不返回远端路径，继续使用 512KiB query，并沿用 30MiB video preview
上限。关闭、切换或卸载分片预览时仍取消后续 chunk；不扩上传 staging、不新增大文件副本、
转码、PDF/audio 预览、relay 状态或独立 runtime。

Desktop 专用媒体 scheme 必须在 `app.ready` 前以 `standard + secure + stream` 注册。`standard`
使 Chromium 将其视作标准 URL 并对非 fast-start MP4 发起文件尾元数据读取；缺少该权限时，
`moov` 位于 `mdat` 之后的视频会在已发送消息中被媒体栈误判为不可解码。正式 VI06 E2E 使用
尾部 `moov` 的可播 MP4，同时验证 artifact-backed 与超过 30MiB local-ref 视频的加载和 seek。

## 设计要点

### 输入层

用户输入拆成明确 variant：

- `Text { text, text_elements }`
- `Image { image_url }`
- `LocalImage { path }`
- `Skill` / `Mention`

其中 `Image` 是 provider-ready 的 data URL 或远程 URL；`LocalImage` 只是本地路径，只有在构造 provider request 时才读取、压缩/转换成 data URL。这个区分很关键：本地路径适合 UI 编辑和本地历史重放，但不应该被当成可直接发给 provider 的稳定内容。

输入层还需要注意几个细节：

- `TextElement` 用 byte range + placeholder 绑定 UI 占位符，避免图片占位文本被编辑后附件映射错位。
- local image 进入模型前生成 `<image name=[Image #N]>`、`input_image`、`</image>` 的有序内容，给模型一个稳定标签。
- 模型能力通过 `input_modalities` 表达；TUI attach/submit 路径都会检查，禁用或警告不支持图片的模型。
- 不支持图片的历史会把 image part 归一成占位文本，而不是静默丢掉。
- SDK 第一层只支持 text + local_image，并把 text 合并成 prompt，把 local image 作为 `--image` 传给 CLI。这是简单但稳定的入口兼容策略。
- 估算上下文时会把 base64 图片 payload 替换成按 detail/尺寸估算的 token 成本，避免 raw JSON 大小误导 compact 判断。

### 持久化与 provider 投影

ZCode 当前的 session store 形态是：消息由 `MessageInfo + Part[]` 组成，附件是 `FilePart`：

```typescript
type FilePart = {
  type: "file";
  mime: string;
  filename?: string;
  url: string;
  source?: FilePartSource;
};
```

`FilePartSource` 分成 `file`、`symbol`、`resource`，并记录 placeholder 文本的 start/end/value。这比只存 `path` 更适合 resume、MCP resource、符号引用和 UI 还原。

provider transform 的规则：

- `text/plain` 和 directory file 不直接作为 file part 进模型，而是在 prompt 构造阶段转为文本或 synthetic Read 结果。
- image/PDF 这类 media 作为 file/media part 进入 AI SDK。
- `ProviderTransform.message()` 会按 `model.capabilities.input` 判断 image/audio/video/pdf 是否支持；不支持时替换成明确错误文本，要求模型告知用户。
- 空 base64 图片会被替换成 `"ERROR: Image file is empty or corrupted..."`，避免 provider 报晦涩错误。
- tool result 的媒体附件如果 provider 支持 tool-result media，就放在 tool result content；不支持时抽出来追加一条 synthetic user message：`Attached image(s) from tool result:`。
- compact/replay 时可以 `stripMedia`，把媒体替换成 `[Attached image/png: file]` 这类占位。
- TUI 对图片/PDF使用虚拟占位符 `[Image N]` / `[PDF N]`，删除占位符就删除对应 part；SVG 按文本粘贴，不当作图片 base64。

### 对 ZCode 的取舍

ZCode 采用 durable part 模型作为持久化主线，因为当前仓库已经有 `FilePart` / `FilePartSource` 形状；同时采用显式输入 variant 和本地图片延迟编码，避免入口层直接把本地路径伪装成 provider 内容。

具体取舍：

- 对外输入用 `UserPromptInput` / `UserAttachmentInput`，保留 local path、data URL、resource link 的差异。
- session store 继续用 `MessageInfo + Part[]`，补强 `FilePart` metadata、source、hash、size。
- provider-visible history 用 `MessageContentBlock[]`，由 hydration/prompt builder 从 parts 投影出来。
- UI 占位符用 `TextElement` / `source.text` 绑定，不靠字符串扫描猜测附件。
- 不支持媒体时第一阶段返回稳定错误或可见 fallback，不静默丢弃。

## 架构落点

这一版的主骨架：session event log 里的 `MessageInfo + Part[]` 是事实源；进入模型前再投影成 provider message。这样可以让 TUI、resume、compact、rewind、fork、debug 都围绕同一个 durable part 模型工作，而不是每条路径各自拼字符串。

### 消息事实源

持久化层保留三类信息：

- `MessageInfo`：role、session、时间、cost/token、parent/fork/compact 边界等元信息。
- `TextPart`：用户可见文本、synthetic read 结果、错误 fallback、compact placeholder。
- `FilePart`：附件事实，不等于 provider file part。它记录 `mime`、`filename`、`url`、`source`、`sizeBytes`、`sha256`、存储位置和可恢复状态。

`FilePart.url` 应视为稳定 URI，而不是“能直接发给模型”的字符串：

- `file://...`：用户提交时的本地文件引用，只能由 attachment resolver 读取。
- `data:<mime>;base64,...`：小体积、provider-ready 的 inline 内容。
- `zcode-artifact://<artifactId>`：已经进入附件 artifact store 的内容。
- `mcp-resource://...` 或 `resource` source：来自 MCP/resource link 的内容。

`FilePart.source.text` 保留 placeholder 在用户输入里的 byte range 和 value。TUI 删除 `[Image 1]` / `[PDF 1]` 时删除对应 `FilePart`，而不是靠重新扫描同名文本猜测。

### Prompt 扩展

关键点是：用户 part 进入 session 时先扩展成“模型可以理解的上下文”，但原始 `FilePart` 仍然保留。

- `resource`：通过 MCP/resource adapter 读取；文本内容生成 synthetic `TextPart`，二进制内容生成 `[Binary content: <mime>]` fallback，同时保留 `FilePart`。
- `file://` + `text/plain`：走统一 Read 能力或等价的 `FileSystemPort` 读取，支持 `start/end`、symbol range 和预算限制；模型看到的是 “Called Read...” 语义的 synthetic text + 文件内容，session 仍保留 `FilePart`。
- `file://` + directory：第一阶段不把目录作为 file part 发给模型，走目录摘要/Read 结果或明确错误。
- `image/*` / `application/pdf`：不转成 synthetic text；解析成媒体附件，按大小进入 `data:` 或 `zcode-artifact:`，provider 投影阶段再加载。
- 空 base64、损坏图片、MIME 不匹配：生成稳定错误 text part，不把坏 payload 交给 provider。

这里要注意模块边界：prompt expansion 只能调用受控 adapter/port，不能在 session/core 里直接调用 `fs.readFile`、`fetch` 或 shell。

### 存储分层

大文件不能直接塞进 SQLite 的 part JSON，也不能把 provider-ready base64 当作长期历史。建议分四层：

| 层                        | 存什么                                                                                     | 不存什么                           | 用途                                |
| ------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------- | ----------------------------------- |
| SQLite/session store      | message/part metadata、text part、短 preview、artifact URI、hash、size、MIME、source range | 大 base64、完整二进制、完整大文本  | resume、rewind、compact 边界、debug |
| Attachment artifact store | 原始媒体、小/中型二进制、抽取后的文本 preview、可复用 provider payload                     | session 业务状态、用户输入全文日志 | resume/fork 稳定重放、大文件引用    |
| Workspace reference       | 用户选择时的本地路径、mtime、size、hash                                                    | provider payload                   | 入口草稿、错误提示、必要时重新解析  |
| Provider projection       | AI SDK `text` / `image` / `file` part                                                      | 持久事实源                         | 单次模型请求                        |

Provider projection 还必须保证 user message 在 wire 上非空。附件-only 输入的边界如下：

```text
SQLite：一条 user(text="", file)
                    │
      ┌─────────────┴──────────────────┐
      │ live                           │ resume / rewind /
      │                                │ fork child resume
      ▼                                ▼
 real_user("")                  hydrate raw parts
 prompt_attachment                     │
      └─────────────┬───────────────────┘
                    ▼
              Agent 内存 history
                    │
                    ▼
              provider adapter
                    │
                    ▼
               "(no content)"

UI snapshot ──始终读取 SQLite 原始消息──> 一个带附件的 user 气泡
```

持久化不拆分消息；拆分只发生在 live/hydrate 的 runtime/provider 投影阶段。成功展开为
`prompt_attachment` 的文本附件可能留下空 `real_user`，图片等媒体仍保留在 structured user content 中。hydrate
重建的空 `real_user` envelope 只存在于 Agent 内存，不写回 session store，也不进入 UI
snapshot。fork commit 本身只复制持久化事实；只有子会话后续打开/恢复时才进入 hydrate。

如果真实 user content 是空字符串，或转换后没有任何 AI SDK user parts，adapter 只在最终
wire 序列化边界将其投影为固定英文 `"(no content)"`，避免
空白占位被部分 provider trim 后仍判定为缺失 prompt。空格、换行等长度非零的字符串保持原值；
已含图片、文件、resource link 或非空文本的 user content 不追加 fallback。session store、
用户可见 query、title seed 和附件事实始终保持原值，`"(no content)"` 只允许出现在 provider
wire 或 model-io 诊断中。

默认策略：

- 小文本可以直接内联为 text part；超出预算只内联 preview，并把完整内容或可恢复引用放到 artifact store。
- 媒体在提交时 snapshot 到 attachment artifact store，确保 resume/fork 不依赖用户本地文件之后是否被改名或删除。
- 超过附件上限的文件只保存 metadata 和稳定错误，不做 snapshot，避免把不可用大文件偷偷占用本地存储。
- 小 data URL 可以保存在 part 里；超过 `sqliteInlineDataUrlMaxBytes` 的 data URL 必须落 artifact，只在 part 里存 `zcode-artifact://...`。
- provider-ready data URL 是投影结果，不是事实源；除非它足够小并且本身就是用户输入。
- video provider payload 统一从 artifact 生成 data URL/base64；会话内切换和冷恢复都必须重新按
  当前 provider wire 投影，message DB 不能只保存某次请求的临时 payload。
- renderer 从草稿、历史或 replayable payload 恢复 inline image/video 时，`sizeBytes` 只作展示
  metadata；解码前必须根据 base64 正文计算真实字节数并执行对应媒体上限，不能让缺失或低报的
  `sizeBytes` 绕过校验。
- project input history 是独立的 legacy 输入召回能力，不是 session 媒体事实源。本期只保存其既有
  file/image/url 投影；video 不得通过扩大 InputHistory contract 假装可持久化，入口层应显式投影
  支持的附件类型。

初始阈值建议用代码常量或配置项表达，不新增环境变量：

- `inlineTextMaxBytes`: 64 KiB，预算内直接转 text part。
- `textPreviewMaxBytes`: 32 KiB，大文本 preview 上限。
- `sqliteInlineDataUrlMaxBytes`: 256 KiB，超过就必须 artifact 化。
- `mediaSnapshotMaxBytes`: 20 MiB，超过则拒绝或只保留 metadata。具体 provider 的更低限制由 provider adapter 再次门控。
- `toolAttachmentMaxBytes`: 20 MiB，tool 产物媒体进入同一 artifact store。

后续如果要把这些阈值暴露成配置，必须另写配置优先级、错误行为和测试覆盖；不要直接加 `ZCODE_*` 环境变量。

### 投影层

新增独立投影入口，避免 `session-history-hydrator`、compact、provider transform 各自做一套规则：

```typescript
interface MessageProjectionOptions {
  mode: "live" | "resume" | "compact" | "replay";
  stripMedia?: boolean;
  toolOutputMaxChars?: number;
  maxAttachmentBytes?: number;
}

interface MessageProjector {
  toModelMessages(
    messages: StoredMessage[],
    model: ModelDescriptor,
    options: MessageProjectionOptions,
  ): Promise<ModelInputMessage[]>;
}
```

投影规则：

- `live/resume` 默认尽量保留当前模型支持的 media。
- `compact` 首次请求沿用模型能力与媒体预算投影；遇到媒体过大错误后，重试仅传 placeholder 和必要 metadata。
- `replay` 如果附件 artifact 不存在，转成 `[Missing attachment: <name> <mime>]`。
- provider 不支持某 modality 时，生成稳定错误 text part，例如 “Cannot read image/png because this model does not support image input.”
- tool result media 优先放在 tool-result content；provider 不支持 tool-result media 但支持 user media 时，追加 synthetic user message。

### 413 请求体防线

图片导致的 413 属于 HTTP request body 问题，不应只依赖 token compact。即使图片 token 估算很低，base64 JSON body 仍可能超过 provider、代理或网关限制。因此 provider request 投影层必须承担硬字节预算：

- 每次调用 provider 前，图片、PDF、其他二进制文件和视频共用一个 `40MiB`
  请求媒体预算。统一统计完整 data URL 的 UTF-8 字节数，包含 base64 和 URL 前缀；
  已投影为文本的附件不计入媒体预算。视频不再拥有独立的请求预算。
- `media-budget.ts` 是唯一的请求预算实现；普通对话、compact/summary、Memory 和
  目标完成验证都先按模型能力投影，再应用该预算。只修改当前请求副本，不修改
  session message、tool result 或 artifact，持久化与恢复链路保持原有语义。
- 最新真实用户消息中的媒体视为当前轮输入，优先保留，避免用户刚上传的截图被历史图片挤掉。
- 历史媒体按新近程度保留；超出预算的旧媒体替换为 `modelMessageContentToText()` 生成的附件 placeholder，并追加“因媒体预算省略”的说明。
- 如果当前轮媒体本身超过预算，立即抛出可恢复的 `invalid_input`，错误码统一为
  `MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE`，不按附件类型分流，也不再调用 provider。
- compact/summary 首次请求遵循相同预算；遇到 provider 媒体过大错误后，沿用既有的
  placeholder 重试策略。
- 发生媒体省略时记录 debug 日志，包含投影前后媒体字节数、保留数量和省略数量。

单张图片 resize 和单个视频 `30MiB` 原始文件上限继续在附件输入/Read 层执行；
请求层只负责编码后的合计预算，不重复计算视频原始字节。恰好 `30MiB` 的视频编码后
已有 `40MiB` base64，再加 URL 前缀便超过请求预算，因此单文件校验通过不保证请求能发送。

`40MiB` 为正文等非媒体内容预留空间，但不统计文本、工具定义和 JSON 包装，不能保证
整个 HTTP body 始终小于 `50MiB`。不新增 provider 专属预算或持久化状态。

## 目标

第一阶段支持用户消息携带本地文件、图片和资源链接，并把可被当前模型消费的内容安全地注入模型请求。

核心目标：

1. 建立 provider-neutral 的消息内容块和附件 schema。
2. 让 CLI/TUI/ZCode app-server/bootstrap/runtime/session store 使用同一份附件契约。
3. 图片在支持 image input 的模型上以 image content block 进入 provider；不支持时给出稳定、可解释的降级。
4. 文本文件可以按预算内联；大文件和二进制文件只保留摘要、metadata 和可追踪引用，不把大体积内容直接塞回上下文。
5. resume、compact、rewind、debug、event log 都能观察和恢复附件状态。
6. UI 占位符和附件引用必须有显式 range/source 绑定，编辑后不会错配图片或文件。

非目标：

- 第一阶段不做音频、视频、目录批量上传、远程 URL 自动下载。
- 第一阶段不让业务层直接读 `fs` 或访问网络；附件解析必须走 adapter/port。
- 第一阶段不承诺所有 provider 私有格式，只支持 AI SDK 能稳定表达的 text/image/PDF/file-like 内容，provider 差异放在 model adapter。

## 契约

新增入口层输入契约：

```typescript
type UserPromptInput = {
  text: string;
  textElements?: TextElement[];
  attachments?: UserAttachmentInput[];
};

type UserAttachmentInput =
  | { type: "local_file"; path: string; placeholder?: string }
  | { type: "image"; imageUrl: string; placeholder?: string }
  | { type: "resource_link"; uri: string; name?: string; title?: string; mimeType?: string };

interface TextElement {
  byteRange: { start: number; end: number };
  placeholder?: string;
  attachmentId?: string;
}
```

入口层的 `local_file` 只表达用户选择了本地文件，不是 provider-ready 内容。只有附件 adapter/prompt builder 能把它解析成文本、data URL、artifact ref 或 fallback。

新增 provider-neutral content block：

```typescript
type MessageContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
      dataUrl: string;
      detail?: "auto" | "low" | "high" | "original";
      source: AttachmentRef;
    }
  | {
      type: "file";
      mediaType: string;
      name?: string;
      uri?: string;
      dataUrl?: string;
      text?: string;
      source: AttachmentRef;
    }
  | { type: "resource_link"; uri: string; name?: string; title?: string };

interface AttachmentRef {
  id: string;
  kind: "local_file" | "resource" | "inline";
  uri?: string;
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  placeholder?: string;
}
```

session `FilePart` 需要补充存储 metadata，在现有 `FilePart` 形状上扩展，使其更适合大文件：

```typescript
interface AttachmentStorageMetadata {
  sizeBytes?: number;
  sha256?: string;
  storageKind: "inline" | "artifact" | "local_ref" | "remote_ref" | "metadata_only";
  artifactUri?: string;
  originalUrl?: string;
  recoverability: "provider_ready" | "rebuildable" | "preview_only" | "metadata_only" | "missing";
  preview?: {
    text?: string;
    truncated?: boolean;
    originalBytes?: number;
  };
  errorCode?: string;
}
```

`metadata_only` 不是成功附件，它表示用户确实提交过附件，但 ZCode 没有把原始内容保存下来，模型只能看到可解释 fallback。

`ModelInputMessage.content` 从 `string` 扩展为：

```typescript
type ModelMessageContent = string | MessageContentBlock[];
```

兼容策略：

- system、assistant、tool 第一阶段继续优先使用 string。
- user message 使用 block array；纯文本输入仍可保持 string 或被规范化成单个 text block。
- text/plain 文件先转 text block；image/PDF 转 file/image block；目录只作为文本说明或明确拒绝。
- `modelInputMessageJsonSchema` 必须同步扩展，跨进程和 session 边界不能只靠 TypeScript 类型。

## 附件解析边界

新增 `AttachmentPort` 或放入现有受控 I/O adapter 层，负责：

- 规范化本地路径，相对路径基于 session cwd，绝对路径必须经过 workspace/sandbox 策略。
- 读取 metadata：文件名、MIME、size、hash、mtime。
- 按 MIME 和大小判断可内联、可转图片、可作为文本摘要、或只能引用。
- 图片读取为 base64/data URL 形态，不在 core 里直接读文件。
- 图片默认走 `ImageProcessorPort.resizeToFit`，进入模型前最长边应限制在 2000 像素以内；后续支持 original detail 时必须由模型能力门控。Node/SEA 默认实现使用纯 JS Jimp adapter，以避免图片处理依赖平台原生二进制。
- WebP 第一阶段不做 resize/transcode。Jimp 默认不支持 WebP 编码输出，adapter 必须原样返回 WebP bytes，`resized: false`，保留 `image/webp` MIME；如果后续引入 WebP resize，必须先在本 spec 中定义新的 WASM/native 资源加载、SEA 打包和降级行为。
- SVG 不作为图片 base64 发送，优先按文本文件处理。
- PDF 第一阶段可作为 media file block 或 fallback；不支持 PDF 的模型必须收到明确错误文本。有视觉能力的模型（`supportsImage`）优先走页图渲染（见「PDF 页图渲染与密码解锁（2026-10-16）」）。⚠️ **2026-11-11 起**：模型**既不支持 PDF 也不支持图片**时，先走本地解析引擎（本地 OCR）—— 就绪就自动用，不就位才给明确错误文本（见「PDF 本地 OCR 自动供给（2026-11-11）」）。
- 文本文件按统一预算读取，超限时返回 preview + artifact ref。
- 对 data URL 校验 base64 非空、MIME 合法；空或损坏图片转稳定错误，不把坏 payload 发给 provider。
- MIME 优先由内容 sniff，文件扩展名只作为 fallback。

业务层只表达“用户附带了这个资源”的意图，不直接调用 `fs`、`fetch` 或 `process.env`。

## 入口路径

### CLI / TUI

第一阶段推荐新增显式输入形态，而不是魔法解析所有文本：

- `zcode --attach path --prompt "..."`。
- TUI 支持粘贴或选择文件后生成附件列表；图片/PDF 以虚拟占位符 `[Image N]` / `[PDF N]` 渲染。
- 外部编辑器或手动删除占位符后，要根据 `TextElement` / `FilePart.source.text` 删除或重排对应附件。
- 纯文本里出现 `@file`、拖拽路径等 UX 可以后续做，但解析结果也必须转成同一 `AttachmentRef`。

### Bootstrap API

把 app API 改成可接受 attachments：

```typescript
interface UserPromptInput {
  text: string;
  attachments?: UserAttachmentInput[];
}

submitPrompt(input: string | UserPromptInput, options?: SubmitPromptOptions): Promise<TurnResult>;
sendInput(input: string | UserPromptInput, options?: SendInputOptions): Promise<SendInputResult>;
```

`UserAttachmentInput` 是入口层 schema，runtime 之前先由 adapter 解析为稳定 `MessageContentBlock[]`。
为兼容当前 API，`string` 等价于 `{ text: string, attachments: [] }`。

### ZCode app-server

ZCode app-server 当前支持 `text` 和 `resource_link`。下一步：

- `text` -> text block。
- `resource_link` -> resource_link block，先不自动读取网络。
- embedded image/resource -> 解析为 attachment block。
- 不支持的 block 返回 `invalid_params`，错误中包含稳定 `unsupported_content_block` reason。

## Provider Transform

`toAiSdkMessages()` 负责把 ZCode content blocks 转成 AI SDK `ModelMessage`：

- text block -> `{ type: "text", text }`。
- image block -> AI SDK image part。
- resource/file text preview -> text part。
- unsupported file/audio/video -> text fallback，内容包含文件名、MIME、size 和“模型未接收原始二进制”的提示。

模型能力判断：

- 使用 Active Model 的 `properties.input_format`；不从 model ID、Provider 类型或独立 capability map 重新推断。
- 目标模型不支持 image 时，不发送 image part；改为稳定错误或降级文本。
- 默认建议第一阶段对“用户显式附图但模型不支持图片”返回用户可操作错误，而不是静默忽略。
- `mime -> modality` 的判断集中在 transform 层：`image/* -> image`、`application/pdf -> pdf`，后续再扩 audio/video。
- tool result 附带 media 时，优先作为 tool-result content；若 provider 不支持 tool-result media 但模型支持用户侧 media，则追加 synthetic user message 携带附件。
- compact、summary、跨模型 resume 可传 `stripMedia` 选项，将 media 转成 `[Attached <mime>: <name>]` 文本。

## Session Store 与恢复

### 首发与冷恢复一致性

同一模型配置、相同可恢复附件事实下，普通发送、队列消费和 resume / rewind / fork
恢复必须共用用户消息组装逻辑。正文在前，普通附件按提交顺序排列，粘贴图片在后；
文本文件仍投影为独立 `prompt_attachment`，不改变 synthetic reminder 或空正文锚点语义。
图片是否来自粘贴由持久化的附件来源决定，不能由恢复后的临时媒体 `source.kind` 判断。

```text
CLI / Desktop / mobile 输入 → Agent 解析 → 统一用户消息组装 → provider 投影
                                  ↓
                        TextPart + FilePart（唯一持久事实）
                                  ↓
resume / rewind / fork → hydrate 内容 → 同一用户消息组装 → provider 投影
```

路径引用附件保存 `metadata.pathReferenceText`，内容是首次发送给模型的完整三行说明，
包括路径、降级原因和读取提示。恢复优先使用这份原文，不重新读取文件，也不根据当前
解析规则重新生成文案。`preview` 仍表示文件内容预览，不复用为附件说明字段。
该可选字段随既有 FilePart JSON 保存，无需数据库迁移；消费时校验它为字符串。

旧消息同样使用统一顺序。若没有有效的 `pathReferenceText`，保留既有单行占位，
不猜测丢失的原因、不回填或重写历史。旧历史首次切换到修复后的投影可能改变缓存前缀；
新保存的消息必须在热态与冷恢复后的最终 provider 请求中保持附件顺序和说明文本一致。
媒体 artifact 缺失、模型能力变化和 compact 的既有降级规则仍适用。

回归覆盖路径引用、剪贴板文本、PDF、本地图片与粘贴图片混排、video、纯文本及附件单独发送；
同时覆盖队列消费、MCS 开关、实际 SQLite 关闭重开以及最终 provider payload。
Desktop 冷恢复通过发送附件、继续对话、重启并续发验证；mobile replayable 使用同一 Agent
持久事实，不新增客户端消息组装状态。

持久化时：

- 用户原文保存为 text part。
- 每个附件保存为 `FilePart`，补齐 `filename`、`mime`、`url/source`、hash、size metadata；`source` 必须保留 `file` / `resource` / `symbol` 类型，不退化成单个 path。
- 本地文件可以保存 `file://` / workspace-relative source；provider-ready data URL 或 artifact ref 作为解析产物保存，避免 resume 时重复猜测。
- 大体积或转换产物进入 artifact store，只在 part 里保存引用。

恢复时：

- `session-history-hydrator` 不能只生成 `[Attached file: ...]`。
- 对仍可安全重建的 text/image block，恢复为 content block。
- 对缺失、超限或模型不支持的附件，恢复为稳定 text fallback，并记录 recoverability metadata。
- 本地 UI draft/history 可以恢复 local path 和占位符；provider history 只能使用已解析的安全内容或 fallback，不能把 local path 当作 image URL。

Compact 时：

- summary 模型默认 `stripMedia: true`，不接收原始图片、PDF、二进制或大 base64。
- compact 输入里的媒体替换为 `[Attached <mime>: <filename> <size>]`，文本大文件替换为 preview + truncated 标记。
- compact boundary 记录 `attachmentMessageIds`、被 strip 的附件数量、总字节数和可恢复 artifact refs，便于 debug 和后续 fork。
- compact boundary 之前的附件仍在 artifact store 中，但默认不重新进入 active model context；用户需要继续讨论时，模型应知道“之前有附件但媒体内容已从摘要上下文移除”。
- compact boundary 之后的最近上下文附件仍按正常 block 保留，直到下一次 compact。
- 如果 `stripMedia` 后仍超过模型上下文，返回稳定 compact failure reason，例如 `context_too_large_after_media_strip`，并提示用户缩小输入或重新开启会话。
- provider context overflow 后的自动续跑可以再次用 `stripMedia` 重投影，并追加 synthetic user text 说明媒体已被移除；不要在错误恢复路径重新读取大文件。
- 上下文 token 估算不能按 base64 原文长度粗暴计算，图片 data URL 应使用固定或尺寸相关估算，PDF/大文本按 preview 和 provider-specific 估算。

## Rewind、Fork 与附件

附件和 rewind/compact 的关系必须单独设计，否则大文件很容易被误删、误读或重复塞进上下文。

- conversation rewind 删除或隐藏目标点之后的 message/part，但不立刻删除 attachment artifact；artifact 进入未引用状态，由后续 GC 处理。
- file-only rewind 恢复的是 workspace checkpoint，不改变已经提交的附件 snapshot。用户提交时的图片/文件内容以 artifact 为准，不因工作区文件被 rewind 后变化而重新解释。
- 如果用户 attach 的只是 `metadata_only` 大文件，rewind/fork 只能保留 metadata 和错误 fallback，不能假装可恢复。
- compact boundary 之前的会话 rewind 仍按 `rewind-compact.md` 的规则走 fork；fork 时复制 message/part metadata，并共享 immutable artifact URI 或增加引用计数。
- fork 如果发现父会话 artifact 缺失，必须把对应 `FilePart` 转为 `[Missing attachment: ...]` fallback，并在 fork debug event 中记录 `attachment_artifact_missing`。
- `partID` 级 rewind/cleanup 应根据 `FilePart.source.text` 删除对应附件 part；删除用户文本里的 placeholder 后不能留下孤儿附件继续发给模型。
- checkpoint snapshot 是工作区文件变更的审计记录，不是用户附件存储。两套 artifact 不应混用，但 trace/debug 里要能把同一 turn 的 checkpoint 和附件关联起来。
- compact 生成摘要时记录 `attachmentMessageIds`，rewind 到 compact boundary 后仍能解释“哪些附件曾参与摘要但原始媒体未在 active context 中”。

## 安全与错误

关键错误码：

- `attachment_not_found`
- `attachment_outside_workspace`
- `attachment_too_large`
- `attachment_unsupported_mime`
- `attachment_model_unsupported`
- `attachment_read_failed`

日志和 event：

- 记录附件数量、MIME、大小、hash 前缀、解析结果、降级原因。
- 不记录完整 base64、完整文件内容、完整用户隐私内容。
- 所有附件解析、artifact 写入、provider transform 都携带同一个 `traceId`。

## 实施阶段

### Phase 0：spec 与 fixture

1. 固化本 spec，并在 `docs/design/v2/rewind-compact.md` 增补附件、compact boundary、fork artifact 的关系。
2. 增加测试 fixture：小文本、大文本、PNG、JPEG、WebP、空 base64、损坏图片、PDF、SVG、目录、缺失文件、空格路径。
3. 定义默认阈值常量和错误码，不新增环境变量。

### Phase 1：契约和 projection 骨架

1. 扩展 `@zcode/contracts` 的 `ModelInputMessage`、JSON schema、session event payload。
2. 扩展 session `FilePart` metadata，保持旧 part JSON 可读。
3. 新增 `MessageProjector`，把 stored messages 投影成 provider-neutral `MessageContentBlock[]`。
4. 更新 `MessageHistory`，支持 user content blocks，同时保持纯文本路径兼容。
5. 单测覆盖纯文本兼容、block JSON schema、unsupported modality fallback、`stripMedia` placeholder。

### Phase 2：Attachment artifact store

1. 从现有 `ToolArtifactStorePort` 抽出或新增 `ArtifactStorePort`，支持 binary/text artifact、metadata、hash、size、MIME、stream/buffer 读取。
2. SQLite part 只保存 artifact URI 和 metadata，不保存大 base64。
3. `NodeToolArtifactStore` 可继续服务 tool text 产物；用户附件媒体走同一基础设施或 sibling namespace，例如 `cli/attachments/<sessionId>`。
4. 增加 artifact GC 设计入口：本阶段可只做未引用查询，不自动删除。
5. 单测覆盖写入、读取、hash 去重、缺失 artifact fallback、跨平台路径。

### Phase 3：Prompt expansion / attachment resolver

1. 新增 `AttachmentResolver`，接受 `UserAttachmentInput` / `FilePart`，输出 synthetic text parts、file parts 和 artifact refs。
2. `text/plain` 文件走 Read 等价语义，支持 preview/truncated。
3. image/PDF 走 MIME sniff、大小门控、artifact snapshot、data URL 投影准备。
4. SVG 走文本路径；目录走摘要或明确错误。
5. resource link 通过 MCP/resource adapter 读取，失败时生成稳定错误 text。
6. 单测覆盖路径规范化、MIME sniff、空/坏 data URL、超限、missing、resource failure。

### Phase 4：入口接入

1. Bootstrap API 支持 `submitPrompt(string | UserPromptInput)`、`sendInput(string | UserPromptInput)`。
2. CLI 增加 `--attach <path>`，多次传入按顺序生成 `FilePart`。
3. TUI 支持附件 draft 列表和虚拟 placeholder，删除 placeholder 同步删除 part。
4. ZCode app-server 接入 `text`、`resource_link`、embedded image/resource；audio/video 继续返回稳定 unsupported。
5. 所有入口都走同一 resolver，不重复实现读取逻辑。

### Phase 5：Provider transform

1. 更新 `toAiSdkMessages()`，支持 text/image/PDF/file preview。
2. 按 model catalog 的 `modalities.input` 或现有 supports 字段门控 image/PDF。
3. 实现 tool-result media 策略：支持则留在 tool result，不支持则 synthetic user message。
4. provider transform 不直接读本地文件，只通过 artifact store 获取 provider payload。
5. 单测覆盖 image-capable、non-image、PDF-capable、tool-result media、empty base64、unsupported modality。

### Phase 6：compact、overflow 与 rewind/fork

1. compact 调用 `MessageProjector` 并强制 `stripMedia: true`。
2. compact boundary 记录附件统计、`attachmentMessageIds` 和被 strip refs。
3. context overflow recovery 使用同一 strip-media 投影，不重复解析本地文件。
4. rewind cleanup 只移除 message/part 引用，artifact 延迟 GC。
5. fork 复制 part metadata 并共享 immutable artifact，缺失 artifact 转 fallback。
6. 更新 `docs/design/v2/rewind-compact.md`，把上述规则并入现有 compact boundary 和 file checkpoint 设计。
7. 单测覆盖 compact stripMedia、compact 后 resume、rewind 到 part、rewind 后 artifact 不误删、fork 缺失 artifact fallback。

### Phase 7：debug、观测和收尾

1. debug event 展示附件数量、MIME、size、hash 前缀、storageKind、projection result、降级原因。
2. trace 覆盖 resolver、artifact write/read、provider projection、compact strip、rewind cleanup。
3. 文档补充用户可见行为：哪些文件会进入模型，哪些只保留 preview/metadata。
4. 根据 provider 差异补充 OpenAI、Anthropic、OpenAI-compatible 兼容测试。

## 测试要求

完成实现前至少运行：

```text
npm run lint
npm test
```

必测场景：

- 纯文本消息仍保持现有行为。
- 空字符串、空数组或空 text parts 形成的 user message 在 provider wire 上转为 `"(no content)"`；空格、换行、非空文本和媒体-only content 保持不变。
- user message 同时包含 text + image。
- image-capable 模型收到 image part。
- 非 image-capable 模型返回稳定错误或稳定降级。
- 空 base64 / 损坏图片不会发给 provider，返回稳定错误文本。
- PDF 模型能力门控和 fallback。
- SVG 作为文本处理。
- tool result image 在支持/不支持 tool-result media 的 provider 下分别正确转换。
- compact stripMedia 把媒体替换成占位文本。
- compact boundary 记录附件 message id 和 strip 统计。
- context overflow 后不会重新读取大文件，而是复用 artifact/fallback。
- conversation rewind 不立即删除附件 artifact。
- file-only rewind 不改变已提交附件 snapshot。
- fork 会保留或降级附件引用。
- 本地文件路径跨平台解析，Windows/macOS/Linux 分隔符和空格路径不破。
- 大文件不直接进入模型上下文，而是 artifact/ref + preview。
- session resume 后附件不丢失、不重复、不错误重放。
- ZCode app-server unsupported content block 返回稳定 invalid params。
- 日志和 event 不泄露 base64 或完整文件内容。

## 多模态扩展（2026-10-15）

本文作为 image / PDF / 视频附件主线的事实源保持不变。下列分 spec 在本文之上搭建
"多模态能力平台"，不破坏本文已落地的形态：

- [`multimodal-platform.md`](./multimodal-platform.md)：六层架构（adapter / port /
  resource index / resolver / bundle / client variant）总览；客户端变体装配策略；与
  本文 attachment pipeline 的关系。
- [`workspace-resource-index.md`](./workspace-resource-index.md)：workspace 维度跨
  session 持久资源库；`resource://<workspaceIdentity>/<id>/<variant>` 形态；fork /
  rewind reference 计数驱动 GC；`.zcode/resource-policy.yaml` 业务策略。
- [`audio-input.md`](./audio-input.md)：audio 附件端到端通路；`AudioPort` /
  `AudioTranscriptionPort` / `ModelAudioContentBlock`；`audio-transcription-worker`
  后台转写；provider 投影支持/不支持 audio 双分支降级。
- [`video-frames.md`](./video-frames.md)：video 抽帧采样；`VideoFramePort`；
  `video-frame-worker` 按 policy 抽帧；不支持 video 的模型自动用 frame image blocks
  替换。
- [`audio-output.md`](./audio-output.md)：speech synthesis 生产端；`AudioOutputPort`；
  `AudioOutput` tool；生成的 audio 作为 `sourceOrigin: "generated_output"` 写入资源
  库并提供 inline 播放。
- [`stream-input.md`](./stream-input.md)：live capture 通路（麦克 / 摄像头 / 屏幕 /
  系统音频）；`LiveCapturePort`；`StreamSession` lifecycle；chunked upload 到
  artifact store。
- [`hardware-sensor.md`](./hardware-sensor.md)：GPS / 加速度 / 电池 / 网络等结构化
  硬件传感器；`HardwareSensorPort`；JSON samples 作为 `kind: "hardware"` entry 持久
  化。

本次新增的契约都遵循本文既有原则：external I/O 收敛到 port；session 内事务与 workspace
持久化是相互补充关系；media budget（40 MiB）共用；tool 变更走
`docs/design/v2/tool/00-tool-change-chain.md` 端到端链路检查。后续以分 spec 单独提交
为准；本文不重复展开。

## Composer PDF 对齐（2026-08-29）

Composer PDF 使用独立的 `TurnAttachment.type = "pdf"` 和 shared
`ZCodePromptPdfAttachment`。本地/远端路径与 Web V4 bytes 均在 admission 时校验 MIME、20MiB
边界和 `%PDF` magic，并写入 durable artifact；session `part.data` 只保存 FilePart 的
`zcode-artifact://` link、MIME、文件名和 metadata。`pdf-cache/<sessionId>/` 是请求与预览使用的
可重建派生 `.pdf` 路径，不写入 DB、snapshot 或 replayable event。

冷恢复与模型切换按 artifact-first 重新物化 path；`supportsPdf=false` 时在 provider 请求前
omit PDF data 并保留 `[PDF: source: <path>]`，切回支持模型时从同一 artifact 恢复。Composer 和
已发送 row 维持文档卡片形态，但统一使用 PdfViewer 与精确 row/part 授权的 attachment range
read；relay/main 不保存 PDF bytes 或 session 业务状态。

## PDF 页图渲染与密码解锁（2026-10-16）

### 动机

文本抽取（poppler pdftotext）和模型侧原生 PDF 解析都会折损水印、排版、图表信息。
对高保真总结诉求，页图渲染（pdftoppm 100dpi JPEG → vision）是保真路径；该路径
read 工具已具备（`pages` 参数），本节把同一能力接入附件解析。

### 分发矩阵

附件解析（local 与 inline 一致）对 PDF 按以下顺序分发：

| 条件 | 投递形态 |
| --- | --- |
| `modelInputFormat.supportsImage === true` 且 `PdfDocumentPort`、`ImageProcessorPort` 可用 | 页图 image blocks（≤20 页 + 尾注 text block），原始 file block 不投递 |
| 否则 `supportsPdf === true` | 现状单 file block（media file block + dataUrl） |
| 否则 `supportsImage === false` 且 `supportsPdf === false`，且本地解析引擎**已就位** | **本地 OCR 的 markdown 文本块**（见「PDF 本地 OCR 自动供给（2026-11-11）」） |
| 否则 `supportsImage === false` 且 `supportsPdf === false`，且本地解析引擎**不就位** | 明确错误文本（含装法 / 下载命令），不静默失败、不静默换路 |
| 否则（能力位未知） | 现状 omit + 文本占位（`[PDF: source: <path>]`） |

渲染门槛取 `supportsImage`（页图本质是 image blocks；`supportsPdf=false` 但有视觉的模型
同样受益），不要求 `supportsPdf`。渲染失败（port `unavailable`/`io_error`、无渲染路径）
一律记 debug 后回退 file block，不得以错误终止 turn。

⚠️ **本地 OCR 分支插在「页图渲染不可用」与「回落 file block」之间**（`local-media-resolver.ts` 的 `resolveLocalPdfAttachment`）—— 前两条路都不通时才考虑，且要求两个能力位**都显式为 `false`**（未知 = 不委派）。

## PDF 本地 OCR 自动供给（2026-11-11）

⚠️ 本节由 [`capability-provisioning.md`](./capability-provisioning.md) 定义，本节只记附件链侧的事实。

- **触发**：本地路径 PDF + 模型**显式**既不支持 PDF 也不支持图片（`supportsImage === false` 且 `supportsPdf === false`）。
- **行为**：ZCode **自动**调本机解析引擎（`LocalInfraPort.parse`），把 markdown 作为 **text block** 投进 prompt（与图片描述那条路同形：把模型吃不了的东西换成文字）。
- **产物落点**：**会话级 artifact 目录**（`ToolArtifactStorePort.resolveSessionArtifactDir`），**不落在用户源文件旁**；拿不到该目录 ⇒ 放弃这条路并给明确错误文本，绝不退回源文件目录。
- **登记**：OCR 产物在 workspace 资源索引里登记为 `kind: "ocr"` 的变体（不复用 `transcript` / `original`）。
- **不就位**：按三层分别给出**确定的下一步** —— 缺引擎给装法（`uv tool install --python 3.12 "mineru>=4.0,<5"`），缺权重给 `zcode ocr models download --tier <t>`，体检失败给 `zcode ocr doctor`。
- **不适用**：inline PDF（粘贴 / data URL）本轮不走这条路。

### 预算

- 每附件页图子预算 `PDF_ATTACHMENT_PAGE_IMAGES_BUDGET_BYTES = 12 MiB`（请求 media budget
  40 MiB 的子预算）；超预算即止，已渲染页有效。
- 页数上限 `PDF_ATTACHMENT_MAX_RENDERED_PAGES = 20`（与 read 工具
  `READ_PDF_MAX_PAGES_PER_REQUEST` 同值）。
- 每页仍走 `ImageProcessorPort.prepareForModel`（READ_IMAGE_* 约束），与 read 工具一致。
- 多个 PDF 附件各自封顶 12MiB，跨附件共享累加器为开放问题（protected latest-user-message
  硬错误发生在 40MiB 处，单附件封顶不足以保证多附件场景不触发）。

### 尾注与 agentic continuation

超 20 页或超预算时投递已渲染页 + 尾注 text block，内容含总页数、已投页数、源路径，
引导 agent 用现有 read 工具 `pages` 参数继续读。不做 resolver 内多请求 map-reduce。

### 元数据与持久化

- `ResolvedTurnAttachment` 新增可选 `contentBlocks`（多块形态），存在时优先于单 `contentBlock`；
  `media-observability` 汇总按块累计字节。
- `AttachmentStorageMetadata` 新增可选 `pdf: { pageCount?, renderedPageCount?,
  renderStrategy?: "page_images" }`，用于可观测性与下游判别（如 `conversation.ts` 的
  pasted-inline-image 分支不得误判页图块）。
- 页图作为 inline image 随用户消息持久化，模型切换 / 冷恢复语义与现有图片一致；
  尾注中的源路径保证 `Read` + `pages` 续读可用。

### 密码 PDF

- `PdfDocumentPort` 请求新增可选 `password`（仅内存传递，禁止写入事件、元数据、日志或任何
  持久化边界）；adapter 对 pdfinfo/pdftoppm 构造 `-upw`，失败重试 `-opw`（单字段双变体）。
- `getPageCount` 对 exit≠0 且 stderr 匹配 `/password/i` 抛 `password_protected`
  （exit=0 不抛，避免误伤 owner-password-only 可渲染 PDF）。原 Read 原生路径会把加密字节
  直传 provider，该分类使其快速失败为 `PDF_PASSWORD_PROTECTED`。
- 附件路径：解析产出的占位符带 `pdf_password_protected` errorCode；runtime 在有
  interaction broker 时经 `ASK_USER_QUESTION_TOOL_NAME` 通道征求密码，用户提交后仅对失败
  附件子集带密码重跑解析一次（不循环）。
- 密码防泄漏关键边界：**不得**调用 `resolvePermission`（会把 `modifiedInput` 写入
  `PermissionResolved` 事件，密码落盘）；解锁流程结束手动发最小化 `PermissionResolved`
  （仅 toolCallId + decision）。`PermissionRequested` 事件 input 为 `{}`，不含密码。
- argv 密码经 `ps` 对本机其他进程可见（poppler 无 stdin/env 通道）；本地单用户场景接受。
- UI 密码输入暂不遮罩（elicitation `sensitive` 字段尚未被对话框消费），为后续项。

## PDF 密码统一通道与阅读进度（2026-10-16，第二阶段）

本节取代上一节「密码 PDF」中的一次性解锁 pass 描述：附件解析里的独立解锁重跑
（`resolveTurnAttachmentsWithPdfUnlock`）删除，密码征求下沉到 `PdfDocumentPort` 装饰器，
附件链路与 Read 工具链路共享同一份密码状态与交互。

### 动机

超过 `PDF_INPUT_MAX_BYTES`（20 MiB）的密码 PDF 附件只投递路径引用，必须经 Read 工具
`pages` 分页续读；一次性解锁 pass 只覆盖附件解析，Read 链路遇到 `password_protected`
快速失败后模型无法提供密码，链路卡死。真实阅卷场景（44MB 密码扫描卷宗）验证了该缺口。

### 所有权（唯一所有者）

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| PDF 密码（内存） | `AgentRuntimeInternal.pdfPasswordCache`（构造时创建，按引用共享给装饰器） | 纯 Map 不序列化；key = 规范化绝对路径；生命周期 = runtime 生命周期。重启后必须重新询问 |
| 密码问询交互 | `requestPdfPasswordViaAskUserQuestion`（共享 helper，原一次性 pass 的问询逻辑搬移） | 附件与 Read 两条链路的唯一问询写入者；安全不变量原样保留（`PermissionRequested` input `{}`；手动最小化 `PermissionResolved`，绝不走 `resolvePermission`） |
| 包装点 | `AgentRuntime` 构造器内 `createPasswordAwarePdfDocumentPort` | 覆盖 Read（executor 依赖改读 `runtime.pdfDocumentPort`）、两条附件链路与子 runtime。workflow-facade / script-workflow-bridge **故意**持有原始 port：后台上下文无交互面，密码 PDF 直接 `password_protected` 失败，属设计行为 |
| 累计识别进度 | `AgentRuntimeInternal.pdfReadProgress: Map<absPath, { pageCount?, recognizedPages: Set<number> }>`，唯一写入者 read-pdf.ts | 仿 `readFileState` 按引用共享进 executor → `ToolExecutionContext` |

### 解锁语义

`getPageCount`/`renderPages` 抛 `password_protected` 且请求未带密码时：
缓存密码先试（失败即清除缓存，文件可能已换）→ CLI 注入密码（`--pdf-password`，见下节；
成功按同一规则入缓存，失败静默落空不拦截）→ 经 AskUserQuestion 问一次（同文件并发去重，
共享同一次应答）→ 带密码重试一次 → 成功缓存、失败不缓存（错误密码永不入缓存）；
Skip / broker 拒绝 / deny broker → 原样抛错，附件侧照旧产出密码占位符，Read 侧照旧
`PDF_PASSWORD_PROTECTED`。请求已带密码 → 直通不问询。N 个密码文件 = N 次弹窗
（取代旧的合并问询），每次弹窗点名具体文件。

### 无头 CLI 密码注入（--pdf-password，2026-10-16）

无头场景（`-p/--prompt`、`--target`）没有 AskUserQuestion 交互面，密码 PDF 在无头下必然
`password_protected` 失败；阅卷等批量任务需要一个非交互的密码来源。

- 参数：`--pdf-password <pw>`，单值全局，适用于本次运行所有密码 PDF。空值（含纯空白）在
  CLI 入口拒绝。作用域与无头链路对齐：仅 `--prompt` 与 `--target` 接受，其他子命令报错退出。
- 传递链路（一条管道，不新增状态所有者）：`arguments.ts` → `GlobalOptions` →
  `prompt-command` → `ZCodeAppOptions.pdfPassword` → `AgentRuntimeDeps.pdfPassword` →
  `createPasswordAwarePdfDocumentPort` 的 `staticPassword`。workflow-facade /
  script-workflow-bridge 仍故意持原始 port，不受影响；子 runtime 经共享 deps 自然继承。
- 优先级：请求自带密码 > 缓存 > CLI 注入密码 > AskUserQuestion 问询。CLI 密码只在
  `password_protected` 后于 `cache.runExclusive` 内尝试（同文件并发去重沿用同一把锁），
  成功走既有「重试一次 → 入缓存」路径；错误密码不入缓存、不阻断后续问询。无头下问询被
  deny broker 拒绝，原样抛 `password_protected`，不等待输入、不卡死。
- 不新增环境变量（遵循 `ZCODE_` 环境变量约束，能用 CLI 参数表达的不做 env）。argv 密码经
  `ps` 对本机其他进程可见，本地单用户场景接受（与 poppler argv 同一约定）；密码不落盘、
  不进日志。
- 失败反馈矩阵（文件不打开、turn 不中断、不卡死等待输入）：
  - 未提供密码（无头）或用户 Skip：附件链路产出占位符
    `[Attached application/pdf: 路径]` + `metadata.errorCode = pdf_password_protected`
    （`recoverability: metadata_only`）；Read 链路快速失败稳定错误码
    `PDF_PASSWORD_PROTECTED`。模型据此在回答中说明该文件无法读取。
  - CLI 密码错误：与未提供密码走同一条降级路径，但 `onStaticPasswordRejected` 回调发出
    `pdf.password.cli_rejected` warn 日志（只带文件路径，绝不携带密码），调用方据此区分
    「密码给错」与「未提供密码」；错误密码不入缓存，同文件后续请求每次重试静态密码。

### Read 阅读进度

- read-pdf.ts（`pages` 分支）渲染前探测总页数（探测失败/不可用则省略 total 降级），
  经 `ToolCallProgress` 事件（transient，不持久化）发射两段：
  开始 `{ total, message: "第 X-Y 页 / 共 N 页" }`；页图准备完成后
  `{ total, progress: 已识别累计, message: "已识别 R/N 页 · 第 X-Y 页完成" }`。
- 已识别累计跨 Read 调用累加（同一文件多次 `pages` 读取），由 `pdfReadProgress` 持有；
  UI 只做展示投影，不持有业务状态。
- UI：explore 工具组内现 `ToolCallProgressIndicator` 进度行；终态（result/error）清除。

### 附件页数徽标

- `TurnAttachmentMeta` 新增可选 `pageCount`（仅展示元信息，非敏感）；仅内联 ≤20MiB
  附件在 resolve 时已知。新增 transient 之外的 `TurnAttachmentMetaUpdated` 会话事件
  （仅当 ≥1 个附件有 pageCount 时发射，index 对齐 TurnStarted 附件顺序），
  V4 投影 patch userInput 行附件；冷恢复从已持久化的 `part.metadata.pdf.pageCount` 读取。
- >20MiB 路径引用附件的徽标为后续项（需路径→附件 ref 注册表）；进度行已显示共 N 页。
- 密码输入遮罩（elicitation `sensitive` 全链透传）为可选后续项，本期未实现。
