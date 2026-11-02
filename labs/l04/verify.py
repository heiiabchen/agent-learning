"""
验证 l04/schema.py 和 l04/toolbox.py。跑法：uv run python -m l04.verify

会在临时目录里建**真实文件和真实符号链接**——符号链接逃逸没法用假数据测。

先跑 VERIFY_TARGET=shared 确认这套测试本身是对的。
"""

from __future__ import annotations

import asyncio
import os
import shutil
import tempfile
from pathlib import Path

_TARGET = "shared" if os.environ.get("VERIFY_TARGET") == "shared" else "mine"

if _TARGET == "shared":
    from shared.sandbox import safe_path, truncate
    from shared.toolbox import make_list_dir, make_read_file, make_search_code
    from shared.tools import (
        ParseOk,
        ToolBox,
        ToolDef,
        ToolResult,
        optional_int,
        require_string,
        tool_result_message,
        tool_uses_of,
    )
else:
    from l04.schema import (
        ParseOk,
        ToolBox,
        ToolDef,
        ToolResult,
        optional_int,
        require_string,
        tool_result_message,
        tool_uses_of,
    )
    from l04.toolbox import make_list_dir, make_read_file, safe_path, truncate

    make_search_code = None  # type: ignore[assignment]

print(
    "\n（测的是 shared/ 里的参考实现）" if _TARGET == "shared" else "\n（测的是 l04/ 里你的实现）"
)

passed = 0
failures: list[str] = []


def test(name: str, fn) -> None:
    global passed
    try:
        r = fn()
        if asyncio.iscoroutine(r):
            asyncio.run(r)
        passed += 1
        print(f"\x1b[32m  ✓\x1b[0m {name}")
    except AssertionError as err:
        failures.append(name)
        print(f"\x1b[31m  ✕ {name}\x1b[0m")
        print(f"\x1b[31m      {err}\x1b[0m")
    except NotImplementedError as err:
        failures.append(name)
        print(f"\x1b[31m  ✕ {name}\x1b[0m")
        print(f"\x1b[31m      还没实现：{err}\x1b[0m")


def _eq(a, b, hint: str = "") -> None:
    assert a == b, f"期待 {b}，实际 {a}" + (f"\n      {hint}" if hint else "")


def _assert_ok(r, want) -> None:
    assert r.ok, f"应该通过：{r}"
    assert isinstance(r, ParseOk) and r.input == want, f"期待 {want}，实际 {r}"


def _assert_fail(r, hint: str) -> None:
    assert not r.ok, hint


# ── 造一个真实的临时仓库 ──────────────────────────────────────────────────

root = Path(tempfile.mkdtemp(prefix="l04-"))
outside = Path(tempfile.mkdtemp(prefix="l04-outside-"))

(outside / "secret.txt").write_text("TOP SECRET")
(root / "src").mkdir()
(root / "node_modules" / "junk").mkdir(parents=True)
(root / "src" / "index.ts").write_text("export const a = 1\nexport const b = 2\nconst c = 3\n")
(root / "src" / "big.txt").write_text("中" * 60_000)
(root / "README.md").write_text("# hello\nsearchable needle here\n")
(root / "node_modules" / "junk" / "x.js").write_text("needle in node_modules")
# 仓库内一个指向外面的符号链接。路径字符串看起来完全正常。
(root / "src" / "escape.txt").symlink_to(outside / "secret.txt")

# ── require_string ───────────────────────────────────────────────────────

print("\nrequire_string")

test("正常字符串", lambda: _assert_ok(require_string({"path": "a.ts"}, "path"), "a.ts"))


def t_missing():
    r = require_string({}, "path")
    assert not r.ok, "字段缺失应该失败"
    assert "path" in r.message, f"错误信息里要提到字段名，实际：{r.message}"


test("字段缺失", t_missing)

