# 本地 OCR 能力面（`zcode ocr`）

Status: **v1 已实现**（2026-11-09）：端口 + 命令面 + 回归测试已落地；**`asset` 命令组延期**（§7.3）。
**2026-11-11 命令面改名**：独立二进制 `zcode-infr-manage` → `zcode` 的**原子子命令组** `zcode ocr`（§7.3）。

> ⚠️ **本版经四路对抗审查后重写。** 上一版有 43 处问题被查出，其中 11 处是阻断级（含 5 处**事实性写错**）。修订要点见 §12。

### 实施状态（2026-11-11）

| 落点 | 路径 | 状态 |
| --- | --- | --- |
| 端口契约 | `apps/zcode-cli/packages/contracts/src/interfaces/local-infra.port.ts` | ✅ 已写 |
| 端口实现 | `apps/zcode-cli/packages/adapters/src/local-infra/`（定位 / 档位 / 子进程 / 产物分类 / 模型状态） | ✅ 已写 |
| 通用解包器 | `apps/zcode-cli/packages/adapters/src/fs/zip-extract.ts` | ✅ 已写（从 `plugins/zip-source.ts` 抽出并复用，路径穿越加固不重复实现） |
| 命令面 | `apps/zcode-cli/packages/cli/src/ocr/`（参数 / 输出 / doctor / parse / models） | ✅ 已写 |
| 分发链 | `zcode` 单一入口（**无第二个 bin**） | ✅ 已写（2026-11-11 改为子命令组，见 §7.3） |
| 配置键 | `adapters/src/config/schema.ts` 的 `ocr` 段（`mineruPath` / `mineruProxy`） | ✅ 已写 |
| 回归测试 | `packages/adapters/tests/local-infra/`（vitest，28 例）、`packages/cli/tests/ocr-command.test.ts`（node:test，14 例） | ✅ 已写 |
| `asset` 命令组 | — | ⏸️ **延期**，阻塞项见 §7.3 |
| SEA / Electron 桌面 | `zcode ocr` 随同一个 `zcode` 入口提供 | ✅ **随主入口自动具备**（2026-11-11；独立二进制时代不提供） |

## 1. 目的与范围

让 ZCode 能**管理本机的模型 / 解析基础设施**：体检环境 → 调用引擎 → 反馈健康与降级。

**v1 范围**：本地 **PDF / 图片** → 结构化文本的解析引擎链（MinerU），封装成 `zcode` 的一个**原子命令组** `zcode ocr`，并以能力端口接入。

**v1 的执行形态：无状态路线** —— `mineru-kit parse` **在子进程内**完成推理（llama.cpp / Apple MPS），**不需要任何常驻服务**。ZCode 只负责：定位可执行文件 → 选档位 → 执行 → 收产物 → 降级告知（§5、§6.2）。

⚠️ **路线选型的实测依据见 §11.0.2** —— 原计划的 Doclib 路线（`mineru parse`）经实测只能产出 markdown，**给不了 ZCode 需要的结构化块**（bbox + 类型），因此 v1 改走无状态路线。Doclib 的索引 / 检索 / 缓存能力留到 knowledge-rag 二期（§6.3）。

**v1 不适用**

- 不做本地 embedding 服务（`knowledge-rag.md` v1 纯词法；embedding 留二期）
- 不做本地 LLM 推理服务（走 provider 配置与 model selection）
- 不做常驻守护进程（进程按需拉起、用完即退）
- 不做 MinerU / Python 环境的安装（只检测 + 调用）
- **不做 tesseract 兜底**（tessdata 资产层未实现；见 §3.2）
- **不接 `office-runtime` / 知识索引**（v1 = 先通链路）；⚠️ **2026-11-12**：`zcode cap run ocr` 这条命令已整体作废（见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) D4）⇒ 业务接入面是**族命令组积木** `zcode ocr inspect` / `zcode ocr parse`
- **不在 SEA 单文件与 Electron 桌面版里提供 `zcode ocr`**（分发链限制，见 §7.3）

### 1.1 与既有 spec 的关系

| spec | 关系 |
| --- | --- |
| [`ocr-local.md`](./ocr-local.md) | 本 spec 是它的**引擎层扩展**：OCR 能力的引擎从"只有 tesseract"变成"引擎链"。⚠️ `ocr-local.md` 假定引擎是"spawn 一个 CLI、读 TSV"，而 MinerU 是**文档级**、产物是 markdown + 块级结构 → 引擎契约与 sidecar 格式都要改（§10 同步清单）。**v1 不改实现**，但边界要写死 |
| [`model-assets.md`](./model-assets.md) | 本 spec 曾计划**吸收其 CLI 表面**（`zcode asset` 挂到本命令组底下），顺带结掉它 §14 的开放问题 7。⚠️ **2026-11-11 改：CLI 原子化 ⇒ 资产面是平级的独立命令组 `zcode asset`**，不再挂进 `zcode ocr`。⚠️ **v1 该命令组整体延期**（§7.3 的 7 条待决：目录地址只有占位 URL 等）⇒ 只保留其"引擎二进制仍由用户自行安装"的决策，并**升格为通用原则**（§3.1） |
| [`capability-registry.md`](./capability-registry.md) | `CapabilityPorts` 新增一项 `localInfra`（v1 定义契约与实现，**不接三投影**） |
| [`knowledge-rag.md`](./knowledge-rag.md) | v1 不改。⚠️ 但 **MinerU 4.x 自带索引与检索**（`mineru search` / `find` / `read`，需要 Doclib server），与本 spec 规划的"客户端本地知识库"功能重叠 → 边界见 §3.3 |
| [`model/http-proxy.md`](./model/http-proxy.md) | ⚠️ **本 spec 的代理策略是那份文件的一个例外，必须去那里登记**（见 §7.9） |

⚠️ **实施状态核查（2026-11-08）**：本条线依赖的三份 spec **全部未实现** ——

| 依赖 | 仓库现状 |
| --- | --- |
| `capability-registry.md` | `apps/zcode-cli/packages/capabilities` **不存在**；`packages/cli/src/run.ts` 的命令分派里**没有** `cap` |
| `model-assets.md` | `packages/contracts/src/interfaces/` 里**没有** `local-asset.port.ts`；`packages/adapters/src/` 里**没有** `local-assets/`；`packages/cli` **没有** `asset` 命令；`arguments.ts` 全局旗标里**没有** `offline` |
| `ocr-local.md` | `packages/contracts/src/interfaces/` 里**没有** `ocr-engine.port.ts` / `image-preprocess.port.ts`；`packages/adapters/src/` 里**没有** `ocr/`；`office-runtime` 的 sidecar 接入未做 |

⇒ **本轮改契约没有存量消费者，不需要走对外契约版本递增**；但新写的契约按"对外公共契约"的纪律对待（字段增删要显式说明）。

---

## 2. 已定决策

### 2.1 用户决策

| 编号 | 决策 |
| --- | --- |
| D1 | ZCode 管理本地模型 / 解析服务；**v1 只做文档解析** |
| D2 | 主引擎 **MinerU**（用户自装） |
| D3 | 引擎 / 档位**不可用**时**降级 + 告知**（可用优先），不直接失败 |
| D4 | 进程**按需临时拉起，用完即退**；无常驻守护 |
| D5 | ⚠️ **已修订（2026-11-11，用户确认）**：命令面是 `zcode` 的**原子子命令组** `zcode ocr`，**不是独立二进制**（原决策为独立二进制 `zcode-infr-manage`）。理由：**CLI 原子化** —— 一个能力域一个命令组（`zcode ocr` / `zcode llm` / `zcode asr` / `zcode asset`），不设"基础设施总管"二进制 |
| D6 | 托管边界：**只检测 + 调用**；引擎与 Python 环境由用户自装 |
| D7 | **v1 = 先通链路**：二进制 + 端口 + 引擎链 + 降级告知 + 产物落工作区；不接 `office-runtime` / 知识索引（⚠️ `zcode cap run ocr` 已作废，见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) D4） |
| D8 | **v1 不做 tesseract 兜底**；降级链 = MinerU 自己的档位链 |
| D9 | ⚠️ **已修订（2026-11-08，用户确认）**：**v1 改走无状态路线** `mineru-kit parse`（子进程内推理，**不要 server**）。原定"走 `mineru server`（Doclib）"的理由是"Doclib 有缓存 / 索引 / 检索"，但实测证明它**给不了结构化块**，而结构化块才是 v1 的刚需（§11.0.2） |

### 2.2 我的决定（可推翻）

| 编号 | 决定 | 理由 |
| --- | --- | --- |
| M1 | **共享实现模块**：`packages/adapters/src/local-infra/`；`zcode ocr` 是它的 CLI 外壳 | 避免 `adapters → cli` 的倒挂依赖 |
| M2 | **两个可执行文件分别定位**：`mineru-kit`（干活：`parse` / `hardware detect`）与 `mineru`（版本检查：`version --json`）。配置键 `ocr.mineruPath` **只指向 `mineru-kit`**；`mineru` 由"同目录 sibling"推导 | 两个是**命令面不重叠的独立 CLI**；`mineru parse` 只有 `--format markdown`（拿不到结构化块），只有 `mineru-kit parse --format zip` 给三件套 |
| M3 | probe **只探硬件与档位，不下载权重**；判定委派 `mineru-kit hardware detect --json` | `doctor` 必须是**只读**命令；权重 0.8~3GB 不该由体检触发 |
| M4 | **ZCode 自己的 stdout** 恒为单个 JSON 对象；**MinerU 的 stdout 是人读文本**（实测 `已解析 1 个输入。`），**不得当 JSON 解析** | 只有 `hardware detect --json` 的 stdout 是 JSON；`mineru-kit parse` 的进度/日志全在 stderr |
| M5 | ⚠️ **已修订（2026-11-11）**：交付形态 = **`zcode` 的子命令组**，**不需要第二个 bin** ⇒ 发行链（`build-zcode.mjs` → `zcode-distribution`）、SEA、Electron 桌面**零改动**（原决策：发行包里的第二个命令，SEA / 桌面不提供） | 子命令组复用同一个入口 ⇒ 既省掉"第二个 bin 要改 4 处"的成本，又让 SEA / 桌面**自动具备**该命令 |
| M6 | MinerU 路径下，tesseract 专属参数（`psm` / `preprocess` / `thresholdingMethod` / `noWords`）**明确拒绝**，不静默忽略 | 契约说谎比报错更糟 |
| M7 | 端口类型放 `packages/contracts`（纯 TS 接口，**不引 zod**）；实现放 `packages/adapters` | ⚠️ zod 纪律约束的是 `CapabilityDefinition.inputSchema/outputSchema`，**不约束 port 接口**（`execution.port.ts` / `file-system.port.ts` 零 zod 依赖）。真正会被 zod 3 咬到的是 §7.10 要改的 `OcrCapabilityInput/Output` |
| M8 | `zcode ocr` 有 `doctor` / `inspect` / `parse` / `models` **四个**子命令（⚠️ **2026-11-12 新增 `inspect`**，形态见 [`capability-cli-blocks.md`](./capability-cli-blocks.md)；**无 `server` 组**）；**`asset` 是平级的独立命令组 `zcode asset`**，不挂在 `zcode ocr` 底下 | 无状态路线没有要管理的服务；CLI 原子化 ⇒ 资产（跨能力域共享）不归任何一个能力域 |
| M9 | 产物用 **`--format zip` 一次取全**，再解包出 `markdown.md` / `middle_json.json` / `structured_content.json` | 分两次跑要**付两次冷启动**（实测冷启动 123.5s） |
| M10 | 档位可用性判据用 **`mineru-kit hardware detect --json`** | 无状态路线没有 server 的 `supported_tiers` 可用 |
| M11 | 档位链 = **`advanced → standard → basic → flash`**（官方枚举的完整四档），但**集合动态取自 `pdf_image_tiers`**，不硬编码 | 实测 `pdf_image_tiers: ["flash","basic","standard","advanced"]`，`flash` 官方文档从未出现过 |
| M12 | **`--pages` 只对 PDF 传**；图片及其它类型**一律不传** | ⚠️ MinerU 只允许 PDF 传页范围，传图片**直接报错退出**（实测） |
| M13 | **临时 zip 路径必须带 `.zip` 后缀** | ⚠️ 不带后缀且不存在 ⇒ MinerU **创建目录**并把产物写在里面（实测）⇒ 引擎成功、退出码 0，但 ZCode 找不到产物 |
| M14 | 统一用 **`--output`**（不用 `-o`），与 MinerU 自己的旗标名一致 | 消除 `-o` / `--output` / `outputDir` 三个名字并存 |
| M15 | **产物落盘由端口实现写**（adapter 写，调用方只给 `outputDir`） | 与 `capability-registry.md` §5 的既有答案一致（"sidecar 的写入"归 adapter，能力层只发指令） |

---

## 3. 边界

### 3.1 托管边界：什么由 ZCode 装，什么由用户装

**原则：ZCode 只托管「许可允许 + 可离线分发 + 跨三平台可获得」的部分。**

| 组件 | 谁装 | 依据 |
| --- | --- | --- |
| MinerU 代码 + Python 依赖 | **用户** | 见 §3.4 许可；沿用 `model-assets.md` §1 口径并升格为本原则 |
| MinerU 模型权重（0.8~3GB，按档位与运行时） | MinerU 自己（`mineru-kit models download`） | ZCode 不代下、不代持 |
| llama.cpp 预编译二进制 | ZCode（二期，embedding 用） | MIT；SEA native runtime asset 机制已有先例 |
| GGUF 权重 | ZCode（二期，embedding 用） | 走资产层 |
| tessdata 语言资产组 | ZCode | 已有（`model-assets.md`），**v1 不涉及**（D8） |

⚠️ **ZCode 不提供"一键装 MinerU"。** `zcode ocr doctor` 的职责是把"缺什么、怎么补"讲清楚。这是产品规则，不是待办。

⚠️ **`zcode ocr` 的分发范围**：v1 **只进 npm / 发行包**（`scripts/build-zcode.mjs` 那条链）。**SEA 单文件与 Electron 桌面版不提供这个命令** —— 那两条链只 stage 一个 `zcode.cjs` 入口（§7.3）。⇒ 业务客户端若需要它，得装发行包，不能只靠桌面版。

### 3.2 为什么 v1 不留 tesseract 兜底（D8）

MinerU 的 `basic` 档是 **约 0.8GB 模型 / 2GB 内存 / 纯 CPU**（⚠️ **文档核出，未实测**）—— 覆盖"没有重模型"场景的**预期**依据。

⚠️ **更正（对抗审查）**：上一版写"basic 档 2GB 内存 / 纯 CPU（**实测跑通**）"是**错的** —— 那次实测跑的是 **torch + MPS**（`hardware detect` 的 `small_backend: torch` / `device: mps`），**既不是 ONNX 变体也不是纯 CPU**，而且**内存从头到尾没有测过**（无峰值 RSS 记录）。⇒ "basic 能在 4GB 无 GPU 机器上跑"目前**完全未验证**。而 tesseract 兜底要成立，前提是 tessdata 资产层落地（`model-assets.md` 未实现）；不落地就只能用系统 tessdata，直接违反 `ocr-local.md` §5「不得依赖系统 tessdata」的可复现性规则。

⇒ v1 的降级链**完全在 MinerU 内部**（档位链，§5.1）。tesseract 兜底留二期，与资产层一起做。

⚠️ **代价要认**：v1 里"用户压根没装 MinerU"就是**硬失败**（`unavailable` + 装法 hint），没有兜底。这是 D8 的已知代价，二期补。

### 3.3 与 MinerU 自带索引的边界

MinerU 4.x 的 Doclib 自带 `mineru search` / `mineru find` / `mineru read` —— 即它有自己的文档索引与检索（**需要 server**）。这与 `knowledge-rag.md` 规划的"客户端本地知识库"功能重叠。

⇒ **规则：同一份文档只能有一套索引所有者。** v1 ZCode **不建索引**，只产出结构化产物，所以**不冲突**。

二期若 ZCode 要自建知识索引（`knowledge-rag.md` 的路线），必须**二选一**：要么用 MinerU 的索引（不自建，但要接受 Doclib server 生命周期），要么让 MinerU 只做解析、由 ZCode 独占索引（**v1 走的正是这条**）。**不许两套同时管同一份文档。**

### 3.4 许可（MinerU Open Source License）

**基于 Apache 2.0 + 附加条件**（不是 AGPL）：

