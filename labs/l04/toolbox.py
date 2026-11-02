"""
L04 · 任务二（Python 通道）：路径沙箱与第一批工具。

跑法：uv run python -m l04.toolbox        验证：uv run python -m l04.verify

`shared/sandbox.py` 和 `shared/toolbox.py` 里有我的实现。**先别看。**

完整任务说明见 l04/toolbox.ts。Python 这边三件事和 TS 不一样：

1. **Path.is_relative_to() 比 TS 那边省事。**
   它把「relative 之后查 .. 开头、再查 isAbsolute」两步合成一步，没有平台差异。
   这是标准库赢的一局——但它赢的只是那一步，符号链接照样挡不住。

2. **os.path.abspath 不解析符号链接，Path.resolve() 和 os.path.realpath 会。**
   用错那个，你的符号链接检查就是空的，而且测试可能照样绿
   （因为纯路径穿越的用例它挡得住）。这是最阴的一种「看起来对」。

3. **truncate 比 TS 省事。**
   bytes.decode(errors="ignore") 直接丢掉切断的多字节尾巴，
   不像 TS 那样留一个 U+FFFD 要手动清。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from l04.schema import ToolDef


@dataclass
class SafePathOk:
    full: Path
    rel: str
    ok: bool = True


@dataclass
class SafePathErr:
    message: str
    """给模型看的话。★ 不要放绝对路径进来。"""

    log_note: str
    """给日志看的话。越界尝试你自己要知道。"""

    ok: bool = False


SafePath = SafePathOk | SafePathErr


# ─────────────────────────────────────────────────────────────────────────────
# TODO 1 · safe_path(root, raw, follow_symlinks=True)
#
#   要挡住的输入（verify 里全都有）：
#
#     '../../etc/passwd'            经典穿越
#     '/etc/passwd'                 绝对路径
#     'src/../../outside.txt'       中间穿越，末尾看起来正常
#     'safe.txt\0../../etc/passwd'  NUL 字节
#     ''                            空字符串
#     一个指向根外的符号链接          ★ 纯路径检查挡不住
#
#   ★ 还有一条反向的：root 本身是符号链接时（macOS 的 /tmp → /private/tmp），
#     不能把正常路径误判成越界。两边都要 resolve 之后再比。
#
#   message 里不要出现 root 的绝对路径——上下文里的东西模型后面都可能复述出来。
#
# TODO 2 · truncate(text, max_bytes) -> (text, truncated)
#
#   ★ 截断必须在内容里明确说明，并给出完整大小。
#     不说的话模型会以为看到了完整内容。
#
# TODO 3 · make_read_file(root)
#
#   run 里每个失败分支都要给出路：
#     不存在 → 建议 list_dir ／ 是目录 → 建议 list_dir ／ 行号超范围 → 说明共几行
#   给了行号区间时输出要带行号前缀。
#
# TODO 4 · make_list_dir(root)
#
#   目录排在文件前（输出稳定 → 缓存可能命中）。
#   被跳过的目录也要列出来并标注，否则模型会以为它不存在然后反复找。
#
# TODO 5 · 用真实攻击输入跑一遍，然后回答 l04/toolbox.ts 里那两个问题。
# ─────────────────────────────────────────────────────────────────────────────


def safe_path(root: str | Path, raw: str, follow_symlinks: bool = True) -> SafePath:
    raise NotImplementedError("TODO 1")


def truncate(text: str, max_bytes: int) -> tuple[str, bool]:
    raise NotImplementedError("TODO 2")


def make_read_file(root: str | Path) -> ToolDef:
    raise NotImplementedError("TODO 3")


def make_list_dir(root: str | Path) -> ToolDef:
    raise NotImplementedError("TODO 4")


def main() -> None:
    raise NotImplementedError("把 TODO 5 写完，然后删掉这一行")


if __name__ == "__main__":
    main()
