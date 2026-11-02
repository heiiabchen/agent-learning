/**
 * L16y 参考实现：语音 agent 的时间账。
 *
 * L16 管的是「屏幕上画了什么」，这里管的是「用户听到了什么」。
 * 语音只有一条串行的音频通道，用户和 agent 轮流用它；所有的难题都是时间问题：
 *
 *   A. VAD 四态滞回：一帧过阈值不算开口，一小段静音不算说完
 *   B. 端点：语义模型只能把等待从 min 延长到 max，从不缩短
 *   C. 投机生成：提交时的四元组和投机时一致，才能直接用
 *   D. 播放账本：生成 ≠ 发送 ≠ 播放；打断时历史截到用户听到的位置
 *   E. 打断判定：持续够久才算打断；打断后迟迟没有转写就恢复
 *   F. 中英文流式分句：中文句号后面没有空格
 *   G. 填充语：连续空闲满 delay 才说，不是「工具开始后 delay 毫秒」
 *   H. 任务板：口头更新只能来自已验证的状态；改了需求，旧结果作废
 *   I. 延迟账：同一个话轮，四种「首音延迟」
 *
 * ★ 时间全是注入的整数毫秒；输入全是合成的（20ms 一帧的 VAD 概率、带时间戳的 token、
 * TTS 块的文本和时长）。没有音频、不调模型。
 * ★ 跨语言字节一致：不用 \w \d \s，长度一律按码点，去空白只去 ASCII 空格。
 */

export type Ms = number

export const FRAME_MS = 20

function cpLen(s: string): number {
  return Array.from(s).length
}

function trimSpaces(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && s[a] === ' ') a++
  while (b > a && s[b - 1] === ' ') b--
  return s.slice(a, b)
}

// ─────────────────────────────────────────────────────────────
// A. VAD 四态滞回
// ─────────────────────────────────────────────────────────────

export type VadState = 'quiet' | 'starting' | 'speaking' | 'stopping'

export interface VadParams {
  /** p ≥ threshold 的帧算有声。 */
  threshold: number
  /** 连续有声满这么久才进 speaking。 */
  startMs: Ms
  /** 连续无声满这么久才回 quiet。 */
  stopMs: Ms
}

/** Pipecat VADParams 的默认值：confidence 0.7、start 0.2s、stop 0.2s。 */
export const VAD_DEFAULTS: VadParams = { threshold: 0.7, startMs: 200, stopMs: 200 }

export interface VadMachine {
  state: VadState
  /** 当前这段有声 / 无声从什么时刻开始。 */
  since: Ms
  /** 最后一个有声帧的时刻。 */
  lastSpeechAt: Ms | null
}

export const VAD_INIT: VadMachine = { state: 'quiet', since: 0, lastSpeechAt: null }

export interface VadEvent {
  kind: 'speech_start' | 'speech_end'
  /** 判定发生的时刻。 */
  t: Ms
  /** 最后一个有声帧的时刻。speech_end 的「用户什么时候说完」要用它，不是 t。 */
  lastSpeechAt: Ms
}

/** 一帧：t 是这一帧结束的时刻，覆盖 (t − FRAME_MS, t]。 */
export interface VadFrame {
  t: Ms
  p: number
}

/**
 * 喂一帧，返回新状态和可能的事件。
 *
 *   quiet    ──有声──▶ starting（since = 这段有声的起点）
 *   starting ──有声且已满 startMs──▶ speaking，发 speech_start
 *   starting ──无声──▶ quiet（计时清零）
 *   speaking ──无声──▶ stopping（since = 最后一个有声帧）
 *   stopping ──有声──▶ speaking（不发事件：这只是一次停顿）
 *   stopping ──无声且已满 stopMs──▶ quiet，发 speech_end
 *
 * ★ 单帧尖峰不是开口；160ms 的换气不是说完。
 * ★ speech_end.lastSpeechAt 是最后一个有声帧，不是判定时刻——两者差了整整 stopMs。
 */