| 条款 | 内容 | 对 ZCode 的含义 |
| --- | --- | --- |
| 商业使用 | 允许，无需另购许可 —— **除非**你 + 关联方合计 MAU > 1 亿，或月收入 > 2000 万美元 | ZCode 自身规模远低于阈值 |
| **在线服务标注** | 若把 MinerU 用于**对外的第三方服务**，必须**显著标注"使用了 MinerU"** | ⚠️ 影响未来的**服务端 RAG**（`knowledge-rag.md` D3 提到服务端是补充召回源）。本地部署不受此条约束 |
| 再分发 | 无额外限制（其余按 Apache 2.0） | 不构成 ZCode 分发障碍 |
| Share-alike | **无** | 无传染 |
| 输出物 | 许可条款**未涉及** | 解析产物归用户 |

⚠️ **D6 是在"许可未知 / 以为是 AGPL"的前提下定的**；许可核实后该前提消失，但**用户决定维持 D6**（只检测 + 调用）。理由记录在案：ZCode 不往用户机器里塞 Python + 依赖，引擎由用户自装，`doctor` 负责体检与告知。

---

## 4. 术语

| 词 | 含义 | 例 |
| --- | --- | --- |
| **本地基础设施** | 本机上与模型 / 解析相关的一组东西：引擎可执行文件、它们的依赖、模型权重、资产组 | — |
| **引擎** | 一个能吃输入、产出结构化文本的本地程序 | `mineru-kit` |
| **档位（tier）** | 引擎内部的**质量档位**，决定模型大小、依赖运行时与硬件门槛 | `flash` / `basic` / `standard` / `advanced` |
| **运行时变体** | 同一档位下的推理实现 | ONNX（含 llama.cpp）/ PyTorch（含 llama.cpp / vLLM / mlx） |
| **资产** | 静态文件（权重、语言包、预编译二进制） | tessdata 组、GGUF |
| **任务** | 一次解析请求（一份文档进，一份产物出） | — |
| **Doclib** | MinerU 的文档库服务（`mineru server`），提供索引 / 检索 / 缓存 | — |

---

## 5. 产品规则

### 5.1 档位链

```
mineru-advanced  →  mineru-standard  →  mineru-basic  →  mineru-flash
```

⚠️ **官方完整枚举是四档**：`flash` / `basic` / `standard` / `advanced`（实测 `mineru-kit hardware detect --json` 的 `pdf_image_tiers`）。`flash` 在官方文档里从未出现过，**但它真实存在** —— 实现不得硬编码三档。

| 档位 | 已知要求 | ⚠️ 输入类型能力 |
| --- | --- | --- |
| `advanced` | 约 3GB 模型 / 16GB 内存 / 8GB+ 显存（PyTorch 路线）；另有 PyTorch + vLLM/lmdeploy/mlx。⚠️ **内存/显存数字是文档核出，未实测**；⚠️ **实测 advanced 1 页就要 10.2s**（Two Step Extraction），量级与其它档完全不同 | PDF + 图片 |
| `standard` | 约 2GB 模型 / 8GB 内存 / GPU·MPS 必需 / 8GB+ 显存（PyTorch 路线）；ONNX + llama.cpp 变体 CPU 可跑（Vulkan 推荐）。⚠️ **内存/显存数字是文档核出，未实测** | PDF + 图片 |
| `basic` | 约 0.8GB 模型 / 2GB 内存 / 纯 CPU（ONNX 变体）。⚠️ **内存数字是文档核出，未实测**（见 §3.2 的更正） | PDF + 图片 |
| `flash` | 最轻档。⚠️ 官方文档未给要求，**实测待补** | ⚠️ **独占**：只有 `flash` 能解 **Office（docx/xlsx/pptx）/ HTML / MHTML / CSV / EPUB / OFD**；basic/standard/advanced **只吃 PDF + 图片** |

⚠️ **`flash` 不是"basic 的更轻版"** —— 它是**输入能力独占**的档位。⇒ 对 Office 文档，降级链是反的（只能一路降到 flash）；对 PDF / 图片，降级链如上。**v1 范围只有 PDF / 图片**，所以当前不致命，但实现里不能把 flash 当"兜底空档"。

**选择规则**

1. **默认不指定 `--tier`** —— MinerU 自带推荐机制：实测 `mineru-kit hardware detect --json` 给 `default_request_tier: "standard"`，不传 `--tier` 时按它走（实测 8.58s 跑通）。**ZCode 不猜**，把硬件判断交给 MinerU。
2. 上层或用户**显式指定档位** → 原样传给 MinerU。
3. **档位判定的唯一规则**（消除上一版三处矛盾）：

| 情形 | 判定依据 | 行为 | 对外码 |
| --- | --- | --- | --- |
| 档位**不在官方枚举内**（如 `turbo`） | 不在 `pdf_image_tiers` 里 | **直接报错**，不 spawn | `invalid_input` / `details.engineCode = "engine_not_found"` |
| 档位在枚举内，但**本机不支持**（不在 `pdf_image_tiers`） | `hardware detect` 的 `pdf_image_tiers` | **降到 `ceiling`** 并告知 | 成功 + `warnings[]` |
| `ceiling` 档**也跑不动** | 依赖缺失 / 内存不足 | 报错 | `unavailable` / `details.engineCode = "engine_unavailable"` |

⚠️ **`ceiling` 就是 `max(pdf_image_tiers)`**（实测 `ceiling: "advanced"` ↔ `pdf_image_tiers` 的最大值），所以"超出上限"与"不在支持列表"是**同一个条件** —— 上表第二行覆盖它，**不存在"既要降级又要报错"的中间态**。

⚠️⚠️ **`ceiling` 不是「本机跑不动更高档」的判据** —— 复核发现它的实现**只看有效 CPU 核数 + 有没有加速器**（≥12 核给 3 档、≥4 核给 2 核、否则只剩 flash），**完全不查内存 / 显存**（`gpu_memory` 恒为 `null`；`calibration.status = "skipped"` 的语义就是"避免把设备可用性当成实测胜出"）。

⇒ **它与 §5.1 档位表里的内存 / 显存要求互相矛盾**：一台 32GB 内存 + 4GB 显存的机器会得到 `ceiling = advanced` ⇒ ZCode 照选 advanced ⇒ 运行期失败；而 §5.2 规定"执行失败不降级重跑" ⇒ 用户拿到一次硬失败。

⇒ **处置**：把 `ceiling` 当作**启发式**（"这台机器大概能跑到哪档"），**不要**当保证。ZCode 侧补一条**保守检查**：用户显式指定的档位若**超出本档的内存要求**（§5.1 表，文档核出值）⇒ 直接降级 + 告知，不 spawn。**这条检查不能靠 `hardware detect`** —— 那正是它不查的东西。

⚠️ **档位可用性只有一级判据**（无状态路线没有 server 的 `supported_tiers`）：**`mineru-kit hardware detect --json`**。

| 字段 | 实测含义 | 用途 |
| --- | --- | --- |
| `ceiling` | ⚠️ **它是「分级规则」的结果，不是对本机能力的实测**（见下方警告） | 降级判据 |
| `pdf_image_tiers` | 本机支持的档位列表 | 选档位 + 校验枚举合法性 |
| `default_request_tier` | 不指定时的默认档位（实测 `standard`） | 默认档位 |
| `device` | 推理设备（实测本机 `mps`） | 告知用户"走的是 MPS" |
| `small_backend` / `vlm_engine` | 实测 `torch` / `llama-cpp` | 诊断用 |
| `reason` | 判据来源（实测 `torch_accelerator`） | 诊断用 |
| `calibration` | ONNX 标定状态（实测 `{status:"skipped", reason:"torch_backend", evidence:null}`；取值含 `missing`/`invalid`/`present`） | 解释"为什么 ceiling 比预期低" |
| `cpu_count` / `gpu_memory` / `schema_version` / `warnings` | 硬件细节 | 诊断用 |

⚠️ **实测：`hardware detect --json` 的 stdout 是干净 JSON，日志在 stderr**（实测 1.68s，只 lazy-import torch，**不加载 VLM**，不会像冷启动那样慢）⇒ M4 成立，**不需要"从混了日志的 stdout 里取 JSON"的机制**。

⚠️ **实际用的档位以产物为准**：ZCode 传的 `--tier` 可能被 MinerU 内部改写，**权威值是产物里的 `structured_content.json` → `extensions.mineru.tier`**（实测：不传 `--tier` 时请求侧无值、产物侧 `"tier": "standard"`）。⇒ 结果里的 `tier` **从产物回填**，不是回填请求值。

### 5.2 降级与告知

| 情形 | 行为 | 告知 |
| --- | --- | --- |
| 档位超出本机上限（枚举内但不在 `pdf_image_tiers`） | **降到 `ceiling`，执行一次** | `warnings[]` = "档位 advanced 在本机不可用（<原因>），已用 basic" |
| 档位不在官方枚举内 | **报错**，不 spawn | `error.code = "invalid_input"` + `hint`（列出合法档位） |
| MinerU 没装 / 跑不起来 | 报错 | `error.code = "unavailable"` + `hint`（装法）+ `details.engineCode = "engine_unavailable"` |
| 档位自选成功 | 无降级 | 不进 `warnings`（正常信息不是告警）；档位从**产物**回填到 `result.tier` |
| 执行失败（非零退出 / 产物缺失 / 超时） | **不降级重跑** | `error.code` + `hint` + `details.engineCode` |

⚠️ **"降到可用档位，重跑一次"这个说法上一版是错的** —— 正确语义是：**在 spawn 之前就把档位降好，只执行一次**。时序图（§6.2）里③定档位时已降级，④只执行一次。

⚠️ **为什么执行失败不降级重跑**

1. MinerU 任务动辄几百页，失败后换档位整份重跑代价高。
2. 失败原因通常不是"档位能力不足"（那是探测阶段的事），而是环境问题 —— 换档重跑多半也失败。
3. 避免副作用放大（写产物、占磁盘）。

⇒ **探测阶段降级，执行阶段报错。** 这条要写进代码注释，不是靠调用方自觉。

### 5.3 批量粒度与页范围

**一次任务 = 一份文档。** 不接受逐页调用。

理由：每次调用都要加载模型（0.8~3GB，按档位）。逐页调用 300 页 = 300 次模型加载。

⚠️ **`--pages` 只对 PDF 传**（M12）：

| 输入类型 | `--pages` | 依据 |
| --- | --- | --- |
| PDF | **传 `--pages all`** | MinerU 的 `mineru parse` 默认只前 10 页；`mineru-kit parse` 默认全部，但显式传避免语义漂移 |
| 图片 / 其它 | **一律不传** | ⚠️ MinerU 只允许 PDF 传页范围，传图片**直接报错退出**（实测：`Page range is only supported for PDF files; 'png' uses full-document parsing.`） |

### 5.4 健康反馈的载体

| 面 | 形态 |
| --- | --- |
| `zcode ocr doctor --json` | 环境体检：可执行文件定位、**硬件与档位**（`ceiling` / `pdf_image_tiers` / `default_request_tier` / `device` / `calibration`）、**模型就绪情况**、缺失项与装法 |
| `zcode ocr parse --json` | ⚠️ **2026-11-12 起是统一信封**（[`capability-cli-blocks.md`](./capability-cli-blocks.md) §5）：`{ version, key: "ocr.parse", ok, output?, error?, metrics? }`（样例见 §7.5） |
| `zcode ocr inspect --json` | 同一套信封，`key: "ocr.inspect"`（**不含** `artifacts` / 逐元素正文） |
| 能力信封 | `output` + `metrics.warnings[]` / `metrics.durationMs` / `metrics.degradedFrom?`；失败走 `error.code` / `error.hint` / `error.details.engineCode`；**顶层不再有 `engine` / `tier` / `warnings` / `degradedFrom`** |

⚠️ **就绪是三层的**（实测得出）：「装了 MinerU」≠「能解析」。

| 层 | 判据 | 缺了会怎样 |
| --- | --- | --- |
| ① 可执行 | 找到 `mineru-kit`（干活）与 `mineru`（版本检查） | 找不到 → `unavailable` + 装法 |
| ② 依赖齐 | `mineru version --json` 能跑 | 缺依赖 → `unavailable` + 装法 |
| ③ 模型就绪 | 目标档位的模型仓库已下载 | 没下 → `unavailable` + 下载命令 |

⚠️ **模型就绪怎么判**（上一版没有可实现的判据）：

MinerU **没有**"列出已下载模型"的 `--json` 命令（`mineru-kit models` 只有 `download` / `show` / `verify`，后两个**无 `--json`**，是人读输出）。实测 `mineru-kit models show` 输出形如：

```
model.source: huggingface
仓库:
  MinerU-4_models_torch: 就绪 (/Users/imissu/.mineru/models/MinerU-4_models_torch)
  MinerU2.5-Pro-2605-1.2B: 缺失 (...)
模型档位:
  basic: MinerU-4_models_torch
  standard: MinerU-4_models_torch, MinerU2.5-Pro-2605-1.2B-GGUF
```

⇒ **决策：ZCode 解析 `mineru-kit models show` 的人读输出**（`/^\s*(\S+):\s*(就绪|缺失)/` 取仓库状态，档位→仓库映射取自"模型档位:"段），**并补一张自己的档位→仓库映射表**。

⚠️ **映射表只覆盖 `basic` / `standard`**（实测 MinerU 只给了这两档的映射）。`flash` / `advanced` **没有仓库映射** ⇒ doctor 对这两档报 `"unknown"`，**不谎报"就绪"也不谎报"缺失"**。

⚠️ **档位状态（`TierModelStatus.status`）怎么从引擎输出推出来**（2026-11-11 补充，实测 `mineru-kit models show`）：

| 档位状态 | 判据 | 典型场景 |
| --- | --- | --- |
| `ready` | 该档位的**全部**必需仓库都被引擎报为「就绪」 | 权重已下好 |
| `missing` | 引擎**明确报出**至少一个必需仓库「缺失」 | **全新机器**（仓库在列表里、状态是「缺失」） |
| `unknown` | 该档位**没有仓库映射**（`flash` / `advanced`），或引擎输出里**查不到**必需仓库的状态 | 引擎输出被截断 / 该仓库没被列出 |

⇒ **「引擎明确说缺失」必须落成 `missing`，不能落成 `unknown`**：第 ③ 层「未就位」与「问不出来」的下一步完全不同 —— 前者可以自动下载权重，后者只能如实说「不知道」。把「缺失」误报成「未知」会让能力供给层永远停在「未就位但不知道该干什么」。

⚠️ **下载命令只在 `missing` 时给，且只对 `basic` / `standard` 给**：MinerU 的 `models download --tier` **只接受这两档** ⇒ 别的档位给不出可执行的命令，就不给（不编一个用户跑不动的命令）。给用户的命令是 **ZCode 自己的** `zcode ocr models download --tier <t>`（不是引擎原始命令）：引擎可能**不在 PATH 上**（只配了 `ocr.mineruPath`），那条命令用户跑不动；ZCode 命令会走引擎定位、代理剥离与档位校验。

⚠️ **成功判据 = 退出码 0 + 产物存在**。退出码 0 不等于成功 —— `ocr-local.md` §2 已实测过 tesseract "缺 `configs/` 是静默失败：退出码 0、无产物、stderr 只有一行警告"。⇒ 适配层**必须同时断言退出码与产物存在**。

### 5.5 产物落盘

**一次 `mineru-kit parse --format zip` 拿全三件套**（M9），再解包到：

```
<源文件目录>/<源文件名>.mineru/
  ├─ markdown.md              # ⚠️ **没有页锚点**（见下）
  ├─ middle_json.json         # 引擎中间结果
  ├─ structured_content.json  # ⭐ 页 + 块（bbox + 类型）—— sidecar v2 的数据源
  └─ images/                  # ⚠️ **可能有**（含图片 / 表格 / 图表的文档才有）
      └─ page_0_image_0.jpg   #   markdown 用相对路径 ![](images/...) 引用它
```

⚠️ **`<源文件名>` 含扩展名**（`扫描件.pdf` → `扫描件.pdf.mineru/`）—— 与 `ocr-local.md` §6.1 的 sidecar 命名口径一致，不要用去掉扩展名的基名。

⚠️ **产物集合随文档内容变化**：实测 1 页纯文本样本 = **3 个文件**；含表格 / 图片的 12 页样本 = **3 个文件 + 24 张裁剪图 = 27 个条目**。⇒ **不能假设只有三个文件**。

⚠️⚠️ **`markdown.md` 里没有 `<!-- page N of M -->` 页锚点** —— 实测 4 个产物（1 页 / 12 页 × zip / markdown 导出）`<!--` 出现次数**全是 0**。⚠️ 上一版把 **Doclib `mineru parse`** 的输出特征错误地归到了 `mineru-kit` 的产物上（Doclib 的 markdown **确实**带该锚点）。

