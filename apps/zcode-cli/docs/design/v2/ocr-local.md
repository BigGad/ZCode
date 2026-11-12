# 本地 OCR 能力（扫描件文本层）

## 1. 目的与范围

给**扫描件 PDF / 图片**补一层文字，让它们能被读取、检索、切片、送进 RAG。

**决策（用户已定）**：OCR 走**本地引擎**，不接云 OCR API。

**本 spec 定义**：本地 OCR 引擎契约、流水线、**图像预处理**（倾斜校正 / 去噪 / 去阴影 / 去色彩 / 二值化）、文本层 sidecar 格式、与 `office-runtime` 解析层的衔接、错误语义。

⚠️ **引擎层已扩展**：本地引擎不再是"tesseract 一个"，而是由 [`local-infra.md`](./local-infra.md) 定义的**引擎链**（MinerU 档位链 → tesseract）。**本 spec 的 §4/§5/§6.1 主体描述的是 tesseract 路线**；MinerU 路线是**文档级**的（整份文档进、markdown + 块级结构出），契约层的分流见 §3.1~§3.3，sidecar 变体见 §6.1.1。

**语言包（tessdata）由 ZCode 托管**，机制见 [`model-assets.md`](./model-assets.md)。本 spec 只负责「用哪个 tessdata 目录、怎么传给引擎」，不负责下载与安装。

**不适用**

- 不做版面还原（表格结构、栏序、标题层级）—— **tesseract 路线**只出**页级文本 + 词级 bbox + 置信度**；MinerU 路线**自带**版面/表格/公式结构（块级），两条路线的产物形态不同（§3.3）。
- 不做手写体识别专项调优。
- 不在 `office-runtime` 内部跑 OCR（见 §6 的放置约束）。
- 不做实时/流式 OCR。
- **不引入外部图像处理依赖**（ImageMagick / OpenCV / Python）—— 本机没有，跨平台分发也不该要求用户装（见 §2 与 §5.1）。

## 2. 已验证的运行时事实

以下是本机（macOS arm64）**实测**结论，不是推测。实现时按这些事实写，不要重新踩。

⚠️ **本表（及 §5.1 / §5.2）里所有 CER 数字都来自「合成清晰页」样本**（0° 干净页基线 **4.58%**，倾斜组 deskew 后基线 **4.87%** —— 见 §5.1 的两组对照表）。**不是真实扫描件**；真实件的分布宽得多，这批数字测不出真实差距。别把它们当真实件基线用。

| 事实 | 证据 |
| --- | --- |
| tesseract 5.5.1 可用，语言包 `chi_sim` / `eng` / `osd` / `snum` 已装（`/opt/homebrew/share/tessdata/`） | `tesseract --version` / `--list-langs` |
| poppler 三件套齐备：`pdfinfo` / `pdftoppm` / `pdftotext`（26.09.0） | `which` |
| **参数顺序有坑**：`tesseract <in> <outbase> -l <langs> <config>`。`-l` 必须在 config 名**之前**；写成 `tesseract in out tsv -l chi_sim+eng` 会被当成「读配置文件 chi_sim+eng」并报 `Can't open chi_sim+eng` | 实测报错 |
| **默认语言只有 eng**：不传 `-l` 时中文全丢（识别成 `ry` / `Bi` 乱码）。必须显式 `-l chi_sim+eng` | 实测：传 `-l` 前识别不出「合同纠纷」，传后全对 |
| TSV 列序固定：`level page_num block_num par_num line_num word_num left top width height conf text`；**词级行 `level == 5`**；`conf` 是浮点（0~100），结构行是 `-1` | 实测 TSV 头部与词行 |
| TSV 写到 `<outbase>.tsv` **文件**，不是 stdout → 不受 stdout 截断影响 | 实测产物文件 |
| 端到端可用：`pdftoppm -r 300 -png` → `tesseract -l chi_sim+eng tsv`，中文正确识别 | 实测：`合同纠纷 编号2024-001` 全对，置信度 91~97 |
| **OCR 噪声真实存在**：同一批测试里「案件」被识别成「桐件」 | 实测 → 必须保留每词置信度，不能只存整页文本 |
| 渲染分辨率影响质量：300 DPI PNG 是可用基线 | 实测 |
| **本机没有任何外部图像处理工具**：`magick` / `convert`（ImageMagick）、OpenCV、`unpaper` 全部未命中 → **图像预处理只能纯 JS 实现** | `command -v` 逐个查 |
| `jimp` 1.6.1 已是 `apps/zcode-cli/packages/adapters` 的依赖 → 纯 JS 图像处理不需要新增依赖 | `packages/adapters/package.json` |
| **tesseract 没有倾斜校正能力**：`--psm 0`（OSD）对 0.7° / 2° / 5° 倾斜的图**一律报 `Orientation in degrees: 0`** —— OSD 只认 90° 的整数倍 | 实测 osd 输出 |
| **倾斜是 OCR 质量的决定性因素**：0° 与 0.7° 全对；2° 出现零星错字；**5° 完全崩坏**（识别输出全是乱码，CER 100%） | 实测（同一批中文样本） |
| **投影锐度法（Postl）估角精度极高**：0.2°→0.190、0.3°→0.290、0.5°→0.490、0.8°→0.810（误差 ≤ 0.02°）；**只有 3 行文字也准**（2° 估成 1.930，误差 0.07°）→ 不需要「文本行数不足就跳过」这类兜底分支 | 实测 |
| **校正阈值取 0.5°**：0.2° 校正前后 CER 都是 4.58%（无收益）；0.8° 校正前 5.74% → 校正后 4.58% | 实测 |
| **`--psm` 必须显式指定**：默认 **PSM 3** 的自动版面分析会把「长行 + 多行中文页」误判成**多栏**，按列读出 → CER 70.69%；PSM 4 / 6 → 4.58% | 实测（同一张图，只改 psm） |
| **去阴影 / 去背景：自建无效，tesseract 自带的 Sauvola 有效**：彩色底纹样本上，自建「灰度 + 除法归一化 + 二值化」CER 17.23%（零增益）；`-c thresholding_method=2`（Sauvola）→ **10.91%** | 实测 |
| **去噪：自建无效**：3×3 中值滤波（3.0 s/页）与连通域去噪（0.07 s/页）在所有样本上 CER 无变化 | 实测 |
| **去色彩：tesseract 内部已做**：红字 / 蓝字 / 泛黄纸张样本均 100% 正确识别 | 实测 |
| **二值化：自建 Otsu 无增益**（与交给 tesseract 的 thresholding_method 相比无差异） | 实测 |
| **预处理产物落 PGM（P5）比 PNG 快 30 倍**：手写 P5 头 + 原始像素落盘 ~13 ms vs jimp PNG 编码 ~410 ms（2480×3508），约 **31.5×** | 实测 ⚠️ **jimp 1.6.1 不支持 PGM 编码**（格式插件只有 bmp/gif/jpeg/png/tiff），`img.write("x.pgm")` 直接抛 `Unsupported MIME type` → **PGM 必须自己手写**，不能指望 jimp |
| **PGM 没有 DPI 元数据 → 调 tesseract 必须显式 `--dpi`**：不传时 tesseract 把 300 DPI 估算成 560 | 实测 `tesseract --dpi` |
| **pdftoppm 的 PNG 带 pHYs**（11811 px/m = 300 DPI）→ PDF 路径本身不缺 DPI | 实测 PNG chunk |
| **tesseract 支持 `--tessdata-dir <dir>`**（5.5.1；不在 `--help` 里但生效，可放在 config 名之前）→ **语言包可以由 ZCode 托管，不需要用户装** | 实测 |
| **指定 `--tessdata-dir` 后识别结果与系统 tessdata 字节一致**（`cmp` 通过） | 实测 |
| **tessdata 的 `configs/` 目录是必需的**：`tsv` 不是内置配置名，而是 `configs/tsv` 文件提供的 | 实测：缺 `configs/` → `read_params_file: Can't open tsv` |
| **缺 `configs/` 是静默失败**：退出码 0、无产物、stderr 只有一行警告 → **adapter 必须断言产物文件存在**，不能只看退出码 | 实测 |
| 最小可用 tessdata 目录 = **46MB**（`chi_sim` 42MB + `eng` 4MB + `configs/` 104KB）；`osd`（10.5MB）不需要（我们自己做 deskew） | 实测 `du -sh` |

⚠️ **测试语料必须有真 CJK 字形**：用无 CJK 字形的默认 PDF 字体生成样本 → tesseract 拿到的是空字形 → 识别出 `….....0024-001` 这种垃圾。生成语料时要嵌入 CJK 字体（macOS 用 `/System/Library/Fonts/Supplemental/Songti.ttc`）。

⚠️ **测试语料的文字不能超出页宽**：超出部分会被裁掉，OCR 输出「行首若干字 + 行号」看起来像读通了，实际每行都缺后半句 —— 量 CER 时会得到完全失真的数字。造语料后先量一遍文字包围盒宽度。

⚠️ **`/tmp` 在 macOS 上是 `/private/tmp` 的符号链接**：leptonica 走符号链接会报 `image file not found`（退出码 0，但只写出一行表头的空 TSV）。测 OCR 时用 `/private/tmp/...` 或工作目录内的相对路径。

## 3. 能力契约

能力键 `ocr`，遵循 [`capability-registry.md`](./capability-registry.md) §3。

```ts
export interface OcrCapabilityInput {
  /** 源文件路径（工作区内）。 */
  readonly path: string;
  /**
   * 显式指定引擎；不给 = 由 `LocalInfraPort` 按档位链选（**能力层不自己选引擎**，见
   * [`local-infra.md`](./local-infra.md) §7.10）。
   * ⚠️ **没有这个字段，输出侧按 `engine` 判别的联合类型就无法被触发** —— 要么 tesseract
   * 分支是死代码，要么能力层得自己选引擎（与"能力层不选引擎"冲突）。
   */
  readonly engine?: "tesseract" | "mineru-flash" | "mineru-basic" | "mineru-standard" | "mineru-advanced";
  /** 显式指定 MinerU 档位；不给 = 用 MinerU 的 `default_request_tier`。 */
  readonly tier?: "flash" | "basic" | "standard" | "advanced";
  /** 处理哪些页。 */
  readonly pages?: "all" | "auto" | string;   // "auto" = 只补无文本层的页；"1-5,8" = 指定页
  /** OCR 文本与已有文本层的关系。 */
  readonly strategy?: "fill" | "override";     // 默认 fill
  /** 引擎语言包，默认 ["chi_sim","eng"]。 */
  readonly languages?: readonly string[];
  /** 渲染 DPI，默认 300。 */
  readonly dpi?: number;
  /** 图像预处理模式，默认 "auto"（见 §5.1）。 */
  readonly preprocess?: OcrPreprocessMode;
  /** tesseract 版面分析模式，默认 4（见 §5.2）。 */
  readonly psm?: number;
  /** tesseract 二值化方法：1 = Leptonica Otsu（默认），2 = Sauvola（见 §5.2）。 */
  readonly thresholdingMethod?: 1 | 2;
  /** 输出到哪。默认写源文件旁的 sidecar；给了绝对路径则写到那里。 */
  readonly output?: string;
  /**
   * 加密 PDF 的密码。
   * ⚠️ **只在 CLI 投影可用**：CLI 投影把既有全局旗标 `--pdf-password` 的值放进这个字段。
   * **MCP / 内置工具投影必须拒绝或忽略它** —— tool input 会进 session event 与日志，
   * 密码不能进那条链路（CLI AGENTS.md：不得把凭据写进日志 / trace）。
   * 只经 argv 传递，**不落盘、不入日志**（沿用 `pdf-document.port.ts` 的约定）。
   */
  readonly password?: string;
  /** 不保留词级 bbox（sidecar 体积从 MB 级降到 KB 级）。默认 false。 */
  readonly noWords?: boolean;
}

```

