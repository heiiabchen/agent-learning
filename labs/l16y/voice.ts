/**
 * L16y 的脚手架。跑法：pnpm voice
 *
 * 观察实验：静音阈值扫不出一个好值、语义模型只延长不缩短、同一话轮的四种首音延迟、
 * 生成 ≠ 发送 ≠ 播放、打断判定的混淆表、中英文分句、填充语的时机、过期的工具结果。
 * 全程零模型、零音频：时间是整数毫秒，输入全是合成的。写完六个 TODO 跑 pnpm verify:l16y。
 */

import {
  ABBR,
  BARGE_IN_DEFAULTS,
  CLOSERS,
  ENDPOINT_ZH,
  FIRST_MIN_UNITS,
  FRAME_MS,
  HARD_ASCII,
  HARD_CJK,
  LATER_MIN_UNITS,
  PlaybackLedger,
  SOFT,
  TaskBoard,
  badSplits,
  commitTurn,
  heardText,
  isCJK,
  judgeBargeIn,
  ledger,
  percentile,
  scheduleFillers,
  speechUnits,
  splitNaive,
  splitPaper,
  splitStream,
  synthTokens,
  type BargeInVerdict,
  type EndpointParams,
  type FillerParams,
  type Ms,
  type Seg,
  type SpecKey,
  type Span,
  type Tok,
  type Truncation,
  type TtsChunk,
  type TurnTimeline,
  type VadFrame,
  type VadMachine,
  type VadEvent,
  type VadParams,
} from '../shared/voice.ts'
import { isMain } from '../shared/entry.ts'

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
const w = (s: string) =>
  [...visible(s)].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0)
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - w(s)))
const lpad = (s: string, n: number) => ' '.repeat(Math.max(0, n - w(s))) + s

// ─────────────────────────────────────────────────────────────
// 夹具（verify 也用）
// ─────────────────────────────────────────────────────────────

export interface DemoTurn {
  id: string
  text: string
  /** 轮内停顿：时长与停顿那一刻话轮模型给出的「说完了」概率。 */
  pauses: { ms: Ms; eou: number }[]
  /** 真正说完时的「说完了」概率。 */
  endEou: number
}

/** 12 个合成的中文用户话轮。停顿时长和概率都是编的，形状参照「轮内停顿比换人间隙更长」。 */
export function demoTurns(): DemoTurn[] {
  return [
    { id: 't01', text: '帮我查一下订单', pauses: [], endEou: 0.92 },
    { id: 't02', text: '我想改一下……收货地址', pauses: [{ ms: 420, eou: 0.004 }], endEou: 0.88 },
    { id: 't03', text: '那个，上周买的……耳机……能退吗', pauses: [{ ms: 310, eou: 0.003 }, { ms: 650, eou: 0.002 }], endEou: 0.75 },
    { id: 't04', text: '好的谢谢', pauses: [], endEou: 0.97 },
    { id: 't05', text: '我要订……周五……下午两点的', pauses: [{ ms: 280, eou: 0.03 }, { ms: 760, eou: 0.001 }], endEou: 0.81 },
    { id: 't06', text: '嗯……让我想想……还是算了吧', pauses: [{ ms: 1100, eou: 0.003 }], endEou: 0.64 },
    { id: 't07', text: '那如果我……', pauses: [], endEou: 0.004 },
    { id: 't08', text: '是的，就是那个蓝色的', pauses: [{ ms: 350, eou: 0.2 }], endEou: 0.9 },
    { id: 't09', text: '退款……多久能到账', pauses: [{ ms: 520, eou: 0.05 }], endEou: 0.86 },
    { id: 't10', text: '对', pauses: [], endEou: 0.6 },
    { id: 't11', text: '帮我……把地址……改成公司', pauses: [{ ms: 240, eou: 0.01 }, { ms: 480, eou: 0.003 }], endEou: 0.79 },
    { id: 't12', text: '我再看看……那个……', pauses: [{ ms: 900, eou: 0.001 }], endEou: 0.002 },
  ]
}

export const SPEECH_MS = 800
export const STT_LAG_MS = 200

export type CommitFn = typeof commitTurn

/**
 * 用一个 commitTurn 跑一个话轮：每段话 SPEECH_MS，段间是停顿，final 转写在每段话结束后 STT_LAG_MS 到。
 * 任何一次停顿被提交 = 误切；没被切的话轮，死寂 = 真正说完到提交的时间。
 */
