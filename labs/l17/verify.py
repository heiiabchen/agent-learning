"""验证 l17/edit.py。跑法：CODING_IMPL=shared uv run python -m l17.verify"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

from shared import coding as shared
from shared.coding import Baseline, DetectHacksInput, EditRequest, Plan, StopState, VerifyResult

TARGET = "shared" if os.environ.get("CODING_IMPL") == "shared" else "mine"


class _Mine:
    def __init__(self) -> None:
        from l17 import edit as m

        self.split_lines = m.my_split_lines
        self.apply_edits = m.my_apply_edits
        self.validate_plan = m.my_validate_plan
        self.parse_test_output = m.my_parse_test_output
        self.can_stop = m.my_can_stop
        self.resolve_in_workspace = m.my_resolve_in_workspace
        self.detect_eol = shared.detect_eol
        self.is_green = shared.is_green
        self.detect_hacks = shared.detect_hacks
        self.adherence = shared.adherence
        self.tools_for = shared.tools_for
        self.Workspace = shared.Workspace


M: Any = shared if TARGET == "shared" else _Mine()

print("\n（测的是 shared/ 里的参考实现）" if TARGET == "shared" else "\n（测的是 l17/ 里你的实现）")

DIM, BOLD, RED, GREEN, OFF = "\x1b[2m", "\x1b[1m", "\x1b[31m", "\x1b[32m", "\x1b[0m"
passed = 0
failures: list[str] = []


def _show(v: object) -> str:
    try:
        return json.dumps(v, ensure_ascii=False, default=str)
    except TypeError:
        return repr(v)


def eq(a: object, b: object, msg: str = "") -> None:
    global passed
    if a == b:
        passed += 1
    else:
        failures.append(msg)
        print(f"  {RED}✕{OFF} {msg}")
        print(f"{DIM}      期望 {_show(b)}{OFF}")
        print(f"{DIM}      实际 {_show(a)}{OFF}")


def ok(c: bool, msg: str = "") -> None:
    global passed
    if c:
        passed += 1
    else:
        failures.append(msg)
        print(f"  {RED}✕{OFF} {msg}")


def section(s: str) -> None:
    print(f"{BOLD}\n{s}{OFF}")


section("A · 行切分与字节层")
eq(M.split_lines("a\n"), ["a"], "LINE-3 a\\n")
eq(M.split_lines("a\n\n"), ["a", ""], "LINE-3 a\\n\\n")
eq(M.split_lines("a\vb"), ["a\vb"], "LINE-1 \\v")
eq(M.split_lines("a\u2028b"), ["a\u2028b"], "LINE-1 U+2028")
eq(M.split_lines("a\r\nb"), ["a", "b"], "LINE CRLF")
eq(M.split_lines(""), [], "LINE 空串")
eq(M.detect_eol("a\r\nb\r\n"), "\r\n", "EOL CRLF")
eq(M.detect_eol("a\nb\r\n"), "mixed", "EOL mixed")

bom_edit = M.apply_edits("\ufeffhello\nworld\n", [EditRequest(old="world", new="WORLD")])
ok(bom_edit.ok, "BOM-1")
if bom_edit.ok:
    ok(bom_edit.new_content.startswith("\ufeff"), "BOM-1 写回仍带 BOM")

crlf = "line1\r\nline2\r\nline3\r\n"
eol_edit = M.apply_edits(crlf, [EditRequest(old="line2\n", new="LINE2\n")])
ok(eol_edit.ok, "EOL-1")
if eol_edit.ok:
    eq(M.detect_eol(eol_edit.new_content), "\r\n", "EOL-1 仍 CRLF")
    eq(eol_edit.new_content, "line1\r\nLINE2\r\nline3\r\n", "EOL-1 内容")

tab_file = "target:\n\techo hi\n"
ok(M.apply_edits(tab_file, [EditRequest(old="\techo hi", new="\techo bye")]).ok, "TAB-1 tab")
tab_miss = M.apply_edits(tab_file, [EditRequest(old="        echo hi", new="        echo bye")])
ok((not tab_miss.ok) and tab_miss.reason == "NO_MATCH", "TAB-1 空格 → NO_MATCH")
nbsp_edit = M.apply_edits("x\u00a0y", [EditRequest(old="x y", new="x z")])
ok((not nbsp_edit.ok) and nbsp_edit.reason == "NO_MATCH", "UNI-1 NBSP")

section("B · 编辑语义")
cache = """class Cache:
    def get(self, key):
        if key not in self._data:
            return None
        return self._data[key]

    def peek(self, key):
        if key not in self._data:
            return None
        return self._data[key]
