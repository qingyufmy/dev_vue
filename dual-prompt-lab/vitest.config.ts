import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['dual-prompt-lab/tests/project-contract.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
})
