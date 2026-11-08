# 客户端本地知识库（Runtime 内置 RAG）

## 1. 定位与决策

### 1.1 决策（用户已定）

| 编号 | 决策 | 影响 |
| --- | --- | --- |
| D1 | **RAG 自建** | 不外包给外部向量服务；检索栈自己实现 |
| D2 | **客户端本地优先** | 本地知识库住在 **ZCode runtime 里**（`packages/core`），离线可用、随客户端走 |
| D3 | **服务端 RAG 只是补充** | 服务端是**额外的召回源**，不替换本地；本地源恒定在场 |
| D4 | **OCR 本地** | 见 [`ocr-local.md`](./ocr-local.md)；OCR 产物以 sidecar 形式进本地索引 |
| D5 | **自动注入默认开** | 每轮自动把命中片段带进上下文；零命中不注入 → 无命中时成本为零。嫌吵就 `features.knowledge: false` 退回纯工具模式 |
| D6 | **源码入库** | 源码是工作区知识的一部分；只排除依赖 / 构建产物 / 二进制（§4.4） |

D2 与 D3 是本 spec 的骨架：**本地检索是主线，服务端是加料**。因此本地侧必须做到「零网络、零模型下载、零额外运行时依赖」。

### 1.2 本 spec 定义

本地知识库的：索引源范围与锚点、分块策略、存储 schema、词法检索算法、**runtime 消费方式**（自动注入 + 工具）、多源融合契约。

### 1.3 不适用

- 不做跨 workspace 检索（隔离键恒为 `workspaceIdentity?.trim() || workspacePath`）。
- 不做联网检索（那是 web_search 的事）。
- **v1 不做嵌入**（本地嵌入模型、远端 embedding 都不做）。理由见 §1.4。
- 不做重排模型（rerank）。
- v1 不解析 XLSX / PPTX / 图片 / 音视频（见 §4.3）。

### 1.4 为什么 v1 不做嵌入

「轻量」是硬约束，不是偏好：

1. **代价**：本地嵌入模型要拖 `onnxruntime` / `transformers.js`（体积、SEA 单文件打包、三平台分发都要额外处理）；远端嵌入要拖网络、凭据、端点配置与失败处理。两者都把「离线可用」这个客户端核心属性打折。
2. **收益不匹配**：客户端的召回需求以**精确术语**为主（法条名、案号、当事人、送达方式、文书标题），这类查询词法命中率高于语义检索。真正需要语义泛化的（「怎么送达」→「送达方式」）正是服务端 RAG 该补的那一段——与 D3 一致。
3. **架构上不需要**：检索层把「源」抽象成一个端口（§10.3）。加嵌入 = **加一个源实现**，不是改架构。

⇒ 结论：**v1 纯词法**。后续若要本地嵌入，走同一端口新增源，runtime 与存储不动。

## 2. 已验证的运行时事实

本机实测，**不是推测**：

**验证语料**（§7 / §14 的测试用同一份，可复现）：

| id | path | anchor | text |
| --- | --- | --- | --- |
| c1 | `卷宗/甲.pdf` | `page:3` | 本案证据材料包括合同、发票与银行流水三份。 |
| c2 | `卷宗/乙.pdf` | `page:1` | 被告具有自首情节与坦白情节，依法可以从轻处罚。 |
| c3 | `卷宗/丙.pdf` | `page:5` | 送达回证由受送达人签收，拒收的由见证人见证。 |
| c4 | `notes/readme.md` | `line:1-40` | The evidence material is stored in the case folder. |

| 事实 | 证据 |
| --- | --- |
| `node:sqlite` 支持 **FTS5** 与 **json1** | 建表 / 建虚表成功 |
| FTS5 的 `trigram` 分词器**要求 ≥3 字符** → 2 字中文查询静默查不到 | 实测 |
| FTS5 的 `unicode61` **不切分 CJK** → 整段中文成单个 token，局部词匹配不上 | 实测 |
| **手动 bigram 切分**（中文按 2 字窗口切、英文数字整词保留）+ `tokenize='unicode61'` + 逐 token 加引号 `MATCH` → 命中正确 | 实测：`证据材料`→c1、`送达回证`→c3、`evidence material`→c4 |
| 空格分隔的多个引号 token 在 FTS5 里是 **AND** 关系；要 OR 得显式写 `OR` | 实测：`合同 纠纷`(AND)→空（c1 只有 `合同`）、(OR)→c1 |
| **`量刑情节` 查不到 c2 是正确行为** | c2 原文是「自首情节与坦白情节」，没有 `量刑` 这个 bigram → AND 排除。**召回质量取决于库里到底有没有这个词，不是检索坏了** |
| `bm25()` 返回**负数**，越接近 0 越不相关 → 排序必须**升序** | 实测：`证据材料`→`-2.46`、`送达回证`→`-2.72` |
| **`\p{Script=Han}` 必须配 `u` 标志** | 实测：无 `u` 时 `text.match(/[\p{Script=Han}]+.../g)` 返回 **`null`**（整个正则不匹配）；带 `u` 正常。且 `u` 版能切出扩展区汉字 `𠀀𠀁`，`[一-鿿]` 不能 |
| **`LIKE` 的默认 `%` 不能走 `ESCAPE` 转义** | 实测：把「不过滤」实现成 `pattern="%"` 再转义 → `%` 变 `\%` → 模式 `\%\%` → **所有查询返回空**。正确做法是「无前缀 → 不加 LIKE 谓词」 |
| `LIKE` 谓词里的 `%` / `_` 必须转义 | 实测：前缀 `卷宗%` → 空（按字面量）；前缀 `卷宗` → 命中 c1 |
| **`pdftotext -layout` 用 `\f`（form feed）分隔页**，且**末尾多一个空段** | 实测：两页样例输出 `b'PageOneAlpha\n\x0cPageTwoBeta\n\x0c'` → 按 `\f` 切得 3 段，末段为空须丢弃 |
| poppler 26.09.0 的 `pdfinfo` / `pdftoppm` / `pdftotext` **同版本同目录**（`/opt/homebrew/bin`） | 实测 |
| `office-runtime` 的 `package.json` **没有 `exports` / `main` / `types`** → 外部包引不到它的解析器；`#office/*` 是包内子路径导入 | 读源码 |
| office-runtime 是**构建期逐插件打包**的库（esbuild 按 `// kind:<format>` 行过滤），**不是运行时可导入的库** | `packages/office-runtime/scripts/build.mjs` |
| `packages/core/package.json` **没有** `@zcode/office-runtime` 依赖；`core/src` 里**没有任何** `node:sqlite` 用法 | 读源码 |
| `packages/adapters` **已有 `yauzl` 依赖**（zip 读取）→ DOCX 文本抽取零新增依赖 | 读 `package.json` |
| `getWorkspaceKey()` = `workspaceIdentity?.trim() \|\| workspacePath \|\| workspaceRoot` | `apps/zcode-cli/packages/core/src/runtime/methods/config.ts:113` |
| workspace 资源库的库路径范式：`<storageRoot>/cli/resources/<sha256(workspaceKey)[0:16]>.db` | `packages/bootstrap/src/app/port-wiring.ts:186-196` |
| `SYSTEM_REMINDER_PER_REQUEST_SOURCES` 与 `SYSTEM_REMINDER_DESCRIPTORS` 都是**封闭集合** → 新增一个 system-reminder 源要**同时改两处** | `packages/core/src/system-reminder/source.ts` |
| memory 的注入范式：**prefetch → consume → inject**，注入用 `systemReminderAttachmentEntry("relevant_memory", ...)` 并镜像进 `setReadFileStateEntry` | `packages/core/src/runtime/helpers/project-memory-recall.ts` |
| **memory 注入的是「整份文件」**（read-state 镜像用 `isPartialView: false`）→ 知识检索注入的是**片段**，必须用 `isPartialView: true` | `apps/zcode-cli/packages/core/src/runtime/helpers/project-memory-recall.ts:127`。⚠️ 这条是 §8.2.4 正确性论证的地基：片段若标成"看全了"，模型后续 Edit 会基于残缺上下文改文件 |
| `MEMORY_RECALL_SESSION_CHARACTER_LIMIT = 61_440` | `packages/core/src/memory/recall/index.ts` |
| 聊天模型的 provider api type **没有 embeddings 变体**：`providerApiTypeDataSchema` 只有 `anthropic-messages` / `openai-chat-completions` / `openai-responses` | `packages/provider/src/config/provider-data-schema.ts:4-8` |