export function simulateTurn(turn: DemoTurn, p: EndpointParams, commit: CommitFn = commitTurn): { cutAt: number | null; deadAir: Ms | null } {
  let t = 0
  for (let i = 0; i < turn.pauses.length; i++) {
    const end = t + SPEECH_MS
    const pause = turn.pauses[i]!
    if (commit(end, pause.eou, end + STT_LAG_MS, end + pause.ms, p) !== null) return { cutAt: i, deadAir: null }
    t = end + pause.ms
  }
  const end = t + SPEECH_MS
  const at = commit(end, turn.endEou, end + STT_LAG_MS, null, p)
  return { cutAt: null, deadAir: at === null ? null : at - end }
}

export function silenceOnly(ms: Ms): EndpointParams {
  return { minDelayMs: ms, maxDelayMs: ms, unlikelyThreshold: 0 }
}

export const SPLIT_SAMPLES: [string, string][] = [
  ['zh-basic', '好的，我帮您查一下。您的订单已经发货了，预计明天下午送到。还有其他问题吗？'],
  ['zh-decimal', '这款套餐每月39.9元，比原来便宜3.5元。详情见第2.1节。'],
  ['zh-longcomma', '根据您提供的信息，我查到您在上周三下单的那台笔记本电脑目前正在从上海仓库发出，物流单号已经同步到您的手机上了。'],
  ['zh-mixed', '请访问 example.com 查看，或者联系 Dr. Wang。谢谢！'],
  ['zh-quote', '他说：“明天见。”然后就走了。'],
  ['en-basic', 'Sure, let me check that. Your order shipped yesterday. It should arrive by 3 p.m. tomorrow.'],
  ['en-tricky', 'The plan costs $39.99 per month. Dr. Smith recommended version 1.2.3 for you. Visit example.com for details.'],
  ['en-short', 'Yes.'],
]

/** 流结束时刻：最后一个 token 之后再过一个 token 间隔。 */
export function streamEnd(toks: Tok[], dt: Ms = 30): Ms {
  return toks[toks.length - 1]!.t + dt
}

export function demoTimeline(): TurnTimeline {
  return {
    userEndTrue: 0,
    vadLastSpeech: 40,
    commitAt: 540,
    llmRequestAt: 560,
    firstSegAt: 900,
    ttsFirstChunkAt: 1080,
    serverFirstFrameAt: 1100,
    firstAudibleAt: 1180,
    firstUsefulAt: 2900,
  }
}

/** 9 个话轮的分段耗时：话轮等待、LLM 首句、TTS 首块。 */
export function demoNineTurns(): { endpoint: Ms; llm: Ms; tts: Ms }[] {
  const endpoint = [500, 500, 500, 500, 500, 3000, 3000, 3000, 500]
  const llm = [300, 900, 320, 880, 310, 290, 870, 330, 860]
  const tts = [200, 220, 600, 210, 640, 190, 230, 620, 205]
  return endpoint.map((e, i) => ({ endpoint: e, llm: llm[i]!, tts: tts[i]! }))
}

/** 实验四：一条回复切成 5 块、每块 1000ms；TTS 以 3 倍实时生成，生成完立刻发给客户端。 */
export function demoReply(): { chunk: TtsChunk; readyAt: Ms }[] {
  const texts = ['您的订单已经发货了，', '预计明天下午送到，', '运费已经原路退回，', '优惠券也补发到您的账户，', '还有其他问题吗？']
  return texts.map((text, i) => ({
    chunk: { epoch: 0, itemId: 'a1', text, ms: 1000 },
    readyAt: Math.floor(((i + 1) * 1000) / 3),
  }))
}

export interface BargeCase {
  label: string
  speech: Span
  transcriptAt: Ms | null
  /** 理想结局。 */
  want: BargeInVerdict
}

export function demoBargeCases(): BargeCase[] {
  return [
    { label: '回声尖峰', speech: { start: 0, end: 120 }, transcriptAt: null, want: 'ignore' },
    { label: '「嗯」', speech: { start: 0, end: 300 }, transcriptAt: 500, want: 'ignore' },
    { label: '咳嗽', speech: { start: 0, end: 80 }, transcriptAt: null, want: 'ignore' },
    { label: '关门声', speech: { start: 0, end: 700 }, transcriptAt: null, want: 'resume' },
    { label: '真打断', speech: { start: 0, end: 900 }, transcriptAt: 500, want: 'interrupt' },
  ]
}