⚠️ **`OcrCapabilityOutput` 只有一份声明，在 §3.3**（按引擎分流的联合类型）。本 spec 曾在这里另写一份 interface，形状冲突且同名双声明会让 TypeScript 直接编译报错 —— 已删除，不要在此处再加回来。

`sideEffects = "workspace"`，`mutating = true`（写 sidecar），`idempotent = true`（同输入同 sidecar 内容，重跑覆盖）。

**`dpi` 的语义分两种输入**：

| 输入 | `dpi` 的含义 | 缺省行为 |
| --- | --- | --- |
| PDF | **渲染分辨率**（`pdftoppm -r`） | 300 |
| 图片 | **送进引擎的分辨率假设**（`tesseract --dpi`） | 300（照片按 300 DPI 语义处理） |

⚠️ 图片格式通常不带可靠的 DPI 元数据，tesseract 只能靠估算（实测一张 300 DPI 的图被估成 560）。**统一显式传 `--dpi`** 可以消除这个不确定性；用户可用 `dpi` 覆盖默认的 300。

### 3.1 引擎链与本契约的关系

⚠️ **本节的前提**：`ocr-local.md` 的引擎层已由 [`local-infra.md`](./local-infra.md) 扩展为**引擎链**（MinerU 档位链 → tesseract）。契约层按引擎分流，**不允许造出第三种"两边都不像"的产物格式**。

| 引擎 | 谁负责 | 产物 | 本契约的适用性 |
| --- | --- | --- | --- |
| MinerU（`flash` / `basic` / `standard` / `advanced` 四档） | `LocalInfraPort`（见 [`local-infra.md`](./local-infra.md)） | markdown + **块级**结构（bbox + 类型，**无置信度**） | ⚠️ 部分字段不适用，见 §3.2 |
| tesseract | `OcrEnginePort`（§4） | 页级文本 + **词级** bbox + 置信度 | 全字段适用 |

⇒ **能力层不自己选引擎**：档位选择与降级决定归 `LocalInfraPort`（[`capability-registry.md`](./capability-registry.md) §3 的 `CapabilityPorts.localInfra`）。能力层只消费 `{ tier, degradedFrom, warnings[] }`。

### 3.2 MinerU 路径下的输入字段处置

⚠️ **契约说谎比报错更糟** —— MinerU 不支持的输入参数一律**明确拒绝**，不静默忽略。

| 本契约字段 | MinerU 路径下 |
| --- | --- |
| `psm` / `preprocess` / `thresholdingMethod` / `noWords` | ❌ **明确拒绝** —— 它们是 tesseract 专属（M6） |
| `strategy`（`fill` / `override`） | ❌ **明确拒绝** —— MinerU 不区分"补文本层"与"覆盖" |
| `pages`（`all` / `auto` / `"1-5,8"`） | ⚠️ MinerU 走**整份文档**语义；子集需求用 MinerU 自己的页范围表达，不复用该字段 |
| `languages`（`chi_sim` / `eng`） | ⚠️ **映射**到 MinerU 的语言词表（`ch` 等）—— 两套词汇表不同，**不能同名直传**；映射表待定（[`local-infra.md`](./local-infra.md) §9.2 O3） |
| `dpi` | ⚠️ MinerU 自行决定渲染分辨率，该字段在 MinerU 路径下**不适用** → 明确拒绝 |
| `password` | ✅ **ZCode 侧前置解密**（**不是**透传给 MinerU）：MinerU 4.1.7 **没有任何密码入口**（实测，见 §3.2.1）⇒ 密码由 ZCode 自己用 poppler 解密后再把**无密副本**交给引擎。规矩不变：只经 argv、不落盘不入日志、MCP / 内置工具投影必须拒绝 |

### 3.2.1 加密 PDF 的解密路线（MinerU 路径）

⚠️ **实测（MinerU 4.1.7，2026-11-12）**：加密 PDF 直接喂给引擎**必然失败** —— `mineru-kit parse <加密.pdf>` 报 `Failed to load document (PDFium: Incorrect password error).`；引擎的密码入口**根本不存在**：`mineru-kit parse --help` 与 `mineru parse --help` 都没有 `--password`，`mineru/parser/__init__.py::parse()` 与 `docvortex.document.pdf.PDFDocument.__init__` 的签名里也没有密码参数。

⇒ **密码由 ZCode 自己消费**，不是透传给引擎：

| 步骤 | 谁做 | 说明 |
| --- | --- | --- |
| ① 探加密状态 | `LocalInfraPort` → `PdfDocumentPort`（poppler `pdfinfo`） | 不带密码探一次：报密码错 ⇒ 加密 |
| ② 没给密码 | 端口**直接失败** | 报 `password_protected`（对外 `invalid_input`）⇒ **不空跑一次引擎** |
| ③ 给了密码 | 端口先探「密码对不对」 | 密码被拒 ⇒ `password_protected`（对外仍是 `invalid_input`） |
| ④ 解密 | `PdfDocumentPort` 的 poppler 实现（`pdftocairo -pdf -upw/-opw`） | 产出**临时无密副本**（系统临时目录），密码**只经 argv** |
| ⑤ 解析 | 端口把**副本**交给 MinerU | **原文件不动**；sidecar 的指纹仍取**原文件** |
| ⑥ 清理 | 端口在解析结束后删掉临时副本 | 不在用户目录里留解密内容 |

⚠️ **解密副本经 cairo 重编码**（`pdftocairo -pdf` 走 cairo 后端）⇒ 矢量内容理论上可能被光栅化。**实测（2026-11-12）**：同一份 PDF 的原文与解密副本分别过 MinerU，**元素模型逐项一致**（块类型 / bbox / `image_source` 全同）⇒ 对 OCR 产物无可见影响。但这是**实测结论而非保证**，引擎或 poppler 换版后要重测。
⚠️ **`pdftocairo` 是 poppler 自带的**（不是 ZCode 的新依赖）：没装 poppler 时，加密 PDF 这条路走不通（报 `unavailable`）；**未加密**的 PDF 不受影响（根本不会调 `pdftocairo`）。
⚠️ **端口没有 poppler 时**（`LocalInfraDeps.pdf` 未注入）走**兜底判定**：引擎跑完在 stderr 里认「Incorrect password」，同样归一成 `password_protected` ⇒ 对外 `invalid_input`（代价是白跑一次引擎）。

### 3.3 输出按引擎分流

> ⚠️ **2026-11-12 修订**：本节的 `pageWidthPt` / `pageHeightPt`（**整份文档共用**的分母）与「sidecar v2 变体」的说法**已过期** —— 统一 sidecar v3 把分母改成**页级** `widthPt` / `heightPt`（分母跟着页走，不再是整份文档共用），且 v2 已废止（见 §6.1 / §6.1.1 的作废横幅与 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §6.3 的映射表）。
> ⇒ **实现时不得按本节的字段名建模**：以 §6.1 的 v3 口径为准。
> ⇒ 本节其余内容（按引擎分流、`tier` / `degradedFrom` 的对外落点、块级 `type` 是开放集合）**继续有效**。

```ts
export type OcrCapabilityOutput =
  | {
      readonly engine: "tesseract";
      readonly path: string;
      readonly pageCount: number;
      readonly ocrPages: readonly number[];
      readonly skippedPages: readonly number[];
      readonly sidecarPath: string;
      readonly averageConfidence?: number;
      readonly lowConfidencePages: readonly number[];
    }
  | {
      readonly engine: "mineru-flash" | "mineru-basic" | "mineru-standard" | "mineru-advanced";
      readonly path: string;
      readonly pageCount: number;
      /** MinerU 系的产物路径。⚠️ 字段名与 MinerU 4.x 的实际产物一致：`structured_content.json` / `middle_json.json`（**没有 `content_list`** —— 那是 2.x 的产物名）。 */
      readonly markdownPath: string;
      readonly structuredContentPath?: string;
      readonly middleJsonPath?: string;
      /** 裁剪图目录（`images/`），⚠️ **必须与 markdown 同级保留** —— markdown 与 `imageSource` 都用相对路径引用它。 */
      readonly assetsDir?: string;
      /** sidecar 路径（v2 变体，见 §6.1.1）。 */
      readonly sidecarPath?: string;
      /** ⚠️ **归一化 bbox 的分母**（实测 595×842 pt）—— 消费方要画高亮框必须有它。 */
      readonly pageWidthPt?: number;
      readonly pageHeightPt?: number;
      /** 块级结构：bbox + 类型（文本 / 表格 / 图片 / 图表）。⚠️ **无置信度**；⚠️ **`type` 是开放集合且随档位变**。 */
      readonly blocks?: readonly OcrBlock[];
      /** ⚠️ **实际使用的档位**（从产物的 `extensions.mineru.tier` 回填，不是回填请求值）。 */
      readonly tier?: "flash" | "basic" | "standard" | "advanced";
      /** ⚠️ **降级的对外落点**：发生过降级时的上一档位。⚠️ 只写在人话 `metrics.warnings[]` 里的话，业务客户端机器读不到。 */
      readonly degradedFrom?: "flash" | "basic" | "standard" | "advanced";
    };

/**
 * MinerU 的块。
 * ⚠️ **bbox 是归一化坐标 0~1 的四点**（x0,y0,x1,y1），**不是像素**（tesseract 侧是像素）—— 换算的分母见 `OcrCapabilityOutput.engine.pageWidthPt/pageHeightPt`。
 * ⚠️ **无置信度字段**。
 * ⚠️ **`type` 是开放字符串，不是封闭枚举** —— 实测出现过 `text` / `paragraph_title` / `table` / `image` / `chart`，且**类型名随档位变**（同一张图 standard/flash 叫 `image`、advanced 叫 `chart`）。
 * ⚠️ **载荷随类型变** —— `text`/`paragraph_title` 只有 `{type,bbox,content}`（+`level`）；`table`/`image`/`chart` 多 `captions`/`footnotes`/`image_source`（+`sub_type`）。⇒ **schema 必须允许额外字段**；且**图片块的 `content` 是空字符串**（图片本体只由 `image_source` 指向）。
 */
export interface OcrBlock {
  /** 块类型（开放集合；未知类型必须原样保留，不得丢弃）。 */
  readonly type: string;
  /** 四点归一化 bbox（0~1）。 */
  readonly bbox: readonly [number, number, number, number];
  readonly content: string;
  /** 标题层级（`paragraph_title` 才有）。 */
  readonly level?: number;
  /** 图表类才有：指向裁剪图的相对路径（需与 sidecar 同级保留 `images/`）。 */
  readonly imageSource?: string;
  readonly captions?: readonly unknown[];
  readonly footnotes?: readonly unknown[];
  readonly subType?: string;
}
```

⚠️ **两者 bbox 粒度与单位都不同、置信度只有 tesseract 有** —— 消费方按 `engine` 字段分流，**不得假设字段齐全**：

| | tesseract | MinerU |
| --- | --- | --- |
| bbox 粒度 | **词级** | **块级** |
| bbox 单位 | **像素** | **归一化 0~1** |
| 置信度 | ✅ 每词有 | ❌ **没有** |

⚠️ **降级是任务级的**：一次任务只用一个引擎，产物形态由该引擎决定；**不中途换引擎**，不产生"半份 tesseract + 半份 MinerU"的混合产物（[`local-infra.md`](./local-infra.md) §5.1）。

