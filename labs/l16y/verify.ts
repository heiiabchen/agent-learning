/**
 * 验证 l16y/voice.ts。
 *   VOICE_IMPL=shared pnpm verify:l16y
 *   pnpm verify:l16y
 *
 * 零模型、零音频。时间是整数毫秒，VAD 概率、token、TTS 块全是手造的。
 */

import * as shared from '../shared/voice.ts'
import type { PlaybackLedger, Seg, SpecKey, TtsChunk, VadEvent, VadFrame } from '../shared/voice.ts'
import { SPLIT_SAMPLES, demoNineTurns, demoTimeline, demoTurns, silenceOnly, simulateTurn, streamEnd } from './voice.ts'

const TARGET = process.env.VOICE_IMPL === 'shared' ? 'shared' : 'mine'

type Api = {
  vadStep: typeof shared.vadStep
  commitTurn: typeof shared.commitTurn
  normalize: typeof shared.normalizeTranscript
  speculationValid: typeof shared.speculationValid
  Ledger: new () => PlaybackLedger
  splitStream: typeof shared.splitStream
  scheduleFillers: typeof shared.scheduleFillers
}

async function loadMine(): Promise<Api> {
  const m = await import('./voice.ts')
  return {
    vadStep: m.myVadStep,
    commitTurn: m.myCommitTurn,
    normalize: m.myNormalizeTranscript,
    speculationValid: m.mySpeculationValid,
    Ledger: m.MyPlaybackLedger,
    splitStream: m.mySplitStream,
    scheduleFillers: m.myScheduleFillers,
  }
}

const M: Api =
  TARGET === 'shared'
    ? {
        vadStep: shared.vadStep,
        commitTurn: shared.commitTurn,
        normalize: shared.normalizeTranscript,
        speculationValid: shared.speculationValid,
        Ledger: shared.PlaybackLedger,
        splitStream: shared.splitStream,
        scheduleFillers: shared.scheduleFillers,
      }
    : await loadMine()

console.log(
  TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l16y/ 里你的实现）',
)

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

class Fail extends Error {}
function need(cond: boolean, why: string): void {
  if (!cond) throw new Fail(why)
}

let passed = 0
let failed = 0
function t(id: string, name: string, fn: () => void): void {
  try {
    fn()
    passed++
  } catch (e) {
    failed++
    const why = e instanceof Fail ? e.message : `抛出了异常：${(e as Error).message}`
    console.log(red(`  ✗ ${id} ${name}`) + dim(`\n      ${why}`))
  }
}
function section(s: string): void {
  console.log(bold(`\n${s}`))
}

const J = (x: unknown) => JSON.stringify(x)

// ─────────────────────────────────────────────────────────────
section('A · VAD 四态滞回')

function frames(ps: number[]): VadFrame[] {
  return ps.map((p, i) => ({ t: (i + 1) * shared.FRAME_MS, p }))
}
function run(ps: number[]): VadEvent[] {
  let m = shared.VAD_INIT
  const out: VadEvent[] = []
  for (const f of frames(ps)) {
    const [next, ev] = M.vadStep(m, f, shared.VAD_DEFAULTS)
    m = next
    if (ev) out.push(ev)
  }
  return out
}
const rep = (p: number, n: number) => Array.from({ length: n }, () => p)
const kinds = (evs: VadEvent[]) => evs.map((e) => e.kind).join(',')

