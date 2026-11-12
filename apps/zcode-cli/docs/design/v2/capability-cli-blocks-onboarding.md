# 能力积木 · 业务接入说明

Status: **v1**（2026-11-12）：随 [`capability-cli-blocks.md`](./capability-cli-blocks.md) 的步 4–7 一起落地。

> ⚠️ **本文是「怎么调」的说明书，不是契约**。字段 / 退出码 / 错误码 / sidecar 格式的**权威定义在 [`capability-cli-blocks.md`](./capability-cli-blocks.md)**；本文只讲业务侧真正要关心的：有哪些积木、要不要装东西、怎么读结果、常见组合怎么写。
> ⚠️ 本文**不含**任何凭据、真实用户数据或内部服务地址。示例里的路径、密码、模型名都是占位符。

## 1. 这份东西是什么

**zcode 的 CLI 就是业务侧要用的积木。** 业务拿一堆原子命令，自己写代码把它们拼成场景逻辑 —— 先干什么后干什么、怎么合并结果、失败怎么重试，**全归业务**。

```
业务代码
  ├─ 调 zcode ocr inspect --path a.pdf   →  拿页成分 + 元素位置
  ├─ 调 zcode ocr parse   --path a.pdf   →  拿文字 / markdown
  └─ 自己决定顺序、并发、重试、怎么合并          ← 业务的事
```

⇒ **zcode 里不会出现场景字样**（不写「阅卷」「试卷」这类词）。同一份 OCR 原子，被不同场景按不同参数用出不同效果。

**要记住的三条**：

| 约定 | 说明 |
| --- | --- |
| **单文件单次** | 每个积木一次只处理**一个文件**。批量是业务自己的编排（业务自己循环 / 并发）⇒ zcode **不提供** `--input-dir` 之类批量旗标 |
| **路径永远传原始路径** | 业务不需要记住上一步的产物路径 —— 积木之间靠 **sidecar 接力**（§6） |
| **契约只有三样** | ① stdout 的**统一信封** ② **退出码** ③ 磁盘上的 **sidecar** |

## 2. 族内动词表（`zcode ocr`）

```
zcode ocr doctor [--json]
zcode ocr inspect --path <文件> [--output <目录>] [--force] [--pdf-password <密码>] [--json]
zcode ocr parse --path <文件> [--output <目录>] [--tier <档位>] [--force] [--pdf-password <密码>] [--json]
zcode ocr models download --tier <basic|standard> [--source <auto|huggingface|modelscope>] [--json]
```

| 动词 | 给什么 | 要什么 | 副作用 |
| --- | --- | --- | --- |
| **`doctor`** | 本机引擎体检：引擎可执行文件在哪、硬件能跑哪几档、权重就位没有、缺什么怎么装 | 无 | **只读**，不下载权重、不写任何产物。**退出码恒为 0**（体检报告本身就是结果） |
| **`inspect`** | **页成分**（纯文本 / 纯图片 / 文本+图片 / 空白）+ **元素位置**（归一化 bbox） | `--path` 必填 | 写 sidecar；**不返回文字正文**、**不产出 markdown** |
| **`parse`** | **文字 + markdown** + 结构化内容块 + 页成分与位置 | `--path` 必填 | 写 sidecar + 产物目录 |
| **`models download`** | 下载指定档位的模型权重 | `--tier` 必填（只接受 `basic` / `standard`） | 下载权重到本机缓存 |

⚠️ **`inspect` 没有 `--tier`** —— 档位是**识别路线**的概念；数字版 PDF 走原生分析路线，压根不烧权重。

⚠️ **`--tier` 只在 `parse` 上有意义**（`flash` / `basic` / `standard` / `advanced`）。不给就用本机默认档；给了但本机跑不动，会**按档位链降级**并在 `metrics.warnings` 里说明（**降级不是错误**，退出码仍是 0）。

⚠️ **`--force` 是破坏性的** —— 忽略 sidecar 缓存强制重算并**覆盖**已有产物。默认（不带）命中缓存直接返回。

## 3. 前置依赖（业务必须知道）

