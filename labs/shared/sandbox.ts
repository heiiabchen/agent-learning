/**
 * 路径沙箱。这是整门课里第一个**真安全**的模块。
 *
 * 要防的东西很具体：模型生成的路径参数可能来自它上下文里的任何东西，
 * 包括用户输入和它刚读进来的文件内容。所以路径必须当成攻击输入处理。
 *
 * ─── 为什么 resolve() 不够 ────────────────────────────────────────────────
 *
 *   resolve('/repo', '../../etc/passwd')  →  '/etc/passwd'
 *
 * resolve 的工作就是解析相对路径，它**忠实地**帮你跳出了根目录。
 * 它不是安全函数，从来不是。
 *
 * 正确的形状是：先 resolve，**再验证结果仍在根内**。
 * 顺序不能反——你没法在解析之前判断一个相对路径最终会落在哪。
 */
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface SafePathOk {
  ok: true
  /** 解析并验证过的绝对路径。只有这个值可以交给 fs。 */
  full: string
  /** 相对根的路径，用于日志和回给模型的消息——绝对路径不要进上下文。 */
  rel: string
  /** 解析完符号链接之后、相对真实根的路径。followSymlinks=false 时等于 rel。 */
  realRel: string
}

export type SafePathCode =
  | 'INVALID'
  | 'ESCAPES_ROOT'
  | 'SYMLINK_ESCAPES_ROOT'
  | 'SYMLINK_LOOP'
  /** 悬空链接或权限不足：落点无法确定，按拒绝处理。 */
  | 'UNRESOLVABLE'

export interface SafePathErr {
  ok: false
  /** 给模型看的话。 */
  message: string
  /** 给日志看的话。越界尝试你自己要知道，哪怕模型只是猜错了。 */
  logNote: string
  code: SafePathCode
}

export type SafePath = SafePathOk | SafePathErr

/**
 * 把一个模型给的路径安全地解析到 root 之内。
 *
 * @param followSymlinks 是否解析符号链接后再验一次。默认开。
 *   路径还不存在时（比如要创建新文件）也照样开：realpath 作用在最近的已存在祖先上。
 */
export function safePath(root: string, input: string, followSymlinks = true): SafePath {
  if (typeof input !== 'string' || input.trim() === '') {
    return {
      ok: false,
      message: '路径不能为空。',
      logNote: `非法路径参数：${JSON.stringify(input)}`,
      code: 'INVALID',
    }
  }

  // NUL 字节会截断 C 层的字符串，是一个经典的绕过手法：
  // 'safe.txt\0../../etc/passwd' 在某些 API 里会被当成 'safe.txt'。
  // Node 现在会抛错，但显式拒绝比依赖运行时行为好。
  if (input.includes('\0')) {
    return {
      ok: false,
      message: '路径含有非法字符。',
      logNote: `路径里有 NUL 字节：${input}`,
      code: 'INVALID',
    }
  }

  const rootAbs = resolve(root)
  const full = resolve(rootAbs, input)
  const rel = relative(rootAbs, full)

  if (escapes(rel)) {
    return {
      ok: false,
      message: `路径超出了允许的范围：${input}。只能访问仓库内的文件。`,
      logNote: `越界访问尝试：${input} → ${full}`,
      code: 'ESCAPES_ROOT',
    }
  }

  // rel 为空表示路径就是根本身。允不允许取决于操作（列目录可以，读文件不行），
  // 这里放过，交给调用方按语义判断。
  if (!followSymlinks) return { ok: true, full, rel: rel || '.', realRel: rel || '.' }

  // 两边都要 realpath：root 本身可能是符号链接（macOS 的 /tmp → /private/tmp）。
  const realRoot = realpathNearest(rootAbs)
  const realFull = realpathNearest(full)
  if (!realRoot.ok || !realFull.ok) {
    const code = !realFull.ok ? realFull.code : !realRoot.ok ? realRoot.code : 'UNRESOLVABLE'
    return {
      ok: false,
      message:
        code === 'SYMLINK_LOOP'
          ? `路径里有符号链接环：${input}。`
          : `无法确定路径最终落在哪里：${input}。`,
      logNote: `${code === 'SYMLINK_LOOP' ? '符号链接环' : '无法解析的符号链接'}：${input} → ${full}`,
      code,
    }
  }
  const realRel = relative(realRoot.real, realFull.real)
  if (escapes(realRel)) {
    // 纯路径检查挡不住这种：仓库内一个 symlink 指向外面。
    // 路径字符串看起来完全正常，解析出来也在根内。
    return {
      ok: false,
      message: `路径超出了允许的范围：${input}。`,
      logNote: `符号链接越界：${input} → ${realFull.real}`,
      code: 'SYMLINK_ESCAPES_ROOT',
    }
  }

  return { ok: true, full, rel: rel || '.', realRel: realRel || '.' }
}

/**
 * relative() 的结果算不算跳出了根。两个条件都要查：
 *   · rel 是 '..' 或以 '..' + 分隔符开头 → 跳出去了
 *   · rel 是绝对路径 → 在 Windows 上跨盘符时 relative 会返回绝对路径
 * ★ 只查 startsWith('..') 会把根内合法的 '..notes.md' 判成越界。
 */
function escapes(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

type RealResult = { ok: true; real: string } | { ok: false; code: 'SYMLINK_LOOP' | 'UNRESOLVABLE' }

/**
 * realpath 最近的已存在祖先，再接上还不存在的那几段。
 *
 * ★ 只对整条路径做 realpath 的话，目标不存在时它会抛，检查就退化成纯路径层：
 *   root 里的 out → /elsewhere，create('out/new.txt') 会写到 root 外面。
 *   对只读工具这不要紧（最后报「不存在」）；对创建文件，「不存在」恰恰是正常状态。
 */
function realpathNearest(p: string): RealResult {
  const rest: string[] = []
  let cur = p
  for (;;) {
    try {
      return { ok: true, real: join(realpathSync(cur), ...rest) }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ELOOP') return { ok: false, code: 'SYMLINK_LOOP' }
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return { ok: false, code: 'UNRESOLVABLE' }
    }
    // realpath 失败而 lstat 成功：cur 是悬空链接，指向哪里要等它被创建才知道
    if (lexists(cur)) return { ok: false, code: 'UNRESOLVABLE' }
    const parent = dirname(cur)
    if (parent === cur) return { ok: true, real: join(cur, ...rest) }
    rest.unshift(basename(cur))
    cur = parent
  }
}

function lexists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * 截断过长的内容，并**明确告知**被截断了。
 *
 * 那句告知不能省。不说的话模型会以为自己看到了完整内容，然后基于残缺信息下结论。
 * 这和 L02 那条「半截内容绝不能静默返回」是同一条纪律，只是换了个位置。
 */
export function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return { text, truncated: false }

  // 按字节切会切断多字节字符。toString 会把残缺的尾巴变成 U+FFFD，
  // 中文内容里这个很常见，所以把结尾那个替换字符去掉。
  const head = buf.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD$/, '')
  const kb = (buf.byteLength / 1024).toFixed(1)
  return {
    text: `${head}\n\n…（内容被截断。完整大小 ${kb} KB，这里只显示前 ${Math.floor(maxBytes / 1024)} KB）`,
    truncated: true,
  }
}
