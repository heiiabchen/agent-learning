/**
 * 真跑模型的评测入口——和 verify 分开。
 *
 * 用法：pnpm exec tsx --env-file=.env l18/runner.ts
 *
 * 这里只做一件事：把「一次真实 agent 跑完」落成 Attempt 记录，
 * 再交给 shared/codingEval 的 rateSpectrum / codingGate。
 *
 * ★ 不要用这个脚本当 CI 门。成功率不可复现的部分属于 nightly；
 * CI 只跑 pnpm verify:l18（零模型）。
 */

import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  classifyAttempt,
  codingGate,
  rateSpectrum,
  type Attempt,
  type TaskInstance,
} from '../shared/codingEval.ts'
import { detectHacks, Workspace } from '../shared/coding.ts'

const root = '/tmp/l18-runner-ws'
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'src'), { recursive: true })
mkdirSync(join(root, 'tests'), { recursive: true })

writeFileSync(
  join(root, 'src', 'cache.py'),
  `class Cache:
    def get(self, key):
        if key not in self._data:
            return None
        return self._data[key]
`,
)
writeFileSync(
  join(root, 'tests', 'test_e1.py'),
  `def test_fix():
    assert False

def test_smoke():
    assert True
`,
)

const task: TaskInstance = {
  id: 'e1',
  difficulty: 'easy',
  failToPass: ['tests/test_e1.py::test_fix'],
  passToPass: ['tests/test_e1.py::test_smoke'],
  repoPin: 'demo/repo@e1',
}

const ws = new Workspace(root)
ws.read('src/cache.py')
const edit = ws.edit('src/cache.py', [
  {
    old: `    def get(self, key):
        if key not in self._data:
            return None
        return self._data[key]`,
    new: `    def get(self, key):
        if key not in self._data:
            raise KeyError(key)
        return self._data[key]`,
  },
])

const hacks = detectHacks({
  changedFiles: ['src/cache.py'],
  diffText: '@@\n-return None\n+raise KeyError(key)\n',
})

const attempt: Attempt = {
  taskId: task.id,
  variant: 'runner-demo',
  patchApplied: edit.ok,
  // ★ 真跑时应执行 failToPass / passToPass；这里只演示记录形状
  failToPassGreen: false,
  passToPassGreen: true,
  testsMutated: false,
  hackFindings: hacks,
  tokens: 0,
  costUsd: 0,
  latencyMs: 0,
}

console.log('classify:', classifyAttempt(attempt))
console.log('spectrum:', rateSpectrum([attempt]))
console.log(
  'gate blockers preview:',
  codingGate({
    tasks: [task],
    baseline: [attempt],
    candidate: [attempt],
  }).blockers,
)

console.log(
  '\n要把上面接进真模型：对每个 TaskInstance 跑完 agent，\n' +
    '把 patchApplied / 测试结果 / detectHacks / tokens / cost 写入 Attempt，\n' +
    '再调用 codingGate。数字的可信度是 L18 正文的主题；CI 仍然零模型。',
)