export function vadStep(m: VadMachine, f: VadFrame, p: VadParams): [VadMachine, VadEvent | null] {
  const voiced = f.p >= p.threshold
  const last = voiced ? f.t : m.lastSpeechAt
  switch (m.state) {
    case 'quiet':
    case 'starting': {
      if (!voiced) return [{ state: 'quiet', since: f.t, lastSpeechAt: m.lastSpeechAt }, null]
      const since = m.state === 'quiet' ? f.t - FRAME_MS : m.since
      if (f.t - since >= p.startMs) {
        return [{ state: 'speaking', since, lastSpeechAt: f.t }, { kind: 'speech_start', t: f.t, lastSpeechAt: f.t }]
      }
      return [{ state: 'starting', since, lastSpeechAt: last }, null]
    }
    case 'speaking':
    case 'stopping': {
      if (voiced) return [{ state: 'speaking', since: m.state === 'speaking' ? m.since : f.t, lastSpeechAt: f.t }, null]
      const since = m.state === 'speaking' ? (m.lastSpeechAt ?? f.t - FRAME_MS) : m.since
      if (f.t - since >= p.stopMs) {
        return [{ state: 'quiet', since: f.t, lastSpeechAt: last }, { kind: 'speech_end', t: f.t, lastSpeechAt: last ?? since }]
      }
      return [{ state: 'stopping', since, lastSpeechAt: last }, null]
    }
  }
}

export function runVad(frames: VadFrame[], p: VadParams = VAD_DEFAULTS): VadEvent[] {
  let m = VAD_INIT
  const out: VadEvent[] = []
  for (const f of frames) {
    const [next, ev] = vadStep(m, f, p)
    m = next
    if (ev) out.push(ev)
  }
  return out
}

// ─────────────────────────────────────────────────────────────
// B. 端点
// ─────────────────────────────────────────────────────────────

export interface EndpointParams {
  minDelayMs: Ms
  maxDelayMs: Ms
  /** 「说完了」的概率低于它，才把等待延长到 max。按语种不同。 */
  unlikelyThreshold: number
}

/** LiveKit 默认 min 0.5s / max 3.0s；多语种话轮模型的中文、英文阈值。 */
export const ENDPOINT_ZH: EndpointParams = { minDelayMs: 500, maxDelayMs: 3000, unlikelyThreshold: 0.0066 }
export const ENDPOINT_EN: EndpointParams = { minDelayMs: 500, maxDelayMs: 3000, unlikelyThreshold: 0.011 }

/**
 * ★ 模型从不让等待短于 min：概率高就用 min，概率低于阈值就用 max。
 * 「上了语义话轮模型响应更快」是错的——它买的是少截断，速度要靠投机生成。
 */
export function endpointDelay(eouProb: number, p: EndpointParams): Ms {
  return eouProb < p.unlikelyThreshold ? p.maxDelayMs : p.minDelayMs
}

/**
 * 话轮在什么时刻提交；不提交返回 null。
 *   commitAt = max(lastSpeechAt + endpointDelay, sttFinalAt)
 *   还没有任何 final 转写 → 不提交
 *   commitAt 之前用户又开口 → 不提交（那只是一次停顿）
 */
export function commitTurn(
  lastSpeechAt: Ms,
  eouProb: number,
  sttFinalAt: Ms | null,
  nextSpeechStart: Ms | null,
  p: EndpointParams,
): Ms | null {
  if (sttFinalAt === null) return null
  const wait = lastSpeechAt + endpointDelay(eouProb, p)
  const commitAt = wait > sttFinalAt ? wait : sttFinalAt
  if (nextSpeechStart !== null && nextSpeechStart < commitAt) return null
  return commitAt
}

// ─────────────────────────────────────────────────────────────
// C. 投机生成
// ─────────────────────────────────────────────────────────────

export interface SpecKey {
  transcript: string
  ctxVersion: number
  toolsVersion: number
  toolChoice: string
}

const PUNCT = new Set(Array.from('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~，。、；：？！“”‘’「」『』（）《》【】…—～·'))

