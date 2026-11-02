/**
 * 真调模型的 runner——和 verify 分开。
 *
 * 用法：pnpm exec tsx --env-file=.env l17/runner.ts
 *
 * 这里只观察那些假输入测不到的行为：
 *   · 模型在 NOT_UNIQUE 之后会不会扩大上下文
 *   · 模型会不会跳过 verify 就声称完成
 *   · 模型会不会去读 tests/ 然后改测试
 *
 * ★ 不要用这个脚本当 CI 门。成功率不可复现，是 L18 的事。
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Workspace, applyEdits } from '../shared/coding.ts'

const root = '/tmp/l17-runner-ws'
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'src'), { recursive: true })
writeFileSync(
  join(root, 'src', 'cache.py'),
  `class Cache:
    def get(self, key):
        if key not in self._data:
            return None
        return self._data[key]

    def peek(self, key):
        if key not in self._data:
            return None
        return self._data[key]
`,
)

const ws = new Workspace(root)
ws.read('src/cache.py')

// 演示：不唯一的编辑被挡住
const shared = `        if key not in self._data:
            return None`
const blocked = ws.edit('src/cache.py', [
  {
    old: shared,
    new: `        if key not in self._data:
            raise KeyError(key)`,
  },
])
console.log('不唯一编辑：', blocked.ok ? '竟成功了' : blocked.reason)
console.log(blocked.ok ? '' : blocked.message)

// 扩大上下文后应成功
const unique = `    def get(self, key):
        if key not in self._data:
            return None
        return self._data[key]`
const ok = ws.edit('src/cache.py', [
  {
    old: unique,
    new: `    def get(self, key):
        if key not in self._data:
            raise KeyError(key)
        return self._data[key]`,
  },
])
console.log('扩大上下文：', ok.ok ? `成功 tier=${ok.ok ? ok.applied[0]?.tier : ''}` : ok.reason)

console.log(
  '\n要把上面接进真模型：用 shared/fake.ts 或 Anthropic SDK，\n' +
    '工具列表按 toolsFor(phase) 切换，终止用 canStop。\n' +
    '接好之后的成功率数字，留给 L18。',
)

void applyEdits
