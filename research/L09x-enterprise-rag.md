# L09x 调研报告 · 企业知识库 RAG：解析、权限与版本

> 调研日期：2026-10-12　·　目标读者：本课程的出题人/讲稿作者（不是学员）
> 课程框架：L09x = 深度选修（120–150 分钟），只讲「企业文档」相对「代码库」多出来的问题。不重做 L09。
> 本报告写给：L09x 的 `content.mdx`、`labs/shared/kb.{ts,py}`、`labs/l09x/{kb,verify}.{ts,py}` 的作者。
>
> **证据标记**：
> `[P]` 一手直述：规范 / 官方文档 / 源码 / 论文 / 官方 changelog，本轮已读原文，引文逐字
> `[P2]` 一手但需推断：原文没有直接这么说，结论是我从一手原文推出来的（推断过程写明）
> `[S]` 二手/社区/记忆，**未复核**，只当线索，不支撑任何数字或结论；全部汇总在 §14
> `[L]` 本地仓库事实（读过代码/文档）
> `[O]` 本报告自产证据：我在本机 `/tmp/l09x/` 跑过的模拟，代码与输出在 §11
>
> 写作状态：**已完成**（2026-10-12）。未完成或缺一手来源的部分统一列在 §14。

---

## 0. 一句话结论

**企业知识库 RAG 比代码库 RAG 多出来的东西，几乎全是「不报错的失败」**：解析器丢了脚注和页码、表格切断后数字没了列名、L09 的 tokenizer 把全角数字整个丢掉、ACL 写成 WHERE 后召回塌到 0 条、rerank 在过滤前把越权全文发给了第三方、框架默认不删已删除的文档、按 mtime 取「最新版」取到了未生效的新办法——这些情况下**没有异常、没有告警，安全审计还是全绿**。所以这节课的主线不是「怎么做」，而是「**怎么让每一种静默失败变得可观测、可断言**」：过滤放在哪一层（ANN 内 / rerank 前）、权限有几份副本（索引、缓存、trace、外部 API）、删除和版本靠显式事件而不是「这次没看到」、评测按身份和时点分层。本报告给出 38 条反转（INV），其中 pgvector 真机实测与 6 个双语言逐字节一致的模拟是 `[O]` 自产证据，其余每条都有一手原文。

---

## 1. 反转清单（INV-1 … INV-38）

> 格式：**直觉** → **实际**。证据（逐字片段 + 标记 + 详见章节）。完整引文与 URL 在对应章节。★ = 对做过代码库 RAG 的人最意外。

**解析**
- **INV-1** 解析器编辑距离越低，RAG 越好 → OHRBench："standard OCR metrics like edit distance do not always align with RAG performance"；严重语义噪声下 "nearly a $50\%$ performance decline"，BM25 与 BGE-M3 都掉 `[P]` §2.2
- **INV-2** 看榜选解析器 → 每个榜单都有主场：同为 pipeline，Marker 自报 olmocr-bench 76.0 高于 MinerU 72.7；OmniDocBench（MinerU 团队维护）v1.6 上 Marker 78.44 低于 MinerU-Pipeline 86.47 `[P]` §2.1
- **INV-3** 通用大模型（GPT/Gemini）解析最好 → OmniDocBench v1.6：GPT-5.2 86.59、Gemini 3 Pro 92.91，低于专用的 PaddleOCR-VL-1.6 96.34 `[P]` §2.1
- **INV-4** ★ 用 ColPali 直接检索页面图像，跳过解析最省事 → 每页 257.5 KB（比 BM25 高一个数量级、比 BGE-M3 高两个）、只到页级引用、没有 BM25 通道、ACL 只能到页 `[P]`+`[P2]` §2.3
- **INV-5** ★ 页码就是页码 → MinerU `page_idx` 从 0 起、CLI 从 1 起；印刷页码随页眉页脚一起被删 `[P]` §2.4 §6.1
- **INV-6** 解析器保留全部内容 → PP-StructureV3 Markdown 默认忽略脚注；Marker 默认删页眉页脚；跨页表格合并要 `--use_llm` `[P]` §2.4 §3.2
- **INV-7** 升级解析器只影响新文档 → MinerU "Old caches are not rewritten; reparse"；RAGFlow "must be re-parsed rather than re-chunked" `[P]` §5.3 §6.1

**分块与切词**
- **INV-8** 表格按普通文本切 → Unstructured `TableChunk` 不重复表头、`max_characters` 默认 500；EXP-B 里 top1 是**表头块**，既无「研发部」也无「1200」 `[P]`+`[O]` §3.1 §11.2
- **INV-9** 按行切 + 带列名就够了 → RAGFlow `names := rows[0]`，多级表头只留第一级；PDF 表格行 chunk "get no positions at all" `[P]` §3.1 §6.1
- **INV-10** ★ L09 的中文 tokenizer 可直接用于公文 → 全角数字被整个丢弃，「第3条 差旅」把**第５条排在第３条前面**；「（２）」切出空列表 `[L]`+`[O]` §11.2
- **INV-11** ★ TS 和 Python 正则/字符串行为一样 → Python `\d` 匹配「１」、`\w` 匹配「中」，JS 不；JS `\s`/`trim()` 吃 BOM、Python 不；JS `<` 是 UTF-16 码元序，扩展 B 区汉字排序与 Python 相反 `[O]` §3.3 §11.3
- **INV-12** 中文编号就是 1. 2. 3. → GB/T 9704 四级「一、（一）1.（1）」；立法法「款」不编号；科技部文件用全角「１、２、」 `[P]`/`[P2]` §3.3
- **INV-13** 搜索引擎默认分词能处理中文 → ES standard tokenizer 按 UAX#29 把汉字切成单字；`cjk_bigram` 默认 `output_unigrams: false`；Qdrant 默认 `word` `[P]` §3.4

**权限**
- **INV-14** ★ ACL 写成 WHERE 就既安全又正确 → 安全，但**召回塌缩且零告警**：pgvector 真机 10% 选择率平均返回 3.8 条、1–2% 时 0.5–0.6 条、最少 0 条 `[O]` §11.1；README："There may be even less results due to dead tuples or filtering conditions" `[P]` §4.1
- **INV-15** 选择率越低越危险 → 危险区在中间：0.1% 时规划器改走顺序扫描反而全对 `[O]` §11.1
- **INV-16** 给过滤列加索引就好 → 加 B-tree/GIN 后 1%/2%/10% 仍选 HNSW（行数估计准确也没用）`[O]` §11.1
- **INV-17** ★ ES/OpenSearch 的 bool filter 就是预过滤 → 只有 `knn.filter`（knn 子句内）是预过滤，外层 filter 是后过滤、可能少于 k。Onyx 把 ACL 放进 knn 子句内 `[P]` §4.1 §7.1
- **INV-18** Qdrant 有 filterable HNSW，随时加过滤都行 → payload 索引须在入库前建，否则要重建 HNSW；多个严格过滤组合或大量软删点 "might still lead to disconnected graph components" `[P]` §4.1
- **INV-19** ★ rerank 在 ACL 前后无所谓，结果一样 → 结果确实一样（EXP-A），但 2% 选择率下 20 个查询把 788 段越权全文发给了外部 reranker；Cohere API："`documents` … A list of texts" `[P]`+`[O]` §4.4
- **INV-20** 把权限规则写进 prompt 让模型把关 → OrgAccess："even GPT-4.1 only achieves an F1-Score of 0.27 on our hardest benchmark"；"fundamentally probabilistic" `[P]` §4.9
- **INV-21** ★ 检索按提问者权限 → 多人会话按**所有在场者的交集**："only those documents for which every active participant has access will be retrieved" `[P]` §4.9
- **INV-22** 返回时隐藏字段 = 字段级安全 → Azure："isn't a content-obfuscation or field-level security mechanism"；vec2text 从向量还原 92% 的 32-token 文本；无权字段参与 BM25 = 存在性泄露 `[P]`+`[P2]` §4.3
- **INV-23** 「尊重源系统权限」= 实时 → Onyx 默认权限同步 5 分钟，Confluence/Jira 30 分钟；改名用户的旧地址 "keep naming the old one until the source system re-syncs" `[P]` §4.6
- **INV-24** ★ 加 tenant_id 过滤 = 租户隔离 → 统计量不隔离：EXP-D 加 10 篇别的租户文档，租户 A 排序翻转；pgvector："vectors from one tenant can affect recall (and speed) for other tenants" `[O]`+`[P]` §4.7 §11.2
- **INV-25** trace 里记检索内容方便排查 → OTel：`gen_ai.retrieval.documents` 为 Opt-In、文档只记 `id`/`score`；开了内容捕获的 trace 后端 = 无 ACL 的知识库副本 `[P]`+`[P2]` §4.8
- **INV-26** 语义缓存按 query 命中 → RedisVL `filter_expression` "Defaults to None and the full cache will be searched"；key 必须含权限指纹 + 语料版本 `[P]`+`[P2]` §4.6
- **INV-27** 尊重源权限就安全 → Copilot "only surfaces organizational data to which individual users have at least view permissions"——源系统的过度共享被一句话检索放大 `[P]`+`[P2]` §4.9
- **INV-28** 按 doc id 取文档不用再查权限 → Onyx："No need for ACL here because the doc ids were validated beforehand"；doc id 一旦来自模型工具参数（L14 的 destination）就绕过了 ACL `[P]`+`[P2]` §7.1

**版本与删除**
- **INV-29** ★ 框架会自动删除源系统已删的文档 → LangChain `cleanup` 默认 `None`、LlamaIndex 默认 `UPSERTS`，都不删 `[P]` §5.1
- **INV-30** ★ incremental 模式会清理删除 → 只清理「本次见过的 source id」，整篇删除永远残留；full 模式在 loader 部分失败时误删（EXP-F）；需要显式墓碑 `[P]`+`[O]` §5.1 §11.2
- **INV-31** 删了就没了 → ES："those deleted documents are taken into account for index statistics"；pgvector dead tuples 让结果变少；Qdrant 软删点断开图 `[P]` §5.2
- **INV-32** 改权限只是改元数据，很便宜 → LangChain 的文档 hash = 内容 hash + `json.dumps(metadata, sort_keys=True)` hash，ACL 一变就重新 embedding `[P]` §5.1
- **INV-33** ★ 新版本优先 → 至少三个维度：上位 > 下位、特别 > 一般、新 > 旧；立法法第一百零五条：新的一般与旧的特别冲突时"不能确定如何适用"，交人裁决。EXP-E 中按 mtime 错 2/6、按生效日错 2/6 `[P]`+`[O]` §5.4
- **INV-34** 模型看到新旧两版会自己挑对 → ClashEval：模型 "adopting incorrect retrieved content … over 60% of the time"，且越像真的越容易采纳——只差一个数字的旧版正是最像真的 `[P]`+`[P2]` §5.4
- **INV-35** 换 embedding 模型可以后台慢慢补 → 不同代向量不可比；Dify："Changing the embedding model will re-embed all documents … original embeddings will be deleted" `[P]` §5.3

**评测与门禁**
- **INV-36** 随机抽样评测集 → 几乎全抽到全员可见文档，权限失败模式不在集合里；越权率是硬门禁，0/500 只能说上界约 0.6% `[P2]` §6.2
- **INV-37** 检索为空就放宽阈值重试 → RAGFlow 空结果时放宽到 similarity 0.17 或返回过滤后全部 chunk；企业里「空」可能就是「无权」 `[P]`+`[P2]` §7.1
- **INV-38** 缺 ACL 元数据的 chunk 留着无妨 → RAGFlow `PruneDeletedChunks` 对缺 `doc_id` 的 chunk "Keep chunks without doc_id"（fail-open）；权限语义下必须 fail-closed `[P]`+`[P2]` §7.1

---

## 2. 文档解析：企业 RAG 的第一道静默失效

> 代码库 RAG 没有「解析」这一步：`.ts` 文件读出来就是文本，行号天然存在。企业文档的第一步是把 PDF/扫描件/Word/Excel 变成**带结构、带坐标**的文本，而这一步的错误**不抛异常**——它产出一份看起来完整的 Markdown，只是里面有一列错位的表格、一段被页眉打断的句子、或者一整页乱码。

### 2.1 公开基准：OmniDocBench 的一手数字（以及它不能告诉你的东西）

URL：https://github.com/opendatalab/OmniDocBench （README，访问 2026-10-12）

基准本身：
> "This benchmark includes 1651 PDF pages, covering 10 document types, 5 layout types, and 5 language types." `[P]`

> "[2025/09/25] **Major update**: Updated from **v1.0** to **v1.5** … The **Overall** metric is now calculated as ((1 - text Edit distance) * 100 + table TEDS + formula CDM) / 3" `[P]`

> "[2026/04/10] **Major update**: Updated from **v1.5** to **v1.6** … Added **296 new pages**, samples are chosen to cover the **more challenging scenario categories** in document parsing, including complex nested tables, dense mathematical formula layouts, and unconventional layout structures" `[P]`

> "[2026/04/30] Updated from **v1.6** to **v1.7**, added the Qianfan-OCR leaderboard, and supported skills-based evaluation." `[P]`（注意：主表 caption 仍写 "v1.6_full"）

**v1.6_full 主表节选**（README 当前版本，`[P]`，我用脚本从 HTML 表抽出，未改数字）：

| 方法 | 类型 | 参数量 | Overall↑ | TextEdit↓ | TableTEDS↑ |
|---|---|---|---|---|---|
| TeleOCR | Specialized VLM | 1.2B | 96.91 | 0.0267 | 96.82 |
| PaddleOCR-VL-1.6 | Specialized VLM | 0.9B | 96.34 | 0.0326 | 94.76 |
| MinerU2.5-Pro | Specialized VLM | 1.2B | 95.75 | 0.036 | 93.42 |
| Gemini 3 Pro | General VLM | - | 92.91 | 0.064 | 89.15 |
| DeepSeek-OCR 2 | Specialized VLM | 3B | 90.25 | 0.050 | 83.89 |
| GPT-5.2 | General VLM | - | 86.59 | 0.114 | 82.95 |
| MinerU-Pipeline | Pipeline | - | 86.47 | 0.055 | 81.88 |
| Marker | Pipeline | - | 78.44 | 0.157 | 65.77 |

（同表另有 GLM-OCR 95.22、dots.ocr 90.77、Qwen3-VL-235B 89.78、Mistral OCR 85.66；FormulaCDM 与 ReadOrderEdit 列略去。）

**v1.5 主表里 PP-StructureV3 的数字**（`v1_5` 分支 README，`[P]`）：PP-StructureV3 Overall 86.73 / TextEdit 0.073 / TableTEDS 81.68；Marker-1.8.2 Overall 71.30 / TableTEDS 57.88；GPT-4o Overall 75.02 / TableTEDS 67.07。

**v1.0 表（中英分列）**（`v1_0` 分支 README，`[P]`）——这是唯一还把 EN/ZH 分开报的版本，对国内场景最有信息量：

| 方法（版本） | TextEdit EN↓ | TextEdit ZH↓ | TableTEDS EN↑ | TableTEDS ZH↑ | ReadOrder EN↓ | ReadOrder ZH↓ |
|---|---|---|---|---|---|---|
| PaddleOCR PP-StructureV3 | 0.058 | 0.088 | 77.2 | 83.9 | 0.069 | 0.091 |
| MinerU-pipeline-2.1.1 | 0.072 | 0.111 | 77.4 | 79.5 | 0.097 | 0.136 |
| Mathpix | 0.105 | 0.381 | 77.0 | 67.1 | 0.108 | 0.304 |
| Marker-1.7.1 | 0.085 | 0.293 | 67.6 | 54.0 | 0.116 | 0.329 |
| **Docling-2.14.0** | 0.416 | **0.987** | 61.3 | **25.0** | 0.313 | 0.837 |
| **Unstructured-0.17.2** | 0.198 | 0.481 | **0** | **0.064** | 0.145 | 0.387 |
| GPT4o | 0.144 | 0.409 | 72.0 | 62.9 | 0.128 | 0.251 |
| Gemini2.5-Pro | 0.055 | 0.168 | 85.8 | 86.4 | 0.049 | 0.121 |