⚠️ **这是最容易踩的一块** —— 第一次调 `inspect` 就撞墙，多半是下面某一类没装。

| 依赖 | 谁需要 | 缺了会怎样 |
| --- | --- | --- |
| **MinerU 引擎 + Python 环境** | `inspect` / `parse`（**识别路线**：扫描件 / 图片 / 有页没文本层的文档） | `unavailable` + `hint` 给装法（业务可以直接把 hint 转给用户） |
| **模型权重** | 同上 | ⚠️ **自动备**（ZCode 自己下）；也可以手动 `zcode ocr models download --tier basic` |
| **poppler** | `inspect` / `parse`（**原生分析路线**：数字版 PDF） | ⚠️ **不报错**，而是**退到识别路线** + 一条明确的 warning —— 数字版 PDF 会多付一次权重代价，但**不静默** |

### 3.1 poppler 的三个二进制各管一段

| poppler 二进制 | 谁用 | 缺了会怎样 |
| --- | --- | --- |
| `pdftohtml` | 原生分析路线（页尺寸 / 文本 bbox / 内嵌图 bbox）+ 路线判定 | 路线判不出来 ⇒ 走识别路线 + 明确 warning |
| `pdftocairo` | 加密 PDF 的解密副本 | 加密 PDF 走不通（`unavailable`）；未加密 PDF 不受影响 |
| `pdftoppm` | 识别路线里**扫描页的整页图** | 扫描页拿不到整页图（页成分仍由引擎给）⇒ 一条 warning |

⚠️ **纯扫描件 + 没装 poppler 仍然可用**（走识别路线即可）⇒ poppler 不是「能不能 OCR」的前置条件，是「**能不能走便宜路线 + 能不能拿到扫描页整页图**」的前置条件。

⚠️ **Windows 上 poppler 默认不进 PATH** —— 业务侧若部署在 Windows，装好后建议用配置项 `ocr.popplerPath` 指到 `pdftohtml` 所在目录。

### 3.2 装法

```bash
# 引擎（Python 3.12）
uv tool install --python 3.12 "mineru>=4.0,<5"

# 权重（basic / standard 两档由引擎决定，其它档位引擎不收）
zcode ocr models download --tier basic
```

⚠️ **引擎与 Python 环境由用户自装，ZCode 不内置引擎二进制** —— 业务侧要能在部署说明里写清楚这一点。

## 4. 怎么调

### 4.1 最小示例（shell）

```bash
# 先体检
zcode ocr doctor --json

# 再看版面
zcode ocr inspect --path ./input.pdf --json > inspect.json

# 再要正文
zcode ocr parse --path ./input.pdf --json > parse.json
```