⇒ **页面级引用的唯一可靠来源是 `structured_content.json` 的 `page_idx`（0-based）** —— sidecar v2 的页锚点必须从 blocks 按 `page_idx` 聚合，**不能**去解析 markdown 的页注释。

⚠️ **`images/` 必须与 `markdown.md` 同级保留** —— markdown 的图片引用是**相对路径**（`![](images/page_0_image_0.jpg)`），块里的 `image_source` 也是相对路径（`images/page_0_image_0.jpg`）。⇒ **只搬三个文档文件 = 图片全断**。

⚠️ **`--output` 的真实语义**（上一版写错，实测已复核）：

| `--output` 指向 | MinerU 的行为 | 实测 |
| --- | --- | --- |
| **已存在的目录** | 产出 `<dir>/<stem>.zip`，**不报错** | ✅ 退出码 0 |
| **不存在的路径，无后缀** | **创建该目录**，产出 `<dir>/<stem>.zip` | ✅ 退出码 0 |
| **带 `.zip` 后缀的文件路径** | 产出该 zip 文件 | ✅ 退出码 0 |
| 收目录时报 `[Errno 21] Is a directory` | ⚠️ **这是 `mineru parse`（Doclib）的行为，不是 `mineru-kit parse`** | 已复核 |

⇒ **M13：临时 zip 路径必须带 `.zip` 后缀**。否则 MinerU 会创建目录、把产物写在里面 ⇒ **引擎成功、退出码 0，但 ZCode 找不到 zip** ⇒ 误报 `artifact_missing`，排查成本极高。

⚠️ **mineru-kit 会自动创建父目录**（实测 `--output /tmp/x/nested/deeper/out.zip` 直接成功），但 `mineru-kit parse --help` **没写这条**（只有 `mineru read --output` 写了）⇒ 不依赖它，ZCode 自己建。

⚠️ **产物文件名不硬编码** —— zip 的条目名**由 MinerU 的 `rglob("*")` 收集**（实测 4.1.7 是扁平的 `markdown.md` / `middle_json.json` / `structured_content.json`），**换版本真的会变**（2.x 是 `*_content_list.json` / `*_middle.json`）。

⇒ **分类规则**（上一版缺失）：解包后按**内容**分类，不按文件名：

| 目标字段 | 判定 |
| --- | --- |
| `markdownPath` | 最浅的 `.md` 条目（同深度时优先叫 `markdown.md` 的） |
| `middleJsonPath` | JSON 且顶层有 `schema` / `schema_version`（4.x）或 `pdf_info`（2.x） |
| `structuredContentPath` | **其余** JSON 里顶层有 `pages` 数组的 |
| **`assetsDir`** | ⚠️ **新增**：图片等资源文件的公共父目录（可能不存在）。**必须落在 `markdown.md` 所在目录之内**（同级或其子目录） |

⚠️ **判据顺序不能反** —— 实测 4.1.7 的 `structured_content.json` 与 `middle_json.json` **同形**：顶层都是 `pages`、页内都是 `pages[].blocks`、连 `extensions.mineru.tier` 都一样 ⇒ **"顶层有 `pages` 数组"区分不了两者**。真正的判别是 `middle_json` 顶层独有的 `schema: "docvortex.middle"` / `schema_version`。⇒ **先判 middle，剩下的才是 structured**；structured 没认出来时，把认不出的那个 JSON 当 structured（那是用户真正要的产物，认错的后果只是取不到 `tier`，不会报错）。

⚠️ **不要按"扫描出来的文件"过滤** —— `images/` 里的 jpg 要**原样落盘**（相对路径依赖它）。

⚠️ **解包前必须清空目标目录** —— 否则 MinerU 升版后旧版残留（如 `middle.json`）与新版（`middle_json.json`）**共存** ⇒ 分类歧义。

⚠️ **zip 里可能有目录条目**（实测 MinerU 会写 `images/` 目录条目）⇒ 解包器要跳过目录条目。

⚠️ **路径穿越是硬要求**：ZCode 解的是**第三方二进制的产物**，条目名随版本变 ⇒ 必须做路径规范化（拒绝 `..`、绝对路径、`\`、NUL）。⇒ **复用仓库已有的加固实现**：`adapters/src/plugins/zip-source.ts` 的 `normalizeZipRelativePath` / `resolveZipPathWithin` / `classifyZipEntry`（含 `ZIP_MAX_ENTRIES=20000` / `ZIP_MAX_SINGLE_FILE_BYTES=50MB` / `ZIP_EXTRACT_MAX_BYTES=500MB` 限额）。

⚠️ **但它当前没有被 re-export**（`adapters/src/plugins/index.ts` 没有导出 `zip-source.ts`）⇒ **先把它抽成通用解包器并导出**，local-infra 再用；**不要复制一份**（安全修复要改两处 = 迟早漏）。

⚠️ **依赖**：`adapters/package.json` **已有 `yauzl@^3.3.0`** ⇒ 不新增依赖。（`office-runtime` 用的是 jszip，且**无 `exports` 字段、jszip 在 devDependencies** ⇒ **不可跨包 import**。）

**`structured_content.json` 的实测结构**：

```jsonc
{
  "pages": [ { "page_idx": 0, "blocks": [ /* ... */ ] } ],   // ⚠️ page_idx 是 0-based
  "metadata": {
    "file_suffix": "pdf",
    "producer": { "name": "mineru", "version": "4.1.7" },
    "document": { "producer_application": "...", "page_count": 1, "page_count_kind": "physical" }
  },
  "extensions": {
    "mineru": { "tier": "standard", "parse_mode": "txt" },   // ⚠️ tier 是权威值；parse_mode ∈ txt / ocr
    "docvortex_layout": {                                     // ⚠️ bbox 的分母在这里
      "version": 1,
      "pages": [ { "page_idx": 0, "width_pt": 595.0, "height_pt": 842.0 } ]
    }
  },
  "is_full_document": true
}
```

⚠️ **两条解析管线**：`parse_mode` 实测有 `txt`（PDF 有可用文本层）与 `ocr`（走 OCR）两种。⇒ **`pdf_image_tiers` 是「图片型 PDF 管线」的档位表**，文本管线可能有不同的档位集 —— 判据别拿它当"本机通用档位表"用。

**块的结构** —— ⚠️ **类型是开放的，且载荷字段随类型变**：

```jsonc
// 文本类（text / paragraph_title）
{ "type": "text", "bbox": [0.096, 0.366, 0.889, 0.658], "content": "合同纠纷案件编号 2024-001" }
{ "type": "paragraph_title", "bbox": [...], "content": "证据材料一", "level": 2 }   // ← 多一个 level

// 图表类（table / image / chart）
{ "type": "table", "bbox": [...], "content": "…",
  "captions": [...], "footnotes": [...], "image_source": "images/page_0_table_5.jpg" }
{ "type": "image", "bbox": [...], "content": "",          // ← ⚠️ 图片块的 content 是空串
  "captions": [...], "footnotes": [...], "image_source": "images/page_0_image_0.jpg" }
{ "type": "chart", "bbox": [...], "sub_type": "...", "content": "…",              // ← 多一个 sub_type
  "captions": [...], "footnotes": [...], "image_source": "images/page_0_chart_0.jpg" }
```

⚠️⚠️ **已实测到的块类型**：`text` / `paragraph_title` / `table` / `image` / `chart`。⚠️ **类型名本身随档位变**：同一张图在 standard/flash 档是 `image`，在 advanced 档是 `chart`。⇒ **`type` 绝不能是封闭枚举**，sidecar v2 的 schema 要留开放字符串 + 一张"已知值"表。

⚠️ **载荷字段随类型变**：`text` / `paragraph_title` 只有 `{type, bbox, content}`（+`level`）；`table` / `image` / `chart` 多 `captions` / `footnotes` / `image_source`（+`sub_type`）。⇒ **sidecar v2 的块 schema 必须允许额外字段**。

⚠️ **图片块的 `content` 是空字符串** —— 图片本体只由 `image_source`（相对路径）指向。按 `{type,bbox,content}` 建模会得到"有框无内容"的图片。

⚠️ **bbox 是归一化 0~1 的四点（xyxy）**，与 tesseract 的**像素**坐标**单位不同** —— 两个 sidecar 变体的消费方必须按 `variant` 区分。

⚠️ **bbox 的分母在产物里**：`extensions.docvortex_layout.pages[].width_pt / height_pt`（实测样本 595×842 pt）。⇒ 换算像素坐标 = `bbox × width_pt × dpi / 72`。**消费方要画高亮框就必须知道这个分母** —— ⚠️ **2026-11-12 修订**：统一 sidecar **v3** 把它记成**页级** `widthPt` / `heightPt`（不再是 `engine.pageWidthPt/pageHeightPt`，也不再是 tesseract 变体的 `pixelWidth/pixelHeight/dpi`）—— 映射表见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §6.3。

⚠️ **无置信度**：MinerU 块**没有**置信度字段（tesseract 有）。

⚠️ **bbox 精度随档位不同**（实测同一张图）：standard 档的图 bbox 有可见偏差（顶边高 0.038 页高、右边宽 0.116 页宽），flash 档反而准（误差 <0.001）。⇒ **不要假设 bbox 一定准**。

⚠️ **`middle_json.json` 的顶层键也会漂**（实测 4.x 是 `pages`，2.x 是 `pdf_info`）⇒ 又一个版本漂移面，**不要按顶层键名解析它**。

### 5.6 性能与冷启动成本

⚠️ **每次调用都要付一次模型初始化 + 每页推理**。实测（standard 档，纯文本 / 含表格图片的 12 页样本）：

| 样本 | 页数 | 档位 | 推理耗时 | 引擎自报 speed | VLM predictor 初始化 |
| --- | --- | --- | --- | --- | --- |
| 纯文本 | 1 | standard | 1.479s | 0.676 page/s | 1.09s |
| 纯文本 | 1 | standard | 1.524s | 0.656 page/s | 1.30s |
| **12 页** | 12 | standard | **4.933s** | 2.432 page/s | 1.48s |
| 12 页 | 12 | standard | 4.484s | 2.676 page/s | 0.96s |
| 1 页 | 1 | **flash** | **0.434s** | 2.302 page/s | — |
| 1 页 | 1 | **advanced** | **10.179s**（Two Step Extraction 9.22s） | 0.098 page/s | 0.66s |

⇒ **边际每页成本 ≈ 0.314 s/页**（`(4.933 - 1.479) / 11`），固定开销 ≈ 1.2s。

⚠️⚠️ **上一版的两个归因都是错的**：

1. **"冷启动 123.5s"不是每次调用的成本** —— 复核发现 **VLM predictor 初始化实测只要 0.66~1.48s**。那一次 123.5s 是**首次**（模型刚下载完）的**一次性**成本，**不是**"page cache 冷"造成的（837MB 刚写盘的文件通常还在 page cache 里）。⇒ 正确表述：**首次可能到分钟级，之后每次调用 ≈ 1s 初始化 + 0.3s/页**。
2. **"0.796 page/s"是整文档速率，不是每页速率** —— 1 页样本的速率被固定开销主导；12 页样本的引擎自报是 **2.432 page/s**。⇒ 拿 1 页样本推 300 页会算错一个数量级。

⚠️ **advanced 是另一量级**（1 页 10.2s，Two Step Extraction 占 9.2s）⇒ 超时额度必须按档位分开给（§7.8）。

⚠️ **但这个成本按"每次调用"计** —— 因此：
1. **一次任务必须一次拿全三件套**（M9），不能分多次调用。
2. 批量粒度必须是一份文档（§5.3），不能逐页。
3. 若 ZCode 后续要高频调用（如逐页 OCR），需要引入常驻 worker —— 那是二期的议题。

⚠️ **表格单元格的拉丁文可能被 OCR 拆开**（实测 `tier` → `t i e r`）—— 表格单元格走的是重 OCR，即使原文 PDF 里是原生文本。⇒ 消费方（尤其知识索引）要做**文本归一化**。

---

## 6. 状态所有者与事件顺序

### 6.1 状态所有者

| 状态 / 事件流 | 唯一所有者 | 备注 |
| --- | --- | --- |
| 引擎可执行文件定位（配置键 > PATH > venv 位置） | `local-infra` 实现模块 | 每次 probe 现查；**不跨进程缓存**（环境会变） |
| 硬件 → 可用档位的映射 | `local-infra` 实现模块 | 委派 `mineru-kit hardware detect --json` |
| 本次任务的**档位选择与降级决定** | `local-infra` 实现模块 | 调用方不重算、不覆盖 |
| 模型文件是否就绪 | `local-infra` 实现模块 | 解析 `mineru-kit models show` 的人读输出 + 自带档位→仓库映射表（§5.4） |
| **产物最终落盘位置** | **`local-infra` 实现模块**（adapter 写） | 调用方只提供 `outputDir`；与 `capability-registry.md` §5「sidecar 写入归 adapter，能力层只发指令」一致（M15） |
| 资产安装与激活指针 | 资产层（`zcode asset`） | 见 `model-assets.md` §11 |

### 6.2 解析流程（事件顺序）

```
调用方(业务客户端/未来的能力)      local-infra 实现            mineru-kit          磁盘
     │                                │                        │                  │
     │ parse(path, tier?)             │                        │                  │
     ├───────────────────────────────>│                        │                  │
     │                                │ ① 定位 mineru-kit      │                  │
     │                                │   配置键 > PATH > venv │                  │
     │                                │   （mineru 由 sibling 推导）           │
     │                                │                        │                  │
     │                                │ ② 硬件探测              │                  │
     │                                │   ── mineru-kit hardware detect --json ─>│
     │                                │ <── ceiling/tiers/… ───┤  (stdout 纯 JSON) │
     │                                │                        │                  │
     │                                │ ③ 定档位                │                  │
     │                                │   显式 → 校验枚举 → 不支持则降到 ceiling │
     │                                │   未显式 → 用 default_request_tier       │
     │                                │                        │                  │
     │                                │ ④ 执行（只执行一次）     │                  │
     │                                │   mineru-kit parse <file> [--pages all]  │
     │                                │   --tier <t> --output <tmp>.zip          │
     │                                │   --format zip                          │
     │                                │ <── exit code ─────────┤                  │
     │                                │ ⑤ 清空目标目录 → 解包 zip → 扫描分类      │
     │                                │   ✗ 产物缺失 → 报错（不降级重跑）        │
     │                                │   ✓ 从产物回填 extensions.mineru.tier    │
     │                                │                        │                  │
     │ <── { ok, tier, output, warnings[] } ──┤                │                  │
```

⚠️ 第 ⑤ 步是**硬要求**：产物断言失败必须报失败，不能因为退出码 0 就当成功（§5.4）。

⚠️ **`parse` 是子命令，必须放在 argv 的第一位** —— 实测 `mineru-kit parse --help` 的签名是 `mineru-kit parse [OPTIONS] {inputs}...`。⇒ 漏掉 `parse` 时引擎会把**输入路径当成未知子命令**，报 `No such command '/path/to.pdf'`（退出码 2）——看起来像"文件不对"，实际是调用形状错了。⚠️ 这类错误**假引擎测不出来**（夹具对 argv 照单全收），必须让假引擎也挑形状，否则只能等真实环境才发现。

### 6.3 二期：Doclib 路线

⚠️ **v1 不做**（D9 修订）。若二期要引入 Doclib（为了索引 / 检索 / 缓存，对接 `knowledge-rag.md`），以下是当时要处理的：

| 议题 | 实测已知 |
| --- | --- |
| 端口 | `MINERU_DOCLIB_TCP_PORT=0` → MinerU 自己分配（**ZCode 不需要端口分配器**） |
| 传输 | ⚠️ **TCP 默认关闭**（`tcp.enabled: false`，默认走 UDS）→ 必须显式 `MINERU_DOCLIB_TCP_ENABLED=1`；**不用 UDS**（Windows 不可靠） |
| 就绪 | `mineru server status --json` → `running===true` 且 `tcp.port>0` 且 `status!=="starting"` |
| 端点文件 | `$MINERU_HOME/doclib.endpoint.json`，⚠️ **实测 `version: 3`**（官方 e2e 文档写的 v2 是旧版，**不要按 2 解析**）；含 `pid` / `server_id` / `transports[]`，**不含 token** |
| token | `~/.mineru/config.yaml` 的 `doclib.auth.token` → ⚠️ **ZCode 不读、不记、不日志** |
| 档位健康 | `status --json` 的 **`parse_server.local.supported_tiers`**（⚠️ **不在顶层**，顶层是 `null`） |
| 本地后端 | ⚠️ `parse_server.local.mode` **默认 `disabled`** → 不改它本地推理根本不启用；改法：`mineru config set parse_server.local.mode managed` |
| 配置顺序 | ⚠️ **`mineru config set` 要求 server 在跑**（走本地 API）→ 顺序必须 `start → set →（必要时 restart）` |
| 所有权锁 | 同一 `MINERU_HOME` 被别的活实例占着时 `start` 非零退出；`stop` **不会终止该实例** |
| 孤儿 | 不按裸 pid 盲杀（pid 可能被复用）；靠 `status` 的 `running` + `server_id` 一致性判断 |
| 产物 | ⚠️ **`mineru parse` 只产 markdown**（`--output` 收文件路径，收目录报错）；`mineru read --format` 只有 `{markdown, image}` |
| **遥测** | ⚠️ **Doclib 遥测默认开启**（端点 `https://mineru.net/metrics/v2/metrics`；`mineru telemetry disable` 或 `MINERU_TELEMETRY_DISABLED=1` 可关）⇒ **二期必须显式关闭**，否则会把使用数据发出去，与 §3.4「本地部署」的承诺冲突。（v1 的 kit 路线不涉及遥测 ✅） |
| **配置命令** | ⚠️ **`mineru config` 整个命令组都要 server 在跑**（`show` / `get` / `set` 全部报「本地 mineru 服务未运行」）—— 不只是 `set` |

