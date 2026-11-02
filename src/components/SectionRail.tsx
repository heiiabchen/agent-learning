import { useEffect, useState } from 'react'
import './SectionRail.css'

interface Section {
  id: string
  text: string
}

/**
 * 讲义右侧的小节导航。讲义很长（一节课两小时的量），
 * 没有它就只能靠滚动条盲找。同时它也让宽屏下右侧的留白变成有用的空间。
 */
export function SectionRail({ contentKey }: { contentKey: string }) {
  const [sections, setSections] = useState<Section[]>([])
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    // effect 在 DOM 提交之后才跑，这里直接查就行，不要等 requestAnimationFrame——
    // 标签页不在前台时 rAF 会被节流，导航条就永远不出现。
    const heads = [...document.querySelectorAll<HTMLHeadingElement>('.prose > h2')]
    if (heads.length === 0) return

    // 标题基本是纯中文，slug 插件对 CJK 的结果不总是可用，缺 id 就自己补
    heads.forEach((h, i) => {
      if (!h.id) h.id = `sec-${i + 1}`
    })
    setSections(heads.map((h) => ({ id: h.id, text: h.textContent ?? '' })))
    setActive(heads[0]?.id ?? null)

    const observer = new IntersectionObserver(
      (entries) => {
        const topMost = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (topMost) setActive(topMost.target.id)
      },
      { rootMargin: '-12% 0px -68% 0px' },
    )
    heads.forEach((h) => observer.observe(h))
    return () => observer.disconnect()
  }, [contentKey])

  if (sections.length < 2) return null

  return (
    <aside className="sectionRail">
      <div className="sectionRailInner">
        <div className="eyebrow">本节结构</div>
        <ol>
          {sections.map((s) => (
            <li key={s.id} data-active={active === s.id}>
              <a href={`#${s.id}`}>{s.text}</a>
            </li>
          ))}
        </ol>
      </div>
    </aside>
  )
}