读法（`[P2]`，我的推断）：
1. **「西方通用解析器」在中文页上的退化是数量级的**，不是百分点的：Docling 2.14 的中文 TextEdit 0.987（几乎全错），Unstructured 0.17 的表格 TEDS ≈ 0（即没产出表格结构）。这些是 2025-01/03 时的版本，之后可能改善，**本轮没有找到 Docling/Unstructured 在 v1.5/v1.6 上的一手数字**——讲稿只能说「当时的版本」，不能说「现在仍然如此」。
2. 国产管线（PP-StructureV3、MinerU）在中文表格上反而**高于**英文表格（83.9 vs 77.2）。选型时「看英文榜单」会系统性地误判。
3. 通用大模型（GPT-5.2：Overall 86.59）在 v1.6 上**低于** 0.9B 的专用 VLM（PaddleOCR-VL-1.6：96.34）。「直接扔给最强的通用 VLM 解析」不是上限。

**OmniDocBench 不能告诉你的东西**（`[P2]`）：
- 它是**页级**基准，不测跨页表格合并、不测页眉页脚在跨页处是否打断句子（它测 reading order，但只在页内）。
- 它测的是**解析**质量，不是**检索/问答**质量——见 2.2，这两者不单调对应。
- 它的维护方 OpenDataLab 同时是 MinerU 的开发方（README 的 MinerU 链接都指向 `opendatalab/MinerU`）。这不说明数字有偏，但说明**每个榜单都有主场**：见下一条。

#### 「每个榜单都有主场」：Marker 自报的 olmocr-bench

URL：https://github.com/datalab-to/marker （README `# Benchmarks`，访问 2026-10-12）

> "We measure conversion quality with olmocr-bench: 1,403 PDFs with ~8,400 pass/fail unit tests covering math rendering, table structure, reading order, headers/footers, and old scans." `[P]`

> "Marker (this repo) beats **both** MinerU and docling on score *and* throughput at once" `[P]`

| System | Overall | Digital-only | Throughput |
|---|---|---|---|
| Marker — balanced (GPU) | 76.0 | 83.5 | 2.9 pg/s |
| MinerU — pipeline (GPU) | 72.7 | 83.3 | 0.54 pg/s |
| docling (GPU) | 50.3 | 64.0 | 2.1 pg/s |

（同一 README，`[P]`）

同一对工具（Marker vs MinerU-pipeline），**OmniDocBench（MinerU 团队维护）上 MinerU 领先 8 分，olmocr-bench（AllenAI 维护，Marker 团队自跑）上 Marker 领先 3.3 分**。`[P]` 两组数字都是一手的，结论是 `[P2]`：**解析器选型不能看任何一个公开榜单，必须用你自己的 50–100 页代表性文档跑一遍**——这正是 §6 「入库质量门禁」要求的那份黄金集。

Marker 的许可也值得讲（`[P]`）："Our code is licensed under **Apache 2.0** … Our model weights use a modified AI Pubs Open Rail-M license (free for research, personal use, and startups under $5M funding/revenue)." MinerU 4.0 README："licensed under the MinerU Open Source License, based on Apache 2.0 with additional conditions." → 企业选型时**许可证是硬门槛**，和精度同级。

### 2.2 解析分数 ≠ RAG 分数：OHRBench

URL：https://arxiv.org/abs/2412.02592 （*OCR Hinders RAG: Evaluating the Cascading Impact of OCR on Retrieval-Augmented Generation*，访问 2026-10-12）

> "OHRBench includes 8,561 carefully selected unstructured document images from seven real-world RAG application domains, along with 8,498 Q&A pairs derived from multimodal elements in documents" `[P]`

> "We reveal that even the best OCR solutions exhibit a performance gap of 14% at least, compared to the ground truth structured data" `[P]`

> "standard OCR metrics like edit distance do not always align with RAG performance. For example, while MinerU and Qwen2.5-VL-72B exhibit lower edit distances compared to Marker, they do not consistently achieve better performance across all metrics." `[P]`

> "increasing Semantic Noise from mild ($r_{\text{noise}}=0$) to severe ($r_{\text{noise}}>0.6$) results in nearly a $50\%$ performance decline for most retrievers and LLMs. In the retrieval stage, both the sparse retriever BM25 and the dense retriever BGE-M3 suffer consistent performance declines across all types of questions, suggesting that dense retrieval's stronger comprehension does not provide robustness against Semantic Noise." `[P]`

> "Reading order is challenging for VLMs and End-to-end OCR. Despite their strong semantic understanding capabilities offered by language decoders, both VLM and end-to-end OCR struggle with merging paragraphs correctly, reflected in F1-score of just 8.8 in overall evaluation. In contrast, pipeline-based OCR, though lacking semantic understanding, achieves performance close to ground truth (GT) using rule-based strategies." `[P]`

对已学完 L09 的人，最意外的两条：
- **「dense 检索懂语义，所以对 OCR 错字更鲁棒」是错的**——BM25 和 BGE-M3 一起掉。（L09 教了「向量不如以为的那么懂语义」，这里是同一结论在解析噪声上的版本。）
- **VLM 解析在「跨段落合并」上反而不如规则管线**（F1 8.8）。多栏、跨页断段这类阅读顺序问题，「换个更强的模型」不一定解决。

### 2.3 「不解析，直接检索页面图像」：ColPali / ColQwen

URL：https://arxiv.org/abs/2407.01449 （*ColPali: Efficient Document Retrieval with Vision Language Models*，访问 2026-10-12）

> "Since modern retrieval systems mainly rely on the textual information they extract from document pages to index documents -often through lengthy and brittle processes-, they struggle to exploit key visual cues efficiently. … a new concept; doing document retrieval by directly embedding the images of the document pages." `[P]`

> "ViDoRe is designed to comprehensively evaluate retrieval systems on their capacity to match queries to relevant documents at the page level." `[P]`

> "We project each PaliGemma vector to a lower dimensional space ($D=128$) to maximize efficiency, leading to a memory footprint of $257.5$ KB per page" `[P]`

> "ColPali's embedding size is an order of magnitude larger than BM25 and two orders of magnitude larger than BGE-M3." `[P]`

> "We train the recently released Qwen2-VL 2B … obtaining ColQwen2-VL. … We observe clear performance improvements of $+5.3$ nDCG@5 values over ColPali" `[P]`

> "Our training set is fully English by design, enabling us to study zero-shot generalization to non-English languages" `[P]`

对企业 RAG 的含义（`[P2]`）：
1. **粒度是页**。这直接和 §4 冲突：**chunk 级 / 字段级 ACL 在页图像检索里无法表达**——一页上有一行工资数据，整页要么能看要么不能看。也和 §6 冲突：引用最多定位到页（热力图能给区域，但那是可解释性产物，不是可审计的 locator）。
2. **存储贵两个数量级**（257.5 KB/页 vs 单向量），而且 §5 的「embedding 模型升级要重建索引」在这里代价更大。
3. **它没有文本**——BM25 那一路（L09 §三的核心论点）直接消失；精确标识符（合同编号、条款号）查询失去「响亮的失败」。
4. 它适合的位置是**第二路召回**（图表/信息图密集的页），不是替代解析管线。课上要讲的是「什么时候它是对的」而不是「它是未来」。

### 2.4 解析器输出的「坐标契约」：页码从 0 还是从 1

MinerU 4.0（URL：https://opendatalab.github.io/MinerU/reference/output_files/ ，访问 2026-10-12）：
> "Pages contain `page_idx` and `blocks`; `page_idx` is zero-based, unlike one-based CLI PDF ranges." `[P]`

> "Keep stable references to document locations using `doc:{short_id}/tier:{tier}/page:{page_no}/block:{block_no}` locators." `[P]`（README）

> "Original layout keeps body text, captions, code, tables and images independently fitted to their source boxes. `continues_prev` does not move text between original boxes." `[P]`（`continues_prev` = 跨页/跨块延续标记）

> "Old caches are not rewritten; reparse to obtain geometry and image-only Flash display equations." `[P]` ← 解析器升级后旧结果不自动迁移，这和 §5 的「重建索引」是同一类问题。

Marker（README，`[P]`）：
> "`--keep_pageheader_in_output` / `--keep_pagefooter_in_output`: Keep running page headers / footers in the output instead of stripping them (they are removed by default)."
> "For the highest accuracy, pass the `--use_llm` flag to use an LLM alongside marker. This will do things like merge tables across pages"

**推断** `[P2]`：
- 同一个系统里，解析器内部 0-based、CLI 1-based、PDF 阅读器 1-based、而文档印刷页码（「第 iii 页」「第 12 页」）可能和物理页序完全不同。**引用校验（L09 §七）在企业 RAG 里多了一个维度：页码坐标系**。lab 里可以钉一条：`page_idx` 与展示页码必须分开存，引用渲染时只用一个函数换算。
- 「跨页表格合并」在 Marker 里要开 `--use_llm`（即**默认不合并**）。默认路径下一个跨两页的表格是**两个表格**，第二个没有表头。这是 §3「表格不能被切断」的上游原因。

（原计划的 2.5「PP-StructureV3 / Unstructured / LlamaParse / Docling 能力对比」本轮没有完成。已核实的默认值分散在 §2.4、§3.1、§3.2；未核实部分见 §14 第 9、18 条。）

## 3. 分块：表格、标题层级、中文公文编号

> L09 §二的结论是「对代码，结构分块 > 调 embedding」，结构来自 `function/class` 这种**显式语法**。企业文档的结构**半显式**：有时是 Markdown `#`（解析器猜出来的），有时只是「一、」「（一）」这样的编号（藏在正文里），有时只是字体（黑体/楷体——解析后就丢了）。表格则是另一种结构：**行的语义依赖表头，而表头只出现一次**。

### 3.1 表格：三家开源实现，三种默认

| 实现 | 表格怎么切 | 表头怎么办 | 坐标 | 来源 |
|---|---|---|---|---|
| Unstructured `basic`/`by_title` | "A `Table` element is always isolated and never combined with another element. A `Table` can be oversized … and in that case is divided into two or more `TableChunk` elements using **text-splitting**." | 文档未提重复表头 → `[P2]` 按字符切分的后续 `TableChunk` **不带表头** | 合并后的 chunk："page-number and coordinates which cannot always be resolved to a single value" | `[P]` docs.unstructured.io/open-source/core-functionality/chunking |
| Docling `HybridChunker` | 按 token 预算切，表格跨多个 chunk 时 | "**`repeat_table_header`** (default: `True`): When enabled, table headers are repeated at the beginning of each chunk when a table spans multiple chunks." 另有 `omit_header_on_overflow`（默认 False）| 继承 DoclingDocument 的 provenance | `[P]` docling `docs/concepts/chunking.md` |
| RAGFlow `TableChunker`（Go 端口） | "emits one chunk per upstream table row … 'Every row in table will be treated as a chunk.'" | 每行渲染为 `- {field}: {value}`，**列名取 `rows[0]`**；空单元格整行跳过该字段 | "PDF items write layout boxes into the same field, so misaligned or non-spreadsheet payloads get no positions at all." | `[P]` `internal/ingestion/component/chunker/table.go`（commit 489d0b4，2026-10-12） |

Unstructured 的默认尺寸也要讲（`[P]` 同页）："`max_characters: int (default=500)` - the hard maximum size for a chunk."——500 **字符**，对中文约等于 500 token，对英文约 125 token；同一个默认值在两种语言下是 4 倍差异（`[P2]`，按 L09 `defaultEstimate` 的「CJK≈1 token/字、其余≈1 token/4 字符」口径）。

**推断与 lab 钩子** `[P2]`：
1. 「表格不能被切断」的真正含义不是「表格整体放一个 chunk」（大表放不下），而是**任何一个含数据行的 chunk 都必须能独立回答「这一格是哪一列」**。判据可以零模型断言：对每个含表格行的 chunk，检查其文本里是否出现了该表的全部列名（或该行的 `field: value` 对）。
2. RAGFlow 的 `names := rows[0]` 在**多级表头**时只用第一行表头（`headerCount > 1` 时第二级表头被当作「已跳过的表头行」而不是列名的一部分）。中文财报里「2025 年 | 2024 年」下挂「金额 | 占比」的两级表头非常常见——按 `rows[0]` 渲染后，「金额」和「占比」两列都叫「2025 年」。lab 的「行 + 表头」渲染函数应把多级表头**按列拼接**（`2025年/金额`）。
3. 「按行切」让每行可独立召回，代价是**行与行之间的关系**（合计行、同比列、「注：」脚注）丢失。合计行尤其危险：它单独成 chunk 时，「合计」那一格的语义只在表头和上方各行的上下文里。lab 实验可以展示：问「华东区 2025 年营收」时，整表 chunk、带表头行 chunk、不带表头行 chunk 三者的 BM25 排名。

### 3.2 解析器默认丢掉的东西：脚注、页码、印章

PP-StructureV3（URL：https://www.paddleocr.ai/latest/en/version3.x/pipeline_usage/PP-StructureV3.html ，访问 2026-10-12）：

> "`markdown_ignore_labels` | Meaning: Layout tags that need to be ignored in Markdown. Description: If not set, the initialized default value will be used, which is `['number','footnote','header','header_image','footer','footer_image','aside_text']` by default." `[P]`

> "`use_seal_recognition` | Meaning: Whether to load and use seal text recognition subpipeline. Description: If not set, the default is `False`." `[P]`

**推断** `[P2]`：**脚注默认不进 Markdown**。企业文档里脚注承载的往往是**限定条件**（「注：以上数据未经审计」「本条款不适用于外包人员」）——丢了它，检索到的正文是「对的」，但答案是**过度泛化**的。印章默认不识别：对公文来说，印章所在区域的文字（发文机关）是判断「这是正式发文还是征求意见稿」的证据，和 §5 的版本判定直接相关。
→ 入库门禁应检查：解析结果里 `footnote` 类块的数量是否为 0（而原文有「注：」字样）。

RAGFlow 的页眉页脚判定（`internal/deepdoc/parser/pdf/layout/toc_header_footer.go`，`[P]`）：

> "headerZoneRatio = 0.10 / footerZoneRatio = 0.90 … minHeaderFooterPages guards against cross-page false positives on short documents. Deterministic page-number patterns still fire on shorter ones. minHeaderFooterPages = 3 … minParityCoverageRatio = 0.40 … running headers are standardly suppressed on chapter opening pages … a running header in a real book often covers only 40%-48% of the even or odd pages."

**推断** `[P2]`：页眉页脚**不是「页面顶部 10% 的文字」**，而是「**在多页的同一区域重复出现**的文字」——这是一个**跨页统计**判定，不能逐页做。所以：(a) 少于 3 页的文档基本不去页眉；(b) 第一页顶部的标题不该被当成页眉删掉；(c) 奇偶页不同页眉（「公司名 / 章节名」交替）需要按奇偶分别统计。这是 lab 里一个很好的纯函数 TODO（`detectRunningLines(pages)`）。

### 3.3 中文公文与法规的编号层级

**GB/T 9704-2012《党政机关公文格式》§7.3.3**（标准原文由多所高校办公室官网转载，例如 https://www.ahua.edu.cn/bgs/2020/0612/c416a9290/page.htm ；国标全文官方渠道为扫描件，本轮未直接读到——标 `[P2]`）：

> "文中结构层次序数依次可以用"一、""（一）""1.""（1）"标注；一般第一层用黑体字、第二层用楷体字、第三层和第四层用仿宋体字标注。"