---

## 7. 接口

### 7.1 端口

`capability-registry.md` §3 的 `CapabilityPorts` 新增一项：

```ts
export interface CapabilityPorts {
  // ...既有五项...
  /** 本地基础设施（`local-infra.port.ts`）—— 解析档位链 / 产物 / 降级。 */
  readonly localInfra: LocalInfraPort;
}
```

⚠️ **`LocalInfraPort` 用工厂签名，不带隐式依赖**（上一版是裸接口，实现要么在 CLI 里 new 一个 ExecutionPort、要么在实现内部 new —— 两条都违规，会出现**两个 ExecutionPort 实例**，代理策略 / 超时各走一套）：

```ts
export type LocalEngineId = "mineru";

/**
 * MinerU 的四档枚举。⚠️ 集合**不能硬编码成三档**：实测
 * `mineru-kit hardware detect --json` 的 `pdf_image_tiers` 是
 * `["flash","basic","standard","advanced"]`，其中 `flash` 官方文档从未出现过。
 */
export type MineruTier = "flash" | "basic" | "standard" | "advanced";
export const MINERU_TIERS: readonly MineruTier[] = ["flash", "basic", "standard", "advanced"];

/** 子进程代理策略。`strip` = 剥掉代理变量直连；`inherit` = 原样继承。 */
export type MineruProxyPolicy = "strip" | "inherit";

/** 引擎定位与代理策略的配置输入（来自 `ocr.*` 配置键）。 */
export interface LocalInfraConfig {
  readonly mineruPath?: string;      // 配置键 `ocr.mineruPath`（只指向 mineru-kit）
  readonly mineruProxy?: MineruProxyPolicy;  // 配置键 `ocr.mineruProxy`
}

/** 端口的依赖 —— 由组合根（bootstrap / CLI 入口）注入，与 CapabilityPorts 里的同一个实例。 */
export interface LocalInfraDeps {
  readonly execution: ExecutionPort;
  readonly fileSystem: FileSystemPort;
  /** 配置层解析出的引擎路径与代理策略。不给则只用 PATH 与常见安装位置探测。 */
  readonly config?: LocalInfraConfig;
  /** PDF 页数读取（超时预算要用页数）。不给则按 1 页计并在 `warnings[]` 说明。 */
  readonly pdf?: PdfDocumentPort;
}

export interface LocalInfraPort {
  /** 环境体检（只读）。 */
  doctor(options?: { readonly engine?: LocalEngineId }): Promise<LocalInfraDoctorReport>;
  /** 解析一份文档。 */
  parse(request: LocalParseRequest): Promise<LocalParseResult>;
  /** 下载目标档位的模型权重。 */
  downloadModels(request: LocalModelsDownloadRequest): Promise<LocalModelsDownloadResult>;
}

/** 组合根用这个工厂装配。 */
export function createLocalInfraPort(deps: LocalInfraDeps): LocalInfraPort;
```

⚠️ **`config` 与 `pdf` 都是可选的，但各有明确语义**：

- `config` 不给 ⇒ 只按 PATH 与常见安装位置探测引擎，代理策略取默认（`strip`）。**配置的读取与层级归配置层**（`ocr.mineruPath` / `ocr.mineruProxy`，层级：项目级 > 用户级），端口只负责"拿到路径后怎么用"。
- `pdf` 不给 ⇒ 解析超时预算按 1 页计，并在 `warnings[]` 说明。⚠️ **可选是刻意的**：poppler（`pdfinfo`）不是 ZCode 的依赖，缺它不应让解析功能不可用。

- **端口类型**放 `apps/zcode-cli/packages/contracts/src/interfaces/local-infra.port.ts` —— **纯 TS 接口，不引 zod**（`execution.port.ts` / `file-system.port.ts` 就是先例）。
- ⚠️ **必须同时进两个 barrel**：`packages/contracts/src/interfaces/index.ts` 与 `packages/contracts/src/index.ts`（后者是**逐个显式 export**，不是 `export *`）。
- **实现**放 `apps/zcode-cli/packages/adapters/src/local-infra/`。
- ⚠️ **必须走窄导入**：在 `adapters/package.json` 的 `exports` 增加 `"./local-infra"` 子路径，CLI 侧 `import { createLocalInfraPort } from "@zcode/adapters/local-infra"`。**只 import 根 barrel 会把 `node:sqlite`、MCP SDK、playwright、provider 全打进 CLI 启动路径**，拖慢每个 `zcode` 命令。

### 7.2 实现落点与依赖方向

```
packages/contracts  ←  端口类型（纯 TS）
packages/adapters   ←  实现：local-infra/（mineru-engine / tier-selection / artifact-unpack / proxy-env）
                         ↑ 复用既有 ExecutionPort / FileSystemPort
apps/zcode-cli/packages/cli  ←  CLI 外壳：zcode ocr
```

⚠️ **依赖方向单向向内**：`cli → adapters → contracts`。**不得**出现 `adapters → cli`（倒挂）。**已核对仓库现状**：`adapters` 依赖 `contracts`、不依赖 `cli`；`cli` 同时依赖两者 ⇒ 与上表一致，不会倒挂。

⚠️ **`ExecutionPort` 能不能自定义 env**：能。`ExecutionEnvOverlay{ base: "inherit"|"empty"; set?; unset? }`，实现里 `unset` 的删除循环在 `applyNetworkEgressEnv` **之后** ⇒ **能压掉策略重新注入的代理**；`deleteEnvKey` 对 Windows 大小写不敏感。
⚠️ **必须用 `base: "inherit"`** —— `base: "empty"` 会丢 PATH / HOME，uv 装的 shim 会挂。
⚠️ **`unset` 是精确匹配**（逐个 `delete env[key]`），§7.9 那 8 个变量名必须写全，**尤其 `all_proxy`**。

⚠️ **能力层与 CLI 层的装配点**：`createLocalInfraPort` 必须在**组合根**被调用（`packages/bootstrap`），CLI 侧在自己的入口调同一个工厂 —— **不许在 CLI 里 new 一个 ExecutionPort**。

### 7.3 `zcode ocr` 命令面

```
zcode ocr doctor [--json]
zcode ocr inspect --path <file> [--output <dir>] [--force] [--pdf-password <密码>] [--json]
zcode ocr parse --path <file> [--output <dir>] [--tier <tier>] [--force] [--pdf-password <密码>] [--json]
zcode ocr models download --tier <basic|standard> [--source <auto|huggingface|modelscope>] [--json]
```

⚠️ **`inspect` 是 2026-11-12 新增的积木**（形态见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §4 / §6.7）：只出**页成分 + 元素位置**，**不返回正文**、**没有 `--tier`**（档位是识别路线的概念，数字版 PDF 走原生分析路线压根不烧权重）。

⚠️ **`--force`**：忽略 sidecar 缓存强制重算并覆盖（接力与缓存判据见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §6.5）。⚠️ **`--pdf-password`**：加密 PDF 的密码，**只经 argv 传给子进程，不落盘、不入日志**（路线见 [`ocr-local.md`](./ocr-local.md) §3.2.1）。

⚠️ **`models download` 是 v1 的第四个子命令** —— §7.9 的代理策略与 §7.7 的 `ocr.mineruProxy` 旋钮都预设了"ZCode 会 spawn `mineru-kit models download`"这件事：若没有这个命令，那两处规则就悬空（配置键没有消费方）。⚠️ **MinerU 的 `models download --tier` 只接受 `basic` / `standard`**（实测 `mineru-kit models download --help`），其它档位命令面直接拒绝并给出可用值。

#### ⚠️ CLI 原子化：命令面按能力域切分（2026-11-11 用户定）

**一个能力域一个命令组；不设"基础设施总管"二进制。** 命令组之间**平级**、互不嵌套：

| 命令组 | 域 | 归属 spec | 状态 |
| --- | --- | --- | --- |
| `zcode ocr` | OCR / 文档解析（MinerU） | 本 spec | ✅ v1 已实现 |
| `zcode llm` | 本地 LLM 服务（llama.cpp 等） | — | ⏸ 未实现 |
| `zcode asr` | 语音转写（whisper 等） | [`audio-input.md`](./audio-input.md) | ⏸ 未实现 |
| `zcode asset` | 本地资产（语言包 / 权重，**跨能力域共享**） | [`model-assets.md`](./model-assets.md) | ⏸ 延期（§7.3 的 7 条待决） |

⚠️ **资产面独立成组，不挂在任何能力域底下** —— 资产（tessdata、whisper 模型、embedding 权重）被多个能力域共用，挂在任一能力域下都会让另一个域去调"别人的"命令组。

⚠️ **本组是 `zcode` 的子命令组，不是独立二进制** ⇒ 复用 `zcode` 的分派表、参数解析、退出码、i18n 与遥测；**发行链不需要第二个入口**。

⚠️ **2026-11-12 新增**：命令组与子命令的**业务接入形态**（积木模型、统一信封、sidecar 接力、`inspect` 子命令、`--force`）由 [`capability-cli-blocks.md`](./capability-cli-blocks.md) 定义 —— 本 spec 只管**引擎 / 档位 / 产物**这一侧。该 spec 同时推翻了 `capability-registry.md` §4.2 的 `zcode cap run` 通用执行面。

#### ⚠️ 旗标：`--path` / `--output` / `--tier` / `--source` / `--force` / `--pdf-password` 注册在 `zcode` 全局旗标表

`zcode` 的全局解析器是 `strict: true`（`packages/cli/src/arguments.ts`），**子命令的私有旗标必须在全局表注册**，否则 `zcode ocr parse --path x.pdf` 会在进分派表之前就报"未知参数"。⇒ 这**六个**旗标都在全局表注册，**命令组只做"哪个子命令收哪些旗标"的组合校验**（例如 `doctor` 不接受 `--path`，`inspect` 不接受 `--tier`）。

⚠️ **六个旗标的来源分两类**（2026-11-12 核对）：

| 旗标 | 来源 | 备注 |
| --- | --- | --- |
| `--path` / `--output` / `--tier` / `--source` | 2026-11-11 为本命令组注册 | 语义**跨能力域一致**（`--path` = 输入文件、`--output` = 产物目录、`--tier` = 档位、`--source` = 模型源）⇒ 将来 `zcode llm` / `zcode asr` 复用同一组旗标，不另起名字 |
| `--force` / `--pdf-password` | **本来就在全局表**（`--force` 供已有命令用；`--pdf-password` 是无头模式下密码 PDF 的非交互来源） | ⚠️ **不是本命令组新增的全局旗标**，但在本组里换了语义：`--force` = 忽略 sidecar 缓存重算；`--pdf-password` = 传 PDF 密码（**argv only**） |

⚠️ **`-p` 仍被 `--prompt` 占用** ⇒ OCR 命令组**只用长名旗标**，不引入短名（沿用 M14）。

⚠️ **`zcode ocr --help`**：本组有自己的用法文案（`OCR_USAGE`），在全局 `--help` 分发**之前**拦截 ⇒ `zcode ocr --help` 打印本组用法，`zcode --help` 的命令清单里有一行 `ocr`。

#### ⏸️ `asset` 命令组：v1 延期（不实现）

`model-assets.md` §5 的 `asset list|catalog|install|use|remove|verify|path` **在 v1 不实现**。原因不是工作量，而是**缺决策**：那份 spec 的默认资产目录只有占位地址（`https://cdn.example.com/zcode/assets/`、`https://mirror.internal/...`）⇒ 默认 `catalogUrl` / `baseUrl` **不存在**，`asset catalog` / `asset install` 的在线路径天然不可用。⇒ **要么把占位地址换成真实地址并补齐下面的决策，要么整个命令组不出现**——不能半实现（半实现的在线命令会给用户"能装"的错觉）。

需要先定的 7 件事（**都需要产品/运维侧拍板，实现侧无法代决**）：

| # | 待决 | 为什么阻塞 |
| --- | --- | --- |
| 1 | 资产目录的真实 `catalogUrl` 与 `baseUrl` | 现在只有占位地址 ⇒ 在线命令不可用 |
| 2 | 目录的**签名与校验**（manifest 签名、公钥分发） | 没校验就不能校验完整性，供应链风险 |
| 3 | 资产与 **MinerU 模型仓库**的关系 | 两套下载体系是否合并、谁负责缓存 |
| 4 | 资产落盘位置（`~/.zcode/assets`? 工作区内?） | 决定 `asset path` / `asset use` 的语义与隔离边界 |
| 5 | **离线**（`--offline`）的语义 | `model-assets.md` 的 `--offline` 从未进过 `zcode` 的全局旗标表 |
| 6 | `asset use` 改的是哪一份配置、要不要撤销/回滚 | 写状态就有 owner 与并发问题 |
| 7 | 与 tesseract 词表等**其它资产**的关系 | 决定 `asset list` 的分类维度 |

⇒ **v1 的资产能力只保留"引擎二进制由用户自行安装"这一条原则**（§3.1），资产目录下载整体延期。**`zcode` 的命令面里不出现 `asset` 子命令**——留一个空壳比不留更糟（将来它以 `zcode asset` 这个**平级命令组**出现）。

#### ⚠️ 交付形态：不需要第二个 bin（M5 的修正，2026-11-11）

独立二进制时代要改的 4 处（第二个 esbuild 入口 / `package.json` 的 `bin` / `build-zcode.mjs` 拷第二个 bundle + 第二个 runner / installer 写第二个 shim）**全部作废** —— 改成子命令组后：

| 事实 | 结论 |
| --- | --- |
| `@zcode/cli` 是 `private: true` ⇒ 它的 `bin` 字段**不会被物化** | 本来就只有一个真实入口 `zcode` |
| 发行链 `scripts/build-zcode.mjs` → `scripts/zcode-distribution/` 只认一个入口 | **零改动** |
| **SEA 只能一个入口** | ⇒ `zcode ocr` **在 SEA 里自动可用**（独立二进制时代不提供） |
| **Electron 桌面只 stage 一个 bundle** | ⇒ `zcode ocr` **在桌面 agent 里自动可用** |

⚠️ **代价**：独立二进制时代"不带 agent 运行时的轻量入口"没有了 —— `zcode ocr doctor` 会随 `zcode` 一起求值 `@zcode/core`（模块加载成本，不是运行时初始化）。**可接受**：体检 / 解析都不是高频热路径，且换来的是 SEA / 桌面自动具备 + 零分发改动。

⚠️ **`doctor` 与 `zcode doctor` 同名不同义**：`zcode doctor` 是"运行时与打包假设检查"（version / node / platform / sea），本 `doctor` 是"本地解析引擎体检"。⇒ 输出标题必须明确写"本地解析引擎体检"，不得混。
⚠️ `commands.md` 里「`zcode doctor` 是唯一进程级入口」这条不变式**不再需要例外** —— `zcode ocr doctor` 与 `zcode doctor` 在**同一个进程入口**下（§10 同步清单）。

### 7.4 `doctor` 契约