t('A1', '全静音 → 没有事件', () => {
  const evs = run(rep(0.1, 50))
  need(evs.length === 0, `应无事件，实际 ${J(evs)}`)
})
t('A2', '连续 10 帧有声 → 恰好一个 speech_start，在第 10 帧（200ms）', () => {
  const nine = run(rep(0.9, 9))
  need(nine.length === 0, `9 帧（180ms）不该开口，实际 ${J(nine)}`)
  const evs = run(rep(0.9, 10))
  need(evs.length === 1 && evs[0]!.kind === 'speech_start' && evs[0]!.t === 200, `实际 ${J(evs)}`)
})
t('A3', '单帧尖峰夹在静音里 → 不是开口', () => {
  const evs = run([...rep(0.1, 5), 0.9, ...rep(0.1, 5)])
  need(evs.length === 0, `单帧过阈值就切状态了：${J(evs)}`)
})
t('A4', '说话中间 160ms 的换气 → 不发 speech_end', () => {
  const evs = run([...rep(0.9, 15), ...rep(0.1, 8), ...rep(0.9, 15), ...rep(0.1, 15)])
  need(kinds(evs) === 'speech_start,speech_end', `应为 speech_start,speech_end，实际 ${kinds(evs)}`)
  need(evs[1]!.lastSpeechAt === 760, `说完时刻应是第二段最后一帧 760，实际 ${evs[1]!.lastSpeechAt}`)
})
t('A5', 'speech_end 的 lastSpeechAt 是最后一个有声帧，不是判定时刻', () => {
  const evs = run([...rep(0.9, 15), ...rep(0.1, 15)])
  const end = evs.find((e) => e.kind === 'speech_end')
  need(end !== undefined, '没有 speech_end')
  need(end!.t === 500 && end!.lastSpeechAt === 300, `应在 500 判定、说完于 300，实际 t=${end!.t} lastSpeechAt=${end!.lastSpeechAt}`)
})
t('A6', 'starting 中途掉到阈值下 → 回 quiet，计时清零', () => {
  const evs = run([...rep(0.9, 5), 0.1, ...rep(0.9, 10)])
  need(evs.length === 1 && evs[0]!.t === 320, `应在 320 开口（从 140 重新计时），实际 ${J(evs)}`)
})
t('A7', 'p 恰好等于阈值算有声（>=）', () => {
  const evs = run(rep(0.7, 10))
  need(evs.length === 1 && evs[0]!.t === 200, `p=0.7 应算有声，实际 ${J(evs)}`)
  need(run(rep(0.6999, 20)).length === 0, 'p=0.6999 不该算有声')
})

// ─────────────────────────────────────────────────────────────
section('B · 端点')

const ZH = shared.ENDPOINT_ZH
const EN = shared.ENDPOINT_EN
const delay = (eou: number, p = ZH) => M.commitTurn(1000, eou, 1000, null, p)! - 1000

t('B1', '概率高 → 等 min（500ms）', () => {
  need(delay(0.5) === 500, `实际等 ${delay(0.5)}`)
})
t('B2', '概率低于中文阈值 → 等 max（3000ms）', () => {
  need(delay(0.001) === 3000, `实际等 ${delay(0.001)}`)
})
t('B3', '任何概率都不让等待短于 min', () => {
  for (const eou of [0, 0.0001, 0.0065, 0.0066, 0.01, 0.5, 0.99, 1]) {
    need(delay(eou) >= 500, `eou=${eou} 等了 ${delay(eou)}ms，比 min 还短`)
  }
})
t('B4', '阈值按语种：eou=0.008 中文等 500、英文等 3000', () => {
  need(delay(0.008, ZH) === 500 && delay(0.008, EN) === 3000, `中文 ${delay(0.008, ZH)}，英文 ${delay(0.008, EN)}`)
})
t('B5', 'final 转写晚于等待结束 → 提交在 final 到达时', () => {
  const at = M.commitTurn(1000, 0.5, 1800, null, ZH)
  need(at === 1800, `应为 1800，实际 ${at}`)
})
t('B6', '提交之前用户又开口 → 不提交；实验二的误切数', () => {
  need(M.commitTurn(1000, 0.5, 1200, 1400, ZH) === null, '1400 复说早于 1500 的提交，应取消')
  need(M.commitTurn(1000, 0.001, 1200, 2500, ZH) === null, '低概率等到 4000，2500 复说应取消')
  const cut = (p: shared.EndpointParams) =>
    demoTurns().filter((x) => simulateTurn(x, p, M.commitTurn).cutAt !== null).map((x) => x.id).join()
  need(cut(silenceOnly(500)) === 't03,t05,t06,t09,t12', `静音 500 应误切 t03,t05,t06,t09,t12，实际 ${cut(silenceOnly(500))}`)
  need(cut(ZH) === 't09', `LiveKit 规则应只误切 t09，实际 ${cut(ZH)}`)
})
t('B7', '复说不早于提交时刻 → 照常提交', () => {
  need(M.commitTurn(1000, 0.5, 1200, 1500, ZH) === 1500, '复说恰在 1500，应照常提交')
  need(M.commitTurn(1000, 0.5, 1200, 1600, ZH) === 1500, '复说在 1600，应在 1500 提交')
})
t('B8', '还没有 final 转写 → 不提交', () => {
  need(M.commitTurn(1000, 0.5, null, null, ZH) === null, '没有转写也提交了')
})

