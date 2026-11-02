"""L10x 的脚手架。跑法：uv run python -m l10x.skills

观察实验：同一组 skill 在四种客户端策略下的结局、YAML 陷阱、description 重叠、
目录预算的三个阶段、skill 与 MCP 的上下文账、缓存下的真实成本。
全程零模型，只用确定性假数据。写完七个 TODO 跑 uv run python -m l10x.verify。
"""

from __future__ import annotations

import json
import re
from typing import Literal

from shared.mcp import McpTool, ToolOutcome, tools_list_cost
from shared.sandbox import SafePath, SafePathErr, SafePathOk, safe_path
from shared.skills import (
    CACHE_READ,
    DANGEROUS_PATTERNS,
    MAX_DESC,
    MAX_NAME,
    POLICY_RANK,
    SHELL_META,
    ApprovalInput,
    ApprovalResult,
    BlockErr,
    BlockOk,
    BlockResult,
    CatalogEntry,
    CatalogOpts,
    CatalogResult,
    NameCode,
    ParseResult,
    Policy,
    PrefixLayers,
    Resolved,
    ScalarErr,
    ScalarOk,
    ScalarResult,
    Shadow,
    SkillCtx,
    SkillMeta,
    SplitErr,
    SplitOk,
    SplitResult,
    alias_rank,
    by_name_then_location,
    catalog_cost,
    catalog_desc,
    catalog_order,
    fmt_hundredths,
    parse_frontmatter,
    prefix_change_cost,
    render_catalog,
    render_entry,
    resident_cost,
    resolve_collisions,
    skill_from_text,
    trim_sp,
    validate_strict,
    word_jaccard_bp,
    wrap_catalog,
)

DIM, BOLD, OFF = "\x1b[2m", "\x1b[1m", "\x1b[0m"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def dim(s: str) -> str:
    return f"{DIM}{s}{OFF}"


def bold(s: str) -> str:
    return f"{BOLD}{s}{OFF}"


def _w(s: str) -> int:
    s = _ANSI.sub("", s)
    return sum(2 if "\u2e80" <= c <= "\u9fff" or "\uff00" <= c <= "\uffef" else 1 for c in s)


def pad(s: str, n: int) -> str:
    return s + " " * max(0, n - _w(s))


def skill(ctx: SkillCtx, front: str) -> SkillMeta:
    r = skill_from_text(f"---\n{front}\n---\n正文。\n", ctx)
    if r.skill is None:
        raise RuntimeError(f"夹具写错了：{ctx.dir}")
    return r.skill


