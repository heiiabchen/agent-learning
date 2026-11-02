/**
 * "这个文件是被直接跑的，还是被 import 的？"
 *
 * Python 有 `if __name__ == "__main__":`，Node 的 ESM 里没有等价物
 * （`import.meta.main` 要 Node 24+），所以自己拼一个。
 *
 * 存在的理由很具体：每节的 verify 脚本会 `import` 你写的那个脚手架，
 * 而脚手架末尾如果直接调 `main()`，import 的那一刻观察实验就跑起来了——
 * 于是 `pnpm verify:l09` 的输出不是一张"还有哪些没写"的清单，
 * 而是第一个 TODO 抛出来的堆栈。
 *
 * ★ 这是一类很典型的 bug：**它不影响任何一个函数的正确性，
 * 只是让报错发生在错误的地方。** 而"报错发生在错误的地方"比报错本身
 * 贵得多——它把一次三秒的确认变成了一次十分钟的排查。
 */
import { pathToFileURL } from 'node:url'

export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  return moduleUrl === pathToFileURL(entry).href
}
