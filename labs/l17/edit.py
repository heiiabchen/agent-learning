"""L17 的脚手架。跑法：uv run python -m l17.edit

观察实验直接跑 shared.coding 的参考实现。
TODO 在文件下半部分，写完跑 CODING_IMPL=shared uv run python -m l17.verify 对照。
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from shared.coding import (
    Baseline,
    EditRequest,
    Plan,
    PlanStep,
    StopState,
    VerifyResult,
    apply_edits,
    can_stop,
    detect_eol,
    is_green,
    parse_test_output,
    resolve_in_workspace,
    split_lines,
    validate_plan,
)

DIM, BOLD, RED, GREEN, YELLOW, OFF = (
    "\x1b[2m",
    "\x1b[1m",
    "\x1b[31m",
    "\x1b[32m",
    "\x1b[33m",
    "\x1b[0m",
)
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def _w(s: str) -> int:
    s = _ANSI.sub("", s)
    return sum(2 if "\u2e80" <= c <= "\u9fff" or "\uff00" <= c <= "\uffef" else 1 for c in s)


def pad(s: str, n: int) -> str:
    return s + " " * max(0, n - _w(s))


CACHE_FILE = """class Cache:
    def get(self, key):
        if key not in self._data:
            return None
        return self._data[key]

    def peek(self, key):
        if key not in self._data:
            return None
        return self._data[key]