**结论**：本地检索 = **SQLite FTS5 + 手动 bigram**，纯词法，零网络、零模型、零新增运行时依赖。

## 3. 总体架构

```
┌──────────────── 写：唯一入口 ────────────────┐
│ zcode knowledge index  ──→  KnowledgeIndexPort.upsertSource()  ──→  SQLite
│                                            （adapters 拥有 node:sqlite）
└─────────────────────────────────────────────┘

┌──────────────── 读：runtime 每轮 ────────────┐
│  用户输入 ──→ 查询构造（bigram + 引号）        │
│                  ↓                          │
│      KnowledgeRetrievalSource[]（本地恒在场）  │
│                  ↓                          │
│         RRF 融合（§9.2）→ top-K             │
│                  ↓                          │
│   relevant_knowledge 注入（system reminder）  │
│                  ↓                          │
│        模型据此引用（<相对路径>#<锚点>）        │
└─────────────────────────────────────────────┘
```

**三条硬规则**

1. **检索路径零写入**：检索绝不触发隐式索引（一次查询的延迟必须可控）。
2. **写只有一条路径**：`KnowledgeIndexPort.upsertSource` / `removeSource`；CLI 的 `zcode knowledge index` 是它唯一的前端。
3. **runtime 只认端口**：`packages/core` 不依赖 `@zcode/adapters`（现状即如此），端口在 `packages/bootstrap/src/app/port-wiring.ts` 注入。

**与 memory 的关系**：memory 的 `default-index` / `semantic-recall` 两个分支**严格互斥**（`docs/design/v2/memory/README.md` §5），那是 memory 的事。本 spec 的知识库是**独立的开关 + 独立的源**，两个 memory 分支下都可开、可关，互不影响。

## 4. 索引源与锚点

### 4.1 v1 支持的源

| 源 | 提取方式 | 锚点单元 | 锚点 |
| --- | --- | --- | --- |
| 纯文本（`.md` / `.txt` / `.markdown` / `.json` / `.yaml` / `.yml` / `.csv` / `.log` + 常见代码文件） | 直接读文本 | 40 行 | `line:N-M` |
| PDF（**有文本层**） | poppler `pdftotext -layout` | 一页 | `page:N` |
| PDF（**扫描件**，无文本层） | 读 OCR sidecar | 一页 | `page:N` |
| DOCX | zip 读 `word/document.xml` → 段落 | 一段 | `p:N-M` |

**PDF 抽取的确切命令**（走 `ExecutionPort`，`mode: "argv"`，不裸 spawn）：

```
pdftotext -layout -enc UTF-8 <abs-pdf-path> -
```

输出写到 stdout，页间以 `\f` 分隔、**末尾多一个空段**（§2 实测）→ 按 `\f` 切分后丢弃末段空串，段序号即页码（1 起）。

**PDF 的双来源优先级**：同一 PDF 同时存在文本层与 OCR sidecar → **用文本层**（更准、更完整）；sidecar 只在**抽不出文本层**时兜底。这条规则是确定的，不做「两者合并」。

**DOCX 抽取为什么不用 office-runtime**：

- office-runtime 的 `package.json` 没有 `exports` / `main` / `types` → 外部包**引不到**它的解析器；`#office/*` 只是包内子路径导入。
- 它是**构建期**按插件逐个打包的（`packages/office-runtime/scripts/build.mjs` 按 `// kind:<format>` 过滤代码行），不是运行时可 import 的库。
- 它的解析器是**渲染级**的（依赖 `docx-preview` / `exceljs` / `react-xlsx`），拖进 CLI 启动路径会显著变重——与「轻量」冲突。
- 而索引只需要**纯文本 + 段落边界**：`word/document.xml` 里 `<w:p>` 是段落、`<w:t>` 是文本。`packages/adapters` 已有 `yauzl`，**零新增依赖**即可读 zip。

⇒ 若将来 office-runtime 补上公开入口（`src/entry.ts` + `exports`），索引源可以换成它以获得一致的锚点体系；那是独立改动，本 spec 不前置（见 §16 第 2 条）。

### 4.2 锚点与引用

- 锚点格式与 office-runtime 现有体系**对齐**：`page:N`（PDF）、`p:N-M`（DOCX 段落）。
- 引用形式：`<工作区相对路径>#<锚点>`，与 office-runtime 的 `<path>#<locator>` 一致。
- 纯文本源的 `line:N-M` 是**行号提示**，office-runtime 不认 → 纯文本源的引用给路径 + 行号区间，作为定位提示而非可跳转锚点。

### 4.3 明确不在 v1：XLSX / PPTX / 图片 / 音视频

| 源 | 不做的原因 | 后续路径 |
| --- | --- | --- |
| XLSX | 表格的 chunk 语义要另设计（按行块？按区域？跨 sheet？），不是套用段落规则能解决的 | 单独设计「表格 chunk」 |
| PPTX | 一页幻灯片的文字量通常远小于 chunk 目标值，chunk 规则要有特例；且 office-runtime 的 pptx 解析是渲染级 | 随表格 chunk 一起设计 |
| 图片 | 需要 OCR → 走 [`ocr-local.md`](./ocr-local.md) 的 sidecar；但「图片本身的文字」进索引的收益需要实测 | 与 OCR spec 联动 |
| 音视频 | provider 的 `ModelMessageContentBlock` **没有 audio 分支**（`apps/zcode-cli/packages/contracts/src/model/index.ts:408`）→ 只能「转写 → 文本」，转写链路本身还没建 | 等转写能力 |

**不做的统一处置**：不支持的源在索引时被**跳过并计数**，不报错、不阻断整批。

### 4.4 默认排除

索引整个工作区会把噪声吸进来。默认排除（可在 CLI 传参覆盖）：

- 目录：`.git/`、`node_modules/`、`dist/`、`build/`、`.next/`、`out/`、`target/`、`__pycache__/`
- 文件：`*.lock`、`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`、`*.min.js`、`*.map`
- 二进制：扩展名白名单之外、且**探测为二进制**（含 NUL 字节）的文件一律跳过

**源码目录（`src/` 等）不排除**（D6）——源码是工作区知识的一部分，对「这个项目怎么组织的」这类问题有用。代价是块数变多、噪声略大，靠 topK 与注入预算截断控制。

## 5. 分块策略

**原则：分块不破坏锚点。** 引用必须能落到「哪一页 / 哪一段」，不能落到一个无来源的文本窗口。

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `TEXT_UNIT_LINES` | 40 | 纯文本的锚点单元行数 |
| `CHUNK_TARGET_CHARS` | 800 | 目标块长（按字符估 token） |
| `CHUNK_MAX_CHARS` | 1500 | 硬上限，超了就切 |
| `CHUNK_MIN_CHARS` | 120 | 下限，太短就并到下一单元 |
| `CHUNK_OVERLAP_CHARS` | 100 | 跨单元合并时的重叠 |

规则：

1. 每个锚点单元是块的**边界**。单元文本 ≤ `CHUNK_MAX_CHARS` → 整块，锚点 = 单元锚点。
2. 单元文本 > `CHUNK_MAX_CHARS` → 在**句末标点**（`。！？；\n`）处切；切不出就按 `CHUNK_MAX_CHARS` 硬切。子块**共用同一个锚点**（引用精度到单元级，不假装更细）。
3. 单元文本 < `CHUNK_MIN_CHARS` → 与**后一个单元**合并，锚点写成**合并范围**（如 `page:3-4`、`line:38-80`）；已是最后一个单元则与前一个合并。
4. **不跨文档合并**。