## 4. 引擎端口

⚠️ **本节只覆盖 tesseract 一条路线**。MinerU 路线**不走这个端口** —— 它经 `LocalInfraPort`（[`local-infra.md`](./local-infra.md) §7.1），由本地基础设施层负责档位选择、执行、降级与产物收集。

**为什么分开**：`OcrEnginePort` 的契约是「给一张图，出**词级**文本层」；MinerU 的契约是「给一份文档，出**块级**结构」。两者形态不同，硬塞进一个端口会造出一个两边都不像的接口。**唯一共同的边界是能力层**（§3.3 按 `engine` 分流）。

⚠️ **档位选择与降级决定归 `LocalInfraPort`**，不在 `OcrEnginePort`、也不在能力层（[`local-infra.md`](./local-infra.md) §5.1）。

```ts
// apps/zcode-cli/packages/contracts/src/interfaces/ocr-engine.port.ts

/** 预处理步骤。顺序固定，与 `OcrPreprocessMode` 里的显式列表一致。 */
export type OcrPreprocessStep =
  | "grayscale"   // 去色彩：转灰度
  | "deskew"      // 图像纠正：倾斜校正
  | "illumination" // 去阴影 / 去背景：除法归一化
  | "despeckle"   // 去噪：连通域面积过滤
  | "binarize";   // 二值化：全局 Otsu

/**
 * 预处理模式。
 * - "auto"（默认）：按检测结果决定做哪几步 —— 目前**只做 deskew**，且仅当估计角 ≥ 0.5°
 * - "none"：完全不预处理，原图直接进引擎
 * - "full"：五步全做
 * - 显式步骤数组：按给定顺序执行（仍受各步的适用条件约束）
 */
export type OcrPreprocessMode = "auto" | "none" | "full" | readonly OcrPreprocessStep[];

export interface OcrEnginePort {
  /** 引擎是否可用；不可用时返回原因（供 `unavailable` 错误文案）。 */
  probe(options?: { signal?: AbortSignal }): Promise<OcrEngineProbeResult>;
  /** 识别一份文档，产出页级文本层。 */
  recognize(request: OcrEngineRecognizeRequest, options?: { signal?: AbortSignal })
    : Promise<OcrEngineRecognizeResult>;
}

export interface OcrEngineProbeResult {
  readonly available: boolean;
  readonly engine?: string;        // "tesseract"
  readonly version?: string;       // "5.5.1"
  readonly languages: readonly string[];
  readonly missingLanguages: readonly string[];
  readonly reason?: string;        // 不可用原因
}

export interface OcrEngineRecognizeRequest {
  readonly filePath: string;
  readonly pageNumbers: readonly number[];   // 空 = 全部页
  readonly languages: readonly string[];
  readonly dpi: number;
  readonly password?: string;               // 密码 PDF；仅内存传递，不落盘不入日志
  readonly trace: TraceContext;
}

export interface OcrEngineRecognizeResult {
  readonly pageCount: number;
  readonly pages: readonly OcrEnginePage[];
  readonly engine: string;
  readonly engineVersion: string;
}

export interface OcrEnginePage {
  readonly pageNumber: number;
  /** 整页文本（按识别顺序拼接，行内以空格分隔）。 */
  readonly text: string;
  /** 词级结果；conf 为 0~100 的浮点。 */
  readonly words: readonly OcrEngineWord[];
  /** 像素尺寸（渲染分辨率下的图像尺寸）。 */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly averageConfidence: number;
}

export interface OcrEngineWord {
  readonly text: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly confidence: number;   // 0~100
}

export type OcrEngineErrorCode =
  | "engine_unavailable"   // 没装 / 找不到可执行文件
  | "language_missing"     // 语言包没装
  | "unsupported_input"    // 不是 PDF / 图片
  | "password_protected"
  | "corrupted"
  | "process_failed"
  | "timeout"
  | "cancelled";
```

实现进 `apps/zcode-cli/packages/adapters/src/ocr/tesseract.ts`，经 `ExecutionPort` 跑子进程（**不**直接 `child_process`）。

### 4.1 图像预处理端口

预处理是**独立的端口**，不塞进 `OcrEnginePort` 里 —— 引擎端口只管「给一张图，出文本层」；预处理管的是「给一张图，出另一张图」。

```ts
// apps/zcode-cli/packages/contracts/src/interfaces/image-preprocess.port.ts
export interface ImagePreprocessRequest {
  /** 输入图路径（渲染产物或原图）。 */
  readonly sourcePath: string;
  /** 产物落盘路径。实现方决定格式（见 §5.1 的落盘约定）。 */
  readonly outputPath: string;
  /** 要执行的步骤，按数组顺序执行。 */
  readonly steps: readonly OcrPreprocessStep[];
  /** 分辨率。产物格式若无 DPI 元数据，调用方必须把这个值传给引擎（见 §5.1）。 */
  readonly dpi: number;
  readonly trace: TraceContext;
}

export interface ImagePreprocessResult {
  readonly outputPath: string;
  /** 实际生效的步骤（可能少于请求 —— 各步有适用条件，见 §5.1）。 */
  readonly applied: readonly OcrPreprocessStep[];
  /** 倾斜校正实际施加的角度（度，正 = 逆时针）。只有 deskew 可能给值。 */
  readonly skewAngle?: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export interface ImagePreprocessPort {
  preprocess(
    request: ImagePreprocessRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ImagePreprocessResult>;
}
```

实现进 `apps/zcode-cli/packages/adapters/src/ocr/preprocess.ts`（纯计算 + 文件读写，走既有文件系统入口；不 spawn 子进程）。

⚠️ **端口不接收"要做什么决定"**。`auto` / `none` / `full` / 显式列表的**判定在能力层**（⚠️ **2026-11-12**：按 [`capability-cli-blocks.md`](./capability-cli-blocks.md) D8，能力层落在 `packages/core/src/capability/`，**不新建** `packages/capabilities`）做，端口只执行给定步骤列表。这样端口是纯函数式的，好测；判定策略留在能力层，改策略不动端口。

⚠️ **`ImageProcessorPort` 不是这个**。已有的 `apps/zcode-cli/packages/contracts/src/interfaces/image-processor.port.ts` 是给**视觉模型**准备输入用的（缩放 + 压缩到 base64 预算内），语义是"让模型能吃下"，不是"让 OCR 读得更准"。两者不要合并，也不要复用它的 `resizeToFit` / `prepareForModel`。

## 5. 流水线

⚠️ **本节是 tesseract 路线**（逐页渲染 → 逐页预处理 → 逐页识别 → 拼页级文本层）。**MinerU 路线完全不同**：它是**文档级**引擎 —— 一次吃整份 PDF，输出 markdown + 块级结构，**没有逐页渲染、没有 ZCode 侧预处理、没有词级 bbox**。两条路线只在能力层汇合（§3.3 按 `engine` 分流），中间不共享任何一步（[`local-infra.md`](./local-infra.md) §5.1）。


```
输入文件
  │
  ├─ 扩展名判定
  │    .pdf → PDF 流水线
  │    .png/.jpg/.jpeg/.webp/.tif/.tiff/.bmp → 图片流水线
  │    其他 → unsupported_input
  │
  ├─ [PDF] pdfinfo → 总页数
  │    [PDF] pdftotext -layout → 按 \f 切页 → 每页文本
  │         └─ pages="auto" 时：文本字符数 < MIN_TEXT_CHARS_PER_PAGE(默认 8) 的页 → 列入待 OCR
  │
  ├─ 待 OCR 页（渲染）
  │    [PDF]  pdftoppm -r <dpi> -png -f <n> -l <n> <pdf> <prefix>
  │    [图片] 直接用原图（不再渲染）
  │
  ├─ 预处理（§5.1，插在渲染与识别之间）
  │    ├─ 判定要执行哪些步骤（能力层：auto / none / full / 显式列表）
  │    ├─ [deskew] 估计倾斜角 → |θ| ≥ DESKEW_MIN_ANGLE(0.5°) 才旋转
  │    └─ 有实质变化 → 落 PGM 产物；无变化 → 原图直接进识别（零重编码）
  │
  ├─ 识别（逐页）
  │    tesseract <page.png|page.pgm> <outbase> -l <langs> --psm <psm> --dpi <dpi> --tessdata-dir <dir> tsv
  │         ├─ <dir> = LocalAssetPort.resolveGroup("tessdata-zh-en")（**每次识别前重读**，见 model-assets.md §7）
  │         └─ 读 <outbase>.tsv → 筛 level==5 的词行 → 拼整页文本 + 算平均置信度
  │
  │    ⚠️ 产物存在性断言：TSV 文件不存在 → 判失败（退出码 0 不代表成功，见 §2 的 configs/ 坑）
  │
  └─ 产出 OcrEngineRecognizeResult
```

⚠️ **参数顺序**：`--psm`、`--dpi`、`--tessdata-dir` 都必须在 config 名（`tsv`）**之前**，与 §2 记录的 `-l` 顺序坑同源。

⚠️ **`--tessdata-dir` 必须显式带**：不能依赖系统 tessdata（`/opt/homebrew/share/tessdata`），否则用户机器上装了什么语言包版本就会污染结果，行为不可复现。语言包由 ZCode 托管（[`model-assets.md`](./model-assets.md)），路径在**每次识别前**解析。

**逐页识别，不合并**：tesseract 对多页 TIFF 支持不稳，且逐页能把 bbox 精确锚到 `page:N`。代价是每页一次进程启动（~0.3s），100 页约 30s + 渲染时间 → 用 `--max-concurrency` 并发（默认 2，避免 CPU 打满；tesseract 本身多线程）。

**bbox 单位**：识别图像的**像素**坐标，不是 PDF 点（1/72 inch）。sidecar 里同时记 `dpi`，消费方需要时可换算：`pt = px * 72 / dpi`。

⚠️ **bbox 是预处理后的坐标**：做了 deskew 之后图像尺寸与内容都变了（旋转会把画布四角的背景带进来）。sidecar 必须记**预处理后**的 `pixelWidth` / `pixelHeight` 与 `skewAngle`，消费方才知道这个 bbox 对应的是哪张图。

**整页文本拼接**：按 TSV 的 `line_num` 分行，行内词用空格连接，行间用 `\n`。**中文不加空格**（tesseract 的 chi_sim 词间本来就没空格；加空格会破坏后续 FTS 的 bigram 切分效果）。

### 5.1 图像预处理细则

**插入点**：渲染之后、识别之前。这一段是纯像素运算，不 spawn 子进程。

**五个步骤**

⚠️ **两组样本，两个基线 —— 别混用**。下文出现的 CER 数字来自两批不同样本：

| 组 | 样本 | deskew 后的基线 | 出现在 |
| --- | --- | --- | --- |
| **倾斜组** | 同一批中文样本的 2° / 5° 倾斜版 | **4.87%** | 本表 `deskew` 行 |
| **干净页组** | 0° 合成清晰页 | **4.58%** | §2 事实表、§5.1 阈值判断、§5.2 参数表 |

两组不能互相替换 —— 4.87% 与 4.58% 不是同一个量的两次测量。

⚠️ **本文所有 CER 均来自「合成清晰页」（含人工加的倾斜）**，**不是真实扫描件**。真实件的分布宽得多，这批数字测不出真实差距 —— 二期做 PP-OCR 对比的前提就是先攒真实件数据（见 §11.4 与 [`model-assets.md`](./model-assets.md) §14 第 1 条）。

