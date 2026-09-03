import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js', 'server/tests/**/*.test.ts'],
    globals: true,
    environment: 'node',
    env: {
      NODE_ENV: 'test',
      JWT_SECRET: 'vitest-only-secret-not-for-production',
    },
    coverage: {
      provider: 'v8',
      include: ['server/routes/ai/**/*.js'],
      exclude: ['server/routes/ai/index.js'],
    },
  },
})