```ts
export interface ModelRepoStatus {
  readonly repo: string;                 // "MinerU-4_models_torch"
  readonly ready: boolean;
  readonly path?: string;
}

/** 档位 → 需要的模型仓库。⚠️ 只有 basic / standard 有映射（实测）。 */
export interface TierModelStatus {
  readonly tier: MineruTier;
  /**
   * "ready"（全部必需仓库就绪）| "missing"（引擎明确报出至少一个必需仓库缺失，
   * 含全新机器）| "unknown"（无仓库映射，如 flash / advanced；或引擎输出里
   * 查不到必需仓库的状态）。见 §5.4。
   */
  readonly status: "ready" | "missing" | "unknown";
  readonly repos: readonly ModelRepoStatus[];
  /** 下载命令（status = "missing" 且档位为 basic / standard 时给）。 */
  readonly downloadCommand?: string;
}

export interface LocalInfraDoctorReport {
  readonly engines: readonly EngineAvailability[];
  /** 本机档位上限（`hardware detect` 的 `ceiling`）。 */
  readonly ceilingTier?: MineruTier;
  /** 本机支持的档位列表（`pdf_image_tiers`）。 */
  readonly supportedTiers: readonly MineruTier[];
  /** 不指定档位时的默认档位（`default_request_tier`）。 */
  readonly defaultTier?: MineruTier;
  /** 推理设备（`device`；实测本机 `mps`）。 */
  readonly device?: string;
  /** ONNX 标定状态（`calibration`）—— 解释"为什么 ceiling 比预期低"。 */
  readonly calibration?: Record<string, unknown>;
  /** 每个档位的模型就绪情况。 */
  readonly models: readonly TierModelStatus[];
  /** 本次探测是否下载了权重 —— 恒为 false（doctor 是只读命令）。 */
  readonly weightsFetched: false;
  readonly durationMs: number;
}
```

- ⚠️ **doctor 的退出码恒为 0**（除非参数非法）：体检报告本身就是结果，"不可用"是**有效报告**而不是命令失败。
- ⚠️ **doctor 只读**：不下载权重、不装依赖、不写任何状态（M3）。
- ⚠️ **不得在输出里泄露内部源地址 / 凭据**（AGENTS.md 日志纪律）。

### 7.5 `parse` 契约

```ts
export interface LocalParseRequest {
  /** 待解析文件的绝对路径。 */
  readonly path: string;
  /** 产物输出目录；不给则落到源文件旁的 `<源文件名>.mineru/`。 */
  readonly outputDir?: string;
  /** 显式指定档位；不给 = 用 MinerU 的 `default_request_tier`。 */
  readonly tier?: MineruTier;
}

/** 失败形态。⚠️ 上一版没有这个字段，导致验收 A4/A5/A6 无法通过。 */
export interface LocalInfraError {
  /** 内部码；对外归一由能力层做（§7.6）。 */
  readonly code: LocalInfraErrorCode;
  readonly message: string;          // 中文，可直接给用户看
  readonly hint?: string;            // 可处置提示
  readonly details?: Record<string, unknown>;
}

export interface LocalParseOutput {
  /** 产物目录。 */
  readonly outputDir: string;
  /** 扫描产物目录得到的实际 markdown 路径。 */
  readonly markdownPath?: string;
  /** 扫描产物目录得到的实际结构化内容路径。 */
  readonly structuredContentPath?: string;
  /** 扫描产物目录得到的实际中间结果路径。 */
  readonly middleJsonPath?: string;
  /**
   * 图片等资源所在的目录（可能不存在）。
   * ⚠️ 必须**落在 markdown 所在目录之内**（同级或其子目录）——markdown 的图片引用是
   * 相对路径（`![](images/page_0_image_0.jpg)`），只搬三个文档文件 = 图片全断。
   * 消费方按 `relative(markdownDir, assetsDir)` 还原目录名再一起搬。
   */
  readonly assetsDir?: string;
}

export interface LocalParseResult {
  readonly ok: boolean;
  readonly engine?: LocalEngineId;
  /** ⚠️ **从产物回填**（`extensions.mineru.tier`），不是回填请求值。 */
  readonly tier?: MineruTier;
  /** 发生过降级时的上一档位。 */
  readonly degradedFrom?: MineruTier;
  readonly output?: LocalParseOutput;
  /** 失败时必填。 */
  readonly error?: LocalInfraError;
  /** 人话告警（降级原因等）。 */
  readonly warnings: readonly string[];
  readonly durationMs: number;
  /**
   * 引擎自己的 stdout（人读文本，**不是 JSON**）。
   * ⚠️ 消费方**不得**把它当 JSON 解析 —— 它只能当进度信息写到 stderr（验收 A10）。
   */
  readonly stdout?: string;
}
```

⚠️ **`langList` 已从契约里删除** —— 实测 `mineru-kit parse --help` **没有语言选项**（语言是模型侧的自动判定，不接受调用方指定）。⇒ 契约里留一个引擎不认的字段，等于给出一个"传了也没用"的假旋钮。⚠️ MinerU 的语言词表（`ch` / `en` / …）与 ZCode 现有 `languages`（`chi_sim` / `eng`）的映射**整体挪到二期**（原 O3 仍开放，但前提从"透传"改成"等引擎支持指定语言再说"）。

⚠️ **产物路径必须由实现扫描产物目录得到**，不得硬编码文件名（§5.5）。

**`zcode ocr parse --json` 的输出样例**：

```jsonc
// 成功
{
  "version": 1,
  "key": "ocr.parse",                                   // ⚠️ 积木 id（不是能力键 `ocr`）
  "ok": true,
  "output": {
    "cached": false,                                    // ⚠️ true = 命中 sidecar 缓存，未重跑引擎
    "sidecarPath": "/work/扫描件.pdf.zcode-ocr.json",
    "artifactsDir": "扫描件.pdf.mineru",                // ⚠️ 相对 sidecar 所在目录
    "engine": "mineru",                                 // ⚠️ 原生分析路线时是 "pdf-native"
    "tier": "basic",                                    // ⚠️ 从产物的 extensions.mineru.tier 回填；原生路线是 "native"
    "artifacts": {                                      // ⚠️ 产物引用**相对 artifactsDir**
      "markdownPath": "markdown.md",
      "structuredContentPath": "structured_content.json",
      "middleJsonPath": "middle_json.json",
      "assetsDir": "images"                             // ⚠️ 有裁剪图时才有
    }
  },
  "metrics": {
    "warnings": ["档位 advanced 在本机不可用（pdf_image_tiers 不含），已用 basic"],
    "degradedFrom": "advanced",                         // 发生过降级时才有
    "durationMs": 8261
  }
}

// 失败
{
  "version": 1,
  "key": "ocr.parse",
  "ok": false,
  "error": {
    "code": "unavailable",                                  // ⚠️ 归一后的能力码，不是内部码
    "message": "未找到 mineru-kit 可执行文件",
    "hint": "安装：uv tool install --python 3.12 \"mineru>=4.0,<5\"",
    "details": { "engineCode": "engine_unavailable", "searched": ["PATH", "~/.local/bin", ".venv/bin"] }
  },
  "metrics": { "durationMs": 12 }
}
```

⚠️ **`error.code` 对外是归一后的能力码，内部码在 `details.engineCode`**（§7.6）—— 业务方按能力码分支，运维按内部码定位。⚠️ **ZCode 自己的 stdout 是上面这样的单个 JSON 对象**；⚠️ **MinerU 的 stdout 是人读文本**（`已解析 1 个输入。`），**不得当 JSON 解析**（M4）⇒ **那段文本走 stderr**（当进度信息），不混进 stdout 的 JSON（验收 A10）。

⚠️ **2026-11-12 起顶层不再有 `engine` / `tier` / `degradedFrom` / `warnings`**（统一信封的字段归属见 [`capability-cli-blocks.md`](./capability-cli-blocks.md) §5.4）：`engine` / `tier` 进 `output`，`warnings` / `degradedFrom` / `durationMs` 进 `metrics`。⚠️ **旧的 `output.outputDir` / `output.markdownPath` 等绝对路径也一并移出 `output`** —— 现在 `output.artifactsDir` 相对 sidecar 目录、`output.artifacts.*` 相对 `artifactsDir`（§6.2 的路径基准），**消费方按基准解析，不要按绝对路径猜**。

### 7.6 错误码与退出码

**内部码**（本地基础设施层内部流转）：

| 内部码 | 含义 | 归一后的能力码 |
| --- | --- | --- |
| `engine_not_found` | 档位不在官方枚举内 | `invalid_input` |
| `engine_unavailable` | 引擎不可执行 / 依赖缺失 / 硬件不足 | `unavailable` |
| `process_failed` | 引擎执行失败（非零退出） | `internal` |
| `artifact_missing` | 退出码 0 但产物缺失 | `internal`（**不是**成功） |
| `timeout` | 超时 | `timeout` |
| `input_invalid` | 文件不存在 / 格式不支持 | `not_found` / `unsupported_input` |

⚠️ **统一用 `process_failed`，不用 `engine_failed`** —— tesseract 路线已有的就是 `process_failed`（`ocr-local.md` §8），两个名字指同一件事会让按 `details.engineCode` 分支的业务方漏掉一侧。

⚠️ **两层各有一份码，职责不同**（验收 A4 的形状由这两层共同决定）：

| 层 | `error.code` 取值 | 内部码在哪 |
| --- | --- | --- |
| **端口层**（`LocalInfraError`） | **内部码**（`engine_not_found` / `engine_unavailable` / `process_failed` / `artifact_missing` / `timeout` / `input_invalid`） | 就在 `code` 里 |
| **命令面**（`zcode ocr parse --json`） | **归一后的能力码**（上表右列） | `details.engineCode` |

⇒ **验收 A4 在命令面上的形状是 `error.code = "invalid_input"` + `details.engineCode = "engine_not_found"`**（不是 `error.code = "engine_not_found"`）。⚠️ **命令面不得预校验档位**：预校验会让这个形状出不来（命令面拦下时只有自己的码，没有引擎的内部码），所以档位枚举的判定**只在端口层做一次**，且必须发生在**任何 spawn 之前**。

⚠️ **`input_invalid` 的二选一规则要写死**：
- 文件**不存在** → `not_found`
- 文件**类型不支持**（既不是 PDF 也不是图片） → `unsupported_input`

**`zcode ocr parse` 的退出码**（⚠️ 上一版完全缺失 —— 一个对外进程级命令面却没有退出码语义）：

| 情形 | 退出码 |
| --- | --- |
| 成功 | `0` |
| 参数非法 / 文件不存在 / 档位不在枚举内 | `1` |
| 引擎不可用 / 依赖缺失 / 硬件不足 | `1` |
| 引擎执行失败 / 产物缺失 | `1` |
| 超时 | `124` |
| 被取消（SIGINT） | `130` |

⇒ 与 `capability-registry.md` §7 的能力退出码表**同源**（`1` / `124` / `130`），业务方可以用同一套分支逻辑。

### 7.7 配置键

| 键 | 含义 | 备注 |
| --- | --- | --- |
| `ocr.mineruPath` | **`mineru-kit` 可执行文件**的绝对路径 | ⚠️ **只指向 `mineru-kit`**。`mineru`（版本检查用）由**同目录 sibling** 推导；若推导不到，`doctor` 报"只缺版本检查工具"，`parse` 仍可工作 |
| `ocr.mineruProxy` | `"strip"`（默认）\| `"inherit"` | 见 §7.9 |

⚠️ **落地顺序错了会炸整个 CLI**：

1. **先**在 `adapters/src/config/schema.ts` 的 `ZCodeConfigFileSchema` **新增 `ocr` 段**（`z.object({ mineruPath: z.string().optional(), mineruProxy: z.enum(["strip","inherit"]).optional() }).optional()`）—— ⚠️ **当前 schema 里根本没有 `ocr` 键**。
2. **再**把 `ocr: true` 加进 `projectConfigFileSchema` 的 `.pick({...})`。

⚠️ **顺序反了会怎样**：zod v4 的 `.pick()` 遇到不存在的键**直接抛** `Unrecognized key: "ocr"` ⇒ **`schema.ts` import 即抛 ⇒ 整个 CLI 启动即死**（不只是新命令坏），且报错点离改动点很远。

⚠️ `ocr.enginePath`（tesseract 侧，`ocr-local.md` §9）**目前只存在于 spec 文本，代码里不存在** ⇒ 新增 `ocr` 段时可以把 `enginePath` / `popplerPath` 一并纳入。

- **查找顺序**：配置键 → PATH → 常见 venv 位置（`~/.local/bin`、项目 `.venv/bin`、Windows 的 Python `Scripts` 目录、`uv tool` / `pipx` 的 shim 目录）。
- 可复用 `adapters/src/exec/windows-executable.ts`（PATHEXT / `.cmd` / `.exe`）与 `adapters/src/context/git-snapshot.ts` 的 `findExecutableOnPath`。

### 7.8 超时与进度

⚠️ **现有 `ExecutionPort` 只有一个 `timeoutMs`、一个定时器、超时即杀整个进程组，没有"阶段"概念** ⇒ "冷启动单独计时、额度另给"**表达不出来**。修正后的规则：

| 项 | 规则 |
| --- | --- |
| **总预算** | `timeoutMs = 冷启动基线 + 页数 × 单位额度` |
| 冷启动基线 | `10min`（首次实测到过 123.5s；留足余量） |
| 单位额度 | `flash`/`basic` = **5s/页**；`standard` = **15s/页**；`advanced` = **60s/页** |
| 页数来源 | ⚠️ **超时公式依赖页数，但请求契约里没有页数**。用既有的 `PdfDocumentPort.getPageCount`（`adapters/src/pdf/index.ts:37`）；**取不到页数（图片 / 未知格式）时按 1 页计**，并在 `warnings[]` 说明"按 1 页计费" |
| 超时语义 | ⚠️ **超时 = 杀进程组**（`ExecutionPort` 的既有语义）。⇒ **无法区分"模型没加载起来"和"文档太大"** —— 这是本条路的已知代价，报错文案要同时给出这两种可能 |
| 进度通道 | **stderr**；ZCode 自己的 stdout 恒为单个 JSON 对象（M4） |

⚠️ **额度是按实测重标的**（上一版给的是 30/60/120s/页，**离实测差 100~400 倍**）：实测边际成本 **0.314 s/页**（standard）、flash 1 页 0.434s、**advanced 1 页 10.2s**（Two Step Extraction）⇒ 额度给 5/15/60s/页（15~50× 余量），**advanced 必须单独一档**（60s/页 起步）。

⚠️ **归一化与档位差异也要提示** —— 降级时产物形状会变（块类型集合、切分粒度、bbox 精度都不同，见 §5.5）⇒ `warnings[]` 必须带一句"**产物形状可能与请求档位不同**"。

⚠️ **不照抄 `ocr-local.md` §8 的"单页 120s / 整批 30min"** —— 一份 300 页 PDF 会远超 30min，照抄会**静默杀掉合法任务**。

### 7.9 子进程环境：代理变量必须显式决定

⚠️ **实测踩坑（连续两次）**：`ALL_PROXY` / `http_proxy` / `https_proxy` 指向 **SOCKS** 代理时，MinerU 的 httpx 会直接失败：

```
Using SOCKS proxy, but the 'socksio' package is not installed.
Make sure to install httpx using `pip install httpx[socks]`.
```

这不是 MinerU 的 bug，是 httpx 读到 SOCKS 代理后需要 `socksio` 依赖 —— 而 MinerU 默认不带这个 extra。

⚠️⚠️ **这与 `model/http-proxy.md` 的子进程策略相反，不是"与既有纪律一致"** —— 那份文件对**子进程**的规定是**恢复**用户 shell 的代理变量（`:9` "在 tool 边界恢复用户 shell 里的 HTTP_PROXY / http_proxy / NODE_EXTRA_CA_CERTS"），"不继承"只约束 **ZCode 自身出口**。⇒ **"默认剥离"是一次新增例外，必须去 `model/http-proxy.md` 登记**，否则两份 spec 互相矛盾。

| 策略 | 做法 | 适用 |
| --- | --- | --- |
| **`"strip"`（默认）** | spawn 时从 env 里**删掉** `ALL_PROXY` / `all_proxy` / `http_proxy` / `https_proxy` / `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` / `no_proxy` | 目标是**直连**下载（国内 ModelScope 直连可用） |
| `"inherit"` | 原样继承 | 用户的网络**必须**走代理才能访问模型源 |

⚠️ **只对"下载"生效，解析不需要** —— 实测 `mineru-kit parse` 在模型已就绪时是**纯本地推理**（llama.cpp + MPS），不联网。⇒ 剥离只施加于 `mineru-kit models download` 子进程。

⚠️ **`unset` 是精确匹配**，8 个名字必须写全（尤其 `all_proxy`）。

