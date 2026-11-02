"""L16y 的脚手架。跑法：uv run python -m l16y.voice

观察实验：静音阈值扫不出一个好值、语义模型只延长不缩短、同一话轮的四种首音延迟、
生成 ≠ 发送 ≠ 播放、打断判定的混淆表、中英文分句、填充语的时机、过期的工具结果。
全程零模型、零音频：时间是整数毫秒，输入全是合成的。写完六个 TODO 跑 uv run python -m l16y.verify。
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, replace

from shared.voice import (
    ABBR,
    BARGE_IN_DEFAULTS,
    CLOSERS,
    ENDPOINT_ZH,
    FIRST_MIN_UNITS,
    FRAME_MS,
    HARD_ASCII,
    HARD_CJK,
    LATER_MIN_UNITS,
    SOFT,
    BargeInVerdict,
    EndpointParams,
    FillerParams,
    Ms,
    PlaybackLedger,
    Seg,
    Span,
    SpecKey,
    TaskBoard,
    Tok,
    Truncation,
    TtsChunk,
    TurnTimeline,
    VadEvent,
    VadFrame,
    VadMachine,
    VadParams,
    bad_splits,
    commit_turn,
    heard_text,
    is_cjk,
    judge_barge_in,
    ledger,
    percentile,
    schedule_fillers,
    speech_units,
    split_naive,
    split_paper,
    split_stream,
    synth_tokens,
)

DIM, BOLD, OFF = "\x1b[2m", "\x1b[1m", "\x1b[0m"
_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def dim(s: str) -> str:
    return f"{DIM}{s}{OFF}"


def bold(s: str) -> str:
    return f"{BOLD}{s}{OFF}"


def _visible(s: str) -> str:
    return _ANSI.sub("", s)


def _w(s: str) -> int:
    return sum(
        2 if "\u2e80" <= c <= "\u9fff" or "\uff00" <= c <= "\uffef" else 1 for c in _visible(s)
    )


def pad(s: str, n: int) -> str:
    return s + " " * max(0, n - _w(s))


def lpad(s: str, n: int) -> str:
    return " " * max(0, n - _w(s)) + s


def _num(x: float) -> str:
    """JS 的 String(x)：整数值不带 .0。本文件的小数都在 1e-4 以上，repr 与 JS 的写法一致。"""
    return str(int(x)) if x == int(x) else repr(x)


# ─────────────────────────────────────────────────────────────
# 夹具（verify 也用）
# ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Pause:
    ms: Ms
    eou: float


@dataclass(frozen=True)
class DemoTurn:
    id: str
    text: str
    # 轮内停顿：时长与停顿那一刻话轮模型给出的「说完了」概率。
    pauses: list[Pause]
    # 真正说完时的「说完了」概率。
    end_eou: float


def demo_turns() -> list[DemoTurn]:
    """12 个合成的中文用户话轮。停顿时长和概率都是编的，形状参照「轮内停顿比换人间隙更长」。"""
    return [
        DemoTurn("t01", "帮我查一下订单", [], 0.92),
        DemoTurn("t02", "我想改一下……收货地址", [Pause(420, 0.004)], 0.88),
        DemoTurn(
            "t03", "那个，上周买的……耳机……能退吗", [Pause(310, 0.003), Pause(650, 0.002)], 0.75
        ),
        DemoTurn("t04", "好的谢谢", [], 0.97),
        DemoTurn("t05", "我要订……周五……下午两点的", [Pause(280, 0.03), Pause(760, 0.001)], 0.81),
        DemoTurn("t06", "嗯……让我想想……还是算了吧", [Pause(1100, 0.003)], 0.64),
        DemoTurn("t07", "那如果我……", [], 0.004),
        DemoTurn("t08", "是的，就是那个蓝色的", [Pause(350, 0.2)], 0.9),
        DemoTurn("t09", "退款……多久能到账", [Pause(520, 0.05)], 0.86),
        DemoTurn("t10", "对", [], 0.6),
        DemoTurn("t11", "帮我……把地址……改成公司", [Pause(240, 0.01), Pause(480, 0.003)], 0.79),
        DemoTurn("t12", "我再看看……那个……", [Pause(900, 0.001)], 0.002),
    ]


SPEECH_MS = 800
STT_LAG_MS = 200

CommitFn = Callable[[Ms, float, Ms | None, Ms | None, EndpointParams], Ms | None]


@dataclass(frozen=True)
class TurnResult:
    cut_at: int | None
    dead_air: Ms | None


def simulate_turn(turn: DemoTurn, p: EndpointParams, commit: CommitFn = commit_turn) -> TurnResult:
    """用一个 commit_turn 跑一个话轮：每段话 SPEECH_MS，段间是停顿，final 转写在每段话结束后 STT_LAG_MS 到。
    任何一次停顿被提交 = 误切；没被切的话轮，死寂 = 真正说完到提交的时间。
    """
    t = 0
    for i, pause in enumerate(turn.pauses):
        end = t + SPEECH_MS
        if commit(end, pause.eou, end + STT_LAG_MS, end + pause.ms, p) is not None:
            return TurnResult(cut_at=i, dead_air=None)
        t = end + pause.ms
    end = t + SPEECH_MS
    at = commit(end, turn.end_eou, end + STT_LAG_MS, None, p)
    return TurnResult(cut_at=None, dead_air=None if at is None else at - end)


def silence_only(ms: Ms) -> EndpointParams:
    return EndpointParams(min_delay_ms=ms, max_delay_ms=ms, unlikely_threshold=0)


SPLIT_SAMPLES: list[tuple[str, str]] = [
    ("zh-basic", "好的，我帮您查一下。您的订单已经发货了，预计明天下午送到。还有其他问题吗？"),
    ("zh-decimal", "这款套餐每月39.9元，比原来便宜3.5元。详情见第2.1节。"),
    (
        "zh-longcomma",
        "根据您提供的信息，我查到您在上周三下单的那台笔记本电脑目前正在从上海仓库发出，物流单号已经同步到您的手机上了。",
    ),
    ("zh-mixed", "请访问 example.com 查看，或者联系 Dr. Wang。谢谢！"),
    ("zh-quote", "他说：“明天见。”然后就走了。"),
    (
        "en-basic",
        "Sure, let me check that. Your order shipped yesterday. It should arrive by 3 p.m. tomorrow.",
    ),
    (
        "en-tricky",
        "The plan costs $39.99 per month. Dr. Smith recommended version 1.2.3 for you. Visit example.com for details.",
    ),
    ("en-short", "Yes."),
]


def stream_end(toks: list[Tok], dt: Ms = 30) -> Ms:
    """流结束时刻：最后一个 token 之后再过一个 token 间隔。"""
    return toks[-1].t + dt


def demo_timeline() -> TurnTimeline:
    return TurnTimeline(
        user_end_true=0,
        vad_last_speech=40,
        commit_at=540,
        llm_request_at=560,
        first_seg_at=900,
        tts_first_chunk_at=1080,
        server_first_frame_at=1100,
        first_audible_at=1180,
        first_useful_at=2900,
    )


@dataclass(frozen=True)
class TurnCost:
    endpoint: Ms
    llm: Ms
    tts: Ms


def demo_nine_turns() -> list[TurnCost]:
    """9 个话轮的分段耗时：话轮等待、LLM 首句、TTS 首块。"""
    endpoint = [500, 500, 500, 500, 500, 3000, 3000, 3000, 500]
    llm = [300, 900, 320, 880, 310, 290, 870, 330, 860]
    tts = [200, 220, 600, 210, 640, 190, 230, 620, 205]
    return [TurnCost(endpoint=e, llm=llm[i], tts=tts[i]) for i, e in enumerate(endpoint)]


@dataclass(frozen=True)
class ReplyChunk:
    chunk: TtsChunk
    ready_at: Ms


def demo_reply() -> list[ReplyChunk]:
    """实验四：一条回复切成 5 块、每块 1000ms；TTS 以 3 倍实时生成，生成完立刻发给客户端。"""
    texts = [
        "您的订单已经发货了，",
        "预计明天下午送到，",
        "运费已经原路退回，",
        "优惠券也补发到您的账户，",
        "还有其他问题吗？",
    ]
    return [
        ReplyChunk(
            chunk=TtsChunk(epoch=0, item_id="a1", text=text, ms=1000),
            ready_at=((i + 1) * 1000) // 3,
        )
        for i, text in enumerate(texts)
    ]


@dataclass(frozen=True)
class BargeCase:
    label: str
    speech: Span
    transcript_at: Ms | None
    # 理想结局。
    want: BargeInVerdict


def demo_barge_cases() -> list[BargeCase]:
    return [
        BargeCase(
            label="回声尖峰", speech=Span(start=0, end=120), transcript_at=None, want="ignore"
        ),
        BargeCase(label="「嗯」", speech=Span(start=0, end=300), transcript_at=500, want="ignore"),
        BargeCase(label="咳嗽", speech=Span(start=0, end=80), transcript_at=None, want="ignore"),
        BargeCase(label="关门声", speech=Span(start=0, end=700), transcript_at=None, want="resume"),
        BargeCase(
            label="真打断", speech=Span(start=0, end=900), transcript_at=500, want="interrupt"
        ),
    ]


# ─────────────────────────────────────────────────────────────
# 观察实验
# ─────────────────────────────────────────────────────────────


def _avg_int(xs: list[int]) -> int:
    s = 0
    for x in xs:
        s += x
    return s // len(xs) if xs else 0


def exp1() -> None:
    print(bold("\n实验一：纯静音阈值，扫不出一个好值（12 个合成中文话轮）"))
    print(dim("  阈值     误切   平均死寂"))
    for ms in [200, 300, 500, 700, 1000]:
        rs = [simulate_turn(t, silence_only(ms)) for t in demo_turns()]
        cuts = len([r for r in rs if r.cut_at is not None])
        dead = [r.dead_air for r in rs if r.dead_air is not None]
        print(f"  {lpad(str(ms), 4)}ms  {lpad(str(cuts), 3)}/12  {lpad(str(_avg_int(dead)), 6)}ms")
    print(
        dim(
            "  同一个人自己说话时的停顿，比换人时的间隙还长：阈值短到能及时接话，就一定切人；长到不切人，就一定慢。"
        )
    )


def exp2() -> None:
    print(bold("\n实验二：语义话轮模型只延长等待，不缩短（静音 500ms vs LiveKit 规则，中文阈值）"))
    print(dim(f"  {pad('话轮', 6)}{pad('停顿（ms / 概率）', 30)}{pad('静音 500', 12)}LiveKit"))

    def show(r: TurnResult) -> str:
        return f"误切@{r.cut_at + 1}" if r.cut_at is not None else f"死寂 {r.dead_air}"

    a: list[TurnResult] = []
    b: list[TurnResult] = []
    for t in demo_turns():
        ra = simulate_turn(t, silence_only(500))
        rb = simulate_turn(t, ENDPOINT_ZH)
        a.append(ra)
        b.append(rb)
        pauses = " ".join(f"{p.ms}/{_num(p.eou)}" for p in t.pauses) or "—"
        print(f"  {pad(t.id, 6)}{pad(pauses, 30)}{pad(show(ra), 12)}{show(rb)}")

    def summary(rs: list[TurnResult]) -> str:
        dead = [r.dead_air for r in rs if r.dead_air is not None]
        cuts = len([r for r in rs if r.cut_at is not None])
        return f"误切 {cuts}，死寂 最小 {min(dead)} / 平均 {_avg_int(dead)} / 最大 {max(dead)}"

    print(f"  静音 500：{summary(a)}")
    print(f"  LiveKit ：{summary(b)}")
    print(
        dim(
            "  误切少了，但死寂的下限仍是 500ms；概率低的话轮（拖尾的「那如果我……」）要等满 3000ms。"
        )
    )
    print(dim("  t09 的停顿 520ms、概率 0.05 高于中文阈值，模型照样切——它不是万能的。"))


def exp3() -> None:
    print(bold("\n实验三：同一个话轮，四种「首音延迟」"))
    tl = demo_timeline()
    lg = ledger(tl)
    rows: list[tuple[str, Ms, str]] = [
        ("论文 TTFA", lg.paper_ttfa, "话轮提交 → TTS 首块"),
        ("LiveKit e2e", lg.livekit_e2e, "VAD 最后语音帧 → 服务端第一帧"),
        ("死寂", lg.dead_air, "实际说完 → 第一个可听见的音"),
        ("有用延迟", lg.useful_latency, "实际说完 → 第一个有用的音"),
    ]
    for name, ms, def_ in rows:
        print(f"  {pad(name, 14)}{lpad(str(ms), 5)}ms  {dim(def_)}")
    print(dim(f"  其中话轮等待 {lg.endpoint_wait}ms：唯一一段什么都不做、纯在等的时间。"))

    turns = demo_nine_turns()

    def seg(k: str, q: int) -> Ms:
        return percentile([getattr(t, k) for t in turns], q)

    totals = [t.endpoint + t.llm + t.tts for t in turns]
    for q in [50, 95]:
        sum_of_seg = seg("endpoint", q) + seg("llm", q) + seg("tts", q)
        print(
            f"  9 个话轮 p{q}：各段 p{q} 相加 {lpad(str(sum_of_seg), 4)}ms，"
            f"总耗时的 p{q} {lpad(str(percentile(totals, q)), 4)}ms"
        )
    print(
        dim(
            "  分段百分位不能相加：p50 相加偏低，p95 相加偏高。要么测端到端的分布，要么明说是保守预算。"
        )
    )


def exp4() -> None:
    print(bold("\n实验四：生成 ≠ 发送 ≠ 播放（5 块各 1000ms，TTS 3 倍实时，播放 1200ms 时被打断）"))
    reply = demo_reply()
    ledger_p = PlaybackLedger()
    for r in reply:
        ledger_p.enqueue(r.chunk, r.ready_at)
    first_start = reply[0].ready_at
    t = first_start + 1200
    sent = [r for r in reply if r.ready_at <= t]
    trunc = ledger_p.barge_in(t)
    assert trunc is not None
    rows: list[tuple[str, str]] = [
        ("全留（LLM 写完的整段）", "".join(r.chunk.text for r in reply)),
        ("留已发送（Gemini 语义）", "".join(r.chunk.text for r in sent)),
        ("截到已播放（OpenAI truncate）", trunc.heard_text),
    ]
    for label, text in rows:
        print(f"  {pad(label, 30)}{text}")
    print(
        dim(
            f"  打断时已发送 {len(sent) * 1000}ms 音频，实际播放 {trunc.audio_end_ms}ms；audio_end_ms 要填后者。"
        )
    )
    print(dim("  前两种历史里都有用户没听到的话：模型会说「我刚才说过了，运费已经退回」。"))


def exp5() -> None:
    print(bold("\n实验五：打断判定（agent 正在说话；2 秒内无转写则恢复）"))
    durations = [0, 200, 500]
    print(
        dim(
            f"  {pad('声音', 10)}{pad('时长', 8)}{pad('理想', 11)}"
            + "".join(pad(f"min={d}", 11) for d in durations)
        )
    )
    wrong = [0 for _ in durations]
    for c in demo_barge_cases():
        cells: list[str] = []
        for j, d in enumerate(durations):
            v = judge_barge_in(
                c.speech, True, c.transcript_at, replace(BARGE_IN_DEFAULTS, min_duration_ms=d)
            )
            if v != c.want:
                wrong[j] += 1
            cells.append(pad(v, 11))
        dur = f"{c.speech.end - c.speech.start}ms"
        print(f"  {pad(c.label, 10)}{pad(dur, 8)}{pad(c.want, 11)}{''.join(cells)}")
    print(f"  {pad('判错', 29)}{''.join(pad(str(n), 11) for n in wrong)}")
    print(dim("  min=0 时每个声音都让 agent 停一下；「嗯」有转写，还会被当成真打断。"))


def exp6() -> None:
    print(bold("\n实验六：中英文流式分句（第 i 个 token 在 300 + 30·i ms 到达）"))
    splitters: list[tuple[str, Callable[[list[Tok], Ms], list[Seg]]]] = [
        ("naive", split_naive),
        ("paper", split_paper),
        ("proposed", split_stream),
    ]
    print(
        dim(
            f"  {pad('分句器', 10)}{pad('样本', 14)}{lpad('首段ms', 7)}{lpad('首段单位', 10)}{lpad('段数', 6)}{lpad('误切', 6)}"
        )
    )
    for name, fn in splitters:
        for sample, text in SPLIT_SAMPLES:
            toks = synth_tokens(text)
            segs = fn(toks, stream_end(toks))
            print(
                f"  {pad(name, 10)}{pad(sample, 14)}{lpad(str(segs[0].t), 7)}{lpad(str(speech_units(segs[0].text)), 10)}"
                + f"{lpad(str(len(segs)), 6)}{lpad(str(bad_splits(text, segs)), 6)}"
            )
    for sample in ["zh-basic", "zh-longcomma"]:
        text = next(s for s in SPLIT_SAMPLES if s[0] == sample)[1]
        toks = synth_tokens(text)
        for name, fn in splitters[1:]:
            segs = fn(toks, stream_end(toks))
            print(
                dim(f"  {pad(f'{name}/{sample}', 22)}")
                + " ‖ ".join(f"{s.t}|{s.text}" for s in segs)
            )
    print(dim("  论文的规则要求「标点后跟空白」：中文句号后面没有空格，于是首音 = 整段生成完。"))


def exp7() -> None:
    print(bold("\n实验七：填充语什么时候说（填充语本身 1200ms）"))
    cases: list[tuple[str, Span, list[Span], FillerParams]] = [
        (
            "工具 1800ms，用户在 400–900 说话",
            Span(0, 1800),
            [Span(400, 900)],
            FillerParams(500, None, None),
        ),
        ("工具 300ms，delay=0（LiveKit 默认）", Span(0, 300), [], FillerParams(0, None, None)),
        ("工具 300ms，delay=500", Span(0, 300), [], FillerParams(500, None, None)),
    ]
    filler_ms = 1200

    def naive(tool: Span, p: FillerParams) -> list[Ms]:
        return [tool.start + p.delay_ms] if tool.start + p.delay_ms < tool.end else []

    print(dim(f"  {pad('场景', 38)}{pad('调度', 12)}{pad('触发', 8)}{pad('撞上用户', 10)}答案推迟"))
    for label, tool, busy, p in cases:
        rows: list[tuple[str, list[Ms]]] = [
            ("开始后计时", naive(tool, p)),
            ("连续空闲", schedule_fillers(tool.start, tool.end, busy, filler_ms, p)),
        ]
        for i, (name, fires) in enumerate(rows):
            f = fires[0] if fires else None
            clash = f is not None and any(b.start < f + filler_ms and f < b.end for b in busy)
            push = 0 if f is None else max(0, f + filler_ms - tool.end)
            print(
                f"  {pad(label if i == 0 else '', 38)}{pad(name, 12)}{pad('—' if f is None else str(f), 8)}"
                f"{pad('是' if clash else '否', 10)}{push}ms"
            )
    print(
        dim("  连续空闲不会和用户撞车，但填充语一旦开口就要说完：工具先回来，答案也得排在它后面。")
    )
    print(dim("  默认 delay=0 时，一个 300ms 的工具被换成了一句 1.2 秒的「我查一下」。"))


def exp8() -> None:
    print(bold("\n实验八：用户把周五改成周四，周五的结果后到"))
    board = TaskBoard()
    log: list[tuple[str, str]] = []
    fri = board.start("book")
    log.append(("订周五（epoch 1）", board.utterable("book")))
    thu = board.amend("book")
    log.append(("改成周四（epoch 2）", board.utterable("book")))
    log.append((f"周五的结果回来：{board.result('book', fri, True)}", board.utterable("book")))
    log.append((f"周四的结果回来：{board.result('book', thu, True)}", board.utterable("book")))
    print(dim(f"  {pad('事件', 30)}可以说出口的状态"))
    for e, s in log:
        print(f"  {pad(e, 30)}{s}")
    print(dim("  口头确认只能来自已验证的状态；「闭嘴」打断的是话语，后台的订票照常进行。"))


# ─────────────────────────────────────────────────────────────
# TODO
# ─────────────────────────────────────────────────────────────


def my_vad_step(m: VadMachine, f: VadFrame, p: VadParams) -> tuple[VadMachine, VadEvent | None]:
    """TODO 1 ★ VAD 四态滞回的一步。帧的 t 是这一帧结束的时刻，每帧 FRAME_MS（20ms）；p ≥ threshold 算有声。
      quiet → starting → speaking：连续有声满 start_ms 才进 speaking，那一刻发 speech_start
      speaking → stopping → quiet：连续无声满 stop_ms 才回 quiet，那一刻发 speech_end
      starting 中途掉到阈值下 → 回 quiet、计时清零；stopping 中途又有声 → 回 speaking、不发事件
    事件里的 last_speech_at 是最后一个有声帧的 t。
    陷阱：单帧过阈值就切状态；speech_end 的「说完时刻」用判定时刻（晚了整整 stop_ms）。
    """
    raise NotImplementedError("TODO 1 未实现")


def my_commit_turn(
    last_speech_at: Ms,
    eou_prob: float,
    stt_final_at: Ms | None,
    next_speech_start: Ms | None,
    p: EndpointParams,
) -> Ms | None:
    """TODO 2 ★★ 话轮在什么时刻提交（不提交返回 None）。
      等待 = max_delay_ms if eou_prob < unlikely_threshold else min_delay_ms
      commit_at = max(last_speech_at + 等待, stt_final_at)；stt_final_at 为 None → 不提交
      next_speech_start 早于 commit_at → 不提交（用户只是停顿了一下）
    陷阱：用概率把等待缩短到 min 以下；不等 final 转写就提交；忘了「复说取消」。
    """
    raise NotImplementedError("TODO 2 未实现")


def my_normalize_transcript(s: str) -> str:
    r"""TODO 3 ★ 投机生成能不能直接用。
      my_normalize_transcript：ASCII 字母转小写；去掉中英文标点；连续空白压成一个空格；去首尾空格
      my_speculation_valid：归一化后的转写、ctx_version、tools_version、tool_choice 四样都相同
    陷阱：用 \w 判标点——TS 的 \w 不认汉字，会把整句中文当标点删光（Python 的 \w 认，两边就对不上了）；
    用 str.lower() / str.strip()——它们会动非 ASCII 字符；只比转写、不比版本。
    """
    raise NotImplementedError("TODO 3 未实现")


def my_speculation_valid(spec: SpecKey, committed: SpecKey) -> bool:
    raise NotImplementedError("TODO 3 未实现")


class MyPlaybackLedger(PlaybackLedger):
    """TODO 4 ★★ 打断时截断播放账本。enqueue / played_ms_at / speaking_at 已经写好，
    你能用的字段：self._scheduled（元素有 .chunk 和 .start，按入队顺序）、self._free_at、self.epoch。
      t 时没有在播或待播的音频 → None
      否则找到 t 时正在播（或排在最前、还没开始）的那个 item：audio_end_ms = 它到 t 为止实际播了多少，
      heard_text 用 shared 的 heard_text 算，drop_item = 一帧没播；然后 epoch + 1、清空队列、_free_at = t
    陷阱：截到已生成 / 已发送（入队总时长）；忘了 epoch，打断后迟到的 TTS 块又被播出来。
    """

    def barge_in(self, t: Ms) -> Truncation | None:
        raise NotImplementedError("TODO 4 未实现")


def my_split_stream(tokens: list[Tok], end_at: Ms) -> list[Seg]:
    """TODO 5 ★★ 流式分句。规则见 shared/voice.py 的 split_stream 注释，要点：
      中文句末（。！？；）和 ! ? ; 之后多等 1 个字符，后引号跟着这一句走
      「.」前瞻 1 个字符：下一个是空格或汉字、前一个词不是缩写（ABBR 或单个字母），才切
      第一段可以在 ，,、：: 处切（够 4 个语音单位）；后续段至少 8 个单位、不在逗号处切
      切点处的空格丢掉，其余字符一个不改；流结束（end_at）时剩下的冲出去
    陷阱：见句号就切（39.9、Dr.）；只认 .!? 加空白（中文永远切不出来）；按字符数而不是语音单位定阈值。
    """
    raise NotImplementedError("TODO 5 未实现")


def my_schedule_fillers(
    tool_start: Ms, tool_end: Ms, busy: list[Span], filler_ms: Ms, p: FillerParams
) -> list[Ms]:
    """TODO 6 ★ 填充语调度。工具在 [tool_start, tool_end) 运行，busy 是有人说话的区间（左闭右开）。
      连续空闲满 delay_ms 才触发；任何一段 busy 都把等待清零；触发时刻 ≥ tool_end 就不再触发
      触发后填充语本身播 filler_ms，也算忙；interval_ms 为 None 最多一次，否则过 interval_ms（墙钟）
      再重新等空闲；max_steps 封顶
    陷阱：tool_start + delay_ms 直接触发；填充语播放期间也当成空闲。
    """
    raise NotImplementedError("TODO 6 未实现")


# ─────────────────────────────────────────────────────────────


def main() -> None:
    exp1()
    exp2()
    exp3()
    exp4()
    exp5()
    exp6()
    exp7()
    exp8()
    print(bold("\n最该记住的"))
    print("  · 比延迟数字之前先对齐起止点：论文的 TTFA 不含话轮等待，用户的死寂含。")
    print("  · 语义话轮模型买的是少截断，不是更快；更快要靠在等待期间就开始生成。")
    print("  · 用户听到的才算说过：历史截到已播放，不是已生成、也不是已发送。")
    print("  · 「闭嘴」不等于「取消订单」：打断停的是话语，后台任务只认已验证的状态。")
    print("  · 中文句号后面没有空格：英文上验证过的分句规则，搬过来首音就等于整段生成完。")


if __name__ == "__main__":
    main()