**《立法法》（2023 修正）第六十五条**（国家税务总局政策法规库全文转载，https://fgk.chinatax.gov.cn/zcfgk/c100009/c5211769/content.html ，`[P]`）：

> "法律根据内容需要，可以分编、章、节、条、款、项、目。编、章、节、条的序号用中文数字依次表述，款不编序号，项的序号用中文数字加括号依次表述，目的序号用阿拉伯数字依次表述。"

**《科学技术部规章制定程序的规定》第十二条**（中国政府网，https://www.gov.cn/zhengce/2003-08/04/content_5711094.htm ，`[P]`）：

> "规章的内容分条文书写，冠以"第几条"字样，每条应当包含一项规则，可以分设款、项、目。款不冠数字，项冠以（一）、（二）、（三）等数字，目冠以１、２、３等数字。"

（注意原文就是**全角数字**「１、２、３」。）

**推断** `[P2]` + **本机实测** `[O]`：
1. **层级藏在编号里，不在 Markdown `#` 里**。解析器能不能把「一、总则」识别为标题，取决于它看不看得见黑体——OCR/文本层提取后字体信息常常丢失。所以企业文档的「结构分块」需要一个**编号识别器**作为 `#` 的补充，否则就是 L09 §二说的「静默降级为固定窗口」。
2. **同一符号在不同体系里层级不同**：公文「（一）」是第 2 层，法规「（一）」是「项」；公文「1.」是第 3 层，技术文档「1.1.2」是三级小节。层级判定要以**文档类型**为参数。
3. **款不编号**：法规的「第三条第二款」要靠**数段落**才能定位。如果解析器把条内的两段合并成一段（OHRBench 说的 reading order / 段落合并问题），「第二款」这个引用就**无法被校验**。
4. **跨语言陷阱（实测）**：同一个字符串 `"（一）总则 １．适用范围 第十二条 1.1.2 小节"`：
   - JS：`s.match(/\d+/g)` → `["1","1","2"]`（`\d` 只认 ASCII，**不匹配全角「１」**）
   - Python：`re.findall(r"\d+", s)` → `['１', '1', '1', '2']`（`str` 模式下 `\d` 是 Unicode 数字，**匹配全角「１」**）；加 `re.ASCII` 后与 JS 一致
   - 两边 `NFKC` 规范化后都得到 `"(一)总则 1.适用范围 第十二条 1.1.2 小节"`——**注意全角括号「（）」也被转成了半角「()」**，之后匹配「（一）」的正则会失效。
   - `/\w/.test("中")` 在 JS 里是 `false`；`re.match(r"\w","中")` 在 Python 里是 `True`。
   → lab 的编号识别必须：先 NFKC，再用**显式字符类**（`[0-9]`、`[一二三四五六七八九十百]`、`[(（]`）匹配，Python 侧正则加 `re.ASCII` 或不用 `\d`/`\w`。
5. **「1.」与 Markdown 有序列表冲突**：「5. 适用范围」可能被渲染器重新编号（`[S]`，未复核 CommonMark 原文，见 §14）。保守做法：编号识别在 Markdown 渲染**之前**、对原始文本行做。

### 3.4 中文 BM25：各家默认分词器

L09 §三已经教了「按空白分词 → 中文一整句变一个 token → BM25 静默返回空」，并在 `tokenize` 里用单字 + 二元组修好了。这里补的是**「你用的那个库默认是哪种」**：

| 系统 | 默认 | 中文效果 | 来源 |
|---|---|---|---|
| Elasticsearch `standard` tokenizer | "grammar based tokenization (based on the Unicode Text Segmentation algorithm, as specified in Unicode Standard Annex #29)" | `[P2]` UAX#29 对汉字按单字切（无二元组），区分度低 | `[P]` elastic.co/docs/reference/text-analysis/analysis-standard-tokenizer |
| Elasticsearch `cjk_bigram` filter | "Forms bigrams out of CJK (Chinese, Japanese, and Korean) tokens." 示例 `東京都は、日本の首都であり` → `[ 東京, 京都, 都は, 日本, 本の, の首, 首都, 都で, であ, あり ]`；`output_unigrams` "Defaults to `false`" | 默认**只有二元组没有单字**——单字查询（如「税」）匹配不到 | `[P]` elastic.co/docs/reference/text-analysis/analysis-cjk-bigram-tokenfilter |
| Qdrant full-text index | "`word` (default) - splits the string into words, separated by spaces, punctuation marks, and special characters." 另有 `multilingual`（"based on multiple packages like charabia and vaporetto … including those with non-Latin alphabets and non-space delimiters"） | 默认 `word` 对中文 = 按标点切，一整句一个 token（`[P2]`） | `[P]` qdrant.tech/documentation/concepts/indexing/ |
| Qdrant BM25 IDF | "IDF statistics are calculated per shard … By default, `N` and `n` are computed across the entire shard." | 多租户下 IDF 被别的租户污染（§4） | `[P]` 同上 |

**推断** `[P2]`：L09 的 `tokenize`（单字 + 二元组）在「单字查询」和「二元组精度」之间折中，而 ES `cjk_bigram` 的默认是**只要二元组**——两者的召回行为不同。lab 不必再教分词本身，但**观察实验应展示「同一 query 在 unigram / bigram / unigram+bigram 三种分词下的 BM25 top-3」**，让学员看到「默认值」本身就是一个选择。另外：**分词器换了 = 索引要重建**，这和 embedding 模型升级是同一类事件（§5）。

（3.5 标题层级分块的具体算法——见 §9 lab TODO-2）

## 4. 权限：下推到检索之前

> 本节回答一个代码库 RAG 从来不用回答的问题：**同一个 query，不同的人该看到不同的 top-k**。L09 的 `bm25Index`/`vectorIndex` 没有「谁在问」这个参数，`rerankHeuristic` 也没有。企业 RAG 里，这个参数一旦漏传或晚传，失败是**静默且不对称**的——要么越权（安全事故），要么召回塌缩（「检索不到相关内容」被当成合法结论，L09 §五刚教过学员这是合法结论）。

### 4.1 各家向量库对「带过滤的 ANN」的官方说法（逐字）

#### pgvector（0.8.x，README，访问 2026-10-12）

URL：https://github.com/pgvector/pgvector （README.md `## Filtering` / `## Iterative Index Scans` / `## Multitenancy` / FAQ）

> "With approximate indexes, filtering is applied *after* the index is scanned. If a condition matches 10% of rows, with HNSW and the default `hnsw.ef_search` of 40, only 4 rows will match on average. For more rows, enable iterative index scans, which will automatically scan more of the index when needed." `[P]`

> "With approximate indexes, queries with filtering can return less results since filtering is applied *after* the index is scanned. Starting with 0.8.0, you can enable iterative index scans, which will automatically scan more of the index until enough results are found (or it reaches `hnsw.max_scan_tuples` or `ivfflat.max_probes`)." `[P]`

> "Strict ensures results are in the exact order by distance … Relaxed allows results to be slightly out of order by distance, but provides better recall" `[P]`

> "Specify the max number of tuples to visit (20,000 by default) … Note: This is approximate and does not affect the initial scan" `[P]`

> FAQ: "Results are limited by the size of the dynamic candidate list (`hnsw.ef_search`), which is 40 by default. There may be even less results due to dead tuples or filtering conditions in the query." `[P]`

> "For applications with multiple tenants, sharing an approximate index between tenants means vectors from one tenant can affect recall (and speed) for other tenants. For tenant isolation, use list partitioning or separate tables." `[P]`

CHANGELOG：`## 0.8.0 (2024-10-30) - Added support for iterative index scans … - Improved cost estimation for better index selection when filtering`；当前最新 `## 0.8.7 (2026-10-01)`。`[P]`

**推断** `[P2]`：README 的示例全部是 `SET hnsw.iterative_scan = …` 显式开启，没有任何地方说它默认开启 → 默认行为仍是「先扫 ef_search=40 个候选，再 WHERE」。所以一个从 0.7 升到 0.8.7 的系统，**不改配置就不会自动获得 iterative scan**。另外「dead tuples」也会吃掉名额——这和 §5 的删除传播直接相关：**软删除越多，过滤后返回越少**。

#### Qdrant（Indexing 与 Multitenancy 文档，访问 2026-10-12）

URL：https://qdrant.tech/documentation/concepts/indexing/

> "In the case of high-selectivity (weak) filters, you can use the HNSW index as it is. In the case of low-selectivity (strict) filters, you can use the payload index and do a complete rescore. However, for cases in the middle, this approach does not work well. On one hand, we cannot apply a full scan on too many vectors. On the other hand, the HNSW graph starts to fall apart when using filters that are too strict." `[P]`

> "Payload indexes should be created before ingesting data. Qdrant's filterable HNSW index only benefits from additional filter-aware edges when it is generated after the payload indexes have been created. If you create a payload index after data has already been ingested, you need to rebuild the HNSW index to take advantage of the new payload indexes." `[P]`

> （ACORN, "Available as of v1.16.0"）"These extra edges are added for each payload index separately, but not for every possible combination of payload indices. As a result, a combination of two or more strict filters might still lead to disconnected graph components. The same can happen when there are a large number of soft-deleted points in the graph." `[P]`

URL：https://qdrant.tech/documentation/guides/multitenancy/

> "Creating a separate collection for each tenant is rarely the most efficient approach. … Only create multiple collections when you have a limited number of tenants that need strict isolation. … Qdrant Cloud limits each cluster to a maximum of 1000 collections by default." `[P]`

> "When using sparse vector search with the IDF modifier, payload-based partitioning alone doesn't isolate IDF statistics. By default, all tenants share the same shard-wide term frequencies." `[P]`

> "By default, these statistics are computed across the entire shard being queried. When using payload-filter-based multitenancy, this blends every tenant's vocabulary into one set of statistics, so a term's IDF no longer reflects its rarity within a specific tenant's data." `[P]`

> "If the corpus filter matches no points, IDF statistics do not fall back to shard-wide statistics. Instead, every term gets the same constant weight, so ranking degenerates to plain TF with no rarity signal." `[P]`

> "…if it matches points that live in a different shard than the one being queried, Qdrant does not reach across shards to satisfy it. It silently computes statistics from whatever overlap exists locally, which can be empty or partial." `[P]`

**推断** `[P2]`：「ACL 过滤 = 只影响返回哪些文档」是错的。BM25 的 IDF 是**语料级统计量**，过滤只挡住了文档，没挡住统计量——**租户 B 的文档会改变租户 A 的排序**（相关性污染），而在极端情况下（一个词只在 B 的机密文档里高频），A 能从自己的检索分数里间接推断 B 语料的词分布（统计侧信道）。Qdrant 官方专门做了 `idf` 参数来解决，本身就说明这不是理论问题。这一条在 L09 的 `bm25Index` 里同样成立（它的 `df` 是全局 Map）。

#### Elasticsearch（knn query 参考，访问 2026-10-12）

URL：https://www.elastic.co/docs/reference/query-languages/query-dsl/query-dsl-knn-query

> "1. pre-filtering – filter is applied during the approximate kNN search to ensure that `k` matching documents are returned.
> 2. post-filtering – filter is applied after the approximate kNN search completes, which results in fewer than k results, even when there are enough matching documents.
> Pre-filtering is supported through the `filter` parameter of the `knn` query. Also filters from aliases are applied as pre-filters.
> All other filters found in the Query DSL tree are applied as post-filters. For example, `knn` query finds the top 3 documents with the nearest vectors (k=3), which are combined with `term` filter, that is post-filtered. The final set of documents will contain only a single document that passes the post-filter." `[P]`

> `num_candidates`："Defaults to `1.5 * k` if `k` is set" `[P]`

**这是本节最反直觉的一条**：在 ES 里写 `bool: { must: { knn }, filter: { term } }`——一个写过 ES 的前端/后端工程师**最自然**的写法——是**后过滤**。ACL 的 `term` 必须写进 `knn.filter` 里（或用带 filter 的 alias）才是前过滤。两种写法**都不报错**，安全性一样（越权文档都被挡掉了），区别只在召回：后者会静默返回 < k 条。

#### OpenSearch（Filtering vector search results，访问 2026-10-12）

URL：https://docs.opensearch.org/latest/vector-search/filter-search-knn/index/

> "Efficient k-nearest neighbors (k-NN) filtering: This approach applies filtering during the vector search, as opposed to before or after the vector search, which ensures that `k` results are returned (if there are at least `k` results in total)." `[P]`

> "Post-filtering: Because it is performed after the vector search, this approach may return significantly fewer than `k` results for a restrictive filter." `[P]`

> "Boolean filter | After search (post-filtering) | … | Outside the k-NN query clause. Must be a leaf clause." `[P]`

> "Scoring script filter: This approach involves pre-filtering a document set and then running an exact k-NN search on the filtered subset. It may have high latency and does not scale when filtered subsets are large." `[P]`

官方推荐表：10M 文档、过滤后剩 2.5%、k=100 时，「lower latency」列推荐 Scoring script（即**精确暴力搜**）。`[P]`

#### Milvus（v2.6.x docs 源文件，访问 2026-10-12）

URL：https://github.com/milvus-io/milvus-docs/blob/v2.6.x/site/en/userGuide/search-query-get/filtered-search.md

> "If a collection contains both vector embeddings and their metadata, you can filter metadata before ANN search to improve the relevancy of the search result. Once Milvus receives a search request carrying a filtering condition, it restricts the search scope within the entities matching the specified filtering condition." `[P]`

> "As illustrated in the diagram above, a search with iterative filtering performs the vector search in iterations. Each entity returned by the iterator undergoes scalar filtering, and this process continues until the specified topK results are achieved." `[P]`

> "However, it's important to note that the iterator processes entities one at a time. This sequential approach can lead to longer processing times or potential performance issues, especially when a large number of entities are subjected to scalar filtering." `[P]`

源码 `internal/core/src/query/PlanProto.cpp`："// currently, iterative filter does not support range search" `[P]`

### 4.2 小结：五家的「默认」放在一起

| 系统 | 默认的过滤时机 | 默认会不会返回 < k | 修法（官方） | 代价 |
|---|---|---|---|---|
| pgvector 0.8 HNSW | 扫完 `ef_search=40` 个候选后 WHERE | **会**（10% 选择率 → 平均 4 条） | `SET hnsw.iterative_scan = strict_order/relaxed_order`；partial index；按租户分区 | 扫描量上限 `max_scan_tuples=20000`，到上限仍可能不足 |
| Qdrant | 图遍历中过滤（filterable HNSW） | 一般不会；**多个严格条件组合**或**大量软删除**时图可能断连 | 入库前建 payload index；v1.16+ ACORN | payload index 建晚了要重建 HNSW |
| Elasticsearch | `knn.filter` 内=前过滤；**bool 外层的 filter=后过滤** | 写错位置**会** | 把 ACL 写进 `knn.filter` 或 filtered alias | 无（写对位置即可） |
| OpenSearch | knn 子句内=efficient filtering；外层 bool/`post_filter`=后过滤 | 写错位置**会** | efficient filtering；高选择性时用 script score 精确搜 | 精确搜延迟 |
| Milvus | 标准过滤=先过滤后 ANN | 不会 | 复杂表达式慢时用 `hints: iterative_filter` | 逐条处理可能慢；不支持 range search |

**贯穿五家的教训** `[P2]`：「前过滤 vs 后过滤」不是一个架构选择题，而是**每家 API 里一个具体的参数位置**。同一个 ACL 条件，写在 JSON 里差一层缩进，安全性不变，召回从 k 掉到 1。**安全审计查不出来（没有越权），召回监控也常常查不出来（「没检索到」是合法结论）。**

### 4.3 ACL 的粒度：文档级、chunk 级、字段级