test(
    "★ 值是数字而不是字符串",
    lambda: _assert_fail(
        require_string({"path": 42}, "path"),
        "模型真的会传数字。直接往下走会在某个文件操作里炸，离原因很远。",
    ),
)


def t_not_dict():
    for bad in [None, "string", 42, []]:
        assert not require_string(bad, "path").ok, f"raw = {bad!r} 时应该失败"
    # ★ 空 dict 也要失败，但原因是字段缺失。
    # 用 `if not raw` 判断的话会把它当成「不是对象」，错误信息就说不清了。
    r = require_string({}, "path")
    assert not r.ok and "path" in r.message, "空 dict 应该报「缺少 path」而不是「不是对象」"


test("★ raw 不是 dict / 是空 dict", t_not_dict)

test(
    "空字符串和纯空格都要拒",
    lambda: (
        _assert_fail(require_string({"path": ""}, "path"), "空字符串应该拒"),
        _assert_fail(require_string({"path": "  "}, "path"), "纯空格应该拒"),
    ),
)

# ── optional_int ─────────────────────────────────────────────────────────

print("\noptional_int")

test("正常取值", lambda: _eq(optional_int({"n": 10}, "n", 20, 1, 50), 10))
test("缺失时用默认值", lambda: _eq(optional_int({}, "n", 20, 1, 50), 20))

test(
    "★ 越界要夹回范围",
    lambda: (
        _eq(
            optional_int({"n": 500}, "n", 20, 1, 50),
            50,
            "schema 写了 maximum: 50 但模型给 500，这是常事。夹回比报错少一个往返。",
        ),
        _eq(optional_int({"n": -3}, "n", 20, 1, 50), 1),
    ),
)

test(
    "非数字退回默认值",
    lambda: (
        _eq(optional_int({"n": "abc"}, "n", 20, 1, 50), 20),
        _eq(optional_int({"n": None}, "n", 20, 1, 50), 20),
    ),
)

test("小数要截成整数", lambda: _eq(optional_int({"n": 10.9}, "n", 20, 1, 50), 10))

# ── ToolBox ──────────────────────────────────────────────────────────────

print("\nToolBox")


async def _echo_run(inp):
    return ToolResult(content=f"echo: {inp}")


dummy = ToolDef(
    name="echo",
    description="回显",
    input_schema={
        "type": "object",
        "properties": {"text": {"type": "string"}},
        "required": ["text"],
    },
    parse=lambda raw: require_string(raw, "text"),
    run=_echo_run,
)

test("注册与列名", lambda: _eq(ToolBox([dummy]).names, ["echo"]))


def t_dup():
    box = ToolBox([dummy])
    try:
        box.register(dummy)
    except Exception:
        return
    raise AssertionError("重名是你的 bug，不是模型的，该响")


test("重名注册要抛错", t_dup)


def t_api_shape():
    api = ToolBox([dummy]).api_tools()
    assert len(api) == 1, f"应该有一个：{api}"
    assert api[0]["name"] == "echo" and "input_schema" in api[0], f"形状不对：{api[0]}"


test("api_tools 形状正确", t_api_shape)


async def t_exec_ok():
    r = await ToolBox([dummy]).execute("echo", {"text": "hi"})
    _eq(r.content, "echo: hi")


test("正常执行", t_exec_ok)


async def t_unknown_tool():
    r = await ToolBox([dummy]).execute("delete_file", {})
    assert r.is_error, "编造的工具名必须回 is_error，不能抛异常"
    assert "echo" in r.content, (
        "错误信息里必须列出真实可用的工具，否则模型只能继续猜。\n"
        f"      实际：{r.content}\n"
        "      （模型编造工具名是模式补全，不是幻觉——它需要一份真清单。）"
    )


test("★★ 不存在的工具名：回 is_error 并列出真实清单", t_unknown_tool)


async def t_parse_fail():
    r = await ToolBox([dummy]).execute("echo", {})
    assert r.is_error, "校验失败该回 is_error 而不是抛"