// ─────────────────────────────────────────────────────────────
section('C · 投机生成')

const key = (transcript: string, o: Partial<SpecKey> = {}): SpecKey => ({
  transcript,
  ctxVersion: 3,
  toolsVersion: 1,
  toolChoice: 'auto',
  ...o,
})

t('C1', '只差大小写和末尾句号 → 有效', () => {
  need(M.speculationValid(key('Book a table.'), key('book a table')), '应有效')
})
t('C2', '中文只差全角标点 → 有效；归一化不能把汉字删掉', () => {
  need(M.normalize('好的，查一下。') === '好的查一下', `归一化结果 ${J(M.normalize('好的，查一下。'))}`)
  need(M.speculationValid(key('好的，查一下。'), key('好的查一下')), '应有效')
  need(!M.speculationValid(key('好的查一下'), key('好的取消')), '内容不同的中文也判成有效了')
})
t('C3', '转写相同但工具版本变了 → 无效', () => {
  need(!M.speculationValid(key('查订单'), key('查订单', { toolsVersion: 2 })), '应无效')
})
t('C4', '转写相同但上下文版本或 tool_choice 变了 → 无效', () => {
  need(!M.speculationValid(key('查订单'), key('查订单', { ctxVersion: 4 })), 'ctxVersion 变了应无效')
  need(!M.speculationValid(key('查订单'), key('查订单', { toolChoice: 'none' })), 'toolChoice 变了应无效')
})
t('C5', '多一个词 → 无效', () => {
  need(!M.speculationValid(key('book a table'), key('book a table now')), '应无效')
})
t('C6', '归一化：空白压缩、只去 ASCII 空格、幂等', () => {
  need(M.normalize('  Hello,  World! ') === 'hello world', `实际 ${J(M.normalize('  Hello,  World! '))}`)
  need(M.normalize('A\tB\nC') === 'a b c', `实际 ${J(M.normalize('A\tB\nC'))}`)
  for (const s of ['  Hello,  World! ', '好的，\t查一下。', 'Dr. Wang 说：“OK”', '', '\u00a0x']) {
    const once = M.normalize(s)
    need(M.normalize(once) === once, `${J(s)} 归一化两次结果不同`)
  }
  need(M.normalize('\u00a0x') === '\u00a0x', '不间断空格不是 ASCII 空格，不该被去掉')
})

// ─────────────────────────────────────────────────────────────
section('D · 播放账本与截断')

const chunk = (text: string, ms = 1000, itemId = 'a1', epoch = 0): TtsChunk => ({ epoch, itemId, text, ms })
const three = () => {
  const l = new M.Ledger()
  for (const s of ['您的订单已经发货了', '预计明天下午送到', '还有其他问题吗']) l.enqueue(chunk(s), 100)
  return l
}

