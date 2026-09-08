import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'AURUM_TRADE_')
  const target = env.AURUM_TRADE_API_BASE || 'http://127.0.0.1:3010'
  return {
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: {
        '~': fileURLToPath(new URL('./src', import.meta.url)),
        '@': fileURLToPath(new URL('../../packages/ui/src', import.meta.url)),
      },
    },
    test: {
      environment: 'happy-dom',
    },
    server: {
      proxy: {
        // Retain the browser surface and its CSRF Origin; the API owns authorization.
        '^/api/v4(?:/|\\?|$)': { target, changeOrigin: false },
        '^/auth/(?:start|callback)(?:\\?|$)': { target, changeOrigin: false },
      },
    },
  }
})