| 粒度 | 例子 | 坑 |
|---|---|---|
| 文档级 | 文档分享设置；chunk 继承（Onyx `access_control_list`） | 文档 ACL 一变，**所有 chunk** 要同步改（§4.6） |
| chunk 级 | 「附件 3：薪酬方案（仅 HR 可见）」 | 解析时要识别边界，否则只能整篇按最严处理 |
| 字段级 | Excel「工资」列、PII 列 | 必须在**渲染 chunk 文本时**去掉，而不是返回时隐藏——见下 |

Azure AI Search 的「安全过滤模式」文档对「字段隐藏 ≠ 字段级安全」说得很直白（URL：https://learn.microsoft.com/en-us/azure/search/search-security-trimming-for-azure-search ，访问 2026-10-12）：

> "Setting `retrievable` to `false` prevents `group_ids` from being returned as part of a document in search results. It isn't a content-obfuscation or field-level security mechanism. In this pattern, document-level authorization is enforced by applying the security filter to every query. Don't rely on `retrievable` alone to protect sensitive information from all query features or response formats." `[P]`

> "There's no authentication or authorization through the security principal. The principal is just a string, used in a filter expression, to include or exclude a document from the search results." `[P]`

> "For search solutions that can't use the built-in access control list (ACL) support for document-level authorization, Azure AI Search supports creating a filter that trims search results based on a string containing a group or user identity." `[P]`

**向量不是密文**（vec2text，URL：https://arxiv.org/abs/2310.06816 ，访问 2026-10-12）：

> "a multi-step method that iteratively corrects and re-embeds text is able to recover $92\%$ of $32\text{-token}$ text inputs exactly. … our model can recover important personal information (full names) from a dataset of clinical notes." `[P]`

> "These results imply that text embeddings present the same threats to privacy as the text from which they are computed, and embeddings should be treated with the same precautions as raw data." `[P]`

OWASP LLM08:2025（URL：https://genai.owasp.org/llmrisk/llm082025-vector-and-embedding-weaknesses/ ）也把 "Embedding Inversion Attacks" 和 "Cross-Context Information Leaks" 列为该类风险的典型场景，并建议 "permission-aware vector and embedding stores" 与 "strict logical and access partitioning of datasets"。`[P]`

**推断** `[P2]`：字段级 ACL 必须在**入库前**实现——给每个「权限视图」生成一份不含无权字段的 chunk 文本并**分别 embedding**。只在返回时把字段抹掉是不够的：(a) 向量本身可被反演；(b) 无权字段的词会参与 BM25 匹配——用户搜「张三 工资 35000」能命中一个他看不到工资列的 chunk，**命中这件事本身就是泄露**（存在性泄露）。

### 4.4 「重排前必须过滤」：外部 rerank API 看到的是什么

L09 §五说重排「可以慢，所以能看细特征」——细特征的意思是**把全文发给重排模型**。如果重排是外部 API：

Cohere Rerank v2（URL：https://docs.cohere.com/reference/rerank ，访问 2026-10-12）：
> "`documents` (list of string, required) — A list of texts that will be compared to the `query`. For optimal performance we recommend against sending more than 1,000 documents in a single request." `[P]`
> "`max_tokens_per_doc` (integer, optional) — Defaults to `4096`. Long documents will be automatically truncated to the specified number of tokens." `[P]`
> 响应 meta：`cached_tokens` "— The number of prompt tokens that hit the inference cache." `[P]`

**推断** `[P2]`：
1. 「召回 50 → 外部 rerank → ACL 过滤 → top 5」里，**越权全文已经离开了你的边界**，即使最终答案一个字都没用。安全边界是「数据去了哪个进程/供应商」，不是「答案里有什么」——L14「通道」结论在检索链上的版本。同理适用于外部 embedding API、LLM-as-reranker、agentic search 里模型看到的中间结果。
2. `max_tokens_per_doc=4096` **静默截断**：超长整表 chunk 的表尾行对重排器不可见（联动 §3.1）。
3. 不变量：ACL 过滤必须在任何「把 chunk 文本交给第三方或模型」的步骤之前。lab 用一个记录输入的假 reranker 断言（§10 ACL-9/10）。

### 4.5 ACL 参数不能出现在工具 schema 里（接 L14「参数才是攻击面」）

Azure 的 "The principal is just a string" 在 agent 场景下的含义（`[P2]`，结合 L14 §六）：检索做成工具（L09 §八 agentic search）时，schema 里的 `user_groups`、`filter`、`tenant_id`、`doc_ids` 都是 L14 说的 `destination` 类参数——被注入的文档可以让模型填 `filter: {}` 或 `user_groups: ["hr"]`。**规则**：工具 schema 只放 `query`、`k` 和业务过滤（`selector` 类）；身份与权限由运行时从会话注入。lab 断言 `buildSearchRequest` 遇到 ACL 字段**抛错**而不是忽略（忽略会掩盖注入尝试）。

### 4.6 权限变更的传播：同步窗口与缓存

**同步是周期性的**。Onyx（`backend/ee/onyx/configs/app_configs.py`，commit d6f2ee0，2026-10-11，`[P]`）：

```python
DEFAULT_PERMISSION_DOC_SYNC_FREQUENCY = int(
    os.environ.get("DEFAULT_PERMISSION_DOC_SYNC_FREQUENCY") or 5 * 60
...
CONFLUENCE_PERMISSION_DOC_SYNC_FREQUENCY = int(
    os.environ.get("CONFLUENCE_PERMISSION_DOC_SYNC_FREQUENCY") or 30 * 60
...
JIRA_PERMISSION_DOC_SYNC_FREQUENCY = int(
    os.environ.get("JIRA_PERMISSION_DOC_SYNC_FREQUENCY") or 30 * 60
```
（同文件：Canvas、Box 也是 `30 * 60`；GitHub、Slack 是 `5 * 60`。）

Onyx `access.py` 关于改名用户的注释（`[P]`）：
> "Addresses the user was renamed away from match too. Indexed ACLs keep naming the old one until the source system re-syncs, and the alias is revoked as soon as the address belongs to somebody else."

Onyx 对无法预同步权限的源（Salesforce）用**查询后审查**（`ee/onyx/external_permissions/post_query_censoring.py`，`[P]`）：
> "This function checks all chunks to see if they need to be sent to a censoring function." 以及 "NOTE: This means if there is a source has a single cc_pair that is sync, all chunks for that source will be censored, even if the connector that indexed that chunk is not sync."

**推断** `[P2]`：
1. 「我们的 RAG 尊重源系统权限」的准确说法是「尊重**最近一次同步时**的源系统权限」。在 Confluence 上撤销某人对一篇文档的访问后，默认最长约 30 分钟（加任务排队时间）内他仍能检索到它。讲稿应让学员能说出**自己系统的撤权延迟上界**，这是面试里一个好问题。
2. Onyx 的 post-query censoring 是**后过滤**——§4.1 的「返回少于 k 条」在这里同样成立。
3. **缓存是第二个副本**。RedisVL `SemanticCache.check()`（URL：https://redis.io/docs/latest/develop/ai/redisvl/api/cache/ ，`[P]`）："filter_expression (Optional[FilterExpression]) – Optional filter expression that can be used to filter cache results. Defaults to None and the full cache will be searched." —— **默认全缓存搜索、不分用户**。L15 讲过的语义缓存，在企业 RAG 里如果 key 不含「权限指纹」，A 问过的问题的答案（基于 A 能看的文档）会直接返回给 B。
   key 只含 `user_id` 安全但命中率低；含「**有效 ACL 集合的哈希** + 语料版本号」则同权限的人共享缓存、权限一变 key 就变（天然失效）。检索结果缓存同理。lab 的 `cacheKey` TODO：principals 要排序去重（否则同权限不同 key），漏掉 principals 则是安全问题。

### 4.7 多租户：隔离的三个层次

（pgvector / Qdrant 的一手原文见 §4.1）

| 层次 | 做法 | 隔离强度 | 代价 | 一手来源 |
|---|---|---|---|---|
| 逻辑 | 共享索引 + `tenant_id` 过滤 | 依赖每条查询都带过滤；**统计量（IDF）共享**；ANN 召回互相影响 | 最省 | Qdrant multitenancy（"Partition by payload"）；pgvector："vectors from one tenant can affect recall (and speed) for other tenants" |
| 物理分区 | 按租户 list 分区 / 每租户 shard | 召回与统计量独立 | 分区数有上限、运维成本 | pgvector："use list partitioning or separate tables"（Qdrant 的按租户分片本轮未读原文，见 §14） |
| 独立实例/集合 | 每租户一个 collection | 最强 | "Qdrant Cloud limits each cluster to a maximum of 1000 collections by default." | Qdrant multitenancy |

**推断** `[P2]`：「多租户 = 加一个 tenant_id 过滤」只解决了**返回**隔离，没解决**统计**隔离（IDF、BM25 avgdl、ANN 图结构）。L09 的 `bm25Index` 把 `df` 存在一个全局 `Map` 里——把它直接用于多租户就是 Qdrant 文档描述的那个问题。lab 观察实验可以让学员亲眼看到：**往租户 B 加 50 篇含「报销」的文档，租户 A 搜「报销」的排序变了**。

### 4.8 trace / 日志：第三个副本

OpenTelemetry GenAI 语义约定（现已迁到独立仓库，URL：https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md ，访问 2026-10-12）对检索 span 的规定（`[P]`）：

> `gen_ai.retrieval.documents` | `Opt-In` | "The documents retrieved." … "Each document object SHOULD contain the following properties when available: `id` (string): A unique identifier for the document, `score` (double): The relevance score of the document"

> `gen_ai.retrieval.query.text` | `Opt-In` | "> [!Warning] This attribute may contain sensitive information."

> （memory 同类属性）"Instrumentations SHOULD NOT capture this attribute by default. Capture SHOULD be gated by an explicit user opt-in, for example `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT`."

**推断** `[P2]`：
1. 规范推荐检索文档只记 `id` + `score`、不记正文，且整个属性 Opt-In。为「方便排查」（L13）打开内容捕获后，**trace 后端就是一份无 ACL 的知识库副本**：能看 trace 的人能看到 HR 的每个问题和检索到的每段薪酬文本。
2. 标题也可能敏感（「2026 Q4 组织调整方案」）：trace 记 chunk id 与 ACL 指纹，不记标题。
3. 从生产 trace 抽样构造的评测集（L12）继承原文档 ACL，其可见范围不能大于样本 ACL 的交集。

### 4.9 「让模型自己判断能不能说」：一手数据说不行

OrgAccess（URL：https://arxiv.org/abs/2505.19165 ，HTML v3，访问 2026-10-12，`[P]`）：
> "our findings reveal that even state-of-the-art LLMs struggle significantly to maintain compliance with role-based structures, even with explicit instructions, with their performance degrades further when navigating interactions involving two or more conflicting permissions. Specifically, even GPT-4.1 only achieves an F1-Score of 0.27 on our hardest benchmark."

ARBITER（URL：https://arxiv.org/abs/2512.20535 ，访问 2026-10-12，`[P]`）：LLM few-shot 做 RBAC 过滤，"Qwen2.5-14B achieved 85% accuracy and 89% F1-score, representing only a 5-percentage-point gap from the static filter baseline."——即 **LLM 过滤比静态过滤差**，作者自己把静态过滤当上限。

Position: Enterprise AI Must Enforce Participant-Aware Access Control（URL：https://arxiv.org/abs/2509.14608 ，访问 2026-10-12，`[P]`）：
> "We show that existing defenses, including prompt sanitization, output filtering, system isolation, and training-level privacy mechanisms, are fundamentally probabilistic and fail to offer robust protection against such attacks."
> "If a participant's query triggers the RAG component, only those documents for which every active participant has access will be retrieved and added to the supplementary context."

**推断** `[P2]`：
1. 「把 ACL 规则写进 system prompt，让模型别说不该说的」——这是 L14 讲过的 in-band 防御，在权限场景下的一手数字是 F1 0.27（最难档）。权限必须是**确定性代码**在检索层执行。
2. **多人会话的有效权限是交集**。群聊机器人、共享频道、把 agent 拉进一个多人文档评论区：检索要用**所有在场者 ACL 的交集**，而不是提问者的 ACL。这一条对写过单用户 RAG 的人非常反直觉，也很适合做 lab 断言：`effectivePrincipals([alice, bob])` 返回的可见文档集合 ⊆ 各自可见集合的交集。
3. Microsoft 365 Copilot 官方文档（URL：https://learn.microsoft.com/en-us/copilot/microsoft-365/microsoft-365-copilot-privacy ，访问 2026-10-12，`[P]`）："Microsoft Copilot only surfaces organizational data to which individual users have at least view permissions. It's important that you're using the permission models available in Microsoft 365 services, such as SharePoint, to help ensure the right users or groups have the right access to the right content within your organization." —— 这句话的另一面（`[P2]`）：**RAG 会把源系统里一直存在、但没人发现的过度共享（oversharing）变成可被一句话检索到的东西**。「尊重源系统权限」不等于安全，它等于「把源系统的权限错误放大」。入库前的权限体检（「全员可见」且含敏感词的文档数）是质量门禁的一项（§6.3）。

## 5. 版本、新鲜度、删除传播

> 代码库 RAG 的「版本」由 git 管：一个 commit 就是一个一致的快照，删掉的文件在下一次索引里自然消失。企业知识库没有 commit：同一份《差旅报销办法》可能有 2023 版、2025 版、2025 版的「补充通知」同时在 SharePoint 里；源系统里删掉的文档，向量库**不会自动知道**。

### 5.1 删除不会自己传播：两大框架的默认值

**LangChain `index()`**（`langchain_core/indexing/api.py`，`[P]`，读的是 GitHub main 分支源码，访问 2026-10-12）：

```python
cleanup: Literal["incremental", "full", "scoped_full"] | None = None,
```

docstring 原文：
> "- incremental: Cleans up all documents that haven't been updated AND that are associated with source IDs that were seen during indexing. …
> - full: Delete all documents that have not been returned by the loader during this run of indexing. Clean up runs after all documents have been indexed. This means that users may see duplicated content during indexing.
> - scoped_full: Similar to Full, but only deletes all documents that haven't been updated AND that are associated with source IDs that were seen during indexing.
> - None: Do not delete any documents."

> "* In full mode, the loader should be returning the entire dataset, and not just a subset of the dataset. Otherwise, the auto_cleanup will remove documents that it is not supposed to."

> "force_update: Force update documents even if they are present in the record manager. Useful if you are re-indexing with updated embeddings."

文档 hash 的算法（同文件，`[P]`）：
```python
content_hash = _calculate_hash(document.page_content, algorithm=key_encoder)
serialized_meta = json.dumps(metadata, sort_keys=True)
metadata_hash = _calculate_hash(serialized_meta, algorithm=key_encoder)
hash_ = _calculate_hash(content_hash + metadata_hash, algorithm=key_encoder)
```

**LlamaIndex `IngestionPipeline`**（`llama_index/core/ingestion/pipeline.py`，`[P]`）：
> "Document de-dup strategy. Defaults to DocstoreStrategy.UPSERTS."
> "UPSERTS_AND_DELETE: ('upserts_and_delete') Use upserts and delete to handle duplicates. Like the upsert strategy but it will also delete non-existing documents from the doc store"
> 没有 vector store 时的回退警告："…to apply upsert/delete semantics; falling back to 'duplicates_only' for this run."