**token 估算**（不引 tokenizer 依赖）：

```
tokens ≈ CJK 字符数 × 1.0 + 拉丁字母数字数 × 0.3 + 空白数 × 0.1
```

近似值只用于「块是不是太长」的判断，不用于计费。

## 6. 存储

### 6.1 文件

每 workspace 一个 SQLite 文件（与 `workspace-resource-index` 同范式）：

```
<storageRoot>/cli/knowledge/<sha256(workspaceKey)[0:16]>.db
```

`workspaceKey = workspaceIdentity?.trim() || workspacePath`（与根 AGENTS.md 的隔离键一致；runtime 侧用 `getWorkspaceKey()`）。

**为什么独立文件而不是复用 resource index 的库**：检索库的写入模式（批量重建分块）与资源库（增量 upsert 资源条目）完全不同；混在一个文件里会让两边的 migration 与清理策略互相牵连。隔离键相同，隔离效果一样。

### 6.2 Schema（v1）

```sql
CREATE TABLE knowledge_sources (
  id             TEXT NOT NULL PRIMARY KEY,   -- sha256(workspaceKey + path) 前 16 位
  workspace_key  TEXT NOT NULL,
  kind           TEXT NOT NULL,               -- text / pdf / docx
  path           TEXT NOT NULL,               -- 工作区相对路径
  title          TEXT,
  bytes          INTEGER NOT NULL,
  mtime_ms       INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  chunk_count    INTEGER NOT NULL DEFAULT 0,
  indexed_at     INTEGER NOT NULL,
  meta           TEXT,                        -- JSON
  UNIQUE (workspace_key, path)
);
CREATE INDEX idx_sources_workspace ON knowledge_sources(workspace_key);

CREATE TABLE knowledge_chunks (
  id         TEXT NOT NULL PRIMARY KEY,       -- sha256(source_id + ordinal)
  source_id  TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  ordinal    INTEGER NOT NULL,
  anchor     TEXT NOT NULL,                   -- page:3 / p:12-18 / line:1-40
  text       TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  token_est  INTEGER NOT NULL
);
CREATE INDEX idx_chunks_source ON knowledge_chunks(source_id, ordinal);

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  tokens,                                    -- bigram 切分后的 token 串（空格分隔）
  chunk_id UNINDEXED,
  source_id UNINDEXED,
  path UNINDEXED,
  tokenize = 'unicode61'
);
```

`path` 放进 FTS 表（UNINDEXED）是为了让 `pathPrefix` 过滤在**一条 SQL** 里完成，不做 join 后过滤。

**没有向量表**：v1 无嵌入（§1.4）。表结构留了加维度的余地，但**不预留空表**——不留「将来也许用」的字段。

### 6.3 增量判定

按**内容哈希**判定，不按 mtime 判定（mtime 会因 checkout / touch 变化，内容没变却重建，是无谓的 IO）：

1. 快筛：`bytes` + `mtime_ms` 与库里一致 → **跳过**（`status: "skipped"`）。
2. 快筛不中 → 读文件算 `content_sha256`：
   - 与库里相同 → 内容没变，只更新 `mtime_ms`，**不重建块**。
   - 与库里不同 → **重建该 source**：单事务内 `DELETE` 旧 chunks/fts 行 + `INSERT` 新行。

**为什么用哈希而不是只信 mtime**：mtime 在 `git checkout`、文件复制、解压后都会变，内容却可能完全一样。哈希是唯一可靠的内容判据。

### 6.4 上限

单 workspace 建议 **≤ 20,000 块**。超限时索引器**报错并提示先清理**（`knowledge_index_limit_exceeded`），**不静默丢数据**、不悄悄变慢。

## 7. 词法检索

### 7.1 索引时：bigram 切分

对每块文本做 bigram 切分后存进 `knowledge_fts.tokens`：

```ts
function bigramTokens(text: string): string {
  const out: string[] = [];
  // ⚠️ 必须带 u 标志：没有 u 时 \p{Script=Han} 在字符类里被当成字面量，整个正则 match 返回 null。
  // \p{Script=Han} 覆盖 CJK 全部区段（含扩展区 U+20000+ 的汉字）。
  for (const run of text.match(/[\p{Script=Han}]+|[a-zA-Z0-9]+/gu) ?? []) {
    if (/^[a-zA-Z0-9]+$/.test(run)) { out.push(run.toLowerCase()); continue; }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    if (run.length === 1) out.push(run);
  }
  return out.join(" ");
}
```

（用 Unicode 属性 `\p{Script=Han}` 而不是 `[一-鿿]` 基本区——Node 原生支持，零成本，顺手消掉「扩展区汉字切不出 token」这个已知限制。**实测**：无 `u` 标志时 `match()` 返回 `null`；带 `u` 时 `"𠀀𠀁证据"` 切成一个 run，而 `[一-鿿]` 只切出 `"证据"`。）

### 7.2 查询时：逐 token 加引号

```
"证据" "据材" "材料"
```

引号是必须的：未加引号的 token 会被 FTS5 当语法（`-` / `*` / `:` 等）解析，中文查询里出现这些字符会直接报错。

- 多 token 默认 **AND**（FTS5 空格语义）。
- `match: "any"` 时改成显式 `OR`：`"证据" OR "据材" OR "材料"`（召回更宽，精度更低）。
- 排序用 FTS5 内置 `bm25(knowledge_fts)`。⚠️ **bm25 返回负数，越小越相关** → `ORDER BY score`（升序）即为最佳优先，**不要**再取负号或用 `DESC`。

**查询退化**：切分后 token 数为 0（如查询只有标点）→ 直接返回空结果，不查库。

**实测的 MATCH 行为**（4 文档语料，见 §2）：

| MATCH 表达式 | 命中 | 说明 |
| --- | --- | --- |
| `"证据" "据材" "材料"` | c1 | AND 语义正确 |
| `"材料" "据材" "证据"` | c1 | 顺序无关 |
| `"证据" AND "据材" AND "材料"` | c1 | 显式 AND 与空格等价 |
| `"合同" "纠纷"` | 空 | c1 只有 `合同` 没有 `纠纷` → AND 正确排除 |
| `"合同" OR "纠纷"` | c1 | OR 放宽 |
| `"证据-*:"` | c1 | 含 FTS5 语法字符**不抛错**（逐 token 加引号生效） |

### 7.3 路径过滤

`pathPrefix` 在同一条 SQL 里做：

```sql
SELECT f.chunk_id, c.anchor, c.text, bm25(knowledge_fts) AS score
FROM knowledge_fts f
JOIN knowledge_chunks c ON c.id = f.chunk_id
WHERE knowledge_fts MATCH ?
  AND f.path LIKE ? ESCAPE '\'
ORDER BY score
LIMIT ?;
```

`LIKE` 的通配符（`%` / `_` / `\`）必须转义——路径前缀来自用户输入，不转义就是注入面：

```ts
function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
}
```

⚠️ **没有前缀时不要走 LIKE 分支**。如果把「不过滤」实现成 `pattern = "%"` 再统一转义，`%` 会被转义成 `\%` → 模式变成 `\%\%` → 只匹配**字面量以 `%` 开头**的路径 → **所有查询都返回空**。这是实测踩到的坑。正确做法是「无前缀 → 不加这个谓词」：

```ts
const where = prefix === undefined ? "" : " AND f.path LIKE ? ESCAPE '\\'";
const params = prefix === undefined ? [match, limit] : [match, `${escapeLikePrefix(prefix)}%`, limit];
```

**实测**（§2 语料）：

| 前缀 | 结果 | 说明 |
| --- | --- | --- |
| 无 | 命中 c1 | 不加 LIKE 谓词 |
| `卷宗/` | 命中 c1 | `卷宗/` + `%` |
| `卷宗` | 命中 c1 | 子串前缀也命中 |
| `卷宗%` | 空 | `%` 按**字面量**处理（转义生效），不是通配符 |

## 8. Runtime 集成

这是本 spec 与旧版最大的差别：**检索结果默认进模型上下文**，而不只是等人来调一个命令。

### 8.1 两个消费面

| 面 | 形态 | 触发 | 默认 |
| --- | --- | --- | --- |
| **A. 自动注入** | `relevant_knowledge` per-request system reminder | 每轮自动 | **开**（D5） |
| **B. 显式工具** | 内置 tool `KnowledgeSearch` | 模型主动调用 | 注册门 = `knowledgeIndexPort` 在场 |

### 8.2 自动注入的时序

完全照抄 memory 的 **prefetch → consume → inject** 范式（`packages/core/src/runtime/helpers/project-memory-recall.ts`）：

```
turn 开始
  └─ startKnowledgeRecallPrefetch(runtime, {query, traceContext, turnAbortSignal})
       └─ 后台 promise：检索 → 落 runtime.knowledgeRecallState