⚠️⚠️ **这是 SOCKS 专属故障** —— httpx 只在读到 **SOCKS** 代理时需要 `socksio`；**HTTP/HTTPS 代理不会触发这个报错**。⇒ 本条规则的适用范围是"避免 SOCKS 代理打断下载"，**不是"所有代理都要剥"**（用户若只有 HTTP 代理，剥了反而会让本来能下的模型下不来）⇒ 所以才有 `ocr.mineruProxy` 这个开关。

⚠️ **CA 维度没覆盖** —— `model/http-proxy.md` 要求转发 `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE`（它点名"提升 Node、OpenSSL/curl、**Python requests** 和 git 的一致性"），而本节只处理 8 个代理变量、**一个 CA 变量都不管** ⇒ 企业 MITM 环境下下载会因证书校验失败，且失败长得像网络问题。⚠️ **未实测** httpx 是否认 `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` ⇒ **实施时必须验一次**，并把结论与变量清单补进本节与 `model/http-proxy.md` 的例外登记。

⚠️⚠️ **绝不传远端旗标** —— `mineru-kit parse` 支持 `--remote` / `--remote-url` / `--api-key` 三个走远程解析的旗标。⇒ **ZCode 绝不传这三个**（`zcode ocr` 的命令面**不暴露**对应选项，实现里也**不构造**这些参数）。理由：① "本地基础设施"这个产品承诺不能被静默打破；② 用户全局的 `~/.mineru/config.yaml` 里 `parse_server.remote.url` 默认就是 `https://mineru.net/api`；③ 远程解析会把文档送出本机。

⚠️ **ZCode 不控制模型源** —— MinerU 的 `model.source` 默认是 `huggingface`（实测 `mineru-kit models show`）。

⚠️⚠️ **上一版那句"直连 HF 超时（15s）、直连 ModelScope 可用（0.3s）⇒ 所以要改用 ModelScope"是自相矛盾的**：同一节里又记着"**HF 下载经 `mineru-kit models download` 走通了**"（三个仓库共 2.9GB 全部就绪，源就是 huggingface）。⇒ **那两条网络实测只测了某个探针 URL，不是完整下载** ⇒ 不能据此建议用户改模型源。

⇒ **处置：删掉"建议改 ModelScope"这条 doctor 提示**，改成**只报告事实**："当前 `model.source = huggingface`；若下载失败，可试 `--source modelscope`"。**建议用户改配置前，先实测一次完整的 HF 下载耗时**（含 1.2GB GGUF）—— 未测前不给建议。

⚠️ **模型目录也不是固定的** —— `mineru-kit models show` 报告 `model.base_dir` **可配**（默认 `~/.mineru/models`），且受 `MINERU_HOME` 影响。⇒ §7.7 要补这两个旋钮，**不要**把 `~/.mineru/models/` 硬编码。

### 7.10 与 OCR 能力的接线（v1 不做，边界写死）

⚠️ **能力层的接线与「按需供给」不是一回事**：能力层（`ocr-local.md`）整块未实现；**供给层**（[`capability-provisioning.md`](./capability-provisioning.md)）已实现第 1 步 —— 它在**附件解析阶段**判定「模型既不支持 PDF 也不支持图片」时，**直接调本端口**把文档转成 markdown 投进 prompt，**不经过能力层**（能力层那套 `OcrCapabilityInput/Output` 契约仍待改，见本节末尾）。

OCR 能力的引擎选择**不再由能力层做**：能力把文档交给 `localInfra` 端口，端口内部定档位、降级、回填 `tier` / `degradedFrom` / `warnings`。

⚠️ **两个引擎语义不能混**（v1 只有 MinerU，但 `ocr-local.md` 的 tesseract 路线仍在）：

| `ocr-local.md` 的输入字段 | MinerU 路径下的处理（M6） |
| --- | --- |
| `psm` / `preprocess` / `thresholdingMethod` / `noWords` | **明确拒绝**（报错），不静默忽略 —— 它们是 tesseract 专属 |
| `pages`（"all" / "auto" / "1-5,8"） | MinerU 走**整份文档**语义；子集需求用 MinerU 自己的 `--pages` 表达，不复用该字段 |
| `strategy`（"fill" / "override"） | MinerU 不区分 → **明确拒绝** |
| `languages`（`chi_sim` / `eng`） | ⏸️ **暂不支持**：实测 `mineru-kit parse` **没有语言选项** ⇒ 二期等引擎支持指定语言后，再做"两套词汇表必须显式映射、不能同名直传"的映射表 |
| `dpi` | MinerU 自行决定渲染分辨率 ⇒ **明确拒绝** |
| `password` | 沿用 `ocr-local.md` §3 的严规矩：只经 argv、不落盘不入日志、MCP / 内置工具投影必须拒绝。⚠️ **2026-11-12 补充**：MinerU 4.1.7 **没有密码入口**（实测 `mineru-kit parse` 报 `Failed to load document (PDFium: Incorrect password error).`）⇒ 密码**不由引擎消费**，而是由 ZCode 侧 poppler **前置解密**（路线见 [`ocr-local.md`](./ocr-local.md) §3.2.1） |

⚠️ `ocr-local.md` §3 的 `OcrCapabilityInput` / `OcrCapabilityOutput` 也要一并改（**§10 同步清单里已补上**）。⚠️ **`OcrCapabilityOutput` 必须是**唯一**一份声明**（上一版在同一个 spec 里声明了两次，形状冲突且 TypeScript 直接编译报错）。

⚠️ **`OcrCapabilityInput` 要补 `engine` / `tier` 字段** —— 否则输出是按 `engine` 判别的联合类型，输入却无法触发判别式（要么 tesseract 分支是死代码，要么能力层得自己选引擎，与"能力层不选引擎"冲突）。

⚠️ **降级要有对外落点**：`degradedFrom` 必须出现在**能力输出**里（不只存在端口层），否则业务客户端机器读不到"从哪档降下来的"。

⚠️ **"引擎 + 档位"有三处编码，映射必须写死**（否则各层消费方各写各的）：

| 层 | 编码 | 出处 |
| --- | --- | --- |
| **端口层** | `engine: "mineru"` + 独立 `tier: "basic"` | §7.5 `LocalParseResult` |
| **能力输出层** | `engine: "mineru-basic"`（档位编进 engine 串），另有独立 `tier` 字段 | `ocr-local.md` §3.3 |
| **sidecar** | `engine.name: "mineru"` + `engine.variant: "mineru"` + `engine.tier: "basic"` | `ocr-local.md` §6.1.1 |

⇒ **映射规则**：端口层 `engine="mineru"` + `tier=T` ⇒ 能力层 `engine = "mineru-" + T`（tesseract 路线是 `engine="tesseract"`、无 tier）⇒ sidecar `engine.name="mineru"` / `engine.variant="mineru"` / `engine.tier=T`。

⚠️ **能力层的 `tier` 字段是权威值**，不是把 `engine` 字符串拆出来的 —— 消费方应当读 `tier`，`engine` 只用来判别分支。

---

## 8. 验收场景

⚠️ 仓库约定（AGENTS.md）：**App 业务单测已退役**；CLI 侧保留各自包的回归测试入口，不默认全量。**测试入口以目标包 `package.json` 与实际测试文件为准**。

| 测试落点 | 框架 | 注意 |
| --- | --- | --- |
| `packages/adapters`（端口 / 实现） | `vitest tests` | 目录自动发现，新建 `tests/` 即可 |
| `packages/cli`（CLI 命令面） | `node --test` + **package.json 显式文件清单** | ⚠️ **新测试文件不加进 `scripts.test` 就不会被跑** |
| 根 `pnpm test:engineering` | — | ⚠️ 清单里 `apps/zcode-cli/**` **0 条** ⇒ 不能用根门禁跑这些测试 |

⚠️ **fake 引擎契约**：fake 必须**模仿 `mineru-kit`**（只有它能产 zip）。要能注入：
- **可执行文件路径** —— 经 `ocr.mineruPath` 配置键注入（fake 放在 `packages/cli/tests/fixtures/` 下）
- **产物契约** —— fake 要产出与真实一致的 zip：`markdown.md` / `middle_json.json` / `structured_content.json`，且 `structured_content.json` 里有 `extensions.mineru.tier`（否则"从产物回填 tier"这条测不了）
- **故障注入** —— 两种：`退出 0 但不产出文件`、`非零退出`

| 编号 | 场景 | 断言 | 落点 |
| --- | --- | --- | --- |
| A0 | **真实 MinerU 环境**跑一次 `mineru-kit parse` | ✅ **已实测通过**（§11.0）：中文全部识别正确、8.26s、产物三件套齐。⚠️ **2026-11-09 用真实二进制复核**：真实 `mineru-kit` 4.1.7 + 真实 PDF → `ok = true`、12.7s、三件套齐、`tier` 从产物回填为 `standard`、`stdout` 是单个 JSON 对象（MinerU 的人读输出在 stderr） | 手工 |
| A1 | 环境里没有 MinerU，`doctor --json` | 退出码 **0**；`available = false`；带 `reason` + `fix`（装法）；`weightsFetched = false`；**无任何下载发生** | adapters |
| A2 | 只配了 `ocr.mineruPath`（不在 PATH） | `doctor` 仍能找到并报为可用 | adapters |
| A3 | 显式 `--tier advanced`，本机 `pdf_image_tiers` 不含它 | **降到 `ceiling`** 并执行**一次**；`degradedFrom = "advanced"`；`warnings[]` 含原因；`result.tier` = 实际用的档位 | adapters |
| A4 | 显式 `--tier turbo`（**不在官方枚举内**） | `ok = false`；`error.code = "invalid_input"`；`details.engineCode = "engine_not_found"`；**不 spawn** | adapters |
| A5 | fake 引擎**退出码 0 但不产出任何文件** | 必须报失败（`details.engineCode = "artifact_missing"`），**不得**当成功 | adapters |
| A6 | fake 引擎**非零退出** | 报失败（`process_failed`）；**不得**自动换档重跑 | adapters |
| A7 | 多页 **PDF** | 断言调用参数含 **`--pages all`**；产物是**一份**整文档产物 | adapters |
| A8 | **图片**输入 | 断言调用参数**不含** `--pages`；解析成功 | adapters |
| A9 | `zcode asset` 各子命令 | ⏸️ **v1 延期**：`asset` 命令组不实现（阻塞项见 §7.3 的 7 条待决） | cli |
| A10 | stdout 契约 | `--json` 时 stdout 是**单个可解析的 JSON 对象**；进度信息只在 stderr；**MinerU 自己的 stdout 是人读文本，不当 JSON 解析** | cli |
| A11 | **代理环境变量存在时**（`ALL_PROXY=socks5://…`） | 下载子进程里代理被剥离（§7.9）；解析子进程不受影响 | adapters |
| A12 | **产物文件名随版本变** | 分类按**内容**不按文件名（§5.5）；解包前清空目标目录 | adapters |
| A13 | **一次调用** | 只 spawn **一次** `mineru-kit parse`（一次付冷启动），三件套一次取全 | adapters |
| A14 | 临时 zip 路径**不带 `.zip` 后缀** | 必须报错或补后缀，**不得**让 MinerU 建目录（否则产物找不到） | adapters |
| A15 | zip 含**恶意条目名**（`../`、绝对路径） | 解包拒绝，不写到目标目录之外 | adapters |

⚠️ **A4 的两处码** —— 表里写的 `error.code = "invalid_input"` 是**命令面**的形状（`zcode ocr parse --json`）；**端口层**返回的是内部码 `engine_not_found`（§7.6 的两层码）。两侧都要断言。

**回归覆盖现状（2026-11-09）**：

| 落点 | 文件 | 覆盖 |
| --- | --- | --- |
| adapters | `packages/adapters/tests/local-infra/local-infra.test.ts` | A1、A2、A3、A5、A6、A7、A8、A11、A12、A13、A14、A15 + 输入校验（not_found / unsupported_input）+ assetsDir 不变式 |
| adapters | `packages/adapters/tests/local-infra/locator-and-tier.test.ts` | 引擎定位（PATH / 配置路径 / 找不到）+ 档位判定（默认值 / 降级 / 非法档位 / 内存闸门） |
| cli | `packages/cli/tests/ocr-command.test.ts` | A4（命令面形状 + 不预校验）、A5、A6（命令面形状）、A10（stdout 单 JSON / 进度走 stderr）、退出码 0/1/124、`doctor` 只读、`models download` 档位约束 |

⇒ **A0 仍是手工**（真实 MinerU 环境），**A9 延期**（§7.3）。

---

## 9. 风险与开放问题

### 9.1 风险

| 编号 | 风险 | 应对 |
| --- | --- | --- |
| R1 | MinerU 的 CLI 参数、产物文件名**随版本变**（4.x 已与 2.x 完全不同） | 不硬编码；按内容分类；参数以 `mineru-kit parse --help` 为准 |
| R2 | **每次调用付一次模型加载**（首次 123.5s，之后 ~8s） | 一次任务一次调用取全三件套（M9）；批量粒度=一份文档（§5.3） |
| R3 | 模型文件 0.8~3GB，用户磁盘可能不够 | doctor 报"缺哪个档位的模型 + 怎么下"；不自动下载（D6） |
| R4 | **代理环境打断 MinerU** | 只对下载子进程剥离（§7.9），且做成可配置 |
| R5 | 档位枚举可能继续变（`flash` 官方文档都没写） | 集合从 `pdf_image_tiers` **动态取**（M11），不硬编码 |
| R6 | **新 `.ts` 文件要过架构登记** | 驱动键是 `scripts/architecture/policy.mjs` 的 `newFilesRequireManagedModule`（**默认 true**）+ `newFileScopes`（默认 `["packages","apps"]`）⇒ `apps/zcode-cli/**` 的新 `.ts` 命中 `unmanaged-new-file`（`zcode-cli` 模块 `managed: false`）。⚠️ **`pnpm architecture:adopt` 要求目录已存在**，且会**生成 4 个带 TODO 的骨架文件**（`module.ts` / `contract.ts` / `contract.example.ts` / `CONTRACT.md`），`--layer` 默认 `adapters` 需显式指定；**至少要登记 2 处**（contracts 接口文件 / adapters 实现目录）。⚠️ 走"逐文件例外"有先例（`architecture-policy.yaml` 的 `exceptions`，含 `audio-transcription-port-declarations` 同型） |
| R7 | v1 没有 tesseract 兜底（D8 已知代价） | `unavailable` 的 hint 必须写清装法 |
| R8 | MinerU 自带索引与 ZCode 知识索引重叠 | §3.3 的"一套索引所有者"规则 |
| R9 | **`bbox` 单位与 tesseract 侧不同**（归一化 0~1 vs 像素） | 两个 sidecar 变体各带引擎标识，消费方按引擎分流（`ocr-local.md` §6.1.1） |
| R10 | ⚠️ **已作废（2026-11-11）**：`zcode ocr` 改成 `zcode` 的子命令组后**没有分发链改动**（无第二个 bin） | 该风险的成因已消失；改为关注「子命令组是否真的进了 `zcode` 的分派表」——漏了就是"命令静默不可用" |
| R11 | **代理剥离与 `model/http-proxy.md` 的子进程策略相反** | 去那份文件登记例外（§7.9），不要让两份 spec 互相矛盾 |
| R12 | **超时无法区分"模型没加载起来"与"文档太大"**（`ExecutionPort` 单定时器语义） | 报错文案同时给出两种可能；二次是引入常驻 worker（§5.6） |

### 9.2 开放问题