t('D1', '3 块一次入队，从 100 起播：1300 时已播 1200ms', () => {
  const l = three()
  need(l.playedMsAt(1300) === 1200, `实际 ${l.playedMsAt(1300)}`)
})
t('D2', '打断时截到已播放，不是已入队；audioEndMs 是 item 内的毫秒', () => {
  const tr = three().bargeIn(1300)
  need(tr !== null && tr.audioEndMs === 1200, `应为 1200，实际 ${J(tr)}`)
  const l = new M.Ledger()
  l.enqueue(chunk('第一句', 1000, 'a1'), 0)
  l.enqueue(chunk('第二句', 1000, 'a1'), 0)
  l.enqueue(chunk('下一条', 1000, 'a2'), 0)
  const tr2 = l.bargeIn(2400)
  need(tr2 !== null && tr2.itemId === 'a2' && tr2.audioEndMs === 400, `应为 a2 播到 400，实际 ${J(tr2)}`)
})
t('D3', 'audioEndMs 不超过已入队总时长；两块之间的空档不算播放', () => {
  const l = new M.Ledger()
  l.enqueue(chunk('先说这句', 1000), 0)
  l.enqueue(chunk('后到这句', 1000), 1500)
  const tr = l.bargeIn(1200)
  need(tr !== null && tr.audioEndMs === 1000 && tr.heardText === '先说这句', `应播到 1000、听到「先说这句」，实际 ${J(tr)}`)
})
t('D4', '听到的文字不含第 3 块的任何字', () => {
  const tr = three().bargeIn(1300)
  need(tr !== null && tr.heardText === '您的订单已经发货了预', `实际 ${J(tr?.heardText)}`)
  need(![...'还有其他问题吗'].some((c) => tr!.heardText.includes(c)), '混进了第 3 块的字')
})
t('D5', '当前块按码点比例向下取整：9 字的块播一半 → 4 字', () => {
  const l = new M.Ledger()
  l.enqueue(chunk('您的订单已经发货了'), 0)
  const tr = l.bargeIn(500)
  need(tr !== null && tr.heardText === '您的订单', `实际 ${J(tr?.heardText)}`)
})
t('D6', '一帧没播就打断 → dropItem', () => {
  const l = new M.Ledger()
  l.enqueue(chunk('还没开始播'), 1000)
  const tr = l.bargeIn(500)
  need(tr !== null && tr.dropItem && tr.audioEndMs === 0 && tr.heardText === '', `实际 ${J(tr)}`)
  const tr2 = three().bargeIn(1300)
  need(tr2 !== null && !tr2.dropItem, '播过的不该 dropItem')
})
t('D7', '打断后 epoch + 1；迟到的旧块是 stale，不会被播出来', () => {
  const l = three()
  l.bargeIn(1300)
  need(l.epoch === 1, `epoch 应为 1，实际 ${l.epoch}`)
  need(l.enqueue(chunk('迟到的块'), 1400) === 'stale', '旧 epoch 的块应判 stale')
  need(l.playedMsAt(3000) === 0 && !l.speakingAt(1500), '旧块被播出来了')
})
t('D8', '新 epoch 的块正常入队播放', () => {
  const l = three()
  l.bargeIn(1300)
  need(l.enqueue(chunk('新回复', 1000, 'a2', 1), 2000) === 'queued', '新 epoch 的块应入队')
  need(l.playedMsAt(2500) === 500 && l.speakingAt(2500), `2500 时应已播 500，实际 ${l.playedMsAt(2500)}`)
})
t('D9', '连续打断两次，第二次返回 null', () => {
  const l = three()
  l.bargeIn(1300)
  const again = l.bargeIn(1300)
  need(again === null, `实际 ${J(again)}`)
})
t('D10', '一次性入队 5 块，播放仍按实时走', () => {
  const l = new M.Ledger()
  for (let i = 0; i < 5; i++) l.enqueue(chunk(`第${i}块`), 0)
  need(l.playedMsAt(2500) === 2500, `2500 时应播 2500，实际 ${l.playedMsAt(2500)}`)
  need(l.speakingAt(4999) && !l.speakingAt(5000), '5000 才播完')
  const tr = l.bargeIn(2500)
  need(tr !== null && tr.audioEndMs === 2500, `应截到 2500，实际 ${J(tr)}`)
})

// ─────────────────────────────────────────────────────────────
section('E · 打断判定（参考实现，只读）')

const judge = shared.judgeBargeIn

