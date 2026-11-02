/**
 * 验证 l04/schema.ts 和 l04/toolbox.ts。跑法：pnpm verify:l04
 *
 * 一次 API 都不调，但**会在临时目录里建真实文件和真实符号链接**——
 * 因为符号链接逃逸没法用假数据测，它是文件系统层面的行为。
 *
 * 先跑 VERIFY_TARGET=shared 确认这套测试本身是对的。
 */
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const target = process.env.VERIFY_TARGET === 'shared' ? 'shared' : 'mine'

const S = target === 'shared' ? await import('../shared/tools.ts') : await import('./schema.ts')
const B = target === 'shared' ? await import('../shared/sandbox.ts') : await import('./toolbox.ts')
const T = target === 'shared' ? await import('../shared/toolbox.ts') : await import('./toolbox.ts')

console.log(target === 'shared' ? '\n（测的是 shared/ 里的参考实现）' : '\n（测的是 l04/ 里你的实现）')

let passed = 0
const failures: string[] = []

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`\x1b[32m  ✓\x1b[0m ${name}`)
  } catch (err) {
    failures.push(name)
    console.log(`\x1b[31m  ✕ ${name}\x1b[0m`)
    console.log(`\x1b[31m      ${(err as Error).message}\x1b[0m`)
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

function eq(actual: unknown, expected: unknown, hint = '') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(`期待 ${e}，实际 ${a}${hint ? `\n      ${hint}` : ''}`)
}

// ── 造一个真实的临时仓库 ─────────────────────────────────────────────────

const root = await mkdtemp(join(tmpdir(), 'l04-'))
const outside = await mkdtemp(join(tmpdir(), 'l04-outside-'))

await writeFile(join(outside, 'secret.txt'), 'TOP SECRET')
await mkdir(join(root, 'src'), { recursive: true })
await mkdir(join(root, 'node_modules', 'junk'), { recursive: true })
await writeFile(join(root, 'src', 'index.ts'), 'export const a = 1\nexport const b = 2\nconst c = 3\n')
await writeFile(join(root, 'src', 'big.txt'), '中'.repeat(60_000))
await writeFile(join(root, 'README.md'), '# hello\nsearchable needle here\n')
await writeFile(join(root, 'node_modules', 'junk', 'x.js'), 'needle in node_modules')
// 仓库内一个指向外面的符号链接。路径字符串看起来完全正常。
await symlink(join(outside, 'secret.txt'), join(root, 'src', 'escape.txt')).catch(() => {})

// ── requireString ───────────────────────────────────────────────────────

console.log('\nrequireString')

await test('正常字符串', () => {
  const r = S.requireString({ path: 'a.ts' }, 'path')
  assert(r.ok, '应该通过')
  eq(r.value, 'a.ts')
})

await test('字段缺失', () => {
  const r = S.requireString({}, 'path')
  assert(!r.ok, '应该失败')
  assert(r.message.includes('path'), `错误信息里要提到字段名，实际：${r.message}`)
})

await test('★ 值是数字而不是字符串', () => {
  const r = S.requireString({ path: 42 }, 'path')
  assert(!r.ok, '模型真的会传数字。直接 input.path 往下走，会在某个 fs 调用里炸，离原因很远。')
})

await test('★ raw 压根不是对象', () => {
  for (const bad of [null, undefined, 'string', 42, []]) {
    const r = S.requireString(bad, 'path')
    assert(!r.ok, `raw = ${JSON.stringify(bad)} 时应该失败`)
  }
})

await test('空字符串和纯空格都要拒', () => {
  assert(!S.requireString({ path: '' }, 'path').ok, '空字符串应该拒')
  assert(!S.requireString({ path: '   ' }, 'path').ok, '纯空格应该拒')
})

// ── optionalInt ─────────────────────────────────────────────────────────

console.log('\noptionalInt')

await test('正常取值', () => eq(S.optionalInt({ n: 10 }, 'n', 20, 1, 50), 10))
await test('缺失时用默认值', () => eq(S.optionalInt({}, 'n', 20, 1, 50), 20))