模型轮次进行…
  └─ 工具批次结算后：consumeSettledKnowledgeRecall(runtime)
       ├─ 有命中 → systemReminderAttachmentEntry("relevant_knowledge", 正文)
       │          + 镜像进 setReadFileStateEntry（表现得像一次读取）
       └─ 无命中 → 不注入（零 token 成本）
turn 结束
  └─ disposeKnowledgeRecallPrefetch(runtime)
```

**落点**（以函数名为准，行号会漂移）：

| 位置 | 动作 |
| --- | --- |
| `packages/core/src/runtime/methods/turn.ts`（`startProjectMemoryRecallPrefetch` 调用处） | 追加 `startKnowledgeRecallPrefetch` |
| `packages/core/src/runtime/methods/turn-loop.ts`（`consumeSettledProjectMemoryRecall` 调用处） | 追加 `consumeSettledKnowledgeRecall` |
| `packages/core/src/runtime/methods/turn.ts`（`disposeProjectMemoryRecallPrefetch` 调用处） | 追加 `disposeKnowledgeRecallPrefetch` |

**查询取本轮真实用户输入**（最后一条 `real_user` 来源的消息）。不做模型改写——词法检索下改写收益低、成本高。

**注入的时点**：与 memory 注入同一批（工具批次结算之后），保证「先给工具结果，再给检索补充」的上下文顺序。

#### 8.2.1 状态形状

与 `MemoryRecallState` 同构，但更简单（没有 selector、没有 manifest）：

```ts
// apps/zcode-cli/packages/core/src/knowledge/state.ts
export interface KnowledgeRecallState {
  /** 本 session 已注入的字符总数（session 预算用）。 */
  injectedCharacters: number;
  /** 本 session 已注入过的来源路径；用于去重与「别再注入同一条」。 */
  injectedPaths: Set<string>;
  /** session 预算耗尽后不再注入。 */
  exhausted: boolean;
}

export interface KnowledgeRecallPrefetch {
  abortController: AbortController;
  consumed: boolean;
  detachTurnAbort: () => void;
  hits: readonly KnowledgeHit[];
  settled: boolean;
}
```

runtime 侧新增两个字段（与 `memoryRecallState` / `memoryRecallPrefetch` 并列）：

```ts
// packages/core/src/runtime/internal.ts
knowledgeRecallState: KnowledgeRecallState;
knowledgeRecallPrefetch?: KnowledgeRecallPrefetch;
```

#### 8.2.2 三个函数的签名

与 memory 的三个函数**一一对应**，签名刻意对称（便于对照 review）：

```ts
// packages/core/src/runtime/helpers/knowledge-recall.ts
export function startKnowledgeRecallPrefetch(
  runtime: AgentRuntimeInternal,
  input: { traceContext: TraceContext; turnAbortSignal: AbortSignal },
): void;

export function consumeSettledKnowledgeRecall(
  runtime: AgentRuntimeInternal,
): RuntimeMessageEntry | undefined;

export function disposeKnowledgeRecallPrefetch(runtime: AgentRuntimeInternal): void;
```

`startKnowledgeRecallPrefetch` 的**前置守卫**（顺序即短路顺序）：

```ts
if (!KNOWLEDGE_RECALL_ENABLED) return;                       // 常量 + 配置
if (runtime.knowledgeRecallPrefetch) return;                 // 本轮已启动
if (!runtime.knowledgeIndexPort) return;                     // 端口即注册门
if (!runtime.knowledgeRetrievalSources?.length) return;      // 没有召回源
if (runtime.knowledgeRecallState.exhausted) return;          // session 预算耗尽
const query = findLatestRealUserQuery(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
if (!query) return;                                          // 本轮没有真实用户输入
```

⚠️ 与 memory 的一个**关键差异**：memory 的前置守卫里有 `if (!input.model.properties.supportsJsonSchemaOutput) return;`——因为它要调 selector 模型、需要严格 JSON Schema。**知识检索不需要模型**，纯本地 SQLite 查询，**没有这条守卫**，也不需要 `Model` 参数。

#### 8.2.3 注入正文的构造

```ts
// apps/zcode-cli/packages/core/src/knowledge/attachment.ts
export function formatKnowledgeAttachment(
  hits: readonly KnowledgeHit[],
  maxCharacters: number,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const hit of hits) {
    const snippet = truncateSnippet(hit.snippet, SNIPPET_MAX_CHARS);
    const block =
      `<knowledge path="${escapeAttribute(hit.path)}" anchor="${escapeAttribute(hit.anchor)}">\n` +
      `${escapeBody(snippet)}\n</knowledge>`;
    if (used + block.length > maxCharacters && parts.length > 0) break;  // 至少保留第 1 条
    parts.push(block);
    used += block.length;
  }
  if (parts.length === 0) return "";
  return [
    "Retrieved from the local workspace knowledge base for possible relevance — use only if it actually applies to what the user asked.",
    "",
    ...parts,
  ].join("\n");
}
```

- `escapeAttribute`：路径 / 锚点里的 `"` `<` `>` `&` 要转义，防止文档正文伪造标签。
- `escapeBody`：正文里的 `<knowledge>` 标签要中和（与 `sanitizeSystemReminderBody` 同一思路）。
- 提示语**沿用 memory 的句式**，但插入 `from the local workspace knowledge base` 以标明来源。⚠️ memory 的既有首句是 `Retrieved for possible relevance — use only if it actually applies to what the user asked.`（`packages/core/src/memory/recall/content.ts:33`）—— **本 spec 这一句与之有意不同，差异仅为来源限定语**，不是逐字沿用。另外 memory 只在第 0 条之前前缀一句，本 spec 是**整段正文第一行固定一句**。

#### 8.2.4 镜像进 read-file-state

注入的正文对模型等价于「一次读取」，所以要同步既有 read-state，供后续 Edit/Write 判断文件是否已读：

```ts
const readAt = new Date();
for (const hit of hits) {
  setReadFileStateEntry(runtime.readFileState, {
    content: hit.snippet,
    isPartialView: true,        // ⚠️ 这是片段，不是整篇
    readAt,
    path: hit.path,
    mtimeMs: undefined,          // 索引库不记录源文件 mtime 到 hit 上
    sizeBytes: undefined,
    limit: hit.snippet.length,
    offset: undefined,
  });
}
```

⚠️ 与 memory 的差异：memory 注入的是**整份文件**（`isPartialView: false`），知识检索注入的是**片段** → 必须 `isPartialView: true`，否则模型会以为自己看全了文件，后续 Edit 会基于残缺上下文改文件。

#### 8.2.5 取消与中止

- `prefetch` 挂在 `runtime.trackResidencyBlockingWork(...)` 上（与 memory 一致）→ 进程退出前会等它收尾。
- turn 被中止时，`turnAbortSignal` → `detachTurnAbort()` 转发到 `abortController` → SQLite 查询被取消。
- `disposeKnowledgeRecallPrefetch` 在 turn 的 `.finally()` 里调用（与 memory 一致）→ 轮次结束必定清理，不会泄漏 abortController。