t('E1', 'agent 没在说话 → ignore', () => {
  need(judge({ start: 0, end: 900 }, false, 500) === 'ignore', '话轮开始不是打断')
})
t('E2', '300ms 的「嗯」→ ignore', () => {
  need(judge({ start: 0, end: 300 }, true, 500) === 'ignore', '应 ignore')
})
t('E3', '120ms 的回声尖峰 → ignore', () => {
  need(judge({ start: 0, end: 120 }, true, null) === 'ignore', '应 ignore')
})
t('E4', '900ms 且有转写 → interrupt', () => {
  need(judge({ start: 0, end: 900 }, true, 1200) === 'interrupt', '应 interrupt')
})
t('E5', '900ms 但停下后 2 秒内没有转写 → resume', () => {
  need(judge({ start: 0, end: 900 }, true, null) === 'resume', '没有转写应 resume')
  need(judge({ start: 0, end: 900 }, true, 3000) === 'resume', '3000 > 900 + 2000，应 resume')
  need(judge({ start: 0, end: 900 }, true, 2900) === 'interrupt', '2900 恰在超时边界，应 interrupt')
})

// ─────────────────────────────────────────────────────────────
section('F · 中英文流式分句')

const sample = (name: string) => SPLIT_SAMPLES.find((s) => s[0] === name)![1]
const split = (text: string): Seg[] => {
  const toks = shared.synthTokens(text)
  return M.splitStream(toks, streamEnd(toks))
}
const texts = (segs: Seg[]) => segs.map((s) => s.text)
const PROPOSED: Record<string, [number, number, number, number]> = {
  'zh-basic': [600, 8, 3, 0],
  'zh-decimal': [540, 9, 3, 0],
  'zh-longcomma': [540, 8, 2, 0],
  'zh-mixed': [510, 7, 2, 0],
  'zh-quote': [570, 5, 2, 0],
  'en-basic': [450, 5, 2, 0],
  'en-tricky': [480, 7, 3, 0],
  'en-short': [330, 1, 1, 0],
}
const LATER_COMMA = '好的，我帮您查一下。然后呢，这个订单已经发货了，明天下午就能到。'

function exactPieces(src: string, segs: Seg[]): string | null {
  const cs = Array.from(src)
  let pos = 0
  for (const s of segs) {
    while (pos < cs.length && cs[pos] === ' ') pos++
    const seg = Array.from(s.text)
    if (seg.length === 0) return '出现了空段'
    if (cs.slice(pos, pos + seg.length).join('') !== s.text) return `${J(s.text)} 不是原文在第 ${pos} 个码点处的子串`
    pos += seg.length
  }
  while (pos < cs.length && cs[pos] === ' ') pos++
  return pos === cs.length ? null : `原文从第 ${pos} 个码点起没有被任何段覆盖`
}