def ratio(a: int, b: int) -> str:
    """整数比值，两位小数，不经过浮点格式化。"""
    return fmt_hundredths((a * 100) // b) + "x"


def _js(v: object) -> str:
    """JSON.stringify(v) 的同义写法：紧凑分隔符，不转义中文。"""
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


# ─────────────────────────────────────────────────────────────


def exp1() -> None:
    print(bold("\n实验一：同一组文件，四种客户端，四种结局"))
    files: list[tuple[str, SkillMeta]] = [
        (
            "user",
            skill(
                SkillCtx(
                    dir="/home/me/.agents/skills/pdf", scope="user", trust="user", alias=".agents"
                ),
                "name: pdf\ndescription: Extract text from PDF files (my copy).",
            ),
        ),
        (
            "project",
            skill(
                SkillCtx(
                    dir="/repo/.agents/skills/pdf",
                    scope="project",
                    trust="project-trusted",
                    alias=".agents",
                ),
                "name: pdf\ndescription: Extract text from PDF files (repo copy).",
            ),
        ),
        (
            "根 .agents",
            skill(
                SkillCtx(
                    dir="/repo/.agents/skills/review",
                    scope="project",
                    trust="project-trusted",
                    alias=".agents",
                ),
                "name: review\ndescription: Review a diff.",
            ),
        ),
        (
            "web .agents",
            skill(
                SkillCtx(
                    dir="/repo/packages/web/.agents/skills/review",
                    scope="project",
                    trust="project-trusted",
                    alias=".agents",
                ),
                "name: review\ndescription: Review a frontend diff.",
            ),
        ),
        (
            ".gemini",
            skill(
                SkillCtx(
                    dir="/repo/.gemini/skills/review",
                    scope="project",
                    trust="project-trusted",
                    alias=".gemini",
                ),
                "name: review\ndescription: Review a diff (gemini copy).",
            ),
        ),
    ]

    def label(loc: str) -> str:
        return next((lb for lb, s in files if s.location == loc), loc)

    def pick(r: Resolved, name: str) -> str:
        hits = [s for s in r.active if s.name == name]
        return label(hits[0].location) if len(hits) == 1 else f"全留（{len(hits)} 份）"

    policies: list[Policy] = ["agentskills-guide", "claude-code", "gemini-cli", "codex"]
    print(
        f"  {pad('策略', 20)}{pad('pdf 用哪份', 14)}{pad('review 用哪份', 16)}{pad('遮蔽条数', 10)}按名字点时有歧义"
    )
    print("  " + "─" * 78)
    for p in policies:
        r = resolve_collisions([s for _, s in files], p)
        amb = ", ".join(r.ambiguous) if r.ambiguous else "—"
        print(
            f"  {pad(p, 20)}{pad(pick(r, 'pdf'), 14)}{pad(pick(r, 'review'), 16)}{pad(str(len(r.shadowed)), 10)}{amb}"
        )

    print(bold("\n  同一个文件，作者侧和运行时两种结论"))
    cases: list[tuple[str, str, str]] = [
        (
            "report-gen/SKILL.md",
            "report-gen",
            "name: report\ndescription: Generate a weekly report.",
        ),
        (
            "deploy/SKILL.md",
            "deploy",
            "name: deploy\ndescription: Deploy the app.\nwhen_to_use: When the user says ship it.",
        ),
    ]
    print(f"  {pad('文件', 22)}{pad('strict（作者侧）', 34)}lenient（运行时）")
    print("  " + "─" * 78)
    for file, dir_name, front in cases:
        p = parse_frontmatter(f"---\n{front}\n---\n", "strict")
        strict = (
            ", ".join(
                d.code + (f" {d.field}" if d.field else "") for d in validate_strict(p.fm, dir_name)
            )
            if p.ok
            else "解析失败"
        )
        rs = skill_from_text(
            f"---\n{front}\n---\n",
            SkillCtx(
                dir=f"/repo/.agents/skills/{dir_name}", scope="project", trust="project-trusted"
            ),
        )
        lenient = (
            f"加载为 {rs.skill.name}，{len(rs.diags)} 条 warning，extra：{', '.join(rs.skill.extra) or '—'}"
            if rs.skill is not None
            else "跳过"
        )
        print(f"  {pad(file, 22)}{pad(strict or '通过', 34)}{lenient}")
    print(dim("\n  标准只规定了文件长什么样。谁赢、严不严，全是客户端自己的策略。"))


# ─────────────────────────────────────────────────────────────

YAML_CASES: list[tuple[str, str, str, str]] = [
    ("01 1.0", "v: 1.0", "float:1.0", "int:1"),
    ("02 no", "v: no", "bool:false", 'str:"no"'),
    ("03 on", "v: on", "bool:true", 'str:"on"'),
    ("04 yes", "v: yes", "bool:true", 'str:"yes"'),
    ("05 0123", "v: 0123", "int:83", "int:123"),
    ("06 0x1F", "v: 0x1F", "int:31", "int:31"),
    ("07 1e3", "v: 1e3", 'str:"1e3"', "int:1000"),
    ("08 date", "v: 2026-10-12", "date", "date"),
    ("09 ~", "v: ~", "null", "null"),
    ("10 null", "v: null", "null", "null"),
    ("11 .inf", "v: .inf", "float:inf", "float:Infinity"),
    ("12 colon-space", "v: Use when: the user asks", "ERR", "ERR"),
    ("13 trailing #", "v: value # comment", 'str:"value"', 'str:"value"'),
    ("14 dq colon", 'v: "quoted: ok"', 'str:"quoted: ok"', 'str:"quoted: ok"'),
    ("15 sq escape", "v: 'it''s'", 'str:"it\'s"', 'str:"it\'s"'),
    ("16 dq \\u", 'v: "caf\\u00e9"', 'str:"café"', 'str:"café"'),
    ("17 flow seq", "v: [a, b]", "list", "list"),
    ("18 flow map", "v: {a: b}", "map", "map"),
    ("19 block seq", "v:\n  - a\n  - b", "list", "list"),
    (
        "20 folded >",
        "v: >\n  line one\n  line two",
        'str:"line one line two"',
        'str:"line one line two\\n"',
    ),
    (
        "21 literal |",
        "v: |\n  line one\n  line two",
        'str:"line one\\nline two"',
        'str:"line one\\nline two\\n"',
    ),
    ("22 anchor", "a: &x hello\nv: *x", 'str:"hello"', 'str:"hello"'),
    ("23 dup key", "v: first\nv: second", 'str:"second"', "ERR"),
    ("24 tab", "v:\n\t- a", "ERR", "ERR"),
]


def show_parse(r: ParseResult) -> str:
    if not r.ok:
        return f"ERR {r.diags[-1].code}"
    v = r.fm.fields.get("v")
    warned = " ⚠" if r.diags else ""
    return ("—" if v is None else _js(v)) + warned


def exp2() -> None:
    print(bold("\n实验二：frontmatter 不是「随便用个 YAML 库」"))
    print(dim("  PyYAML 6.0.3 与 js-yaml 4.3.2 两列是调研时的实测结果，写死在这里，lab 不装它们。"))
    print(
        f"  {pad('样例', 16)}{pad('子集 strict', 28)}{pad('子集 lenient', 30)}{pad('PyYAML', 26)}js-yaml"
    )
    print("  " + "─" * 110)
    agree = 0
    for id_, y, py, js in YAML_CASES:
        text = f"---\n{y}\n---\n"
        if py == js:
            agree += 1
        strict = show_parse(parse_frontmatter(text, "strict"))
        lenient = show_parse(parse_frontmatter(text, "lenient"))
        print(f"  {pad(id_, 16)}{pad(strict, 28)}{pad(lenient, 30)}{pad(py, 26)}{js}")
    print(dim(f"\n  PyYAML 和 js-yaml 只在 {agree} / {len(YAML_CASES)} 个样例上一致；"))
    print(dim("  加上 yaml 和 strictyaml 四家一起比（报错都算同一种结果），只剩 7 / 24。"))
    print(dim("  子集的规则：几家一致的照常支持；不一致的拒绝，或在字段层用显式规则收口。"))


# ─────────────────────────────────────────────────────────────

OVERLAP: list[tuple[str, str, str]] = [
    (
        "pdf",
        "Use this skill whenever the user mentions PDFs, documents, files, reports, forms or any document processing, even if they do not explicitly ask for it.",
        "Extract text, tables and form fields from existing PDF files. Not for creating new PDFs or editing Word files.",
    ),
    (
        "docx",
        "Use this skill whenever the user mentions Word documents, files, reports, letters or any document editing, even if they do not explicitly ask for it.",
        "Edit existing .docx files: tracked changes, comments, styles. Not for PDFs or plain-text notes.",
    ),
    (
        "xlsx",
        "Use this skill whenever the user mentions spreadsheets, Excel, tables, data, files or any numbers, even if they do not explicitly ask for it.",
        "Read and write .xlsx workbooks, including formulas and cell formatting. Not for CSV files or charts.",
    ),
    (
        "csv",
        "Use this skill whenever the user mentions CSV, data, tables, files, analysis or any dataset, even if they do not explicitly ask for it.",
        "Profile a CSV file: column types, missing values, outliers. Not for Excel workbooks.",
    ),
    (
        "chart",
        "Use this skill whenever the user mentions charts, plots, graphs, data, reports or any visualization, even if they do not explicitly ask for it.",
        "Render a PNG chart from tabular data with matplotlib. Not for dashboards or slide layout.",
    ),
    (
        "report",
        "Use this skill whenever the user mentions reports, summaries, documents, data or any writing task, even if they do not explicitly ask for it.",
        "Draft a weekly status report from a list of merged PRs. Not for emails or slide decks.",
    ),
    (
        "email",
        "Use this skill whenever the user mentions email, messages, letters, documents or any writing task, even if they do not explicitly ask for it.",
        "Draft a reply to an email thread in the user's tone. Not for reports or chat messages.",
    ),
    (
        "slides",
        "Use this skill whenever the user mentions slides, presentations, decks, reports or any document, even if they do not explicitly ask for it.",
        "Build a .pptx deck from an outline, one slide per heading. Not for charts or PDF export.",
    ),
]


def overlap_stats(descs: list[tuple[str, str]]) -> tuple[int, list[tuple[str, str, int]]]:
    pairs: list[tuple[str, str, int]] = []
    for i in range(len(descs)):
        for j in range(i + 1, len(descs)):
            pairs.append((descs[i][0], descs[j][0], word_jaccard_bp(descs[i][1], descs[j][1])))
    total = sum(p[2] for p in pairs)
    # TS 的比较器：重叠降序，同分按 a + b 拼起来的字符串升序
    top = sorted(pairs, key=lambda p: (-p[2], p[0] + p[1]))[:3]
    return total // len(pairs), top


def exp3() -> None:
    print(bold("\n实验三：description 写得越「积极」，彼此越像"))
    print(
        dim(
            "  指标是小写词集合的 Jaccard（基点，万分之一）。它只是确定性的重叠代理，不预测真实触发率。"
        )
    )
    pushy = overlap_stats([(n, p) for n, p, _ in OVERLAP])
    bounded = overlap_stats([(n, b) for n, _, b in OVERLAP])
    print(f"  {pad('写法', 24)}{pad('28 对的平均重叠', 18)}最像的三对")
    print("  " + "─" * 78)
    for label, (avg, top3) in [
        ("「只要提到就用」", pushy),
        ("意图 + 边界（不适用于…）", bounded),
    ]:
        top = "  ".join(f"{a}/{b} {v}" for a, b, v in top3)
        print(f"  {pad(label, 24)}{pad(str(avg), 18)}{top}")
    print(
        dim(
            "\n  官方建议 description 写得 pushy 一点，免得不触发；可每个 skill 都这么写，它们就互相抢。"
        )
    )


# ─────────────────────────────────────────────────────────────


def fake_skills(n: int) -> list[SkillMeta]:
    filler = "Step-by-step guidance with checks, worked examples and the edge cases that usually go wrong. "
    out: list[SkillMeta] = []
    for i in range(1, n + 1):
        id_ = f"skill-{i:03d}"
        user = i % 2 == 0
        desc = f"Use for workflow {i}: {filler * 3}"[:200].rstrip(" ")
        out.append(
            skill(
                SkillCtx(
                    dir=f"/home/me/.agents/skills/{id_}",
                    scope="user",
                    trust="user",
                    alias=".agents",
                )
                if user
                else SkillCtx(
                    dir=f"/repo/.agents/skills/{id_}",
                    scope="project",
                    trust="project-trusted",
                    alias=".agents",
                ),
                f"name: {id_}\ndescription: {desc}",
            )
        )
    return out


def exp4() -> None:
    print(bold("\n实验四：目录预算 8000 字符，装到第几个 skill 开始出事"))
    print(
        f"  {pad('skill 数', 10)}{pad('阶段', 6)}{pad('目录字符', 10)}{pad('description 显示', 18)}{pad('被截短', 8)}省略（project / user）"
    )
    print("  " + "─" * 78)
    for n in [10, 30, 60, 120, 200]:
        skills = fake_skills(n)
        r = render_catalog(skills, CatalogOpts(budget_chars=8000, format="lines"))
        shown = [e.shown for e in r.entries]
        rng = "—" if not shown else f"{min(shown)}–{max(shown)}"
        cut = sum(1 for e in r.entries if e.shown < e.full)
        scope = {s.name: s.scope for s in skills}
        op = sum(1 for x in r.omitted if scope[x] == "project")
        ou = sum(1 for x in r.omitted if scope[x] == "user")
        print(
            f"  {pad(str(n), 10)}{pad(str(r.stage), 6)}{pad(str(len(r.text)), 10)}{pad(rng, 18)}{pad(str(cut), 8)}{op} / {ou}"
        )
    print(dim("\n  每条 description 才 200 字符，远低于 1024 的上限，30 个左右就开始截短。"))
    print(dim("  到了阶段 3，按目录顺序贪心放，user 层排在最后，最先整条消失。"))


# ─────────────────────────────────────────────────────────────

SAME_DESC = (
    "Extract text, tables and form fields from PDF files and return them as Markdown. "
    "Use when the user provides a PDF or asks about its contents. Not for creating or editing PDFs."
)


async def _no_run(_args: dict[str, object]) -> ToolOutcome:
    return ToolOutcome(text="", is_error=False)


def mcp_tool(name: str) -> McpTool:
    return McpTool(
        name=name,
        description=SAME_DESC,
        input_schema={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path to the PDF file"},
                "pages": {"type": "string", "description": "Page range such as 1-3"},
                "format": {"type": "string", "enum": ["text", "markdown"]},
            },
            "required": ["path"],
        },
        run=_no_run,
    )