// ─────────────────────────────────────────────────────────────
// 观察实验
// ─────────────────────────────────────────────────────────────

function avgInt(xs: number[]): number {
  let s = 0
  for (const x of xs) s += x
  return xs.length ? Math.floor(s / xs.length) : 0
}

function exp1(): void {
  console.log(bold('\n实验一：纯静音阈值，扫不出一个好值（12 个合成中文话轮）'))
  console.log(dim('  阈值     误切   平均死寂'))
  for (const ms of [200, 300, 500, 700, 1000]) {
    const rs = demoTurns().map((t) => simulateTurn(t, silenceOnly(ms)))
    const cuts = rs.filter((r) => r.cutAt !== null).length
    const dead = rs.filter((r) => r.deadAir !== null).map((r) => r.deadAir!)
    console.log(`  ${lpad(String(ms), 4)}ms  ${lpad(String(cuts), 3)}/12  ${lpad(String(avgInt(dead)), 6)}ms`)
  }
  console.log(dim('  同一个人自己说话时的停顿，比换人时的间隙还长：阈值短到能及时接话，就一定切人；长到不切人，就一定慢。'))
}

function exp2(): void {
  console.log(bold('\n实验二：语义话轮模型只延长等待，不缩短（静音 500ms vs LiveKit 规则，中文阈值）'))
  console.log(dim(`  ${pad('话轮', 6)}${pad('停顿（ms / 概率）', 30)}${pad('静音 500', 12)}LiveKit`))
  const show = (r: { cutAt: number | null; deadAir: Ms | null }) => (r.cutAt !== null ? `误切@${r.cutAt + 1}` : `死寂 ${r.deadAir}`)
  const a: { cutAt: number | null; deadAir: Ms | null }[] = []
  const b: { cutAt: number | null; deadAir: Ms | null }[] = []
  for (const t of demoTurns()) {
    const ra = simulateTurn(t, silenceOnly(500))
    const rb = simulateTurn(t, ENDPOINT_ZH)
    a.push(ra)
    b.push(rb)
    const pauses = t.pauses.map((p) => `${p.ms}/${p.eou}`).join(' ') || '—'
    console.log(`  ${pad(t.id, 6)}${pad(pauses, 30)}${pad(show(ra), 12)}${show(rb)}`)
  }
  const summary = (rs: typeof a) => {
    const dead = rs.filter((r) => r.deadAir !== null).map((r) => r.deadAir!)
    return `误切 ${rs.filter((r) => r.cutAt !== null).length}，死寂 最小 ${Math.min(...dead)} / 平均 ${avgInt(dead)} / 最大 ${Math.max(...dead)}`
  }
  console.log(`  静音 500：${summary(a)}`)
  console.log(`  LiveKit ：${summary(b)}`)
  console.log(dim('  误切少了，但死寂的下限仍是 500ms；概率低的话轮（拖尾的「那如果我……」）要等满 3000ms。'))
  console.log(dim('  t09 的停顿 520ms、概率 0.05 高于中文阈值，模型照样切——它不是万能的。'))
}

function exp3(): void {
  console.log(bold('\n实验三：同一个话轮，四种「首音延迟」'))
  const tl = demoTimeline()
  const l = ledger(tl)
  const rows: [string, Ms, string][] = [
    ['论文 TTFA', l.paperTtfa, '话轮提交 → TTS 首块'],
    ['LiveKit e2e', l.livekitE2e, 'VAD 最后语音帧 → 服务端第一帧'],
    ['死寂', l.deadAir, '实际说完 → 第一个可听见的音'],
    ['有用延迟', l.usefulLatency, '实际说完 → 第一个有用的音'],
  ]
  for (const [name, ms, def] of rows) console.log(`  ${pad(name, 14)}${lpad(String(ms), 5)}ms  ${dim(def)}`)
  console.log(dim(`  其中话轮等待 ${l.endpointWait}ms：唯一一段什么都不做、纯在等的时间。`))

  const turns = demoNineTurns()
  const seg = (k: 'endpoint' | 'llm' | 'tts', q: number) => percentile(turns.map((t) => t[k]), q)
  const totals = turns.map((t) => t.endpoint + t.llm + t.tts)
  for (const q of [50, 95]) {
    const sumOfSeg = seg('endpoint', q) + seg('llm', q) + seg('tts', q)
    console.log(`  9 个话轮 p${q}：各段 p${q} 相加 ${lpad(String(sumOfSeg), 4)}ms，总耗时的 p${q} ${lpad(String(percentile(totals, q)), 4)}ms`)
  }
  console.log(dim('  分段百分位不能相加：p50 相加偏低，p95 相加偏高。要么测端到端的分布，要么明说是保守预算。'))
}