### 8.3 新增 system-reminder 源 `relevant_knowledge`

`packages/core/src/system-reminder/source.ts` 是**封闭集合**，新增源要同时改两处：

1. `SYSTEM_REMINDER_PER_REQUEST_SOURCES` 数组加 `"relevant_knowledge"`。
2. `SYSTEM_REMINDER_DESCRIPTORS` 记录加：

```ts
relevant_knowledge: descriptor("current_turn", "per_current_turn", true, "sr.relevant_knowledge"),
```

descriptor 形状与 `relevant_memory` 完全一致（同为 per-request、meta、provider 可见）。

⚠️ **与 memory 分支的边界**：`semantic-recall` 与 `default-index` 严格互斥是 **memory 内部**的规则。knowledge 是独立开关 + 独立源，**不进入**那个互斥判定——两个 memory 分支下 knowledge 都可以开。

### 8.4 开关与预算

**配置**（`apps/zcode-cli/packages/adapters/src/config/schema.ts`，与 `features.memory` 同级）：

⚠️ **`features` 只能在用户级 `~/.zcode/cli/config.json` 生效**。项目级 schema（`schema.ts:315-320` 的 `projectConfigFileSchema`）是白名单 `.pick({ mcp, hooks, skill, command })` 再 `.strip()` —— **`features` 与 `knowledge` 都不在白名单里**，写进项目级 `<workspace>/.zcode/config.json` 会被**静默剥掉**（不报错、不进 diagnostics）。若要支持项目级可配，须把 `features` / `knowledge` 加进那个 `.pick()` 白名单 —— 这是**独立改动**，本 spec 不前置。

```jsonc
{
  "features": { "knowledge": true },     // 总开关，默认 true
  "knowledge": {
    "topK": 6,                           // 默认 6
    "maxTurnCharacters": 12000           // 默认 12000
  }
}
```

只有一个开关（`features.knowledge`），不像 memory 那样再拆一个 `memory.use`——知识库没有「能力可用但本轮不用」的中间态，零命中不注入已经覆盖了那个诉求。

**运行时配置**：`AgentRuntimeConfig.knowledge?: { enabled?: boolean; topK?: number; maxTurnCharacters?: number }`，在 `packages/bootstrap/src/app/runtime-config.ts` 的 `memory:` 块旁装配。

**常量**（core 内部，与 `PROJECT_MEMORY_SEMANTIC_RECALL_ENABLED` 同构）：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `KNOWLEDGE_RECALL_ENABLED` | `true` | 总开关（配置可覆盖） |
| `KNOWLEDGE_RECALL_TURN_CHARACTER_LIMIT` | `12_000` | 单轮注入的字符上限 |
| `KNOWLEDGE_RECALL_SESSION_CHARACTER_LIMIT` | `61_440` | 单 session 累计注入上限（与 memory 同量级） |
| `SNIPPET_MAX_CHARS` | `1_500` | **单条**片段的上限（§8.2.3 的 `truncateSnippet` 截断点）。取 `CHUNK_MAX_CHARS` 同值 —— 片段本来就来自一个块，不该比块还长；这一条是**兜底**，防检索侧返回超长片段把单轮预算吃光 |

**规则**

1. **零命中不注入**：检索无结果 → 不产生任何附件、不占 token。这让「默认开」在大多数轮次里的成本为零。
2. **单轮超预算**：按得分从低到高丢弃片段，直到总量 ≤ 上限；至少保留第 1 条（避免整轮什么都没给）。
3. **session 超预算**：不再注入新的片段，并在该 session 后续轮次**不再注入**（预算耗尽即停），不追加提示语。
4. **索引库缺席**：没有 `knowledgeIndexPort` → 不检索、不注入、不注册工具，**不报错、不告警**（端口即注册门，与 `workflowSubmitPort` 同范式）。

### 8.5 注入正文格式

```
Retrieved from the local workspace knowledge base for possible relevance — use only if it actually applies to what the user asked.

<knowledge path="卷宗/笔录1.pdf" anchor="page:3">
……片段正文……
</knowledge>

<knowledge path="卷宗/笔录1.pdf" anchor="page:7">
……片段正文……
</knowledge>
```

- 首行提示语沿用 `formatRelevantMemoryAttachment` 的**句式**，插入来源限定语 `from the local workspace knowledge base`（memory 现有首句为 `Retrieved for possible relevance — use only if it actually applies to what the user asked.`，见 `packages/core/src/memory/recall/content.ts:33`）—— 刻意不逐字相同，好让模型知道这批片段来自知识库而不是 memory。
- 片段正文按 §8.4 的预算截断。
- 路径是**工作区相对路径**（不泄露绝对路径、不泄露用户目录结构）。
- 片段正文里的 `<knowledge>` 标签需转义，防止文档正文伪造标签（与 system-reminder 的嵌套标签规则同源）。

### 8.6 工具 `KnowledgeSearch`

- **inputSchema**：`{ query: string, topK?: number, pathPrefix?: string, match?: "all" | "any" }`
- **outputSchema**：`{ hits: [{ path, anchor, snippet, score, source }] }`
- **只读**，`sideEffects: "none"`，不写索引、不写文件。
- **注册门**：`knowledgeIndexPort` 在场。
- ⚠️ 实现前**必须先读并更新** `docs/design/v2/tool/00-tool-change-chain.md`（CLI AGENTS.md 硬性要求），按端到端链路逐项检查。

## 9. 多源融合：服务端作为补充

### 9.1 源抽象

```ts
export interface KnowledgeRetrievalSource {
  readonly id: string;      // "local" / "server"
  readonly label: string;
  search(req: KnowledgeSearchRequest, options?: { signal?: AbortSignal }): Promise<KnowledgeSearchResult>;
}
```

- **本地源**：workspace SQLite 索引，**恒定在场**。
- **服务端源**：后期的服务端 RAG，实现**同一个接口**。

### 9.2 融合：RRF

本地源给 bm25 名次、服务端源给语义名次，量纲完全不同 → 用 **RRF（Reciprocal Rank Fusion）**，只看名次不看分数：

```
score(chunk) = Σ over sources  1 / (K_RRF + rank_source(chunk))     K_RRF = 60
```

去重键 = `path#anchor`（同一份文档的同一处，两源命中算一条，本地优先）。

### 9.3 「补充」的机械保证

服务端源**不得替换**本地源。规则是确定的、可测的：

| 规则 | 说明 |
| --- | --- |
| R1 | 本地源恒定参与检索。**本地零命中时**，才允许服务端结果单独成条目 |
| R2 | 默认**配额** `remoteMaxShare = 0.5` → top-K 中服务端最多占 `⌈K/2⌉` 条，其余名额留给本地（本地不足则空着，不用远端填满） |
| R3 | 跨源按 `path#anchor` 去重，同一条内容不占两个名额 |
| R4 | 服务端源不可用（超时 / 鉴权失败 / 端点未配）→ **降级为仅本地**，不报错、不阻塞本轮，只记 `warn` 级日志 |
| R5 | 服务端命中必须带 `source: "server"` 标注；**本地命中排在前面** |

R2 是「补充」这个产品规则的**唯一机械保证**——没有它，一次远端故障或远端强召回就会把本地结果挤掉，客户端就退化成了远端客户端。

### 9.4 服务端源的接入是后期独立的事

本 spec 只把**契约**定好（§10.3 的 `KnowledgeRetrievalSource`）。服务端源的协议、鉴权、端点配置、服务端索引策略**另立 spec**——它是 D3 的第二阶段，不阻塞本地侧落地。

## 10. 契约

### 10.1 抽取端口（IO 边界）

⚠️ **分块的归属先定死，再定端口签名**。本 spec §11 把**分块**归给 `apps/zcode-cli/packages/core/src/knowledge/chunk.ts`（纯函数），把**抽取**归给 adapters。于是：

