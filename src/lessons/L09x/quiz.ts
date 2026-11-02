import type { QuizSpec } from '@/lib/quiz'

export const quiz: QuizSpec = {
  lessonId: 'L09x',
  questions: [
    {
      id: 'acl-as-where',
      kind: 'choice',
      prompt:
        '公司知识库是一个共享的 pgvector 0.8.1 HNSW 索引，参数全是默认值。检索写成 `SELECT id FROM chunks WHERE acl && $1 ORDER BY emb <-> $2 LIMIT 10`。安全审计抽查了 500 次问答，没有一次越权。可是一个只能看全库约 2% 文档的部门反复投诉「明明有这份制度，助手总说检索不到相关内容」。最可能的原因和修法是？',
      options: [
        {
          id: 'a',
          label:
            '过滤发生在 HNSW 扫完 `ef_search=40` 个候选之后，2% 选择率下平均只剩 0.6 条、最少 0 条。安全没问题，召回塌了；打开 `hnsw.iterative_scan`（relaxed_order）或按部门分区，并用按身份分层的检索评测去盯',
        },
        {
          id: 'b',
          label: '`acl` 列没有索引，规划器估错了行数才走了 HNSW；给它建一个 GIN 索引，规划器就会改走位图扫描',
        },
        {
          id: 'c',
          label: '升级到 0.8 之后迭代扫描已经默认打开，所以召回不会塌；问题在 prompt，模型过于保守地拒答',
        },
        {
          id: 'd',
          label: '这个部门的文档本来就少，检索不到是合法结论；安全审计全绿说明链路是对的，不用改',
        },
      ],
      correct: ['a'],
      explain: `A。

pgvector README 原文："With approximate indexes, filtering is applied *after* the index is scanned."。调研在本机用 PostgreSQL 18.3、pgvector 0.8.1、5 万行 32 维、默认参数实测：\`acl && '{7,142}'\`（约 2%）平均返回 0.6 条、最少 0 条、recall@10 只有 0.055；打开 \`strict_order\` 是 0.920，\`relaxed_order\` 是 0.985。所有模式都没有返回越权行，所以安全审计必然全绿。

B 错：实测时过滤列已经建了 GIN，规划器对这个条件估计 1,010 行（真实 1,000），估得很准，仍然选了 HNSW；有没有过滤列索引，前三组数字完全相同。

C 错：\`SHOW\` 出来是 \`hnsw.iterative_scan = off\`。0.8 提供了迭代扫描，但不改配置就不会生效。

D 错：「检索不到相关内容」是合法结论（L09），前提是检索本身是对的。这里空结果来自过滤放错了层，不是语料里没有。安全审计只看越权，看不到召回，这正是这种失败能上线的原因。

对应讲义第三节 3.1、3.2；断言 ACL-5、ACL-7。注意实测只覆盖 5 万行、32 维，更大规模下规划器怎么选，没有数据。`,
    },
    {
      id: 'knn-filter-position',
      kind: 'choice',
      prompt:
        '同一个 ACL 条件，在 Elasticsearch 里写成两种：甲是 `bool: { must: { knn: {...} }, filter: { terms: { acl: [...] } } }`；乙是把同一个 `terms` 写进 `knn` 子句自己的 `filter`。下面哪个说法对？',
      options: [
        { id: 'a', label: '两种写法等价：ES 会把 bool 里的 filter 下推到近似搜索里，结果一样' },
        {
          id: 'b',
          label:
            '甲是后过滤：knn 先找出 k 个最近的，再拿 terms 过滤，最后可能远少于 k 条；乙在近似搜索时就过滤。两者安全性相同，召回不同',
        },
        { id: 'c', label: '甲会把越权文档返回给用户，因为外层 filter 只影响打分，不影响命中' },
        { id: 'd', label: '甲的问题调大 `num_candidates` 就能根治，不用改查询结构' },
      ],
      correct: ['b'],
      explain: `B。

ES 文档原文："All other filters found in the Query DSL tree are applied as post-filters. For example, \`knn\` query finds the top 3 documents with the nearest vectors (k=3), which are combined with \`term\` filter, that is post-filtered. The final set of documents will contain only a single document that passes the post-filter."。只有写进 \`knn\` 自己的 \`filter\`（或者用带 filter 的 alias）才是前过滤。Onyx 就是这么写的：\`knn_field_query["filter"] = {"bool": {"filter": search_filters}}\`。

A 错：官方文档明说外层的是后过滤，没有自动下推。

C 错：后过滤是安全的。被过滤掉的文档不会出现在结果里，问题是剩下的太少。这和 pgvector 的 WHERE 是同一个形状：安全，召回塌。

D 错：官方给的修法是把过滤写进 knn 子句，不是调候选数。后过滤作用在 knn 已经选出的那 k 个结果上，候选看得再多，通过 ACL 的也只是这 k 个里的一部分。

对应讲义第三节 3.3 的五家对照表；lab 的 \`buildSearchRequest\` 把 ACL 放在 \`knn.filter\`，断言 ACL-12 要求请求外层只有 \`query\`、\`k\`、\`knn\` 三个字段。OpenSearch 同理：knn 子句内的 efficient filtering 是前过滤，外层 bool 和 \`post_filter\` 是后过滤。`,
    },
    {
      id: 'tenant-stats',
      kind: 'choice',
      prompt:
        'SaaS 知识库的所有租户共用一个 BM25 索引，每次查询都带 `tenant_id` 过滤。acme 租户发现：自己的文档一篇没改，搜「报销 发票」的排序却变了；结果里没有任何别的租户的文档。最准确的解释是？',
      options: [
        { id: 'a', label: '`tenant_id` 过滤有 bug，globex 的文档混进了 acme 的候选集' },
        {
          id: 'b',
          label:
            '过滤隔离的是结果，不是统计量。IDF、平均长度按整个索引算，globex 写进来的「报销」文档改变了 acme 的分数；要么按租户算统计量，要么按租户分区',
        },
        { id: 'c', label: 'ANN 本来就有随机性，排序小幅波动是正常的，不用处理' },
        {
          id: 'd',
          label: '在 Qdrant 上不会发生：过滤条件匹配不到点时，它会回退到全 shard 的统计量，排序保持稳定',
        },
      ],
      correct: ['b'],
      explain: `B。

实验五：globex 往共享索引里加 10 篇含「报销」的短文，acme 的第一名就从 A1 换成了 A2（\`A2:6944 A1:3633\`），per-tenant 统计下仍是 \`A1:6553 A2:3208\`。Qdrant 原文："payload-based partitioning alone doesn't isolate IDF statistics"；pgvector 原文："sharing an approximate index between tenants means vectors from one tenant can affect recall (and speed) for other tenants. For tenant isolation, use list partitioning or separate tables."。

A 错：题目已经说了结果里没有别的租户的文档，过滤本身是对的。被污染的是分数。

C 错：这是 BM25，打分是确定性的；lab 里同一组输入每次输出一样，per-tenant 那一列在 0、10、50 篇下完全不变。ANN 的「图是全库的」是另一个问题，也不是随机波动。

D 错：方向反了。Qdrant 文档写的是 "If the corpus filter matches no points, IDF statistics do not fall back to shard-wide statistics. Instead, every term gets the same constant weight, so ranking degenerates to plain TF"。

对应讲义第三节 3.4；断言 TENANT-1 到 TENANT-3（测的是参考实现 \`tenantSearch\`）。调研还推断这是一条统计侧信道，那一条是推断，不是实测。`,
    },
    {
      id: 'rerank-order',
      kind: 'choice',
      prompt:
        '两条检索流水线：甲先按 ACL 过滤，再把剩下的候选发给外部 rerank API；乙先把 top-40 候选全部发给外部 rerank，回来再按 ACL 过滤。回归测试比较 20 个查询的最终 top-k，两条完全相同。哪个结论对？',
      options: [
        { id: 'a', label: '两条等价；乙甚至更好，因为重排器看到了更多上下文' },
        {
          id: 'b',
          label:
            '结果相同，但乙把越权全文发给了第三方：lab 里 2% 选择率、20 个查询一共外发 788 段。安全边界是数据流向，测试要断言发出去的是什么',
        },
        { id: 'c', label: '乙会让越权内容出现在最终答案里，所以测试本该发现差异' },
        { id: 'd', label: '只要 rerank 供应商承诺不留存数据，乙就是安全的' },
      ],
      correct: ['b'],
      explain: `B。

实验四的 rerank-first 一行：2% 选择率下平均返回 0.6 条、recall@10 6.0%，和后过滤一模一样，越权外发 788。ACL-10 断言两种顺序的 hits 完全相同，ACL-9 和 ACL-10 去看 \`exposed\`。Cohere Rerank v2 的接口是 "\`documents\` (list of string, required) — A list of texts that will be compared to the \`query\`."，收的就是全文。

A 错：在过滤之前多看的那些「上下文」，正是用户无权看的文档。重排器多看了，最终答案里一个字也没用上。

C 错：乙在 rerank 之后仍然过滤，越权的不会进答案。正因为结果一样，只看结果的测试永远抓不到它。

D 错：调研没有读到这类服务的数据政策，不能拿它当前提。更根本的是，不变量不依赖对方怎么处理：越权全文已经离开了你的进程。ACL 过滤要在任何「把 chunk 文本交给第三方或模型」的步骤之前。

对应讲义第四节 4.1 和那个 Key；L14 第七节「每一个"过滤"都被绕过了。每一个"移除"都守住了。」在检索链上的版本。`,
    },
    {
      id: 'permission-copies',
      kind: 'choice',
      multi: true,
      prompt:
        '公司的 RAG 已经把 ACL 写进 ANN 内部，安全审计也逐条检查过最终答案。下面哪些做法仍然可能让某个人拿到他无权看的内容？（多选）',
      options: [
        { id: 'a', label: '语义缓存的键是规范化后的 query，命中就直接返回上一次的答案' },
        { id: 'b', label: '为了排查问题，trace 打开了内容捕获，检索 span 上记了每个 chunk 的正文' },
        { id: 'c', label: '群聊里的机器人按提问者的身份检索，群里还有没有 HR 权限的新人' },
        { id: 'd', label: '检索工具的 schema 里有 `user_groups` 参数，由模型根据上下文填写' },
        { id: 'e', label: '版本消解在权限过滤之后、对每个用户分别做' },
        { id: 'f', label: '缓存键包含去重排序后的 principals 和语料版本' },
      ],
      correct: ['a', 'b', 'c', 'd'],
      explain: `A、B、C、D。

每一份副本都要单独执行 ACL，而它们的默认行为几乎都是「不分人」。

A 对：RedisVL 的 \`filter_expression\` "Defaults to None and the full cache will be searched."。键里没有 principals，HR 问过的问题，答案会原样返回给实习生。

B 对：OTel 的 \`gen_ai.retrieval.documents\` 是 Opt-In，规范建议每个文档只带 \`id\` 和 \`score\`。打开了内容捕获的 trace 后端，就是一份没有 ACL 的知识库副本（调研的推断）。

C 对：arXiv 2509.14608 的原话是 "only those documents for which every active participant has access will be retrieved"。按提问者检索，答案会被群里的其他人看到。

D 对：\`user_groups\` 是 L14 说的 \`destination\` 类参数，被注入的文档可以让模型把它填成 \`["group:hr"]\`。规则是契约里没写的参数一律拒绝，权限只来自会话（ACL-11）。

E 错：这是正确做法，不是泄露。alice 和 bob 看得见的文档不同，版本消解的结果本来就该不同（VER-5）。

F 错：这正是 A 的修法（CACHE-1 到 CACHE-3）。用有效 principal 集合做键，同权限的人共享缓存，权限一变键就变。

对应讲义第四节 4.2 的七份副本表。`,
    },
    {
      id: 'field-level',
      kind: 'choice',
      prompt:
        '`hr-salary` 的文档 ACL 是 `group:hr` 和 `group:managers`，其中「月薪」一列只给 `group:hr`。现在的实现是：每行连同全部列一起建索引（BM25 和向量都有），返回给非 HR 用户之前把「月薪」字段抹掉。bob 在 `group:managers` 里。哪个判断对？',
      options: [
        { id: 'a', label: '安全：bob 永远看不到月薪那个值，返回时已经抹掉了' },
        {
          id: 'b',
          label:
            '不安全：bob 搜「23000」能命中张三那一行，命中本身就是泄露；值也编码在向量里。要在索引时分视图：普通行不含受限列、用文档 ACL，完整行另存一份、ACL 取受限列可见者',
        },
        { id: 'c', label: '在 Azure AI Search 里把月薪字段设成 `retrievable: false` 就够了' },
        { id: 'd', label: '在 system prompt 里写明「不要透露薪资」，让模型把关即可' },
      ],
      correct: ['b'],
      explain: `B。

抹掉返回值挡住了「看到」，挡不住「命中」。bob 用 23000 当查询，能确认某一行的月薪是 23000（存在性泄露，调研的推断）。向量那一侧，vec2text 原文是 "recover 92% of 32-token text inputs exactly"，作者的结论是 "embeddings should be treated with the same precautions as raw data"；不过论文只测了英文和 GTR、ada-002，中文和 BGE 类模型能否迁移没有数据。lab 的 \`chunkDocument\` 在索引时分两份，ACL-14 断言 bob 看得见的两行里既没有「月薪」也没有「23000」，用 23000 查询一条都命中不了，而 alice 恰好命中那一条完整行。

A 错：理由见上。返回时遮掉是最后一道，前面的 BM25 和向量里值都还在。

C 错：Azure 文档原话是 \`retrievable\` 设成 false "isn't a content-obfuscation or field-level security mechanism"，它只控制返回，不控制能不能被搜到。

D 错：OrgAccess 里 GPT-4.1 在最难的一档 F1 只有 0.27；ARBITER 里最好的 LLM 过滤也比静态过滤低 5 个百分点。权限要在检索层用确定性代码执行。

对应讲义第四节 4.6。代价要说出来：同一行存两份、embedding 两次。`,
    },
    {
      id: 'table-chunking',
      kind: 'choice',
      prompt:
        '`budget-2025` 的预算表有两级表头（「2025年」下面分「金额」「占比」），跨第 2–3 页，最后一行是「合计」。查询是「研发部 2025年 金额」。下面关于分块的说法，哪个对？',
      options: [
        {
          id: 'a',
          label:
            '按行切，多级表头按列拼成「2025年/金额」，caption 每行都带，合计行照常带列名，跨页后半段继承表头；任何含数据行的 chunk 都要能回答「这一格是哪一列」',
        },
        {
          id: 'b',
          label: '按行切、列名取第一行（RAGFlow 的 `rows[0]`）就够了：实验二里它的 top1 已经是研发部那一行',
        },
        { id: 'c', label: '把整张表放进一个 chunk，表格就不会被切断，这是唯一安全的做法' },
        {
          id: 'd',
          label: 'Unstructured 的 `max_characters` 默认 500，中文和英文得到的 token 预算一样，所以默认值可以直接用',
        },
      ],
      correct: ['a'],
      explain: `A。

实验二四种切法里，只有「按行、多级表头按列拼」让 1200 的列名是 \`2025年/金额\`。定长 40 字那种，top1 是表头所在的那一块：查询里的「2025年」「金额」都在表头里，而它既没有「研发部」也没有「1200」。lab 的 \`renderTableRows\`（TODO 2）把每一行渲染成「表3 各部门预算（万元）① 部门: 研发部; 2025年/金额: 1200; …」。

B 错：top1 对了，但「金额」和「占比」两列都叫「2025年」。模型拿到 1200 和 25.9%，分不清哪个是钱。这正是 TABLE 组要抓的。

C 错：大表放不下一个 chunk；放得下也会撞上别的上限，比如 Cohere Rerank 的 \`max_tokens_per_doc\` 默认 4096，超长的整表会被静默截断，表尾对重排器不可见。「不能被切断」的真正意思是每个含数据行的 chunk 都带着完整的列名。

D 错：500 是字符。按 L09 \`defaultEstimate\` 的口径（汉字约 1 token，其余约 4 字符 1 token），中文约 500 token、英文约 125 token，差 4 倍（推断）。文档也没提后续 \`TableChunk\` 会重复表头。

对应讲义第二节 2.1；断言 TABLE-1 到 TABLE-6，以及 PARSE-4（脚注附到每一行）、PARSE-5（跨页表格合并）。`,
    },
    {
      id: 'fullwidth-nfkc',
      kind: 'choice',
      prompt:
        '一批公文里写的是「第３条」「（２）」「２０２５年」（全角数字）。检索沿用 L09 的 tokenizer。同事提议：入库时把 chunk 正文整体做一次 NFKC，一劳永逸。哪个说法对？',
      options: [
        {
          id: 'a',
          label:
            'L09 的字符类不含全角数字，「（２）」切出空列表。切词、标题识别、缓存键之前要 NFKC；但 chunk 正文保留原样，因为 NFKC 会把「①」变成「1」、「（」变成「(」',
        },
        { id: 'b', label: '同事说得对：正文统一成半角，检索和引用都更干净' },
        {
          id: 'c',
          label: 'Python 的 `\\d` 本来就匹配全角数字，所以 Python 版不需要 NFKC，只有 TS 版需要',
        },
        { id: 'd', label: '对每行做一次 `trim()` 就能把全角字符和 BOM 一起清掉' },
      ],
      correct: ['a'],
      explain: `A。

实验三：「第３条」在 L09 下只切出 \`[第,条]\`，「（２）」切出 \`[]\`，「２０２５年」只剩 \`[年]\`。于是查「第3条 差旅」时，第５条（1888）排到了第３条（1760）前面；先 NFKC 再切词，第３条变成第一（2938）。

B 错：正文做了 NFKC，预算表 caption 里的「①」变成「1」，脚注「① 不含外包人员费用。」就找不到该附在哪一行；用户在 PDF 里看到的是「（２）」，chunk 里却是「(2)」，引用对不上原文。规范化只用在「比较」的地方。

C 错：Python 的 \`\\d\` 在 \`str\` 模式下确实匹配全角「１」，JS 不匹配——这恰恰是两种语言的差异，不是 Python 更对。lab 两边都在 NFKC 之后只写 \`[0-9]\`，不用 \`\\d\`。另外 Python 的 \`_TOKEN\` 和 TS 是同一个字符类，同样不含全角数字。

D 错：\`trim()\` 只去空白，不做全角转半角。而且 JS 的 \`trim()\` 会去掉 BOM，Python 的 \`strip()\` 不会，靠它会让两边对同一行是不是标题给出相反的结论。lab 只去 ASCII 空格，BOM 在 \`normalizeText\` 里显式删。

对应讲义第二节 2.3、2.4 和那个 PyMirror；断言 NUM-2、NUM-3、PARSE-6。`,
    },
    {
      id: 'version-precedence',
      kind: 'choice',
      prompt:
        '今天是 2026-10-12。研发部的 bob 问一线城市住宿上限。他看得见：2023 版办法（300 元，2025-07-01 废止）、2025 版办法（500 元，2025-07-01 生效）、2026 版办法（600 元，2026-09-20 发布，2027-01-01 生效）、研发部差旅补充规定（特别规定，450 元，2024-05-01 生效，与公司办法同级）。按 lab 的 `resolveVersions`，应当怎么答？',
      options: [
        { id: 'a', label: '600 元：2026 版是最新发布、最新修改的' },
        { id: 'b', label: '500 元：在已生效、未废止的版本里，2025 版的生效日最新' },
        { id: 'c', label: '450 元：特别规定优先于一般规定，这条没有例外' },
        {
          id: 'd',
          label:
            '冲突：新的一般规定（2025 版）晚于旧的特别规定（补充规定），规则自己裁决不了；两段都给出、标注冲突、交人决定。HR 的 alice 看不到补充规定，她拿到 2025 版',
        },
      ],
      correct: ['d'],
      explain: `D。

《立法法》第一百零五条："法律之间对同一事项的新的一般规定与旧的特别规定不一致，不能确定如何适用时，由全国人民代表大会常务委员会裁决。"。lab 照这套优先序写规则：先按 asOf 过滤生效日和废止日，再看上位、特别、新。实验六的真实语料：bob 是 \`CONFLICT\`，alice 是 \`travel-2025\`。

A 错：2026 版 2027-01-01 才生效，在 2026-10-12 不该覆盖任何版本（场景 S2）。按 mtime 还会在「旧版被重新编辑」时选回 2023 版（S3）。

B 错：只用了「新」这一个维度，没看到研发部的特别规定（S5 里按生效日选的是公司差旅办法）。

C 错：第一百零三条说特别规定优先，但第一百零五条承认有例外：新的一般规定晚于旧的特别规定时，不能自动裁决。2025 版办法生效于 2025-07-01，晚于补充规定的 2024-05-01。

还有一个前提要记住：企业内部制度是不是普遍仿照立法法的优先序，调研没有一手来源，你的公司要自己确认。

对应讲义开头和第五节 5.4、TODO 5 的 Drill；断言 VER-1 到 VER-7。`,
    },
    {
      id: 'sync-modes',
      kind: 'choice',
      prompt:
        '知识库用 LangChain 的 `index()` 加 `cleanup="incremental"` 做每晚同步。上线三个月后发现：源系统里已经删掉的文档，助手还能引用。同事提议改成 `cleanup="full"`。哪个评价最准确？',
      options: [
        { id: 'a', label: '同意：full 模式会删掉这一轮没出现的文档，正好解决问题，没有副作用' },
        {
          id: 'b',
          label:
            'incremental 只清理这一轮见过的 source 的旧版本，整篇被删的文档根本没被见到；full 要求 loader 每次返回全集，loader 部分失败就误删。应当加显式的删除事件（墓碑）',
        },
        { id: 'c', label: '改回默认值 `cleanup=None` 最稳妥，它会在下次检索时自动清理' },
        { id: 'd', label: '只要删掉 chunk，BM25 和 HNSW 立刻就和这篇文档无关了，所以选哪种都行' },
      ],
      correct: ['b'],
      explain: `B。

LangChain 文档原文，incremental 是 "Cleans up all documents that haven't been updated AND that are associated with source IDs that were seen during indexing"；full 是 "the loader should be returning the entire dataset, and not just a subset of the dataset. Otherwise, the auto_cleanup will remove documents that it is not supposed to."。实验七：第 3 轮 loader 因为 B 的读权限过期只拿回 A，full 模式下 B 被误删；只有 tombstone（incremental 加墓碑）两轮都对。

A 错：副作用就是误删。网络抖动、读权限过期、分页拿漏，任何一次部分失败都会被当成「源里删了」。

C 错：\`None\` 的文档原文是 "Do not delete any documents."，删除永远不会传播。下次检索时兜底的是 RAGFlow 的 \`PruneDeletedChunks\` 那种查询时清理，而那又是一次后过滤。

D 错：删除和更新在三类索引里都是先标记、后回收。ES 原文 "those deleted documents are taken into account for index statistics"；实验七删了 30 篇没重算统计量，acme 的排序就从 \`A1:6553 A2:3208\` 翻成了 \`A2:9472 A1:3856\`。

对应讲义第五节 5.1、5.2；断言 SYNC-1 到 SYNC-4。`,
    },
    {
      id: 'debug-acl-pipeline',
      kind: 'debug',
      prompt:
        '下面是公司知识库问答的主流程。测试环境里只有 200 篇全员可见的文档，问答全对；安全审计抽查最终答案，也没有发现越权。找出所有问题，按「会越权或外泄」和「会静默降质」两类分开，说明每一个在测试环境里为什么看不出来，以及怎么让它变成一个能断言的输出。',
      lang: 'ts',
      code: `async function answer(q: string, user: User): Promise<string> {
  const key = normalizeText(q).trim()
  const cached = await cache.get(key)
  if (cached) return cached

  const principals = [user.email, ...user.groups]
  const cands = await pg.query(
    'SELECT id, text, acl FROM chunks ORDER BY emb <-> $1 LIMIT 40',
    [await embed(q)],
  )
  const ranked = await rerankApi.rerank({
    query: q,
    documents: cands.rows.map((r) => r.text),
  })
  let hits = ranked
    .slice(0, 10)
    .map((r) => cands.rows[r.index])
    .filter((c) => !c.acl || c.acl.some((p) => principals.includes(p)))

  if (hits.length === 0) {
    // 空结果：放宽相似度阈值再试一次
    hits = await relaxedSearch(q, { minSimilarity: 0.17 })
  }

  span.setAttribute(
    'gen_ai.retrieval.documents',
    JSON.stringify(hits.map((h) => ({ id: h.id, text: h.text }))),
  )
  const ans = await llm(q, hits)
  await cache.set(key, ans)
  return ans
}`,
      rubric: [
        '你有没有指出缓存键只有 query，没有 principals 和语料版本，并说出它在「全员可见」的测试语料上永远看不出来？',
        '你有没有指出 rerank 在 ACL 过滤之前，越权全文已经发给了外部 API，而最终答案和先过滤一模一样？',
        '你有没有指出 ACL 在取 top-10 之后才过滤，是后过滤，低选择率用户的召回会塌到 0 条？',
        '你有没有发现 `!c.acl` 那一支是 fail-open，缺 acl 的 chunk 谁都能看？',
        '你有没有发现 principals 没有类型前缀，一个叫 alice@qinghe.com 的组会撞上 alice 的个人权限？',
        '你有没有指出空结果后的放宽重试没有带 ACL，并且会把「无权」变成一个基于无关材料的答案？',
        '你有没有指出 trace 记了正文，是一份没有 ACL 的副本？',
        '你给的修法里，每一条是不是都对应一个能断言的输出（exposed、scanned、缓存键、按身份分层的评测），而不是只改代码？',
      ],
      reference: `七个问题。测试环境看不出来，是因为它同时满足了三个条件：所有文档全员可见（ACL 永远通过）、只有一个测试用户（缓存不会串）、只看最终答案（数据流不可见）。

## 会越权或外泄

| 位置 | 问题 | 测试环境为什么看不出 | 让它可断言 |
|---|---|---|---|
| 缓存键 | 只有 query：HR 问过的问题，答案原样返回给实习生 | 只有一个用户，键串不串都一样 | 键含去重排序的 principals 和 corpusVersion（CACHE-1 到 CACHE-3） |
| rerank 位置 | 先把 40 段全文发给外部 API，回来才过滤 | 最终 top-k 和先过滤完全相同（ACL-10） | 流水线返回 \`exposed\`，断言里面没有越权 id（ACL-9） |
| \`!c.acl\` | 缺 acl 当公开，fail-open | 测试语料每篇都有 acl | 缺 acl 一律不可见（ACL-1）；入库门禁的 NO_ACL 挡在前面 |
| principals | \`user.email\` 和组名在同一个命名空间 | 没有恰好同名的组 | \`principalKey\` 输出「类型:名字」（ACL-2、ACL-3） |
| 放宽重试 | \`relaxedSearch\` 不带 principals，也把「无权」变成了一次重试 | ACL 从不过滤，结果从不为空，这一支永远不执行 | 删掉；空结果原样报出，拒答率按身份分层看 |
| trace | 检索 span 记了正文 | 测试数据不敏感 | 只记 id、score 和 ACL 指纹；正文外部化到按原文档 ACL 读的存储 |

放宽重试那一支要单独说：RAGFlow 的 "If result is empty, retry with relaxed conditions" 在开放域是好意；在这里，没带 ACL 的版本是直接越权，带了 ACL 的版本会拿过滤后剩下的无关 chunk 作答，得到 L09 第八节说的那种「完全讲得通、有材料支撑、而且错的答案」。

## 会静默降质

ACL 在 \`slice(0, 10)\` 之后过滤，是比 WHERE 还紧的后过滤：40 个候选先被 rerank 截到 10 个，再按 ACL 筛。一个只能看全库 2% 文档的用户，按实验四的量级，平均每次剩不到 1 条。pgvector 实测 2% 选择率、默认参数下 recall@10 是 0.055。

测试环境看不出来，因为全员可见时 ACL 什么都不过滤。修法是把过滤放进 ANN（pgvector 打开 \`hnsw.iterative_scan\` 或按部门分区，ES 写进 \`knn.filter\`），然后先过滤再 rerank：

    const cands = await searchFiltered(qv, principals, { mode: 'iterative', ef: 40, maxScan: 400 })
    const ranked = await rerankApi.rerank({ query: q, documents: cands.map((c) => c.text) })

再加一个按身份分层的检索评测：每个样本带 \`asPrincipal\`，分别报低选择率用户的 recall。安全审计只看越权，永远是绿的。`,
    },
    {
      id: 'debug-sync',
      kind: 'debug',
      prompt:
        '下面是知识库的每晚同步任务，跑了半年。最近三件事：一次组织调整（几十个组改名）之后，同步跑了 14 个小时、embedding 账单翻了好几倍；embedding 模型从 bge-m3 换成新模型之后，抽查发现检索质量忽高忽低；源系统里删掉的文档，助手还在引用。同事提议在末尾加一段「这一轮没出现的 src 一律删」。找出代码里的问题，评价这个提议，给出修法。',
      lang: 'ts',
      code: `function contentHash(d: SourceDoc): string {
  // metadata 里有 acl、effectiveFrom、repealedAt
  return sha256(d.text + JSON.stringify(d.metadata))
}

async function nightlySync(loader: Loader, index: Index, gen: Gen) {
  const docs = await loader.loadAll()   // 偶尔因网络或读权限过期只返回一部分
  for (const d of docs) {
    const h = contentHash(d)
    if (await index.hasHash(d.src, h)) continue
    await index.deleteBySrc(d.src)
    const chunks = chunkDocument(d, gen)
    const vectors = await embedBatch(chunks.map((c) => c.text), gen.embedder)
    await index.upsert(chunks.map((c, i) => ({ ...c, hash: h, vector: vectors[i] })))
  }
}

// 同事的提议：
//   const seen = new Set(docs.map((d) => d.src))
//   for (const src of await index.allSrcs()) if (!seen.has(src)) await index.deleteBySrc(src)`,
      rubric: [
        '你有没有指出 ACL 和版本元数据进了内容 hash，权限变更会触发重解析、重分块、重 embedding，而它只需要更新 payload？',
        '你有没有发现 JSON.stringify 不排序 key，同一份 metadata 换了 key 顺序就会被当成变了？',
        '你有没有指出 embedding 模型不在 hash 里，换模型后没变过的文档不会重做，索引里混着两代不可比的向量？',
        '你有没有指出先删后写：embedding 失败时这篇文档整个从索引里消失？',
        '你有没有说清这段代码的删除语义等于 LangChain 的 incremental，整篇删除永远传不到？',
        '你有没有指出同事的提议就是 full 模式，loader 部分失败时会误删，并给出墓碑作为替代？',
        '你有没有提到删除之后统计量和 HNSW 里还有幽灵，需要合并或重建？',
      ],
      reference: `五个问题，外加对提议的评价。三件事一一对得上。

## 一、ACL 进了内容 hash：组织调整等于全量重 embedding

LangChain 的 \`index()\` 也是这么做的：文档 hash 是内容 hash 加 \`json.dumps(metadata, sort_keys=True)\` 的 hash。ACL 写在 metadata 里，改一次权限就整篇重做。几十个组改名，几乎每篇文档的 ACL 都变了，于是 14 个小时和翻倍的账单。

按 lab 的 \`planReindex\`，「只有 ACL 或版本元数据变了」只需要更新 payload（Qdrant 的 \`set_payload\`、ES 的 \`_update\`），不重解析、不重分块、不重 embedding（SYNC-5）。内容 hash 只放正文：

    const contentHash = (d: SourceDoc) => sha256(d.text)
    const metaHash = (d: SourceDoc) => sha256(stableStringify(d.metadata))

## 二、JSON.stringify 不排序 key

同一份 metadata，上游哪天换了字段顺序，hash 就变了，整篇重做。LangChain 的 \`sort_keys=True\` 就是为了这个。这是一个只会多花钱、不会少做事的 bug，所以没人发现。

## 三、embedding 模型不在 hash 里：两代向量混在一起

换了模型，\`hasHash\` 对所有没改过的文档返回真，它们保留旧模型的向量；只有改过的文档用了新模型。不同代的向量不在同一个空间里，不可比——这就是「忽高忽低」。LangChain 的 record manager 有同样的问题，要 \`force_update\`。

修法：\`Gen\`（解析器、分块器、embedding 模型三个版本）进 hash 或作为单独的索引代，换模型就建新一代、整体切换；检索时一次结果里混了两代，lab 的 \`assertSingleEmbedder\` 直接抛错（VER-8）。

## 四、先删后写

\`deleteBySrc\` 在 \`embedBatch\` 之前。embedding API 超时或限流，这篇文档就从索引里消失了，下一轮之前谁都检索不到。lab 的 TODO 6 要求先写后删：新 chunk 写进去，再删同 src 下 hash 不同的旧 chunk。

## 五、删除传不到

这段代码只处理 loader 这一轮返回的文档，语义等于 LangChain 的 incremental："Cleans up all documents that haven't been updated AND that are associated with source IDs that were seen during indexing"。整篇被删的文档这一轮根本没被见到，它的 chunk 就永远留着。

## 同事的提议：就是 full 模式

LangChain 对 full 的警告原文："the loader should be returning the entire dataset, and not just a subset of the dataset. Otherwise, the auto_cleanup will remove documents that it is not supposed to."。代码注释已经写了 loader 偶尔只返回一部分。实验七第 3 轮正是这个场景：B 的读权限过期，full 模式下 B 被误删。

| 模式 | 已删的 C | loader 漏了 B |
|---|---|---|
| 现在的代码（incremental） | 残留 | 不受影响 |
| 同事的提议（full） | 删掉 | 误删 |
| 墓碑 | 删掉 | 不受影响 |

正确的做法是显式的删除事件：源系统的删除 webhook、回收站扫描、或者定期拿源系统的全量 id 列表做对账，**对账失败就不删**。lab 的 \`tombstone\` 模式就是 incremental 再加一条「src 在墓碑里就删整篇」（SYNC-4）。

## 删完还有幽灵

删除和更新在 ES、pgvector、Qdrant 里都是先标记、后回收。ES 原文 "those deleted documents are taken into account for index statistics"；pgvector 的死元组和 ACL 过滤抢同一批 \`ef_search\` 名额；Qdrant 大量软删除点可能让图断开。实验七删了 30 篇不重算统计量，排序就翻了。大批删除之后要安排段合并、\`VACUUM\` 或重建。`,
    },
    {
      id: 'design-policy-kb',
      kind: 'design',
      prompt:
        '为公司设计一个内部制度知识库问答助手。说清楚：怎么解析和分块、ACL 放在哪一层、除了索引还有哪些副本要执行权限、版本怎么消解、删除怎么传播、怎么评测，以及入库前挡什么。',
      scenario:
        '语料约 3,000 份：Confluence 上的制度页面；共享盘里的 PDF，其中不少是扫描件，带页眉「青禾科技 内部资料」、印章、罗马数字页码的目录，正文用公文编号「一、（一）1.（1）」；Excel 导出的预算表和薪酬表，薪酬表的「月薪」一列只允许 HR 看。差旅办法每年秋天发布新版、次年 1 月 1 日生效，各部门还有自己的补充规定。权限来自 Confluence 和共享盘的 ACL，组织调整时会批量改组名。助手既在个人对话里用，也会被拉进部门群聊。向量库是 Elasticsearch，重排用一个外部 rerank API，trace 接到公司的 OTel 后端。',
      reference: `这题没有唯一答案。能区分「想过」和「没想过」的，是你有没有把每一种静默失败变成一个能断言的输出，而不是只描述一条「正确的流水线」。

## 一、解析与坐标

- 解析器不看榜单选：拿 50 到 100 页自己的代表性文档（扫描件、表格、跨页表格各要有），在检索层跑回归，而不是比编辑距离。OHRBench 说编辑距离和 RAG 表现不对齐；OmniDocBench 和 olmocr-bench 上 Marker 和 MinerU 名次相反。许可证和精度同级
- 显式检查默认值：PP-StructureV3 默认忽略脚注、页码、页眉；印章识别默认关。印章（发文机关）是判定正式发文的证据，要打开
- chunk 分开存物理页序和印刷页码，只有一个函数负责换算成引用；跨页段落给页码范围。目录的罗马数字页码和正文的「1」不是同一页
- 页眉按跨页统计判定（顶部或底部 10% 区域、至少 3 页重复），不按「顶部 10%」
- 解析器版本是索引的一代：升级就重解析，不是重分块

## 二、结构

- 公文编号识别器补在 \`#\` 旁边，先 NFKC 再用显式字符类；层级表按文档类型参数化（公文的「（一）」是第 2 层，法规的「（一）」是项）
- 表格按行切，多级表头按列拼，caption 每行带，合计行带列名，跨页后半段继承表头，脚注附到含同一序号的每一行
- 切词、标题识别、缓存键之前做 NFKC；chunk 正文保留原样
- Elasticsearch 的中文分词器是一个显式选择：\`standard\` 按 UAX#29 切，\`cjk_bigram\` 默认不出单字。换分词器等于重建索引

## 三、ACL 放在哪一层

- ACL 写进 \`knn\` 子句自己的 \`filter\`（或 filtered alias），不写在外层 bool。外层是后过滤，安全但召回会塌
- principal 带类型前缀和来源（\`user:\`、\`group:\`、\`ext_group:confluence/…\`），只做 ASCII 小写；缺 acl 一律不可见
- principal 数有上限：Onyx 超过 65,536 个 terms 直接抛错，不静默截断
- 字段级：薪酬表在索引时分两份，普通行不含「月薪」、用文档 ACL；完整行另存，ACL 只给 HR。只在返回时遮掉，值还在 BM25 和向量里

## 四、副本

| 副本 | 做法 |
|---|---|
| 外部 rerank | 先过滤再发；流水线返回 \`exposed\`，断言里面没有越权 id |
| 答案缓存 | 键是规范化 query、去重排序的 principals、语料版本三段 |
| trace | 检索 span 只记 id、score、ACL 指纹；正文外部化到按原文档 ACL 读的存储；查询文本也按敏感处理 |
| 部门群聊 | 按所有在场者的交集检索，不按提问者 |
| 检索工具 | schema 只有 \`query\`、\`k\`；ACL 相关参数出现就拒绝；按 id 取文档也查 ACL |
| 同步延迟 | 说得出撤权延迟的上界（Onyx 的默认值是 Confluence 30 分钟），并把它写进对外承诺 |

源系统里的过度共享会被一句话检索放大：入库前统计「全员可见又命中敏感词」的文档。

## 五、版本

- 每份制度带 \`effectiveFrom\`、\`repealedAt\`、\`level\`（集团、公司、部门）、\`special\`；缺 \`effectiveFrom\` 的进门禁，不参与自动消解
- 消解在权限过滤之后、对每个用户分别做：先按 asOf 过滤，再上位、特别、新；新的一般规定晚于旧的特别规定时返回冲突，两段都给出、交人裁决
- 不按 mtime，也不把两版都塞给模型让它挑：ClashEval 里模型超过 60% 的时候采纳了与自身正确先验冲突的检索内容，而只差一个数字的新旧版本正是最像真的那一类
- 立法法的优先序只是参照；公司自己的制度怎么排，要和制度管理部门确认

## 六、删除与重建

- 删除走墓碑：源系统的删除事件，或定期全量 id 对账，对账失败就不删。不用 full 模式
- ACL 和版本元数据不进内容 hash，走只更新 payload 的通道：组织调整批量改组名时不重 embedding
- 索引有代：解析器、分块器、embedding 模型任何一个变了，建新一代整体切换；一次结果里混两代就报错
- 大批删除之后安排段合并或重建，否则统计量里有幽灵

## 七、评测与门禁

- 评测集按身份 × 时点 × 文档类型分层，每个样本带 \`asPrincipal\` 和 \`asOf\`；低选择率用户（只能看少数文档的部门）单独报 recall
- 越权率是计数：500 条 0 次越权，95% 置信上界约 0.6%，报 0 之前先报分母
- 统计「引用了已废止版本」和「冲突被静默选了一边」的比率
- 入库门禁至少挡：缺 acl、缺生效日、空白页、脚注丢失、表格无表头、替换字符。阈值没有一手数字，要在自己的语料上校准`,
      rubric: [
        '你有没有在自己的语料上、在检索层评估解析器，并显式检查了脚注、页码、印章的默认值？',
        '你有没有区分物理页序和印刷页码，并让引用只经过一个换算函数？',
        '你的表格分块能不能保证每个含数据行的 chunk 都带完整列名（多级表头、caption、合计行、跨页）？',
        '你有没有把 ACL 写进 ES 的 knn 子句内部，并说明外层 bool filter 的后果是召回塌缩而不是越权？',
        '薪酬表的月薪列是不是在索引时就分了视图，而不是只在返回时遮掉？',
        '你有没有列全副本：外部 rerank、缓存、trace、群聊、工具参数、同步延迟，并给每一份一个能断言的不变量？',
        '版本消解有没有至少三个维度、按 asOf 而不是 mtime，并且能返回「冲突、交人裁决」？',
        '删除是不是靠显式事件，ACL 变更是不是不触发重 embedding，换 embedding 模型是不是整代切换？',
        '你的评测有没有按身份和时点分层，越权率有没有带分母？',
        '入库门禁的阈值，你有没有承认需要在自己的语料上校准，而不是给一个看起来权威的数字？',
      ],
    },
  ],
}