**推断** `[P2]`（这几条对写过 L09 的人很反直觉）：
1. **默认不删**。两个框架的默认（`cleanup=None` / `UPSERTS`）都**不会删除源系统里已删掉的文档**。删除必须显式开启。
2. **incremental 删不掉「整篇被删」的文档**：它只清理「本次见过的 source id」下的旧 chunk。整篇被删的文档**本次根本没见过**，所以它的 chunk 永远留着。这正是企业里最常见的删除形态（文档下线、员工离职后其个人空间被清理）。
3. **full 模式有反向危险**：loader 这次因为网络抖动/权限过期只返回了一半文档，full 模式会把另一半**全删掉**。删除传播需要「墓碑」（明确的删除事件）而不是「这次没看到」。
4. **hash 含 metadata**：ACL 写在 metadata 里时，**改权限 = hash 变 = 重新 embedding**。对一个 10 万文档的库，一次大规模组织调整（换部门组名）会触发全量重 embedding——这不是 bug，是设计后果；更好的做法是 ACL **不进 hash**、单独走一条「只更新 payload」的通道（Qdrant `set_payload`、ES `_update`）。
5. **hash 不含 embedding 模型名**：换模型后 record manager 认为「什么都没变」，必须 `force_update`。
6. 「墓碑」是 lab 里最适合做成 TODO 的概念：`applyTombstones(index, events)`，断言「整篇删除」「部分 chunk 删除」「删除后同 id 重新创建」三种情况。

### 5.2 删了，但统计量还记得：BM25 / ANN 的「幽灵文档」

Elasticsearch「Getting consistent scoring」（URL：https://www.elastic.co/docs/solutions/search/full-text/search-relevance/consistent-scoring ，访问 2026-10-12，`[P]`）：
> "As you may know when documents are deleted or updated, the old document is not immediately removed from the index, it is just marked as deleted and it will only be removed from disk on the next time that the segment this old document belongs to is merged. However for practical reasons, those deleted documents are taken into account for index statistics."

pgvector README（`[P]`）：
> "There may be even less results due to dead tuples or filtering conditions in the query."

Qdrant ACORN（§4.1 已引，`[P]`）："The same can happen when there are a large number of soft-deleted points in the graph."

**推断** `[P2]`：删除/更新在三类索引里都是「先标记、后回收」：
- **BM25**：被删文档的词仍然计入 df 和 N → 一个高频「旧版本」词的 IDF 被压低；**更新**同样产生 deleted doc（ES 更新 = 删 + 插），所以频繁更新的文档会让统计量漂移。
- **HNSW**：dead tuple/软删除点占用 `ef_search` 名额 → 返回更少结果（和 §4.1 的过滤问题叠加）。
- **对 lab 的意义**：L09 的 `bm25Index` 每次重建，所以没有这个问题；企业 RAG 是增量的。lab 可以让 `bm25Index` 支持「标记删除」并**故意保留统计量**，让学员看到：删除 30 篇旧版文档后，新版文档的分数**没有**回到「从头重建」时的值。

### 5.3 嵌入模型 / 解析器升级：索引的「代」

Dify 企业版文档（URL：https://enterprise-docs.dify.ai/en/3.9.x/use/knowledge-base/knowledge-and-documents-maintenance/introduction ，访问 2026-10-12，`[P]`）：
> "Embedding Model: Allows you to modify the embedding model for the knowledge base. Changing the embedding model will re-embed all documents in the knowledge base, and the original embeddings will be deleted."

Dify 云版文档（URL：https://docs.dify.ai/en/cloud/use-dify/knowledge/manage-knowledge/introduction ，访问 2026-10-12，`[P]`）：
> "Summary Auto-Gen | Automatically generate summaries for document chunks. Once enabled, this only applies to newly added documents and chunks."

MinerU（§2.4 已引，`[P]`）："Old caches are not rewritten; reparse"。

**推断** `[P2]`：
1. 一个企业索引里的 chunk 有**三个代际维度**：解析器版本、分块策略版本、embedding 模型版本。Dify 的「Summary Auto-Gen 只对新文档生效」就是一个**配置变更只影响新数据**的例子——索引里同时存在「有摘要」和「没摘要」两代 chunk，检索时它们的分数分布不同。
2. embedding 模型不同代的向量**不可比**（不同空间），所以「先换模型、再慢慢补」期间要么双写双读、要么停服。Dify 的做法是「re-embed all … original embeddings will be deleted」——**中间态**下检索会怎样，文档没写（列入 §14）。
3. 每个 chunk 应带 `{parser, chunker, embedder}` 版本三元组；查询时**断言**结果集只来自同一 embedder 版本——lab 可以断言「混入旧 embedder 版本的 chunk 时 `search` 抛错」。

### 5.4 新旧版本共存与上下位冲突：法规给出的优先序（以及它的空白）

《中华人民共和国立法法》（2023 年第二次修正，国家税务总局政策法规库全文，与 §3.3 同一页面，URL：https://fgk.chinatax.gov.cn/zcfgk/c100009/c5211769/content.html ，访问 2026-10-12，`[P]`）：

> "第九十九条 法律的效力高于行政法规、地方性法规、规章。"
> "第一百零三条 同一机关制定的法律、行政法规、地方性法规、自治条例和单行条例、规章，特别规定与一般规定不一致的，适用特别规定；新的规定与旧的规定不一致的，适用新的规定。"
> "第一百零五条 法律之间对同一事项的新的一般规定与旧的特别规定不一致，不能确定如何适用时，由全国人民代表大会常务委员会裁决。"

**推断** `[P2]`（法规是企业制度的一个规范化样本，企业内部制度通常仿照这套优先序）：
1. 冲突消解至少有**三个维度**：**效力层级**（上位 > 下位：集团制度 > 子公司细则）、**特别 vs 一般**（《研发部差旅补充规定》> 《公司差旅办法》）、**新 vs 旧**。「按时间取最新」只是第三个维度。
2. 这三个维度会**互相打架**，而立法法第一百零五条承认：「新的一般规定与旧的特别规定不一致」时**规则本身无法裁决**，要交给人。RAG 系统的对应做法是：**检测到这种冲突时，把两段都给出并标注冲突，而不是选一个**。
3. 「生效日期」≠「发布日期」≠「修改时间」。一份 2026-09 发布、2027-01-01 生效的新办法，在 2026-10-12 这天**不应**覆盖旧办法。用文件 mtime 当版本是错的。
4. 模型会不会自己处理冲突？ClashEval（URL：https://arxiv.org/abs/2404.10198 ，`[P]`）："LLMs are susceptible to adopting incorrect retrieved content, overriding their own correct prior knowledge over 60% of the time. However, the more unrealistic the retrieved content is (i.e. more deviated from truth), the less likely the model is to adopt it." —— 旧版制度和新版只差一个数字（报销上限 300 → 500），这正是「最不 unrealistic」的那类冲突，模型最容易照抄检索到的那一版。**版本消解必须在检索层做，不能指望生成层**。`[P2]`

lab 可以用一个 `resolveVersions(chunks, asOf)` 实现上述规则，并在观察实验里打出「仅按时间」「按时间+生效日」「三维规则」三种策略对 6 个冲突场景的判决表（§9 EXP-5）。

### 5.5 增量索引：「什么时候算变了」

| 变化 | 需要重解析 | 需要重分块 | 需要重 embedding | 需要更新 payload |
|---|---|---|---|---|
| 正文改了一个字 | ✔ | ✔（该文档） | ✔（变化的 chunk） | — |
| 权限变了 | — | — | ✘（若 ACL 不进 hash） | ✔（该文档所有 chunk） |
| 文档被删 | — | — | — | **墓碑** → 删全部 chunk |
| 生效日 / 废止标记变了 | — | — | — | ✔ |
| 解析器升级 | ✔（全量） | ✔ | ✔ | ✔ |
| embedding 模型升级 | — | — | ✔（全量，新代） | — |

`[P2]`，由 §5.1–5.3 的一手原文推出。lab 的 `planReindex(oldDoc, newDoc)` 可以返回这张表里的一行（一个小而有判别力的纯函数）。

## 6. 引用定位、评测、入库质量门禁

### 6.1 引用要定位到「页 + 区域」，而且要能回放

L09 §七的引用校验是「答案里的 `[n]` 必须指向一个实际给过的 chunk」——这是**结构**校验。企业文档多两层要求：

1. **人要能点开看到原文位置**。代码 RAG 给 `src/login.ts:42`，用户打开就是。PDF 给「第 12 页」——但是**哪个第 12 页**？
   - MinerU `page_idx` 从 0 开始，CLI 的页参数从 1 开始（§2.4，`[P]`）；
   - PDF 的「物理页序号」≠ 页面上印的页码（封面、目录常用罗马数字，正文从 1 重新开始）；
   - 页眉页脚被去掉之后，**印刷页码这个信息也一起被去掉了**（Marker 默认删页眉页脚，§2.4；PP-StructureV3 默认 `markdown_ignore_labels` 含 `number`，§3.2）。
   → `[P2]`：chunk 至少要带 `{page_index0, page_label, bbox}` 三个字段；显示给用户的是 `page_label`（若有）否则 `page_index0 + 1`。lab 断言：`citeLocator` 对 `page_index0 = 0` 显示「第 1 页」，对有印刷页码「iii」的页显示「iii」。
2. **跨页的 chunk 有两个页码**。MinerU 的 `continues_prev`（§2.4）说明一个表格/段落可能横跨两页。引用定位应给**范围** `p.12–13`，而不是第一页。
3. **表格行 chunk 的定位**：RAGFlow 按行生成表格 chunk（`internal/ingestion/component/chunker/table.go`，`[P]`）：
   `names := rows[0]`，紧随其后的注释："R1: a row chunk must carry only its own tuple. … a whole-table tuple must not be copied onto every row, and PDF items write layout boxes into the same field, so misaligned or non-spreadsheet payloads get no positions at all."
   以及：
   > "pre-upgrade row-IR records (ck_type: table_row/table_header with cells), which hold no markup and therefore keep no per-row positions; documents from before this wire must be re-parsed rather than re-chunked."

   **推断** `[P2]`：(a) **PDF 表格的行 chunk 没有任何位置信息**——不是「只到表」，是「什么都没有」；只有电子表格才有行级坐标。审计场景（「这个数字出自哪一格」）在 PDF 上做不到。(b) 他们明确拒绝把整表坐标复制到每一行——因为那会让引用**看起来精确但其实是错的**，这是一个值得在课上讲的设计判断：**没有坐标比错的坐标好**。(c) `names := rows[0]`：即使 `HeaderRows > 1`，列名也只取第一行表头（§3.1 的多级表头问题在当前 Go 代码里依然存在）。(d) 「must be re-parsed rather than re-chunked」——又一个「解析器升级 → 旧数据必须重解析」的一手例子（§5.3）。
4. **ColPali 类方案天然只到页**（§2.3）：它检索的是页面图像的 patch，引用自然是「第 N 页」，没有文本 span。

### 6.2 企业 RAG 的评测：比 L12 多的三个维度

L12 已经讲了 judge 校准、配对检验、分层抽样和门禁。企业 RAG 在其上**多出**的维度（`[P2]`，由 §2.2、§4、§5 推出）：

| 维度 | 为什么 L12 的做法不够 | 做法 |
|---|---|---|
| **身份分层** | 同一问题，HR 与普通员工的正确答案不同；不分身份会把越权回答判成「答对」 | 样本带 `asPrincipal`，按身份分层报告；**越权率**（引用了不可见 chunk）是必须为 0 的硬门禁 |
| **版本时点** | 正确答案取决于 `asOf` | 样本带 `asOf`；统计「引用已废止版本」的比率 |
| **解析退化** | 编辑距离不对齐 RAG 表现（§2.2） | 解析器升级跑**检索层**回归（L12 门禁），不只看编辑距离 |

和 L12 的连接点：L12 §八「随机抽样会给你一个 90 分的废评测集」——在企业 RAG 里，随机抽样会几乎全部抽到「全员可见」的文档（因为它们最多），于是**权限相关的失败模式在评测集里不存在**。分层维度里必须有「身份 × 文档可见范围」。

**越权率是计数，不是比例**。L14 §十二说报数要两个轴；这里的对应是：「500 条样本 0 次越权」只能说明越权率的 95% 置信上界约为 3/500 = 0.6%（rule of three）——不能说「没有越权」。`[P2]`

### 6.3 入库质量门禁：解析器不抛异常，所以要自己查

（以下检查项由 §2–§5 的一手原文推出，`[P2]`；阈值是建议值，需要在真实语料上校准，**不是**一手数字）

| 检查 | 抓的是什么（依据） |
|---|---|
| 页覆盖率：有文本的页 / 总页数 | 扫描页被当文本页、整页空白（§2.4） |
| 乱码率：私用区（U+E000–F8FF）等异常字符占比 | 文本层损坏的「伪文本 PDF」（§2.1） |
| 表格数 vs「表 N」/「Table」标题数 | 表格漏检（§2.1） |
| 页眉页脚残留：同串在 ≥3 页顶/底部出现 | 页眉打断句子（§3.2） |
| 脚注丢失：正文有「①」但无脚注文本 | 默认忽略 footnote（§3.2） |
| 编号断档：「第五条」后直接「第七条」 | 跨页/多栏漏段（§3.3） |
| ACL 缺失 | fail-open 风险（§7.1） |
| 过度共享：ACL 含「全员」且命中敏感词 | oversharing 被放大（§4.9） |
| 缺 `effectiveFrom` | 版本消解无法进行（§5.4） |

lab 的 `qualityGate(parsedDoc)` 可以实现其中 5–6 项，返回 `{pass, issues[]}`；观察实验用 4 份「故意坏掉」的假解析结果，打出「哪项检查抓住了哪份」的矩阵——**每份坏文档恰好只被一项检查抓住**（这条性质本身可以做断言：证明检查之间不冗余）。

## 7. 开源企业 RAG 项目怎么做

> 三个项目都在本机 sparse clone 读了源码：Onyx `d6f2ee0`（2026-10-11）、RAGFlow `489d0b4`（2026-10-12，**主体代码已迁到 Go，位于 `internal/`**）、Dify `f225852`（2026-10-12）。以下只写读过原文的东西。

### 7.1 权限模型对照

| | Onyx | Dify | RAGFlow |
|---|---|---|---|
| ACL 粒度 | **文档级**，chunk 继承；ACL 是字符串集合 | **知识库（dataset）级** | **知识库级**（CE 版 `ResourceKind` 只有 `dataset`/`canvas`/`agent_session`） |
| 源系统权限同步 | 有（EE），按 connector 周期同步，默认 5–30 分钟 | 无 | 无 |
| 过滤位置 | 检索请求里带 `access_control_list` 过滤（下推）；Salesforce 等源走**查询后审查** | 数据集级访问检查 + 检索后按段状态再查库 | 数据集级 scope；检索后 `PruneDeletedChunks` |
| 读 = 写？ | 否 | **是**（见下） | Team 成员可上传、解析 |

**Onyx**（`backend/onyx/access/utils.py` 等，`[P]`）：
> `prefix_user_email`："Prefixes a user email to eliminate collision with group names"
> `build_ext_group_name_for_onyx`："External groups may collide across sources, every source needs its own prefix. NOTE: the name is lowercased"

→ ACL 字符串形如 `user_email:alice@x.com`、`group:hr`、`external_group:confluence_hr`。**命名空间前缀**是一个很容易被忽略的不变量：如果有个组恰好叫 `alice@x.com`，没有前缀就会让组成员获得 alice 的个人权限。lab 的 `principalsOf(user)` 应该输出带前缀的字符串，断言 `group:alice@x.com` ≠ `user:alice@x.com`。`[P2]`

Onyx 的 ACL 过滤**放在 `knn` 子句内部**（`backend/onyx/document_index/opensearch/search.py`，`[P]`）：
```python
        if search_filters is not None:
            knn_field_query["filter"] = {"bool": {"filter": search_filters}}

        return {"knn": {CONTENT_VECTOR_FIELD_NAME: knn_field_query}}
```
ACL 子句本身是 `bool.should` = 「`public` 为真 OR `terms` 命中任一 principal」，`minimum_should_match: 1`；principal 数超过 `MAX_NUM_TERMS_ALLOWED_IN_TERMS_QUERY = 65_536` 时 `raise ValueError`（同文件，`[P]`）。