function exp4(): void {
  console.log(bold('\n实验四：生成 ≠ 发送 ≠ 播放（5 块各 1000ms，TTS 3 倍实时，播放 1200ms 时被打断）'))
  const reply = demoReply()
  const ledgerP = new PlaybackLedger()
  for (const r of reply) ledgerP.enqueue(r.chunk, r.readyAt)
  const firstStart = reply[0]!.readyAt
  const t = firstStart + 1200
  const sent = reply.filter((r) => r.readyAt <= t)
  const trunc: Truncation = ledgerP.bargeIn(t)!
  const rows: [string, string][] = [
    ['全留（LLM 写完的整段）', reply.map((r) => r.chunk.text).join('')],
    ['留已发送（Gemini 语义）', sent.map((r) => r.chunk.text).join('')],
    ['截到已播放（OpenAI truncate）', trunc.heardText],
  ]
  for (const [label, text] of rows) console.log(`  ${pad(label, 30)}${text}`)
  console.log(dim(`  打断时已发送 ${sent.length * 1000}ms 音频，实际播放 ${trunc.audioEndMs}ms；audio_end_ms 要填后者。`))
  console.log(dim('  前两种历史里都有用户没听到的话：模型会说「我刚才说过了，运费已经退回」。'))
}

function exp5(): void {
  console.log(bold('\n实验五：打断判定（agent 正在说话；2 秒内无转写则恢复）'))
  const durations = [0, 200, 500]
  console.log(dim(`  ${pad('声音', 10)}${pad('时长', 8)}${pad('理想', 11)}` + durations.map((d) => pad(`min=${d}`, 11)).join('')))
  const wrong = durations.map(() => 0)
  for (const c of demoBargeCases()) {
    const cells = durations.map((d, j) => {
      const v = judgeBargeIn(c.speech, true, c.transcriptAt, { ...BARGE_IN_DEFAULTS, minDurationMs: d })
      if (v !== c.want) wrong[j]!++
      return pad(v, 11)
    })
    console.log(`  ${pad(c.label, 10)}${pad(`${c.speech.end - c.speech.start}ms`, 8)}${pad(c.want, 11)}${cells.join('')}`)
  }
  console.log(`  ${pad('判错', 29)}${wrong.map((n) => pad(String(n), 11)).join('')}`)
  console.log(dim('  min=0 时每个声音都让 agent 停一下；「嗯」有转写，还会被当成真打断。'))
}

function exp6(): void {
  console.log(bold('\n实验六：中英文流式分句（第 i 个 token 在 300 + 30·i ms 到达）'))
  const splitters: [string, (t: Tok[], end: Ms) => Seg[]][] = [
    ['naive', splitNaive],
    ['paper', splitPaper],
    ['proposed', splitStream],
  ]
  console.log(dim(`  ${pad('分句器', 10)}${pad('样本', 14)}${lpad('首段ms', 7)}${lpad('首段单位', 10)}${lpad('段数', 6)}${lpad('误切', 6)}`))
  for (const [name, fn] of splitters) {
    for (const [sample, text] of SPLIT_SAMPLES) {
      const toks = synthTokens(text)
      const segs = fn(toks, streamEnd(toks))
      console.log(`  ${pad(name, 10)}${pad(sample, 14)}${lpad(String(segs[0]!.t), 7)}${lpad(String(speechUnits(segs[0]!.text)), 10)}` +
        `${lpad(String(segs.length), 6)}${lpad(String(badSplits(text, segs)), 6)}`)
    }
  }
  for (const sample of ['zh-basic', 'zh-longcomma']) {
    const text = SPLIT_SAMPLES.find((s) => s[0] === sample)![1]
    const toks = synthTokens(text)
    for (const [name, fn] of splitters.slice(1)) {
      const segs = fn(toks, streamEnd(toks))
      console.log(dim(`  ${pad(`${name}/${sample}`, 22)}`) + segs.map((s) => `${s.t}|${s.text}`).join(' ‖ '))
    }
  }
  console.log(dim('  论文的规则要求「标点后跟空白」：中文句号后面没有空格，于是首音 = 整段生成完。'))
}