| 步骤 | 做什么 | 算法 | 实测收益（CER，越低越好） |
| --- | --- | --- | --- |
| `grayscale` | 去色彩 | 亮度加权 `0.299R + 0.587G + 0.114B` | **0**（tesseract 内部本就灰度化；红字/蓝字/泛黄纸样本均已 100% 正确） |
| `deskew` | 图像纠正 | 投影锐度法（见下） | **决定性**（倾斜组）：5° 倾斜 100% → 4.87%；2° 倾斜 7.21% → 4.87% |
| `illumination` | 去阴影 / 去背景 | 块最大值估背景 → 除法归一化 `out = in × 255 / bg` | **0**（彩色底纹样本 17.23% → 17.23%；tesseract 自带的 Sauvola 反而做到 10.91%） |
| `despeckle` | 去噪 | 8 连通域标记 → 删面积 < 12 px 的孤立块 | **0** |
| `binarize` | 二值化 | 全局 Otsu 阈值 | **0** |

**结论（重要）**：**只有 `deskew` 是刚需，其余四步在本轮实测里全部零增益。** 它们的收益已被 tesseract 内建的二值化 / 去噪 / 灰度化覆盖 —— 更进一步，去阴影这类需求 tesseract 的 **Sauvola 自适应阈值**（`-c thresholding_method=2`）做得比我们自建的归一化更好（见 §5.2）。

**决策（用户已定）**：零收益的四步**保留在契约里，但默认不启用**。

因此：

- **`auto`（默认）只做 `deskew`**，且仅当估计角 `|θ| ≥ DESKEW_MIN_ANGLE`（0.5°）。低于 0.5° 校正前后 CER 相同（4.58% vs 4.58%），旋转只会引入重采样损失。
- 其余四步（`grayscale` / `illumination` / `despeckle` / `binarize`）**保留在契约里但默认不启用**，作为显式选项留给疑难件（用户可 `preprocess: "full"` 或显式列步骤）。不因为「实测无增益」就删掉能力 —— 真实扫描件的分布比合成样本宽；但**默认不替用户做没依据的事**。
- **不要**因为「去噪/去阴影听起来该做」就默认打开。这正是 §2 那三条零收益实测要挡住的。

**倾斜估计：投影锐度法（Postl）**

1. 解码 → 灰度（内存内中间表示，不落盘）。
2. 降采样到宽 1200 px（近邻采样，够用且快）。
3. Otsu 阈值 → 二值图（黑 = 文字）。
4. 粗搜：角度区间 `[-6°, +6°]`，步长 0.2°。
5. 细搜：在粗搜最优角 ±0.25° 内，步长 0.02°。
6. 候选角 θ 下：每一行按 `off = round((y - h/2) × tan θ)` 横向错位，把黑像素累加进列直方图；**得分 = 相邻列差分的平方和**（列投影越锐利 → 文本行越水平 → 得分越高）。
7. 取最高分的角度。

⚠️ **得分必须用「相邻差分平方和」，不能用「方差」**。方差版本对直方图零填充的长度敏感，同一张图换个 `bins` 长度就得出不同角度（实测稀疏文本页上偏差 +0.65°）。差分平方和只依赖被占用的列区间。

**旋转方向约定**：**正角 = 逆时针**（与 PIL `rotate` 同向）。估计出的角度就是图像当前的逆时针倾斜量，**校正时施加 `-θ`**。⚠️ 实测踩坑：最初实现的旋转方向与 PIL 相反，校正变成了**加倍倾斜** —— 表现为识别输出长度翻倍、CER 100%+。实现时必须写一个往返自检（转 +2° 再转 -2°，与原图的平均像素差应 < 5）。

**落盘格式**

| 情况 | 输入给 tesseract | DPI 来源 |
| --- | --- | --- |
| 未做任何实质预处理 | 原始 PNG（渲染产物或原图） | PNG 自带 pHYs（pdftoppm 写 300 DPI）→ 但**仍显式传 `--dpi`** |
| 做了预处理 | **PGM（P5）** | PGM 无元数据 → **必须传 `--dpi`**，否则 tesseract 估算成 560 |

选 PGM 的理由：手写 P5 头 + 原始像素落盘 ~13 ms vs jimp PNG 编码 ~410 ms（同为 2480×3508，约 **30 倍**）；且不需要额外的 PNG 编码器依赖。代价是每页约 8.9 MB 临时文件（识别完立即删）。

⚠️ **PGM 由适配器手写，不依赖 jimp**：jimp 1.6.1 的格式插件只有 bmp / gif / jpeg / png / tiff，**没有 PGM**。落盘格式固定为：

```
P5\n<width> <height>\n255\n<原始灰度字节>
```

`width` / `height` 用空格分隔、换行结尾、`255` 是最大灰度值，之后紧跟 `width × height` 个字节的原始像素。**注意 `P5` 是二值/灰度格式** —— 写入前必须先把像素归一到单通道 8 位灰度，不能直接塞 RGBA。

**性能预算**（300 DPI A4 单页）

| 阶段 | 耗时 |
| --- | --- |
| 解码 PNG（jimp） | ~80 ms |
| 灰度化 | ~30 ms |
| 倾斜估计 | ~200 ms |
| 旋转（双线性） | ~180 ms |
| 落 PGM | ~26 ms |
| **预处理合计** | **~520 ms** |
| tesseract 识别本身 | ~3~4 s |

预处理开销约为识别开销的 15%，可接受。

### 5.2 引擎参数（不是预处理，但同样决定质量）

| 参数 | 默认 | 为什么 |
| --- | --- | --- |
| `--psm` | **4**（单列文本，字号可变） | 默认 PSM 3 的自动版面分析会把「长行 + 多行中文页」误判成**多栏**，按列读出 → 实测 CER 70.69%；PSM 4 / 6 → 4.58%。PSM 4 比 PSM 6 更适合扫描件（允许标题/正文/印章字号不一） |
| `-c thresholding_method` | **1**（Leptonica Otsu） | 2 = Sauvola（局部自适应）。Sauvola 在**彩色底纹表单**上 17.23% → 10.91%，但在 5° 崩坏样本上反而更差（145% vs 100%）。→ **不做无条件默认**；需要处理彩色底纹时由用户显式选 2 |

⚠️ **这两个参数与预处理是两回事**：`--psm` 的收益（70.69% → 4.58%，干净页组）**远大于**整套预处理（倾斜组 7.21% → 4.87%）。如果只允许改一件事，改 `--psm`。

## 6. 放置约束（重要）

**`office-runtime` 不能跑 OCR。** 事实：`apps/zcode-cli/packages/office-runtime/src/` 里**没有** `child_process` 引用 —— 它是 MCP stdio server，不 spawn 子进程。而 OCR 必须 spawn tesseract。

**结论**：OCR 是**独立于解析层的能力**，位置如下：

```
zcode ocr parse --path <文件> --json
   │  （CLI 层：能力实现 → OcrEnginePort → adapters/tesseract → ExecutionPort → tesseract 子进程）
   ▼
写 sidecar：<源文件名>.zcode-ocr.json   ← 写在源文件旁（工作区内）
   │
   ▼
office-runtime 解析时读 sidecar（只读）→ 无文本层的页用 OCR 文本补上
```

⚠️ **2026-11-12 修订**：本节原用 `zcode cap run ocr --input ocr-request.json`，现改为族积木 `zcode ocr parse --path <文件>`。⚠️ **文件路径走 `--path`，不再走 `--input`**（`--input` 的能力输入 JSON 语义随 `zcode cap run` 一起作废，见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) D4）。

这样 office-runtime 保持**纯读 + 不 spawn**，OCR 也不必被塞进 office-runtime 的解析路径。

### 6.1 Sidecar 格式

> ⚠️⚠️ **2026-11-12：本节（tesseract 变体 `version: 1`）已作废**，§6.1.1 的 MinerU 变体（`version: 2`）**一并作废**。
> ⇒ **业务只认 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §6.2 的统一 sidecar `version: 3`**（引擎无关、页成分 + 元素位置 + 逐元素文字）。
> ⇒ 旧变体字段 → 统一字段的**映射表见该 spec §6.3**（`page`(1 基) → `pageIndex`(0 基)、`content` → `text`、`image_source` → `imagePath`、`engine.pageWidthPt/pageHeightPt` → 页级 `widthPt/heightPt`）。
> ⇒ **本节与 §6.1.1 保留作历史记录**，实施时**不得**按它们建模。

⚠️ **本节描述的是 tesseract 变体**。MinerU 变体见 §6.1.1 —— 两者**不是同一份 schema**。

路径：`<源文件目录>/<源文件名>.zcode-ocr.json`（例：`扫描件.pdf.zcode-ocr.json`）。

⚠️ **`<源文件名>` 含扩展名** —— 不是去掉扩展名的基名。`扫描件.pdf` → `扫描件.pdf.zcode-ocr.json`（不是 `扫描件.zcode-ocr.json`）。业务方拼路径时别搞错。

```json
{
  "version": 1,
  "source": {
    "path": "扫描件.pdf",
    "sha256": "…",
    "bytes": 4821003,
    "mtimeMs": 1762000000000
  },
  "engine": {
    "name": "tesseract",
    "variant": "tesseract",
    "version": "5.5.1",
    "languages": ["chi_sim", "eng"],
    "assets": { "tessdata-zh-en": "1.0.0" },
    "dpi": 300,
    "psm": 4,
    "thresholdingMethod": 1,
    "preprocess": {
      "mode": "auto",
      "applied": ["deskew"],
      "skewAngle": 2.01
    }
  },
  "strategy": "fill",
  "pages": [
    {
      "page": 1,
      "text": "合同纠纷案件编号 2024-001",
      "pixelWidth": 2480,
      "pixelHeight": 3508,
      "averageConfidence": 94.2,
      "words": [
        { "text": "合", "left": 42, "top": 75, "width": 60, "height": 60, "confidence": 96.4 }
      ]
    }
  ],
  "generatedAt": 1762000000000
}
```

- `source.sha256` 是**源文件内容**的哈希 → sidecar 与源文件不匹配时**作废**（源文件改了，OCR 结果不再有效）。
- `pages[].words` 可选（输入 `noWords: true` 时省略，体积从 MB 级降到 KB 级）。默认**保留**（RAG 的引用定位要 bbox）。
- `strategy` 记在 sidecar 里，消费方按它决定「填坑」还是「覆盖」。
- `engine.preprocess.applied` 是**该文档实际生效**的步骤（不是请求的步骤）。没做任何预处理时为空数组。
- `engine.assets` 记**语言包资产组 → 版本**（见 [`model-assets.md`](./model-assets.md)）。换语言包版本 → `engine` 块不同 → 旧 sidecar 不复用。这是既有复用判据（`source.sha256` + `engine` 块）的自然延伸，不需要额外机制。
- `engine.preprocess.skewAngle` 是**实际施加**的校正角（度，正 = 逆时针；即校正前图像的倾斜量）。同一份源文件换引擎参数重跑，sidecar 内容会变 → 消费方要按 `source.sha256` + `engine` 判断能否复用。
- `pages[].pixelWidth` / `pixelHeight` 是**预处理后**的图像尺寸（做了 deskew 会变）。

### 6.1.1 MinerU 变体

> ⚠️⚠️ **2026-11-12：本节（`version: 2`）已作废** —— 统一到 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §6.2 的 **v3**（映射表见该 spec §6.3）。
> ⚠️ **版本号不复用**：v1 = tesseract 变体、v2 = MinerU 变体，**都已废止**；统一格式走 **v3**，避免「version: 1」同时指两种不兼容的 schema。
> ⇒ 本节保留作历史记录，实施时**不得**按它建模。