**推断** `[P2]`：把 filter 放进 knn 子句，正是 §4.1 OpenSearch 文档说的「efficient k-NN filtering」（预过滤）；如果放在外层 `bool.filter`，就成了后过滤、可能少于 k 条。**同一个 filter，放的位置差一层花括号，语义完全不同**——这是 lab 可以用一个「请求构造器」纯函数断言的点（断言 ACL 出现在 knn 内部，而不是外层）。另外，ACL 超过上限时 **抛错**而不是截断——截断会静默丢掉一部分权限（fail-closed 但不可解释），抛错是可观测的。

Onyx 检索路径里有一处「跳过 ACL」的分支（`search_runner`，`[P]`）："No need for ACL here because the doc ids were validated beforehand"，随后 `IndexFilters(access_control_list=None)`。—— 按 id 取文档时信任上游已校验。**推断** `[P2]`：这类「上游已校验」的捷径是越权的高发点：任何能让 doc id 不经校验流到这里的新路径（比如模型在工具参数里给出 doc id——又是 L14 的 `destination` 参数）都会绕过 ACL。lab 断言：`fetchByIds(ids, session)` **也必须**做 ACL 检查。

**Dify**（`api/models/enums.py:371` + 官方文档，`[P]`）：
`class PermissionEnum(StrEnum)`（docstring："Shared permission levels for resources (datasets, credentials, etc.)"）只有 `ONLY_ME = "only_me"`、`ALL_TEAM = "all_team_members"`、`PARTIAL_TEAM = "partial_members"` 三档。云版文档（URL 同 §5.3，`[P]`）："Permissions | Defines which workspace members can access the knowledge base. Members granted access to a knowledge base have all the permissions listed in Manage Knowledge Content."；企业版文档（`[P]`）："authorized users are granted full permissions, including the ability to view, edit, and delete knowledge base content"。

**推断** `[P2]`：Dify 没有文档级 ACL，也没有「只读」档。「全员可读、仅 HR 可写」只能靠**拆库 + 让应用去检索**实现，此时检索身份是**应用**而非提问者——典型的 confused deputy：能用这个应用的人都继承了应用对知识库的权限。

Dify 检索后会再查一次数据库（`api/core/rag/datasource/retrieval_service.py`、`dataset_retrieval.py`，`[P]`）：段要满足 `DocumentSegment.enabled == True, DocumentSegment.status == "completed"`，文档要满足 `DatasetDocument.enabled == True`、`archived == False`。→ 「禁用/归档」是**查询时后过滤**实现的，不是从索引里删除。§4.1 的「后过滤返回少于 k 条」同样适用。`[P2]`

**RAGFlow**（`internal/service/nlp/retrieval.go`，`[P]`）：函数 `PruneDeletedChunks`（注释 "removes chunks whose documents no longer exist"）在检索结果上逐条查文档是否还存在；对 `doc_id` 为空的 chunk 走分支 "// Keep chunks without doc_id"；删掉时打日志 "Pruned stale chunks whose documents no longer exist"。

**推断** `[P2]`：
1. 这个函数的存在本身说明**文档删除没有可靠地传播到检索引擎**，只能查询时兜底——§5.1 在生产项目里的直接证据。
2. 兜底是**后过滤**（返回少于请求数），且对缺 `doc_id` 的 chunk **fail-open**。权限语义下应 fail-closed：lab 断言 `aclVisible` 对缺 `acl` 的 chunk 返回 false（ACL-1）。

RAGFlow 空结果时的放宽重试（同文件注释，`[P]`）："If result is empty, retry with relaxed conditions"；有 doc_id 过滤时 "fall back to a filter-only search (no text match, no vector match)"；否则 "retry with lower min_match (0.1 vs default 0.3) and lower vector similarity threshold (0.17 …)"。
**推断** `[P2]`：「空结果 → 放宽阈值再查」对开放域问答是好意，但在企业 RAG 里，**「检索为空」本身是信号**——可能是用户无权访问相关文档。放宽后返回「过滤后剩下的、和问题无关的 chunk」，模型就会基于不相关内容作答。L12 的「拒答率」指标在这里要按身份分层看（§6.2）。

### 7.2 解析与分块

只核实了 RAGFlow：自研 PDF 管线位于 `internal/deepdoc/parser/pdf/`（含 `table/` 下的表格结构、跨页合并 `table_merge.go`、caption 合并等文件）；表格按行生成 chunk（§3.1、§6.1）；页眉页脚规则见 §3.2。Onyx 与 Dify 的解析路径本轮没有读源码，不做断言（§14 第 8 条）。

## 8. 与 L09 / L12 / L14 的边界

| 主题 | 已在主线讲过（L09x 直接引用，不重讲） | L09x 只讲增量 |
|---|---|---|
| 分块 | L09 §二：按结构切、overlap、chunk 带路径 | 表格保头、中文公文编号、页眉页脚、跨页 |
| BM25 / 中文分词 | L09 §三：字 + 二元组、驼峰切分 | 全角数字被 L09 tokenizer **丢弃**、NFKC、跨语言 `\d` 差异、多租户 IDF |
| 混合检索 / RRF / 重排 | L09 §三–§五 | **过滤的位置**：在 ANN 内 / 外、在 rerank 前 / 后 |
| 引用校验 | L09 §七：`[n]` 指向实际给过的 chunk | 页码 0/1 基、印刷页码、跨页范围、表格行定位 |
| agentic search | L09 §八 | 检索工具 schema 不能有 ACL 参数（接 L14） |
| 评测、门禁、分层 | L12 全课 | 身份分层、`asOf` 版本时点、越权率当硬门禁、解析器升级回归 |
| 注入、参数角色、通道 | L14 §六、§七 | ACL/tenant/doc id 是 `destination` 类参数；外部 rerank 是「数据离开边界」的通道 |
| 缓存 | L15 | 缓存 key 必须含权限指纹 + 语料版本 |
| 可观测性 | L13 | OTel 检索属性 Opt-In、只记 id+score |

**L09x 不讲**：向量库选型（只讲各家**过滤语义**）、OCR 模型原理、embedding 训练、GraphRAG、知识图谱。

## 9. Lab 设计提案

> 约束（来自课程规范）：参考实现 `labs/shared/kb.ts` + `kb.py`（snake_case），纯函数优先，零网络、零模型、零真向量库、零新依赖。学生文件 `labs/l09x/kb.{ts,py}`（5–7 个 TODO），观察实验 `labs/l09x/explore.{ts,py}`，断言 `labs/l09x/verify.{ts,py}`。复用 `labs/shared/retrieval` 的 `tokenize`/`bm25Index`/`fakeEmbed` 与 `codingEval` 的 `fmtFixed`/`cmpCodePoint`（注意 §11.3 第 1 条）。

### 9.1 假数据：一份手写的「已解析文档」JSON（`labs/l09x/fixtures/corpus.json`）

一个虚构公司「青禾科技」的 7 份文档（两语言读同一个 JSON 文件，避免数据本身分叉）：

| docId | 内容要点 | 用来暴露 |
|---|---|---|
| `travel-2023` | 《差旅报销办法（2023）》：第一章…第十三条；住宿上限 300 元；页眉「青禾科技 内部资料」×5 页；页码 0–4，印刷页码 i, ii, 1, 2, 3 | 页眉残留、印刷页码、旧版本 |
| `travel-2025` | 2025 版，上限 500 元，`effectiveFrom 2025-07-01` | 新版本 |
| `travel-2026` | 2026 版，`issued 2026-09-20`、`effectiveFrom 2027-01-01` | 未生效 |
| `rd-travel-supp` | 《研发部差旅补充规定》，`special: true`，2024 | 特别 vs 一般 |
| `budget-2025` | 两级表头的预算表（「2025年 / 金额、占比」），跨第 2–3 页（`continuesPrev`），含「合计」行；一个脚注「① 不含外包」 | 表格切法、跨页、脚注 |
| `hr-salary` | 薪酬表，ACL `group:hr`；含字段级敏感列「月薪」 | 字段级 ACL、存在性泄露 |
| `legacy-notice` | 无 `acl` 字段、无 `effectiveFrom` | fail-closed、质量门禁 |

外加：两个租户（`acme`、`globex`），`globex` 有 10 篇含「报销」的短文档；4 个用户（alice@HR、bob@研发、carol@globex、dave 新人只在 `group:all`）；一个名为 `alice@qinghe.com` 的**组**（测 principal 前缀碰撞）。

### 9.2 共享 API 草图（`labs/shared/kb.ts`；Python 同名 snake_case）

```ts
// ── 数据形状
export type BlockKind = 'heading' | 'para' | 'table' | 'footnote' | 'header' | 'footer' | 'page_number' | 'caption'
export interface TableData { caption: string; headerRows: string[][]; rows: string[][] }
export interface Block { id: string; kind: BlockKind; text: string; page: number /* 0 起 */; bbox: [number, number, number, number]; continuesPrev?: boolean; table?: TableData }
export interface ParsedPage { index0: number; label?: string /* 印刷页码 */; height: number; blocks: Block[] }
export interface VersionMeta { family: string; level: number /* 1=集团 */; special: boolean; issued: string; effectiveFrom?: string; repealedAt?: string; mtime: string }
export interface ParsedDoc { docId: string; tenant: string; title: string; acl?: string[]; version: VersionMeta; parser: string; pages: ParsedPage[] }
export interface Gen { parser: string; chunker: string; embedder: string }
export interface KbChunk { id: string; docId: string; tenant: string; text: string; headingPath: string[]; pages: [number, number]; pageLabels: [string, string]; acl?: string[]; version: VersionMeta; gen: Gen; kind: 'text' | 'table_row' }
export interface Session { userId: string; tenant: string; principals: string[] }

// ── 解析后清洗 & 分块
export function normalizeText(s: string): string                         // 去 BOM → NFKC
export function detectRunningLines(pages: ParsedPage[], zone?: number, minPages?: number): string[]  // 顶/底 zone 内出现 ≥minPages 页的行
export function headingLevel(line: string): { level: number; label: string } | null   // TODO-1 ★
export function renderTableRows(t: TableData): string[]                  // TODO-2 ★★ 多级表头按列拼「2025年/金额」
export function chunkDocument(doc: ParsedDoc, gen: Gen, maxChars?: number): KbChunk[]
export function citeLocator(c: KbChunk): string                           // 「第 1 页」/「p. ii」/「pp. 3–4」

// ── 权限
export function principalKey(kind: 'user' | 'group' | 'ext_group', name: string, source?: string): string  // 前缀 + 小写
export function aclVisible(c: KbChunk, principals: string[]): boolean      // 缺 acl → false
export function visibleToAll(c: KbChunk, sessions: Session[]): boolean     // 多人会话 = 交集
export interface FilteredSearch { hits: KbChunk[]; scanned: number; exposedToReranker: string[] }
export function searchFiltered(chunks: KbChunk[], query: string, s: Session,
  o: { k: number; ef: number; mode: 'post' | 'pre' | 'iterative'; maxScan: number }): FilteredSearch  // TODO-3 ★★ iterative
export function rerankPipeline(cands: KbChunk[], s: Session, order: 'filter-first' | 'rerank-first',
  reranker: (q: string, texts: string[]) => number[], query: string): FilteredSearch             // TODO-4 ★
export function buildSearchRequest(toolArgs: Record<string, unknown>, s: Session): { knn: { filter: unknown }; query: string; k: number }  // ACL 字段在 toolArgs 里 → throw
export function tenantBm25(chunks: KbChunk[], scope: 'shared' | 'per-tenant'): (q: string, s: Session, k: number) => { id: string; score: number }[]

// ── 版本 & 同步
export function resolveVersions(cands: KbChunk[], asOf: string): { chosen: string | null; conflict: boolean; reason: string }  // TODO-5 ★★
export type SyncMode = 'none' | 'incremental' | 'full' | 'tombstone'
export function applySync(index: KbChunk[], batch: KbChunk[], tombstones: string[], mode: SyncMode): KbChunk[]   // TODO-6 ★
export function planReindex(oldDoc: ParsedDoc | null, newDoc: ParsedDoc | null, oldGen: Gen, newGen: Gen):
  { reparse: boolean; rechunk: boolean; reembed: boolean; payloadOnly: boolean; deleteAll: boolean }
export function assertSingleEmbedder(hits: KbChunk[]): void                // 混代 → throw

// ── 缓存 & 门禁
export function cacheKey(query: string, principals: string[], corpusVersion: string): string   // TODO-7 ★
export function qualityGate(doc: ParsedDoc): { pass: boolean; issues: string[] }
```

设计取舍：
- **向量**：继续用 `fakeEmbed`（字符三元组哈希），ANN 用「精确排序取前 ef」近似——§11.2 已说明这只会让后过滤**看起来更好**，因此观察结论是保守的。
- **`searchFiltered` 返回 `scanned` 和 `exposedToReranker`**：让「代价」与「泄露」成为可断言的输出，而不是只看 hits。
- **所有日期是 `YYYY-MM-DD` 字符串**，比较用字典序（两语言一致，避免时区）。
- **`principalKey` 统一小写**（Onyx 同款），断言大小写变体映射到同一 key。

### 9.3 学生 TODO（7 个）

| # | 函数 | 难度 | 「看起来对但错」的典型实现 | 钉住 |
|---|---|---|---|---|
| TODO-1 | `headingLevel` | ★ | 用 `\d` 匹配编号（Python 能过全角，TS 不能）；把「1. 适用范围」和 Markdown 列表混为一谈；不识别「（一）」 | INV-11 INV-12 |
| TODO-2 | `renderTableRows` | ★★ | 只用 `headerRows[0]`（RAGFlow 现状）；「合计」行丢列名；caption 不带进行文本 | INV-8 INV-9 |
| TODO-3 | `searchFiltered` 的 `iterative` | ★★ | 扩大 ef 后**重新从头取 k**但忘了 maxScan 上限（无限扫描）；或返回不足 k 时静默补入越权结果 | INV-14 |
| TODO-4 | `rerankPipeline` 的 `filter-first` | ★ | 先 rerank 再过滤（结果一样，`exposedToReranker` 不为空） | INV-19 |
| TODO-5 | `resolveVersions` | ★★ | 按 `mtime` 或 `issued` 取最新；忽略 `effectiveFrom > asOf`；对「新的一般 vs 旧的特别」硬选一个 | INV-33 |
| TODO-6 | `applySync` 的 `tombstone` | ★ | 用 incremental 语义（整篇删除残留）；用 full 语义（部分批次误删） | INV-29 INV-30 |
| TODO-7 | `cacheKey` | ★ | key 不含 principals（跨用户串答案）；principals 不排序去重（同权限不同 key）；不含 corpusVersion（撤权后命中旧答案） | INV-26 |

### 9.4 观察实验（`labs/l09x/explore.{ts,py}`，输出两语言逐字节一致）

| EXP | 打印什么 | 揭示 |
|---|---|---|
| EXP-1 解析坑 | `budget-2025` 的块列表：页眉残留行、脚注是否被保留、`page index0` vs 印刷页码 | INV-5 INV-6 |
| EXP-2 表格切法 | 三种切法 × 查询「研发部 2025年 金额」：top1、是否含列名（§11.2 EXP-B 的扩展：加两级表头） | INV-8 INV-9 |
| EXP-3 切词 | L09 `tokenize` vs `normalizeText` 后再切，对「第３条」「（２）」「２０２５年」「\uFEFF第一章」 | INV-10 INV-11 |
| EXP-4 过滤位置 | 选择率 50/10/2/0.5% × post/pre/iterative/rerank-first：平均返回、最少、recall@10、外发越权数（§11.2 EXP-A） | INV-14 INV-15 INV-19 |
| EXP-5 租户统计 | shared vs per-tenant 统计，`globex` 文档数 0/10/50 时 `acme` 的排序（§11.2 EXP-D） | INV-24 |
| EXP-6 版本消解 | 6 场景 × 3 策略的判决表（§11.2 EXP-E） | INV-33 |
| EXP-7 删除传播 | 4 种同步模式 × 3 轮（§11.2 EXP-F）+ 「删 30 篇后 BM25 统计量是否回到重建值」 | INV-29 INV-30 INV-31 |
| EXP-8 门禁矩阵 | 4 份故意坏掉的解析结果 × 6 项检查：谁抓住了谁（每份恰好一项） | §6.3 |