### 4.2 最小示例（Node / TypeScript）

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** ⚠️ `maxBuffer` 要给够 —— markdown 产物可能很大；stdout 只装信封，但别把它设太小。 */
async function ocr(block: "inspect" | "parse", file: string) {
  const { stdout } = await run("zcode", ["ocr", block, "--path", file, "--json"], {
    maxBuffer: 32 * 1024 * 1024,
  });
  const envelope = JSON.parse(stdout);
  if (!envelope.ok) {
    // ⚠️ 对外只有 8 个能力码；引擎的细粒度码在 error.details.engineCode
    throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  }
  return envelope.output;
}
```

⚠️ **`--json` 时 stdout 只有信封一个 JSON 对象** ⇒ 直接 `JSON.parse(stdout)` 就行，不用剥前缀。

### 4.3 加密 PDF

```bash
zcode ocr parse --path ./加密.pdf --pdf-password "$PDF_PASSWORD" --json
```

⚠️ **密码只经 argv 传给子进程，不落盘、不入日志**。⚠️ **不给密码不会空跑引擎** —— ZCode 在调引擎前就探加密状态，直接报 `invalid_input`（hint 指向 `--pdf-password`）。

## 5. 怎么读结果

### 5.1 信封

```jsonc
{
  "version": 1,
  "key": "ocr.parse",     // ⚠️ 积木 id 闭集：ocr.inspect / ocr.parse / ocr.doctor / ocr.models.download
  "ok": true,
  "output": { /* ... */ },
  "metrics": { "durationMs": 8261, "warnings": ["..."] }
}
```

失败时是 `ok: false` + `error`（**没有** `output`）：

```jsonc
{
  "version": 1,
  "key": "ocr.parse",
  "ok": false,
  "error": {
    "code": "unavailable",                                 // ⚠️ 8 个能力码之一
    "message": "未找到 mineru-kit 可执行文件",
    "hint": "安装：uv tool install --python 3.12 \"mineru>=4.0,<5\"",
    "details": { "engineCode": "engine_unavailable" }     // ⚠️ 引擎内部码在这
  }
}
```

**对外的 8 个能力码**：`unsupported_input` / `invalid_input` / `unavailable` / `not_found` / `permission_denied` / `cancelled` / `timeout` / `internal`。

⇒ **业务按能力码分支，运维按 `details.engineCode` 定位**。

### 5.2 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功（⚠️ **降级、部分页失败也是 0** —— 那些在 `metrics.warnings` 里） |
| `1` | 参数非法 / 文件不存在 / 引擎不可用 / 执行失败 |
| `124` | 超时 |
| `130` | 被取消（SIGINT） |

⇒ 业务可以用同一套分支逻辑处理所有积木。

### 5.3 进度

`inspect` / `parse` 可能跑到分钟级（备权重 + 识别）⇒ **进度走 stderr**，每行一个 NDJSON 事件：

```
{"type":"progress","phase":"provision","message":"准备模型权重…","percent":null}
{"type":"progress","phase":"analyze","message":"分析第 1/3 页…","percent":null}
```

⚠️ **`percent` 不可知时是 `null`** —— 不拿假百分比糊弄业务。⚠️ **失败时 stderr 没有错误行**（错误只在 stdout 的信封里 + 退出码）⇒ 逐行 `JSON.parse(stderr)` 不会混进非 JSON 行。

### 5.4 `inspect` 给什么

```jsonc
"output": {
  "cached": false,                       // true = 命中 sidecar 缓存（没重新分析）
  "sidecarPath": "/abs/扫描件.pdf.zcode-ocr.json",
  "artifactsDir": "扫描件.pdf.mineru",   // ⚠️ **相对 sidecar 所在目录**
  "engine": "mineru",                    // "mineru" | "pdf-native"
  "tier": "basic",                       // 原生分析路线恒为 "native"
  "pages": [
    {
      "pageIndex": 0,
      "widthPt": 595.3,
      "heightPt": 841.9,
      "status": "ok",                    // "ok" | "failed"
      "composition": "text+image",       // 纯文本 / 纯图片 / 文本+图片 / 空白
      "otherElements": 0,
      "elements": [
        { "category": "text",  "type": "text",  "origin": "engine", "bbox": [0.117, 0.086, 0.379, 0.113] },
        { "category": "image", "type": "image", "origin": "engine", "bbox": [0.300, 0.400, 0.700, 0.720], "imagePath": "layout-1_1.png" }
      ]
    }
  ]
}
```

⚠️ **`elements[]` 里没有 `text` 字段** —— 这是 `inspect` 与 `parse` 的唯一区别。⚠️ **但 sidecar 里仍然带逐元素文字** ⇒ `parse` 能接力，不必重跑引擎。

⚠️ **`bbox` 是归一化 0~1 的四点**（`x0,y0,x1,y1`），分母是**该页**的 `widthPt` / `heightPt`（不是整份文档共用一个）。

⚠️ **`imagePath` 相对 `artifactsDir`** ⇒ 拼绝对路径要用 `dirname(sidecarPath) + artifactsDir` 再拼。

⚠️ **扫描页**会有一张覆盖整页的图：`bbox = [0,0,1,1]`、`origin: "rendered"`。

### 5.5 `parse` 给什么

```jsonc
"output": {
  "cached": false,
  "sidecarPath": "/abs/扫描件.pdf.zcode-ocr.json",
  "artifactsDir": "扫描件.pdf.mineru",
  "engine": "mineru",
  "tier": "basic",
  "artifacts": {                         // ⚠️ **相对 artifactsDir**
    "markdownPath": "markdown.md",
    "structuredContentPath": "structured_content.json",   // 引擎原生产物，调试用
    "middleJsonPath": "middle_json.json",                  // 引擎原生产物，调试用
    "assetsDir": "images"                                  // ⚠️ 有裁剪图时才有
  }
}
```

⚠️ **`cached` 是业务判断「这次有没有再烧一次识别」的依据** —— `true` = 直接复用了 sidecar。

⚠️ **命中缓存时 `artifacts` 只有 `markdownPath`** —— sidecar 不记引擎原生产物的路径（那些只是调试信息）。

⚠️ **`engine` 告诉业务这次走的是哪条路线**：`pdf-native` = 数字版 PDF 走原生分析（**没烧权重**）；`mineru` = 走了识别。

## 6. 积木之间怎么配合

### 6.1 接力：`inspect` → `parse`

```
业务调 zcode ocr inspect --path a.pdf   →  写 sidecar（含逐元素文字）
业务调 zcode ocr parse   --path a.pdf   →  命中同一个 sidecar，cached: true，**没重新调用引擎**
```

⇒ **业务永远只传原始路径**，不需要把上一步的产物路径传下去。

⚠️ **命中的判据**（spec §6.5）：源文件内容指纹 + 档位 + **当前积木所需的产物**。⇒ `inspect` 之后调 `parse` 会命中；反过来也一样。

⚠️ **源文件内容变了 ⇒ 不命中**（自动重算）—— 判据是**内容哈希**，不是 mtime。

⚠️ **原生分析路线没有档位** ⇒ 请求给了 `--tier` 也照样命中（否则数字版 PDF 每次都「档位不符 ⇒ 重算」，缓存形同虚设）。

### 6.2 首次部署：`doctor` → `models download` → `parse`

```bash
zcode ocr doctor --json                       # 看缺什么
zcode ocr models download --tier basic        # 权重
zcode ocr parse --path ./input.pdf --json     # 干活
```

⚠️ **`doctor` 的退出码恒为 0** ⇒ 业务**不要**靠退出码判断「能不能用」，要读 `output.report` 里的就绪情况。

### 6.3 重算：`--force`

业务改了自己的预处理、想重跑同一份文件时用 `--force`（**破坏性**，覆盖已有产物）。

## 7. 常见坑

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `unavailable` + hint 说装引擎 | 本机没装 MinerU / Python 环境 | 按 hint 装（§3.2） |
| 数字版 PDF 明明有文字，却走了识别路线 | 没装 poppler（或 Windows 上不在 PATH） | 装 poppler；或配 `ocr.popplerPath`（§3.1） |
| `invalid_input` + hint 提到 `--pdf-password` | 文件加密且没给密码 | 补 `--pdf-password`（§4.3） |
| `cached: true` 但内容是旧的 | sidecar 命中缓存 | 传 `--force` 重算（§6.3） |
| 退出码 0，但 `metrics.warnings` 有告警 | **降级 / 部分页失败 / 路线退化** | 看 `warnings`；降级**不是错误** |
| `tier` 和自己请求的不一样 | 请求的档位本机跑不动，**已降级** | `metrics.degradedFrom` 是原请求档位 |
| `inspect` 拿不到文字 | **设计如此** —— `inspect` 不返回正文 | 要文字用 `parse` |
| 逐行解析 stderr 遇到非 JSON 行 | 没加 `--json` | 加 `--json`（非 JSON 模式下 stderr 是人读文本） |

## 8. 契约在哪

| 想查 | 看哪 |
| --- | --- |
| 信封形状 / 退出码 / 8 个能力码 | [`capability-cli-blocks.md`](./capability-cli-blocks.md) §5 |
| `inspect` / `parse` 的参数 | 同上 §4.2 |
| 前置依赖（引擎 / 权重 / poppler） | 同上 §4.3（本文 §3 是它的业务版） |
| sidecar 格式（v3） | 同上 §6.2 / §6.3 |
| 接力与缓存判据 | 同上 §6.5 |
| 引擎与档位的业务规则 | [`local-infra.md`](./local-infra.md) |
| 命令总表 | [`commands.md`](./commands.md) |