await test('★ 越界要夹回范围，不是报错也不是用默认值', () => {
  eq(
    S.optionalInt({ n: 500 }, 'n', 20, 1, 50),
    50,
    '讲义第二节那个例子：schema 写了 maximum: 50，模型给 500。\n' +
      '      这不是攻击也不是致命错误，夹回上限比报错少一个往返。',
  )
  eq(S.optionalInt({ n: -3 }, 'n', 20, 1, 50), 1)
})

await test('非数字退回默认值', () => {
  eq(S.optionalInt({ n: 'abc' }, 'n', 20, 1, 50), 20)
  eq(S.optionalInt({ n: null }, 'n', 20, 1, 50), 20)
  eq(S.optionalInt({ n: NaN }, 'n', 20, 1, 50), 20)
})

await test('小数要截成整数', () => eq(S.optionalInt({ n: 10.9 }, 'n', 20, 1, 50), 10))

// ── ToolBox ─────────────────────────────────────────────────────────────

console.log('\nToolBox')

const dummy = {
  name: 'echo',
  description: '回显',
  inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] },
  parse: (raw: unknown) => {
    const r = S.requireString(raw, 'text')
    return r.ok ? ({ ok: true, input: { text: r.value } } as const) : ({ ok: false, message: r.message } as const)
  },
  run: async (input: { text: string }) => ({ content: `echo: ${input.text}` }),
} as never

await test('注册与列名', () => {
  const box = new S.ToolBox([dummy])
  eq(box.names, ['echo'])
})

await test('重名注册要抛错', () => {
  const box = new S.ToolBox([dummy])
  let threw = false
  try {
    box.register(dummy)
  } catch {
    threw = true
  }
  assert(threw, '重名是你的 bug，不是模型的，该响')
})

await test('apiTools 形状正确', () => {
  const box = new S.ToolBox([dummy])
  const api = box.apiTools()
  eq(api.length, 1)
  assert(api[0]!.name === 'echo' && 'input_schema' in api[0]!, `形状不对：${JSON.stringify(api[0])}`)
})

await test('正常执行', async () => {
  const box = new S.ToolBox([dummy])
  eq((await box.execute('echo', { text: 'hi' })).content, 'echo: hi')
})

await test('★★ 不存在的工具名：回 isError，并把真实清单列出来', async () => {
  const box = new S.ToolBox([dummy])
  const r = await box.execute('delete_file', {})
  assert(r.isError, '编造的工具名必须回 isError，不能抛异常')
  assert(
    r.content.includes('echo'),
    '错误信息里必须列出真实可用的工具，否则模型只能继续猜。\n' +
      `      实际返回的是：${r.content}\n` +
      '      （模型编造工具名是模式补全，不是幻觉——它需要的是一份真清单。）',
  )
})

await test('参数校验失败：回 isError，不抛', async () => {
  const box = new S.ToolBox([dummy])
  const r = await box.execute('echo', {})
  assert(r.isError, '校验失败该回 isError')
})

// ── toolUsesOf / toolResultMessage ──────────────────────────────────────

console.log('\ntoolUsesOf / toolResultMessage')