| 编号 | 问题 | 归属 |
| --- | --- | --- |
| O1 | `zcode ocr` 与 `zcode` 同属 `@zcode/cli` 包，两个 bin 的版本升级与发布节奏要不要绑死 | 待定（实现者） |
| O2 | 产物目录默认名 `<源文件名>.mineru/` 是否要进 workspace `.gitignore` | 待定（与 `ocr-local.md` §11 的 sidecar 讨论一起做） |
| O3 | MinerU 的语言词表（`ch` / `en` / …）与 ZCode 现有 `languages` 的**完整映射表** | 二期（⚠️ v1 **不透传** —— 实测 `mineru-kit parse` 没有语言选项） |
| O4 | 服务端若调用 MinerU，需显著标注"MinerU 被使用"（§3.4）——服务端 RAG 落地时要处理 | 服务端 RAG 那个 spec |
| O5 | v1 的产物要不要同时被 `office-runtime` 读（扫描件 PDF 打开能出文字） | v2（§1 范围的产品空洞） |
| O6 | ✅ **已由实测回答**：Doclib 路线给不了结构化块 ⇒ **v1 走无状态路线**（D9 修订） | 已决（2026-11-08） |
| O7 | `flash` 档的硬件要求与质量表现（官方文档未给）；**且它是 Office/HTML/CSV 的唯一可用档位** | 实测待补 |
| O8 | MinerU 的 `middle_json.json` 是否还需要消费（`structured_content.json` 已够用） | 待定（二期） |
| O9 | `mineru` 与 `mineru-kit` 的 sibling 推导在没有 `mineru-kit` 的安装布局下怎么办（用户可能只装了其中一个） | 待定（doctor 降级为"只报版本检查不可用"） |
| O10 | `zcode ocr` 是否也需要 `zcode` 那套遥测 / i18n | 待定（实现者） |
| O11 | `asset` 命令组的 7 条待决（目录地址 / 签名 / 与模型仓库的关系 / 落盘位置 / `--offline` 语义 / `asset use` 写哪份配置 / 资产分类维度）—— §7.3 | 待决（产品 / 运维） |
| O12 | **Windows 侧的补充实测**：`.exe` 布局、`ceiling` / `device` 在 CUDA（显存 < 8GB）下的取值、zip 里的 `images/` 是否一致、临时目录清理、首次运行真实耗时、1.2GB 权重的完整下载耗时、一次真实的 Doclib 运行、`doctor()` 的探测耗时（macOS 实测 ~2.5s/次，见 [capability-provisioning.md](./capability-provisioning.md) §9.3） | 待补（2026-11-09 起在 Windows 机器上验证） |

---

## 10. 同步清单（改 spec 时要一起动的地方）

| 文件 | 要改什么 | 状态（2026-11-09） |
| --- | --- | --- |
| `ocr-local.md` | §3 `OcrCapabilityInput`（补 `engine` / `tier` 字段；补 `dpi` 在 MinerU 路径的处置）；§3 `OcrCapabilityOutput`（**删掉重复声明**，只留一份联合类型，补 `tier` / `degradedFrom` / `sidecarPath` / `middleJsonPath`）；§4 引擎契约；§5 流水线；§6 sidecar（两变体、bbox 单位列、`engine.variant` 补进 v1 示例、补 v2 示例 JSON、tier 枚举补 `flash`）；§7 **状态所有者**（补 MinerU 行）；§8 错误表（补齐 6 个内部码，统一 `process_failed`）；§9 跨平台（代理、查找顺序）；§11 未决问题 4 | 🟡 **部分改（2026-11-12）**：§6.1 / §6.1.1 / §6.5 已按 [`capability-cli-blocks.md`](./capability-cli-blocks.md) 修订（sidecar 统一到 v3、交付形态改成族积木）；§3 / §4 / §5 / §7 / §8 / §9 仍 ⏸️ **未改**：v1 不接 OCR 能力（§1 已声明），等接线时一起改 |
| `model-assets.md` | §5 **接入点 2/3 改为独立命令组 `zcode asset`**（平级于 `zcode ocr`，不进 `zcode ocr` 底下；`--offline` 将来注册到 `zcode` 全局旗标）；§11 **状态所有者**；§12 命令面；§14 开放问题 7（已结）+ 清掉 `server` 命令组与悬空的"§5 例外条款"引用 | ⏸️ **未改**：`asset` 命令组整体延期（§7.3 的 7 条待决），改它要等那些决策落地 |
| `capability-registry.md` | §3 `CapabilityPorts` 加 `localInfra`；§5 状态所有者（产物落盘归 adapter）；§7 **错误映射表补齐 6 个内部码**；投影 C 的超时预算加 MinerU 豁免（`:328` 的"单页 120s / 整批 30min"不能套用） | ⏸️ **未改**：`capabilities` 包与 `cap` 分派都不存在（§1.1 核查），v1 不接线 |
| `commands.md` | §53 的"唯一进程级入口"**例外作废**（`zcode ocr` 是子命令组，同一进程入口）；命令清单补 `ocr`；`parse` 的旗标统一为 `--path` / `--output` / `--tier` / `--json` | ✅ **已改**（2026-11-11：例外作废 + 补 `ocr` 行）；⚠️ **2026-11-12 补**：`inspect` 子命令、`--force`、`--pdf-password`、统一信封与进度通道（`commands.md` 的 `zcode ocr` 条目已补） |
| `knowledge-rag.md` | §12 命令面表（**已改**） | ✅ 已改 |
| `model/http-proxy.md` | ⚠️ **登记 §7.9 的"下载子进程剥离代理"例外**（否则与本 spec 的 `:9` 口径矛盾） | ✅ **已登记**（2026-11-08 同步时写入）；2026-11-09 补正两处表述：这条是 **SOCKS 专属**故障（HTTP 代理不触发），且**不写死"应该用哪个模型源"** |
| `architecture-policy.yaml` | ⚠️ **列入同步清单**：新增 `.ts` 要 adopt 或逐文件例外（R6） | ✅ **已登记** `local-infra-unmanaged-files` 例外（16 个新文件，2026-11-09） |

⚠️ **AGENTS.md 纪律**：新增或修改行为前先更新对应 spec。本 spec 落定后，**先改上面这几份，再写代码**。

---

## 11. 参考事实

### 11.0 ⭐ 实测事实（本机 macOS arm64 / Apple M2 Pro / 16GB，2026-11-08）

⚠️ **本节每条结论都标注了样本来源。** 没有样本支撑的一律标 `未实测` 并挪进 §11.1（文档核出）—— 上一版把"一个样本"推成了"一般结论"，这是本次审查最大的问题。

**样本定义**

| id | 样本 | 档位 | 备注 |
| --- | --- | --- | --- |
| **S1** | 1 页中文纯文本 PDF（`cupsfilter` 生成，无表格/图片/公式） | standard（不传 `--tier`，走 `default_request_tier`） | `parse_mode = "ocr"` |
| **S2** | 同 S1 | basic | `parse_mode = "ocr"` |
| **S3** | 1 页含标题/正文/表格/图片/公式的 PDF（PyMuPDF 生成） | standard / flash / advanced 三档各跑一次 | `parse_mode = "txt"` |
| **S4** | 12 页含表格/图片的 PDF（PyMuPDF 生成） | standard | `parse_mode = "txt"` |

| 事实 | 实测值 | **样本** | 对设计的影响 |
| --- | --- | --- | --- |
| 安装 | `uv tool install --python 3.12 "mineru>=4.0,<5"` → 装出两个 bin：`mineru` + `mineru-kit`（`~/.local/bin/`）；`mineru version --json` → `{"mineru_version":"4.1.7","python_version":"3.12.10"}` | S1 | 用户自装（D6） |
| **两个命令面不重叠** | `mineru-kit`：parse / webui / api-server / file-parse-server / vlm-server / router / models / hardware / version；`mineru`：parse / read / scan / watch / search / find / usage / list / show / telemetry / server / config / invalidate / forget / cleanup / version | S1 | **M2**：一个配置键装不下两个 |
| **只有 `mineru-kit parse --format zip` 给三件套** | `mineru parse --format` **存在**，但**只有 `markdown` 一个取值**；`mineru-kit parse --format` = `{markdown, middle_json, zip}` | S1 + `--help` | **M9** |
| **无状态路线不需要 server** | ✅ `mineru-kit parse` 在子进程内完成推理（llama.cpp + Apple MPS） | S1/S3/S4 | **D9 的基础** |
| **档位枚举** | `hardware detect --json` → `pdf_image_tiers: ["flash","basic","standard","advanced"]`、`ceiling: "advanced"`、`default_request_tier: "standard"`、`device: "mps"`、`small_backend: "torch"`、`vlm_engine: "llama-cpp"`、`reason: "torch_accelerator"`、`calibration: {status:"skipped", reason:"torch_backend"}`、`cpu_count: 10` | 本机 | **M10 / M11**；⚠️ `ceiling` 是**分级规则**不是能力上限（§5.1） |
| ⚠️ **`pdf_image_tiers` 是「图片型 PDF 管线」的档位表** | 文本管线走 `parse_mode: "txt"`、图片/扫描件走 `"ocr"`，**两条管线的档位集可能不同** | S1（ocr）/ S3（txt） | ⚠️ 别把它当"本机通用档位表" |
| **档位集合随输入类型变** | `flash` 是 **Office/HTML/MHTML/CSV/EPUB/OFD 的唯一可用档位**；basic/standard/advanced 只吃 PDF + 图片 | `--help` | §5.1 |
| **不传 `--tier` 也能跑** | ✅ 按 `default_request_tier` 走 | S1/S3 | ZCode 默认不传 |
| ⚠️ **`--pages` 只对 PDF 有效** | 图片 + `--pages all` → `错误: Page range is only supported for PDF files; 'png' uses full-document parsing.`，退出非 0；图片**不传** `--pages` → 正常 | S1（PDF 正常）+ 图片样本报错 | **M12** |
| ⚠️ **`--output` 的真实语义** | 已存在目录 → 产出 `<dir>/<stem>.zip`（**不报错**）；不存在且无后缀 → **创建目录**并产出其中；带 `.zip` 后缀 → 产出该文件 | S1/S3/S4 三次复现 | **M13**；⚠️ `[Errno 21] Is a directory` 是 **Doclib `mineru parse`** 的行为，不是 mineru-kit 的 |
| **输出格式** | `--format {markdown, middle_json, zip}`；zip 内含 `markdown.md` / `middle_json.json` / `structured_content.json`（**扁平无目录前缀**） | S1/S3/S4 | **M9** |
| ⚠️ **产物集合随文档内容变化** | S1 = **3 个条目**；S3 = **5 个**（3 + `images/` 下 2 张）；S4 = **27 个**（3 + 24 张） | S1/S3/S4 | ⇒ **不能假设只有三个文件**；`images/` 必须与 markdown 同级保留 |
| ⚠️ **`markdown.md` 里没有页锚点** | `<!--` 出现次数：S1 zip / S3 zip / S4 zip / S4 直接导出 `.md` —— **全是 0** | S1/S3/S4 | ⚠️ 上一版把 **Doclib `mineru parse`** 的特征误归给 mineru-kit（Doclib 的 markdown **确实**带 `<!-- page N of M -->`）。⇒ **页面引用的唯一来源是 `page_idx`（0-based）** |
| **块类型（开放集合）** | 实测出现：`text` / `paragraph_title`（多 `level` 键）/ `table` / `image` / `chart`（多 `sub_type` 键）。⚠️ **类型名随档位变**：同一张图在 standard/flash 是 `image`，advanced 是 `chart` | S3 三档 | ⇒ **`type` 不能是封闭枚举**；sidecar v2 的块 schema 要允许额外字段 |
| **块载荷字段随类型变** | `text`/`paragraph_title` = `{type,bbox,content}`(+level)；`table`/`image`/`chart` 多 `captions`/`footnotes`/`image_source`(+sub_type)；⚠️ **图片块的 `content` 是空串** | S3 | ⇒ 不能只建 `{type,bbox,content}` |
| **bbox = 归一化 0~1 的四点（xyxy）** | 用 `extensions.docvortex_layout.pages[].width_pt/height_pt`（S3 = 595×842 pt）反算，与已知几何真值误差 <0.002 | S3 | ⚠️ **分母必须记进 sidecar v2**（tesseract 变体记 `pixelWidth/pixelHeight/dpi`，要对齐） |
| ⚠️ **bbox 精度随档位不同** | 同一张图：standard 顶边高 0.038 页高、右边宽 0.116 页宽；flash 误差 <0.001 | S3 | ⇒ **不要假设 bbox 一定准** |
| **`structured_content.json` 顶层** | `{pages:[{page_idx, blocks}], metadata, extensions, is_full_document}`；`page_idx` **0-based** | S1/S3/S4 | — |
| ⚠️ **权威档位在产物里** | `extensions.mineru = {"tier": "standard", "parse_mode": "txt"}` —— ⚠️ **`tier` 是权威值**（ZCode 传的 `--tier` 可能被内部改写）；`parse_mode` ∈ `txt` / `ocr` | S1（ocr）/ S3（txt） | **§5.1：tier 从产物回填** |
| ⚠️ **MinerU 的 stdout 是人读文本** | 成功时 stdout = `已解析 1 个输入。`；进度条 / `mineru.model.*` / torch warning **全在 stderr** | S1/S3/S4 | **M4**：不得把 mineru-kit 的 stdout 当 JSON |
| **`hardware detect --json` 的 stdout 是干净 JSON** | 日志在 stderr；耗时 **1.68s**（只 lazy-import torch，不加载 VLM） | 本机 | doctor 不会像冷启动那样慢 |
| **性能：边际成本** | standard：1 页 1.479s / 1.524s；**12 页 4.933s / 4.484s** ⇒ **边际 ≈ 0.314 s/页**，固定开销 ≈ 1.2s。flash 1 页 **0.434s**；**advanced 1 页 10.179s**（Two Step Extraction 9.22s） | S1/S3/S4 | ⇒ **超时额度按 5/15/60 s/页 重标**（§7.8） |
| ⚠️ **"冷启动 123.5s"是首次一次性成本** | VLM predictor 初始化实测只要 **0.66~1.48s**；123.5s 那次是模型刚下载完的**首次**（"page cache 冷"的前提不成立 —— 837MB 刚写盘通常还在 page cache） | S1/S3/S4 | ⇒ 正确表述：**首次可能到分钟级，之后 ≈ 1s 初始化 + 0.3s/页** |
| **中文识别质量** | ✅ S1/S3 的中文正文全部正确。⚠️ **但表格单元格的拉丁文可能被 OCR 拆开**（实测 `tier` → `t i e r`）—— 表格单元格走重 OCR，即使原文是原生文本 PDF | S1/S3 | ⇒ 消费方（知识索引）要做**文本归一化** |
| **`models show` 是人读输出、无 `--json`** | 输出含 `model.source: huggingface`、各仓库 `就绪`/`缺失`、"模型档位:"映射段（**只有 basic / standard 有映射**）、`model.base_dir`（**可配**）；⚠️ **不含 `doclib.auth.token`** | 本机 | §5.4 的判据；⚠️ 模型目录**不要硬编码** |
| ⚠️ **代理环境变量打断 MinerU** | `ALL_PROXY=socks5://127.0.0.1:17890` 时报 `Using SOCKS proxy, but the 'socksio' package is not installed`（**连续踩两次**：模型下载 + 解析）。⚠️ **SOCKS 专属** —— HTTP 代理不触发 | S1 | **§7.9 / R4** |
| ⚠️ **网络结论自相矛盾** | 探针式测法：ModelScope 直连 0.3s 通、HuggingFace 直连 15s 超时。**但完整 HF 下载走通了**（三个仓库共 2.9GB 全部就绪，源 = huggingface）⇒ 那两条**不能**用来建议用户改模型源 | 本机 | §7.9 的处置：**只报事实，不给建议** |
| 模型落盘位置 | `~/.mineru/models/<仓库名>/`（`MinerU-4_models_onnx` 837MB / `MinerU-4_models_torch` 854MB）—— **不是** HF cache；⚠️ 且 `model.base_dir` 可配 | 本机 | 资产层要认这个路径，但**不要硬编码** |
| `mineru-kit models download` 选项 | `--tier {basic,standard}` / `--small-backend {auto,onnx,torch}` / `--vlm-engine {auto,llama-cpp,vllm,lmdeploy,mlx}` / `--source {auto,huggingface,modelscope}` / 位置参数 `repo` | `--help` | ⚠️ **`--tier` 只接受 basic / standard** ⇒ flash / advanced 的模型**没有文档化的下载命令** |
| `mineru config` 整个命令组都要 server | `show` / `get` / `set` 全部报「本地 mineru 服务未运行」 | 本机 | §6.3（二期） |

### 11.0.1 ⭐ 路线选型的结论

⚠️ **措辞更正**：上一版把 D9 / O6 写成"**实测证明** Doclib 给不了结构化块"—— **依据不足**。Doclib 路线**在本机没真正跑通**（`mineru parse` 直接要求先起 server，且默认 `parse_server.local.mode = disabled`、远端 `url` 默认指向 `https://mineru.net/api`）。⇒ 下面的依据应是「**CLI 表面**」，不是「运行结果」。