t('F1', 'zh-basic 首段是「好的，我帮您查一下。」；实验六 proposed 那 8 行', () => {
  const segs = split(sample('zh-basic'))
  need(segs[0]!.text === '好的，我帮您查一下。', `首段 ${J(segs[0]!.text)}`)
  for (const [name, text] of SPLIT_SAMPLES) {
    const s = split(text)
    const row = [s[0]!.t, shared.speechUnits(s[0]!.text), s.length, shared.badSplits(text, s)]
    need(J(row) === J(PROPOSED[name]), `${name}：应为 ${J(PROPOSED[name])}，实际 ${J(row)}`)
  }
})
t('F2', '没有空格的中文也切得出来', () => {
  for (const name of ['zh-basic', 'zh-decimal', 'zh-longcomma', 'zh-mixed', 'zh-quote']) {
    const n = split(sample(name)).length
    need(n >= 2, `${name} 只切出 ${n} 段：只认「标点后跟空白」？`)
  }
})
t('F3', '「39.9元」不在小数点处切', () => {
  const segs = split(sample('zh-decimal'))
  need(!segs.some((s) => /[0-9]\.$/.test(s.text)) && segs.some((s) => s.text.includes('39.9元')), `实际 ${J(texts(segs))}`)
})
t('F4', '「Dr. Wang」「Dr. Smith」不在缩写后切', () => {
  for (const name of ['zh-mixed', 'en-tricky']) {
    const segs = split(sample(name))
    need(!segs.some((s) => s.text.endsWith('Dr.')), `${name}：${J(texts(segs))}`)
  }
  const long = split('Please hold on while I transfer you to Dr. Smith in cardiology.')
  need(long.length === 1, `「Dr.」前面已经够长，也不该切：${J(texts(long))}`)
})
t('F5', '「example.com」不切', () => {
  for (const name of ['zh-mixed', 'en-tricky']) {
    const segs = split(sample(name))
    need(segs.some((s) => s.text.includes('example.com')), `${name}：${J(texts(segs))}`)
  }
})
t('F6', '后引号跟着前一句走', () => {
  const segs = split(sample('zh-quote'))
  need(J(texts(segs)) === J(['他说：“明天见。”', '然后就走了。']), `实际 ${J(texts(segs))}`)
})
t('F7', '长逗号句：首段在第一个逗号处出，540ms', () => {
  const segs = split(sample('zh-longcomma'))
  need(segs[0]!.text === '根据您提供的信息，' && segs[0]!.t === 540, `首段 ${segs[0]!.t}|${segs[0]!.text}`)
})
t('F8', '后续段不在逗号处切', () => {
  const segs = split(LATER_COMMA)
  need(J(texts(segs)) === J(['好的，我帮您查一下。', '然后呢，这个订单已经发货了，明天下午就能到。']), `实际 ${J(texts(segs))}`)
})
t('F9', '分句不改字符：每段都是原文按序的子串，段间只隔空格', () => {
  for (const [name, text] of [...SPLIT_SAMPLES, ['later-comma', LATER_COMMA] as [string, string]]) {
    const why = exactPieces(text, split(text))
    need(why === null, `${name}：${why}`)
  }
})
t('F10', '按码点截断：「好😀好」播一半 → 「好」', () => {
  const l = new M.Ledger()
  l.enqueue(chunk('好😀好'), 0)
  const tr = l.bargeIn(500)
  need(tr !== null && tr.heardText === '好', `实际 ${J(tr?.heardText)}（按 UTF-16 切会多出半个 emoji）`)
  const l2 = new M.Ledger()
  l2.enqueue(chunk('好😀好'), 0)
  const tr2 = l2.bargeIn(700)
  need(tr2 !== null && tr2.heardText === '好😀', `700ms 应为「好😀」，实际 ${J(tr2?.heardText)}`)
})

// ─────────────────────────────────────────────────────────────
section('G · 填充语与任务板')

const once = (delayMs: number) => ({ delayMs, intervalMs: null, maxSteps: null })

t('G1', '工具 300ms、delay 500 → 不说填充语', () => {
  const f = M.scheduleFillers(0, 300, [], 1200, once(500))
  need(f.length === 0, `实际 ${J(f)}`)
})
t('G2', '工具 1800ms、用户在 400–900 说话 → 1400 才说，不是 500', () => {
  const f = M.scheduleFillers(0, 1800, [{ start: 400, end: 900 }], 1200, once(500))
  need(J(f) === '[1400]', `实际 ${J(f)}`)
})
t('G3', 'intervalMs = null → 最多一次', () => {
  const f = M.scheduleFillers(0, 10000, [], 1200, once(500))
  need(J(f) === '[500]', `实际 ${J(f)}`)
})
t('G4', 'maxSteps = 2 → 恰好两次；第二次要等填充语本身播完', () => {
  const f = M.scheduleFillers(0, 10000, [], 1200, { delayMs: 500, intervalMs: 1000, maxSteps: 2 })
  need(J(f) === '[500,2200]', `应为 [500,2200]，实际 ${J(f)}`)
})
t('G5', '改了需求，旧结果作废，状态仍是 working', () => {
  const b = new shared.TaskBoard()
  const fri = b.start('book')
  b.amend('book')
  need(b.result('book', fri, true) === 'stale' && b.utterable('book') === 'working', `实际 ${b.utterable('book')}`)
})
t('G6', '只有被接受的成功结果才能说成「办好了」', () => {
  const b = new shared.TaskBoard()
  const e = b.start('book')
  need(b.utterable('book') === 'working', '刚发起就不是 working 了')
  need(b.result('book', e, false) === 'accepted' && b.utterable('book') === 'failed', '失败结果应记为 failed')
  const b2 = new shared.TaskBoard()
  const e2 = b2.start('book')
  b2.result('book', e2, true)
  need(b2.utterable('book') === 'completed', '成功结果应记为 completed')
  const e3 = b2.amend('book')
  need(b2.cancelConfirmed('book', e3 - 1) === 'stale' && b2.utterable('book') === 'working', '旧 epoch 的取消确认应作废')
})

