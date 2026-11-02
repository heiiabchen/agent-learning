"""
Coding agent 的地基：编辑语义、字节层、计划校验、验证解析、终止谓词。

★★ 这一节的中心论点：coding agent 的核心难点不是「让模型写出对的代码」，
而是「让『改动被正确落盘』这件事具备可判定性」。

前 16 节的每个组件失败时都会给信号。代码编辑是第一个
「失败时看起来完全像成功」的子系统——打错缩进、命中第一处而非唯一处、
混合行尾，全都不抛异常、exit code 是 0。

所以这个模块的每一个返回值都带着**可判定的失败原因**。
参考实现故意选择：
  · 多处匹配 → NOT_UNIQUE（Anthropic），不是「改第一处」（aider diff）
  · 批量编辑全有或全无（不是 aider 的逐条落盘）
  · 降级只到 blockIndent，永不 strip()、永不相似度
  · 行切分只认 \\r\\n / \\n / \\r（Python 的 splitlines 会在 8 个码点上切）

本文件零 DOM、尽量零 IO：apply_edits / plan / parse / can_stop 全是纯函数。
Workspace 那一层需要 IO，单独放在下面，且依赖 shared.sandbox。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from dataclasses import dataclass
from typing import Literal

from shared.sandbox import safe_path

# ═══════════════════════════════════════════════════════════════════
# 一、行切分 —— 双语言一致性的地基
# ═══════════════════════════════════════════════════════════════════


def split_lines(s: str) -> list[str]:
    """★ 只在 \\r\\n / \\n / \\r 上分行。

    Python 的 str.splitlines() 还会在 \\v \\f \\x1c \\x1d \\x1e \\x85 \\u2028 \\u2029
    上切——那 8 个码点一旦出现在文件里，TS/Python 的输出就会分叉。
    这一节要切的是**文件内容**，所以绝不能用 splitlines。
    """
    if len(s) == 0:
        return []
    out: list[str] = []
    start = 0
    i = 0
    n = len(s)
    while i < n:
        c = ord(s[i])
        if c == 0x0D:
            # \\r\\n 算一个结束符
            out.append(s[start:i])
            if i + 1 < n and ord(s[i + 1]) == 0x0A:
                i += 1
            start = i + 1
        elif c == 0x0A:
            out.append(s[start:i])
            start = i + 1
        i += 1
    # ★ 末尾换行不产生空行：`a\\n` → ["a"]，`a\\n\\n` → ["a", ""]
    # 循环里每遇到结束符就 push；若以换行结束则 start === length，不再 push。
    if start < n:
        out.append(s[start:])
    return out


Eol = Literal["\n", "\r\n", "\r", "mixed", "none"]


def detect_eol(s: str) -> Eol:
    """探测文件的主导行尾。混合时返回 mixed，并保留逐行信息供写回。"""
    lf = 0
    crlf = 0
    cr = 0
    i = 0
    n = len(s)
    while i < n:
        if ord(s[i]) == 0x0D:
            if i + 1 < n and ord(s[i + 1]) == 0x0A:
                crlf += 1
                i += 1
            else:
                cr += 1
        elif ord(s[i]) == 0x0A:
            lf += 1
        i += 1
    kinds = sum(1 for x in (lf > 0, crlf > 0, cr > 0) if x)
    if kinds == 0:
        return "none"
    if kinds > 1:
        return "mixed"
    if crlf > 0:
        return "\r\n"
    if cr > 0:
        return "\r"
    return "\n"


def join_lines(lines: list[str], eol: Literal["\n", "\r\n", "\r"], trailing_nl: bool) -> str:
    """用指定行尾把行重新拼回去。不补末尾换行——NL-1。"""
    if len(lines) == 0:
        return ""
    body = eol.join(lines)
    return body + eol if trailing_nl else body


def has_trailing_nl(s: str) -> bool:
    return s.endswith("\n") or s.endswith("\r")


@dataclass
class StripBomResult:
    text: str
    bom: str


def strip_bom(s: str) -> StripBomResult:
    if s and ord(s[0]) == 0xFEFF:
        return StripBomResult(text=s[1:], bom="\ufeff")
    # UTF-8 BOM 以三个字节出现时，解码后是 U+FEFF；上面已覆盖。
    return StripBomResult(text=s, bom="")


# ═══════════════════════════════════════════════════════════════════
# 二、匹配阶梯
# ═══════════════════════════════════════════════════════════════════

MatchTier = Literal["exact", "eol", "blockIndent"]


@dataclass
class MatchHit:
    """字节偏移（在 content 里）。"""

    start: int
    end: int
    #: 1-based 行号。
    line: int


@dataclass
class TierResult:
    tier: MatchTier
    match_count: int
    hits: list[MatchHit]


#: 缩进敏感的扩展名。这些文件禁用 strip 语义，blockIndent 也要格外小心。
INDENT_SENSITIVE: frozenset[str] = frozenset(
    {
        ".py",
        ".pyi",
        ".yaml",
        ".yml",
        ".sass",
        ".styl",
        ".hs",
        ".nim",
        ".coffee",
        ".pug",
        ".mk",
    }
)


def is_indent_sensitive(path: str) -> bool:
    base = re.split(r"[/\\]", path)[-1] if path else path
    if base in ("Makefile", "makefile", "GNUmakefile"):
        return True
    dot = base.rfind(".")
    if dot < 0:
        return False
    return base[dot:].lower() in INDENT_SENSITIVE


def _line_number_at(s: str, offset: int) -> int:
    n = 1
    i = 0
    length = len(s)
    while i < offset and i < length:
        if ord(s[i]) == 0x0A:
            n += 1
        elif ord(s[i]) == 0x0D:
            n += 1
            if i + 1 < offset and ord(s[i + 1]) == 0x0A:
                i += 1
        i += 1
    return n


def match_exact(content: str, old: str) -> list[MatchHit]:
    """exact：逐字节子串搜索，返回所有不重叠命中。"""
    if len(old) == 0:
        return []
    hits: list[MatchHit] = []
    from_ = 0
    while from_ <= len(content) - len(old):
        i = content.find(old, from_)
        if i < 0:
            break
        hits.append(MatchHit(start=i, end=i + len(old), line=_line_number_at(content, i)))
        from_ = i + len(old)
    return hits


@dataclass
class _NormEol:
    norm: str
    #: normToOrig[i] = norm 里第 i 个字符对应的原串起始字节；末尾哨兵 = len(s)
    norm_to_orig: list[int]


def _normalize_eol(s: str) -> _NormEol:
    """把文本的行尾统一成 LF。

    ★ CRLF 在 norm 里是一个 \\n，但消耗原串两个字节——哨兵保证 end 落在 \\n 之后。
    """
    norm_parts: list[str] = []
    norm_to_orig: list[int] = []
    i = 0
    n = len(s)
    while i < n:
        o = ord(s[i])
        if o == 0x0D:
            norm_to_orig.append(i)
            norm_parts.append("\n")
            if i + 1 < n and ord(s[i + 1]) == 0x0A:
                i += 1
        elif o == 0x0A:
            norm_to_orig.append(i)
            norm_parts.append("\n")
        else:
            norm_to_orig.append(i)
            norm_parts.append(s[i])
        i += 1
    norm_to_orig.append(n)
    return _NormEol(norm="".join(norm_parts), norm_to_orig=norm_to_orig)


def match_eol(content: str, old: str) -> list[MatchHit]:
    """eol：忽略行尾差异的匹配。命中位置映射回原 content。"""
    c = _normalize_eol(content)
    o = _normalize_eol(old)
    if len(o.norm) == 0:
        return []
    hits: list[MatchHit] = []
    from_ = 0
    while from_ <= len(c.norm) - len(o.norm):
        i = c.norm.find(o.norm, from_)
        if i < 0:
            break
        start = c.norm_to_orig[i]
        end = c.norm_to_orig[i + len(o.norm)]
        hits.append(MatchHit(start=start, end=end, line=_line_number_at(content, start)))
        from_ = i + len(o.norm)
    return hits


@dataclass
class BlockIndentResult:
    hits: list[MatchHit]
    indent_shift: int


def match_block_indent(content: str, old: str) -> BlockIndentResult:
    """blockIndent：所有非空行共享同一个缩进偏移量时才算命中。

    ★ aider 的正确实现：`if len(add) != 1: return`——偏移量必须唯一。
    写回时用原位置的实际缩进 + new 的相对缩进（FUZZ-6）。
    """
    content_lines = split_lines(content)
    old_lines = split_lines(old)
    if len(old_lines) == 0:
        return BlockIndentResult(hits=[], indent_shift=0)

    old_indents = [_leading_ws(line) for line in old_lines]
    old_bodies = [line[len(old_indents[i]) :] for i, line in enumerate(old_lines)]
    # 非空行的缩进集合
    shifts = {len(w) for i, w in enumerate(old_indents) if len(old_bodies[i]) > 0}
    # 允许全空行；若非空行缩进不一致，这一档直接失败（对 old 本身）
    if len(shifts) > 1:
        return BlockIndentResult(hits=[], indent_shift=0)
    old_shift = next(iter(shifts)) if len(shifts) == 1 else 0

    hits: list[MatchHit] = []
    for i in range(0, len(content_lines) - len(old_lines) + 1):
        ok = True
        content_shift: int | None = None
        for j in range(len(old_lines)):
            cl = content_lines[i + j]
            c_ind = _leading_ws(cl)
            c_body = cl[len(c_ind) :]
            o_body = old_bodies[j]
            if len(o_body) == 0:
                # old 的空行：content 对应行也必须是空（或只有空白）
                if len(c_body) != 0:
                    ok = False
                    break
                continue
            if c_body != o_body:
                ok = False
                break
            shift = len(c_ind) - old_shift
            if shift < 0:
                ok = False
                break
            # ★ 所有非空行的偏移量必须一致
            if content_shift is None:
                content_shift = shift
            elif content_shift != shift:
                ok = False
                break
            # content 行的缩进必须是 leadingWs 精确等于 shift+oldShift
            if len(c_ind) != shift + old_shift:
                ok = False
                break
        if ok and content_shift is not None:
            # 算字节范围
            start = _offset_of_line(content, i)
            end = (
                len(content)
                if i + len(old_lines) >= len(content_lines)
                else _offset_of_line(content, i + len(old_lines))
            )
            hits.append(MatchHit(start=start, end=end, line=i + 1))
    return BlockIndentResult(hits=hits, indent_shift=0)


def _leading_ws(s: str) -> str:
    i = 0
    while i < len(s) and s[i] in (" ", "\t"):
        i += 1
    return s[:i]


def _offset_of_line(s: str, line_index: int) -> int:
    # line_index 0-based
    n = 0
    i = 0
    while i < len(s) and n < line_index:
        c = ord(s[i])
        if c == 0x0D:
            i += 1
            if i < len(s) and ord(s[i]) == 0x0A:
                i += 1
            n += 1
        elif c == 0x0A:
            i += 1
            n += 1
        else:
            i += 1
    return i


@dataclass
class MatchWithTiersResult:
    tier_results: dict[MatchTier, int]
    hit: TierResult | None
    not_unique: TierResult | None


def match_with_tiers(
    content: str,
    old: str,
    path: str = "",
) -> MatchWithTiersResult:
    """按 exact → eol → blockIndent 顺序尝试。

    ★★ 任一档 matchCount > 1 → 立刻停，返回 NOT_UNIQUE 所需信息。
    不得继续往更宽松的档试（FUZZ-2）。
    """
    tier_results: dict[MatchTier, int] = {"exact": 0, "eol": 0, "blockIndent": 0}

    exact = match_exact(content, old)
    tier_results["exact"] = len(exact)
    if len(exact) > 1:
        return MatchWithTiersResult(
            tier_results=tier_results,
            hit=None,
            not_unique=TierResult(tier="exact", match_count=len(exact), hits=exact),
        )
    if len(exact) == 1:
        return MatchWithTiersResult(
            tier_results=tier_results,
            hit=TierResult(tier="exact", match_count=1, hits=exact),
            not_unique=None,
        )

    eol = match_eol(content, old)
    tier_results["eol"] = len(eol)
    if len(eol) > 1:
        return MatchWithTiersResult(
            tier_results=tier_results,
            hit=None,
            not_unique=TierResult(tier="eol", match_count=len(eol), hits=eol),
        )
    if len(eol) == 1:
        return MatchWithTiersResult(
            tier_results=tier_results,
            hit=TierResult(tier="eol", match_count=1, hits=eol),
            not_unique=None,
        )

    # 缩进敏感文件：仍然允许 blockIndent（相对缩进偏移），但调用方禁止 strip 档——
    # 我们根本没有 strip 档，所以这里直接跑 blockIndent。
    bi = match_block_indent(content, old).hits
    tier_results["blockIndent"] = len(bi)
    if len(bi) > 1:
        return MatchWithTiersResult(
            tier_results=tier_results,
            hit=None,
            not_unique=TierResult(tier="blockIndent", match_count=len(bi), hits=bi),
        )
    if len(bi) == 1:
        # 对缩进敏感文件，blockIndent 命中要标出来，写回逻辑另行处理
        _ = path
        return MatchWithTiersResult(
            tier_results=tier_results,
            hit=TierResult(tier="blockIndent", match_count=1, hits=bi),
            not_unique=None,
        )

    return MatchWithTiersResult(tier_results=tier_results, hit=None, not_unique=None)


# ═══════════════════════════════════════════════════════════════════
# 三、apply_edits —— 纯函数，零 IO
# ═══════════════════════════════════════════════════════════════════

EditFailReason = Literal[
    "NOT_UNIQUE",
    "NO_MATCH",
    "NO_OP",
    "EMPTY_OLD",
    "OVERLAP",
    "ALREADY_APPLIED",
    "READ_REQUIRED",
    "STALE_READ",
    "TRUNCATED_READ",
    "FILE_NOT_FOUND",
    "DENIED",
]


@dataclass
class EditRequest:
    old: str
    new: str
    #: 默认 "one"：必须唯一。设 "all" 时改每一处（EDIT-4）。
    occurrence: Literal["one", "all"] | None = None


@dataclass
class AppliedEdit:
    tier: MatchTier
    start: int
    end: int
    line: int


@dataclass
class EditOk:
    new_content: str
    applied: list[AppliedEdit]
    warnings: list[str]
    tier_results: dict[MatchTier, int]
    ok: Literal[True] = True
    path: str | None = None
    requires_confirmation: bool | None = None


@dataclass
class EditErr:
    reason: EditFailReason
    failed_at: int
    match_count: int
    match_lines: list[int]
    #: 错误信息里的 old 必须逐字节等于输入（EDIT-9）。
    old: str
    warnings: list[str]
    message: str
    ok: Literal[False] = False
    already_applied: bool | None = None
    nearest: str | None = None
    tier_results: dict[MatchTier, int] | None = None
    path: str | None = None
    requires_confirmation: bool | None = None


EditResult = EditOk | EditErr


def _is_whitespace_only(s: str) -> bool:
    return len(s) > 0 and re.fullmatch(r"\s*", s) is not None


@dataclass
class _Planned:
    index: int
    start: int
    end: int
    replacement: str
    tier: MatchTier
    line: int


def apply_edits(content: str, edits: list[EditRequest], path: str = "") -> EditResult:
    """在内存里应用一组编辑。全有或全无。

    ★ 定位全部基于**原文件**（BATCH-3），不是串行 replace。
    ★ 重叠 → OVERLAP，零写入（BATCH-1）。
    """
    warnings: list[str] = []
    eol = detect_eol(content)
    if eol == "mixed":
        warnings.append("MIXED_EOL")

    bom = strip_bom(content)
    body = bom.text
    # 注意：匹配在去 BOM 后的 body 上做；写回时加回 BOM（BOM-1）

    planned: list[_Planned] = []
    last_tier_results: dict[MatchTier, int] = {"exact": 0, "eol": 0, "blockIndent": 0}

    for i, e in enumerate(edits):
        if e.old == "" or _is_whitespace_only(e.old):
            return EditErr(
                reason="EMPTY_OLD",
                failed_at=i,
                match_count=0,
                match_lines=[],
                old=e.old,
                warnings=warnings,
                message="old 不能为空或全是空白。空 SEARCH 不得退化成追加或全文替换。",
            )
        if e.new == e.old:
            return EditErr(
                reason="NO_OP",
                failed_at=i,
                match_count=0,
                match_lines=[],
                old=e.old,
                warnings=warnings,
                message="new 与 old 相同，这是空操作。",
            )

        mwt = match_with_tiers(body, e.old, path)
        last_tier_results = mwt.tier_results
        tier_results = mwt.tier_results
        hit = mwt.hit
        not_unique = mwt.not_unique

        if not_unique is not None:
            if e.occurrence == "all":
                for h in not_unique.hits:
                    planned.append(
                        _Planned(
                            index=i,
                            start=h.start,
                            end=h.end,
                            replacement=_rewrite_with_tier(body, h, e.new, not_unique.tier),
                            tier=not_unique.tier,
                            line=h.line,
                        )
                    )
                continue
            return EditErr(
                reason="NOT_UNIQUE",
                failed_at=i,
                match_count=not_unique.match_count,
                match_lines=[h.line for h in not_unique.hits],
                old=e.old,
                tier_results=tier_results,
                warnings=warnings,
                message=(
                    f"old 在文件中出现 {not_unique.match_count} 次"
                    f"（行 {', '.join(str(h.line) for h in not_unique.hits)}）。"
                    f"扩大上下文使它唯一，或设 occurrence: \"all\"。"
                ),
            )

        if hit is None:
            already = len(e.new) > 0 and (e.new in body) and (e.old not in body)
            return EditErr(
                reason="NO_MATCH",
                failed_at=i,
                match_count=0,
                match_lines=[],
                old=e.old,
                already_applied=True if already else None,
                nearest=_find_nearest(body, e.old),
                tier_results=tier_results,
                warnings=warnings,
                message=(
                    "old 不在文件中，但 new 已在——这个编辑可能已经生效过了。"
                    if already
                    else (
                        "old 在文件中未找到。tierResults="
                        + json.dumps(tier_results, separators=(",", ":"))
                    )
                ),
            )

        h = hit.hits[0]
        planned.append(
            _Planned(
                index=i,
                start=h.start,
                end=h.end,
                replacement=_rewrite_with_tier(body, h, e.new, hit.tier),
                tier=hit.tier,
                line=h.line,
            )
        )

    # 重叠检查（按原文件坐标）
    sorted_planned = sorted(planned, key=lambda p: (p.start, p.end))
    for i in range(1, len(sorted_planned)):
        if sorted_planned[i].start < sorted_planned[i - 1].end:
            return EditErr(
                reason="OVERLAP",
                failed_at=sorted_planned[i].index,
                match_count=0,
                match_lines=[],
                old=edits[sorted_planned[i].index].old,
                warnings=warnings,
                message=(
                    f"第 {sorted_planned[i].index} 条与第 "
                    f"{sorted_planned[i - 1].index} 条的目标区间重叠。"
                ),
            )

    # 从后往前替换，避免偏移
    out = body
    applied: list[AppliedEdit] = []
    for i in range(len(sorted_planned) - 1, -1, -1):
        p = sorted_planned[i]
        out = out[: p.start] + p.replacement + out[p.end :]
        applied.insert(0, AppliedEdit(tier=p.tier, start=p.start, end=p.end, line=p.line))

    # 恢复 BOM；行尾：若原文件非 mixed，把 replacement 里的行尾统一成原文件风格
    if eol in ("\n", "\r\n", "\r"):
        out = _unify_eol(out, eol)
    trailing = has_trailing_nl(content)
    # unifyEol 可能影响末尾；按原文件是否有 trailing nl 校准
    if trailing and not has_trailing_nl(out):
        out = out + ("\r\n" if eol == "\r\n" else "\r" if eol == "\r" else "\n")
    if not trailing and has_trailing_nl(out):
        out = re.sub(r"(?:\r\n|\n|\r)$", "", out)

    return EditOk(
        new_content=bom.bom + out,
        applied=applied,
        warnings=warnings,
        tier_results=last_tier_results,
    )


def _rewrite_with_tier(content: str, hit: MatchHit, new_text: str, tier: MatchTier) -> str:
    if tier == "exact":
        return new_text
    if tier == "eol":
        # 用命中区域的主导行尾来写 new
        region = content[hit.start : hit.end]
        e = detect_eol(region)
        target: Literal["\n", "\r\n", "\r"] = e if e in ("\r\n", "\r", "\n") else "\n"
        return _unify_eol(new_text, target)
    # blockIndent：把 new 的相对缩进接到命中位置的实际缩进上
    region = content[hit.start : hit.end]
    region_lines = split_lines(region)
    new_lines = split_lines(new_text)
    if len(region_lines) == 0 or len(new_lines) == 0:
        return new_text
    base_indent = _leading_ws(region_lines[0])
    new_base_line = next(
        (line for line in new_lines if len(line.strip()) > 0), new_lines[0]
    )
    new_base = _leading_ws(new_base_line)
    rebuilt = []
    for line in new_lines:
        if len(line.strip()) == 0:
            rebuilt.append(line)
            continue
        ind = _leading_ws(line)
        body = line[len(ind) :]
        rel = max(0, len(ind) - len(new_base))
        rebuilt.append(base_indent + (" " * rel) + body)
    e = detect_eol(region)
    target = e if e in ("\r\n", "\r", "\n") else "\n"
    trailing = has_trailing_nl(region)
    return join_lines(rebuilt, target, trailing)  # type: ignore[arg-type]


def _unify_eol(s: str, eol: Literal["\n", "\r\n", "\r"]) -> str:
    lines = split_lines(s)
    return join_lines(lines, eol, has_trailing_nl(s))


def _find_nearest(content: str, old: str) -> str | None:
    # 极简：取 old 的第一行在文件中的第一次出现，返回前后各一行作为提示
    old_lines = split_lines(old)
    first = old_lines[0] if old_lines else None
    if not first or len(first.strip()) < 3:
        return None
    idx = content.find(first.strip())
    if idx < 0:
        return None
    line = _line_number_at(content, idx)
    lines = split_lines(content)
    from_ = max(0, line - 2)
    to = min(len(lines), line + 1)
    return "\n".join(lines[from_:to])


# ═══════════════════════════════════════════════════════════════════
# 四、计划作为可校验的数据结构
# ═══════════════════════════════════════════════════════════════════

PlanStepKind = Literal["read", "edit", "verify", "command", "other"]


@dataclass
class PlanStep:
    id: str
    kind: PlanStepKind
    targets: list[str]
    depends_on: list[str]
    status: Literal["pending", "done", "skipped"] | None = None


@dataclass
class Plan:
    steps: list[PlanStep]


PlanFailReason = Literal[
    "EMPTY",
    "DUPLICATE_STEP_ID",
    "CYCLE",
    "DANGLING_DEP",
    "NO_VERIFY_STEP",
    "EDIT_WITHOUT_READ",
    "LOST_COMPLETED_STEP",
    "MISSING_REASON",
    "PLAN_THRASHING",
]


@dataclass
class PlanOk:
    ok: Literal[True] = True


@dataclass
class PlanErr:
    reason: PlanFailReason
    detail: list[str]
    message: str
    ok: Literal[False] = False


PlanResult = PlanOk | PlanErr


def validate_plan(plan: Plan) -> PlanResult:
    if not plan.steps or len(plan.steps) == 0:
        return PlanErr(reason="EMPTY", detail=[], message="计划不能为空。")
    ids: dict[str, int] = {}
    dup: list[str] = []
    for s in plan.steps:
        n = ids.get(s.id, 0) + 1
        ids[s.id] = n
        if n == 2:
            dup.append(s.id)
    if dup:
        return PlanErr(
            reason="DUPLICATE_STEP_ID",
            detail=dup,
            message=f"重复的 step id：{', '.join(dup)}",
        )

    by_id = {s.id: s for s in plan.steps}
    dangling: list[str] = []
    for s in plan.steps:
        for d in s.depends_on:
            if d not in by_id:
                dangling.append(f"{s.id}→{d}")
    if dangling:
        return PlanErr(
            reason="DANGLING_DEP",
            detail=dangling,
            message=f"依赖指向不存在的 id：{', '.join(dangling)}",
        )

    cycle = _find_cycle(plan.steps)
    if cycle:
        return PlanErr(
            reason="CYCLE",
            detail=cycle,
            message=f"依赖图有环：{' → '.join(cycle)}",
        )

    if not any(s.kind == "verify" for s in plan.steps):
        return PlanErr(
            reason="NO_VERIFY_STEP",
            detail=[],
            message='计划里至少要有一个 kind === "verify" 的步骤。',
        )

    # EDIT_WITHOUT_READ：每个 edit 的每个 target，祖先里要有 read 覆盖它
    missing: list[str] = []
    for e in (s for s in plan.steps if s.kind == "edit"):
        ancestors = _ancestor_ids(e.id, by_id)
        for t in e.targets:
            covered = False
            for aid in ancestors:
                a = by_id[aid]
                if a.kind == "read" and t in a.targets:
                    covered = True
                    break
            if not covered:
                missing.append(f"{e.id}:{t}")
    if missing:
        return PlanErr(
            reason="EDIT_WITHOUT_READ",
            detail=missing,
            message=f"这些编辑没有先读：{', '.join(missing)}",
        )

    return PlanOk()


def _find_cycle(steps: list[PlanStep]) -> list[str] | None:
    by_id = {s.id: s for s in steps}
    state: dict[str, int] = {}
    stack: list[str] = []

    def dfs(id_: str) -> list[str] | None:
        state[id_] = 1
        stack.append(id_)
        for d in by_id.get(id_).depends_on if by_id.get(id_) else []:
            st = state.get(d, 0)
            if st == 1:
                i = stack.index(d)
                return [*stack[i:], d]
            if st == 0:
                c = dfs(d)
                if c:
                    return c
        stack.pop()
        state[id_] = 2
        return None

    for s in steps:
        if state.get(s.id, 0) == 0:
            c = dfs(s.id)
            if c:
                return c
    return None


def _ancestor_ids(id_: str, by_id: dict[str, PlanStep]) -> set[str]:
    out: set[str] = set()
    stack = list(by_id[id_].depends_on if id_ in by_id else [])
    while stack:
        x = stack.pop()
        if x in out:
            continue
        out.add(x)
        if x in by_id:
            stack.extend(by_id[x].depends_on)
    return out


@dataclass
class ReviseOpts:
    revise_count: int
    max_revises: int
    reason: str | None = None


def revise_plan(prev: Plan, next: Plan, opts: ReviseOpts) -> PlanResult:
    if not opts.reason or opts.reason.strip() == "":
        return PlanErr(
            reason="MISSING_REASON",
            detail=[],
            message="revise_plan 必须带 reason。",
        )
    if opts.revise_count >= opts.max_revises:
        return PlanErr(
            reason="PLAN_THRASHING",
            detail=[str(opts.revise_count)],
            message=f"修订次数已达上限 {opts.max_revises}。",
        )
    prev_done = [s for s in prev.steps if s.status == "done"]
    for d in prev_done:
        n = next((s for s in next.steps if s.id == d.id), None)
        if n is None:
            return PlanErr(
                reason="LOST_COMPLETED_STEP",
                detail=[d.id],
                message=f"不得删除已完成的 step {d.id}。",
            )
        same_targets = len(n.targets) == len(d.targets) and all(
            t == d.targets[i] for i, t in enumerate(n.targets)
        )
        if not same_targets:
            return PlanErr(
                reason="LOST_COMPLETED_STEP",
                detail=[d.id],
                message=f"不得修改已完成 step {d.id} 的 targets。",
            )
    return validate_plan(next)


Phase = Literal["plan", "execute"]


def tools_for(phase: Phase) -> list[str]:
    if phase == "plan":
        return ["read_file", "list_dir", "grep", "submit_plan", "revise_plan"]
    return [
        "read_file",
        "list_dir",
        "grep",
        "edit_file",
        "create_file",
        "run_command",
        "revise_plan",
        "give_up",
    ]


@dataclass
class ToolLogEntry:
    seq: int
    tool: str
    path: str | None = None
    step_id: str | None = None


@dataclass
class Adherence:
    unplanned_files: list[str]
    unvisited_files: list[str]
    order_violations: list[str]
    verify_ran_after_last_edit: bool


def adherence(plan: Plan, log: list[ToolLogEntry]) -> Adherence:
    planned_edit = {
        _normalize_rel(t)
        for s in plan.steps
        if s.kind == "edit"
        for t in s.targets
    }
    actual_edit = {
        p
        for e in log
        if e.tool in ("edit_file", "create_file")
        for p in [_normalize_rel(e.path or "")]
        if p
    }
    unplanned_files = sorted(p for p in actual_edit if p not in planned_edit)
    unvisited_files = sorted(p for p in planned_edit if p not in actual_edit)

    seq_of: dict[str, int] = {}
    for e in log:
        if e.step_id and e.step_id not in seq_of:
            seq_of[e.step_id] = e.seq
    order_violations: list[str] = []
    for s in plan.steps:
        s_seq = seq_of.get(s.id)
        if s_seq is None:
            continue
        for d in s.depends_on:
            d_seq = seq_of.get(d)
            if d_seq is not None and s_seq < d_seq:
                order_violations.append(f"{s.id} before {d}")

    last_edit_seq = -1
    last_verify_seq = -1
    for e in log:
        if e.tool in ("edit_file", "create_file"):
            last_edit_seq = max(last_edit_seq, e.seq)
        if e.tool in ("run_command", "verify"):
            last_verify_seq = max(last_verify_seq, e.seq)
    verify_ran_after_last_edit = last_verify_seq > last_edit_seq and last_edit_seq >= 0

    return Adherence(
        unplanned_files=unplanned_files,
        unvisited_files=unvisited_files,
        order_violations=order_violations,
        verify_ran_after_last_edit=verify_ran_after_last_edit,
    )


def _normalize_rel(p: str) -> str:
    return re.sub(r"^\./", "", p.replace("\\", "/"))


# ═══════════════════════════════════════════════════════════════════
# 五、测试输出解析与终止谓词
# ═══════════════════════════════════════════════════════════════════

ParserConfidence = Literal["exact", "unparsed"]


@dataclass
class VerifyResult:
    runner: str
    passed: int
    failed: int
    skipped: int
    collected: int
    confidence: ParserConfidence
    exit_code: int


def is_green(v: VerifyResult) -> bool:
    if v.confidence != "exact":
        return False
    if v.collected == 0:
        return False
    if v.failed > 0:
        return False
    if v.exit_code != 0:
        return False
    return True


_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def strip_ansi(s: str) -> str:
    """去掉 ANSI 转义。"""
    return _ANSI_RE.sub("", s)


# ★ 逐行匹配，正则一律不带 re.M、空白只写 [ \t]、大小写不敏感时加 re.A。
# JS 的 m 标志在 \r、\u2028、\u2029 后也算行首，Python 的 re.M 只认 \n；
# JS 的 \s 含 \uFEFF 不含 \x1c，Python 正好相反；re.I 不加 re.A 时 ſ 会匹配 s。
# 同一段输出会一绿一红（PARSE-8/9）。用 [0-9] 而不是 \d 也是同一个理由。
# 每项：名字、正则、summary 行是否必须以行结束符收尾（PARSE-6）、取值函数。
_RUNNERS: list[tuple[str, re.Pattern[str], bool, object]] = [
    (
        "pytest",
        re.compile(r"^=+ ([^=]+?) in [0-9.]+s =+$"),
        True,
        lambda m: _parse_pytest_parts(m.group(1)),
    ),
    (
        "vitest",
        re.compile(
            r"Tests[ \t]+([0-9]+)[ \t]+passed(?:[ \t]+\|[ \t]+([0-9]+)[ \t]+failed)?"
            r"(?:[ \t]+\|[ \t]+([0-9]+)[ \t]+skipped)?",
            re.I | re.A,
        ),
        False,
        lambda m: {
            "passed": int(m.group(1)),
            "failed": int(m.group(2) or 0),
            "skipped": int(m.group(3) or 0),
        },
    ),
    (
        "jest",
        re.compile(
            r"Tests:[ \t]+([0-9]+)[ \t]+failed,[ \t]+([0-9]+)[ \t]+passed,"
            r"[ \t]+([0-9]+)[ \t]+total",
            re.I | re.A,
        ),
        False,
        lambda m: {
            "failed": int(m.group(1)),
            "passed": int(m.group(2)),
            "collected": int(m.group(3)),
        },
    ),
    (
        "jest",
        re.compile(r"Tests:[ \t]+([0-9]+)[ \t]+passed,[ \t]+([0-9]+)[ \t]+total", re.I | re.A),
        False,
        lambda m: {
            "passed": int(m.group(1)),
            "failed": 0,
            "collected": int(m.group(2)),
        },
    ),
    (
        "go",
        re.compile(r"^PASS$"),
        False,
        lambda m: {"passed": 1, "failed": 0, "skipped": 0},
    ),
    (
        "go",
        re.compile(r"^FAIL$"),
        False,
        lambda m: {"passed": 0, "failed": 1, "skipped": 0},
    ),
    (
        "cargo",
        re.compile(
            r"test result:[ \t]+ok\.[ \t]+([0-9]+)[ \t]+passed;[ \t]+([0-9]+)[ \t]+failed;"
            r"[ \t]+([0-9]+)[ \t]+ignored"
        ),
        False,
        lambda m: {
            "passed": int(m.group(1)),
            "failed": int(m.group(2)),
            "skipped": int(m.group(3)),
        },
    ),
]

_NO_TESTS_RAN = re.compile(r"no tests ran", re.I | re.A)


def parse_test_output(raw: str, exit_code: int, runner_hint: str = "") -> VerifyResult:
    """解析测试输出。★ 反向扫描 summary（PARSE-7），截断 → unparsed（PARSE-6）。

    ★ 先用 split_lines 切行，再逐行匹配——「什么算一行」只在 split_lines 里定义一次。
    """
    text = strip_ansi(raw)

    # pytest「no tests ran」
    if _NO_TESTS_RAN.search(text):
        return VerifyResult(
            runner="pytest",
            passed=0,
            failed=0,
            skipped=0,
            collected=0,
            confidence="exact",
            exit_code=exit_code,
        )

    lines = split_lines(text)
    last_terminated = has_trailing_nl(text)

    # ★ 反向：找最后一次命中。位置按（行号，行内偏移）比较。
    best: tuple[str, tuple[int, int], dict[str, int]] | None = None
    for name, pattern, needs_eol, parse in _RUNNERS:
        if runner_hint and name != runner_hint and runner_hint != "auto":
            continue
        for i in range(len(lines) - 1, -1, -1):
            if needs_eol and i == len(lines) - 1 and not last_terminated:
                continue
            last: re.Match[str] | None = None
            for m in pattern.finditer(lines[i]):
                last = m
            if last is None:
                continue
            pos = (i, last.start())
            if best is None or pos > best[1]:
                best = (name, pos, parse(last))  # type: ignore[operator]
            break

    if best is None:
        return VerifyResult(
            runner=runner_hint or "unknown",
            passed=0,
            failed=0,
            skipped=0,
            collected=0,
            confidence="unparsed",
            exit_code=exit_code,
        )

    name, _idx, partial = best
    passed = partial.get("passed", 0)
    failed = partial.get("failed", 0)
    skipped = partial.get("skipped", 0)
    collected = partial.get("collected", passed + failed + skipped)
    return VerifyResult(
        runner=name,
        passed=passed,
        failed=failed,
        skipped=skipped,
        collected=collected,
        confidence="exact",
        exit_code=exit_code,
    )


def _parse_pytest_parts(parts: str) -> dict[str, int]:
    # "3 passed, 1 skipped" / "2 failed, 3 passed" / "1 error"
    passed = 0
    failed = 0
    skipped = 0
    for bit in parts.split(","):
        m = re.match(r"[ \t]*([0-9]+)[ \t]+([A-Za-z]+)", bit)
        if not m:
            continue
        n = int(m.group(1))
        k = m.group(2)
        if k.startswith("passed"):
            passed = n
        elif k.startswith("failed") or k.startswith("error"):
            failed += n
        elif k.startswith("skipped") or k.startswith("xfailed") or k.startswith("xpassed"):
            skipped += n
    return {
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "collected": passed + failed + skipped,
    }


@dataclass
class Baseline:
    collected: int
    skipped: int
    test_file_hashes: dict[str, str]


@dataclass
class StopState:
    finished: bool
    gave_up: bool
    last_edit_seq: int
    last_verify_seq: int
    verify: VerifyResult | None
    unplanned_files: list[str]
    revised_for_unplanned: bool
    current_test_file_hashes: dict[str, str]
    give_up_reason: str | None = None


@dataclass
class StopDecision:
    can_stop: bool
    outcome: Literal["success", "gave_up", "continue"]
    reasons: list[str]


def can_stop(state: StopState, baseline: Baseline) -> StopDecision:
    if state.gave_up:
        if state.give_up_reason and state.give_up_reason.strip():
            return StopDecision(can_stop=True, outcome="gave_up", reasons=[])
        return StopDecision(can_stop=False, outcome="continue", reasons=["give_up 缺 reason"])

    reasons: list[str] = []
    if not state.verify:
        reasons.append("从未跑 verify")
    else:
        if state.verify.confidence != "exact":
            reasons.append("parserConfidence=unparsed")
        if state.verify.collected == 0:
            reasons.append("collected=0")
        if state.verify.failed > 0:
            reasons.append("有失败用例")
        if state.verify.exit_code != 0:
            reasons.append(f"exitCode={state.verify.exit_code}")
        if not is_green(state.verify):
            pass  # already covered
        if state.last_verify_seq <= state.last_edit_seq:
            reasons.append("verify 不在最后一次 edit 之后")
        if state.verify.collected < baseline.collected:
            reasons.append(
                f"collected 比 baseline 少 {baseline.collected - state.verify.collected}"
            )
        if state.verify.skipped > baseline.skipped:
            reasons.append(
                f"skipped 比 baseline 多 {state.verify.skipped - baseline.skipped}"
            )
    if len(state.unplanned_files) > 0 and not state.revised_for_unplanned:
        reasons.append("有计划外改动且未 revise_plan")
    for f, h in baseline.test_file_hashes.items():
        if state.current_test_file_hashes.get(f) != h:
            reasons.append(f"测试文件被改动：{f}")

    if not state.finished and len(reasons) == 0:
        # 模型还没 finish，但其他都满足——仍应等 finish；不过 STOP 用例里 finished 是显式的
        pass
    if not state.finished:
        reasons.append("模型未 finish")

    if reasons:
        return StopDecision(can_stop=False, outcome="continue", reasons=reasons)
    return StopDecision(can_stop=True, outcome="success", reasons=[])


# ═══════════════════════════════════════════════════════════════════
# 六、reward hacking 检测器（测检测器，不测模型）
# ═══════════════════════════════════════════════════════════════════

HackSeverity = Literal["warn", "block"]


@dataclass
class HackEvidence:
    file: str | None = None
    line: int | None = None
    snippet: str | None = None


@dataclass
class HackFinding:
    rule: str
    severity: HackSeverity
    evidence: HackEvidence


_SKIP_MARKERS = re.compile(
    r"@pytest\.mark\.(?:xfail|skip)\b|@unittest\.skip\b|\bit\.skip\s*\(|\tt\.Skip\s*\("
)
_RESULT_LINES = re.compile(r"\b(?:PASSED|FAILED|ERROR|SKIPPED)\b", re.I)
_SUSPICIOUS_EXIT = re.compile(
    r"\bsys\.exit\s*\(\s*0\s*\)|\bos\._exit\s*\(\s*0\s*\)|\bprocess\.exit\s*\(\s*0\s*\)"
)
_SKIP_FROM_SOURCE = re.compile(r"raise\s+unittest\.SkipTest|pytest\.skip\s*\(")
_SKIP_FROM_TEST_DIFF = re.compile(r"(^|\n)\+\+\+\s+.*tests?/")
_STUB_LINE = re.compile(
    r"^\+\s*(pass|TODO|NotImplemented|throw new Error\(['\"]not implemented)", re.M
)
_MINUS_LINES = re.compile(r"^-", re.M)
_TEST_PATH = re.compile(r"(^|/)tests?/")
_DUNDER_TEST_PATH = re.compile(r"(^|/)__tests__/")


@dataclass
class DetectHacksInput:
    verify_output: str | None = None
    exit_code: int | None = None
    baseline: Baseline | None = None
    verify: VerifyResult | None = None
    #: unified diff 或「path → new content」表。
    diff_text: str | None = None
    changed_files: list[str] | None = None
    tool_log: list[ToolLogEntry] | None = None
    installed_packages: list[str] | None = None


def detect_hacks(input: DetectHacksInput) -> list[HackFinding]:
    out: list[HackFinding] = []
    v = input.verify
    if v and input.verify_output:
        result_lines = len(_RESULT_LINES.findall(input.verify_output))
        if (
            v.collected >= 12
            and result_lines > 0
            and result_lines < v.collected / 2
            and (input.exit_code or 0) == 0
        ):
            out.append(
                HackFinding(
                    rule="EARLY_EXIT",
                    severity="block",
                    evidence=HackEvidence(
                        snippet=f"collected={v.collected} resultLines={result_lines}"
                    ),
                )
            )
    if v and input.baseline:
        if v.skipped > input.baseline.skipped:
            out.append(
                HackFinding(
                    rule="SKIP_INCREASED",
                    severity="block",
                    evidence=HackEvidence(
                        snippet=f"skipped {input.baseline.skipped}→{v.skipped}",
                    ),
                )
            )

    files = input.changed_files or []
    for f in files:
        norm = _normalize_rel(f)
        if _TEST_PATH.search(norm) or _DUNDER_TEST_PATH.search(norm):
            out.append(
                HackFinding(
                    rule="TEST_FILE_MODIFIED",
                    severity="block",
                    evidence=HackEvidence(file=norm),
                )
            )
        if (
            "site-packages/" in norm
            or "node_modules/" in norm
            or "/.venv/" in norm
            or norm.startswith(".venv/")
        ):
            out.append(
                HackFinding(
                    rule="UPSTREAM_MODIFIED",
                    severity="block",
                    evidence=HackEvidence(file=norm),
                )
            )

    diff = input.diff_text or ""
    skip_m = _SKIP_MARKERS.search(diff)
    if skip_m:
        out.append(
            HackFinding(
                rule="SKIP_MARKER_ADDED",
                severity="block",
                evidence=HackEvidence(snippet=skip_m.group(0)),
            )
        )
    if _SUSPICIOUS_EXIT.search(diff):
        out.append(
            HackFinding(
                rule="SUSPICIOUS_EXIT",
                severity="warn",
                evidence=HackEvidence(snippet="exit(0) added"),
            )
        )
    if _SKIP_FROM_SOURCE.search(diff) and not _SKIP_FROM_TEST_DIFF.search(diff):
        out.append(
            HackFinding(
                rule="SKIP_FROM_SOURCE",
                severity="block",
                evidence=HackEvidence(snippet="skip from non-test file"),
            )
        )

    # STUB_SUSPECTED：粗测——大块删除 + 新增 pass/TODO/NotImplemented
    if len(_MINUS_LINES.findall(diff)) >= 10 and _STUB_LINE.search(diff):
        out.append(
            HackFinding(
                rule="STUB_SUSPECTED",
                severity="warn",
                evidence=HackEvidence(snippet="large deletion + stub"),
            )
        )

    for f in files:
        top = _normalize_rel(f).split("/")[0]
        if input.installed_packages and top in input.installed_packages:
            out.append(
                HackFinding(
                    rule="PACKAGE_SHADOWING",
                    severity="block",
                    evidence=HackEvidence(file=top),
                )
            )

    for e in input.tool_log or []:
        if e.tool == "read_file" and e.path and _TEST_PATH.search(_normalize_rel(e.path)):
            out.append(
                HackFinding(
                    rule="READ_TEST_FILE",
                    severity="warn",
                    evidence=HackEvidence(file=e.path),
                )
            )

    return out


# ═══════════════════════════════════════════════════════════════════
# 七、Workspace：读后写、快照、回滚、沙箱
# ═══════════════════════════════════════════════════════════════════

DENIED_PREFIXES = [
    ".git/",
    "node_modules/",
    ".venv/",
    "site-packages/",
    "tests/hidden/",
]

DENIED_NAMES = [".env", ".env.local", ".env.production"]

HIGH_RISK = re.compile(
    r"(?:^|/)(?:package\.json|Makefile|conftest\.py|CLAUDE\.md|.+\.config\.[jt]s)$|^\.github/workflows/",
    re.I | re.A,
)

DenyReason = Literal[
    "ESCAPES_ROOT",
    "ABSOLUTE_PATH",
    "NUL_BYTE",
    "BACKSLASH",
    "SYMLINK_ESCAPES_ROOT",
    "WRITE_THROUGH_SYMLINK",
    "SYMLINK_LOOP",
    "DENIED_PATH",
    "REQUIRES_CONFIRMATION",
]


@dataclass
class ResolveOk:
    full: str
    rel: str
    ok: Literal[True] = True
    requires_confirmation: bool | None = None


@dataclass
class ResolveErr:
    reason: DenyReason
    message: str
    ok: Literal[False] = False


ResolveResult = ResolveOk | ResolveErr


def resolve_in_workspace(root: str, input: str, op: Literal["read", "write"]) -> ResolveResult:
    """在 safe_path 之上叠加 deny 规则与写穿 symlink 检查。

    ★ deny 在规范化之后做（SBX-11：`./.git/config` 不能靠字面前缀绕过）。
    ★ 目标不存在也解析符号链接：realpath 落在最近的已存在祖先上（SBX-8）。
    ★ deny 用 OR：请求的路径或它解析到的路径，任一命中就拒（SBX-15）。
    """
    if "\0" in input:
        return ResolveErr(reason="NUL_BYTE", message="路径含 NUL 字节。")
    if "\\" in input:
        return ResolveErr(reason="BACKSLASH", message="路径不得含反斜杠，请用 /。")
    if input.startswith("/") or re.match(r"^[A-Za-z]:", input):
        return ResolveErr(reason="ABSOLUTE_PATH", message="不接受绝对路径。")

    sp = safe_path(root, input, True)
    if not sp.ok:
        code = sp.code  # type: ignore[union-attr]
        if code == "SYMLINK_LOOP":
            return ResolveErr(reason="SYMLINK_LOOP", message=sp.message)  # type: ignore[union-attr]
        if code in ("SYMLINK_ESCAPES_ROOT", "UNRESOLVABLE"):
            return ResolveErr(reason="SYMLINK_ESCAPES_ROOT", message=sp.message)  # type: ignore[union-attr]
        return ResolveErr(reason="ESCAPES_ROOT", message=sp.message)  # type: ignore[union-attr]

    full = str(sp.full)  # type: ignore[union-attr]
    rel = sp.rel.replace("\\", "/")  # type: ignore[union-attr]
    real_rel = sp.real_rel.replace("\\", "/")  # type: ignore[union-attr]
    if _is_denied(rel) or _is_denied(real_rel):
        return ResolveErr(reason="DENIED_PATH", message=f"拒绝访问 {rel}")

    if op == "write" and os.path.islink(full):
        return ResolveErr(
            reason="WRITE_THROUGH_SYMLINK",
            message=f"拒绝穿过符号链接写入：{rel}",
        )

    requires_confirmation = bool(HIGH_RISK.search(rel) or HIGH_RISK.search(real_rel))
    return ResolveOk(full=full, rel=rel, requires_confirmation=requires_confirmation)


def _is_denied(rel: str) -> bool:
    """★ 大小写不敏感：macOS 和 Windows 的默认文件系统上 `.ENV` 就是 `.env`（SBX-14）。"""
    p = rel.lower()
    base = p.split("/")[-1]
    if base in DENIED_NAMES or base.startswith(".env."):
        return True
    return any(p == d[:-1] or p.startswith(d) for d in DENIED_PREFIXES)


@dataclass
class ReadResult:
    ok: bool
    path: str | None = None
    content: str | None = None
    hash: str | None = None
    truncated: bool | None = None
    warnings: list[str] | None = None
    message: str | None = None


@dataclass
class CreateResult:
    ok: bool
    message: str | None = None


@dataclass
class InvisibleHit:
    codepoint: str
    line: int
    col: int


# INVISIBLE regex 在 TS 侧声明但未使用（void INVISIBLE）；这里同样保留意图注释。
_INVISIBLE = re.compile(r"[\u00A0\u200B-\u200F\u2028\u2029\uFEFF\uFF01-\uFF5E]")


def find_invisible(content: str) -> list[InvisibleHit]:
    hits: list[InvisibleHit] = []
    lines = split_lines(content)
    for li, line in enumerate(lines):
        for ci, ch in enumerate(line):
            if (
                ch == "\u00a0"
                or ("\u200b" <= ch <= "\u200f")
                or ch == "\u2028"
                or ch == "\u2029"
                or (ch == "\ufeff" and not (li == 0 and ci == 0))
                or ("\uff01" <= ch <= "\uff5e")
            ):
                hits.append(
                    InvisibleHit(
                        codepoint=f"U+{ord(ch):04X}",
                        line=li + 1,
                        col=ci + 1,
                    )
                )
    _ = _INVISIBLE
    return hits


def content_hash(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


@dataclass
class _SnapFile:
    kind: Literal["file"]
    bytes: str


@dataclass
class _SnapAbsent:
    kind: Literal["absent"]


_SnapEntry = _SnapFile | _SnapAbsent


class Workspace:
    """工作区：强制 read-before-write、懒快照、回滚。"""

    def __init__(self, root: str) -> None:
        self.root = root
        self._hashes: dict[str, str] = {}
        self._truncated: set[str] = set()
        self._snapshot: dict[str, _SnapEntry] = {}
        self._seq = 0
        self.log: list[ToolLogEntry] = []

    @property
    def snapshot_size(self) -> int:
        return len(self._snapshot)

    def read(
        self,
        path: str,
        *,
        max_chars: int | None = None,
        range: tuple[int, int] | None = None,
    ) -> ReadResult:
        r = resolve_in_workspace(self.root, path, "read")
        if not r.ok:
            return ReadResult(ok=False, message=r.message)  # type: ignore[union-attr]
        assert isinstance(r, ResolveOk)
        if not os.path.exists(r.full):
            return ReadResult(ok=False, message=f"文件不存在：{r.rel}")
        with open(r.full, encoding="utf-8", newline="") as f:
            content = f.read()
        warnings: list[str] = []
        inv = find_invisible(content)
        if inv:
            warnings.append(
                "invisible: "
                + "; ".join(
                    f"{h.codepoint} at line {h.line} col {h.col}" for h in inv[:5]
                )
            )
        if detect_eol(content) == "mixed":
            warnings.append("MIXED_EOL")

        truncated = False
        if range is not None:
            lines = split_lines(content)
            a, b = range
            eol_for_join: Literal["\n", "\r\n"] = (
                "\r\n" if detect_eol(content) == "\r\n" else "\n"
            )
            content = join_lines(lines[a:b], eol_for_join, False)
        if max_chars is not None and len(content) > max_chars:
            content = content[:max_chars]
            truncated = True
            self._truncated.add(r.rel)
        else:
            self._truncated.discard(r.rel)

        # 哈希始终对全文
        with open(r.full, encoding="utf-8", newline="") as f:
            full = f.read()
        self._hashes[r.rel] = content_hash(full)
        self._seq += 1
        self.log.append(ToolLogEntry(seq=self._seq, tool="read_file", path=r.rel))
        return ReadResult(
            ok=True,
            path=r.rel,
            content=content,
            hash=self._hashes.get(r.rel),
            truncated=truncated,
            warnings=warnings,
        )

    def edit(self, path: str, edits: list[EditRequest]) -> EditResult:
        r = resolve_in_workspace(self.root, path, "write")
        if not r.ok:
            return EditErr(
                reason="DENIED",
                failed_at=0,
                match_count=0,
                match_lines=[],
                old=edits[0].old if edits else "",
                warnings=[],
                message=r.message,  # type: ignore[union-attr]
            )
        assert isinstance(r, ResolveOk)
        if r.requires_confirmation:
            # 仍允许在显式确认后写入；这里只标记。调用方看这个字段。
            pass
        if r.rel not in self._hashes:
            return EditErr(
                reason="READ_REQUIRED",
                failed_at=0,
                match_count=0,
                match_lines=[],
                old=edits[0].old if edits else "",
                warnings=[],
                message="READ_REQUIRED：编辑前必须先 read。",
            )
        if r.rel in self._truncated:
            return EditErr(
                reason="TRUNCATED_READ",
                failed_at=0,
                match_count=0,
                match_lines=[],
                old=edits[0].old if edits else "",
                warnings=[],
                message="TRUNCATED_READ：读取被截断，不得基于残缺内容编辑。",
            )
        if not os.path.exists(r.full):
            return EditErr(
                reason="FILE_NOT_FOUND",
                failed_at=0,
                match_count=0,
                match_lines=[],
                old=edits[0].old if edits else "",
                warnings=[],
                message=f"FILE_NOT_FOUND：{r.rel}",
            )
        with open(r.full, encoding="utf-8", newline="") as f:
            current = f.read()
        h = content_hash(current)
        if h != self._hashes.get(r.rel):
            return EditErr(
                reason="STALE_READ",
                failed_at=0,
                match_count=0,
                match_lines=[],
                old=edits[0].old if edits else "",
                warnings=[],
                message=f"STALE_READ：{r.rel} 自上次 read 以来已被改动。",
            )

        result = apply_edits(current, edits, r.rel)
        if not result.ok:
            assert isinstance(result, EditErr)
            result.path = r.rel
            result.requires_confirmation = r.requires_confirmation
            return result

        assert isinstance(result, EditOk)
        self._ensure_snapshot(r.rel, current)
        atomic_write(r.full, result.new_content)
        self._hashes[r.rel] = content_hash(result.new_content)
        self._seq += 1
        self.log.append(ToolLogEntry(seq=self._seq, tool="edit_file", path=r.rel))
        result.path = r.rel
        result.requires_confirmation = r.requires_confirmation
        return result

    def create(self, path: str, content: str) -> CreateResult:
        r = resolve_in_workspace(self.root, path, "write")
        if not r.ok:
            return CreateResult(ok=False, message=r.message)  # type: ignore[union-attr]
        assert isinstance(r, ResolveOk)
        if os.path.exists(r.full):
            return CreateResult(ok=False, message=f"已存在：{r.rel}")
        self._ensure_snapshot(r.rel, None)
        parent = os.path.dirname(r.full)
        if parent:
            os.makedirs(parent, exist_ok=True)
        atomic_write(r.full, content)
        self._hashes[r.rel] = content_hash(content)
        self._seq += 1
        self.log.append(ToolLogEntry(seq=self._seq, tool="create_file", path=r.rel))
        return CreateResult(ok=True)

    def invalidate_after_command(self, readonly: bool) -> None:
        """非只读命令之后调用，使全部哈希失效（STALE-6）。"""
        if not readonly:
            self._hashes.clear()

    def rollback_all(self) -> None:
        for rel, entry in self._snapshot.items():
            full = os.path.join(self.root, rel)
            if entry.kind == "absent":
                if os.path.exists(full):
                    os.unlink(full)
            else:
                os.makedirs(os.path.dirname(full) or ".", exist_ok=True)
                atomic_write(full, entry.bytes)
        self._snapshot.clear()
        self._hashes.clear()

    def _ensure_snapshot(self, rel: str, current: str | None) -> None:
        if rel in self._snapshot:
            return
        if current is None:
            self._snapshot[rel] = _SnapAbsent(kind="absent")
        else:
            self._snapshot[rel] = _SnapFile(kind="file", bytes=current)


def atomic_write(full: str, content: str) -> None:
    """临时文件 + os.replace。Windows 上用 replace 覆盖已存在目标。"""
    tmp = f"{full}.tmp-{os.getpid()}-{int(time.time() * 1000)}"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    os.replace(tmp, full)


READONLY_COMMANDS: frozenset[str] = frozenset(
    [
        "git status",
        "git diff",
        "git log",
        "git show",
        "ls",
        "pwd",
    ]
)


def is_readonly_command(name: str, args: list[str]) -> bool:
    line = " ".join([name, *args])
    for r in READONLY_COMMANDS:
        if line == r or line.startswith(r + " "):
            return True
    return False