def exp5() -> None:
    print(bold("\n实验五：同一段 description，做成 skill 条目和做成 MCP 工具，差多少"))
    print(
        dim(
            f"  description {len(SAME_DESC)} 字符；MCP 那边多一个三参数的 inputSchema。token 用课程的 estimateTokens。"
        )
    )
    print(
        f"  {pad('N', 6)}{pad('skill（XML）', 14)}{pad('skill（行）', 14)}{pad('MCP tools/list', 16)}MCP / XML"
    )
    print("  " + "─" * 60)
    for n in [3, 10, 30, 120]:
        names = [f"pdf-{i + 1:03d}" for i in range(n)]
        skills = [
            skill(
                SkillCtx(dir=f"/home/me/.agents/skills/{nm}", scope="user", trust="user"),
                f"name: {nm}\ndescription: {SAME_DESC}",
            )
            for nm in names
        ]
        xml = catalog_cost(skills, "xml")
        lines = catalog_cost(skills, "lines")
        mcp = tools_list_cost([mcp_tool(nm) for nm in names]).tokens
        print(
            f"  {pad(str(n), 6)}{pad(str(xml), 14)}{pad(str(lines), 14)}{pad(str(mcp), 16)}{ratio(mcp, xml)}"
        )
    print(dim("\n  格式本身只差一个 inputSchema。skill 真正省的是把「怎么做」推迟到激活之后。"))

    print(bold("\n  会话中途装了一个新 skill，这一轮的输入计费（基础 token 价 = 1）"))
    layers = PrefixLayers(tools=2965, system=3000, history=40000)
    print(
        dim(
            f"  tools {layers.tools}、system {layers.system}、history {layers.history} token；缓存写 1.25 倍、读 0.1 倍。"
        )
    )
    print(f"  {pad('目录放在哪', 36)}{pad('前缀失效', 12)}本轮计费")
    print("  " + "─" * 60)
    placements: list[tuple[str, Literal["tools", "system", "tail"]]] = [
        ("激活工具的 name enum 里", "tools"),
        ("system prompt 里", "system"),
        ("作为一条新消息追加在末尾", "tail"),
    ]
    for label, at in placements:
        r = prefix_change_cost(layers, at)
        print(f"  {pad(label, 36)}{pad(str(r.invalidated), 12)}{fmt_hundredths(r.cost)}")
    print(
        dim(
            "\n  放在 enum 里还是 system 里只差 tools 那一层；大头是对话历史，分水岭是「改没改前缀」。"
        )
    )