| 事实 | Doclib 路线 `mineru parse` | 无状态路线 `mineru-kit parse` |
| --- | --- | --- |
| 需要 server | ✅ 必须 | ❌ **不需要** |
| `--output` 收目录 | ❌ 报错（`IsADirectoryError`） | ✅ 静默改写成 `<dir>/<stem>.zip` |
| **CLI 暴露的输出格式** | `--format` **存在**，但**只有 `markdown` 一个取值** | `--format {markdown,middle_json,zip}` |
| **CLI 暴露的结构化产物** | ❌ `mineru read --format` 只有 `{markdown, image}`；`mineru parse --json` 的 `content` 字段是 **`null`** | ✅ `structured_content.json` + `middle_json.json` |
| 页范围默认 | ⚠️ `--help` 文本称默认前 10 页（**1 页样本观察不到该上限**） | ✅ 默认全部（但图片不能传 `--pages`） |
| 索引 / 检索 / 缓存 | ✅ `search` / `find` / `read` / `list` / `show` / `scan` / `watch` | ❌ 没有 |

| ZCode v1 需要什么 | 谁给 |
| --- | --- |
| **结构化块（bbox + 类型）** —— 喂 RAG、写 sidecar v2 | ⚠️ **只有无状态路线的 CLI 暴露**（Doclib 的 CLI 不暴露；其 **server 侧是否落块级结构未验证** —— 它有自己的 `doclib.db` 索引，块级结构对它是自然的） |
| 零 server 复杂度 | ⚠️ **只有无状态路线** |
| 索引 / 检索 / 缓存 | 只有 Doclib —— 但这属于 **knowledge-rag 二期**（§3.3） |

⇒ **结论方向不变**（v1 走无状态路线更划算 —— 它同时满足"结构化产物"和"零 server 复杂度"，而 Doclib 的独有价值在 v1 用不上），但**依据从"实测证明给不了"改为"CLI 表面不暴露"**。

⇒ **用户已确认 D9 修订**（2026-11-08）：v1 走无状态路线。

⚠️ **二期若要 Doclib**：先验证 server 侧返回里有没有块级 bbox（`mineru server start` → `config set parse_server.local.mode managed` → `mineru parse` → 查 `doclib.db` 与 `search`/`read` 的返回）。**在那之前不要断言"Doclib 给不了结构化块"。**

### 11.1 MinerU（当前版 4.1.7，2026-11-04 发布）—— 文档核出

| 事实 | 值 |
| --- | --- |
| 最新版本 | **4.1.7**（4.1.0~4.1.7 是一周内的密集迭代） |
| 许可 | **MinerU Open Source License**（基于 Apache 2.0 + 附加条件）。商用允许（MAU > 1 亿 或 月收入 > 2000 万美元需另购）；对外第三方服务须显著标注；无再分发限制；无 share-alike；输出物许可未涉及。⚠️ **该结论针对 4.1.7 的许可文本**，而安装命令装的是 `>=4.0,<5` 的**浮动版本** ⇒ **许可结论没有 pin 住**，一个 4.2 完全可能改条款。⚠️ 这是全文档唯一"错了会有法律后果"的未验证假设 ⇒ **要么把安装命令 pin 成 `mineru==4.1.7`，要么明确写"`<5` 区间内每次发版需复核许可"** |
| Python | `>=3.11,<3.15`（推荐 3.12） |
| 安装 | `uv tool install --python 3.12 "mineru>=4.0,<5"`；校验 `mineru version --json` |
| 档位 basic | ONNX：约 0.8GB 模型 / 2GB 内存 / CPU 支持；PyTorch：约 0.8GB 模型 / 8GB 内存 / GPU·MPS 推荐。⚠️ **内存数字是文档核出，未实测**（实测那次跑的是 torch+MPS，且无峰值 RSS 记录） |
| 档位 standard | ONNX + llama.cpp：约 2GB 模型 / 8GB 内存 / CPU 可跑（Vulkan 推荐）；PyTorch + llama.cpp：约 2GB / 16GB 内存 / GPU·MPS 必需 / 8GB+ 显存。⚠️ **内存/显存数字是文档核出，未实测** |
| 档位 advanced | 同 standard 的依赖，推理计算更多（最慢）；另有 PyTorch + vLLM/lmdeploy/mlx：约 3GB 模型 / 16GB 内存 / 8GB+ 显存。⚠️ **内存/显存数字是文档核出，未实测**；⚠️ **实测 advanced 1 页就要 10.2s**（Two Step Extraction），量级与其它档完全不同 |
| `full` extra | ≥16GB 内存 + Volta 及以后 NVIDIA GPU 且 8GB 可用显存 + 约 5GB 额外磁盘。⛔ **实测否掉**："Doclib 需要 full + NVIDIA"不成立（无独显的 M2 Pro 照样起得来） |
| `mineru-kit parse` 选项 | `--pages`（`'1-5,8'` / `'r3-r1'` / `'all'`，默认全部）、`--format {markdown,middle_json,zip}`（默认 markdown）、`--tier`、`--remote`、`--remote-url`、`--api-key`、`--ocr-mode {auto,txt,ocr}`、`--disable-image-analysis` |
| `mineru config` 子命令 | `show` / `get` / `set` / `unset` / `exclude-rules` / `parsing-rules` —— **没有 `list`** |
| 4.x vs 2.x | **CLI 完全改过**：2.x 是 `mineru -p x.pdf -o out/ -b pipeline`；4.x 是 `mineru parse x.pdf --output x.md --tier standard`。**不要用 2.x 的资料写实现** |

⚠️ 上表为**文档核出的结论**，实施前需在真实环境复测（§11.0 已复测的部分以实测为准）。

### 11.2 Doclib 事实（**v1 不用，二期再展开**）

见 §6.3 的表格 —— 已按实测整理。

### 11.3 仓库现状

| 事实 | 证据 |
| --- | --- |
| `apps/zcode-cli/packages/capabilities` 包**不存在** | `ls apps/zcode-cli/packages` |
| `zcode` 命令分派表无 `cap` / `asset` | `apps/zcode-cli/packages/cli/src/run.ts` |
| `zcode` 的既有子命令 | `help / version / agent-server / app-server / doctor / login / logout / memo / commands / plugin(s) / skills / providers / usage / recognize / tui` |
| `zcode doctor` = 运行时与打包假设检查 | `run.ts` 的 `runDoctor` |
| bin 名 `zcode` 已被占两次 | `apps/zcode-cli/packages/cli/package.json`、`packages/zcode-server-cli/package.json` |
| **`@zcode/cli` 是 `private: true`** | `packages/cli/package.json` ⇒ 它的 `bin` 不会被物化 |
| **发行链只认一个入口** | `scripts/build-zcode.mjs:160,186,202`；`scripts/zcode-distribution/runner.mjs:14,266`；`installer.mjs:45-49` |
| **SEA / 桌面只 stage 一个 bundle** | `packages/cli/scripts/build-sea.mjs:59,189,295`；`packages/desktop/scripts/stage-agent-bundle.mjs:14,37` |
| `zcode` 的全局 `-p` 已被 `--prompt` 占用 | `packages/cli/src/arguments.ts:30-33`；`parseArgs` 是 `strict: true`（`:177`） |
| `adapters` 依赖 `contracts`、不依赖 `cli` | `packages/adapters/package.json` |
| `adapters` 已有 `yauzl` | `packages/adapters/package.json` ⇒ 解包不新增依赖 |
| `adapters` 的根 barrel 是全量 | `packages/adapters/src/index.ts` ⇒ **必须加 `exports` 子路径** |
| `adapters` 已有加固过的 zip 解包实现（**未 re-export**） | `packages/adapters/src/plugins/zip-source.ts:220-287,401-448` |
| `FileSystemPort` **没有** `mkdtemp` / `writeBinaryFile` / `copyFile` | `packages/contracts/src/interfaces/file-system.port.ts` |
| `PdfDocumentPort.getPageCount` 存在 | `packages/adapters/src/pdf/index.ts:37` |
| `ExecutionPort` 支持 `env` overlay / cwd / stdout-stderr 分离 / abort | `packages/contracts/src/interfaces/execution.port.ts:59-65,141-161,194-195,252` |
| `ExecutionPort` 只有**单个** `timeoutMs`，超时**杀进程组** | `execution.port.ts:157`；`adapters/src/exec/node-execution-adapter-run.ts:234,403-404,256-276` |
| contracts / adapters 的 zod 版本 | contracts `zod ^3.24.0`；adapters `zod 4.6.5` |
| `ZCodeConfigFileSchema` **无 `ocr` 段** | `packages/adapters/src/config/schema.ts:291-309`；`projectConfigFileSchema` 在 `:315-317` |
| `adapters` 的测试是 `vitest tests`（自动发现） | `packages/adapters/package.json` |
| `cli` 的测试是 `node --test` + **显式清单** | `packages/cli/package.json` 的 `scripts.test` |
| 架构登记驱动键 | `scripts/architecture/policy.mjs:73-74`（`newFilesRequireManagedModule` / `newFileScopes`）；`violations.mjs:89-113`；`adopt.mjs:24,78`（生成 4 件套、layer 默认 adapters）；`architecture-policy.yaml:67-69`（zcode-cli `managed: false`） |
| 工作区基线新鲜（`libo`，与 `origin/libo` 同步） | `node scripts/check-workspace-freshness.mjs` |

---

## 12. 修订记录

| 版本 | 日期 | 变更 |
| --- | --- | --- |
| v2 | 2026-11-08 | **四路对抗审查后重写（第一轮）。** 修正 5 处事实性错误（`--pages` 只对 PDF；`--output` 收目录的真实语义；`@zcode/cli` 的 `bin` 不会被物化；档位判据自相矛盾；`.pick()` 会抛导致 CLI 启动即死）；补齐 11 个阻断级契约缺口（端口失败通道、DI 注入、超时与 `ExecutionPort` 的匹配、`OcrCapabilityOutput` 双声明、降级对外落点、错误码闭集、`parse` 退出码、旗标名统一、产物字段名、产物落盘 owner、两个命令面的定位）；补 M12~M15 四条决定 |
| **v3** | **2026-11-08** | **第四路（证据充分性）审查后修订。** 这一路自己造了 12 页带表格/图片/公式的样本、三档各跑一遍，**推翻了我"实测事实"表里的 6 条结论**：<br>① **markdown 没有 `<!-- page N of M -->` 页锚点** —— 上一版把 Doclib `mineru parse` 的特征误归给 `mineru-kit`（4 个产物 `<!--` 计数全 0）⇒ 页面引用只能靠 `page_idx`<br>② **块类型是开放集合且随档位变**（`text`/`paragraph_title`/`table`/`image`/**`chart`**；advanced 把图叫 `chart`、standard 叫 `image`）⇒ `type` 不能是封闭枚举<br>③ **产物集合随内容变化**（3 / 5 / 27 个条目）⇒ 漏了 `images/` 会让 markdown 的图片链接全断<br>④ **`ceiling` 是分级规则不是能力上限**（只看 CPU 核数 + 有无加速器，**不查内存/显存**）⇒ 与 §5.1 的内存表自相矛盾<br>⑤ **性能数字差 100~400 倍**（边际 0.314s/页，不是 30~120s/页；"冷启动 123.5s"是首次一次性成本，predictor 初始化实测只要 0.66~1.48s）<br>⑥ **D9/O6 的措辞依据不足**（Doclib 那列根本没跑通）⇒ 从"实测证明给不了"降级为"CLI 表面不暴露"<br>另修：§11.0 全面加**样本列**（S1~S4），无样本支撑的结论一律标"未实测"并挪进 §11.1；补"绝不传 `--remote`/`--remote-url`/`--api-key`"硬规则；补 CA 变量维度；补 Doclib 遥测默认开启；补许可结论未 pin 版本 |

| **v4** | **2026-11-09** | **v1 实现落地后的规格同步。** ① Status 改为"v1 已实现"并补实施状态表；② §7.1 端口契约补 `config` / `pdf` 两个可选依赖、`MINERU_TIERS` / `MineruProxyPolicy` / `downloadModels`；③ §7.3 命令面把 `asset` 组**延期**（列出 7 条阻塞决策：目录地址只有占位 URL、签名校验、落盘位置、`--offline` 语义等），新增 `models download` 子命令（MinerU 只接受 `basic` / `standard`），并记录分发链**选第二个 runner**（不选 argv[0] 路由：两个 bin 的 argv 语义不可混）；④ §7.5 删掉 `langList`（实测 `mineru-kit parse` **没有语言选项**），补 `assetsDir` 与 `stdout` 字段，并把 JSON 样例的 `error.code` 改成**归一后的能力码**（内部码在 `details.engineCode`）；⑤ §7.6 补"两层码各司其职"表，澄清验收 A4 在端口层与命令面的**不同形状**；⑥ §5.5 修正产物分类规则（实测 `structured_content.json` 与 `middle_json.json` **同形**，"顶层有 pages"区分不了 ⇒ 先判 `schema` / `schema_version` / `pdf_info` 再判 structured）；⑦ §8 补回归覆盖现状表（A0 手工、A9 延期）；⑧ §9.2 补 O11（asset 待决）与 O12（Windows 补充实测）；⑨ §10 同步清单补状态列；⑩ `model/http-proxy.md` 补正两处表述（SOCKS 专属、不写死模型源） |

| **v5** | **2026-11-11** | **命令面改名 + CLI 原子化（用户定）。** ① 独立二进制 `zcode-infr-manage` → **`zcode` 的原子子命令组 `zcode ocr`**（D5 / M5 修订）；② 新增「CLI 原子化」小节：命令组按能力域切分、平级不嵌套（`zcode ocr` / `zcode llm` / `zcode asr` / `zcode asset`），**不设"基础设施总管"二进制**；③ §7.3 旗标改为**注册到 `zcode` 全局旗标表**（`--path` / `--output` / `--tier` / `--source`，严格解析器要求），命令组只做组合校验；④ 交付形态从"第二个 bin（改 4 处分发链）"改为"**零分发改动**"，SEA / Electron 桌面**自动具备**该命令；⑤ `asset` 组从 `zcode ocr` 底下移出，成为平级命令组 `zcode asset`；⑥ `commands.md` 的"唯一进程级入口"**例外作废**（同一进程入口）；⑦ 全文 `zcode-infr-manage` → `zcode ocr`、`zcode-infr-manage asset` → `zcode asset`；⑧ §7.10 与 [`capability-provisioning.md`](./capability-provisioning.md) 互相指向（第 1 步的自动供给层） |

| **v6** | **2026-11-11** | **档位状态的判据补全（修第 2 步的前置依赖）。** ① §5.4 补「档位状态（`TierModelStatus.status`）怎么从引擎输出推出来」表：`ready` = 全部必需仓库就绪；`missing` = 引擎**明确报出**至少一个必需仓库缺失（**全新机器**就是这个状态）；`unknown` = 无仓库映射（flash / advanced）或引擎输出里查不到必需仓库的状态；② 同处补「下载命令只在 `missing` 时给、且只对 `basic` / `standard` 给（给的是 ZCode 自己的 `zcode ocr models download --tier <t>`，不是引擎原始命令）」；③ §7.4 契约注释同步；④ 实施层修 `adapters/src/local-infra/models-status.ts` 的 `toTierModelStatuses`：原先「没有任何仓库就绪 ⇒ unknown」会把**全新机器**判成 unknown ⇒ 能力供给层的自动备资产**永远不触发**（见 [`capability-provisioning.md`](./capability-provisioning.md) A15） |

| **v7** | **2026-11-12** | **积木模型落地后的口径同步（[`capability-cli-blocks.md`](./capability-cli-blocks.md) §9 的同步项）。** ① M8 的子命令数从三个改成**四个**（补 `inspect`）；② §5.4 的健康反馈载体改成**统一信封**（`{ version, key, ok, output?, error?, metrics? }`），顶层不再有 `engine` / `tier` / `degradedFrom` / `warnings`；③ §7.3 命令面补 `zcode ocr inspect` 与 `--force` / `--pdf-password`，并说明六个旗标里 `--force` / `--pdf-password` **本来就在全局表**（不是本组新增）；④ §7.5 的 `parse --json` 样例整体改成统一信封 + 相对产物引用（`artifactsDir` 相对 sidecar 目录、`artifacts.*` 相对 `artifactsDir`）；⑤ §10 同步清单补 `commands.md` 的 2026-11-12 增量与 `ocr-local.md` 的部分改状态 |

⚠️ **审查发现的问题分布**：契约一致性 11 阻断 + 12 高 + 6 低；架构合规 3 P0 + 12 P1 + 3 P2；实现可行性 5 P0 + 13 P1 + 7 P2；证据充分性 7 P0 + 9 P1 + 9 P2。

⚠️ **四路共同指出的元问题**：上一版把"**一个样本**"推成了"**一般结论**"—— §11.0 的"实测事实"表里混着只有一个样本支撑的断言。⇒ 本版给每条实测结论标注样本（S1~S4），没有样本的一律标"未实测"并降级到 §11.1。**这是本轮审查最有价值的产出。**