/**
 * ASCII 字母转小写；去掉中英文标点；连续空白压成一个空格；去首尾空格。
 * ★ 不能用 \w 去标点：TS 的 \w 不认汉字，一删就把整句中文删光了；Python 的 \w 认。
 */
export function normalizeTranscript(s: string): string {
  let out = ''
  for (const c of Array.from(s)) {
    if (PUNCT.has(c)) continue
    if (c === '\t' || c === '\n' || c === '\r') out += ' '
    else if (c >= 'A' && c <= 'Z') out += String.fromCharCode(c.charCodeAt(0) + 32)
    else out += c
  }
  return trimSpaces(out.replace(/ +/g, ' '))
}

/**
 * 投机生成能不能直接用：转写（归一化后）、上下文版本、工具版本、tool_choice 四样都没变。
 * ★ 只比转写不够：话轮等待期间工具列表或上下文变了，投机出来的回答是基于旧世界的。
 */
export function speculationValid(spec: SpecKey, committed: SpecKey): boolean {
  return (
    normalizeTranscript(spec.transcript) === normalizeTranscript(committed.transcript) &&
    spec.ctxVersion === committed.ctxVersion &&
    spec.toolsVersion === committed.toolsVersion &&
    spec.toolChoice === committed.toolChoice
  )
}

// ─────────────────────────────────────────────────────────────
// D. 播放账本
// ─────────────────────────────────────────────────────────────

export interface TtsChunk {
  epoch: number
  itemId: string
  text: string
  ms: Ms
}

export interface Truncation {
  itemId: string
  /** 这个 item 实际播放到的位置（item 内的毫秒）。OpenAI truncate 的 audio_end_ms。 */
  audioEndMs: Ms
  /** 用户听到的文字。 */
  heardText: string
  /** 一帧都没播：整条 assistant 消息从历史里拿掉。 */
  dropItem: boolean
}

/**
 * 已播放 playedMs 毫秒时，用户听到的文字：整块照收，当前块按码点比例向下取整。
 * ★ 按码点切，不按 UTF-16：「好😀好」播一半是「好」，不是「好」加半个 emoji。
 */
export function heardText(chunks: TtsChunk[], playedMs: Ms): string {
  let left = playedMs
  let out = ''
  for (const c of chunks) {
    if (left <= 0) break
    if (left >= c.ms) {
      out += c.text
      left -= c.ms
      continue
    }
    const cps = Array.from(c.text)
    out += cps.slice(0, Math.floor((cps.length * left) / c.ms)).join('')
    break
  }
  return out
}

interface Scheduled {
  chunk: TtsChunk
  start: Ms
}

/**
 * 单通道串行播放：每块从 max(入队时刻, 上一块播完) 开始播。
 * 服务端生成比实时快，所以入队可以远早于播放——账本只认播放。
 */
export class PlaybackLedger {
  epoch = 0
  protected scheduled: Scheduled[] = []
  protected freeAt: Ms = 0

  /** 旧 epoch 的块（打断之后才到的 TTS）直接丢弃。 */
  enqueue(c: TtsChunk, t: Ms): 'queued' | 'stale' {
    if (c.epoch < this.epoch) return 'stale'
    const start = t > this.freeAt ? t : this.freeAt
    this.scheduled.push({ chunk: c, start })
    this.freeAt = start + c.ms
    return 'queued'
  }

  /** 当前 epoch 到时刻 t 为止一共播了多少毫秒。 */
  playedMsAt(t: Ms): Ms {
    let n = 0
    for (const s of this.scheduled) n += Math.max(0, Math.min(s.chunk.ms, t - s.start))
    return n
  }

  /** 时刻 t 还有没播完的音频吗。 */
  speakingAt(t: Ms): boolean {
    return this.scheduled.length > 0 && t < this.freeAt
  }

