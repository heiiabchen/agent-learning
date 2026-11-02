import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// L16 的交付物：一个独立的 agent 界面。
// 它不接真实的 API——事件流是确定性的假流（见 stream.ts）。
//
// 为什么要确定性：这一节要演示的现象里有好几个在真实调用里**几乎撞不到**
// （服务端中途换模型、max_tokens 恰好切在参数中间、CDN 重新分帧）。
// 用脚本化的假流，这些分支每次都能复现，而且一次模型都不调。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  server: { port: 5316, open: false },
})