test("参数校验失败：回 is_error，不抛", t_parse_fail)

# ── tool_uses_of / tool_result_message ───────────────────────────────────

print("\ntool_uses_of / tool_result_message")

blocks = [
    {"type": "text", "text": "我来查一下"},
    {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {"path": "a.ts"}},
    {"type": "tool_use", "id": "toolu_2", "name": "list_dir", "input": {"path": "."}},
]

test(
    "只挑出 tool_use 块",
    lambda: _eq([t["id"] for t in tool_uses_of(blocks)], ["toolu_1", "toolu_2"]),
)


def t_one_message():
    msg = tool_result_message(tool_uses_of(blocks), [ToolResult("A"), ToolResult("B")])
    _eq(msg["role"], "user", "tool_result 走 user 角色——协议里只有 user 和 assistant")
    _eq(len(msg["content"]), 2, "两个结果要在同一条消息里，分成多条会造成连续两条 user")


test("结果拼成一条 user 消息", t_one_message)


def t_order():
    msg = tool_result_message(tool_uses_of(blocks), [ToolResult("A"), ToolResult("B")])
    _eq(
        [c["tool_use_id"] for c in msg["content"]],
        ["toolu_1", "toolu_2"],
        "顺序抖动的后果：前缀缓存失效 + 问题无法复现。用 gather 保序，别「谁完成谁 append」。",
    )


test("★ 顺序跟 tool_use 一致", t_order)


def t_is_error():
    msg = tool_result_message([tool_uses_of(blocks)[0]], [ToolResult("X", is_error=True)])
    assert msg["content"][0].get("is_error") is True, f"is_error 没传过去：{msg['content'][0]}"


test("is_error 要传过去", t_is_error)


def t_len_mismatch():
    try:
        tool_result_message(tool_uses_of(blocks), [ToolResult("only one")])
    except Exception:
        return
    raise AssertionError("数量对不上是你的 bug，该响")


test("数量对不上要抛错", t_len_mismatch)

# ── safe_path：攻击输入 ──────────────────────────────────────────────────

print("\nsafe_path")


def t_normal_path():
    r = safe_path(root, "src/index.ts")
    assert r.ok, f"应该通过：{r}"
    _eq(r.rel, "src/index.ts")


test("正常相对路径", t_normal_path)

test(
    "★★ 经典路径穿越",
    lambda: _assert_fail(
        safe_path(root, "../../etc/passwd"),
        "abspath(root / '../../etc/passwd') 会老老实实解析到 /etc/passwd。\n"
        "      正确形状：先规范化，再用 is_relative_to 验证结果仍在根内。",
    ),
)

test(
    "★★ 绝对路径",
    lambda: _assert_fail(safe_path(root, "/etc/passwd"), "绝对路径要挡住"),
)

test(
    "★ 中间穿越，末尾看起来正常",
    lambda: _assert_fail(
        safe_path(root, "src/../../outside/secret.txt"),
        "别用字符串前缀匹配判断——要看规范化之后的结果",
    ),
)


def t_dotdot_name():
    r = safe_path(root, "..notes.md", False)
    assert r.ok, (
        f"根内的 ..notes.md 被判成越界了：{r}\n"
        "      别对 relpath 的字符串查 startswith('..')，用 is_relative_to。"
    )
    _eq(r.rel, "..notes.md")


test("★ 文件名以 .. 开头不是穿越", t_dotdot_name)

test(
    "★ NUL 字节",
    lambda: _assert_fail(
        safe_path(root, "safe.txt\0../../etc/passwd"),
        "NUL 会截断 C 层字符串，是经典绕过手法。显式拒绝比依赖运行时行为好。",
    ),
)

test("空字符串", lambda: _assert_fail(safe_path(root, ""), "空路径应该拒"))

