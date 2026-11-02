/**
 * L16 的交付物：一个 agent 界面。
 *
 * ★★ 它**不是**一个聊天框，是一个**演示台**。
 *
 * 理由：这一节的结论几乎全都是「一个看起来正确的实现在什么情况下是错的」。
 * 这种结论没法靠"做一个好看的界面"讲明白——你得能把正确的那一半关掉，
 * 亲眼看见错的那一半长什么样。
 *
 * 所以界面上每一个开关都对应一条反转：
 *
 *   按协议撤回     关掉 → 变成一个只会 append 的前端（L02 欠条一）
 *   渲染速率       调到 15 cps → 亲手量打字机的代价（Tombaugh 1985）
 *   外链白名单     关掉 → 让那三个外链真的发出去（L14 / L15）
 *   按帧转发       关掉 → 让下游 JSON.parse 半个帧（L02 欠条二）
 *
 * 状态面板里的数字全部是可复现的，因为事件流是确定性的（见 stream.ts）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type Chunk,
  type UnknownChunk,
  type View,
  applyChunk,
  auditLinks,
  checkResumable,
  chopRelay,
  emptyView,
  visibleText,
} from '../../shared/wire.ts'
import { SCENARIOS, type Scenario, chop, toRawSse } from './stream.ts'

const ALLOWED_HOSTS = ['cdn.trusted.test']

/** 渲染速率档位。★ 这几档不是随便选的，见 Tombaugh 1985 的结论。 */
const RATES = [
  { id: 15, label: '15 cps', note: 'Tombaugh 里理解率最差的一档' },
  { id: 30, label: '30 cps', note: '理解率最高的两档之一' },
  { id: 60, label: '60 cps', note: '快于阅读速度，无额外收益' },
  { id: 0, label: '不节流', note: '到多少显多少，等价于「瞬间全显」' },
] as const

/**
 * 一个只会 append 的 reducer。★ 这是**故意写错**的版本。
 *
 * 它和正确版本的唯一区别：不认识 reset-step，于是把它当未知类型忽略掉。
 * 而「忽略未知类型」本身是对的（见 shared/wire.ts 里 UnknownChunk 的注释）——
 * 所以这个 bug 藏得很深：它不是「没处理未知类型」，是**没实现协议里有的那个类型**。
 */
function appendOnlyApply(v: View, c: Chunk | UnknownChunk): View {
  if (c.type === 'reset-step') return v
  if (c.type === 'max_tokens') return v
  return applyChunk(v, c as Chunk)
}

interface Metrics {
  /** 收到的字符数 */
  received: number
  /** 已显示的字符数 */
  shown: number
  /** 流结束的时刻（相对开始），null 表示还没结束 */
  streamDoneAt: number | null
  /** 显示追平的时刻 */
  displayDoneAt: number | null
  /** 状态更新次数。★ 这一栏就是 Anthropic 建议缓冲 token 的那个成本 */
  updates: number
}

