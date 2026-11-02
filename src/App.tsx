import { MDXProvider } from '@mdx-js/react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/AppShell'
import { mdxComponents } from '@/mdx-components'
import { Home } from '@/pages/Home'
import { LessonPage } from '@/pages/Lesson'

export function App() {
  return (
    <MDXProvider components={mdxComponents}>
      <AppShell>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/lesson/:id" element={<LessonPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </MDXProvider>
  )
}