// ─────────────────────────────────────────────────────────────
section('H · 延迟账（参考实现，只读）')

t('H1', '同一时间线：论文 TTFA < LiveKit e2e < 死寂', () => {
  const l = shared.ledger(demoTimeline())
  need(l.paperTtfa === 540 && l.livekitE2e === 1060 && l.deadAir === 1180, `实际 ${J(l)}`)
})
t('H2', '有用延迟 ≥ 死寂；有填充语时严格大于', () => {
  const tl = demoTimeline()
  const l = shared.ledger(tl)
  need(l.usefulLatency === 2900 && l.usefulLatency > l.deadAir, `实际 ${J(l)}`)
  const plain = shared.ledger({ ...tl, firstUsefulAt: tl.firstAudibleAt })
  need(plain.usefulLatency === plain.deadAir, '没有填充语时两者应相等')
})
t('H3', '分段百分位相加 ≠ 总耗时的百分位', () => {
  const turns = demoNineTurns()
  const p = (xs: number[], q: number) => shared.percentile(xs, q)
  const totals = turns.map((x) => x.endpoint + x.llm + x.tts)
  const sum50 = p(turns.map((x) => x.endpoint), 50) + p(turns.map((x) => x.llm), 50) + p(turns.map((x) => x.tts), 50)
  const sum95 = p(turns.map((x) => x.endpoint), 95) + p(turns.map((x) => x.llm), 95) + p(turns.map((x) => x.tts), 95)
  need(sum50 === 1050 && p(totals, 50) === 1590, `p50：${sum50} vs ${p(totals, 50)}`)
  need(sum95 === 4540 && p(totals, 95) === 4100, `p95：${sum95} vs ${p(totals, 95)}`)
})
t('H4', 'nearest-rank 百分位', () => {
  const xs = [100, 200, 300, 400, 500, 600, 700, 800, 900]
  need(shared.percentile(xs, 95) === 900 && shared.percentile(xs, 50) === 500, `实际 p95=${shared.percentile(xs, 95)} p50=${shared.percentile(xs, 50)}`)
  need(shared.percentile([1, 2, 3, 4], 50) === 2, 'n=4 的 p50 应取第 2 个')
})

console.log()
if (failed === 0) {
  console.log(green(`  ✓ ${passed} 条断言全部通过`))
  console.log(
    dim(
      '\n  最该记住的六条：\n' +
        '    A   一帧过阈值不算开口；说完时刻是最后一个有声帧，不是判定时刻\n' +
        '    B   语义模型只把等待从 min 延长到 max；等 final 转写；复说就取消\n' +
        '    C   投机要四样都对上；去标点别用 \\w\n' +
        '    D   历史截到已播放：不是已生成，不是已发送；打断后旧 epoch 的块作废\n' +
        '    F   中文句号后面没有空格；「.」要前瞻；首段为延迟、后续段为韵律\n' +
        '    G   填充语等的是连续空闲；口头确认只来自已验证的状态\n',
    ),
  )
  process.exit(0)
}
console.log(red(`  ✗ ${failed} 失败 / ${passed} 通过`))
process.exit(1)