## 10. verify 断言清单（56 条，TS 与 Python 同数同序）

> 每条形如 `check('<ID>', 条件)`。「反例」= 这条断言专门要抓的「看起来对但错」的实现。所有断言只用 §9.1 的固定数据，零模型。

**PARSE（6）**
1. `PARSE-1` `detectRunningLines(travel-2023)` 含「青禾科技 内部资料」——反例：只看第 0 页。INV-6
2. `PARSE-2` 同一字符串只在 2 页出现时**不**被判为页眉（`minPages=3`）——反例：出现 ≥2 次就删，误删正文小标题
3. `PARSE-3` `chunkDocument` 的输出中不含页眉文本——反例：检测了但没删
4. `PARSE-4` 脚注「① 不含外包」出现在预算表所在 chunk 的文本里——反例：沿用默认丢弃脚注。INV-6
5. `PARSE-5` `budget-2025` 跨页表格生成的 chunk `pages = [2, 3]`——反例：只记第一页。INV-5
6. `PARSE-6` `normalizeText('\uFEFF第一章')` 以「第」开头——反例：只做 NFKC 不去 BOM（Python 下失败、TS `trim` 下侥幸通过）。INV-11

**NUM（6）**
7. `NUM-1` `headingLevel('第十二条 适用范围')` → 条级——反例：只认阿拉伯数字
8. `NUM-2` `headingLevel('（一）总则')` 与 `headingLevel('(一)总则')` 同级——反例：不做 NFKC。INV-12
9. `NUM-3` `headingLevel('１、总则')` = `headingLevel('1、总则')`——反例：TS 里用 `\d`。INV-11
10. `NUM-4` 层级序：「一、」<「（一）」<「1.」<「（1）」（GB/T 9704 序）——反例：按字符长度判层级。INV-12
11. `NUM-5` `headingLevel('1.1.2 小节')` 深于 `headingLevel('1.1 节')`——反例：只看第一个数字
12. `NUM-6` `headingLevel('2025年预算增长10%。')` 为 `null`——反例：「数字开头即编号」。

**TABLE（6）**
13. `TABLE-1` `renderTableRows` 的每一行都含所有列名——反例：只有第一行带表头。INV-8
14. `TABLE-2` 两级表头渲染为「2025年/金额」与「2025年/占比」两个不同列名——反例：只取 `headerRows[0]`（RAGFlow 现状）。INV-9
15. `TABLE-3` 「合计」行也带列名——反例：把合计行当作页脚丢弃或不带列名
16. `TABLE-4` 每行文本含 caption「表3 各部门预算」——反例：caption 只在第一行
17. `TABLE-5` 查询「研发部 2025年 金额」BM25 top1 是研发部那一行且含「2025年/金额: 1200」——反例：定长切分。INV-8
18. `TABLE-6` 表格行 chunk 的 `kind === 'table_row'` 且行数 = 数据行数（不含表头行）——反例：表头行也成了一个 chunk

**ACL（14）**
19. `ACL-1` `aclVisible` 对缺 `acl` 的 chunk 返回 false——反例：fail-open（RAGFlow `PruneDeletedChunks` 的做法）。INV-38
20. `ACL-2` `principalKey('group','alice@qinghe.com') !== principalKey('user','alice@qinghe.com')`——反例：无前缀。§7.1
21. `ACL-3` `principalKey('user','Alice@Qinghe.com') === principalKey('user','alice@qinghe.com')`
22. `ACL-4` bob 的 `pre` 搜索结果中没有 `hr-salary` 的 chunk
23. `ACL-5` 2% 选择率、`post` 模式下返回条数 < k（**证明后过滤会少**，防止有人把 post 实现成 pre）。INV-14
24. `ACL-6` 同条件 `pre` 模式返回 = k
25. `ACL-7` `iterative` 返回条数 ≥ `post` 且 `scanned ≤ maxScan`——反例：无上限扩张。INV-14
26. `ACL-8` `iterative` 的结果全部对该用户可见——反例：不足 k 时补入越权结果
27. `ACL-9` `rerankPipeline(filter-first).exposedToReranker` 中每段文本都对该用户可见。INV-19
28. `ACL-10` `rerank-first` 与 `filter-first` 的 **hits 相同**但 `exposedToReranker` 不同——**这条断言证明「结果一样」不能当作「安全一样」**。INV-19
29. `ACL-11` `buildSearchRequest({query, filter:{}}, s)` 抛错；`{query, user_groups:['hr']}` 抛错；`{query, doc_ids:[…]}` 抛错。INV-28
30. `ACL-12` `buildSearchRequest` 的 ACL 出现在 `knn.filter` 内，而不是外层——反例：放在外层 bool（后过滤）。INV-17
31. `ACL-13` `visibleToAll(chunk, [alice, bob])` 对 `hr-salary` 为 false，尽管 alice 单独可见。INV-21
32. `ACL-14` 字段级：bob 视图下 `hr-salary` 的渲染文本不含「月薪」列的值，**且**以该值为查询的 BM25 不命中任何 bob 可见 chunk（存在性泄露）。INV-22

**TENANT（3）**
33. `TENANT-1` `per-tenant` 下 carol（globex）的结果里没有 acme 文档（基础隔离）
34. `TENANT-2` `shared` 统计下，加入 globex 10 篇文档后 acme 的 top1 改变；`per-tenant` 下不变。INV-24
35. `TENANT-3` `per-tenant` 下 acme 的分数与「只用 acme 文档单独建索引」逐位相等（用 `fmtFixed(score, 6)` 比）

**VER（8）**
36. `VER-1` S1：选 2025 版
37. `VER-2` S2（新版未生效）：asOf=2026-10-12 选 2025 版；asOf=2027-01-01 选 2026 版——反例：按 issued/mtime。INV-33
38. `VER-3` S3（旧版被重新编辑，mtime 最新）：仍选 2025 版——反例：按 mtime
39. `VER-4` S4：选上位「集团制度」，`conflict=true`（下位冲突需标注）
40. `VER-5` S5（新的一般 vs 旧的特别）：`chosen=null`、`conflict=true`——反例：硬选一个。INV-33
41. `VER-6` S6（已废止）：不选被废止版本
42. `VER-7` 缺 `effectiveFrom` 的文档不参与自动消解（进入 `reason`）——反例：当作「永远有效」
43. `VER-8` `assertSingleEmbedder` 对混入 `embedder:'v1'` 与 `'v2'` 的结果抛错。INV-35

**SYNC（6）**
44. `SYNC-1` `none` 模式三轮后仍含已删文档 C（证明默认不删）。INV-29
45. `SYNC-2` `incremental` 三轮后仍含 C（整篇删除残留）。INV-30
46. `SYNC-3` `full` 在第 3 轮（批次缺 B）后丢了 B（误删）。INV-30
47. `SYNC-4` `tombstone` 三轮后：无 C、有 B、A 只有新版
48. `SYNC-5` `planReindex` 仅 ACL 变化 → `payloadOnly=true, reembed=false`——反例：把 ACL 放进内容 hash。INV-32
49. `SYNC-6` `planReindex` parser 版本变化 → `reparse=true`；embedder 变化 → `reembed=true, reparse=false`。INV-7 INV-35

**CACHE（3）**
50. `CACHE-1` alice 与 bob 同一 query 的 `cacheKey` 不同。INV-26
51. `CACHE-2` principals `['group:hr','user:a']` 与 `['user:a','group:hr','group:hr']` 的 key 相同（排序去重）
52. `CACHE-3` 撤销 alice 的 `group:hr` 后 key 改变；`corpusVersion` 变化后 key 改变

**GATE + CITE（4）**
53. `GATE-1` `qualityGate(legacy-notice)` 的 issues 含「缺 acl」与「缺 effectiveFrom」
54. `GATE-2` 4 份坏文档 × 6 项检查的矩阵中，每份坏文档**恰好**被 1 项抓住、好文档 0 项（证明检查不冗余、不误报）
55. `CITE-1` `citeLocator` 对 `pages=[0,0]` 且无印刷页码显示「第 1 页」；有印刷页码「ii」时显示「p. ii」。INV-5
56. `CITE-2` 跨页 chunk 显示范围「pp. 3–4」（index0 = 2–3 且无印刷页码时）——反例：只显示首页

**「不是构造即真」的自检**：ACL-5、ACL-10、SYNC-1/2/3、TENANT-2 是「反向断言」，断言**错误策略**确实产生可观测后果。若有人把 post 模式偷偷写成 pre，ACL-5 就会失败——这保证观察实验的表格不是摆设。

## 11. 本地实测

### 11.1 `[O]` pgvector 0.8.1 真机：ACL 写成 WHERE，HNSW 返回几条

**环境**：本机 Postgres.app，`PostgreSQL 18.3 (Postgres.app) on aarch64-apple-darwin23.6.0`，`pgvector 0.8.1`；临时集群 `/tmp/l09x/pg`，端口 54329（实验后已停）。
**数据**：50,000 行，32 维 `random()` 向量（`setseed(0.42)`），`vector_l2_ops` HNSW 索引（默认 m/ef_construction）；四种过滤列：`grp10`（每组 10%）、`grp100`（1%）、`grp1000`（0.1%）、`acl int[]`（每行两个组，查询 `acl && '{7,142}'` 命中 1,000 行 = 2%，GIN 索引）。20 个固定查询向量（`setseed(0.7)`），`LIMIT 10`。「召回@10」以 `SET LOCAL enable_indexscan = off` 的精确结果为真值。

**默认值确认**（`LOAD 'vector'` 后 `SHOW`）：`hnsw.ef_search = 40`，`hnsw.iterative_scan = off`，`hnsw.max_scan_tuples = 20000`。→ 证实 §4.1 的推断：**0.8.x 默认不开 iterative scan**。

**脚本**：`/tmp/l09x/pgv_exp.sql`（建表）+ `/tmp/l09x/pgv_run.py`（只依赖 `psql` 命令行）。核心查询：

```sql
BEGIN; SET LOCAL hnsw.iterative_scan = off;
SELECT id FROM chunks WHERE acl && '{7,142}' ORDER BY emb <-> '[...]' LIMIT 10;
COMMIT;
```

**输出**（加了过滤列 B-tree/GIN 索引之后的那一轮；不加索引时前三组数字完全相同）：

```text
过滤              选择率   模式            平均返回 最少返回 召回@10  计划
acl && '{7,142}'  约 2%   exact             10.0     10   1.000  Bitmap Index Scan on chunks_acl_idx
acl && '{7,142}'  约 2%   off(默认)          0.6      0   0.055  Index Scan using chunks_emb_idx
acl && '{7,142}'  约 2%   strict_order      10.0     10   0.920  Index Scan using chunks_emb_idx
acl && '{7,142}'  约 2%   relaxed_order     10.0     10   0.985  Index Scan using chunks_emb_idx
grp10 = 3         约 10%  exact             10.0     10   1.000  Bitmap Index Scan on chunks_grp10_idx
grp10 = 3         约 10%  off(默认)          3.8      1   0.375  Index Scan using chunks_emb_idx
grp10 = 3         约 10%  strict_order      10.0     10   0.800  Index Scan using chunks_emb_idx
grp10 = 3         约 10%  relaxed_order     10.0     10   0.915  Index Scan using chunks_emb_idx
grp100 = 7        约 1%   exact             10.0     10   1.000  Bitmap Index Scan on chunks_grp100_idx
grp100 = 7        约 1%   off(默认)          0.5      0   0.045  Index Scan using chunks_emb_idx
grp100 = 7        约 1%   strict_order      10.0     10   0.965  Index Scan using chunks_emb_idx
grp100 = 7        约 1%   relaxed_order     10.0     10   1.000  Index Scan using chunks_emb_idx
grp1000 = 13      约 0.1% exact             10.0     10   1.000  Seq Scan on chunks
grp1000 = 13      约 0.1% off(默认)         10.0     10   1.000  Seq Scan on chunks
grp1000 = 13      约 0.1% strict_order      10.0     10   1.000  Seq Scan on chunks
grp1000 = 13      约 0.1% relaxed_order     10.0     10   1.000  Seq Scan on chunks
```

`EXPLAIN` 显示规划器对 `acl && '{7,142}'` 的行数估计是 `rows=1010`（真实 1000）——**估得很准，但仍然选了 HNSW**。

**读法**：
1. 10% 选择率下默认返回平均 **3.8** 条——和 README 的 "only 4 rows will match on average" 吻合（README 是理论值，这里是实测）。`[O]` + `[P]`
2. **危险区在中间，不在两端**：0.1% 时规划器切到顺序扫描（精确），反而全对；1%–2% 时默认路径平均返回 **0.5–0.6** 条、**最少 0 条**。一个 100 人部门里的员工（ACL 选择率 1%）会稳定地得到「检索不到相关内容」——而 L09 §五刚教过学员这是一个「合法的、经常正确的结论」。`[O]`
3. **「给 ACL 列加索引」不能解决**：加了 B-tree/GIN 之后，规划器在 1%/2%/10% 三档仍然选 HNSW（行数估计准确也没用）。这和 README "A good place to start is creating an index on the filter column" 的期望不一致——至少在 5 万行、32 维这个规模上。`[O]`（规模更大时规划器选择可能不同，未测）
4. `strict_order` 返回够 10 条但召回只有 0.80–0.97；`relaxed_order` 更高（0.915–1.000）。和 README "Relaxed allows results to be slightly out of order by distance, but provides better recall" 一致。`[O]` + `[P]`
5. **零安全事故**：所有模式都没有返回越权行。这正是这个失败难被发现的原因：**安全审计全绿，召回塌缩只能靠「按身份分层」的检索评测发现**（§6.2）。

### 11.2 `[O]` 零依赖 TS + Python 双实现：六个观察实验原型（逐字节一致）

脚本：`/tmp/l09x/sim/sim.ts`（`node --experimental-strip-types sim.ts`，Node v22.19.0）与 `/tmp/l09x/sim/sim.py`（Python 3.13.13）。tokenizer 原样复制自 `labs/shared/retrieval.{ts,py}`，BM25 与 L09 同式。

```text
$ node --experimental-strip-types sim.ts > out_ts.txt; python3 sim.py > out_py.txt
$ cmp out_ts.txt out_py.txt && echo BYTE-IDENTICAL
BYTE-IDENTICAL
$ shasum -a 256 out_ts.txt out_py.txt
fdcee6849774bebde10e25650ed708c4973f532ecdf746b11e5d8b5a04b5dcfe  out_ts.txt
fdcee6849774bebde10e25650ed708c4973f532ecdf746b11e5d8b5a04b5dcfe  out_py.txt
```

为了逐字节一致而做的四件事（可直接写进 lab 规范）：
- 随机数：Park–Miller minstd（`x*48271 % 2147483647`，乘积 < 2^53，JS double 精确）；
- 小数：一律整数运算后拼字符串（`permille`、`tenths`、`floor(score*1000)`），**不用** `toFixed` / `round` / `f"{:.1f}"`；
- Python 去重用 `dict.fromkeys`（保序），**不用** `set()`——查询词的迭代顺序决定 BM25 浮点求和顺序；
- 排序永远带 tie-break（`(-score, id)`）；中英混排对齐用「非 ASCII 记宽 2」的同一规则。

