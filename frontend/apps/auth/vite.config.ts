import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'AURUM_AUTH_')
  const target = env.AURUM_AUTH_API_BASE || 'http://127.0.0.1:3010'
  return {
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: {
        '~': fileURLToPath(new URL('./src', import.meta.url)),
        '@': fileURLToPath(new URL('../../packages/ui/src', import.meta.url)),
      },
    },
    test: { environment: 'happy-dom' },
    server: {
      proxy: {
        // Keep the browser Host and Origin: the API validates the auth surface and CSRF.
        '^/oauth/(authorize|jwks|token)(\\?|$)': { target, changeOrigin: false },
        '^/api/v4/auth/(login|session|logout)(\\?|$)': { target, changeOrigin: false },
        '^/\\.well-known/openid-configuration(\\?|$)': { target, changeOrigin: false },
      },
    },
  }
})
