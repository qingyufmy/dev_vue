import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['server/routes/ai/**/*.js'],
      exclude: ['server/routes/ai/index.js'],
    },
  },
})
