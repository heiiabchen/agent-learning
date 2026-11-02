"""
路径沙箱。shared/sandbox.ts 的 Python 对照版。

这里有一个 Python 明显更好的地方，值得单独指出来：

    Path(full).is_relative_to(root)      # 3.9+

它把 TS 那边「relative 之后查 .. 开头、再查 isAbsolute」两步合成了一步，
而且没有平台差异。**这是标准库赢的一局。**

但注意它赢的只是那一步。它照样挡不住符号链接——
仓库内一个指向外面的 symlink，路径字符串完全正常，is_relative_to 会返回 True。
所以解析符号链接之后再验一次仍然是必需的。

顺便记住 Path.resolve() 和 os.path.realpath 都会解析符号链接，
而 os.path.abspath **不会**。用错了那个，符号链接检查就是空的。

还有一处标准库输的：resolve() / realpath() 默认 strict=False，
遇到符号链接环**不报错**，原样返回一个看起来正常的路径。
所以这里用 strict=True，作用在最近的已存在祖先上，和 TS 的 realpathSync 对齐。
"""

from __future__ import annotations

import errno
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class SafePathOk:
    full: Path
    """验证过的绝对路径。只有这个值能交给文件操作。"""

    rel: str
    """相对根的路径。回给模型的消息里用这个——绝对路径不要进上下文。"""

    ok: bool = True

    real_rel: str = ""
    """解析完符号链接之后、相对真实根的路径。follow_symlinks=False 时等于 rel。"""


@dataclass
class SafePathErr:
    message: str
    """给模型看的话。"""

    log_note: str
    """给日志看的话。越界尝试你自己要知道，哪怕模型只是猜错了。"""

    ok: bool = False

    code: str = "INVALID"
    """INVALID / ESCAPES_ROOT / SYMLINK_ESCAPES_ROOT / SYMLINK_LOOP / UNRESOLVABLE。
    UNRESOLVABLE：悬空链接或权限不足，落点无法确定，按拒绝处理。"""


SafePath = SafePathOk | SafePathErr


def safe_path(root: str | Path, raw: str, follow_symlinks: bool = True) -> SafePath:
    if not isinstance(raw, str) or not raw.strip():
        return SafePathErr("路径不能为空。", f"非法路径参数：{raw!r}")

    # NUL 会截断 C 层字符串，是经典绕过手法。
    # Python 现在会抛 ValueError，但显式拒绝比依赖运行时行为好。
    if "\0" in raw:
        return SafePathErr("路径含有非法字符。", f"路径里有 NUL 字节：{raw!r}")

    # 这里用 os.path.abspath 而不是 Path.resolve()：先只做纯路径层面的规范化，
    # 把符号链接留到下一步单独处理。两件事混在一起时错误信息会说不清是哪种越界。
    root_abs = Path(os.path.abspath(root))
    full = Path(os.path.abspath(root_abs / raw))

    if not full.is_relative_to(root_abs):
        return SafePathErr(
            f"路径超出了允许的范围：{raw}。只能访问仓库内的文件。",
            f"越界访问尝试：{raw} → {full}",
            code="ESCAPES_ROOT",
        )

    rel = str(full.relative_to(root_abs)) or "."

    if not follow_symlinks:
        return SafePathOk(full=full, rel=rel, real_rel=rel)

    # 两边都要 realpath。只解析 full 的话，root 本身是符号链接时
    # （macOS 的 /tmp → /private/tmp）所有正常路径都会被判成越界。
    real_root, root_code = _realpath_nearest(root_abs)
    real_full, full_code = _realpath_nearest(full)
    if real_root is None or real_full is None:
        code = full_code or root_code
        loop = code == "SYMLINK_LOOP"
        return SafePathErr(
            f"路径里有符号链接环：{raw}。" if loop else f"无法确定路径最终落在哪里：{raw}。",
            f"{'符号链接环' if loop else '无法解析的符号链接'}：{raw} → {full}",
            code=code,
        )
    if not real_full.is_relative_to(real_root):
        return SafePathErr(
            f"路径超出了允许的范围：{raw}。",
            f"符号链接越界：{raw} → {real_full}",
            code="SYMLINK_ESCAPES_ROOT",
        )

    return SafePathOk(full=full, rel=rel, real_rel=str(real_full.relative_to(real_root)) or ".")


def _realpath_nearest(p: Path) -> tuple[Path | None, str]:
    """realpath 最近的已存在祖先，再接上还不存在的那几段。

    ★ 只对整条路径做 strict realpath 的话，目标不存在时它会抛，检查就退化成纯路径层：
      root 里的 out → /elsewhere，create('out/new.txt') 会写到 root 外面。
      对只读工具这不要紧（最后报「不存在」）；对创建文件，「不存在」恰恰是正常状态。
    """
    rest: list[str] = []
    cur = p
    while True:
        try:
            return Path(os.path.realpath(cur, strict=True)).joinpath(*rest), ""
        except OSError as e:
            if e.errno == errno.ELOOP:
                return None, "SYMLINK_LOOP"
            if e.errno not in (errno.ENOENT, errno.ENOTDIR):
                return None, "UNRESOLVABLE"
        # realpath 失败而 lstat 成功：cur 是悬空链接，指向哪里要等它被创建才知道
        if os.path.lexists(cur):
            return None, "UNRESOLVABLE"
        parent = cur.parent
        if parent == cur:
            return cur.joinpath(*rest), ""
        rest.insert(0, cur.name)
        cur = parent


def truncate(text: str, max_bytes: int) -> tuple[str, bool]:
    """
    截断过长内容，并**明确告知**被截断了。

    那句告知不能省：不说的话模型会以为看到了完整内容，然后基于残缺信息下结论。

    Python 这边比 TS 省事一点——bytes.decode(errors="ignore") 会直接丢掉
    切断的多字节尾巴，不像 TS 那样留一个 U+FFFD 要手动清。
    """
    raw = text.encode("utf-8")
    if len(raw) <= max_bytes:
        return text, False

    head = raw[:max_bytes].decode("utf-8", errors="ignore")
    kb = len(raw) / 1024
    note = f"\n\n…（内容被截断。完整大小 {kb:.1f} KB，这里只显示前 {max_bytes // 1024} KB）"
    return head + note, True