⚠️ **MinerU 的产物形态与 tesseract 不同**（块级 vs 词级、有类型无置信度），**硬塞进 §6.1 的 schema 会造出第三种"两边都不像"的格式**。

⇒ 决策：**sidecar 加 `version: 2`，用 `engine.variant` 区分两种形态**；消费方按 `variant` 分流（分流规则的**权威定义在本表**，不是 `local-infra.md` §7.5 —— 那边只有端口层契约，没有 sidecar 概念）。

MinerU 变体的关键差异：

| 字段 | tesseract 变体（v1） | MinerU 变体（v2） |
| --- | --- | --- |
| `engine.name` | `"tesseract"` | `"mineru"` |
| `engine.variant` | `"tesseract"` | `"mineru"` |
| `engine.version` | tesseract 版本 | MinerU 版本 |
| `engine.tier` | —（无档位概念） | `"flash"` / `"basic"` / `"standard"` / `"advanced"`（**四档**，官方枚举见 [`local-infra.md`](./local-infra.md) M11；⚠️ 不得硬编码三档） |
| 文本粒度 | `pages[].text`（整页）+ `pages[].words[]`（**词级** bbox + 置信度） | `blocks[]`（**块级** bbox + 类型） |
| **块类型集合** | —（只有 text 概念） | ⚠️ **开放集合且随档位变**：实测 `text` / `paragraph_title` / `table` / `image` / **`chart`**（advanced 把图叫 `chart`、standard 叫 `image`）⇒ **不能用封闭枚举**，未知类型原样保留 |
| **块载荷字段** | — | ⚠️ **随类型变**：`text`/`paragraph_title` = `{type,bbox,content}`(+`level`)；`table`/`image`/`chart` 多 `captions`/`footnotes`/`image_source`(+`sub_type`) ⇒ **schema 要允许额外字段**；⚠️ **图片块的 `content` 是空串** |
| **bbox 单位** | ⚠️ **像素**（记 `pixelWidth/pixelHeight/dpi`） | ⚠️ **归一化 0~1 的四点**（x0,y0,x1,y1）—— 与 tesseract **单位不同**，消费方必须按 `variant` 区分；**分母是 `pageWidthPt/pageHeightPt`** |
| 置信度 | ✅ 每词有 | ❌ **没有** —— 消费方不得假设存在 |
| `strategy` | ✅ 有（fill / override） | ❌ **没有** —— MinerU 不区分，v2 固定 `"override"` 语义（整份替换） |
| `engine.preprocess` | ✅ 有（纯 JS 预处理） | ❌ **没有** —— 预处理在 MinerU 内部完成，ZCode 不可见 |
| `engine.assets` | ✅ 语言包资产组 → 版本 | ⚠️ MinerU 模型仓库 → 版本（`<tier>` + `<small-backend>` + `<vlm-engine>` 组合） |

⚠️ **没有存量消费者**（本条线的 spec 全部未实现），所以这次契约变更**不需要对外版本递增**，但**必须显式记录版本号**（`version: 2`）并让消费方按 `engine.variant` 分流。

**MinerU 变体（v2）示例 JSON** —— ⚠️ 上一版只给了差异表、没有示例，导致 `source` 在不在、`blocks` 在顶层还是在 `pages[]` 下、`generatedAt` 在不在全无定义：

```json
{
  "version": 2,
  "source": {
    "path": "扫描件.pdf",
    "sha256": "…",
    "bytes": 4821003,
    "mtimeMs": 1762000000000
  },
  "engine": {
    "name": "mineru",
    "variant": "mineru",
    "version": "4.1.7",
    "tier": "basic",
    "pageWidthPt": 595.0,
    "pageHeightPt": 842.0
  },
  "strategy": "override",
  "pages": [
    {
      "page": 1,
      "text": "（该页各 text 类块的 content 按顺序拼接）",
      "blocks": [
        { "type": "text", "bbox": [0.096, 0.366, 0.889, 0.658], "content": "合同纠纷案件编号 2024-001" },
        { "type": "paragraph_title", "bbox": [0.1, 0.2, 0.3, 0.22], "content": "证据材料一", "level": 2 },
        { "type": "table", "bbox": [0.098, 0.223, 0.858, 0.325], "content": "…",
          "captions": [], "footnotes": [], "image_source": "images/page_0_table_5.jpg" }
      ]
    }
  ],
  "generatedAt": 1762000000000
}
```

⚠️⚠️ **v2 的 `pages[].text` 只能由 blocks 聚合得到** —— MinerU 的 `markdown.md` **没有页锚点**（实测 4 个产物 `<!--` 计数全 0），**不能**从 markdown 切页。

⚠️ **`engine.pageWidthPt` / `pageHeightPt` 是 bbox 的分母**（来自 `extensions.docvortex_layout.pages[]`，实测 595×842 pt）—— ⚠️ **必须有它，消费方才能把归一化 bbox 换算成像素**。tesseract 变体记的是 `pixelWidth/pixelHeight/dpi`，**两个变体要对齐**（R9）。

⚠️ **`blocks[]` 的 `type` 是开放字符串** —— 实测出现过 `text` / `paragraph_title` / `table` / `image` / **`chart`**，且⚠️ **类型名随档位变**（同一张图 standard/flash 叫 `image`、advanced 叫 `chart`）⇒ schema **不能**用封闭枚举。

⚠️ **`blocks[]` 的载荷随类型变** —— `text`/`paragraph_title` = `{type,bbox,content}`（+`level`）；`table`/`image`/`chart` 多 `captions`/`footnotes`/`image_source`（+`sub_type`）⇒ schema **必须允许额外字段**。且⚠️ **图片块的 `content` 是空字符串**（图片本体只由 `image_source` 指向）。

⚠️ **`source.sha256` 是两个变体共有的失效判据**（§6.1 与本节的 `source` 块同构）—— 知识索引（§6.4）按它判 sidecar 是否作废，这条**对两个变体都成立**。

⚠️ **降级不是 sidecar 的一种形态**：一次任务只用一个引擎，sidecar 的 `engine` 块如实记实际用的那个。**不产生混合产物**（[`local-infra.md`](./local-infra.md) §5.1）。

### 6.2 office-runtime 接入

改动点（`apps/zcode-cli/packages/office-runtime/`）：

1. `src/adapters/files.ts` 的 `WorkspaceFiles` 增一个只读辅助方法：

   ```ts
   /** 读一个工作区内的辅助文件（如 OCR sidecar）；不存在返回 undefined。 */
   readAuxiliary(path: string): Promise<{ bytes: Uint8Array; mtimeMs: number; size: number } | undefined>;
   ```
   不做文档类型校验（sidecar 是 `.json`，不是文档），但仍做**工作区边界检查 + 大小上限**（默认 16 MiB）。

2. `src/adapters/files.ts` 的 `fingerprint(path)` 扩展：文档的指纹由 `size:mtime` 改为 `size:mtime:sidecarSize:sidecarMtime`（sidecar 不存在则记 `0:0`）。**否则新写的 sidecar 不会让已缓存的解析失效** —— 这是接入里最容易漏的一环。

3. `src/adapters/main.ts` 的 `parse(file)` 闭包：解析前读 sidecar（`readAuxiliary`），解析后传给 parser。

4. `src/adapters/parsers.ts` 的 `ParseFormat` 签名扩一个参数：

   ```ts
   export type ParseFormat = (
     bytes: Uint8Array,
     path: string,
     pdfAssets: PdfAssets,
     auxiliary?: ParsedAuxiliary,   // 新增
   ) => Promise<ParsedDocument>;
   ```

   ⚠️ **`ParsedAuxiliary` 是新类型**，仓库里目前没有（`ParsedDocument` 在 `#office/domain/model.ts`，`PdfAssets` 在 `#office/adapters/parse/pdf.ts`）。定义放 `src/domain/model.ts`（与 `ParsedDocument` 同处）：

   ```ts
   // apps/zcode-cli/packages/office-runtime/src/domain/model.ts
   /** 解析器可选接收的辅助输入（当前只有 OCR sidecar）。 */
   export interface ParsedAuxiliary {
     /** 来源标记，便于解析器区分不同辅助来源（如 "ocr-sidecar"）。 */
     readonly kind: "ocr-sidecar";
     /** 页号（1 基）→ 该页的 OCR 文本。页码与 PDF 页码一一对应。 */
     readonly pagesByNumber: Readonly<Record<number, string>>;
     /** 填充策略："fill" = 文本层优先、无文本层才用 OCR；"override" = OCR 覆盖文本层。 */
     readonly strategy: "fill" | "override";
   }
   ```

   ⚠️ **`ParseFormat` 从 3 参变 4 参是**破坏性签名变更**：`PARSERS` 里 docx / pdf / pptx / xlsx **四个** parser 都得跟着改签名（新增参数是可选的 → 现有实现只需加一个未使用参数，不用改逻辑），但 `PARSERS` 的类型标注会重新检查全部四个 → **编译期会一次性暴露所有需要动的点**，这是好事，别用 `as any` 绕过去。

   ⚠️ **`ParsedAuxiliary` 只放已解析好的数据，不放 sidecar 的原始 JSON** —— parser 是纯函数（只拿到 bytes 就不能读文件），它拿到的必须是**调用方已读好并解析好的**内容。

5. `src/adapters/parse/pdf.ts` 的 `parsePdf` 接 `auxiliary`：
   - 逐页取 pdf.js 的文本层；
   - 文本层为空时，取 sidecar 里对应页的 OCR 文本（⚠️ **v3 的页文本由 `elements[]` 的文本类元素 `text` 顺序拼接得到**，见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §6.3）；
   - 两者都无 → 保持现状的 `"(no extractable text; the page may be scanned)"`；
   - OCR 文本**不覆盖** outline（书签是 PDF 自身的，比 OCR 准）。

   ⚠️ `parsePdf` **不能**自己读文件（它只拿到 bytes）→ sidecar 的读取责任在 `main.ts` 的调用方，parser 只收已读好的数据。这条边界不能破（parser 保持纯函数，好测）。

6. **只有 pdf 解析器受影响**。docx / xlsx / pptx 本来就有文本层，不接 sidecar。

### 6.3 锚点

office-runtime 的锚点是 `page:N`（**1 基**）。⚠️ **统一 sidecar v3 的 `pages[].pageIndex` 是 0 基** ⇒ 换算：`page:N` ↔ `pageIndex = N - 1`（[统一格式的映射表](./capability-cli-blocks.md) §6.3 已写死）。词级 bbox 是**页内像素坐标**，不是 office-runtime 锚点体系的一部分（`Locator` 只到页/段/单元格粒度）。若将来需要 bbox 级锚点，另写 spec 扩 `Locator`。

### 6.4 sidecar 也是本地知识库的索引源

⚠️ **统一 sidecar v3 怎么填 `pagesByNumber`**：v3 **不存页级文本**（只存**逐元素**的 `text`）⇒ 消费方按 `elements[]` 顺序拼接文本类元素的 `text` 得到该页文本。`pagesByNumber` 的内容语义 = **该页的纯识别文本**（不含版面结构）—— ⚠️ 与已废止的 MinerU 变体（v2，页级 markdown 文本）语义**不同**，迁移时注意。

客户端本地知识库（[`knowledge-rag.md`](./knowledge-rag.md)）把扫描件 PDF 的 OCR 文本作为索引来源，锚点同样是 `page:N`。**优先级规则**：同一 PDF 同时有文本层与 sidecar → **用文本层**（更准更全），sidecar 只在抽不出文本层时兜底；两者不合并。

