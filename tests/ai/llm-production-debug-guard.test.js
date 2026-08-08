import { describe, expect, it } from 'vitest'
import fs from 'node:fs'

describe('LLM production logging guard', () => {
  it('requires a non-production environment before payload logging can be enabled', () => {
    const source = fs.readFileSync(new URL('../../server/routes/ai/llm.js', import.meta.url), 'utf8')
    expect(source).toContain("process.env.NODE_ENV !== 'production' && process.env.DEBUG_LLM_PAYLOAD === '1'")
  })
})