- 抽取端口返回**锚点单元**（`units`）—— adapter 只负责「拿到原文，按锚点切单元」；
- 索引端口接收**已切好的块**（`chunks`）—— 块怎么切由 core 决定，adapter 只负责落库。

**如果索引端口收 `units`，adapter 就必须自己再切一次块** → 分块逻辑有两份实现（core 一份、adapter 一份），两份迟早不一致，而 §5 的锚点规则是本 spec 最需要保持一致的部分。所以索引端口收 `chunks`，**不是 `units`**。

```ts
// apps/zcode-cli/packages/contracts/src/interfaces/knowledge-extract.port.ts
export type KnowledgeSourceKind = "text" | "pdf" | "docx";

export interface KnowledgeUnit {
  readonly anchor: string;      // page:3 / p:12-18 / line:1-40
  readonly text: string;
}

export interface KnowledgeScanEntry {
  readonly kind: KnowledgeSourceKind;
  readonly path: string;        // 工作区相对路径
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly contentSha256: string;
}

export interface KnowledgeExtractPort {
  /** 遍历工作区 → 候选源（已按 §4.4 排除规则过滤、已跳过二进制）。 */
  scan(
    req: { workspaceKey: string; kinds?: readonly KnowledgeSourceKind[] },
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<readonly KnowledgeScanEntry[]>;
  /** 单个源 → 锚点单元序列。PDF 走 ExecutionPort；DOCX 走 yauzl。 */
  extract(
    req: { workspaceKey: string; path: string; kind: KnowledgeSourceKind },
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<readonly KnowledgeUnit[]>;
}
```

⚠️ **`scan` 里的遍历、排除、二进制探测、文件读取全部走 `FileSystemPort`**（`apps/zcode-cli/packages/contracts/src/interfaces/file-system.port.ts`）—— **不直接 `fs.readdir` / `fs.readFile`**（AGENTS.md：所有外部 I/O 收敛到 adapter）。既有方法够用：`listDirectory`（遍历）、`stat`（mtime / bytes）、`readTextFile`（文本源）、`readBinaryFile`（二进制探测）。

⚠️ **新端口必须从 barrel 导出**：`packages/contracts/src/interfaces/index.ts` **和** `packages/contracts/src/index.ts` 都要加，否则跨包引不到。

### 10.2 索引端口（写 + 本地读）

```ts
// apps/zcode-cli/packages/contracts/src/interfaces/knowledge-index.port.ts
import type { KnowledgeSourceKind } from "./knowledge-extract.port.js";

export interface KnowledgeChunk {
  readonly ordinal: number;
  readonly anchor: string;      // page:3 / page:3-4 / line:38-80
  readonly text: string;
  readonly charCount: number;
  readonly tokenEstimate: number;
  /** bigram 切分后的 token 串（空格分隔）—— §7.1，由 core 算好。 */
  readonly ftsTokens: string;
}

export interface KnowledgeSourceInput {
  readonly workspaceKey: string;
  readonly kind: KnowledgeSourceKind;
  readonly path: string;        // 工作区相对路径
  readonly title?: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly contentSha256: string;
  /** **已切好的块**（core 切、adapter 落库）。不是 units。 */
  readonly chunks: readonly KnowledgeChunk[];
}

export interface KnowledgeSourceSummary {
  readonly id: string;
  readonly kind: KnowledgeSourceKind;
  readonly path: string;
  readonly title?: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly chunkCount: number;
  readonly indexedAt: number;
}

export interface KnowledgeIndexStats {
  readonly sources: number;
  readonly chunks: number;
  readonly tokenEstimated: number;
}

export interface KnowledgeIndexPort {
  upsertSource(
    input: KnowledgeSourceInput,
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<{ summary: KnowledgeSourceSummary; status: "indexed" | "skipped" | "updated" }>;
  removeSource(
    req: { workspaceKey: string; path: string },
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<{ removed: boolean }>;
  listSources(
    req: { workspaceKey: string },
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<readonly KnowledgeSourceSummary[]>;
  stats(
    req: { workspaceKey: string },
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<KnowledgeIndexStats>;
}
```

### 10.3 检索端口（多源）

```ts
export interface KnowledgeSearchRequest {
  readonly workspaceKey: string;
  readonly query: string;
  readonly topK: number;
  readonly pathPrefix?: string;
  readonly match?: "all" | "any";        // 默认 all
}

export interface KnowledgeHit {
  readonly sourceId: string;   // 召回源 id：local / server
  readonly path: string;
  readonly anchor: string;
  readonly snippet: string;
  readonly score: number;      // RRF 融合分
  readonly rank: number;       // 融合后的名次（1 起）
}

export interface KnowledgeSearchResult {
  readonly hits: readonly KnowledgeHit[];
}

export interface KnowledgeRetrievalSource {
  readonly id: string;
  readonly label: string;
  search(
    req: KnowledgeSearchRequest,
    options?: { trace?: TraceContext; signal?: AbortSignal },
  ): Promise<KnowledgeSearchResult>;
}
```

**本地源**由 `apps/zcode-cli/packages/adapters/src/knowledge/local-source.ts` 实现（内部走 SQLite + FTS5），**注册门**是 `knowledgeIndexPort` 在场。

### 10.4 错误码

```ts
export type KnowledgeErrorCode =
  | "knowledge_index_corrupt"           // 库损坏
  | "knowledge_index_storage_full"      // 磁盘满
  | "knowledge_index_write_conflict"    // 并发写冲突
  | "knowledge_index_limit_exceeded"    // 超过块数上限
  | "knowledge_source_unreadable"       // 源文件读不了
  | "knowledge_source_unsupported"      // 不支持的源类型
  | "knowledge_workspace_key_invalid"   // 隔离键非法
  | "knowledge_remote_source_unavailable"; // 服务端源不可用（→ 降级，不上抛）
```

错误类 `KnowledgePortError { code, message, details? }`，与 `WorkspaceResourceIndexPortError` 同范式。

## 11. 状态所有者

| 状态 / 事件流 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 索引库文件 | `apps/zcode-cli/packages/adapters/src/knowledge/knowledge-index.ts`（node:sqlite adapter） | **只有 adapter 碰 node:sqlite** |
| 索引内容（source / chunk / fts） | 同上 | 写操作在**一个事务**里做完；收到的**已是切好的块**（§10.1） |
| **工作区遍历 / 排除规则 / 二进制探测 / 文件读取** | `apps/zcode-cli/packages/adapters/src/knowledge/scan.ts` | ⚠️ **全部走 `FileSystemPort`**（`packages/contracts/src/interfaces/file-system.port.ts`）—— 不直接 `fs.readdir` / `fs.readFile`（AGENTS.md：外部 I/O 收敛到 adapter） |
| 源抽取（文本 / PDF / DOCX → units） | `apps/zcode-cli/packages/adapters/src/knowledge/extract/*` | PDF 走 `ExecutionPort`；DOCX 走 `yauzl` |
| **分块 + bigram 切分** | `apps/zcode-cli/packages/core/src/knowledge/chunk.ts`（纯函数） | 最好测。⚠️ **分块只有这一份实现** —— 索引端口收 `chunks` 不收 `units`（§10.1），否则 adapter 要再切一次 |
| 查询构造 / RRF 融合 / 注入格式化 | `apps/zcode-cli/packages/core/src/knowledge/`（纯函数） | 无 I/O |
| 每轮召回状态 | `runtime.knowledgeRecallState`（runtime 拥有） | 与 `memoryRecallState` 同构 |
| 召回源列表 | `AgentRuntimeDeps.knowledgeRetrievalSources`（bootstrap 注入） | 默认只有本地 |
| CLI 参数解析与退出码 | `apps/zcode-cli/packages/cli/src/knowledge/` | 不调 `process.exit` |

**避免的反模式**

