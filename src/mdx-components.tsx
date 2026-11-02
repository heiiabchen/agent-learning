import type { MDXComponents } from 'mdx/types'
import { CursorHook, Drill, Key, Lab, Note, Pitfall, PyMirror, Steps, TsMirror } from '@/components/blocks'

/** 讲义里可直接使用的教学组件，不需要在每个 mdx 文件里 import。 */
export const mdxComponents: MDXComponents = {
  Drill,
  CursorHook,
  PyMirror,
  TsMirror,
  Lab,
  Pitfall,
  Note,
  Key,
  Steps,
}