function exp7(): void {
  console.log(bold('\n实验七：填充语什么时候说（填充语本身 1200ms）'))
  const cases: { label: string; tool: Span; busy: Span[]; p: FillerParams }[] = [
    { label: '工具 1800ms，用户在 400–900 说话', tool: { start: 0, end: 1800 }, busy: [{ start: 400, end: 900 }], p: { delayMs: 500, intervalMs: null, maxSteps: null } },
    { label: '工具 300ms，delay=0（LiveKit 默认）', tool: { start: 0, end: 300 }, busy: [], p: { delayMs: 0, intervalMs: null, maxSteps: null } },
    { label: '工具 300ms，delay=500', tool: { start: 0, end: 300 }, busy: [], p: { delayMs: 500, intervalMs: null, maxSteps: null } },
  ]
  const fillerMs = 1200
  const naive = (tool: Span, p: FillerParams) => (tool.start + p.delayMs < tool.end ? [tool.start + p.delayMs] : [])
  console.log(dim(`  ${pad('场景', 38)}${pad('调度', 12)}${pad('触发', 8)}${pad('撞上用户', 10)}答案推迟`))
  for (const c of cases) {
    const rows: [string, Ms[]][] = [
      ['开始后计时', naive(c.tool, c.p)],
      ['连续空闲', scheduleFillers(c.tool.start, c.tool.end, c.busy, fillerMs, c.p)],
    ]
    rows.forEach(([name, fires], i) => {
      const f = fires[0]
      const clash = f !== undefined && c.busy.some((b) => b.start < f + fillerMs && f < b.end)
      const push = f === undefined ? 0 : Math.max(0, f + fillerMs - c.tool.end)
      console.log(`  ${pad(i === 0 ? c.label : '', 38)}${pad(name, 12)}${pad(f === undefined ? '—' : String(f), 8)}${pad(clash ? '是' : '否', 10)}${push}ms`)
    })
  }
  console.log(dim('  连续空闲不会和用户撞车，但填充语一旦开口就要说完：工具先回来，答案也得排在它后面。'))
  console.log(dim('  默认 delay=0 时，一个 300ms 的工具被换成了一句 1.2 秒的「我查一下」。'))
}

function exp8(): void {
  console.log(bold('\n实验八：用户把周五改成周四，周五的结果后到'))
  const board = new TaskBoard()
  const log: [string, string][] = []
  const fri = board.start('book')
  log.push(['订周五（epoch 1）', board.utterable('book')])
  const thu = board.amend('book')
  log.push(['改成周四（epoch 2）', board.utterable('book')])
  log.push([`周五的结果回来：${board.result('book', fri, true)}`, board.utterable('book')])
  log.push([`周四的结果回来：${board.result('book', thu, true)}`, board.utterable('book')])
  console.log(dim(`  ${pad('事件', 30)}可以说出口的状态`))
  for (const [e, s] of log) console.log(`  ${pad(e, 30)}${s}`)
  console.log(dim('  口头确认只能来自已验证的状态；「闭嘴」打断的是话语，后台的订票照常进行。'))
}

// ─────────────────────────────────────────────────────────────
// TODO
// ─────────────────────────────────────────────────────────────

/**
 * TODO 1 ★ VAD 四态滞回的一步。帧的 t 是这一帧结束的时刻，每帧 FRAME_MS（20ms）；p ≥ threshold 算有声。
 *   quiet → starting → speaking：连续有声满 startMs 才进 speaking，那一刻发 speech_start
 *   speaking → stopping → quiet：连续无声满 stopMs 才回 quiet，那一刻发 speech_end
 *   starting 中途掉到阈值下 → 回 quiet、计时清零；stopping 中途又有声 → 回 speaking、不发事件
 * 事件里的 lastSpeechAt 是最后一个有声帧的 t。
 * 陷阱：单帧过阈值就切状态；speech_end 的「说完时刻」用判定时刻（晚了整整 stopMs）。
 */
export function myVadStep(m: VadMachine, f: VadFrame, p: VadParams): [VadMachine, VadEvent | null] {
  throw new Error('TODO 1 未实现')
}

/**
 * TODO 2 ★★ 话轮在什么时刻提交（不提交返回 null）。
 *   等待 = eouProb < unlikelyThreshold ? maxDelayMs : minDelayMs
 *   commitAt = max(lastSpeechAt + 等待, sttFinalAt)；sttFinalAt 为 null → 不提交
 *   nextSpeechStart 早于 commitAt → 不提交（用户只是停顿了一下）
 * 陷阱：用概率把等待缩短到 min 以下；不等 final 转写就提交；忘了「复说取消」。
 */