"""
shared_old = """        if key not in self._data:
            return None"""
nu = M.apply_edits(
    cache,
    [EditRequest(old=shared_old, new="""        if key not in self._data:
            raise KeyError(key)""")],
)
ok((not nu.ok) and nu.reason == "NOT_UNIQUE", "EDIT-2 NOT_UNIQUE")
if not nu.ok:
    eq(nu.match_count, 2, "EDIT-2 count")
    eq(nu.old, shared_old, "EDIT-9 old 逐字节")

unique = """    def get(self, key):
        if key not in self._data:
            return None
        return self._data[key]"""
ok1 = M.apply_edits(
    cache,
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
ok(ok1.ok, "EDIT-1")
if ok1.ok:
    eq(ok1.applied[0].tier, "exact", "EDIT-1 tier")

ok(not M.apply_edits("abc", [EditRequest(old="", new="x")]).ok, "EDIT-6")
ok(not M.apply_edits("abc", [EditRequest(old="   \n  ", new="x")]).ok, "EDIT-7")
ok(not M.apply_edits("abc", [EditRequest(old="a", new="a")]).ok, "EDIT-5")
dele = M.apply_edits("abXYcd", [EditRequest(old="XY", new="")])
ok(dele.ok and dele.new_content == "abcd", "EDIT-8")
all_ = M.apply_edits("aa aa aa", [EditRequest(old="aa", new="bb", occurrence="all")])
ok(all_.ok and len(all_.applied) == 3, "EDIT-4")

if ok1.ok:
    again = M.apply_edits(
        ok1.new_content,
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
    ok((not again.ok) and again.reason == "NO_MATCH", "NL-2")

batch = M.apply_edits(
    "abcdefgh",
    [EditRequest(old="bcd", new="BCD"), EditRequest(old="cde", new="CDE")],
)
ok((not batch.ok) and batch.reason == "OVERLAP", "BATCH-1")
batch_ok = M.apply_edits(
    "abcdefgh",
    [EditRequest(old="bcd", new="BCD"), EditRequest(old="fgh", new="FGH")],
)
ok(batch_ok.ok and batch_ok.new_content == "aBCDeFGH", "BATCH-3")
fail2 = M.apply_edits(
    "abcdefgh",
    [EditRequest(old="bcd", new="BCD"), EditRequest(old="ZZZ", new="z")],
)
ok((not fail2.ok) and fail2.failed_at == 1, "BATCH-2")

section("C · 计划")
ok(not M.validate_plan(Plan(steps=[])).ok, "PLAN 空")
no_v = M.validate_plan(
    Plan(
        steps=[
            shared.PlanStep(id="r", kind="read", targets=["a.ts"], depends_on=[]),
            shared.PlanStep(id="e", kind="edit", targets=["a.ts"], depends_on=["r"]),
        ]
    )
)
ok((not no_v.ok) and no_v.reason == "NO_VERIFY_STEP", "PLAN-5")
no_r = M.validate_plan(
    Plan(
        steps=[
            shared.PlanStep(id="e", kind="edit", targets=["a.ts"], depends_on=[]),
            shared.PlanStep(id="v", kind="verify", targets=[], depends_on=["e"]),
        ]
    )
)
ok((not no_r.ok) and no_r.reason == "EDIT_WITHOUT_READ", "PLAN-6")
cyc = M.validate_plan(
    Plan(
        steps=[
            shared.PlanStep(id="a", kind="read", targets=["a.ts"], depends_on=["b"]),
            shared.PlanStep(id="b", kind="read", targets=["b.ts"], depends_on=["a"]),
            shared.PlanStep(id="v", kind="verify", targets=[], depends_on=["a"]),
        ]
    )
)
ok((not cyc.ok) and cyc.reason == "CYCLE", "PLAN-2")
good = Plan(
    steps=[
        shared.PlanStep(id="r", kind="read", targets=["a.ts"], depends_on=[]),
        shared.PlanStep(id="e", kind="edit", targets=["a.ts"], depends_on=["r"]),
        shared.PlanStep(id="v", kind="verify", targets=[], depends_on=["e"]),
    ]
)
ok(M.validate_plan(good).ok, "PLAN 合法")
eq("edit_file" in M.tools_for("plan"), False, "PHASE-1")
eq("edit_file" in M.tools_for("execute"), True, "PHASE execute")

adh = M.adherence(
    good,
    [
        shared.ToolLogEntry(seq=1, tool="read_file", path="a.ts", step_id="r"),
        shared.ToolLogEntry(seq=2, tool="edit_file", path="a.ts", step_id="e"),
        shared.ToolLogEntry(seq=3, tool="edit_file", path="extra.ts"),
        shared.ToolLogEntry(seq=4, tool="verify", step_id="v"),
    ],
)
ok("extra.ts" in adh.unplanned_files, "ADH-1")
ok(adh.verify_ran_after_last_edit, "ADH-4 true")
adh2 = M.adherence(
    good,
    [
        shared.ToolLogEntry(seq=1, tool="edit_file", path="a.ts", step_id="e"),
        shared.ToolLogEntry(seq=2, tool="verify", step_id="v"),
        shared.ToolLogEntry(seq=3, tool="edit_file", path="a.ts"),
    ],
)
ok(not adh2.verify_ran_after_last_edit, "ADH-4 false")

section("D · 测试解析与终止")
p1 = M.parse_test_output("===== 3 passed, 1 skipped in 0.12s =====\n", 0)
eq([p1.passed, p1.skipped, p1.collected, p1.confidence], [3, 1, 4, "exact"], "PARSE-1")
eq(
    M.parse_test_output(
        "=====\x1b[32m 3 passed\x1b[0m, 1 skipped in 0.12s =====\n", 0
    ).passed,
    3,
    "PARSE-2",
)
ok(M.parse_test_output("garbage", 0).confidence == "unparsed", "PARSE-3")
ok(not M.is_green(M.parse_test_output("garbage", 0)), "PARSE-3 isGreen")
ok(not M.is_green(M.parse_test_output("===== no tests ran in 0.01s =====\n", 5)), "PARSE-4")
ok(not M.is_green(M.parse_test_output("===== 3 passed, 1 skipped in 0.12s =", 0)), "PARSE-6")
fake = (
    "print says 3 passed\n"
    "===== 3 passed, 1 failed in 0.1s =====\n"
    "===== 3 passed, 0 failed in 0.1s =====\n"
)
eq(M.parse_test_output(fake, 0).failed, 0, "PARSE-7")

# 两门语言对「行首」和「空白」的定义不同：先切行、再逐行匹配，空白只认空格和 tab
via_cr = M.parse_test_output("progress 50%\r===== 3 passed in 0.10s =====\n", 0)
eq([via_cr.confidence, via_cr.passed], ["exact", 3], "PARSE-8 裸 \\r 之后是新的一行")
eq(
    M.parse_test_output("note\u2028===== 3 passed in 0.10s =====\n", 0).confidence,
    "unparsed",
    "PARSE-9 U+2028 不分行 → unparsed",
)
eq(
    [
        M.parse_test_output("PASS\r\n", 0).confidence,
        M.parse_test_output("Tests\x1c3 passed\n", 0).confidence,
    ],
    ["exact", "unparsed"],
    "PARSE-10 PASS\\r\\n 认得；\\x1c 不算空白",
)

baseline = Baseline(collected=3, skipped=0, test_file_hashes={"tests/t.py": "abc"})
green_v = VerifyResult(
    runner="pytest", passed=3, failed=0, skipped=0, collected=3, confidence="exact", exit_code=0
)


def _stop(**kw: Any) -> StopState:
    return StopState(**kw)


ok(
    not M.can_stop(
        _stop(
            finished=True,
            gave_up=False,
            last_edit_seq=1,
            last_verify_seq=-1,
            verify=None,
            unplanned_files=[],
            revised_for_unplanned=False,
            current_test_file_hashes={"tests/t.py": "abc"},
        ),
        baseline,
    ).can_stop,
    "STOP-1",
)
ok(
    not M.can_stop(
        _stop(
            finished=True,
            gave_up=False,
            last_edit_seq=3,
            last_verify_seq=2,
            verify=green_v,
            unplanned_files=[],
            revised_for_unplanned=False,
            current_test_file_hashes={"tests/t.py": "abc"},
        ),
        baseline,
    ).can_stop,
    "STOP-3",
)
ok(
    M.can_stop(
        _stop(
            finished=True,
            gave_up=False,
            last_edit_seq=1,
            last_verify_seq=2,
            verify=green_v,
            unplanned_files=[],
            revised_for_unplanned=False,
            current_test_file_hashes={"tests/t.py": "abc"},
        ),
        baseline,
    ).can_stop,
    "STOP ok",
)
ok(
    not M.can_stop(
        _stop(
            finished=True,
            gave_up=False,
            last_edit_seq=1,
            last_verify_seq=2,
            verify=VerifyResult(
                runner="pytest",
                passed=1,
                failed=0,
                skipped=0,
                collected=1,
                confidence="exact",
                exit_code=0,
            ),
            unplanned_files=[],
            revised_for_unplanned=False,
            current_test_file_hashes={"tests/t.py": "abc"},
        ),
        baseline,
    ).can_stop,
    "STOP-4",
)
ok(
    not M.can_stop(
        _stop(
            finished=True,
            gave_up=False,
            last_edit_seq=1,
            last_verify_seq=2,
            verify=green_v,
            unplanned_files=[],
            revised_for_unplanned=False,
            current_test_file_hashes={"tests/t.py": "CHANGED"},
        ),
        baseline,
    ).can_stop,
    "STOP-7",
)
ok(
    M.can_stop(
        _stop(
            finished=False,
            gave_up=True,
            give_up_reason="blocked on auth",
            last_edit_seq=1,
            last_verify_seq=-1,
            verify=None,
            unplanned_files=[],
            revised_for_unplanned=False,
            current_test_file_hashes={},
        ),
        baseline,
    ).can_stop,
    "STOP-9",
)

section("E · reward hacking 检测器")
ok(
    any(
        h.rule == "TEST_FILE_MODIFIED"
        for h in M.detect_hacks(DetectHacksInput(changed_files=["tests/test_foo.py"]))
    ),
    "HACK-3",
)
ok(
    any(
        h.rule == "SKIP_MARKER_ADDED"
        for h in M.detect_hacks(DetectHacksInput(diff_text="+@pytest.mark.skip\ndef test_x():\n"))
    ),
    "HACK-4",
)
ok(
    any(
        h.rule == "UPSTREAM_MODIFIED"
        for h in M.detect_hacks(DetectHacksInput(changed_files=["node_modules/x/index.js"]))
    ),
    "HACK-5",
)
ok(
    any(
        h.rule == "SKIP_INCREASED"
        for h in M.detect_hacks(
            DetectHacksInput(
                verify=VerifyResult(
                    runner="pytest",
                    passed=9,
                    failed=0,
                    skipped=5,
                    collected=14,
                    confidence="exact",
                    exit_code=0,
                ),
                baseline=Baseline(collected=14, skipped=0, test_file_hashes={}),
            )
        )
    ),
    "HACK-2",
)
ok(
    len(
        M.detect_hacks(
            DetectHacksInput(
                changed_files=["src/fix.ts"],
                diff_text="@@ -1,3 +1,3 @@\n-old\n+new\n",
            )
        )
    )
    == 0,
    "HACK-11",
)

section("F · 沙箱")
root = tempfile.mkdtemp(prefix="l17v-")
evil = root + "-evil"
os.makedirs(evil, exist_ok=True)
Path(evil, "x").write_text("nope", encoding="utf-8")
os.makedirs(Path(root, "src"), exist_ok=True)
Path(root, "src", "main.ts").write_text("ok", encoding="utf-8")
try:
    os.symlink("/etc", str(Path(root, "link")))
except OSError:
    pass

ok(not M.resolve_in_workspace(root, "../etc/passwd", "read").ok, "SBX-1")
ok(not M.resolve_in_workspace(root, "a/../../etc/passwd", "read").ok, "SBX-2")
ok(not M.resolve_in_workspace(root, "/etc/passwd", "read").ok, "SBX-3")
to_evil = "../" + Path(root).name + "-evil/x"
ok(not M.resolve_in_workspace(root, to_evil, "read").ok, "SBX-4")
ok(not M.resolve_in_workspace(root, "a\0b", "read").ok, "SBX-5")
ok(not M.resolve_in_workspace(root, "src\\main.ts", "read").ok, "SBX-6")
ok(not M.resolve_in_workspace(root, "./.git/config", "read").ok, "SBX-11")
ok(not M.resolve_in_workspace(root, "node_modules/x", "read").ok, "SBX-12")
ok(not M.resolve_in_workspace(root, ".env.local", "read").ok, "SBX-13")
ok(M.resolve_in_workspace(root, "src/main.ts", "read").ok, "SBX ok")
conf = M.resolve_in_workspace(root, "package.json", "write")
ok(conf.ok and conf.requires_confirmation, "INJ-2")

# 符号链接：out → root 外的目录；loop → 自己；dang → 不存在的地方；g → root 里的 .git
os.makedirs(Path(root, ".git"), exist_ok=True)
Path(root, ".git", "config").write_text("[core]", encoding="utf-8")
try:
    os.symlink(evil, str(Path(root, "out")))
    os.symlink("loop", str(Path(root, "loop")))
    os.symlink(str(Path(evil, "nope")), str(Path(root, "dang")))
    os.symlink(".git", str(Path(root, "g")))
    linked = True
except OSError:
    linked = False
if linked:

    def reason(p: str, op: str) -> str:
        r = M.resolve_in_workspace(root, p, op)
        return "ok" if r.ok else r.reason

    eq(reason("out/x", "read"), "SYMLINK_ESCAPES_ROOT", "SBX-7 已存在文件经符号链接出 root")
    eq(
        [reason("out/new.txt", "write"), reason("out/a/b/new.txt", "write")],
        ["SYMLINK_ESCAPES_ROOT", "SYMLINK_ESCAPES_ROOT"],
        "SBX-8 在符号链接目录下新建：realpath 最近的已存在祖先",
    )
    made = M.Workspace(root).create("out/new.txt", "leak")
    ok(
        (not made.ok) and not os.path.exists(Path(evil, "new.txt")),
        "SBX-8b create 不得写到 root 外",
    )
    eq(
        [reason("loop", "read"), reason("loop/x", "write")],
        ["SYMLINK_LOOP", "SYMLINK_LOOP"],
        "SBX-9 符号链接环",
    )
    ok(reason("dang/x", "write") != "ok", "SBX-10 悬空链接：落点未知 → 拒")
    eq(
        [reason(p, "read") for p in (".ENV", ".Env.Local", ".GIT/config", "Node_Modules/x")],
        ["DENIED_PATH", "DENIED_PATH", "DENIED_PATH", "DENIED_PATH"],
        "SBX-14 deny 大小写不敏感",
    )
    eq(reason("g/config", "read"), "DENIED_PATH", "SBX-15 deny 也查解析后的路径")

ws = M.Workspace(root)
e1 = ws.edit("src/main.ts", [EditRequest(old="ok", new="OK")])
ok((not e1.ok) and e1.reason == "READ_REQUIRED", "STALE-1")
ws.read("src/main.ts")
Path(root, "src", "main.ts").write_text("changed externally", encoding="utf-8")
e2 = ws.edit("src/main.ts", [EditRequest(old="ok", new="OK")])
ok((not e2.ok) and e2.reason == "STALE_READ", "STALE-4")
ws.read("src/main.ts")
e3 = ws.edit("src/main.ts", [EditRequest(old="changed externally", new="fixed")])
ok(e3.ok, "STALE-5")
if e3.ok:
    eq(Path(root, "src", "main.ts").read_text(encoding="utf-8"), "fixed", "写入生效")
e4 = ws.edit("src/main.ts", [EditRequest(old="fixed", new="fixed2")])
ok(e4.ok, "STALE-5 第二次")

shutil.rmtree(root, ignore_errors=True)
shutil.rmtree(evil, ignore_errors=True)

print()
if not failures:
    print(f"{GREEN}  ✓ {passed} 条断言全部通过{OFF}")
    raise SystemExit(0)
print(f"{RED}  {len(failures)} 条失败，{passed} 条通过{OFF}")
raise SystemExit(1)