export default function App() {
  const [scenarioId, setScenarioId] = useState(SCENARIOS[0]!.id)
  const [rate, setRate] = useState<number>(0)
  const [protocolRetract, setProtocolRetract] = useState(true)
  const [linkWhitelist, setLinkWhitelist] = useState(true)
  const [frameRelay, setFrameRelay] = useState(true)
  const [running, setRunning] = useState(false)

  const [view, setView] = useState<View>(emptyView())
  const [boundaries, setBoundaries] = useState<{ at: number; from: string; to: string }[]>([])
  const [metrics, setMetrics] = useState<Metrics>({
    received: 0,
    shown: 0,
    streamDoneAt: null,
    displayDoneAt: null,
    updates: 0,
  })

  const timers = useRef<number[]>([])
  const startedAt = useRef<number>(0)
  const rafId = useRef<number>(0)

  const scenario = useMemo(
    () => SCENARIOS.find((s) => s.id === scenarioId)!,
    [scenarioId],
  )

  const reset = useCallback(() => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
    cancelAnimationFrame(rafId.current)
    setView(emptyView())
    setBoundaries([])
    setMetrics({ received: 0, shown: 0, streamDoneAt: null, displayDoneAt: null, updates: 0 })
    setRunning(false)
  }, [])

  useEffect(() => reset(), [scenarioId, reset])

  const play = useCallback(() => {
    reset()
    setRunning(true)
    startedAt.current = performance.now()
    const reducer = protocolRetract ? applyChunk : appendOnlyApply

    for (const ev of scenario.script) {
      const t = window.setTimeout(() => {
        // 模型边界不是内容 chunk，单独记一条时间线。
        //
        // ★ 注意这里的分工：`model-boundary` 是 shared/wire.ts **不认识**的类型，
        // 协议层对它一视同仁地静默忽略（见 UnknownChunk 的注释）。
        // 而界面层想用它，就得自己**防御性地读字段**——不要 cast。
        // cast 只是让编译器闭嘴，不会让字段真的存在，而这些字段来自网络。
        if (ev.chunk.type === 'model-boundary') {
          const from = typeof ev.chunk.from === 'string' ? ev.chunk.from : '?'
          const to = typeof ev.chunk.to === 'string' ? ev.chunk.to : '?'
          setBoundaries((prev) => [...prev, { at: ev.at, from, to }])
          return
        }
        setView((prev) => reducer(prev, ev.chunk))
        setMetrics((m) => ({ ...m, updates: m.updates + 1 }))
      }, ev.at)
      timers.current.push(t)
    }

    const last = scenario.script[scenario.script.length - 1]!.at
    timers.current.push(
      window.setTimeout(() => {
        setMetrics((m) => ({ ...m, streamDoneAt: Math.round(performance.now() - startedAt.current) }))
        setRunning(false)
      }, last + 30),
    )
  }, [scenario, protocolRetract, reset])

  /** 用户点停止。★ 走的是一个 abort chunk，而不是直接改 status。 */
  const stop = useCallback(() => {
    // ★ 先清掉还没触发的定时器——但**已经在路上**的那些 chunk 仍然会到，
    // 这正是「abort 必须是终态」的理由。为了让这件事可见，这里故意让
    // 接下来 400ms 内的 chunk 继续投递。
    const now = performance.now() - startedAt.current
    for (let i = 0; i < timers.current.length; i++) {
      const at = scenario.script[i]?.at
      if (at !== undefined && at > now + 400) clearTimeout(timers.current[i]!)
    }
    setView((prev) => applyChunk(prev, { type: 'abort', reason: '用户点了停止' }))
    setMetrics((m) => ({ ...m, streamDoneAt: Math.round(now) }))
    setRunning(false)
  }, [scenario])

  const fullText = visibleText(view)

  // ── 打字机：按速率推进"已显示"的字符数
  useEffect(() => {
    if (rate === 0) {
      setMetrics((m) => (m.shown === fullText.length ? m : { ...m, shown: fullText.length }))
      return
    }
    const tick = () => {
      const elapsed = performance.now() - startedAt.current
      const allowed = Math.floor((elapsed / 1000) * rate)
      setMetrics((m) => {
        const shown = Math.min(fullText.length, allowed)
        if (shown === m.shown) return m
        const done =
          shown === fullText.length && m.streamDoneAt !== null && m.displayDoneAt === null
            ? Math.round(elapsed)
            : m.displayDoneAt
        // ★ 每推进一次就是一次状态更新，也就是一次重渲染。
        // 这一栏会在 15 cps 上涨到接近字符数——那正是官方建议先缓冲的理由。
        return { ...m, shown, displayDoneAt: done, updates: m.updates + 1 }
      })
      rafId.current = requestAnimationFrame(tick)
    }
    rafId.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId.current)
  }, [rate, fullText.length])

  useEffect(() => {
    setMetrics((m) => (m.received === fullText.length ? m : { ...m, received: fullText.length }))
  }, [fullText.length])

  const shownText = rate === 0 ? fullText : fullText.slice(0, metrics.shown)

  // ── 外链审计。★ 在**渲染之前**做，而不是渲染之后。
  const audit = useMemo(() => auditLinks(fullText, ALLOWED_HOSTS), [fullText])
  // ★ 这个渲染器真的会请求哪几条。和 audit.found 的差集就是「审计比渲染器宽」的那部分。
  const requested = useMemo(() => wouldRequest(fullText), [fullText])
  const resume = useMemo(() => checkResumable(view), [view])

  // ── 转发演示：把原始字节按固定大小切块，看两种下游的结果
  const relayStat = useMemo(() => {
    const raw = toRawSse(scenario)
    const chunks = chop(raw, 37) // 37 是个质数，保证块边界和帧边界不对齐
    return chopRelay(chunks, frameRelay)
  }, [scenario, frameRelay])

  const waste =
    metrics.streamDoneAt !== null && metrics.displayDoneAt !== null
      ? metrics.displayDoneAt - metrics.streamDoneAt
      : metrics.streamDoneAt !== null && metrics.shown < metrics.received
        ? Math.round(performance.now() - startedAt.current) - metrics.streamDoneAt
        : 0

  return (
    <div className="app">
      <header>
        <h1>
          L16 · agent 前端演示台
          <small>每个开关对应一条反转。事件流是确定性的，一次模型都不调。</small>
        </h1>
      </header>

      <div className="controls">
        <fieldset>
          <legend>场景</legend>
          {SCENARIOS.map((s) => (
            <label key={s.id} className="radio">
              <input
                type="radio"
                name="scenario"
                checked={scenarioId === s.id}
                onChange={() => setScenarioId(s.id)}
              />
              {s.title}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>渲染速率</legend>
          {RATES.map((r) => (
            <label key={r.id} className="radio" title={r.note}>
              <input
                type="radio"
                name="rate"
                checked={rate === r.id}
                onChange={() => setRate(r.id)}
              />
              {r.label}
            </label>
          ))}
        </fieldset>

        <fieldset>
          <legend>把正确的那一半关掉</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={protocolRetract}
              onChange={(e) => setProtocolRetract(e.target.checked)}
            />
            按协议撤回（reset-step）
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={linkWhitelist}
              onChange={(e) => setLinkWhitelist(e.target.checked)}
            />
            外链白名单
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={frameRelay}
              onChange={(e) => setFrameRelay(e.target.checked)}
            />
            按帧转发
          </label>
        </fieldset>

        <div className="actions">
          <button type="button" onClick={play} disabled={running}>
            ▶ 播放
          </button>
          <button type="button" onClick={stop} disabled={!running}>
            ■ 停止
          </button>
          <button type="button" onClick={reset}>
            ↺ 重置
          </button>
        </div>
      </div>

      <p className="teaches">{scenario.teaches}</p>

      <div className="split">
        <section className="transcript">
          <h2>渲染结果</h2>
          {/*
            ★ 无障碍：这三个属性的组合是这一节唯一能写成断言的体验要求。
              aria-live="polite"  不用 assertive——它会清空朗读队列
              aria-busy           流式期间为 true，让辅助技术把批量更新合并成一次朗读
            ★ 而且 live region 必须**先渲染成空的**再改内容。如果连容器一起插入，
              屏幕阅读器不会播报——这是 WCAG 的明确要求。所以这个 div 永远在。
          */}
          <div className="bubble" aria-live="polite" aria-busy={running}>
            {view.parts.length === 0 && !running && <span className="hint">点「播放」开始</span>}

            {renderBody(shownText, linkWhitelist, ALLOWED_HOSTS)}

            {view.parts
              .filter((p) => p.kind === 'tool')
              .map((p) => (
                <ToolCard key={p.id} name={p.toolName ?? ''} raw={p.text} state={p.args ?? 'streaming'} />
              ))}

            {boundaries.map((b) => (
              <div key={b.at} className="boundary">
                ⤳ 模型边界：这之后由 <code>{b.to}</code> 接着写（之前是 <code>{b.from}</code>）
                <small>标记是一个零 delta 的空块。假设「每块至少一个 delta」的解析器会把它当成空工具调用。</small>
              </div>
            ))}

            {view.status === 'aborted' && (
              <div className="badge aborted">已停止 · {view.reason}</div>
            )}
            {view.status === 'failed' && <div className="badge failed">失败 · {view.reason}</div>}
            {view.reason === 'max_tokens 在参数中途截断' && (
              <div className="badge trunc">
                max_tokens 截断 · HTTP 200、无错误事件
                <small>正确动作是提高 max_tokens 重试，不是修补那半个参数。</small>
              </div>
            )}
          </div>
        </section>

        <aside className="panel">
          <h2>状态面板</h2>

          <dl>
            <dt>收到字符</dt>
            <dd>{metrics.received}</dd>
            <dt>已显示</dt>
            <dd className={metrics.shown < metrics.received ? 'lag' : ''}>{metrics.shown}</dd>
            <dt>流结束</dt>
            <dd>{metrics.streamDoneAt === null ? '—' : `${(metrics.streamDoneAt / 1000).toFixed(1)}s`}</dd>
            <dt title="内容已经到手，打字机还让用户接着等的时间">白等</dt>
            <dd className={waste > 0 ? 'bad' : 'good'}>
              {waste > 0 ? `+${(waste / 1000).toFixed(1)}s` : '0s'}
            </dd>
            <dt title="Anthropic 官方建议渲染前先缓冲几个 token，理由就是这一栏">状态更新</dt>
            <dd>{metrics.updates}</dd>
            <dt title="正常运行里这一栏应该是 0">撤回的 part</dt>
            <dd className={view.retracted > 0 ? 'bad' : 'good'}>{view.retracted}</dd>
          </dl>

          <h3>外链审计</h3>
          <p className="sub">
            在<em>渲染之前</em>扫，而不是之后。关键在于渲染即发送——不需要用户点击。
          </p>
          {audit.found.length === 0 ? (
            <p className="ok">这段输出里没有外部资源。</p>
          ) : (
            <ul className="links">
              {audit.found.map((u) => (
                <li key={u} className={audit.offending.includes(u) ? 'blocked' : 'allowed'}>
                  <code>{u.length > 44 ? `${u.slice(0, 44)}…` : u}</code>
                  <span>{audit.offending.includes(u) ? (linkWhitelist ? '已拦' : '已放行') : '白名单内'}</span>
                  {/*
                    ★★ 「审计抓到」和「这个渲染器真的会请求」是两件事。
                    参考式的外链 auditLinks 抓得到，但这个渲染器不解析它，
                    所以它不会发请求。不把这个落差显示出来的话，看到
                    「3 条已放行」会以为发了 3 个请求，其实是 2 个。
                  */}
                  <small className={requested.includes(u) ? 'fires' : 'inert'}>
                    {requested.includes(u) ? '这个渲染器会发请求' : '这个渲染器不解析这种写法'}
                  </small>
                </li>
              ))}
            </ul>
          )}
          {!linkWhitelist && audit.offending.length > 0 && (
            <p className="warn">
              白名单已关。打开 devtools 的 Network：标着「会发请求」的那{' '}
              {audit.offending.filter((u) => requested.includes(u)).length} 条真的发出去了，
              而界面上它们什么都不显示。
              {audit.offending.some((u) => !requested.includes(u)) && (
                <>
                  {' '}剩下的是参考式写法，这个渲染器不解析，所以这次没发——
                  但换一个完整的 markdown 库就会发。<em>审计的覆盖面必须大于渲染器的覆盖面。</em>
                </>
              )}
            </p>
          )}

          <h3>能不能接续</h3>
          <p className={resume.safeUpTo >= 0 ? 'sub' : 'warn'}>{resume.reason}</p>
          <p className="sub">
            可安全回传到第 {resume.safeUpTo} 个 part（-1 表示一个都不能带）。
          </p>

          <h3>转发（按 37 字节切块）</h3>
          <dl>
            <dt>输出块数</dt>
            <dd>{relayStat.emitted}</dd>
            <dt>下游能解析出</dt>
            <dd className={relayStat.naiveOk ? 'good' : 'bad'}>
              {relayStat.naiveEvents} / {relayStat.wantEvents} 个事件
            </dd>
            <dt>下游崩溃</dt>
            <dd className={relayStat.naiveCrashes === 0 ? 'good' : 'bad'}>
              {relayStat.naiveCrashes} 次
            </dd>
            <dt>字节一致</dt>
            <dd className={relayStat.bytewise ? 'good' : 'bad'}>
              {relayStat.bytewise ? '是' : '否'}
            </dd>
          </dl>
          <p className="sub">
            {frameRelay
              ? '按帧转发：只把不完整的尾巴留在手上，所以下游即使每块直接 parse 也不会崩。'
              : '原样转发：块边界和帧边界无关，下游拿到半个帧。这正是 Anthropic SDK 修过的那个 bug。'}
          </p>
        </aside>
      </div>
    </div>
  )
}

/**
 * 工具调用卡片。★ 关键是**四个状态**，以及 snapshot 和 canExecute 的区别。
 *
 * streaming 时 snapshot 照样显示出来（官方 SDK 就是这么设计的），
 * 但「执行」按钮是禁用的——审批必须卡在 canExecute 上，不能卡在 snapshot 上。
 */
function ToolCard({ name, raw, state }: { name: string; raw: string; state: string }) {
  const label: Record<string, string> = {
    streaming: '参数流入中',
    ready: '参数完整',
    invalid: '参数非法',
    truncated: '被 max_tokens 截断',
  }
  const canExecute = state === 'ready'
  return (
    <details className={`tool ${state}`} open>
      <summary>
        <code>{name || '（空）'}</code>
        <span className="state">{label[state] ?? state}</span>
      </summary>
      <pre>{raw || '（还没有参数）'}</pre>
      <div className="tool-actions">
        <button type="button" disabled={!canExecute}>
          {canExecute ? '允许执行' : '不可执行'}
        </button>
        <small>
          {state === 'streaming' && 'snapshot 可以展示，但执行的唯一安全点是 content_block_stop。'}
          {state === 'truncated' && '正确动作是提高 max_tokens 重试，不是修补。'}
          {state === 'invalid' && '包成 {"INVALID_JSON": …} 回传给模型，用 JSON 库构造。'}
          {state === 'ready' && '参数已完整，现在给用户看的和要执行的是同一个东西。'}
        </small>
      </div>
    </details>
  )
}

/**
 * 极简的正文渲染。
 *
 * ★ 这里**故意不引入 markdown 库**，因为这一节要讲的恰好是「渲染不可信内容」，
 * 而一个现成的库会把这件事藏起来。这里只处理两种东西：段落，和图片。
 *
 * ★ 图片的处理才是重点：白名单开着时**根本不生成 img 元素**，只显示一个
 * 被拦下来的痕迹。不是渲染出来再隐藏——那样请求已经发出去了。
 */

/**
 * 这个渲染器认得的图片写法。★ 只有两种：内联式和内联 HTML。
 *
 * ★★ 它**故意**比 auditLinks 窄。auditLinks 还抓参考式（`![x][ref]` + `[ref]: url`），
 * 而这里不认——所以参考式的外链在这个渲染器里是惰性的，不会发请求。
 *
 * 这个落差本身就是这一节的一个论点：**审计的覆盖面必须大于渲染器的覆盖面。**
 * 如果你的审计只覆盖「当前这个渲染器恰好会解析的写法」，那么哪天有人把它换成
 * 一个完整的 markdown 库，参考式的链接就开始发请求了，而审计从头到尾不知情。
 *
 * 状态面板里那一栏把「审计抓到」和「这个渲染器真的会请求」分开显示，就是为了
 * 让这个落差可见——否则看到「3 条已放行」很容易以为发了 3 个请求，其实是 2 个。
 */
const IMG = /!\[[^\]]*\]\(\s*([^)\s]+)\s*\)|<img[^>]+src\s*=\s*["']?([^"'\s>]+)[^>]*>/g

/** 这个渲染器真的会为哪些 URL 造出 img 元素（也就是真的会发请求的那些）。 */
function wouldRequest(text: string): string[] {
  return [...text.matchAll(IMG)].map((m) => m[1] ?? m[2] ?? '')
}
function renderBody(text: string, whitelist: boolean, allowed: string[]) {
  const out: React.ReactNode[] = []
  let last = 0
  let key = 0

  for (const m of text.matchAll(IMG)) {
    const url = m[1] ?? m[2] ?? ''
    if (m.index > last) out.push(<span key={key++}>{text.slice(last, m.index)}</span>)
    const bad = auditLinks(m[0], allowed).offending.length > 0
    if (bad && whitelist) {
      out.push(
        <span key={key++} className="blocked-img" title={url}>
          🚫 外链已拦
        </span>,
      )
    } else {
      // eslint-disable-next-line jsx-a11y/alt-text
      out.push(<img key={key++} src={url} alt="" className="loaded-img" />)
    }
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>)
  return <div className="body">{out}</div>
}