sidecar 的 `source.sha256` 不匹配（源文件已改）→ 该 sidecar 作废，索引器按「无文本层」处理，不采信过期文本。

### 6.5 对外交付形态（已定）

> ⚠️ **2026-11-12 修订**：本节原写「子进程调 `zcode cap run ocr`」。用户拍板 **CLI 是交给业务调用的积木**，业务拿原子命令自己封装场景逻辑 ⇒ **不再有 `zcode cap run` 通用入口**，业务调的是**族命令组积木**（`zcode ocr inspect` / `zcode ocr parse`）。
> 完整形态见 [`capability-cli-blocks.md`](./capability-cli-blocks.md)（D1 / D4 / D5 / §8）。本节其余内容（sidecar 是共用产物、引擎不下放给业务方、同机部署的三个要求）**继续有效**。

**决策（用户已定）**：业务客户端与 ZCode **同机**（装在用户机器上），通过**子进程调族命令组积木**（`zcode ocr inspect` / `zcode ocr parse`）消费 OCR 能力。

**结论：引擎与预处理归 ZCode 维护，业务客户端不持有任何 OCR 实现代码。** 业务方只依赖三样东西：

| 依赖物 | 位置 | 稳定性承诺 |
| --- | --- | --- |
| **CLI 输出信封** | `zcode ocr parse --json` 的 stdout | 业务方会写代码解析 → **对外公共契约**，见 [`capability-registry.md`](./capability-registry.md) §8 |
| **退出码** | §8 那张表 | 业务方靠它判断成功 / 失败 / 取消 → **对外公共契约** |
| **sidecar 文件** | `<源文件名>.zcode-ocr.json` | 业务方与 `office-runtime` **共用同一份产物** → 一份 OCR 结果两个消费者，不重复识别 |

**为什么引擎层不下放给业务方**：引擎参数与预处理是踩坑密集区（§2 的实测表）—— PGM 无 DPI 元数据、必须显式 `--psm 4`、投影得分要用差分平方和不能用方差 —— **业务方自己实现一遍就要把同样的坑重踩一遍**，而且 tesseract 版本升级、参数调整要各自跟进。放在 ZCode 一处维护，业务方只升级 zcode 即可。

⚠️ **但 sidecar 格式不随实现变**。即使将来引擎层被下放（比如业务方改用私有 OCR 集群），sidecar 字段语义一个字不改 —— `office-runtime` 只认 sidecar，不关心它是谁生成的。这是跨实现的稳定边界。

**同机部署带来的三个具体要求**

1. **tesseract + poppler 的安装责任在用户机器上**。ZCode 不内置引擎二进制（§9），因此 `zcode ocr parse` 失败时**最常见**的原因是 `engine_unavailable`。→ 错误文案必须直接给出安装命令（§8 已写），业务方可以直接把 zcode 的 stderr 转给用户。
2. **zcode 可执行文件的定位由业务方负责**。zcode 侧**不新增环境变量**（AGENTS.md：能用配置 / 旗标表达的优先不做环境变量）；业务方自行决定用配置文件还是进程环境变量把 zcode 路径传进来。
3. **sidecar 是磁盘缓存，不只是接口**。业务方重复调 `zcode ocr parse` 处理同一文件时，应当命中 sidecar 而不重跑识别 —— ⚠️ **有效性判据与接力矩阵以 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §6.5 为准**（内容指纹 `source.sha256` + 档位判据 + 积木所需产物判据；**参数变了 sidecar 就不该复用**）。→ **「源文件没变就跳过识别」这条捷径由 zcode 内部做**（业务方只管调），已定，见 §11 第 10 条。

⚠️ **子进程路线在批量场景下的成本**：每次调用付一次 node 启动（~200-400 ms）+ 一次引擎探测。业务方处理一个案卷（几十个 PDF）时逐个 spawn 会重复付这笔钱，而真正的大头 tesseract 单页 3~4 s 反而是叠加的。→ 是否支持一次调用处理多个文件 → §11 第 9 条。

## 7. 状态所有者

> ⚠️⚠️ **2026-11-12：本表与下面的 owner 图是 tesseract 时代的产物，多数行指向已不存在的包 / 文件**（`packages/capabilities`、`adapters/src/ocr/*` —— tesseract 兜底路线在 v1 不实现，见 §11 第 4 条）。⇒ **保留作历史记录，不得按它们建模**。
> ⇒ **当前有效的层位划分以 [`capability-cli-blocks.md`](./capability-cli-blocks.md) D8 为准**：契约 `contracts/src/capability-blocks/` → 实现 `core/src/capability/` → 适配 `adapters/src/local-infra/` → 装配 `bootstrap/` → CLI `cli/src/ocr/`。
> ⇒ **本表剩余的 tesseract 时代清理**（把每行改成 D8 的路径）留作独立议题，不在本轮范围。

| 状态 / 事件流 | 唯一所有者 | 备注 |
| --- | --- | --- |
| **MinerU 的引擎可执行文件定位 / 档位选择 / 降级决定 / 产物收集** | **`apps/zcode-cli/packages/adapters/src/local-infra/`**（[`local-infra.md`](./local-infra.md)） | ⚠️ **能力层不自己探环境、不自己选引擎** —— 档位与降级归 `LocalInfraPort`（§4 开头） |
| tesseract 路线可用性与版本探测 | `apps/zcode-cli/packages/adapters/src/ocr/tesseract.ts` 的 `probe()` | 每次运行探测一次，结果缓存到本次进程 |
| **`ocr.*` 配置键（`enginePath` / `popplerPath` / `mineruPath` / `mineruProxy`）** | **配置 schema（`adapters/src/config/schema.ts`）** | ⚠️ `ZCodeConfigFileSchema` 当前**无 `ocr` 段** ⇒ 必须**先加段、再加 `.pick()` 白名单**，顺序反了 zod v4 会在 import 时抛 `Unrecognized key` ⇒ **整个 CLI 启动即死**（[`local-infra.md`](./local-infra.md) §7.7） |
| 渲染与识别的子进程调度 | `ExecutionPort` | 超时 / 取消 / 输出截断由既有执行入口统一管 |
| TSV → 结构的归一 | `apps/zcode-cli/packages/adapters/src/ocr/tsv.ts` | 纯函数：TSV 文本 → `OcrEnginePage[]`，最好测 |
| **预处理步骤的判定（auto / none / full / 显式列表）** | `apps/zcode-cli/packages/capabilities/src/capabilities/ocr.ts` | 能力层决定「做哪几步」；端口只执行 |
| **像素运算本身（灰度 / 估角 / 旋转 / 归一化 / 去噪 / 二值化）** | `apps/zcode-cli/packages/adapters/src/ocr/preprocess.ts` | 纯计算 + 文件读写；不 spawn 子进程 |
| **预处理临时产物（PGM）** | `apps/zcode-cli/packages/adapters/src/ocr/preprocess.ts` | 识别完立即删；不落工作区、不进 sidecar |
| 逐页并发调度 | `apps/zcode-cli/packages/capabilities/src/capabilities/ocr.ts` | worker pool，与 `recognize-command.ts` 同范式 |
| **sidecar 写入** | `apps/zcode-cli/packages/adapters/src/ocr/sidecar-store.ts` | ⚠️ **不落在能力层** —— 能力层只发「写这个 sidecar」的指令，实际落盘经 `FileSystemPort` 完成（原子写：先写临时文件再 rename） |
| **sidecar 读取 + 缓存失效** | `apps/zcode-cli/packages/office-runtime/src/adapters/files.ts` | 只读；`fingerprint` 含 sidecar 大小与 mtime |
| 页文本的补齐（文本层 vs OCR） | `apps/zcode-cli/packages/office-runtime/src/adapters/parse/pdf.ts` | 解析层的唯一决策点 |
| **引擎调用与预处理算法本身** | **`apps/zcode-cli/packages/adapters/src/ocr/`** | **业务客户端不持有实现**，只消费 CLI 信封 + sidecar（§6.5） |
| **语言包资产（tessdata）的获取 / 校验 / 切换** | `apps/zcode-cli/packages/adapters/src/local-assets/`（[`model-assets.md`](./model-assets.md)） | 资产层只管文件，不碰引擎 |
| **tessdata 路径的解析** | OCR 能力层调 `LocalAssetPort.resolveGroup()` | ⚠️ **每次识别前解析，不缓存** —— 缓存会让「切换在调用前生效」落空（`model-assets.md` §7）。⚠️ **只对 tesseract 路线**；MinerU 路线不碰 tessdata（v1 不涉及资产层） |
| **「什么时候 OCR / 结果去哪 / 要不要重试复核」** | **业务客户端** | 纯业务决策，不进 ZCode 契约 |

**执行链路与 owner 图**（一次 `zcode ocr parse` 的完整时序）

```
业务客户端
  │  argv: ocr parse --path <文件> --json
  ▼
CLI 层 (apps/zcode-cli/packages/cli/src/ocr/parse-command.ts)
  │  解析 --path / --tier / --output / --pdf-password（组合校验，zod）
  ▼
积木层 (apps/zcode-cli/packages/core/src/capability/)
  │  ① 判定路线（PDF 原生分析 / 识别）        ← 唯一的编排点
  │  ② 能力供给层决策：档位就绪？未就位则备资产 / 降级
  │  ③ 命中 sidecar 缓存？→ 直接返回 cached:true
  ├──────────────────────────────┐
  ▼                              ▼                              ▼
adapters/local-infra/         adapters/pdf/                adapters/local-assets/
MinerU 路线：档位 / 产物收集    原生路线：文本层 + 图片对象      只提供文件
  │                              │
  ▼                              ▼
adapters/port-wiring 装配 → EnginePort / PdfDocumentPort
  │
  ▼
统一 sidecar v3 写入（FileSystemPort，原子写：先写临时文件再 rename）
  │
  ▼
工作区：<源文件名>.zcode-ocr.json        office-runtime（只读消费）
```

**事件顺序约束**

1. **子进程永远在端口后面**：能力层调 `OcrEnginePort`，adapter 才 spawn tesseract。能力层**不得**直接 `child_process`。
2. **tessdata 路径必须在调用前解析**（事件 ①），且**每次调用都重读** —— 资产切换「在调用前生效」，缓存会让切换落空。
3. **产物断言在子进程退出码 0 之后**：断言的是 `<outbase>.tsv` 存在且非空，不是「目录里有文件」。
4. **sidecar 写入在全部页处理完之后**（一次写，避免半截产物）。
5. **sidecar 写入走 `FileSystemPort`**，不落在能力层；sidecar 的**读**由 `office-runtime` 单独负责 —— **两个方向，同一个格式，两个 owner**。
6. **输出校验在投影层返回前**：`ok` / `error` / 退出码由 CLI 投影层产生，能力层只产出结果对象。

**避免的反模式**

- 不在 `office-runtime` 里 import tesseract adapter（跨进程，越界）。
- 不在 parser 里读文件（保持 parser 纯）。
- 不把 OCR 文本写回源 PDF（源文件不可改）。
- 不在 CLI 层缓存 OCR 结果（缓存由 sidecar 承担，sidecar 本身就是磁盘缓存）。
- **不把预处理步骤塞进 `OcrEnginePort`** —— 引擎端口的职责是「图 → 文本层」，塞进像素处理会让它既依赖图像库又依赖 tesseract。
- **不把 `auto` 的判定逻辑放进 preprocess 端口** —— 判定策略会随实测结论变，放端口里等于把策略焊死在像素运算上。
- **不因为「去噪/去阴影听起来该做」就默认打开** —— §5.1 的三条零收益实测就是挡这个的。