"""


def exp1() -> None:
    print(f"{BOLD}\n实验一：同一个编辑意图，哪些表示法会静默改坏文件{OFF}")
    print(f"{DIM}  意图：只改 get() 里的 return None → raise KeyError(key)\n{OFF}")
    shared = """        if key not in self._data:
            return None"""
    unique = """    def get(self, key):
        if key not in self._data:
            return None
        return self._data[key]"""
    rows: list[tuple[str, str, str, str]] = []
    rows.append(("search/replace 首命中", "写入成功", "碰巧对", "无"))
    rows.append(("同上，意图其实是改 peek", "写入成功", "错", "无"))
    r = apply_edits(
        CACHE_FILE,
        [EditRequest(old=shared, new="""        if key not in self._data:
            raise KeyError(key)""")],
    )
    rows.append(
        (
            "str_replace + 唯一性",
            "成功" if r.ok else f"{r.reason} ×{r.match_count}",
            "——",
            "有" if r.ok else f"{GREEN}有{OFF}",
        )
    )
    r2 = apply_edits(
        CACHE_FILE,
        [
            EditRequest(
                old=unique,
                new="""    def get(self, key):
        if key not in self._data:
            raise KeyError(key)
        return self._data[key]""",
            )
        ],
    )
    rows.append(
        (
            "唯一性（扩大上下文）",
            f"成功 tier={r2.applied[0].tier}" if r2.ok else r2.reason,
            f"{GREEN}对{OFF}" if r2.ok else "错",
            "有",
        )
    )
    rows.append(("行号编辑（差一）", "写入成功", f"{RED}错{OFF}", f"{RED}无{OFF}"))
    print(f"  {pad('表示法', 28)}{pad('结果', 22)}{pad('改对了吗', 14)}有信号吗")
    print("  " + "─" * 70)
    for name, result, correct, signal in rows:
        print(f"  {pad(name, 28)}{pad(result, 22)}{pad(correct, 14)}{signal}")
    print(
        f"{DIM}\n  「有信号」的只有唯一性那两行。"
        f"正确循环：先 NOT_UNIQUE → 扩大上下文 → 成功。{OFF}"
    )


def exp2() -> None:
    print(f"{BOLD}\n实验二：切断测试输出，看解析器何时报告 isGreen{OFF}")
    full = (
        "tests/test_cache.py::test_get PASSED\n"
        "tests/test_cache.py::test_peek PASSED\n"
        "tests/test_cache.py::test_miss PASSED\n"
        "\n"
        "===== 3 passed, 1 skipped in 0.12s =====\n"
    )
    raw = full.encode("utf-8")
    first_green = -1
    last_ungreen = -1
    false_green = 0
    summary = "===== 3 passed, 1 skipped in 0.12s ====="
    for i in range(len(raw) + 1):
        slice_ = raw[:i].decode("utf-8", errors="replace")
        v = parse_test_output(slice_, 0)
        g = is_green(v)
        if g and first_green < 0:
            first_green = i
        if not g:
            last_ungreen = i
        if g and summary not in slice_:
            false_green += 1
    print(f"{DIM}  完整输出 {len(raw)} 字节。\n{OFF}")
    print(f"  首次 isGreen：偏移 {first_green}")
    print(f"  最后一次非绿：偏移 {last_ungreen}")
    fg = f"{GREEN}0{OFF}" if false_green == 0 else f"{RED}{false_green}{OFF}"
    print(f"  完整 summary 之前的假绿次数：{fg}")
    suffix_ok = first_green > last_ungreen or (first_green >= 0 and last_ungreen + 1 == first_green)
    print(f"  绿区是后缀区间：{GREEN + '是' + OFF if suffix_ok else RED + '否' + OFF}")
    print(
        f"{DIM}  危险区间是 summary 行只出现了一部分的那几十个字节"
        f"——naive 正则会在这里假绿。{OFF}"
    )


def exp3() -> None:
    print(f"{BOLD}\n实验三：同一个路径字符串，各层检查放行了什么{OFF}")
    # ★ 固定路径，保证和 TS 侧输出逐字节一致（临时名会破坏对照）
    root = "/tmp/l17-sbx-demo"
    evil = root + "-evil"
    shutil.rmtree(root, ignore_errors=True)
    shutil.rmtree(evil, ignore_errors=True)
    os.makedirs(root, exist_ok=True)
    os.makedirs(evil, exist_ok=True)
    Path(evil, "x").write_text("nope", encoding="utf-8")
    os.makedirs(Path(root, "src"), exist_ok=True)
    Path(root, "src", "main.ts").write_text("ok", encoding="utf-8")
    try:
        os.symlink("/etc", str(Path(root, "link")))
    except OSError:
        pass

    def starts_with(p: str) -> str:
        # ★ 故意字符串拼接而不 join/normpath——才展示得出「只看前缀」的漏洞形态
        full = root + "/" + p
        return "ALLOW" if full.startswith(root) else "DENY"

    def norm_starts(p: str) -> str:
        try:
            full = os.path.abspath(os.path.join(root, p))
        except ValueError:
            return "DENY"
        return "ALLOW" if full.startswith(root) else "DENY"

    def with_sep(p: str) -> str:
        try:
            full = os.path.abspath(os.path.join(root, p))
        except ValueError:
            return "DENY"
        root_sep = root if root.endswith(os.sep) else root + os.sep
        return "ALLOW" if full == root or full.startswith(root_sep) else "DENY"

    def ours(p: str) -> str:
        return "ALLOW" if resolve_in_workspace(root, p, "read").ok else "DENY"

    to_evil = "../" + Path(root).name + "-evil/x"
    cases = [
        ("src/main.ts", "ALLOW"),
        ("../etc/passwd", "DENY"),
        ("a/../../etc/passwd", "DENY"),
        (to_evil, "DENY"),
        ("link/passwd", "DENY"),
        ("./.git/config", "DENY"),
        ("a\0b", "DENY"),
    ]
    print(
        f"  {pad('路径', 28)}{pad('startsWith', 12)}"
        f"{pad('norm+starts', 12)}{pad('norm+SEP', 10)}本节"
    )
    print("  " + "─" * 72)

    def mark(x: str, want: str) -> str:
        return x if x == want else f"{RED}{x} ✗{OFF}"

    for p, want in cases:
        a, b, c = starts_with(p), norm_starts(p), with_sep(p)
        d = "DENY" if "\0" in p else ours(p)
        label = p.replace("\0", "\\0")[:26]
        print(
            f"  {pad(label, 28)}{pad(mark(a, want), 12)}"
            f"{pad(mark(b, want), 12)}{pad(mark(c, want), 10)}{mark(d, want)}"
        )
    print(
        f"{DIM}\n  注意 ws-evil 那一行：startsWith(root) 会放行，"
        f"加分隔符或 relative 才挡住。{OFF}"
    )
    shutil.rmtree(root, ignore_errors=True)
    shutil.rmtree(evil, ignore_errors=True)


def exp4() -> None:
    print(f"{BOLD}\n实验四：CRLF 文件编辑一行之后，行尾分布{OFF}")
    src = "line1\r\nline2\r\nline3\r\nline4\r\nline5\r\n"
    naive = "\n".join(
        "LINE2" if i == 1 else line for i, line in enumerate(src.split("\n"))
    )
    ours_r = apply_edits(src, [EditRequest(old="line2\n", new="LINE2\n")])
    normalized = src.replace("\r\n", "\n").replace("line2", "LINE2", 1)

    def count(s: str) -> str:
        crlf_n = s.count("\r\n")
        lf_n = s.replace("\r\n", "").count("\n")
        return f"{crlf_n}×CRLF + {lf_n}×LF"

    def diff_lines(s: str) -> int:
        a = src.replace("\r\n", "\n").split("\n")
        b = s.replace("\r\n", "\n").split("\n")
        n = 0
        for i in range(max(len(a), len(b))):
            if (a[i] if i < len(a) else None) != (b[i] if i < len(b) else None):
                n += 1
        return n

    print(f"  {pad('实现', 32)}{pad('行尾分布', 22)}内容改动行数")
    print("  " + "─" * 60)
    naive_label = "naive split/join on \\n"
    print(f"  {pad(naive_label, 32)}{pad(count(naive), 22)}{diff_lines(naive)}")
    ours_s = count(ours_r.new_content) if ours_r.ok else "FAIL"
    ours_d = diff_lines(ours_r.new_content) if ours_r.ok else "-"
    print(f"  {pad('本节规范（探测+恢复）', 32)}{pad(ours_s, 22)}{ours_d}")
    print(
        f"  {pad('naive normalize to LF', 32)}"
        f"{pad(count(normalized), 22)}{diff_lines(normalized)}"
    )
    print(
        f"{DIM}\n  第一行「1 行改动但文件已混合」最阴——git diff 看起来干净，问题稍后才爆。{OFF}"
    )
    _ = detect_eol, split_lines


def exp5() -> None:
    print(f"{BOLD}\n实验五：verify 绿过一次，但最后又 edit 了一次{OFF}")
    baseline = Baseline(collected=3, skipped=0, test_file_hashes={})
    verify = VerifyResult(
        runner="pytest", passed=3, failed=0, skipped=0, collected=3, confidence="exact", exit_code=0
    )
    cases = [
        (
            "edit→verify→finish",
            StopState(
                finished=True,
                gave_up=False,
                last_edit_seq=1,
                last_verify_seq=2,
                verify=verify,
                unplanned_files=[],
                revised_for_unplanned=False,
                current_test_file_hashes={},
            ),
        ),
        (
            "edit→verify→edit→finish",
            StopState(
                finished=True,
                gave_up=False,
                last_edit_seq=3,
                last_verify_seq=2,
                verify=verify,
                unplanned_files=[],
                revised_for_unplanned=False,
                current_test_file_hashes={},
            ),
        ),
        (
            "从未 verify",
            StopState(
                finished=True,
                gave_up=False,
                last_edit_seq=1,
                last_verify_seq=-1,
                verify=None,
                unplanned_files=[],
                revised_for_unplanned=False,
                current_test_file_hashes={},
            ),
        ),
    ]
    print(f"  {pad('日志', 32)}canStop  原因")
    print("  " + "─" * 60)
    for name, st in cases:
        d = can_stop(st, baseline)
        flag = f"{GREEN}true{OFF}" if d.can_stop else f"{YELLOW}false{OFF}"
        reason = d.reasons[0] if d.reasons else ""
        print(f"  {pad(name, 32)}{pad(flag, 8)}{reason}")
    print(f"{DIM}\n  中间那一行是本节最重要的终止条件：verify 必须在最后一次 edit 之后。{OFF}")
    _ = validate_plan, Plan, PlanStep


def observe() -> None:
    print(f"{BOLD}L17 · 观察实验（参考实现）{OFF}")
    print(f"{DIM}跑完这些再去写 TODO。每一张表都对应一条反转。{OFF}")
    exp1()
    exp2()
    exp3()
    exp4()
    exp5()


# ── TODO ─────────────────────────────────────────────────────


def my_split_lines(s: str) -> list[str]:
    raise NotImplementedError("TODO 1 未实现")


def my_apply_edits(content: str, edits: list[EditRequest], path: str = "") -> object:
    raise NotImplementedError("TODO 2 未实现")


def my_validate_plan(plan: Plan) -> object:
    raise NotImplementedError("TODO 3 未实现")


def my_parse_test_output(raw: str, exit_code: int, runner_hint: str = "") -> object:
    """★ 先用 split_lines 切行再逐行匹配，不带 re.M，空白只写 [ \\t]，
    re.I 要配 re.A（PARSE-8/9/10）。"""
    raise NotImplementedError("TODO 4 未实现")


def my_can_stop(state: StopState, baseline: Baseline) -> object:
    raise NotImplementedError("TODO 5 未实现")


def my_resolve_in_workspace(root: str, input: str, op: str) -> object:
    """★ 目标还不存在时也要解析符号链接（SBX-8）；环 → SYMLINK_LOOP（SBX-9）；
    deny 大小写不敏感（SBX-14），并且对解析后的路径再查一遍（SBX-15）。
    shared.sandbox 的 safe_path 已经做了前两件，读它的 code 和 real_rel。
    """
    raise NotImplementedError("TODO 6 未实现")


if __name__ == "__main__":
    observe()
    print(
        f"{DIM}\n  下一步：实现文件下半部分的六个 TODO，然后跑 "
        f"pnpm verify:l17（或 uv run python -m l17.verify）。{OFF}"
        f"{DIM}\n  想先确认测试本身是对的，跑 CODING_IMPL=shared 下的 verify。{OFF}"
        f"{DIM}\n  观察实验：pnpm coding / uv run python -m l17.edit\n{OFF}"
    )
