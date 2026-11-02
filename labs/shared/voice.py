r"""L16y 参考实现：语音 agent 的时间账。shared/voice.ts 的 Python 镜像。

L16 管的是「屏幕上画了什么」，这里管的是「用户听到了什么」。
语音只有一条串行的音频通道，用户和 agent 轮流用它；所有的难题都是时间问题：

  A. VAD 四态滞回：一帧过阈值不算开口，一小段静音不算说完
  B. 端点：语义模型只能把等待从 min 延长到 max，从不缩短
  C. 投机生成：提交时的四元组和投机时一致，才能直接用
  D. 播放账本：生成 ≠ 发送 ≠ 播放；打断时历史截到用户听到的位置
  E. 打断判定：持续够久才算打断；打断后迟迟没有转写就恢复
  F. 中英文流式分句：中文句号后面没有空格
  G. 填充语：连续空闲满 delay 才说，不是「工具开始后 delay 毫秒」
  H. 任务板：口头更新只能来自已验证的状态；改了需求，旧结果作废
  I. 延迟账：同一个话轮，四种「首音延迟」

★ 时间全是注入的整数毫秒；输入全是合成的（20ms 一帧的 VAD 概率、带时间戳的 token、
TTS 块的文本和时长）。没有音频、不调模型。
★ 跨语言字节一致：不用 \w \d \s，长度一律按码点，去空白只去 ASCII 空格。

─── Python 侧的差异 ───────────────────────────────────────────

天然就对的：
  · len(s)、s[:k]、for c in s 都按码点走。TS 那边要专门写 Array.from。
  · 非负整数的 Math.floor(a / b) 就是 a // b。
  · sorted() 是稳定排序，和 Array.prototype.sort 一样。

反而要小心的：
  · str.strip() 不只去 ASCII 空格（U+00A0 也去），str.lower() 会动非 ASCII 字母。都不能用。
  · 正则的 $ 还匹配「末尾换行之前」，一律改用 \Z。
  · \w 在 Python 里认汉字、在 TS 里不认；\s \d 两边也不一样。一律写显式字符类。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

Ms = int

FRAME_MS = 20


def _cp_len(s: str) -> int:
    return len(s)


def _trim_spaces(s: str) -> str:
    a = 0
    b = len(s)
    while a < b and s[a] == " ":
        a += 1
    while b > a and s[b - 1] == " ":
        b -= 1
    return s[a:b]


# ─────────────────────────────────────────────────────────────
# A. VAD 四态滞回
# ─────────────────────────────────────────────────────────────

VadState = Literal["quiet", "starting", "speaking", "stopping"]


@dataclass(frozen=True)
class VadParams:
    # p ≥ threshold 的帧算有声。
    threshold: float
    # 连续有声满这么久才进 speaking。
    start_ms: Ms
    # 连续无声满这么久才回 quiet。
    stop_ms: Ms


# Pipecat VADParams 的默认值：confidence 0.7、start 0.2s、stop 0.2s。
VAD_DEFAULTS = VadParams(threshold=0.7, start_ms=200, stop_ms=200)


@dataclass(frozen=True)
class VadMachine:
    state: VadState
    # 当前这段有声 / 无声从什么时刻开始。
    since: Ms
    # 最后一个有声帧的时刻。
    last_speech_at: Ms | None


VAD_INIT = VadMachine(state="quiet", since=0, last_speech_at=None)


@dataclass(frozen=True)
class VadEvent:
    kind: Literal["speech_start", "speech_end"]
    # 判定发生的时刻。
    t: Ms
    # 最后一个有声帧的时刻。speech_end 的「用户什么时候说完」要用它，不是 t。
    last_speech_at: Ms


@dataclass(frozen=True)
class VadFrame:
    """一帧：t 是这一帧结束的时刻，覆盖 (t − FRAME_MS, t]。"""

    t: Ms
    p: float


def vad_step(m: VadMachine, f: VadFrame, p: VadParams) -> tuple[VadMachine, VadEvent | None]:
    """喂一帧，返回新状态和可能的事件。

      quiet    ──有声──▶ starting（since = 这段有声的起点）
      starting ──有声且已满 start_ms──▶ speaking，发 speech_start
      starting ──无声──▶ quiet（计时清零）
      speaking ──无声──▶ stopping（since = 最后一个有声帧）
      stopping ──有声──▶ speaking（不发事件：这只是一次停顿）
      stopping ──无声且已满 stop_ms──▶ quiet，发 speech_end

    ★ 单帧尖峰不是开口；160ms 的换气不是说完。
    ★ speech_end.last_speech_at 是最后一个有声帧，不是判定时刻——两者差了整整 stop_ms。
    """
    voiced = f.p >= p.threshold
    last = f.t if voiced else m.last_speech_at
    if m.state in ("quiet", "starting"):
        if not voiced:
            return VadMachine(state="quiet", since=f.t, last_speech_at=m.last_speech_at), None
        since = f.t - FRAME_MS if m.state == "quiet" else m.since
        if f.t - since >= p.start_ms:
            return (
                VadMachine(state="speaking", since=since, last_speech_at=f.t),
                VadEvent(kind="speech_start", t=f.t, last_speech_at=f.t),
            )
        return VadMachine(state="starting", since=since, last_speech_at=last), None
    if voiced:
        since = m.since if m.state == "speaking" else f.t
        return VadMachine(state="speaking", since=since, last_speech_at=f.t), None
    if m.state == "speaking":
        since = m.last_speech_at if m.last_speech_at is not None else f.t - FRAME_MS
    else:
        since = m.since
    if f.t - since >= p.stop_ms:
        return (
            VadMachine(state="quiet", since=f.t, last_speech_at=last),
            VadEvent(kind="speech_end", t=f.t, last_speech_at=last if last is not None else since),
        )
    return VadMachine(state="stopping", since=since, last_speech_at=last), None


def run_vad(frames: list[VadFrame], p: VadParams = VAD_DEFAULTS) -> list[VadEvent]:
    m = VAD_INIT
    out: list[VadEvent] = []
    for f in frames:
        nxt, ev = vad_step(m, f, p)
        m = nxt
        if ev is not None:
            out.append(ev)
    return out


# ─────────────────────────────────────────────────────────────
# B. 端点
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class EndpointParams:
    min_delay_ms: Ms
    max_delay_ms: Ms
    # 「说完了」的概率低于它，才把等待延长到 max。按语种不同。
    unlikely_threshold: float


# LiveKit 默认 min 0.5s / max 3.0s；多语种话轮模型的中文、英文阈值。
ENDPOINT_ZH = EndpointParams(min_delay_ms=500, max_delay_ms=3000, unlikely_threshold=0.0066)
ENDPOINT_EN = EndpointParams(min_delay_ms=500, max_delay_ms=3000, unlikely_threshold=0.011)


def endpoint_delay(eou_prob: float, p: EndpointParams) -> Ms:
    """★ 模型从不让等待短于 min：概率高就用 min，概率低于阈值就用 max。
    「上了语义话轮模型响应更快」是错的——它买的是少截断，速度要靠投机生成。
    """
    return p.max_delay_ms if eou_prob < p.unlikely_threshold else p.min_delay_ms


def commit_turn(
    last_speech_at: Ms,
    eou_prob: float,
    stt_final_at: Ms | None,
    next_speech_start: Ms | None,
    p: EndpointParams,
) -> Ms | None:
    """话轮在什么时刻提交；不提交返回 None。
    commit_at = max(last_speech_at + endpoint_delay, stt_final_at)
    还没有任何 final 转写 → 不提交
    commit_at 之前用户又开口 → 不提交（那只是一次停顿）
    """
    if stt_final_at is None:
        return None
    wait = last_speech_at + endpoint_delay(eou_prob, p)
    commit_at = wait if wait > stt_final_at else stt_final_at
    if next_speech_start is not None and next_speech_start < commit_at:
        return None
    return commit_at


# ─────────────────────────────────────────────────────────────
# C. 投机生成
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SpecKey:
    transcript: str
    ctx_version: int
    tools_version: int
    tool_choice: str


_PUNCT = frozenset("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~，。、；：？！“”‘’「」『』（）《》【】…—～·")


def normalize_transcript(s: str) -> str:
    r"""ASCII 字母转小写；去掉中英文标点；连续空白压成一个空格；去首尾空格。
    ★ 不能用 \w 去标点：TS 的 \w 不认汉字，一删就把整句中文删光了；Python 的 \w 认。
    """
    out = ""
    for c in s:
        if c in _PUNCT:
            continue
        if c in ("\t", "\n", "\r"):
            out += " "
        elif "A" <= c <= "Z":
            out += chr(ord(c) + 32)
        else:
            out += c
    return _trim_spaces(re.sub(" +", " ", out))


def speculation_valid(spec: SpecKey, committed: SpecKey) -> bool:
    """投机生成能不能直接用：转写（归一化后）、上下文版本、工具版本、tool_choice 四样都没变。
    ★ 只比转写不够：话轮等待期间工具列表或上下文变了，投机出来的回答是基于旧世界的。
    """
    return (
        normalize_transcript(spec.transcript) == normalize_transcript(committed.transcript)
        and spec.ctx_version == committed.ctx_version
        and spec.tools_version == committed.tools_version
        and spec.tool_choice == committed.tool_choice
    )


# ─────────────────────────────────────────────────────────────
# D. 播放账本
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TtsChunk:
    epoch: int
    item_id: str
    text: str
    ms: Ms


@dataclass(frozen=True)
class Truncation:
    item_id: str
    # 这个 item 实际播放到的位置（item 内的毫秒）。OpenAI truncate 的 audio_end_ms。
    audio_end_ms: Ms
    # 用户听到的文字。
    heard_text: str
    # 一帧都没播：整条 assistant 消息从历史里拿掉。
    drop_item: bool


def heard_text(chunks: list[TtsChunk], played_ms: Ms) -> str:
    """已播放 played_ms 毫秒时，用户听到的文字：整块照收，当前块按码点比例向下取整。
    ★ 按码点切，不按 UTF-16：「好😀好」播一半是「好」，不是「好」加半个 emoji。
    """
    left = played_ms
    out = ""
    for c in chunks:
        if left <= 0:
            break
        if left >= c.ms:
            out += c.text
            left -= c.ms
            continue
        out += c.text[: (len(c.text) * left) // c.ms]
        break
    return out


@dataclass
class _Scheduled:
    chunk: TtsChunk
    start: Ms


class PlaybackLedger:
    """单通道串行播放：每块从 max(入队时刻, 上一块播完) 开始播。
    服务端生成比实时快，所以入队可以远早于播放——账本只认播放。
    """

    def __init__(self) -> None:
        self.epoch = 0
        self._scheduled: list[_Scheduled] = []
        self._free_at: Ms = 0

    def enqueue(self, c: TtsChunk, t: Ms) -> Literal["queued", "stale"]:
        """旧 epoch 的块（打断之后才到的 TTS）直接丢弃。"""
        if c.epoch < self.epoch:
            return "stale"
        start = t if t > self._free_at else self._free_at
        self._scheduled.append(_Scheduled(chunk=c, start=start))
        self._free_at = start + c.ms
        return "queued"

    def played_ms_at(self, t: Ms) -> Ms:
        """当前 epoch 到时刻 t 为止一共播了多少毫秒。"""
        n = 0
        for s in self._scheduled:
            n += max(0, min(s.chunk.ms, t - s.start))
        return n

    def speaking_at(self, t: Ms) -> bool:
        """时刻 t 还有没播完的音频吗。"""
        return len(self._scheduled) > 0 and t < self._free_at

    def barge_in(self, t: Ms) -> Truncation | None:
        """用户在时刻 t 打断。没有在播或待播的音频 → None。
        否则：找到 t 时正在播（或排在最前、还没开始播）的那个 item，算它播到了哪里，
        epoch + 1，清空队列，通道从 t 起空闲。

        ★ audio_end_ms 是已播放，不是已生成、也不是已发送；它不会超过这个 item 已入队的总时长。
        ★ 一帧没播 → drop_item。
        """
        if not self.speaking_at(t):
            return None
        current = next(s for s in self._scheduled if t < s.start + s.chunk.ms)
        for s in self._scheduled:
            if s.start <= t < s.start + s.chunk.ms:
                current = s
        item_id = current.chunk.item_id
        mine = [s for s in self._scheduled if s.chunk.item_id == item_id]
        played = 0
        for s in mine:
            played += max(0, min(s.chunk.ms, t - s.start))
        trunc = Truncation(
            item_id=item_id,
            audio_end_ms=played,
            heard_text=heard_text([s.chunk for s in mine], played),
            drop_item=played == 0,
        )
        self.epoch += 1
        self._scheduled = []
        self._free_at = t
        return trunc


# ─────────────────────────────────────────────────────────────
# E. 打断判定
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class BargeInParams:
    # 用户的声音持续这么久才算打断。
    min_duration_ms: Ms
    # 用户停下后这么久仍没有任何转写，就当误打断，接着说。
    false_interruption_timeout_ms: Ms


# LiveKit：min_duration 0.5s；resume_false_interruption 开，2.0s 无转写则恢复。
BARGE_IN_DEFAULTS = BargeInParams(min_duration_ms=500, false_interruption_timeout_ms=2000)

BargeInVerdict = Literal["ignore", "interrupt", "resume"]


@dataclass(frozen=True)
class Span:
    start: Ms
    end: Ms


def judge_barge_in(
    user_speech: Span,
    agent_speaking: bool,
    first_transcript_at: Ms | None,
    p: BargeInParams = BARGE_IN_DEFAULTS,
) -> BargeInVerdict:
    """
      agent 没在说话           → ignore（这是话轮开始，不是打断）
      持续 < min_duration_ms   → ignore（回声尖峰、咳嗽、「嗯」）
      停下后 timeout 内有转写   → interrupt
      否则                     → resume（agent 已经停了，再接着说）
    resume 不是没事：用户听到了一次卡顿。
    """
    if not agent_speaking:
        return "ignore"
    if user_speech.end - user_speech.start < p.min_duration_ms:
        return "ignore"
    if (
        first_transcript_at is not None
        and first_transcript_at <= user_speech.end + p.false_interruption_timeout_ms
    ):
        return "interrupt"
    return "resume"


# ─────────────────────────────────────────────────────────────
# F. 中英文流式分句
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Tok:
    t: Ms
    text: str


@dataclass(frozen=True)
class Seg:
    t: Ms
    text: str


_CJK = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")
_CJK_PUNCT = re.compile(r"[\u3000-\u303f\uff00-\uffef\u201c\u201d\u2018\u2019]")
_ALNUM = re.compile(r"[A-Za-z0-9]")


def is_cjk(c: str) -> bool:
    return _CJK.search(c) is not None


def _is_cjk_punct(c: str) -> bool:
    return _CJK_PUNCT.search(c) is not None


def speech_units(s: str) -> int:
    """语音单位：一个汉字算 1，一串连续的 ASCII 字母数字算 1。按字符数定阈值，中文和英文不等价。"""
    n = 0
    in_run = False
    for c in s:
        if is_cjk(c):
            n += 1
            in_run = False
        elif _ALNUM.search(c):
            if not in_run:
                n += 1
            in_run = True
        else:
            in_run = False
    return n


def synth_tokens(text: str, t0: Ms = 300, dt: Ms = 30) -> list[Tok]:
    """合成 token 流：每个汉字 / 全角标点一个 token，ASCII 连续串（含前导空格）一个 token；
    第 i 个 token 在 t0 + i·dt 到达。只给观察实验和 verify 造输入。
    """
    out: list[str] = []
    cs = list(text)
    i = 0
    while i < len(cs):
        c = cs[i]
        if is_cjk(c) or _is_cjk_punct(c):
            out.append(c)
            i += 1
            continue
        j = i
        w = ""
        while j < len(cs) and cs[j] == " ":
            w += cs[j]
            j += 1
        while j < len(cs) and cs[j] != " " and not is_cjk(cs[j]) and not _is_cjk_punct(cs[j]):
            w += cs[j]
            j += 1
        if w == "":
            w = cs[j]
            j += 1
        out.append(w)
        i = j
    return [Tok(t=t0 + k * dt, text=s) for k, s in enumerate(out)]


HARD_CJK = "。！？；"
HARD_ASCII = "!?;"
CLOSERS = '”’」』）)"'
SOFT = "，,、：:"
ABBR = ["Dr", "Mr", "Mrs", "Ms", "Prof", "St", "vs", "e.g", "i.e", "p.m", "a.m", "etc"]
FIRST_MIN_UNITS = 4
LATER_MIN_UNITS = 8

_PREV_WORD = re.compile(r"([A-Za-z.]+)\Z")
_ONE_LETTER = re.compile(r"[A-Za-z]")


def split_stream(tokens: list[Tok], end_at: Ms) -> list[Seg]:
    """流式分句：token 一个个到，攒够一句就交给 TTS。end_at 是流结束的时刻，剩下的在那时冲出去。

      中文句末（。！？；）和 ! ? ; 无歧义，但多等 1 个字符：后引号（”」』）要跟着这一句走
      「.」必须前瞻 1 个字符：下一个是空格或汉字、且前一个词不是缩写，才是句号
        （39.9、1.2.3、example.com、Dr. Wang、3 p.m. 都不切）
      第一段可以在逗号处切（够 FIRST_MIN_UNITS 个语音单位）：首段为延迟服务
      后续段至少 LATER_MIN_UNITS 个单位、不在逗号处切：后续段为韵律服务

    ★ 分句只决定在哪切，不改字符：段与段之间只丢掉切点处的空格。
    ★ 「标点后跟空白」这条英文规则在中文上永远不触发——中文句号后面没有空格。
    """
    segs: list[Seg] = []
    buf: list[str] = []
    pending_dot = False
    pending_closer = False

    def cut_at(k: int, t: Ms) -> None:
        nonlocal buf
        text = _trim_spaces("".join(buf[:k]))
        buf = buf[k:]
        while buf and buf[0] == " ":
            buf.pop(0)
        if text:
            segs.append(Seg(t=t, text=text))

    def enough(k: int) -> bool:
        need = FIRST_MIN_UNITS if len(segs) == 0 else LATER_MIN_UNITS
        return speech_units("".join(buf[:k])) >= need

    for tk in tokens:
        for c in tk.text:
            if pending_closer:
                if c in CLOSERS:
                    buf.append(c)
                    continue
                pending_closer = False
                if enough(len(buf)):
                    cut_at(len(buf), tk.t)
            if pending_dot:
                pending_dot = False
                k = len(buf)
                m = _PREV_WORD.search("".join(buf[: k - 1]))
                prev_word = m.group(1) if m else ""
                is_abbr = prev_word in ABBR or _ONE_LETTER.fullmatch(prev_word) is not None
                if (c == " " or is_cjk(c)) and not is_abbr and enough(k):
                    cut_at(k, tk.t)
            buf.append(c)
            if c in HARD_CJK or c in HARD_ASCII:
                pending_closer = True
                continue
            if c == ".":
                pending_dot = True
                continue
            if len(segs) == 0 and c in SOFT and enough(len(buf)):
                cut_at(len(buf), tk.t)
    rest = _trim_spaces("".join(buf))
    if rest:
        segs.append(Seg(t=end_at, text=rest))
    return segs


def split_naive(tokens: list[Tok], end_at: Ms) -> list[Seg]:
    """对照组一：见到 .!?。！？ 立刻切。前端的第一版。"""
    segs: list[Seg] = []
    buf = ""
    for tk in tokens:
        for c in tk.text:
            buf += c
            if c in ".!?。！？":
                text = _trim_spaces(buf)
                if text:
                    segs.append(Seg(t=tk.t, text=text))
                buf = ""
    rest = _trim_spaces(buf)
    if rest:
        segs.append(Seg(t=end_at, text=rest))
    return segs


_PAPER_ABBR = ["Dr.", "Mr.", "PM."]


def split_paper(tokens: list[Tok], end_at: Ms) -> list[Seg]:
    """对照组二：arXiv 2603.05413 的四条规则——.!? 后跟空白才切、跳过缩写、
    至少 10 个字符、流结束时冲出。
    """
    segs: list[Seg] = []
    buf = ""
    for tk in tokens:
        for c in tk.text:
            buf += c
            cs = list(buf)
            n = len(cs)
            if n >= 2 and cs[n - 1] == " " and cs[n - 2] in ".!?":
                cand = _trim_spaces("".join(cs[: n - 1]))
                words = re.split(" +", cand)
                if words[-1] in _PAPER_ABBR:
                    continue
                if _cp_len(cand) < 10:
                    continue
                segs.append(Seg(t=tk.t, text=cand))
                buf = ""
    rest = _trim_spaces(buf)
    if rest:
        segs.append(Seg(t=end_at, text=rest))
    return segs


_BAD_TAIL = re.compile(r"(Dr|Mr|p\.m|a\.m)\.\Z")


def bad_splits(src: str, segs: list[Seg]) -> int:
    """误切：切点前是「.」而原文紧接着既不是空格也不是汉字；
    或者切在 Dr. / Mr. / p.m. / a.m. 之后。
    """
    cs = list(src)
    bad = 0
    pos = 0
    for i in range(len(segs) - 1):
        seg = list(segs[i].text)
        while pos < len(cs) and cs[pos] == " ":
            pos += 1
        end = pos + len(seg)
        pos = end
        prev = cs[end - 1] if 0 < end <= len(cs) else None
        nxt = cs[end] if end < len(cs) else ""
        tail = "".join(cs[max(0, end - 4) : end])
        if prev == "." and nxt != " " and nxt != "" and not is_cjk(nxt):
            bad += 1
        elif _BAD_TAIL.search(tail):
            bad += 1
    return bad


# ─────────────────────────────────────────────────────────────
# G. 填充语
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class FillerParams:
    # 连续空闲满这么久才说。LiveKit 默认 0。
    delay_ms: Ms
    # 说完一次后隔这么久（墙钟）再重新等空闲；None = 最多一次。
    interval_ms: Ms | None
    max_steps: int | None


def schedule_fillers(
    tool_start: Ms, tool_end: Ms, busy: list[Span], filler_ms: Ms, p: FillerParams
) -> list[Ms]:
    """工具在 [tool_start, tool_end) 运行；busy 是这期间有人在说话的区间（左闭右开）；
    每次填充语本身要播 filler_ms，播放期间也算忙。返回每次触发的时刻。

    ★ 是「连续空闲」满 delay_ms，不是「工具开始后 delay_ms」：用户说话、agent 说话都会把等待清零。
    ★ 工具结束了就不再触发（结果已经到了，该说答案了）。
    """
    spans = sorted(busy, key=lambda s: s.start)
    fires: list[Ms] = []
    from_ = tool_start
    while True:
        idle_start = from_
        moved = True
        while moved:
            moved = False
            for s in spans:
                if s.start < idle_start + p.delay_ms and s.end > idle_start:
                    idle_start = s.end
                    moved = True
        f = idle_start + p.delay_ms
        if f >= tool_end:
            break
        fires.append(f)
        if p.interval_ms is None:
            break
        if p.max_steps is not None and len(fires) >= p.max_steps:
            break
        spans.append(Span(start=f, end=f + filler_ms))
        from_ = f + p.interval_ms
    return fires


# ─────────────────────────────────────────────────────────────
# H. 任务板
# ─────────────────────────────────────────────────────────────

TaskState = Literal["working", "completed", "failed", "cancel_confirmed"]


@dataclass
class _Task:
    epoch: int
    state: TaskState


class TaskBoard:
    """后台任务的已验证状态。用户每改一次需求 epoch + 1，旧 epoch 的结果回来一律作废。
    口头更新只能从 utterable() 取——不能从「已经发起了请求」说成「已经办好了」。
    话语打断不碰这里：「闭嘴」不等于「取消订单」。
    """

    def __init__(self) -> None:
        self._tasks: dict[str, _Task] = {}

    def start(self, id_: str) -> int:
        self._tasks[id_] = _Task(epoch=1, state="working")
        return 1

    def amend(self, id_: str) -> int:
        t = self._get(id_)
        t.epoch += 1
        t.state = "working"
        return t.epoch

    def result(self, id_: str, epoch: int, ok: bool) -> Literal["accepted", "stale"]:
        t = self._get(id_)
        if epoch != t.epoch:
            return "stale"
        t.state = "completed" if ok else "failed"
        return "accepted"

    def cancel_confirmed(self, id_: str, epoch: int) -> Literal["accepted", "stale"]:
        """后端确认取消成功之后才调这个；只说「我在取消」时状态仍是 working。"""
        t = self._get(id_)
        if epoch != t.epoch:
            return "stale"
        t.state = "cancel_confirmed"
        return "accepted"

    def utterable(self, id_: str) -> TaskState:
        return self._get(id_).state

    def _get(self, id_: str) -> _Task:
        t = self._tasks.get(id_)
        if t is None:
            raise LookupError(f"没有这个任务：{id_}")
        return t


# ─────────────────────────────────────────────────────────────
# I. 延迟账
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class TurnTimeline:
    # 用户实际说完的最后一个音（只有离线标注才知道）。
    user_end_true: Ms
    # VAD 判定的最后一个有声帧。
    vad_last_speech: Ms
    # 话轮提交。
    commit_at: Ms
    llm_request_at: Ms
    # 第一句攒够、交给 TTS。
    first_seg_at: Ms
    # TTS 产出第一块音频（服务端）。
    tts_first_chunk_at: Ms
    # 服务端把第一帧推进传输层。
    server_first_frame_at: Ms
    # 扬声器放出第一个非静音样本。
    first_audible_at: Ms
    # 第一个有用的音（不是「我查一下」）。
    first_useful_at: Ms


@dataclass(frozen=True)
class Ledger:
    # 论文口径：话轮提交 → TTS 首块。不含话轮等待、STT、网络、播放。
    paper_ttfa: Ms
    # LiveKit e2e_latency：VAD 最后语音帧 → 服务端第一帧。含话轮等待，不含下行与播放。
    livekit_e2e: Ms
    # 用户感受到的死寂：实际说完 → 第一个可听见的音。
    dead_air: Ms
    # 实际说完 → 第一个有用的音。OpenAI 要求和填充语分开测。
    useful_latency: Ms
    # VAD 最后语音帧 → 话轮提交。唯一一段纯在等的时间。
    endpoint_wait: Ms


def ledger(t: TurnTimeline) -> Ledger:
    return Ledger(
        paper_ttfa=t.tts_first_chunk_at - t.commit_at,
        livekit_e2e=t.server_first_frame_at - t.vad_last_speech,
        dead_air=t.first_audible_at - t.user_end_true,
        useful_latency=t.first_useful_at - t.user_end_true,
        endpoint_wait=t.commit_at - t.vad_last_speech,
    )


def percentile(xs: list[Ms], q: int) -> Ms:
    """nearest-rank 百分位：排序后取第 ceil(q·n/100) 个。q 是整数百分数。"""
    if len(xs) == 0:
        raise ValueError("空样本没有百分位")
    s = sorted(xs)
    rank = (q * len(s) + 99) // 100
    return s[min(len(s), max(1, rank)) - 1]