# ─────────────────────────────────────────────────────────────


def exp6() -> None:
    print(bold("\n实验六：有了前缀缓存，skill 比 AGENTS.md 省在哪"))
    body = 2000
    entry = 60
    rounds = 20
    print(
        dim(
            f"  一段 {body} token 的流程知识，目录条目 {entry} token，会话 {rounds} 轮。单位：基础 token 价。"
        )
    )
    agents = resident_cost(body, rounds)
    rows: list[tuple[str, int]] = [
        ("放进 AGENTS.md（常驻）", agents),
        ("做成 skill，整场没激活", resident_cost(entry, rounds)),
        (
            "做成 skill，第 1 轮就激活",
            resident_cost(entry, rounds) + resident_cost(body, rounds, 1),
        ),
        ("做成 skill，第 5 轮激活", resident_cost(entry, rounds) + resident_cost(body, rounds, 5)),
        (
            "做成 skill，第 15 轮激活",
            resident_cost(entry, rounds) + resident_cost(body, rounds, 15),
        ),
    ]
    print(f"  {pad('放法', 30)}{pad('20 轮合计', 14)}相对 AGENTS.md")
    print("  " + "─" * 60)
    for label, cost in rows:
        print(f"  {pad(label, 30)}{pad(fmt_hundredths(cost), 14)}{(cost * 100) // agents}%")
    print(
        dim(
            f"\n  激活之后正文进了历史，之后每轮按缓存读（{CACHE_READ / 100} 倍）计费，和常驻几乎一样贵。"
        )
    )
    print(
        dim(
            "  省钱只来自「大多数会话根本不激活」。一个几乎每次都被激活的 skill，应该进 AGENTS.md。"
        )
    )