## 8. 错误语义与退出码

⚠️ **对外只有一套错误码**：`CapabilityErrorCode`（[`capability-registry.md`](./capability-registry.md) §3，8 个值）。引擎层的 `OcrEngineErrorCode`（§4）是**内部码**，一律归一到能力码，原始码放 `details.engineCode`。

| 情形 | 引擎层码 | **对外 `error.code`** | CLI 退出码 | 说明 |
| --- | --- | --- | --- | --- |
| tesseract 不可用（没装 / 不在 PATH / `--engine` 指错） | `engine_unavailable` | `unavailable` | `1` | `hint` 给装法：`brew install tesseract` / `apt install tesseract-ocr`；`details.engineCode = "engine_unavailable"` |
| 语言资产缺失（要 chi_sim 但只有 eng） | `language_missing` | `unavailable` | `1` | **语言资产由 ZCode 托管**（[`model-assets.md`](./model-assets.md)）→ 提示 `zcode asset install tessdata-zh-en`，不再让用户去装 tessdata-lang；`details.missingLanguages` |
| **语言资产组未安装 / 未激活** | 资产层 `not_found` | `unavailable` | `1` | 同样指向 `zcode asset`；`details.assetCode` / `details.group` |
| **TSV 产物缺失但退出码为 0** | `process_failed` | `internal` | `1` | 回归 §2 的「缺 `configs/` → 静默失败」坑 → adapter 必须**专门断言 `<outbase>.tsv` 存在且非空**（tesseract 会退回写出 `.txt`，只查「有文件」会误判成功） |
| 引擎在但 `probe` 返回可用，跑起来却失败 | `process_failed` | `internal` | `1` | `details.engineCode` + stderr 尾（**不含路径里的凭据**，本命令无凭据） |
| 输入不是 PDF / 图片 | `unsupported_input` | `unsupported_input` | `1` | |
| 文件损坏 | `corrupted` | `invalid_input` | `1` | `details.engineCode = "corrupted"` |
| 密码 PDF 且未给密码 | `password_protected` | `invalid_input` | `1` | `hint` 说明用 `--pdf-password`；**密码只经 argv 传递，不落盘、不入日志**（沿用 `pdf-document.port.ts` 的约定）。✅ **2026-11-12 已实施**（[`capability-cli-blocks.md`](./capability-cli-blocks.md) v2.2）：端口在**调引擎前**用 poppler 探加密状态 ⇒ **未给密码直接报这个码，不空跑一次引擎**；解密路线见 §3.2.1 |
| 某页识别失败（渲染失败 / tesseract 非零退出） | — | — | — | **不中断整批**：该页记为失败，其余页继续；最终若**全部**页失败才报错 |
| **预处理失败**（解码失败 / 估角异常 / 写 PGM 失败） | — | — | — | **降级**：跳过预处理，把原图直接交给引擎，该页记一条 warning。预处理是**增益**不是**前提**，不该因为它把整页 OCR 拖垮 |
| 用户取消 | `cancelled` | `cancelled` | `130` | |
| 超时 | `timeout` | `timeout` | `124` | 单页超时上限默认 120s，整批上限默认 30min |

**MinerU 路线补充**（引擎层码见 [`local-infra.md`](./local-infra.md) §7.6）：

| 情形 | 引擎层码 | **对外 `error.code`** | CLI 退出码 | 说明 |
| --- | --- | --- | --- | --- |
| MinerU 没装 / 跑不起来 | `engine_unavailable` | `unavailable` | `1` | `hint` 给装法（`uv tool install "mineru>=4.0,<5"`）；**用户自装，ZCode 不代装**（[`local-infra.md`](./local-infra.md) §3.1） |
| 显式档位不可用 | — | **不报错** | `0` | **降级 + 告知**：降到可用档位重跑一次，原因写进 `metrics.warnings[]`（[`local-infra.md`](./local-infra.md) §5.2） |
| MinerU 退出码 0 但**产物缺失** | `artifact_missing` | `internal` | `1` | ⚠️ **不得当成功** —— 与上面 TSV 那行同一个坑 |
| **加密 PDF，给了密码但密码被拒** | `password_protected` | `invalid_input` | `1` | poppler 解密阶段就拒了（密码错 / 只设了 owner 密码）；`hint` 说明密码可能被拒。⚠️ 引擎自己**认不出**这个情形（它只会报 PDFium 的 `Incorrect password`）⇒ 由 ZCode 侧判定（§3.2.1） |
| **加密 PDF，给了密码且解密成功** | — | **不报错** | `0` | ZCode 侧前置解密（§3.2.1）：引擎拿到的是**临时无密副本**，解析完即删 |

⚠️ **降级不是错误**：档位降级属"可用优先"（D3），走 `metrics.warnings[]` + 成功退出，**不进 `error`**。只有"全链都不可用"才是 `unavailable`。

**部分成功**：命令整体 `ok: true`，但 `output.ocrPages` / `skippedPages` 里能看出哪些页没成，失败页进 `metrics.warnings`。**不要**因为一页失败就整批报错 —— 100 页扫描件里挂 1 页，其余 99 页的文本仍然有用。

⚠️ **这张表是对外公共契约**。交付形态已定为「业务客户端同机 + 子进程调 CLI」（§6.5），业务方会写代码按退出码分支。→ 退出码与错误码的语义**不得随意改**；要改必须与业务方同步，并按 `capability-registry.md` §8 的信封 `version` 走版本递增。

## 9. 跨平台

| 关注点 | 处理 |
| --- | --- |
| 可执行文件 | `tesseract` / `tesseract.exe`；通过 `--engine` 或设置 `ocr.enginePath` 指定绝对路径；不硬编码路径 |
| PATH 查找 | 优先 `--engine` > 设置 `ocr.enginePath` > PATH 里的 `tesseract`。**不新增环境变量**（AGENTS.md：能用旗标/配置表达的优先不做环境变量） |
| poppler | `pdfinfo` / `pdftoppm` / `pdftotext` 同理：`ZCODE` 设置里给 `ocr.popplerPath` 目录；Windows 常见为 `C:\Program Files\poppler\Library\bin` |
| 路径空格 | 一律用 `ExecutionPort` 的 `mode: "argv"` + 参数数组，**不**拼 shell 字符串 |
| 临时目录 | 用 `node:os.tmpdir()` + `mkdtemp`，不硬编码 `/tmp` |
| 换行 | TSV 解析按 `\r\n` / `\n` 都能切 |
| 编码 | TSV 读成 UTF-8；tesseract 输出是 UTF-8 |
| 字体 | 只影响**测试语料**生成，不影响生产路径 |

**剩余风险**：Windows 上 `tesseract` 与 poppler 默认不进 PATH → 首跑大概率 `engine_unavailable`。这是**明确的环境缺失错误**，不是静默降级；本 spec 不内置引擎二进制（体积 + 许可 + 打包复杂度），装法写进提示文案。

### 9.1 MinerU 路线的跨平台要点

| 关注点 | 处理 |
| --- | --- |
| 可执行文件 | `mineru` / `mineru-kit`；查找顺序 = 配置键 `ocr.mineruPath` > PATH > 常见 venv 位置（`~/.local/bin`、项目 `.venv/bin`、Windows 的 Python `Scripts`、uv/pipx shim 目录）。⚠️ **官方 uv 装法把可执行文件放在 venv 的 `bin/` 里，通常不在 PATH**（[`local-infra.md`](./local-infra.md) §7.7） |
| Python 版本 | MinerU 4.x 要求 `>=3.11,<3.15`（官方推荐 3.12）。**Windows + 3.13 曾有 ray 依赖不兼容的记录** |
| 服务传输 | 只用 TCP（`MINERU_DOCLIB_TCP_ENABLED=1` + `MINERU_DOCLIB_TCP_PORT=0` 由 MinerU 分配端口）。⚠️ **不用 UDS** —— UDS 在 Windows 上不可靠（[`local-infra.md`](./local-infra.md) §6.3.2） |
| **代理环境变量** | ⚠️ **实测踩坑**：`ALL_PROXY` / `http_proxy` / `https_proxy` 指向 SOCKS 代理时，MinerU 的 httpx 会因缺 `socksio` 直接失败（`Using SOCKS proxy, but the 'socksio' package is not installed`）。ZCode spawn MinerU 时**必须显式决定代理环境**（剥离或保留），不能默认继承 —— 与 [`model/http-proxy.md`](./model/http-proxy.md)「不继承 `HTTP_PROXY` / `HTTPS_PROXY`」的既有纪律一致 |
| 模型源 | 直连 HuggingFace 在国内通常不通，ModelScope 可直连。下载源要可指定（`--source modelscope`），否则用户会卡在超时 |
| 凭据 | MinerU 的本地 token 存在自己的 config 里，**ZCode 不读、不记、不日志**（AGENTS.md 凭据纪律） |

## 10. 验收

**工程测试 —— 按包的真实入口跑**：

⚠️ **`pnpm test:engineering <file>` 到不了这些测试**。根 `vitest.config.ts` 的 `engineering` project 的 `include` 是 `scripts/engineering-test-files.json` 的**显式清单**（158 条），其中 **`apps/zcode-cli/**` 与 `packages/shared/**` 各 0 条**。而且它匹配不到文件时**不报错**（只打印 "No test files found"）→ **门禁形同虚设**。各包的真实入口：

| 包 | 入口 | 新增测试文件要做什么 |
| --- | --- | --- |
| `apps/zcode-cli/packages/contracts` | `pnpm --filter @zcode/contracts test`（= `vitest tests`） | 放进 `packages/contracts/tests/` |
| `apps/zcode-cli/packages/core` | `pnpm --filter @zcode/core test`（= `vitest tests`） | 放进 `packages/core/tests/` |
| `apps/zcode-cli/packages/adapters` | `pnpm --filter @zcode/adapters test`（= `vitest tests`） | 放进 `packages/adapters/tests/` |
| `apps/zcode-cli/packages/capabilities` | **待定**（新包，需在 `package.json` 建 `test` 脚本） | 建包时一并建 `vitest tests` 入口 |
| `apps/zcode-cli/packages/cli` | `pnpm --filter @zcode/cli test`（= `node --test` + **显式文件清单**） | ⚠️ **必须把新测试文件加进 `packages/cli/package.json` 的 `scripts.test` 文件列表**，否则不会被跑 |
| `apps/zcode-cli/packages/office-runtime` | `pnpm --filter @zcode/office-runtime test` | 按其 `package.json` |

**测试分两组**：**纯函数组**（TSV 归一、命令拼装、预处理判定、倾斜估计）→ 进 CI，无外部依赖；**需要 tesseract 的组** → 只在装了引擎的机器上跑，CI 跳过（跳过时**必须显式跳过**，不能静默"通过"）。

**纯函数 + 命令拼装组**（断言）：