test(
    "★★ 符号链接逃逸（纯路径检查挡不住）",
    lambda: _assert_fail(
        safe_path(root, "src/escape.txt"),
        "仓库内一个指向外面的 symlink：路径字符串完全正常，规范化之后也在根内。\n"
        "      只有 resolve()（会解析符号链接）之后再验一次才挡得住。\n"
        "      ★ 如果你用的是 os.path.abspath，它不解析符号链接，这条必然挂。",
    ),
)


def t_root_is_symlink():
    # macOS 上 /tmp 就是指向 /private/tmp 的符号链接，而临时目录都在 /tmp 下。
    r = safe_path(root, "README.md")
    assert r.ok, (
        "root 本身是符号链接时（macOS 的 /tmp 就是），\n"
        "      如果只对 full 做 resolve 而不对 root 做，正常路径会被全部判成越界。\n"
        "      两边都要 resolve 之后再比。"
    )


test("★ root 本身是 symlink 时不能误判正常路径", t_root_is_symlink)


def t_no_abs_leak():
    r = safe_path(root, "../../nosuch/secret.txt")
    assert not r.ok, "应该失败"
    assert str(root) not in r.message and tempfile.gettempdir() not in r.message, (
        f"message 里泄露了 root 的绝对路径：{r.message}\n"
        "      上下文里的东西模型后面都可能复述出来。绝对路径放 log_note，不放 message。"
    )
    assert r.log_note, "越界尝试要留一条日志"


test("★ 消息里不能泄露解析后的绝对路径", t_no_abs_leak)

# ── truncate ─────────────────────────────────────────────────────────────

print("\ntruncate")

test("短内容原样返回", lambda: _eq(truncate("hello", 1000), ("hello", False)))


def t_trunc_notice():
    text, was = truncate("x" * 5000, 1000)
    assert was, "应该标记为截断"
    assert "截断" in text, (
        "截断了但没在内容里说。模型会以为看到了完整文件，然后基于残缺内容下结论。"
    )


test("★ 截断必须明确告知", t_trunc_notice)


def t_trunc_utf8():
    text, _ = truncate("中" * 1000, 1000)
    assert "\ufffd" not in text, "出现了 U+FFFD。用 decode(errors='ignore') 丢掉切断的尾巴。"


test("★ 按字节截断不能留下半个多字节字符", t_trunc_utf8)

# ── 真实工具 ─────────────────────────────────────────────────────────────

print("\nread_file / list_dir")

read_file = make_read_file(root)
list_dir = make_list_dir(root)


async def t_read_ok():
    p = read_file.parse({"path": "src/index.ts"})
    assert p.ok, f"校验应该通过：{p}"
    r = await read_file.run(p.input)
    assert not r.is_error and "export const a = 1" in r.content, f"读取失败：{r}"


test("read_file 正常读取", t_read_ok)

test("read_file 缺 path 要被拦下", lambda: _assert_fail(read_file.parse({}), "path 必填"))


async def t_read_missing():
    p = read_file.parse({"path": "src/nope.ts"})
    assert p.ok, "路径合法但文件不存在，parse 应该通过"
    r = await read_file.run(p.input)
    assert r.is_error, "应该 is_error"
    assert "list_dir" in r.content, (
        f"错误信息里没有下一步建议。实际：{r.content}\n"
        "      模型读完只会重试同一个路径。判据不是「准确描述故障」，是「读完知道干什么」。"
    )


test("★ read_file 文件不存在时要给出路", t_read_missing)


async def t_read_dir():
    p = read_file.parse({"path": "src"})
    assert p.ok
    r = await read_file.run(p.input)
    assert r.is_error and "list_dir" in r.content, f"应该提示改用 list_dir：{r.content}"


test("read_file 读到目录时要提示 list_dir", t_read_dir)


