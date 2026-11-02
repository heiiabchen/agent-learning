"""
第一批工具：read_file / list_dir / search_code。
shared/toolbox.ts 的 Python 对照版。

每个工具的形状都一样：
  description 写清「返回什么 + 边界在哪」→ parse 校验 → run 执行且不抛
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from shared.sandbox import safe_path, truncate
from shared.tools import (
    ParseErr,
    ParseOk,
    ParseResult,
    ToolDef,
    ToolResult,
    optional_int,
    require_string,
)

MAX_FILE_BYTES = 100 * 1024
SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".venv", "__pycache__", ".pytest_cache"}


def make_read_file(root: str | Path) -> ToolDef:
    def parse(raw: Any) -> ParseResult:
        p = require_string(raw, "path")
        if not p.ok:
            return p
        assert isinstance(p, ParseOk)
        start = (
            optional_int(raw, "start_line", 0, 1, 10**9)
            if isinstance(raw, dict) and raw.get("start_line") is not None
            else None
        )
        end = (
            optional_int(raw, "end_line", 0, 1, 10**9)
            if isinstance(raw, dict) and raw.get("end_line") is not None
            else None
        )
        if start is not None and end is not None and end < start:
            return ParseErr(f"end_line ({end}) 不能小于 start_line ({start})。")
        return ParseOk(input={"path": p.input, "start_line": start, "end_line": end})

    async def run(inp: dict[str, Any]) -> ToolResult:
        sp = safe_path(root, inp["path"])
        if not sp.ok:
            return ToolResult(content=sp.message, is_error=True, log_note=sp.log_note)

        if not sp.full.exists():
            # 给出路：告诉它下一步干什么，而不是只说失败了
            return ToolResult(
                content=f"文件不存在：{sp.rel}。用 list_dir 看看这个目录下实际有哪些文件。",
                is_error=True,
            )
        if sp.full.is_dir():
            return ToolResult(
                content=f"{sp.rel} 是一个目录，不是文件。用 list_dir 列出它的内容。",
                is_error=True,
            )

        raw_text = sp.full.read_text(encoding="utf-8", errors="replace")
        start, end = inp["start_line"], inp["end_line"]

        if start is None and end is None:
            text, _ = truncate(raw_text, MAX_FILE_BYTES)
            return ToolResult(content=text)

        lines = raw_text.split("\n")
        frm = (start or 1) - 1
        to = end if end is not None else len(lines)
        if frm >= len(lines):
            return ToolResult(
                content=f"start_line {start} 超过了文件总行数 {len(lines)}。", is_error=True
            )
        # 带上行号，模型下一步才能准确指定编辑位置
        sliced = "\n".join(f"{frm + i + 1}\t{ln}" for i, ln in enumerate(lines[frm:to]))
        text, _ = truncate(sliced, MAX_FILE_BYTES)
        return ToolResult(content=f"{text}\n\n（{sp.rel} 共 {len(lines)} 行）")

    return ToolDef(
        name="read_file",
        description=(
            "读取仓库内一个文本文件的内容。路径相对于仓库根目录。"
            "可以只读某个行号区间（start_line / end_line，从 1 开始，含两端）——"
            "文件很大时应该先读一段而不是全读。"
            f"单次返回上限 {MAX_FILE_BYTES // 1024}KB，超出会被截断并明确标注。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对仓库根的文件路径，例如 src/index.ts",
                },
                "start_line": {
                    "type": "integer",
                    "description": "起始行号，从 1 开始",
                    "minimum": 1,
                },
                "end_line": {"type": "integer", "description": "结束行号，含该行", "minimum": 1},
            },
            "required": ["path"],
        },
        parse=parse,
        run=run,
    )


def make_list_dir(root: str | Path) -> ToolDef:
    def parse(raw: Any) -> ParseResult:
        p = require_string(raw, "path")
        if not p.ok:
            return p
        assert isinstance(p, ParseOk)
        return ParseOk(input={"path": p.input, "depth": optional_int(raw, "depth", 1, 1, 3)})

    async def run(inp: dict[str, Any]) -> ToolResult:
        sp = safe_path(root, inp["path"])
        if not sp.ok:
            return ToolResult(content=sp.message, is_error=True, log_note=sp.log_note)

        if not sp.full.exists():
            return ToolResult(
                content=f'目录不存在：{sp.rel}。用 list_dir 从 "." 开始往下找。', is_error=True
            )
        if not sp.full.is_dir():
            return ToolResult(
                content=f"{sp.rel} 是一个文件，不是目录。用 read_file 读它。", is_error=True
            )

        out: list[str] = []

        def walk(d: Path, prefix: str, left: int) -> None:
            # 目录在前、各自按名字排序：输出稳定，缓存才可能命中
            entries = sorted(d.iterdir(), key=lambda p: (not p.is_dir(), p.name))
            for e in entries:
                if e.name.startswith(".") and e.name != ".env.example":
                    continue
                if e.is_dir():
                    if e.name in SKIP_DIRS:
                        # 被跳过的也要列出来。完全不提的话模型会以为它不存在，然后反复去找。
                        out.append(f"{prefix}{e.name}/  （已跳过）")
                        continue
                    out.append(f"{prefix}{e.name}/")
                    if left > 1:
                        walk(e, prefix + "  ", left - 1)
                else:
                    size = e.stat().st_size
                    human = f"{size}B" if size < 1024 else f"{size / 1024:.1f}KB"
                    out.append(f"{prefix}{e.name} ({human})")

        walk(sp.full, "", inp["depth"])

        if not out:
            return ToolResult(content=f"{sp.rel} 是空目录。")
        text, _ = truncate("\n".join(out), MAX_FILE_BYTES)
        return ToolResult(content=text)

    return ToolDef(
        name="list_dir",
        description=(
            '列出仓库内某个目录的内容。路径相对于仓库根，用 "." 表示根目录。'
            "depth 控制递归层数（1 表示只列当前层，最大 3）。"
            "自动跳过 node_modules、.git、dist 这类目录。"
            "目录名以 / 结尾，文件会标出大小。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": '相对仓库根的目录路径，根目录用 "."'},
                "depth": {
                    "type": "integer",
                    "description": "递归层数，默认 1，最大 3",
                    "minimum": 1,
                    "maximum": 3,
                },
            },
            "required": ["path"],
        },
        parse=parse,
        run=run,
    )


def make_search_code(root: str | Path) -> ToolDef:
    def parse(raw: Any) -> ParseResult:
        p = require_string(raw, "pattern")
        if not p.ok:
            return p
        assert isinstance(p, ParseOk)
        try:
            re.compile(p.input)
        except re.error as err:
            # 正则语法错是模型能改的，回给它并带上报错原文
            return ParseErr(f"正则不合法：{err}。换一个写法再试。")
        return ParseOk(
            input={"pattern": p.input, "max_results": optional_int(raw, "max_results", 20, 1, 50)}
        )

    async def run(inp: dict[str, Any]) -> ToolResult:
        sp = safe_path(root, ".")
        if not sp.ok:
            return ToolResult(content=sp.message, is_error=True, log_note=sp.log_note)

        rx = re.compile(inp["pattern"])
        cap = inp["max_results"]
        hits: list[str] = []

        def walk(d: Path, rel: str) -> None:
            if len(hits) >= cap:
                return
            for e in sorted(d.iterdir(), key=lambda p: p.name):
                if len(hits) >= cap:
                    return
                if e.name.startswith("."):
                    continue
                r = f"{rel}/{e.name}" if rel else e.name
                if e.is_dir():
                    if e.name not in SKIP_DIRS:
                        walk(e, r)
                    continue
                try:
                    if e.stat().st_size > MAX_FILE_BYTES * 5:
                        continue
                    text = e.read_text(encoding="utf-8")
                except (OSError, UnicodeDecodeError):
                    # 二进制文件在这里被 UnicodeDecodeError 自然滤掉，
                    # 比 TS 那边靠「有没有 NUL 字节」判断更干净
                    continue
                for i, ln in enumerate(text.split("\n"), start=1):
                    if len(hits) >= cap:
                        return
                    if rx.search(ln):
                        hits.append(f"{r}:{i}: {ln.strip()[:200]}")

        walk(sp.full, "")

        if not hits:
            return ToolResult(
                content=f"没有匹配 /{inp['pattern']}/ 的内容。"
                "换个更宽松的写法，或者先用 list_dir 确认目录结构。"
            )
        tail = f"\n\n（达到 {cap} 条上限，可能还有更多匹配）" if len(hits) >= cap else ""
        return ToolResult(content="\n".join(hits) + tail)

    return ToolDef(
        name="search_code",
        description=(
            "在仓库内按正则搜索文本，返回匹配的文件路径、行号和该行内容。"
            "只搜文本文件，跳过 node_modules、.git、dist。"
            "返回条数上限默认 20，最大 50。找不到时会明确说没有匹配。"
        ),
        input_schema={
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "Python re 语法"},
                "max_results": {
                    "type": "integer",
                    "description": "返回条数上限，默认 20",
                    "minimum": 1,
                    "maximum": 50,
                },
            },
            "required": ["pattern"],
        },
        parse=parse,
        run=run,
    )


def standard_tools(root: str | Path) -> list[ToolDef]:
    return [make_read_file(root), make_list_dir(root), make_search_code(root)]