| 场景 | 断言 |
| --- | --- |
| TSV 归一（纯函数） | 词行 `level==5` 被取；`level<5` 的结构行被丢；`conf == -1` 的行不参与平均置信度 |
| TSV 归一 | 空文本页 → `text: ""`、`words: []`、平均置信度 `0` |
| 命令拼装 | `-l` 在 config 名**之前**（回归 §2 记录的踩坑点） |
| 命令拼装 | `--psm` / `--dpi` 也在 config 名**之前**（同源坑） |
| 命令拼装 | **必须**带 `--psm 4`（回归「PSM 3 误判栏序」踩坑点） |
| 命令拼装 | 未指定语言时**必须**带 `-l chi_sim+eng`（回归「默认只有 eng」踩坑点） |
| 命令拼装 | 预处理产物是 PGM 时**必须**带 `--dpi`（回归「PGM 无 DPI 元数据」踩坑点） |
| 命令拼装 | **必须**带 `--tessdata-dir <dir>`，且路径来自 `LocalAssetPort.resolveGroup()`（不依赖系统 tessdata） |
| 命令拼装 | `--tessdata-dir` 也在 config 名**之前**（同源坑） |
| **产物存在性断言** | tesseract 退出码 0 但 **`<outbase>.tsv` 不存在** → 判 `internal`（`details.engineCode = "process_failed"`）。⚠️ 必须**专门断言 `.tsv`**，不能只查「目录里有没有产物文件」—— tesseract 缺 `configs/` 时会退回写出 `<outbase>.txt`，只查「有文件」会**误判为成功** |
| **tessdata 路径不缓存** | 解析一次 → 切换资产版本 → 下一次识别用新路径（回归「切换在调用前生效」） |
| **倾斜估计（纯函数）** | 已知角度的合成页（0.2° / 0.5° / 0.8° / 2.0°）→ 估计误差 ≤ 0.1° |
| **倾斜估计** | 只有 3 行文字的页也能估出（误差 ≤ 0.1°）→ 不需要「行数不足跳过」的分支 |
| **倾斜估计** | 得分用「相邻差分平方和」；换 `bins` 长度不改变结果（回归「方差版本对零填充敏感」踩坑点） |
| **旋转方向** | 转 +2° 再转 -2° → 与原图平均像素差 < 5（回归「方向反了变成加倍倾斜」踩坑点） |
| **预处理判定（能力层，纯函数）** | `auto` + 估计角 0.2° → 不施加 deskew；估计角 2.0° → 施加并记 `skewAngle` |
| **预处理判定** | `none` → 不做任何步骤，原图直接进引擎 |
| **预处理判定** | `full` → 五步全做，`applied` 记全 |
| **预处理降级** | 预处理抛错 → 跳过该步、原图进引擎、该页进 warnings、整批仍 `ok: true` |
| **产物落盘** | 预处理产物是 PGM，**P5 头由适配器手写**（`P5\n<w> <h>\n255\n` + 原始灰度字节）—— jimp 1.6.1 **不支持 PGM 编码**，不得依赖它；不落 PNG（回归「PNG 编码慢 30 倍」） |
| 部分失败 | 10 页里第 3 页 tesseract 非零退出 → 其余 9 页成功，整批 `ok: true`，失败页进 warnings |
| 全部失败 | 每页都失败 → `ok: false`，`error.code = "internal"`，`details.engineCode = "process_failed"` |
| 引擎不可用 | `probe` 返回 unavailable → `error.code = "unavailable"`，`details.engineCode = "engine_unavailable"`，`error.hint` 含安装提示 |
| sidecar 原子写 | 写过程中崩溃 → 不留半截文件（原文件存在、临时文件被清） |
| sidecar 与源文件不匹配 | `source.sha256` 对不上 → sidecar 作废，不被采用 |
| sidecar 记预处理 | `engine.preprocess.applied` 反映**实际生效**的步骤（不是请求的） |
| office-runtime 接入 | 有 sidecar 时，无文本层的页 `read` 返回 OCR 文本；无 sidecar 时保持 `"(no extractable text…)"` |
| office-runtime 接入 | `strategy: "override"` 时用 OCR 文本覆盖文本层；`"fill"` 时文本层优先 |
| office-runtime 缓存失效 | 文档不变、**sidecar 新写** → 解析缓存失效并重解析（回归 §6.2 第 2 点） |
| 锚点 | sidecar 第 1 页 → 锚点 `page:1` |
| **CLI 输出信封** | `zcode ocr parse --json` 的 stdout 是**一个** JSON 对象，含 `key` / `ok` / `output` / `metrics`；失败时含 `error.code` / `error.message` / `error.hint`（§6.5：业务方按信封解析 → 对外契约） |
| **CLI 退出码** | 逐条对上 §8 的表（`unavailable` → 1、`cancelled` → 130、`timeout` → 124） |
| **stderr 形状** | 失败时 stderr **只有一行**，不打印堆栈（业务方直接把 stderr 转给用户） |
| **安装提示** | `unavailable` + `details.engineCode = "engine_unavailable"` 时，`error.hint` 含 tesseract 的安装命令（业务方不自造提示，直接透传） |

**端到端手测**（需要本机装好 tesseract + poppler，**不是 CI 门禁**）：

1. 造一份**带真 CJK 字形**的扫描件 PDF（用 Songti.ttc 嵌入，见 §2）。
2. `zcode ocr parse --path <文件> --json` → 侧写文本里出现正确中文（⚠️ **路径走 `--path`，不写 `ocr-request.json`**）。
4. 用该 PDF 打开 pdf 插件面板 → 搜索框里能搜到 OCR 出来的词。

**不测**：CI 里的真实 OCR 质量（依赖系统装包，跨平台不一致）→ 归到端到端手测。

**质量回归的度量方式**：真实 OCR 质量没法写进 CI（依赖系统装包），但**可以**把「合成中文页 → tesseract → 与真值比 CER」做成一条**本地可复跑**的脚本，纳入工程测试的「需要 tesseract 才跑」分组。合成页参数（角度、阴影、噪点）就是本 spec §5.1 的实测表 —— 改了预处理参数就跑一遍看 CER 变化，而不是靠感觉。

## 11. 未决问题

1. **要不要把 OCR 做成内置工具（投影 C）？** 倾向做：Agent 遇到「这页没文字」时可以自己调。但它有工作区写副作用（写 sidecar），权限面要单独定。→ 归 `capability-registry.md` **§11 未决问题 4**（内置工具默认关还是开）与 **§11 未决问题 8**（投影 C 何时做）一起定。
2. **要不要 OCR 图片（非 PDF）？** 本 spec 的契约已含图片输入（直接识别原图），但**图片的文字层放哪**没定：sidecar 同样适用（`<img>.png.zcode-ocr.json`），但 ZCode 现有的图片通道是**直接送视觉模型**，不读 sidecar。要不要让视觉模型优先读 OCR 文本（省 token、也防幻觉）？→ 单独议题，本期只保证 OCR CLI 本身可用。
3. **版面还原（表格 / 栏序）？** v1 不做。tesseract 有 `--psm` 和 TSV 的 block/paragraph 结构可以粗略还原单栏顺序，但表格需要 hOCR/PDX。→ 需要时另写 spec。
4. ✅ **已定（2026-11-08）：引擎换成 MinerU**。见 [`local-infra.md`](./local-infra.md) —— 引擎层扩展为**档位链**（`mineru-advanced → mineru-standard → mineru-basic → mineru-flash`，四档）。原来的 `OcrEnginePort` **只覆盖 tesseract 一条路线**，MinerU 走 `LocalInfraPort`（§4 开头）。⚠️ **v1 的降级链里没有 tesseract**（D8：tessdata 资产层未实现，用系统 tessdata 会违反可复现性规则）—— tesseract 兜底留二期，与资产层一起做。
   - **PP-OCR ONNX：不再单列** —— MinerU 的档位链已覆盖"轻量本地引擎"这一格（`basic` 档约 0.8GB 模型 / 2GB 内存 / 纯 CPU）。
   - **云端引擎会推翻「本地 OCR」决策**，加之前要重新对齐。
   - **macOS Vision 等平台原生引擎：暂不考虑**（用户已定）。
   - ⚠️ **tesseract 兜底在 v1 不实现**（[`local-infra.md`](./local-infra.md) §3.2）：tessdata 资产层未落地，用系统 tessdata 会违反「不得依赖系统 tessdata」的可复现性规则。⇒ **v1 里"用户压根没装 MinerU"是硬失败**（`unavailable` + 装法 hint），这是已知代价。
5. **sidecar 是否入 git？** 它是可重建的派生物，默认不该进版本库。建议加 `.gitignore` 规则 `*.zcode-ocr.json`；但用户可能想把 OCR 结果作为交付物提交 → 留一个 `--keep-in-repo`？→ 简单起见默认不入 git，是否忽略由用户的 `.gitignore` 决定（我们不自动改用户的 gitignore）。
6. **`--psm` 要不要按页自动选？** 固定 4 在本轮样本里最优，但表格页 / 票据页可能需要 6（均匀块）或 11（稀疏文本）。要不要按页先跑一次自动判定？→ v1 不做（多跑一遍的代价大，且错选比统一 4 更难预测）；先把 `--psm` 暴露给用户。
7. **预处理产物要不要可留档？** 目前 PGM 识别完就删，只在 sidecar 里留 `applied` + `skewAngle`。疑难件排查时可能想看「预处理后那张图长什么样」→ 是否加 `--keep-preprocessed` 把中间产物留在工作区？→ 默认不留（工作区不放大件），需要时再定。
8. **OCR 产物放 sidecar，还是进 L2 工作区资源库？** 本 spec 全程按 **sidecar**（`<源文件名>.zcode-ocr.json`，写在源文件旁）设计，理由是：解析层（`office-runtime`）只读同目录的文件就能拿到 OCR 文本，不用跨进程查库；sidecar 自带 `source.sha256` → 复用判据天然在文件里。
   ⚠️ 但 ZCode 另有一套 **L2 工作区资源库**（`WorkspaceResourceIndexPort`，多 session 共享、跨会话可见）。两者**不是一回事**：
   - sidecar = **文件旁的派生物**，跟着源文件走，跨 session 天然共享（同一份文件），但**不进资源库索引**，不会被跨 workspace 检索命中；
   - L2 资源库 = **workspace 维度**的索引，跨 session 聚合，但资源种类是封闭集合 —— `WorkspaceResourceKind` 目前只有 `image | pdf | audio | video | stream | hardware | transcript | frame`，**没有 `ocr` / `text_layer` 种类**。
   → **待用户定**：OCR 产物要不要成为资源库的一种资源种类（需要扩 `WorkspaceResourceKind` + 扩资源库的 kind 封闭集合）？还是**就停在 sidecar**（本期倾向：sidecar 已满足「解析层能读到」这个核心诉求，扩资源库是另一件事）。**在定下来之前，本 spec 只实现 sidecar 这条路**。
9. **去噪 / 去阴影要不要单独给「用户可发现的入口」？** 「保留在契约里、默认不启用」已定（§5.1），剩下的是**怎么让用户知道它们存在**。→ ⚠️ **2026-11-12 修订**：`zcode cap describe ocr` 随 `zcode cap run` 一起**作废**（不实现，见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) D4）⇒ 改为在 `zcode ocr --help` 的族内动词表里列出全部可用预处理步骤与各自实测收益，让用户自己判断，不做自动推荐、不做自动开启。
10. **子进程路线的两个具体缺口**（§6.5 引入）：
   1. ~~**要不要支持一次调用处理多个文件？**~~ → ⚠️ **2026-11-12 已定**：**zcode 不做批量旗标**。业务自己编排（循环 / 并发 spawn 积木），见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) D1 / §3.4。代价（每次 spawn 付 ~200-400ms node 启动）由业务在自己一侧拉常驻 worker 消化。
   2. ~~**「源文件没变就跳过识别」这条捷径由谁做？**~~ → ⚠️ **2026-11-12 已定：zcode 内部做**。判据与接力矩阵见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §6.5；业务方只管调，「本次没重跑」的语义由 `output.cached` 给出。