- 不在检索路径里隐式建索引（延迟不可控）。
- `core` 不 import `adapters`（现状即如此，保持）。
- 不用「先删后插」的方式重建某个 source → **单事务内 `DELETE` + `INSERT`**，避免检索看到空档。
- 不把索引库塞进 workspace resource index 库（写模式不同，migration 会互相牵连）。
- **不新增 `ZCODE_` 环境变量**：能力用配置文件 + CLI 参数表达（AGENTS.md 明确要求）。
- 不在日志里写片段正文全文（只记 path / anchor / 分数）。

## 12. 错误语义与退出码

CLI 形态：

```
zcode knowledge index [--path <dir>] [--recursive] [--force] [--kinds a,b] [--json]
zcode knowledge search <query> [--top-k N] [--path-prefix <p>] [--match all|any] [--json]
zcode knowledge status [--json]
```

⚠️⚠️ **上面这些旗标必须在全局 `arguments.ts` 里注册，否则命令一出生就是死的**。

CLI 是**单一全局严格解析**：`apps/zcode-cli/packages/cli/src/arguments.ts:177` 的 `parseArgs({ strict: true, allowPositionals: true })` —— **未知旗标直接抛错**，不存在「子命令自己解析自己旗标」这回事。实测：

```js
parseArgs({ args: ["knowledge", "index", "--path", "/tmp"], options: {}, allowPositionals: true, strict: true })
// → throw: Unknown option '--path'. To specify a positional argument starting with a '-', ...
```

⇒ 实现清单（照搬仓库既有惯例，`arguments.ts:105-106` 的原话是「strict 解析器要求在全局注册，run.ts 收集后透传给各命令，不污染其他命令的选项语义」）：

1. `arguments.ts` 的 `options` 里注册下列旗标。**已存在的直接复用，不要重复注册**：

   | 旗标 | 类型 | 现状 |
   | --- | --- | --- |
   | `--json` | boolean | **已存在**（`usage` / `plugins` 在用）→ 复用 |
   | `--recursive` | boolean | **已存在**（`recognize` 在用）→ 复用 |
   | `--force` | boolean | **已存在**（`plugins` 在用）→ 复用 |
   | `--path` | string | 新增。⚠️ 语义窄（只指索引根目录），若别处也要用 `--path` 指别的含义 → 改 `--root` |
   | `--kinds` | string | 新增 |
   | `--top-k` | string | 新增 |
   | `--path-prefix` | string | 新增 |
   | `--match` | string | 新增（`all` \| `any`） |

2. `run.ts` 的 `switch (commandName(parsed.positionals))` 加 `case "knowledge"`，把 `parsed.values.*` 收集后透传给 `runKnowledgeCommand(ctx, options, parsed.positionals.slice(1), {...})`。
3. ⚠️ **全局注册 = 全子命令可见**。`--path` 这类通用名一旦全局注册，`zcode recognize --path …` 也会被接受（虽然 `recognize` 不认它）→ 语义在别的命令面被误用时不会报错，只会「传了没反应」。**通用含义的旗标优先复用既有全局旗标**；含义窄的用带前缀的名字（`--knowledge-path`）。

| 情形 | 错误码 | 退出码 |
| --- | --- | --- |
| 成功 | — | `0` |
| 源文件读不了 | `knowledge_source_unreadable` | 该源 `status: "failed"`，**不中断整批**；全部失败则 `1` |
| 源类型不支持 | `knowledge_source_unsupported` | 跳过并计数，**不报错**（§4.3） |
| 索引库损坏 | `knowledge_index_corrupt` | `1`（**不自动重建**，要求用户删库，避免悄悄丢数据） |
| 磁盘满 | `knowledge_index_storage_full` | `1` |
| 块数超上限 | `knowledge_index_limit_exceeded` | `1` |
| 查询为空 | — | `0`（返回空 hits，不是错误） |
| 取消 / 超时 | `cancelled` / `timeout` | `130` / `124` |

⚠️ **本表是 `zcode knowledge` 命令面自己的错误码，不属于 `CapabilityErrorCode`**。本 spec 的检索部分**不是** `zcode cap` 能力（是 runtime 子系统 + 独立命令面，见 §17 与 [`capability-registry.md`](./capability-registry.md)），所以**不归一到那 8 值闭集**，也不进能力信封。

四个命令面各有各的错误语义，别混用：

| 命令面 | 错误形态 | 归属 |
| --- | --- | --- |
| `zcode cap run` | `CapabilityErrorCode`（8 值闭集） | [`capability-registry.md`](./capability-registry.md) §3 / §7 |
| `zcode asset` | `LocalAssetErrorCode` | [`model-assets.md`](./model-assets.md) §4 / §12 |
| `zcode knowledge` | **本表的 `knowledge_*` 码** | 本 spec §12 |
| `zcode standards validate` | **无结构化错误码**，只有退出码 `0/1/2` | [`standard-rule-engine.md`](./standard-rule-engine.md) §7.1 |

⚠️ `cancelled` / `timeout` 这两个名字在多处出现，但**归属不同** —— 本表的 `cancelled` / `timeout` 是 `zcode knowledge` 的；`CapabilityErrorCode` 里也有同名值但属于能力信封。**两套不要互相塞。**

**部分成功**：索引时某个文件坏了，其余照常索引，坏的那个在输出里带原因。**不要**因为一个坏文件让整批失败。

## 13. 跨平台与性能预算

| 关注点 | 处理 |
| --- | --- |
| SQLite | `node:sqlite`（Node ≥ 24 内置），三平台一致；不用 `better-sqlite3`（原生编译） |
| 文件路径 | `node:path` 跨平台；DB 文件名用哈希（避免 Windows 非法字符） |
| PDF 抽取 | 走 `ExecutionPort` 的 `mode: "argv"`，参数数组形式（**不**用 shell 字符串拼接），路径含空格安全 |
| DOCX 抽取 | `yauzl`（adapters 已有依赖），不新增包 |
| 并发 | node:sqlite 是**同步** API → 索引写入**单线程串行**；PDF/DOCX 抽取是外部 IO，可并发（默认 4），拿到 units 后串行写库 |
| 长任务 | 索引是长任务 → 走 ZCode 既有的后台任务通道，不占前台；可取消 |
| 性能预算 | FTS5 bigram 查询在 20k 块量级是毫秒级；PDF 抽取主要耗在 poppler；DOCX 抽取主要耗在解压 |
| 内存 | 检索逐行读，不一次性全量载入 |

## 14. 验收

**工程测试 —— 按包的真实入口跑**：

⚠️ **`pnpm test:engineering <文件>` 到不了这些测试**。根 `vitest.config.ts` 的 `engineering` project 的 `include` 是 `scripts/engineering-test-files.json` 的**显式清单**，其中 **`apps/zcode-cli/**` 与 `packages/shared/**` 各 0 条**；而且匹配不到文件时**不报错**（只打印 "No test files found"）→ **门禁形同虚设**。各包的真实入口：

| 包 | 入口 | 新增测试文件要做什么 |
| --- | --- | --- |
| `apps/zcode-cli/packages/contracts` | `pnpm --filter @zcode/contracts test`（= `vitest tests`） | 放进 `packages/contracts/tests/` |
| `apps/zcode-cli/packages/core` | `pnpm --filter @zcode/core test`（= `vitest tests`） | 放进 `packages/core/tests/` —— 分块、bigram、RRF、注入格式化都在这里 |
| `apps/zcode-cli/packages/adapters` | `pnpm --filter @zcode/adapters test`（= `vitest tests`） | 放进 `packages/adapters/tests/` —— sqlite adapter、抽取器 |
| `apps/zcode-cli/packages/cli` | `pnpm --filter @zcode/cli test`（= `node --test` + **显式文件清单**） | ⚠️ **必须把新测试文件加进 `packages/cli/package.json` 的 `scripts.test` 文件列表** |

**需要 poppler / tesseract 的组**（PDF 抽取、OCR sidecar 兜底）→ 只在装了这些工具的机器上跑，CI 跳过（跳过时**必须显式跳过**，不能静默"通过"）。纯函数组（分块、bigram、RRF、SQL、注入格式化）→ 进 CI，无外部依赖。