完整输出（两语言相同）：

```text
== EXP-A  ACL 写在 ANN 之后：返回条数与 recall@10（N=4000, dim=8, ef=40, 20 个查询）==
选择率  策略            平均返回  最少  recall@10  越权文本外发
50%     post-filter           10    10     100.0%             0
50%     pre-filter            10    10     100.0%             0
50%     iterative             10    10     100.0%             0
50%     rerank-then-acl       10    10     100.0%           401
10%     post-filter          4.3     1      43.5%             0
10%     pre-filter            10    10     100.0%             0
10%     iterative             10    10     100.0%             0
10%     rerank-then-acl      4.3     1      43.5%           713
2%      post-filter          0.6     0       6.0%             0
2%      pre-filter            10    10     100.0%             0
2%      iterative            7.2     3      72.0%             0
2%      rerank-then-acl      0.6     0       6.0%           788
0.5%    post-filter          0.1     0       1.0%             0
0.5%    pre-filter            10    10     100.0%             0
0.5%    iterative            1.5     0      15.0%             0
0.5%    rerank-then-acl      0.1     0       1.0%           798

== EXP-B  表格切法：查询「研发部 2025年 预算」==
策略              chunk数  top1      含研发部    含1200     能否判断 1200 属于 2025
定长40字·无表头        3  fixed#0   否          否         不能
按行·带列名            6  row#1     是          是         能
按行·无列名            6  bare#1    是          是         不能

== EXP-C  公文里的全角数字：L09 tokenizer vs NFKC 后再切 ==
第３条   L09: [第,条]  NFKC: [第,3,条]
（２）   L09: []  NFKC: [2]
２０２５年 L09: [年]  NFKC: [2025,年]
查询        切词    排序（id:score×1000 取整）
第3条 差旅  L09     第５条:1888  第３条:1760  第十三条:1527
第3条 差旅  NFKC    第３条:2938  第５条:1877  第十三条:1550
（2） 发票  L09     （２）:4124
（2） 发票  NFKC    （２）:5451

== EXP-D  共享索引 + tenant 过滤 vs 每租户统计：租户 A 搜「报销 发票」==
B 租户文档数  统计口径    租户 A 的排序（id:score×1000 取整）
0             共享索引    A1:6553  A2:3208
0             每租户      A1:6553  A2:3208
10            共享索引    A2:6944  A1:3633
10            每租户      A1:6553  A2:3208
50            共享索引    A2:10829  A1:4170
50            每租户      A1:6553  A2:3208

== EXP-E  版本消解：asOf=2026-10-12，三种策略各选哪一版 ==
场景                  按 mtime 最新   按生效日(asOf)    三维规则
S1 新版已生效         办法2025        办法2025          办法2025
S2 新版未生效         办法2026        办法2025          办法2025
S3 旧版被重新编辑     办法2023        办法2025          办法2025
S4 上位 vs 下位       子公司细则      子公司细则        集团制度（上位优先，下位冲突需标注）
S5 同级特别 vs 一般   公司差旅办法    公司差旅办法      CONFLICT（新的一般 vs 旧的特别，交人裁决）
S6 已废止             办法2025        暂行规定          暂行规定

== EXP-F  三轮同步后索引里剩下什么（LangChain cleanup 语义的复刻 + 墓碑）==
模式         第2轮后               第3轮后               问题
None         A:a1,A:a2,B:b1,C:c1   A:a1,A:a2,B:b1,C:c1   A 旧版残留、已删 C 残留
incremental  A:a2,B:b1,C:c1        A:a2,B:b1,C:c1        已删 C 残留
full         A:a2,B:b1             A:a2                  B 被误删
tombstone    A:a2,B:b1             A:a2,B:b1             无
```

**读法**：
- **EXP-A**：用「精确排序前 ef 个」代替 HNSW 候选只会让后过滤**显得更好**；即便如此，10%/2% 选择率下平均只返回 4.3/0.6 条，与 §11.1 真机（3.8/0.6）同量级；迭代扫描受上限 400（对应 `hnsw.max_scan_tuples`）约束，0.5% 时只拿回 1.5 条。「先外部 rerank 再 ACL」在 2% 时共外发 **788 段越权文本**，最终结果却与后过滤相同。
- **EXP-B**：定长切分的 top1 是**表头块**（「2025年预算」在表头里），既无「研发部」也无「1200」；按行无列名时无法判断 1200 属于哪年。只有「按行 + 列名」能答。
- **EXP-C**：L09 tokenizer 的两个字符类都不含 U+FF10–FF19，全角数字被**整个丢掉**：「第３条」只剩「第、条」，查「第3条 差旅」时第５条（更短）排在第３条前面；「（２）」切出空列表。先 NFKC 再切即可修复。
- **EXP-D**：加 10 篇**另一个租户**的含「报销」文档，租户 A 的排序就翻转（A1 → A2），即使结果按 tenant 过滤过。
- **EXP-E**：按 mtime 在 S2/S3 选错（未生效的新版、被重新编辑的旧版）；按生效日在 S4/S5 选错（不懂上位/特别）；三维规则在 S5 正确地**拒绝自动裁决**（立法法第一百零五条的情形）。
- **EXP-F**：与 §5.1 的 LangChain 文档语义一一对应：`None` 什么都不删；`incremental` 删不掉整篇被删的 C；`full` 在 loader 部分失败时误删 B；只有显式墓碑同时满足两点。

### 11.3 `[O]` 跨语言字符串陷阱（lab 作者必读）

```text
$ node probe.mjs                      $ python3 (同等代码)
lt true len 2 [...] 1                 lt false len 1 [...] 1
sorted 中|𠮷野家|｀x                   sorted 中|｀x|𠮷野家
ws true true true false               ws false true true false
split ["a","b","c","d"]               split ["a\ufeffb", "c", "d"]
trim "标题"                            trim "\ufeff标题"
```

（探针：`'𠮷' < '｀'`；`.length`；`sorted`；`/\s/` 对 U+FEFF、U+3000、U+00A0、U+200B；`split(/\s+/)`；`'\uFEFF标题\u3000'.trim()` vs `.strip()`。）

1. **JS 字符串比较是 UTF-16 码元序，不是码点序**。`𠮷`（U+20BB7，日本人名/店名常用，中文生僻人名也会用到扩展 B 区）在 JS 里排在 `｀`（U+FF40）前面，Python 里排在后面。仓库里的 `cmpCodePoint`（`labs/shared/codingEval.ts:402`）实现是 `a < b`——**对 BMP 外字符并不是码点序** `[L]`+`[O]`。kb lab 的假数据要么避开扩展区汉字，要么 `cmpCodePoint` 改为逐码点比较（这属于改共享代码，留给 lab 作者决定）。
2. 同一字符串 `.length` 2 vs 1 → 按字符数切块时两边**切点不同**。
3. **BOM（U+FEFF）**：JS `\s` 和 `trim()` 认它是空白，Python 不认。从 Word/Excel 导出的文本常带 BOM，`"\uFEFF第一章 总则"` 在 JS 里 `trim()` 后能被 `^第.+章` 匹配，在 Python 里 `strip()` 后**不能**。kb lab 的标题检测应先显式 `replace('\uFEFF', '')` 再 NFKC。
4. L09 的 Python `_CAMEL = re.compile(r"([a-z\d])([A-Z])")` 对「１A」会插入空格而 TS 不会（`\d` 差异，§3.3）——对现有输出无影响，但是潜伏差异 `[L]`。

## 12. Top 5 最承重的反转

1. **INV-14（含 15/16）ACL 写成 WHERE：安全，但召回静默塌缩。** pgvector 真机：10% 选择率平均返回 3.8 条，1–2% 时 0.5–0.6 条、最少 0 条；加索引不改计划。L09 教过「检索为空是合法结论」，这条说明空结果也可能是**过滤位置错了**。权限部分的锚点，也是最好的面试追问。
2. **INV-19 「结果一样」≠「安全一样」。** 先 rerank 后过滤与反过来 hits 完全相同，但前者外发了 788 段越权全文。安全边界是**数据流向**，不是最终答案；由此引出缓存、trace、多人会话等「权限副本」（INV-21/25/26），接 L14「通道」。
3. **INV-29/30 删除不会自己传播。** 两大框架默认不删；incremental 删不掉整篇删除；full 在 loader 部分失败时误删；RAGFlow 查询时 `PruneDeletedChunks` 兜底本身就是证据。删除要靠**显式墓碑**。
4. **INV-33/34 「最新版优先」既不完整也不安全。** 三维优先序（上位、特别、新）且有一种冲突规则无法裁决（立法法第一百零五条）；ClashEval 显示模型会采纳「像真的」错误上下文。版本消解必须在检索层按 `asOf` 做，冲突要显式交出去。
5. **INV-10/11 L09 tokenizer 与「两语言一样」的假设在公文上同时失效。** 全角数字被丢弃（第５条排到第３条前面）；`\d`、BOM、UTF-16 比较三处跨语言差异。对一门要求 TS/Python 逐字节一致的课，这既是内容也是 lab 工程约束。（次席：INV-8/9 表格切法。）

## 13. 建议的课时主题（5 个，对暂定主题做了调整）

1. **解析是静默失效，坐标是契约**（INV-1–7）。证据：OmniDocBench 与 olmocr-bench 互相矛盾、OHRBench、MinerU/Marker/PP-StructureV3 的默认值。保留暂定的「解析与版面」，加入页码契约和「升级要重解析」。
2. **结构要跟着每个 chunk 走**（INV-8–13）。证据：EXP-B、EXP-C、RAGFlow `rows[0]`、GB/T 9704、立法法。把「表格不能切断」扩成「结构信息不能丢」，并入中文编号与切词。
3. **过滤放在哪一层**（INV-14–18、24）。证据：pgvector 真机、五家向量库官方语义、EXP-A/D、Onyx 源码。暂定的「权限下推」拆成两讲，这一讲只讲**正确性**。
4. **权限有几份副本**（INV-19–23、25–28）：外部 rerank、缓存、trace、多人会话、字段级、工具参数、同步延迟。证据：Cohere API、RedisVL、OTel、vec2text、OrgAccess、Position paper、Onyx、Copilot。新增：一手证据最密、面试最常问、与 L13/L14/L15 衔接最多。
5. **没有 commit 的语料**（INV-29–38）：墓碑、统计量里的幽灵、索引的「代」、三维版本消解，收尾讲身份 × 时点分层评测和入库门禁。证据：LangChain/LlamaIndex 源码、ES/Dify 文档、立法法、ClashEval、EXP-E/F。暂定的「版本与冲突」和「入库质量门禁」合并，因为门禁阈值没有一手数字（§14），撑不起单独一讲。

## 14. 无一手来源的说法清单

以下内容在报告中出现过，但**本轮没有找到一手来源**，或只有二手线索 / 推断。讲稿引用时应注明，或者先补证据。
1. **质量门禁的所有阈值**（§6.3）：都是建议值，没有任何一手数字。
2. **CommonMark 有序列表与「1.」编号冲突**（§3.3）：标为 `[S]`，未读规范原文。
3. **GB/T 9704-2012 原文**：官方只提供扫描件，四级编号序来自转述 `[P2]`。
4. **Milvus 默认一致性级别与删除可见性**：一致性文档各候选路径均 404，未核实。
5. **Docling / Unstructured 在 OmniDocBench v1.5 以后的分数**：README 未列，只有 v1.0 数字。
6. **Dify 换 embedding 模型期间的检索中间态**：文档未说明。
7. **RAGFlow 文档级权限是否在检索时执行**：文档提到 "document-level Read, Write, or Manage permission"，但 CE 代码 `ResourceKind` 只有 dataset/canvas/agent_session，未核实。
8. **Onyx / Dify 的 PDF 解析路径**：未读源码。
9. **LlamaParse**：未读一手文档（托管、数据驻留、坐标输出），不做断言。
10. **vec2text 对中文 / BGE 类模型的可迁移性**：论文只测英文与 GTR/ada-002。
11. **rerank 服务对输入的留存策略**：未读数据政策；§4.4 只依据 API 形状推断。
12. **pgvector 更大规模下的规划器选择**：只测了 5 万行、32 维。
13. **「企业制度普遍仿照立法法优先序」**：推断，无来源。
14. **撤权延迟中的任务排队时间**：只有配置默认值，无实测。
15. **ColPali / ColQwen 的中文效果**：训练集只有英文，中文数字未找到。
16. **Elastic 博客对 Lucene 删除机制的解释**：`[S]`；正文结论只用 ES 官方文档。
17. **Qdrant 按租户分片（user-defined sharding）**：未读原文。
18. **PP-StructureV3 / Unstructured / Docling 的系统能力对比（原计划 §2.5）**：未完成，只核实了 §2–§3 引用的默认值。

## 15. 来源索引（访问日期均为 2026-10-12；完整 URL 在正文引文处）

**解析**（§2–§3）：OmniDocBench README（main / v1_5 / v1_0 分支）·OHRBench arXiv 2412.02592 ·ColPali arXiv 2407.01449 ·MinerU README 与 output_files 文档 ·Marker README ·Docling chunking 文档 ·PP-StructureV3 文档（paddleocr.ai）·Unstructured chunking 文档

**向量库过滤**（§4.1–4.2、§5.2）：pgvector README/CHANGELOG ·Qdrant indexing、multitenancy ·Elasticsearch kNN search、knn query、consistent scoring ·OpenSearch filter-search-knn ·Milvus docs v2.6.x `filtered-search.md`

**权限与安全**（§4.3–4.9）：Azure AI Search security trimming ·M365 Copilot privacy ·OWASP LLM08:2025 ·vec2text arXiv 2310.06816 ·OrgAccess arXiv 2505.19165 ·ARBITER arXiv 2512.20535 ·Participant-aware AC arXiv 2509.14608 ·Cohere Rerank v2 API ·RedisVL SemanticCache API ·OTel `semantic-conventions-genai` gen-ai-spans

**版本与索引**（§5）：LangChain `langchain_core/indexing/api.py` ·LlamaIndex `llama_index/core/ingestion/pipeline.py`（均为 GitHub main）·Dify 企业版 3.9.x 与云版知识库设置文档 ·立法法 2023（国家税务总局政策法规库）·科技部规章制定程序规定（gov.cn）·GB/T 9704 高校转载（`[P2]`）·ClashEval arXiv 2404.10198

**开源项目源码**（本机 sparse clone）：Onyx `d6f2ee0`（`backend/onyx/document_index/opensearch/search.py`、`backend/onyx/access/`、`backend/ee/onyx/configs/app_configs.py`、`backend/ee/onyx/external_permissions/post_query_censoring.py`、`backend/onyx/context/search/retrieval/search_runner.py`）·RAGFlow `489d0b4`（`internal/ingestion/component/chunker/table.go`、`internal/service/nlp/retrieval.go`、`internal/permission/types.go`；文档 https://ragflow.io/docs/guides/team/permission_system_overview/permission_effective_rules ）·Dify `f225852`（`api/models/enums.py`、`api/core/rag/datasource/retrieval_service.py`、`api/core/rag/retrieval/dataset_retrieval.py`）

**本地仓库** `[L]`：`labs/shared/retrieval.{ts,py}`（`tokenize`、`bm25Index`）、`labs/shared/codingEval.ts`（`cmpCodePoint`、`fmtFixed`）、`src/lessons/L09|L12|L14/content.mdx`

**本报告自产** `[O]`：`/tmp/l09x/pgv_exp.sql`、`/tmp/l09x/pgv_run.py`、`/tmp/l09x/pgv_out_*.txt`（pgvector 0.8.1 真机）；`/tmp/l09x/sim/sim.ts`、`sim.py`、`out_ts.txt`、`out_py.txt`（逐字节一致，sha256 `fdcee684…`）；`/tmp/l09x/sim/probe.mjs`（跨语言字符串探针）
