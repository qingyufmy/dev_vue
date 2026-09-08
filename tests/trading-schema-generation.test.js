import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { renderTradingSchemaReadiness } from '../scripts/generate-trading-schema-readiness.mjs'

it('keeps the deployed account schema contract bound to registered migrations and verified table definitions', async () => {
  const actual = await readFile(new URL('../server/src/modules/trading/infrastructure/inplace-account-schema.ts', import.meta.url), 'utf8')
  expect(actual).toBe(await renderTradingSchemaReadiness())
  expect(actual).not.toContain('serverUuid')
  expect(actual).not.toContain('rowsSha256')
})