**纯函数 + SQL 组**（断言）：

| 场景 | 断言 |
| --- | --- |
| bigram 切分 | 中文按 2 字窗口；英文数字整词且小写；单字中文保留自身；**扩展区汉字（U+20000+）能切出 token** |
| **bigram 正则的 `u` 标志** | 回归：切分器里 `\p{Script=Han}` 必须带 `u`；漏了 → `match()` 返回 `null` → **所有查询空** |
| FTS 建索引 + 查询 | 用 §2 的验证语料：`证据材料`→唯一命中 c1；`送达回证`→c3；`evidence material`→c4；`量刑情节`→**空**（c2 无 `量刑` bigram，AND 正确排除） |
| FTS AND/OR | `match: "all"` 时不含全部 token 的块不命中（`合同 纠纷`→空）；`match: "any"` 时命中（→c1） |
| **bm25 排序方向** | 回归：`bm25()` 返回负数 → `ORDER BY score` **升序**为最佳优先；不得写成 `DESC` |
| **无前缀时的查询** | 回归：不带 `pathPrefix` 时**不加 LIKE 谓词**；若把默认 `%` 一起转义 → 所有查询返回空 |
| pathPrefix 过滤 | 只返回前缀内的块；前缀含 `%` / `_` 时按**字面量**匹配（`卷宗%`→空，`卷宗`→命中 c1） |
| FTS 引号 | 查询含 `-` / `*` / `:` 等 FTS5 语法字符**不抛错**（逐 token 加引号生效） |
| 分块 | 超长单元被切且**共用同一锚点**；短单元与后单元合并且锚点写成范围；不跨文档合并 |
| 增量 | 内容哈希不变 → `skipped`；内容变了 → 重建且块数更新；mtime 变但内容没变 → 只更新 mtime，不重建 |
| 事务 | 重建某个源期间，检索不返回该源的空档（要么旧的要么新的） |
| 部分失败 | 10 个文件坏 1 个 → 其余 9 个索引成功 |
| 排除规则 | `node_modules/` / 锁文件 / 二进制文件被跳过并计数 |
| PDF 分页 | `\f` 切分后页码正确，**末尾空段被丢弃** |
| DOCX 段落 | `p:N-M` 锚点与段落顺序一致 |
| 端口缺席 | 没有 `knowledgeIndexPort` 时，runtime 不注入、不注册工具、不报错 |
| 零命中不注入 | 检索无结果 → 本轮不产生任何 system-reminder 附件 |
| 预算 | 单轮注入字符数 ≤ 上限；session 累计超限后**不再注入** |
| 注入格式 | 首行带提示语；路径是**相对路径**；正文里的 `<knowledge>` 被转义 |
| RRF 融合 | 本地 + 服务端两源，名次已知时融合结果与手算一致 |
| 远端配额 | `remoteMaxShare = 0.5` 时服务端条目数 ≤ `⌈K/2⌉`；本地不足时**不用远端填满** |
| 远端降级 | 服务端源抛 `unavailable` → 仍返回本地结果，**不向上抛** |
| 去重 | 两源命中同一 `path#anchor` → 只出一条，且 `source` 取本地 |
| 凭据 | 索引库里**不含任何凭据**（回归保护；本期无凭据字段） |

**不测**：真实 poppler / 真实 tesseract 的抽取质量 → 手工验收。

**手工验收**：拿一份真实卷宗（≥ 50 页 PDF + 若干 Word）建索引，在 ZCode 会话里问一个「只在正文出现、不在目录里」的词，确认：
1. 自动注入把命中片段带进上下文（`/context` 或 debug 可见）；
2. 片段带正确的 `path#page:N`；
3. 模型据此回答且引用正确。

## 15. 实施顺序

每步一个提交。

1. **登记 managed module**：`pnpm architecture:adopt knowledge-recall --root ...`，补齐 `module.ts` / `contract.ts` / `contract.example.ts` / `CONTRACT.md`。⚠️ `apps/zcode-cli` 是 `managed: false` 的模块 → **不做这一步，下面每一步新增的 `.ts` 都会让 `pnpm architecture:check --changed` 报 `unmanaged-new-file`**。
2. **契约**：`KnowledgeExtractPort`（§10.1）+ `KnowledgeIndexPort`（§10.2）。⚠️ **签名一次定死** —— 索引端口收 `chunks` 不收 `units`（§10.1 的理由），后面再改就是改契约。
3. **抽取器**（adapters）：`scan`（遍历 / 排除 / 二进制探测 / 读取，**全走 `FileSystemPort`**）+ `extract`（纯文本 / PDF 走 `ExecutionPort` / DOCX 走 `yauzl`）。
4. **分块 + bigram 切分**（core，纯函数）+ node:sqlite adapter 落库（`upsertSource` 收 chunks）。
5. `zcode knowledge index` CLI。
6. 词法检索（本地源）+ `zcode knowledge search` CLI。
7. **runtime 集成**：`relevant_knowledge` system-reminder 源 + prefetch/consume/dispose + 预算 + 配置。
8. `KnowledgeSearch` 工具（**先读 tool 变更链**）。
9. 多源融合契约（`KnowledgeRetrievalSource[]` + RRF + 配额 + 降级），服务端源先不接。
10. 服务端源接入（后期独立 spec）。

**步骤 7 是这套设计的兑现点**——前面 6 步都只是把库建起来，第 7 步才让它在会话里自动起作用。

## 16. 未决问题

1. **本地索引覆盖哪些源？** v1 = 纯文本 + PDF + DOCX + **源码**（源码收录已确认，见 §1.1 D6）。XLSX / PPTX 留后续（表格的 chunk 语义要单独设计：按行块？按区域？跨 sheet 怎么合并？）。
2. **office-runtime 要不要补公开入口？** 补了索引源能换成它（锚点与解析完全一致），但会把 `docx-preview` / `exceljs` 等重依赖拖进 CLI 启动路径，与「轻量」冲突。→ 倾向**不补**，维持轻量抽取；真要补，作为独立改动评估。
3. **服务端源的协议与鉴权**：走 zcode-protocol 的哪个通道？凭据从哪来（不落 `~/.zcode/v2/knowledge_config.json` 之外的地方）？→ 后期单独 spec。
4. **索引库是每 workspace 一个文件还是全局一个库 + `workspace_key` 列？** 本 spec 取**每 workspace 一个文件**（与 `workspace-resource-index` 同范式，避免跨 workspace 误召回与清理策略纠缠）。若将来跨 workspace 联合检索需求出现，再评估全局库。
5. **源码块的 chunk 上限是否要比文档更小？** 源码已确认收录。长函数块会占掉注入预算，可能压掉文档类命中。→ v1 暂用统一上限；若实测出现「源码块挤掉文档命中」，再按扩展名分档（属调参，不是设计变更）。

## 17. 与其它 spec 的关系

| spec | 关系 |
| --- | --- |
| [`ocr-local.md`](./ocr-local.md) | OCR sidecar 是本 spec 的索引源之一（扫描 PDF 的兜底）；sidecar 的 `fingerprint` 必须含 sidecar 自身的大小与 mtime，否则解析缓存不会失效 |
| [`capability-registry.md`](./capability-registry.md) | RAG 的**运行时**部分**不是** `zcode cap` 能力（它是 runtime 子系统，不是「一次实现三投影」的能力）。RAG 的**离线动作**（建索引 / 查索引）以 `zcode knowledge` 子命令暴露，因为它们是长任务且需要脚本化 |
| [`standard-rule-engine.md`](./standard-rule-engine.md) | 无关；两者都落在「规范一套」的规划里，但一个管检索、一个管校验 |
| `docs/design/v2/memory/README.md` | memory 的两个分支与 knowledge **独立**：knowledge 不进入那个互斥判定 |
| `docs/design/v2/tool/00-tool-change-chain.md` | 实现 `KnowledgeSearch` 工具前**必须**先读并更新 |