def observe() -> None:
    print(bold("L10x · 观察实验（参考实现）"))
    print(dim("跑完这些再去写 TODO。每一张表都对应一条「直觉是反的」。"))
    exp1()
    exp2()
    exp3()
    exp4()
    exp5()
    exp6()


# ── TODO ─────────────────────────────────────────────────────
#
# 七个 TODO 的契约都在 shared/skills.py 对应函数的注释里，带 ★ 的是会被 verify 抓的坑。
# 写完一个就可以跑 uv run python -m l10x.verify 看对应那一组。


def my_split_frontmatter(text: str) -> SplitResult:
    """TODO 1 ★ 切出 frontmatter 的行和正文。
    去 BOM，CRLF 和孤立 CR 都换成 LF；第一行必须恰好是 ---；结束符是之后第一个恰好是 --- 的整行。
    正文去掉开头的空行。
    """
    raise NotImplementedError("TODO 1 未实现")


def my_parse_scalar(raw: str) -> ScalarResult:
    r"""TODO 2a ★★ 单行标量。不做任何类型推断。
    支持 plain、"双引号"（转义只认 \\ \" \n \t \uXXXX，拒绝代理对）、'单引号'（'' 是 '）、行尾 ` #` 注释。
    以 [ { & * ! % @ ` | > 开头的拒绝；`- `、`? ` 开头的拒绝。
    plain 里出现 `: ` 或以 `:` 结尾时 colon 为 True（是否报错由调用方按 mode 决定）。
    """
    raise NotImplementedError("TODO 2a 未实现")