  /**
   * 用户在时刻 t 打断。没有在播或待播的音频 → null。
   * 否则：找到 t 时正在播（或排在最前、还没开始播）的那个 item，算它播到了哪里，
   * epoch + 1，清空队列，通道从 t 起空闲。
   *
   * ★ audioEndMs 是已播放，不是已生成、也不是已发送；它不会超过这个 item 已入队的总时长。
   * ★ 一帧没播 → dropItem。
   */
  bargeIn(t: Ms): Truncation | null {
    if (!this.speakingAt(t)) return null
    let current = this.scheduled.find((s) => t < s.start + s.chunk.ms)!
    for (const s of this.scheduled) if (s.start <= t && t < s.start + s.chunk.ms) current = s
    const itemId = current.chunk.itemId
    const mine = this.scheduled.filter((s) => s.chunk.itemId === itemId)
    let played = 0
    for (const s of mine) played += Math.max(0, Math.min(s.chunk.ms, t - s.start))
    const trunc: Truncation = {
      itemId,
      audioEndMs: played,
      heardText: heardText(mine.map((s) => s.chunk), played),
      dropItem: played === 0,
    }
    this.epoch++
    this.scheduled = []
    this.freeAt = t
    return trunc
  }
}

// ─────────────────────────────────────────────────────────────
// E. 打断判定
// ─────────────────────────────────────────────────────────────

export interface BargeInParams {
  /** 用户的声音持续这么久才算打断。 */
  minDurationMs: Ms
  /** 用户停下后这么久仍没有任何转写，就当误打断，接着说。 */
  falseInterruptionTimeoutMs: Ms
}

/** LiveKit：min_duration 0.5s；resume_false_interruption 开，2.0s 无转写则恢复。 */
export const BARGE_IN_DEFAULTS: BargeInParams = { minDurationMs: 500, falseInterruptionTimeoutMs: 2000 }

export type BargeInVerdict = 'ignore' | 'interrupt' | 'resume'

/**
 *   agent 没在说话           → ignore（这是话轮开始，不是打断）
 *   持续 < minDurationMs     → ignore（回声尖峰、咳嗽、「嗯」）
 *   停下后 timeout 内有转写   → interrupt
 *   否则                     → resume（agent 已经停了，再接着说）
 * resume 不是没事：用户听到了一次卡顿。
 */
export function judgeBargeIn(
  userSpeech: { start: Ms; end: Ms },
  agentSpeaking: boolean,
  firstTranscriptAt: Ms | null,
  p: BargeInParams = BARGE_IN_DEFAULTS,
): BargeInVerdict {
  if (!agentSpeaking) return 'ignore'
  if (userSpeech.end - userSpeech.start < p.minDurationMs) return 'ignore'
  if (firstTranscriptAt !== null && firstTranscriptAt <= userSpeech.end + p.falseInterruptionTimeoutMs) return 'interrupt'
  return 'resume'
}

// ─────────────────────────────────────────────────────────────
// F. 中英文流式分句
// ─────────────────────────────────────────────────────────────

export interface Tok {
  t: Ms
  text: string
}

export interface Seg {
  t: Ms
  text: string
}

export function isCJK(c: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(c)
}

function isCJKPunct(c: string): boolean {
  return /[\u3000-\u303f\uff00-\uffef\u201c\u201d\u2018\u2019]/.test(c)
}

/** 语音单位：一个汉字算 1，一串连续的 ASCII 字母数字算 1。按字符数定阈值，中文和英文不等价。 */
export function speechUnits(s: string): number {
  let n = 0
  let inRun = false
  for (const c of Array.from(s)) {
    if (isCJK(c)) {
      n++
      inRun = false
    } else if (/[A-Za-z0-9]/.test(c)) {
      if (!inRun) n++
      inRun = true
    } else inRun = false
  }
  return n
}

/**
 * 合成 token 流：每个汉字 / 全角标点一个 token，ASCII 连续串（含前导空格）一个 token；
 * 第 i 个 token 在 t0 + i·dt 到达。只给观察实验和 verify 造输入。
 */
