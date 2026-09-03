import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'

const uiSource = fileURLToPath(new URL('../../packages/ui/src', import.meta.url))

export default defineNuxtConfig({
  alias: {
    '@/lib/utils': `${uiSource}/lib/utils.ts`,
    '@/components/ui': `${uiSource}/components/ui`,
  },
  compatibilityDate: '2026-09-03',
  css: ['@aurum/design-tokens/styles.css'],
  devtools: { enabled: false },
  modules: [],
  typescript: { strict: true, typeCheck: true },
  vite: {
    plugins: [tailwindcss()],
    resolve: {
      alias: [
        { find: '@/lib', replacement: `${uiSource}/lib` },
        { find: '@/components/ui', replacement: `${uiSource}/components/ui` },
      ],
    },
  },
})