export function myCommitTurn(
  lastSpeechAt: Ms,
  eouProb: number,
  sttFinalAt: Ms | null,
  nextSpeechStart: Ms | null,
  p: EndpointParams,
): Ms | null {
  throw new Error('TODO 2 未实现')
}

/**
 * TODO 3 ★ 投机生成能不能直接用。
 *   myNormalizeTranscript：ASCII 字母转小写；去掉中英文标点；连续空白压成一个空格；去首尾空格
 *   mySpeculationValid：归一化后的转写、ctxVersion、toolsVersion、toolChoice 四样都相同
 * 陷阱：用 \w 判标点——TS 的 \w 不认汉字，会把整句中文当标点删光；只比转写、不比版本。
 */
export function myNormalizeTranscript(s: string): string {
  throw new Error('TODO 3 未实现')
}

export function mySpeculationValid(spec: SpecKey, committed: SpecKey): boolean {
  throw new Error('TODO 3 未实现')
}

/**
 * TODO 4 ★★ 打断时截断播放账本。enqueue / playedMsAt / speakingAt 已经写好，
 * 你能用的字段：this.scheduled（{ chunk, start }[]，按入队顺序）、this.freeAt、this.epoch。
 *   t 时没有在播或待播的音频 → null
 *   否则找到 t 时正在播（或排在最前、还没开始）的那个 item：audioEndMs = 它到 t 为止实际播了多少，
 *   heardText 用 shared 的 heardText 算，dropItem = 一帧没播；然后 epoch + 1、清空队列、freeAt = t
 * 陷阱：截到已生成 / 已发送（入队总时长）；忘了 epoch，打断后迟到的 TTS 块又被播出来。
 */
export class MyPlaybackLedger extends PlaybackLedger {
  override bargeIn(t: Ms): Truncation | null {
    throw new Error('TODO 4 未实现')
  }
}

/**
 * TODO 5 ★★ 流式分句。规则见 shared/voice.ts 的 splitStream 注释，要点：
 *   中文句末（。！？；）和 ! ? ; 之后多等 1 个字符，后引号跟着这一句走
 *   「.」前瞻 1 个字符：下一个是空格或汉字、前一个词不是缩写（ABBR 或单个字母），才切
 *   第一段可以在 ，,、：: 处切（够 4 个语音单位）；后续段至少 8 个单位、不在逗号处切
 *   切点处的空格丢掉，其余字符一个不改；流结束（endAt）时剩下的冲出去
 * 陷阱：见句号就切（39.9、Dr.）；只认 .!? 加空白（中文永远切不出来）；按字符数而不是语音单位定阈值。
 */
export function mySplitStream(tokens: Tok[], endAt: Ms): Seg[] {
  throw new Error('TODO 5 未实现')
}

/**
 * TODO 6 ★ 填充语调度。工具在 [toolStart, toolEnd) 运行，busy 是有人说话的区间（左闭右开）。
 *   连续空闲满 delayMs 才触发；任何一段 busy 都把等待清零；触发时刻 ≥ toolEnd 就不再触发
 *   触发后填充语本身播 fillerMs，也算忙；intervalMs 为 null 最多一次，否则过 intervalMs（墙钟）
 *   再重新等空闲；maxSteps 封顶
 * 陷阱：toolStart + delayMs 直接触发；填充语播放期间也当成空闲。
 */
export function myScheduleFillers(toolStart: Ms, toolEnd: Ms, busy: Span[], fillerMs: Ms, p: FillerParams): Ms[] {
  throw new Error('TODO 6 未实现')
}

// ─────────────────────────────────────────────────────────────

function main(): void {
  exp1()
  exp2()
  exp3()
  exp4()
  exp5()
  exp6()
  exp7()
  exp8()
  console.log(bold('\n最该记住的'))
  console.log('  · 比延迟数字之前先对齐起止点：论文的 TTFA 不含话轮等待，用户的死寂含。')
  console.log('  · 语义话轮模型买的是少截断，不是更快；更快要靠在等待期间就开始生成。')
  console.log('  · 用户听到的才算说过：历史截到已播放，不是已生成、也不是已发送。')
  console.log('  · 「闭嘴」不等于「取消订单」：打断停的是话语，后台任务只认已验证的状态。')
  console.log('  · 中文句号后面没有空格：英文上验证过的分句规则，搬过来首音就等于整段生成完。')
}

if (isMain(import.meta.url)) main()