def my_block_scalar(header: str, lines: list[str]) -> BlockResult:
    r"""TODO 2b ★★ 块标量。header 是 | |- > >- 之一，lines 是带原始缩进的续行。
    缩进以第一个非空行为准；clip 固定为恰好一个末尾 \n；folded 里更深的缩进拒绝。
    """
    raise NotImplementedError("TODO 2b 未实现")


def my_cp_len(s: str) -> int:
    """TODO 3a ★ 码点长度。"""
    raise NotImplementedError("TODO 3a 未实现")


def my_validate_name(name: str) -> NameCode | None:
    """TODO 3b ★ name 校验。空 → NAME_MISSING；超过 64 个码点 → NAME_LENGTH；
    不是 ASCII 小写字母数字加单个连字符（首尾不能是连字符） → NAME_CHARSET；否则 None。
    """
    raise NotImplementedError("TODO 3b 未实现")


def my_resolve_collisions(skills: list[SkillMeta], policy: Policy) -> Resolved:
    """TODO 4 ★★ 按策略合并同名 skill。规则见 POLICY_RANK、alias_rank 和 resolve_collisions 的注释。
    胜出的是整条记录；每个败者一条 Shadow；codex 策略全留并记进 ambiguous。
    active 按 name、再按 location 排序；shadowed 按 name 排，同名的败者按策略优先级从高到低排。
    """
    raise NotImplementedError("TODO 4 未实现")


def my_render_catalog(skills: list[SkillMeta], opts: CatalogOpts) -> CatalogResult:
    """TODO 5 ★★ 渲染目录，带三阶段预算。可以用 catalog_order、catalog_desc、render_entry、wrap_catalog。
    预算按 text 的码点数算；阶段 2 从排序后的第一个开始轮转，每次加一个码点；
    阶段 3 去掉全部 description，按顺序放，第一个放不下的起全部省略。
    """
    raise NotImplementedError("TODO 5 未实现")


def my_resolve_skill_resource(skill: SkillMeta, rel: str) -> SafePath:
    """TODO 6 ★ 把 skill 资源路径解析到 skill 目录之内。用 safe_path，不要自己拼字符串。
    解析结果是目录本身（real_rel 为 '.'）时返回 INVALID。
    """
    raise NotImplementedError("TODO 6 未实现")


def my_script_approval(a: ApprovalInput) -> ApprovalResult:
    """TODO 7 ★★ 一条命令要不要问人。可以用 DANGEROUS_PATTERNS 和 SHELL_META；
    Bash / Bash(cmd) / Bash(prefix:*) 三种规则的匹配自己写，不要直接调 match_allowed。
    untrusted → deny；危险模式即使被预批准也要 ask；没被精确命中 → ask；哈希缺失或变了 → ask；否则 auto。
    reasons 依次是 DANGEROUS:<id>…、NOT_PREAPPROVED、NOT_APPROVED 或 HASH_CHANGED。
    """
    raise NotImplementedError("TODO 7 未实现")


_ = (
    my_split_frontmatter,
    my_parse_scalar,
    my_block_scalar,
    my_cp_len,
    my_validate_name,
    my_resolve_collisions,
    my_render_catalog,
    my_resolve_skill_resource,
    my_script_approval,
    catalog_order,
)

if __name__ == "__main__":
    observe()
    print(
        dim(
            "\n  下一步：实现文件下半部分的七个 TODO，然后跑 pnpm verify:l10x（或 uv run python -m l10x.verify）。"
        )
        + dim("\n  想先确认测试本身是对的，跑 SKILLS_IMPL=shared 下的 verify。")
        + dim("\n  观察实验：pnpm skills / uv run python -m l10x.skills\n")
    )
