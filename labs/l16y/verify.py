"""验证 l16y/voice.py。
  VOICE_IMPL=shared uv run python -m l16y.verify
  uv run python -m l16y.verify

零模型、零音频。时间是整数毫秒，VAD 概率、token、TTS 块全是手造的。
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Callable
from dataclasses import asdict, dataclass, is_dataclass, replace
from typing import Any

from l16y.voice import (
    SPLIT_SAMPLES,
    demo_nine_turns,
    demo_timeline,
    demo_turns,
    silence_only,
    simulate_turn,
    stream_end,
)
from shared import voice as shared
from shared.voice import (
    EndpointParams,
    FillerParams,
    Ms,
    PlaybackLedger,
    Seg,
    Span,
    SpecKey,
    Truncation,
    TtsChunk,
    VadEvent,
    VadFrame,
    VadMachine,
    VadParams,
)

TARGET = "shared" if os.environ.get("VOICE_IMPL") == "shared" else "mine"


@dataclass(frozen=True)
class Api:
    vad_step: Callable[[VadMachine, VadFrame, VadParams], tuple[VadMachine, VadEvent | None]]
    commit_turn: Callable[[Ms, float, Ms | None, Ms | None, EndpointParams], Ms | None]
    normalize: Callable[[str], str]
    speculation_valid: Callable[[SpecKey, SpecKey], bool]
    Ledger: Callable[[], PlaybackLedger]
    split_stream: Callable[[list[shared.Tok], Ms], list[Seg]]
    schedule_fillers: Callable[[Ms, Ms, list[Span], Ms, FillerParams], list[Ms]]


def _load_mine() -> Api:
    from l16y import voice as m

    return Api(
        vad_step=m.my_vad_step,
        commit_turn=m.my_commit_turn,
        normalize=m.my_normalize_transcript,
        speculation_valid=m.my_speculation_valid,
        Ledger=m.MyPlaybackLedger,
        split_stream=m.my_split_stream,
        schedule_fillers=m.my_schedule_fillers,
    )


M = (
    Api(
        vad_step=shared.vad_step,
        commit_turn=shared.commit_turn,
        normalize=shared.normalize_transcript,
        speculation_valid=shared.speculation_valid,
        Ledger=shared.PlaybackLedger,
        split_stream=shared.split_stream,
        schedule_fillers=shared.schedule_fillers,
    )
    if TARGET == "shared"
    else _load_mine()
)

print(
    "\n（测的是 shared/ 里的参考实现）" if TARGET == "shared" else "\n（测的是 l16y/ 里你的实现）"
)

DIM, BOLD, RED, GREEN, OFF = "\x1b[2m", "\x1b[1m", "\x1b[31m", "\x1b[32m", "\x1b[0m"


def bold(s: str) -> str:
    return f"{BOLD}{s}{OFF}"


def red(s: str) -> str:
    return f"{RED}{s}{OFF}"


def green(s: str) -> str:
    return f"{GREEN}{s}{OFF}"


def dim(s: str) -> str:
    return f"{DIM}{s}{OFF}"


class Fail(Exception):
    pass


def need(cond: bool, why: str) -> None:
    if not cond:
        raise Fail(why)


passed = 0
failed = 0


def t(id_: str, name: str) -> Callable[[Callable[[], None]], Callable[[], None]]:
    """装饰器：定义即运行。和 TS 的 t(id, name, () => {...}) 一样按出现顺序执行。"""

    def run(fn: Callable[[], None]) -> Callable[[], None]:
        global passed, failed
        try:
            fn()
            passed += 1
        except Exception as e:
            failed += 1
            why = str(e) if isinstance(e, Fail) else f"抛出了异常：{e}"
            print(red(f"  ✗ {id_} {name}") + dim(f"\n      {why}"))
        return fn

    return run


def section(s: str) -> None:
    print(bold(f"\n{s}"))


def _camel(k: str) -> str:
    head, *rest = k.split("_")
    return head + "".join(w[:1].upper() + w[1:] for w in rest)


def _default(o: Any) -> Any:
    if is_dataclass(o) and not isinstance(o, type):
        return {_camel(k): v for k, v in asdict(o).items()}
    return str(o)


def js(x: Any) -> str:
    """JSON.stringify 的同义写法。dataclass 按字段展开，字段名换回 TS 的驼峰，失败信息和 TS 一字不差。"""
    return json.dumps(x, ensure_ascii=False, separators=(",", ":"), default=_default)


def heard(tr: Truncation | None) -> str:
    """J(tr?.heardText)：tr 是 null 时 TS 打印的是 undefined。"""
    return "undefined" if tr is None else js(tr.heard_text)


# ─────────────────────────────────────────────────────────────
section("A · VAD 四态滞回")


def frames(ps: list[float]) -> list[VadFrame]:
    return [VadFrame(t=(i + 1) * shared.FRAME_MS, p=p) for i, p in enumerate(ps)]


def run(ps: list[float]) -> list[VadEvent]:
    m = shared.VAD_INIT
    out: list[VadEvent] = []
    for f in frames(ps):
        nxt, ev = M.vad_step(m, f, shared.VAD_DEFAULTS)
        m = nxt
        if ev is not None:
            out.append(ev)
    return out


def rep(p: float, n: int) -> list[float]:
    return [p] * n


def kinds(evs: list[VadEvent]) -> str:
    return ",".join(e.kind for e in evs)


@t("A1", "全静音 → 没有事件")
def _a1() -> None:
    evs = run(rep(0.1, 50))
    need(len(evs) == 0, f"应无事件，实际 {js(evs)}")


@t("A2", "连续 10 帧有声 → 恰好一个 speech_start，在第 10 帧（200ms）")
def _a2() -> None:
    nine = run(rep(0.9, 9))
    need(len(nine) == 0, f"9 帧（180ms）不该开口，实际 {js(nine)}")
    evs = run(rep(0.9, 10))
    need(len(evs) == 1 and evs[0].kind == "speech_start" and evs[0].t == 200, f"实际 {js(evs)}")


@t("A3", "单帧尖峰夹在静音里 → 不是开口")
def _a3() -> None:
    evs = run([*rep(0.1, 5), 0.9, *rep(0.1, 5)])
    need(len(evs) == 0, f"单帧过阈值就切状态了：{js(evs)}")


@t("A4", "说话中间 160ms 的换气 → 不发 speech_end")
def _a4() -> None:
    evs = run([*rep(0.9, 15), *rep(0.1, 8), *rep(0.9, 15), *rep(0.1, 15)])
    need(
        kinds(evs) == "speech_start,speech_end", f"应为 speech_start,speech_end，实际 {kinds(evs)}"
    )
    need(
        evs[1].last_speech_at == 760,
        f"说完时刻应是第二段最后一帧 760，实际 {evs[1].last_speech_at}",
    )


@t("A5", "speech_end 的 lastSpeechAt 是最后一个有声帧，不是判定时刻")
def _a5() -> None:
    evs = run([*rep(0.9, 15), *rep(0.1, 15)])
    end = next((e for e in evs if e.kind == "speech_end"), None)
    need(end is not None, "没有 speech_end")
    assert end is not None
    need(
        end.t == 500 and end.last_speech_at == 300,
        f"应在 500 判定、说完于 300，实际 t={end.t} lastSpeechAt={end.last_speech_at}",
    )


@t("A6", "starting 中途掉到阈值下 → 回 quiet，计时清零")
def _a6() -> None:
    evs = run([*rep(0.9, 5), 0.1, *rep(0.9, 10)])
    need(len(evs) == 1 and evs[0].t == 320, f"应在 320 开口（从 140 重新计时），实际 {js(evs)}")


@t("A7", "p 恰好等于阈值算有声（>=）")
def _a7() -> None:
    evs = run(rep(0.7, 10))
    need(len(evs) == 1 and evs[0].t == 200, f"p=0.7 应算有声，实际 {js(evs)}")
    need(len(run(rep(0.6999, 20))) == 0, "p=0.6999 不该算有声")


# ─────────────────────────────────────────────────────────────
section("B · 端点")

ZH = shared.ENDPOINT_ZH
EN = shared.ENDPOINT_EN


def delay(eou: float, p: EndpointParams = ZH) -> int:
    at = M.commit_turn(1000, eou, 1000, None, p)
    # TS 里 null - 1000 得 -1000，不抛异常
    return (at or 0) - 1000


@t("B1", "概率高 → 等 min（500ms）")
def _b1() -> None:
    need(delay(0.5) == 500, f"实际等 {delay(0.5)}")


@t("B2", "概率低于中文阈值 → 等 max（3000ms）")
def _b2() -> None:
    need(delay(0.001) == 3000, f"实际等 {delay(0.001)}")


@t("B3", "任何概率都不让等待短于 min")
def _b3() -> None:
    for eou in [0, 0.0001, 0.0065, 0.0066, 0.01, 0.5, 0.99, 1]:
        need(delay(eou) >= 500, f"eou={eou} 等了 {delay(eou)}ms，比 min 还短")


@t("B4", "阈值按语种：eou=0.008 中文等 500、英文等 3000")
def _b4() -> None:
    need(
        delay(0.008, ZH) == 500 and delay(0.008, EN) == 3000,
        f"中文 {delay(0.008, ZH)}，英文 {delay(0.008, EN)}",
    )


@t("B5", "final 转写晚于等待结束 → 提交在 final 到达时")
def _b5() -> None:
    at = M.commit_turn(1000, 0.5, 1800, None, ZH)
    need(at == 1800, f"应为 1800，实际 {js(at)}")


@t("B6", "提交之前用户又开口 → 不提交；实验二的误切数")
def _b6() -> None:
    need(M.commit_turn(1000, 0.5, 1200, 1400, ZH) is None, "1400 复说早于 1500 的提交，应取消")
    need(M.commit_turn(1000, 0.001, 1200, 2500, ZH) is None, "低概率等到 4000，2500 复说应取消")

    def cut(p: EndpointParams) -> str:
        return ",".join(
            x.id for x in demo_turns() if simulate_turn(x, p, M.commit_turn).cut_at is not None
        )

    need(
        cut(silence_only(500)) == "t03,t05,t06,t09,t12",
        f"静音 500 应误切 t03,t05,t06,t09,t12，实际 {cut(silence_only(500))}",
    )
    need(cut(ZH) == "t09", f"LiveKit 规则应只误切 t09，实际 {cut(ZH)}")


@t("B7", "复说不早于提交时刻 → 照常提交")
def _b7() -> None:
    need(M.commit_turn(1000, 0.5, 1200, 1500, ZH) == 1500, "复说恰在 1500，应照常提交")
    need(M.commit_turn(1000, 0.5, 1200, 1600, ZH) == 1500, "复说在 1600，应在 1500 提交")


@t("B8", "还没有 final 转写 → 不提交")
def _b8() -> None:
    need(M.commit_turn(1000, 0.5, None, None, ZH) is None, "没有转写也提交了")


# ─────────────────────────────────────────────────────────────
section("C · 投机生成")


def key(transcript: str, **o: Any) -> SpecKey:
    return replace(
        SpecKey(transcript=transcript, ctx_version=3, tools_version=1, tool_choice="auto"), **o
    )


@t("C1", "只差大小写和末尾句号 → 有效")
def _c1() -> None:
    need(M.speculation_valid(key("Book a table."), key("book a table")), "应有效")


@t("C2", "中文只差全角标点 → 有效；归一化不能把汉字删掉")
def _c2() -> None:
    need(
        M.normalize("好的，查一下。") == "好的查一下",
        f"归一化结果 {js(M.normalize('好的，查一下。'))}",
    )
    need(M.speculation_valid(key("好的，查一下。"), key("好的查一下")), "应有效")
    need(not M.speculation_valid(key("好的查一下"), key("好的取消")), "内容不同的中文也判成有效了")


@t("C3", "转写相同但工具版本变了 → 无效")
def _c3() -> None:
    need(not M.speculation_valid(key("查订单"), key("查订单", tools_version=2)), "应无效")


@t("C4", "转写相同但上下文版本或 tool_choice 变了 → 无效")
def _c4() -> None:
    need(
        not M.speculation_valid(key("查订单"), key("查订单", ctx_version=4)),
        "ctxVersion 变了应无效",
    )
    need(
        not M.speculation_valid(key("查订单"), key("查订单", tool_choice="none")),
        "toolChoice 变了应无效",
    )


@t("C5", "多一个词 → 无效")
def _c5() -> None:
    need(not M.speculation_valid(key("book a table"), key("book a table now")), "应无效")


@t("C6", "归一化：空白压缩、只去 ASCII 空格、幂等")
def _c6() -> None:
    need(
        M.normalize("  Hello,  World! ") == "hello world",
        f"实际 {js(M.normalize('  Hello,  World! '))}",
    )
    tabbed = "A\tB\nC"
    need(M.normalize(tabbed) == "a b c", f"实际 {js(M.normalize(tabbed))}")
    for s in ["  Hello,  World! ", "好的，\t查一下。", "Dr. Wang 说：“OK”", "", "\u00a0x"]:
        once = M.normalize(s)
        need(M.normalize(once) == once, f"{js(s)} 归一化两次结果不同")
    need(M.normalize("\u00a0x") == "\u00a0x", "不间断空格不是 ASCII 空格，不该被去掉")


# ─────────────────────────────────────────────────────────────
section("D · 播放账本与截断")


def chunk(text: str, ms: Ms = 1000, item_id: str = "a1", epoch: int = 0) -> TtsChunk:
    return TtsChunk(epoch=epoch, item_id=item_id, text=text, ms=ms)


def three() -> PlaybackLedger:
    lg = M.Ledger()
    for s in ["您的订单已经发货了", "预计明天下午送到", "还有其他问题吗"]:
        lg.enqueue(chunk(s), 100)
    return lg


@t("D1", "3 块一次入队，从 100 起播：1300 时已播 1200ms")
def _d1() -> None:
    lg = three()
    need(lg.played_ms_at(1300) == 1200, f"实际 {lg.played_ms_at(1300)}")


@t("D2", "打断时截到已播放，不是已入队；audioEndMs 是 item 内的毫秒")
def _d2() -> None:
    tr = three().barge_in(1300)
    need(tr is not None and tr.audio_end_ms == 1200, f"应为 1200，实际 {js(tr)}")
    lg = M.Ledger()
    lg.enqueue(chunk("第一句", 1000, "a1"), 0)
    lg.enqueue(chunk("第二句", 1000, "a1"), 0)
    lg.enqueue(chunk("下一条", 1000, "a2"), 0)
    tr2 = lg.barge_in(2400)
    need(
        tr2 is not None and tr2.item_id == "a2" and tr2.audio_end_ms == 400,
        f"应为 a2 播到 400，实际 {js(tr2)}",
    )


@t("D3", "audioEndMs 不超过已入队总时长；两块之间的空档不算播放")
def _d3() -> None:
    lg = M.Ledger()
    lg.enqueue(chunk("先说这句", 1000), 0)
    lg.enqueue(chunk("后到这句", 1000), 1500)
    tr = lg.barge_in(1200)
    need(
        tr is not None and tr.audio_end_ms == 1000 and tr.heard_text == "先说这句",
        f"应播到 1000、听到「先说这句」，实际 {js(tr)}",
    )


@t("D4", "听到的文字不含第 3 块的任何字")
def _d4() -> None:
    tr = three().barge_in(1300)
    need(tr is not None and tr.heard_text == "您的订单已经发货了预", f"实际 {heard(tr)}")
    assert tr is not None
    need(not any(c in tr.heard_text for c in "还有其他问题吗"), "混进了第 3 块的字")


@t("D5", "当前块按码点比例向下取整：9 字的块播一半 → 4 字")
def _d5() -> None:
    lg = M.Ledger()
    lg.enqueue(chunk("您的订单已经发货了"), 0)
    tr = lg.barge_in(500)
    need(tr is not None and tr.heard_text == "您的订单", f"实际 {heard(tr)}")


@t("D6", "一帧没播就打断 → dropItem")
def _d6() -> None:
    lg = M.Ledger()
    lg.enqueue(chunk("还没开始播"), 1000)
    tr = lg.barge_in(500)
    need(
        tr is not None and tr.drop_item and tr.audio_end_ms == 0 and tr.heard_text == "",
        f"实际 {js(tr)}",
    )
    tr2 = three().barge_in(1300)
    need(tr2 is not None and not tr2.drop_item, "播过的不该 dropItem")


@t("D7", "打断后 epoch + 1；迟到的旧块是 stale，不会被播出来")
def _d7() -> None:
    lg = three()
    lg.barge_in(1300)
    need(lg.epoch == 1, f"epoch 应为 1，实际 {lg.epoch}")
    need(lg.enqueue(chunk("迟到的块"), 1400) == "stale", "旧 epoch 的块应判 stale")
    need(lg.played_ms_at(3000) == 0 and not lg.speaking_at(1500), "旧块被播出来了")


@t("D8", "新 epoch 的块正常入队播放")
def _d8() -> None:
    lg = three()
    lg.barge_in(1300)
    need(lg.enqueue(chunk("新回复", 1000, "a2", 1), 2000) == "queued", "新 epoch 的块应入队")
    need(
        lg.played_ms_at(2500) == 500 and lg.speaking_at(2500),
        f"2500 时应已播 500，实际 {lg.played_ms_at(2500)}",
    )


@t("D9", "连续打断两次，第二次返回 null")
def _d9() -> None:
    lg = three()
    lg.barge_in(1300)
    again = lg.barge_in(1300)
    need(again is None, f"实际 {js(again)}")


@t("D10", "一次性入队 5 块，播放仍按实时走")
def _d10() -> None:
    lg = M.Ledger()
    for i in range(5):
        lg.enqueue(chunk(f"第{i}块"), 0)
    need(lg.played_ms_at(2500) == 2500, f"2500 时应播 2500，实际 {lg.played_ms_at(2500)}")
    need(lg.speaking_at(4999) and not lg.speaking_at(5000), "5000 才播完")
    tr = lg.barge_in(2500)
    need(tr is not None and tr.audio_end_ms == 2500, f"应截到 2500，实际 {js(tr)}")


# ─────────────────────────────────────────────────────────────
section("E · 打断判定（参考实现，只读）")

judge = shared.judge_barge_in


@t("E1", "agent 没在说话 → ignore")
def _e1() -> None:
    need(judge(Span(start=0, end=900), False, 500) == "ignore", "话轮开始不是打断")


@t("E2", "300ms 的「嗯」→ ignore")
def _e2() -> None:
    need(judge(Span(start=0, end=300), True, 500) == "ignore", "应 ignore")


@t("E3", "120ms 的回声尖峰 → ignore")
def _e3() -> None:
    need(judge(Span(start=0, end=120), True, None) == "ignore", "应 ignore")


@t("E4", "900ms 且有转写 → interrupt")
def _e4() -> None:
    need(judge(Span(start=0, end=900), True, 1200) == "interrupt", "应 interrupt")


@t("E5", "900ms 但停下后 2 秒内没有转写 → resume")
def _e5() -> None:
    need(judge(Span(start=0, end=900), True, None) == "resume", "没有转写应 resume")
    need(judge(Span(start=0, end=900), True, 3000) == "resume", "3000 > 900 + 2000，应 resume")
    need(
        judge(Span(start=0, end=900), True, 2900) == "interrupt", "2900 恰在超时边界，应 interrupt"
    )


# ─────────────────────────────────────────────────────────────
section("F · 中英文流式分句")


def sample(name: str) -> str:
    return next(s for s in SPLIT_SAMPLES if s[0] == name)[1]


def split(text: str) -> list[Seg]:
    toks = shared.synth_tokens(text)
    return M.split_stream(toks, stream_end(toks))


def texts(segs: list[Seg]) -> list[str]:
    return [s.text for s in segs]


PROPOSED: dict[str, list[int]] = {
    "zh-basic": [600, 8, 3, 0],
    "zh-decimal": [540, 9, 3, 0],
    "zh-longcomma": [540, 8, 2, 0],
    "zh-mixed": [510, 7, 2, 0],
    "zh-quote": [570, 5, 2, 0],
    "en-basic": [450, 5, 2, 0],
    "en-tricky": [480, 7, 3, 0],
    "en-short": [330, 1, 1, 0],
}
LATER_COMMA = "好的，我帮您查一下。然后呢，这个订单已经发货了，明天下午就能到。"


def exact_pieces(src: str, segs: list[Seg]) -> str | None:
    cs = list(src)
    pos = 0
    for s in segs:
        while pos < len(cs) and cs[pos] == " ":
            pos += 1
        seg = list(s.text)
        if len(seg) == 0:
            return "出现了空段"
        if "".join(cs[pos : pos + len(seg)]) != s.text:
            return f"{js(s.text)} 不是原文在第 {pos} 个码点处的子串"
        pos += len(seg)
    while pos < len(cs) and cs[pos] == " ":
        pos += 1
    return None if pos == len(cs) else f"原文从第 {pos} 个码点起没有被任何段覆盖"


@t("F1", "zh-basic 首段是「好的，我帮您查一下。」；实验六 proposed 那 8 行")
def _f1() -> None:
    segs = split(sample("zh-basic"))
    need(segs[0].text == "好的，我帮您查一下。", f"首段 {js(segs[0].text)}")
    for name, text in SPLIT_SAMPLES:
        s = split(text)
        row = [s[0].t, shared.speech_units(s[0].text), len(s), shared.bad_splits(text, s)]
        need(js(row) == js(PROPOSED[name]), f"{name}：应为 {js(PROPOSED[name])}，实际 {js(row)}")


@t("F2", "没有空格的中文也切得出来")
def _f2() -> None:
    for name in ["zh-basic", "zh-decimal", "zh-longcomma", "zh-mixed", "zh-quote"]:
        n = len(split(sample(name)))
        need(n >= 2, f"{name} 只切出 {n} 段：只认「标点后跟空白」？")


@t("F3", "「39.9元」不在小数点处切")
def _f3() -> None:
    segs = split(sample("zh-decimal"))
    need(
        not any(re.search(r"[0-9]\.\Z", s.text) for s in segs)
        and any("39.9元" in s.text for s in segs),
        f"实际 {js(texts(segs))}",
    )


@t("F4", "「Dr. Wang」「Dr. Smith」不在缩写后切")
def _f4() -> None:
    for name in ["zh-mixed", "en-tricky"]:
        segs = split(sample(name))
        need(not any(s.text.endswith("Dr.") for s in segs), f"{name}：{js(texts(segs))}")
    long = split("Please hold on while I transfer you to Dr. Smith in cardiology.")
    need(len(long) == 1, f"「Dr.」前面已经够长，也不该切：{js(texts(long))}")


@t("F5", "「example.com」不切")
def _f5() -> None:
    for name in ["zh-mixed", "en-tricky"]:
        segs = split(sample(name))
        need(any("example.com" in s.text for s in segs), f"{name}：{js(texts(segs))}")


@t("F6", "后引号跟着前一句走")
def _f6() -> None:
    segs = split(sample("zh-quote"))
    need(js(texts(segs)) == js(["他说：“明天见。”", "然后就走了。"]), f"实际 {js(texts(segs))}")


@t("F7", "长逗号句：首段在第一个逗号处出，540ms")
def _f7() -> None:
    segs = split(sample("zh-longcomma"))
    need(
        segs[0].text == "根据您提供的信息，" and segs[0].t == 540,
        f"首段 {segs[0].t}|{segs[0].text}",
    )


@t("F8", "后续段不在逗号处切")
def _f8() -> None:
    segs = split(LATER_COMMA)
    need(
        js(texts(segs))
        == js(["好的，我帮您查一下。", "然后呢，这个订单已经发货了，明天下午就能到。"]),
        f"实际 {js(texts(segs))}",
    )


@t("F9", "分句不改字符：每段都是原文按序的子串，段间只隔空格")
def _f9() -> None:
    for name, text in [*SPLIT_SAMPLES, ("later-comma", LATER_COMMA)]:
        why = exact_pieces(text, split(text))
        need(why is None, f"{name}：{why}")


@t("F10", "按码点截断：「好😀好」播一半 → 「好」")
def _f10() -> None:
    lg = M.Ledger()
    lg.enqueue(chunk("好😀好"), 0)
    tr = lg.barge_in(500)
    need(
        tr is not None and tr.heard_text == "好",
        f"实际 {heard(tr)}（按 UTF-16 切会多出半个 emoji）",
    )
    lg2 = M.Ledger()
    lg2.enqueue(chunk("好😀好"), 0)
    tr2 = lg2.barge_in(700)
    need(tr2 is not None and tr2.heard_text == "好😀", f"700ms 应为「好😀」，实际 {heard(tr2)}")


# ─────────────────────────────────────────────────────────────
section("G · 填充语与任务板")


def once(delay_ms: int) -> FillerParams:
    return FillerParams(delay_ms=delay_ms, interval_ms=None, max_steps=None)


@t("G1", "工具 300ms、delay 500 → 不说填充语")
def _g1() -> None:
    f = M.schedule_fillers(0, 300, [], 1200, once(500))
    need(len(f) == 0, f"实际 {js(f)}")


@t("G2", "工具 1800ms、用户在 400–900 说话 → 1400 才说，不是 500")
def _g2() -> None:
    f = M.schedule_fillers(0, 1800, [Span(start=400, end=900)], 1200, once(500))
    need(js(f) == "[1400]", f"实际 {js(f)}")


@t("G3", "intervalMs = null → 最多一次")
def _g3() -> None:
    f = M.schedule_fillers(0, 10000, [], 1200, once(500))
    need(js(f) == "[500]", f"实际 {js(f)}")


@t("G4", "maxSteps = 2 → 恰好两次；第二次要等填充语本身播完")
def _g4() -> None:
    f = M.schedule_fillers(
        0, 10000, [], 1200, FillerParams(delay_ms=500, interval_ms=1000, max_steps=2)
    )
    need(js(f) == "[500,2200]", f"应为 [500,2200]，实际 {js(f)}")


@t("G5", "改了需求，旧结果作废，状态仍是 working")
def _g5() -> None:
    b = shared.TaskBoard()
    fri = b.start("book")
    b.amend("book")
    need(
        b.result("book", fri, True) == "stale" and b.utterable("book") == "working",
        f"实际 {b.utterable('book')}",
    )


@t("G6", "只有被接受的成功结果才能说成「办好了」")
def _g6() -> None:
    b = shared.TaskBoard()
    e = b.start("book")
    need(b.utterable("book") == "working", "刚发起就不是 working 了")
    need(
        b.result("book", e, False) == "accepted" and b.utterable("book") == "failed",
        "失败结果应记为 failed",
    )
    b2 = shared.TaskBoard()
    e2 = b2.start("book")
    b2.result("book", e2, True)
    need(b2.utterable("book") == "completed", "成功结果应记为 completed")
    e3 = b2.amend("book")
    need(
        b2.cancel_confirmed("book", e3 - 1) == "stale" and b2.utterable("book") == "working",
        "旧 epoch 的取消确认应作废",
    )


# ─────────────────────────────────────────────────────────────
section("H · 延迟账（参考实现，只读）")


@t("H1", "同一时间线：论文 TTFA < LiveKit e2e < 死寂")
def _h1() -> None:
    lg = shared.ledger(demo_timeline())
    need(lg.paper_ttfa == 540 and lg.livekit_e2e == 1060 and lg.dead_air == 1180, f"实际 {js(lg)}")


@t("H2", "有用延迟 ≥ 死寂；有填充语时严格大于")
def _h2() -> None:
    tl = demo_timeline()
    lg = shared.ledger(tl)
    need(lg.useful_latency == 2900 and lg.useful_latency > lg.dead_air, f"实际 {js(lg)}")
    plain = shared.ledger(replace(tl, first_useful_at=tl.first_audible_at))
    need(plain.useful_latency == plain.dead_air, "没有填充语时两者应相等")


@t("H3", "分段百分位相加 ≠ 总耗时的百分位")
def _h3() -> None:
    turns = demo_nine_turns()
    p = shared.percentile
    totals = [x.endpoint + x.llm + x.tts for x in turns]
    sum50 = (
        p([x.endpoint for x in turns], 50)
        + p([x.llm for x in turns], 50)
        + p([x.tts for x in turns], 50)
    )
    sum95 = (
        p([x.endpoint for x in turns], 95)
        + p([x.llm for x in turns], 95)
        + p([x.tts for x in turns], 95)
    )
    need(sum50 == 1050 and p(totals, 50) == 1590, f"p50：{sum50} vs {p(totals, 50)}")
    need(sum95 == 4540 and p(totals, 95) == 4100, f"p95：{sum95} vs {p(totals, 95)}")


@t("H4", "nearest-rank 百分位")
def _h4() -> None:
    xs = [100, 200, 300, 400, 500, 600, 700, 800, 900]
    need(
        shared.percentile(xs, 95) == 900 and shared.percentile(xs, 50) == 500,
        f"实际 p95={shared.percentile(xs, 95)} p50={shared.percentile(xs, 50)}",
    )
    need(shared.percentile([1, 2, 3, 4], 50) == 2, "n=4 的 p50 应取第 2 个")


print()
if failed == 0:
    print(green(f"  ✓ {passed} 条断言全部通过"))
    print(
        dim(
            "\n  最该记住的六条：\n"
            "    A   一帧过阈值不算开口；说完时刻是最后一个有声帧，不是判定时刻\n"
            "    B   语义模型只把等待从 min 延长到 max；等 final 转写；复说就取消\n"
            "    C   投机要四样都对上；去标点别用 \\w\n"
            "    D   历史截到已播放：不是已生成，不是已发送；打断后旧 epoch 的块作废\n"
            "    F   中文句号后面没有空格；「.」要前瞻；首段为延迟、后续段为韵律\n"
            "    G   填充语等的是连续空闲；口头确认只来自已验证的状态\n"
        )
    )
    raise SystemExit(0)
print(red(f"  ✗ {failed} 失败 / {passed} 通过"))
raise SystemExit(1)