const blocks = [
  { type: 'text' as const, text: '我来查一下', citations: null },
  { type: 'tool_use' as const, id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
  { type: 'tool_use' as const, id: 'toolu_2', name: 'list_dir', input: { path: '.' } },
] as never[]

await test('只挑出 tool_use 块', () => {
  eq(
    S.toolUsesOf(blocks).map((t) => t.id),
    ['toolu_1', 'toolu_2'],
  )
})

await test('结果拼成一条 user 消息', () => {
  const msg = S.toolResultMessage(S.toolUsesOf(blocks), [{ content: 'A' }, { content: 'B' }])
  eq(msg.role, 'user', 'tool_result 走 user 角色——协议里只有 user 和 assistant')
  assert(Array.isArray(msg.content), 'content 必须是块数组')
  eq((msg.content as unknown[]).length, 2, '两个结果要在同一条消息里，分成多条会造成连续两条 user')
})

await test('★ 顺序跟 tool_use 一致，不是完成顺序', () => {
  const msg = S.toolResultMessage(S.toolUsesOf(blocks), [{ content: 'A' }, { content: 'B' }])
  const ids = (msg.content as { tool_use_id: string }[]).map((c) => c.tool_use_id)
  eq(
    ids,
    ['toolu_1', 'toolu_2'],
    '顺序抖动的后果：前缀缓存失效（每轮重新付全价）+ 问题无法复现。\n' +
      '      实现上用 Promise.all（保序），不要「谁完成谁 push」。',
  )
})

await test('isError 要传成 is_error', () => {
  const msg = S.toolResultMessage([S.toolUsesOf(blocks)[0]!], [{ content: 'X', isError: true }])
  const first = (msg.content as { is_error?: boolean }[])[0]!
  assert(first.is_error === true, `is_error 没传过去：${JSON.stringify(first)}`)
})

await test('数量对不上要抛错', () => {
  let threw = false
  try {
    S.toolResultMessage(S.toolUsesOf(blocks), [{ content: 'only one' }])
  } catch {
    threw = true
  }
  assert(threw, '数量对不上是你的 bug，该响')
})

// ── safePath：攻击输入 ──────────────────────────────────────────────────

console.log('\nsafePath')

await test('正常相对路径', () => {
  const r = B.safePath(root, 'src/index.ts')
  assert(r.ok, `应该通过，实际：${JSON.stringify(r)}`)
  eq(r.rel, 'src/index.ts')
})

await test('★★ 经典路径穿越', () => {
  const r = B.safePath(root, '../../etc/passwd')
  assert(
    !r.ok,
    'resolve(root, "../../etc/passwd") 会老老实实解析到 /etc/passwd。\n' +
      '      resolve 的工作就是解析相对路径——它不是安全函数，从来不是。\n' +
      '      正确形状：先 resolve，再用 relative 验证结果仍在根内。',
  )
})

await test('★★ 绝对路径', () => {
  const r = B.safePath(root, '/etc/passwd')
  assert(
    !r.ok,
    '绝对路径要挡住。注意只查 rel.startsWith("..") 在某些平台上会漏，\n' +
      '      还要查 isAbsolute(rel)。',
  )
})

await test('★ 中间穿越，末尾看起来正常', () => {
  const r = B.safePath(root, 'src/../../outside/secret.txt')
  assert(!r.ok, '别用字符串前缀匹配去判断——要看 resolve 之后的结果')
})

await test('★ 文件名以 .. 开头不是穿越', () => {
  const r = B.safePath(root, '..notes.md', false)
  assert(
    r.ok,
    `根内的 ..notes.md 被判成越界了：${JSON.stringify(r)}\n` +
      "      rel.startsWith('..') 太宽：要查 rel === '..' 或 rel.startsWith('..' + sep)。",
  )
  eq(r.rel, '..notes.md')
})

await test('★ NUL 字节', () => {
  const r = B.safePath(root, 'safe.txt\0../../etc/passwd')
  assert(
    !r.ok,
    'NUL 会截断 C 层字符串，是经典绕过手法。显式拒绝比依赖运行时行为好。',
  )
})

await test('空字符串', () => {
  assert(!B.safePath(root, '').ok, '空路径应该拒')
})

await test('★★ 符号链接逃逸（纯路径检查挡不住）', () => {
  const r = B.safePath(root, 'src/escape.txt')
  assert(
    !r.ok,
    '仓库内一个指向外面的 symlink：路径字符串完全正常，resolve 之后也在根内。\n' +
      '      只有 realpath 之后再验一次才能挡住。',
  )
})

await test('★ root 本身是 symlink 时不能误判正常路径', () => {
  // macOS 上 /tmp 就是指向 /private/tmp 的符号链接，而临时目录都在 /tmp 下。
  // 如果只对 full 做 realpath 而不对 root 做，正常路径会被全部判成越界。
  const r = B.safePath(root, 'README.md')
  assert(
    r.ok,
    'root 本身是符号链接时（macOS 的 /tmp 就是），\n' +
      '      realpath(full) 落在 /private/tmp 而 root 还写着 /tmp，于是正常路径被判越界。\n' +
      '      两边都要 realpath 之后再比。',
  )
})

await test('★ 回给模型的消息里不能泄露解析后的绝对路径', () => {
  // 注意这里断言的是「不能出现 root / 解析结果」，不是「不能出现模型给的路径」。
  // 把模型自己给的参数回显给它是有用的（它得知道是哪次调用失败了）；
  // 泄露的是**你的文件系统结构**——root 在哪、最终解析到了哪。
  const r = B.safePath(root, '../../nosuch/secret.txt')
  assert(!r.ok, '应该失败')
  assert(
    !r.message.includes(root) && !r.message.includes(tmpdir()),
    `message 里出现了 root 的绝对路径：${r.message}\n` +
      '      上下文里的东西模型后面都可能复述出来。绝对路径放 logNote，不放 message。',
  )
  assert(r.logNote.length > 0, '越界尝试要留一条日志——模型猜错也好、被攻击也好，你都该知道')
})

// ── truncate ────────────────────────────────────────────────────────────

console.log('\ntruncate')

await test('短内容原样返回', () => {
  const r = B.truncate('hello', 1000)
  eq(r.truncated, false)
  eq(r.text, 'hello')
})

await test('★ 截断必须明确告知', () => {
  const r = B.truncate('x'.repeat(5000), 1000)
  eq(r.truncated, true)
  assert(
    /截断|truncat/i.test(r.text),
    '截断了但没在内容里说。模型会以为看到了完整文件，然后基于残缺内容下结论。\n' +
      '      这和 L02「半截内容绝不能静默返回」是同一条纪律。',
  )
})

await test('★ 按字节截断不能留下半个多字节字符', () => {
  // '中' 是 3 字节，1000 不是 3 的整数倍，一定会切在字符中间
  const r = B.truncate('中'.repeat(1000), 1000)
  assert(
    !r.text.includes('\uFFFD'),
    '出现了 U+FFFD 替换字符。中文内容里这个非常常见，处理掉切断的尾巴。',
  )
})

// ── 真实工具 ────────────────────────────────────────────────────────────

console.log('\nread_file / list_dir / search_code')

const readFile = T.makeReadFile(root)
const listDir = T.makeListDir(root)

await test('read_file 正常读取', async () => {
  const p = readFile.parse({ path: 'src/index.ts' })
  assert(p.ok, `校验应该通过：${JSON.stringify(p)}`)
  const r = await readFile.run(p.input)
  assert(!r.isError && r.content.includes('export const a = 1'), `读取失败：${JSON.stringify(r)}`)
})

await test('read_file 缺 path 要被校验拦下', () => {
  assert(!readFile.parse({}).ok, 'path 必填')
})

await test('★ read_file 文件不存在时，错误信息要给出路', async () => {
  const p = readFile.parse({ path: 'src/nope.ts' })
  assert(p.ok, '校验应该通过（路径合法但文件不存在）')
  const r = await readFile.run(p.input)
  assert(r.isError, '应该 isError')
  assert(
    r.content.includes('list_dir'),
    '错误信息里没有下一步建议。\n' +
      `      实际：${r.content}\n` +
      '      模型读完只会重试同一个路径。判据不是「准确描述故障」，是「读完知道干什么」。',
  )
})

await test('read_file 读到目录时要提示用 list_dir', async () => {
  const p = readFile.parse({ path: 'src' })
  assert(p.ok, '校验通过')
  const r = await readFile.run(p.input)
  assert(r.isError && r.content.includes('list_dir'), `应该提示改用 list_dir：${r.content}`)
})

await test('read_file 行号区间要带行号前缀', async () => {
  const p = readFile.parse({ path: 'src/index.ts', start_line: 2, end_line: 3 })
  assert(p.ok, '校验通过')
  const r = await readFile.run(p.input)
  assert(
    r.content.includes('2') && r.content.includes('export const b'),
    `应该带行号并只返回指定区间：${r.content}`,
  )
  assert(!r.content.includes('export const a'), '第 1 行不该出现')
})

await test('read_file end_line < start_line 要拦下', () => {
  assert(!readFile.parse({ path: 'src/index.ts', start_line: 5, end_line: 2 }).ok, '区间反了要拒')
})

await test('read_file 大文件要被截断并告知', async () => {
  const p = readFile.parse({ path: 'src/big.txt' })
  assert(p.ok, '校验通过')
  const r = await readFile.run(p.input)
  assert(/截断/.test(r.content), '大文件必须截断并说明——否则一次调用就能烧掉几十块钱并撞满上下文')
})

await test('★ read_file 挡住越界路径', async () => {
  const p = readFile.parse({ path: '../../etc/passwd' })
  assert(p.ok, '路径校验不在 parse 里，在 run 里（parse 只管类型）')
  const r = await readFile.run(p.input)
  assert(r.isError, '越界必须被 run 挡下')
})

await test('list_dir 列出内容，目录在前', async () => {
  const p = listDir.parse({ path: '.' })
  assert(p.ok, '校验通过')
  const r = await listDir.run(p.input)
  const lines = r.content.split('\n')
  const firstFile = lines.findIndex((l) => !l.includes('/'))
  const lastDir = lines.reduce((acc, l, i) => (l.includes('/') ? i : acc), -1)
  assert(
    firstFile === -1 || lastDir < firstFile,
    `目录应该排在文件前面，实际：\n${r.content}\n` +
      '      输出稳定才可能命中缓存（L02：顺序抖动等于每轮重新付全价）',
  )
})

await test('★ list_dir 跳过的目录也要列出来并标注', async () => {
  const p = listDir.parse({ path: '.' })
  assert(p.ok, '校验通过')
  const r = await listDir.run(p.input)
  assert(
    r.content.includes('node_modules'),
    '被跳过的目录也要出现在输出里并标注「已跳过」。\n' +
      `      实际：\n${r.content}\n` +
      '      完全不提的话，模型会以为它不存在，然后反复去找。',
  )
})

await test('list_dir depth 越界要夹回', () => {
  const p = listDir.parse({ path: '.', depth: 99 })
  assert(p.ok && p.input.depth <= 3, `depth 应该被夹到 3 以内，实际 ${JSON.stringify(p)}`)
})

if ('makeSearchCode' in T) {
  const search = T.makeSearchCode(root)

  await test('search_code 找到匹配', async () => {
    const p = search.parse({ pattern: 'needle' })
    assert(p.ok, '校验通过')
    const r = await search.run(p.input)
    assert(r.content.includes('README.md'), `应该找到 README.md：${r.content}`)
    assert(
      !r.content.includes('node_modules'),
      'node_modules 里的匹配不该出现——描述里承诺了跳过它',
    )
  })

  await test('★ search_code 非法正则要回给模型而不是崩掉', () => {
    const p = search.parse({ pattern: '[invalid(' })
    assert(!p.ok, '非法正则是模型能改的，回 message 让它重写')
    assert(p.message.length > 4, '要把正则的报错原文带上，否则它不知道哪里错了')
  })

  await test('search_code 找不到时要明确说没匹配', async () => {
    const p = search.parse({ pattern: 'zzzznotfoundzzzz' })
    assert(p.ok, '校验通过')
    const r = await search.run(p.input)
    assert(r.content.length > 4 && !r.isError, `找不到不是错误，但要说清楚：${r.content}`)
  })
}

// ── 收尾 ────────────────────────────────────────────────────────────────

await rm(root, { recursive: true, force: true })
await rm(outside, { recursive: true, force: true })

const total = passed + failures.length
console.log(`\n${'─'.repeat(52)}`)
if (failures.length === 0) {
  console.log(`\x1b[32m全绿 ${passed}/${total}。\x1b[0m 去看 shared/sandbox.ts 和 shared/toolbox.ts 对照取舍。`)
} else {
  console.log(`\x1b[31m${failures.length}/${total} 没过：\x1b[0m`)
  for (const f of failures) console.log(`  · ${f}`)
  console.log('\n带 ★★ 的是真漏洞，别跳过。')
  process.exit(1)
}