export function synthTokens(text: string, t0: Ms = 300, dt: Ms = 30): Tok[] {
  const out: string[] = []
  const cs = Array.from(text)
  let i = 0
  while (i < cs.length) {
    const c = cs[i]!
    if (isCJK(c) || isCJKPunct(c)) {
      out.push(c)
      i++
      continue
    }
    let j = i
    let w = ''
    while (j < cs.length && cs[j] === ' ') w += cs[j++]
    while (j < cs.length && cs[j] !== ' ' && !isCJK(cs[j]!) && !isCJKPunct(cs[j]!)) w += cs[j++]
    if (w === '') w = cs[j++]!
    out.push(w)
    i = j
  }
  return out.map((s, k) => ({ t: t0 + k * dt, text: s }))
}

export const HARD_CJK = '。！？；'
export const HARD_ASCII = '!?;'
export const CLOSERS = '”’」』）)"'
export const SOFT = '，,、：:'
export const ABBR = ['Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'St', 'vs', 'e.g', 'i.e', 'p.m', 'a.m', 'etc']
export const FIRST_MIN_UNITS = 4
export const LATER_MIN_UNITS = 8

/**
 * 流式分句：token 一个个到，攒够一句就交给 TTS。endAt 是流结束的时刻，剩下的在那时冲出去。
 *
 *   中文句末（。！？；）和 ! ? ; 无歧义，但多等 1 个字符：后引号（”」』）要跟着这一句走
 *   「.」必须前瞻 1 个字符：下一个是空格或汉字、且前一个词不是缩写，才是句号
 *     （39.9、1.2.3、example.com、Dr. Wang、3 p.m. 都不切）
 *   第一段可以在逗号处切（够 FIRST_MIN_UNITS 个语音单位）：首段为延迟服务
 *   后续段至少 LATER_MIN_UNITS 个单位、不在逗号处切：后续段为韵律服务
 *
 * ★ 分句只决定在哪切，不改字符：段与段之间只丢掉切点处的空格。
 * ★ 「标点后跟空白」这条英文规则在中文上永远不触发——中文句号后面没有空格。
 */
export function splitStream(tokens: Tok[], endAt: Ms): Seg[] {
  const segs: Seg[] = []
  let buf: string[] = []
  let pendingDot = false
  let pendingCloser = false
  const cutAt = (k: number, t: Ms) => {
    const text = trimSpaces(buf.slice(0, k).join(''))
    buf = buf.slice(k)
    while (buf.length && buf[0] === ' ') buf.shift()
    if (text) segs.push({ t, text })
  }
  const enough = (k: number) => speechUnits(buf.slice(0, k).join('')) >= (segs.length === 0 ? FIRST_MIN_UNITS : LATER_MIN_UNITS)
  for (const tk of tokens) {
    for (const c of Array.from(tk.text)) {
      if (pendingCloser) {
        if (CLOSERS.includes(c)) {
          buf.push(c)
          continue
        }
        pendingCloser = false
        if (enough(buf.length)) cutAt(buf.length, tk.t)
      }
      if (pendingDot) {
        pendingDot = false
        const k = buf.length
        const m = buf.slice(0, k - 1).join('').match(/([A-Za-z.]+)$/)
        const prevWord = m ? m[1]! : ''
        const isAbbr = ABBR.includes(prevWord) || /^[A-Za-z]$/.test(prevWord)
        if ((c === ' ' || isCJK(c)) && !isAbbr && enough(k)) cutAt(k, tk.t)
      }
      buf.push(c)
      if (HARD_CJK.includes(c) || HARD_ASCII.includes(c)) {
        pendingCloser = true
        continue
      }
      if (c === '.') {
        pendingDot = true
        continue
      }
      if (segs.length === 0 && SOFT.includes(c) && enough(buf.length)) cutAt(buf.length, tk.t)
    }
  }
  const rest = trimSpaces(buf.join(''))
  if (rest) segs.push({ t: endAt, text: rest })
  return segs
}

/** 对照组一：见到 .!?。！？ 立刻切。前端的第一版。 */
export function splitNaive(tokens: Tok[], endAt: Ms): Seg[] {
  const segs: Seg[] = []
  let buf = ''
  for (const tk of tokens) {
    for (const c of Array.from(tk.text)) {
      buf += c
      if ('.!?。！？'.includes(c)) {
        const text = trimSpaces(buf)
        if (text) segs.push({ t: tk.t, text })
        buf = ''
      }
    }
  }
  const rest = trimSpaces(buf)
  if (rest) segs.push({ t: endAt, text: rest })
  return segs
}

const PAPER_ABBR = ['Dr.', 'Mr.', 'PM.']

/**
 * 对照组二：arXiv 2603.05413 的四条规则——.!? 后跟空白才切、跳过缩写、
 * 至少 10 个字符、流结束时冲出。
 */
export function splitPaper(tokens: Tok[], endAt: Ms): Seg[] {
  const segs: Seg[] = []
  let buf = ''
  for (const tk of tokens) {
    for (const c of Array.from(tk.text)) {
      buf += c
      const cs = Array.from(buf)
      const n = cs.length
      if (n >= 2 && cs[n - 1] === ' ' && '.!?'.includes(cs[n - 2]!)) {
        const cand = trimSpaces(cs.slice(0, n - 1).join(''))
        const words = cand.split(/ +/)
        if (PAPER_ABBR.includes(words[words.length - 1]!)) continue
        if (cpLen(cand) < 10) continue
        segs.push({ t: tk.t, text: cand })
        buf = ''
      }
    }
  }
  const rest = trimSpaces(buf)
  if (rest) segs.push({ t: endAt, text: rest })
  return segs
}

/** 误切：切点前是「.」而原文紧接着既不是空格也不是汉字；或者切在 Dr. / Mr. / p.m. / a.m. 之后。 */
export function badSplits(src: string, segs: Seg[]): number {
  const cs = Array.from(src)
  let bad = 0
  let pos = 0
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = Array.from(segs[i]!.text)
    while (pos < cs.length && cs[pos] === ' ') pos++
    const end = pos + seg.length
    pos = end
    const prev = cs[end - 1]
    const next = cs[end] ?? ''
    const tail = cs.slice(Math.max(0, end - 4), end).join('')
    if (prev === '.' && next !== ' ' && next !== '' && !isCJK(next)) bad++
    else if (/(Dr|Mr|p\.m|a\.m)\.$/.test(tail)) bad++
  }
  return bad
}