async def t_read_range():
    p = read_file.parse({"path": "src/index.ts", "start_line": 2, "end_line": 3})
    assert p.ok, f"校验应该通过：{p}"
    r = await read_file.run(p.input)
    assert "export const b" in r.content, f"应该返回指定区间：{r.content}"
    assert "export const a" not in r.content, "第 1 行不该出现"
    assert "2" in r.content, "要带行号前缀，模型下一步才能准确指定编辑位置"


test("read_file 行号区间要带行号前缀", t_read_range)

test(
    "read_file end_line < start_line 要拦下",
    lambda: _assert_fail(
        read_file.parse({"path": "src/index.ts", "start_line": 5, "end_line": 2}), "区间反了要拒"
    ),
)


async def t_read_big():
    p = read_file.parse({"path": "src/big.txt"})
    assert p.ok
    r = await read_file.run(p.input)
    assert "截断" in r.content, "大文件必须截断并说明——否则一次调用就能撞满上下文"


test("read_file 大文件要被截断并告知", t_read_big)


async def t_read_escape():
    p = read_file.parse({"path": "../../etc/passwd"})
    assert p.ok, "路径校验在 run 里，不在 parse 里（parse 只管类型）"
    r = await read_file.run(p.input)
    assert r.is_error, "越界必须被 run 挡下"


test("★ read_file 挡住越界路径", t_read_escape)


async def t_list_order():
    p = list_dir.parse({"path": "."})
    assert p.ok
    r = await list_dir.run(p.input)
    lines = r.content.split("\n")
    dirs = [i for i, ln in enumerate(lines) if "/" in ln]
    files = [i for i, ln in enumerate(lines) if "/" not in ln]
    assert not files or not dirs or max(dirs) < min(files), (
        f"目录应该排在文件前面：\n{r.content}\n      输出稳定才可能命中缓存"
    )


test("list_dir 目录排在文件前", t_list_order)


async def t_list_skipped():
    p = list_dir.parse({"path": "."})
    assert p.ok
    r = await list_dir.run(p.input)
    assert "node_modules" in r.content, (
        f"被跳过的目录也要列出来并标注。实际：\n{r.content}\n"
        "      完全不提的话，模型会以为它不存在然后反复去找。"
    )


test("★ list_dir 跳过的目录也要列出并标注", t_list_skipped)


def t_depth_clamp():
    p = list_dir.parse({"path": ".", "depth": 99})
    assert p.ok and p.input["depth"] <= 3, f"depth 应该夹到 3 以内：{p}"


test("list_dir depth 越界要夹回", t_depth_clamp)

if make_search_code is not None:
    print("\nsearch_code")
    search = make_search_code(root)

    async def t_search_hit():
        p = search.parse({"pattern": "needle"})
        assert p.ok
        r = await search.run(p.input)
        assert "README.md" in r.content, f"应该找到 README.md：{r.content}"
        assert "node_modules" not in r.content, "描述里承诺跳过 node_modules，就必须真跳过"

    test("search_code 找到匹配", t_search_hit)

    def t_search_bad_re():
        p = search.parse({"pattern": "[invalid("})
        assert not p.ok, "非法正则是模型能改的，回 message 让它重写"
        assert len(p.message) > 4, "要带上正则的报错原文，否则它不知道哪里错了"

    test("★ search_code 非法正则要回给模型", t_search_bad_re)

# ── 收尾 ─────────────────────────────────────────────────────────────────

shutil.rmtree(root, ignore_errors=True)
shutil.rmtree(outside, ignore_errors=True)

total = passed + len(failures)
print(f"\n{'─' * 52}")
if not failures:
    print(f"\x1b[32m全绿 {passed}/{total}。\x1b[0m 去看 shared/ 里那两版对照一下取舍。")
else:
    print(f"\x1b[31m{len(failures)}/{total} 没过：\x1b[0m")
    for f in failures:
        print(f"  · {f}")
    print("\n带 ★★ 的是真漏洞，别跳过。")
    raise SystemExit(1)