// ─────────────────────────────────────────────────────────────
// G. 填充语
// ─────────────────────────────────────────────────────────────

export interface FillerParams {
  /** 连续空闲满这么久才说。LiveKit 默认 0。 */
  delayMs: Ms
  /** 说完一次后隔这么久（墙钟）再重新等空闲；null = 最多一次。 */
  intervalMs: Ms | null
  maxSteps: number | null
}

export interface Span {
  start: Ms
  end: Ms
}

/**
 * 工具在 [toolStart, toolEnd) 运行；busy 是这期间有人在说话的区间（左闭右开）；
 * 每次填充语本身要播 fillerMs，播放期间也算忙。返回每次触发的时刻。
 *
 * ★ 是「连续空闲」满 delayMs，不是「工具开始后 delayMs」：用户说话、agent 说话都会把等待清零。
 * ★ 工具结束了就不再触发（结果已经到了，该说答案了）。
 */
export function scheduleFillers(toolStart: Ms, toolEnd: Ms, busy: Span[], fillerMs: Ms, p: FillerParams): Ms[] {
  const spans = busy.slice().sort((a, b) => a.start - b.start)
  const fires: Ms[] = []
  let from = toolStart
  for (;;) {
    let idleStart = from
    let moved = true
    while (moved) {
      moved = false
      for (const s of spans) {
        if (s.start < idleStart + p.delayMs && s.end > idleStart) {
          idleStart = s.end
          moved = true
        }
      }
    }
    const f = idleStart + p.delayMs
    if (f >= toolEnd) break
    fires.push(f)
    if (p.intervalMs === null) break
    if (p.maxSteps !== null && fires.length >= p.maxSteps) break
    spans.push({ start: f, end: f + fillerMs })
    from = f + p.intervalMs
  }
  return fires
}

// ─────────────────────────────────────────────────────────────
// H. 任务板
// ─────────────────────────────────────────────────────────────

export type TaskState = 'working' | 'completed' | 'failed' | 'cancel_confirmed'

/**
 * 后台任务的已验证状态。用户每改一次需求 epoch + 1，旧 epoch 的结果回来一律作废。
 * 口头更新只能从 utterable() 取——不能从「已经发起了请求」说成「已经办好了」。
 * 话语打断不碰这里：「闭嘴」不等于「取消订单」。
 */
export class TaskBoard {
  protected tasks = new Map<string, { epoch: number; state: TaskState }>()

  start(id: string): number {
    this.tasks.set(id, { epoch: 1, state: 'working' })
    return 1
  }

  amend(id: string): number {
    const t = this.get(id)
    t.epoch++
    t.state = 'working'
    return t.epoch
  }

  result(id: string, epoch: number, ok: boolean): 'accepted' | 'stale' {
    const t = this.get(id)
    if (epoch !== t.epoch) return 'stale'
    t.state = ok ? 'completed' : 'failed'
    return 'accepted'
  }

  /** 后端确认取消成功之后才调这个；只说「我在取消」时状态仍是 working。 */
  cancelConfirmed(id: string, epoch: number): 'accepted' | 'stale' {
    const t = this.get(id)
    if (epoch !== t.epoch) return 'stale'
    t.state = 'cancel_confirmed'
    return 'accepted'
  }

  utterable(id: string): TaskState {
    return this.get(id).state
  }

  protected get(id: string) {
    const t = this.tasks.get(id)
    if (!t) throw new Error(`没有这个任务：${id}`)
    return t
  }
}

// ─────────────────────────────────────────────────────────────
// I. 延迟账
// ─────────────────────────────────────────────────────────────

export interface TurnTimeline {
  /** 用户实际说完的最后一个音（只有离线标注才知道）。 */
  userEndTrue: Ms
  /** VAD 判定的最后一个有声帧。 */
  vadLastSpeech: Ms
  /** 话轮提交。 */
  commitAt: Ms
  llmRequestAt: Ms
  /** 第一句攒够、交给 TTS。 */
  firstSegAt: Ms
  /** TTS 产出第一块音频（服务端）。 */
  ttsFirstChunkAt: Ms
  /** 服务端把第一帧推进传输层。 */
  serverFirstFrameAt: Ms
  /** 扬声器放出第一个非静音样本。 */
  firstAudibleAt: Ms
  /** 第一个有用的音（不是「我查一下」）。 */
  firstUsefulAt: Ms
}

export interface Ledger {
  /** 论文口径：话轮提交 → TTS 首块。不含话轮等待、STT、网络、播放。 */
  paperTtfa: Ms
  /** LiveKit e2e_latency：VAD 最后语音帧 → 服务端第一帧。含话轮等待，不含下行与播放。 */
  livekitE2e: Ms
  /** 用户感受到的死寂：实际说完 → 第一个可听见的音。 */
  deadAir: Ms
  /** 实际说完 → 第一个有用的音。OpenAI 要求和填充语分开测。 */
  usefulLatency: Ms
  /** VAD 最后语音帧 → 话轮提交。唯一一段纯在等的时间。 */
  endpointWait: Ms
}

export function ledger(t: TurnTimeline): Ledger {
  return {
    paperTtfa: t.ttsFirstChunkAt - t.commitAt,
    livekitE2e: t.serverFirstFrameAt - t.vadLastSpeech,
    deadAir: t.firstAudibleAt - t.userEndTrue,
    usefulLatency: t.firstUsefulAt - t.userEndTrue,
    endpointWait: t.commitAt - t.vadLastSpeech,
  }
}

/** nearest-rank 百分位：排序后取第 ceil(q·n/100) 个。q 是整数百分数。 */
export function percentile(xs: Ms[], q: number): Ms {
  if (xs.length === 0) throw new Error('空样本没有百分位')
  const sorted = xs.slice().sort((a, b) => a - b)
  const rank = Math.floor((q * sorted.length + 99) / 100)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!
}
