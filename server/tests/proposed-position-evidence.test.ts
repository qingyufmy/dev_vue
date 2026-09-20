import { expect, it } from 'vitest'
import { contentHash } from '../src/modules/inference/index.js'
import { createMysqlProposedDecisionEvidenceReader } from '../src/modules/inference/infrastructure/mysql-proposed-decision-evidence-reader.js'
import type { PoolConnection } from 'mysql2/promise'
const payload = { positions: [], positionsRevision: 12 }
const scope = { decisionId: 'd', decisionRevision: 1, userId: 1, accountId: '7', analysisRevision: 2 }
function reader(rows: unknown[]) {
  return createMysqlProposedDecisionEvidenceReader({ execute: async () => [rows, []] } as unknown as Pick<PoolConnection, 'execute'>)
}
it('reads hash-verified frozen positions from the trader snapshot', async () => {
  expect(await reader([{ payload_json: payload, payload_sha256: contentHash(payload) }]).readPositions!(scope))
    .toEqual({ positions: [], revision: 12 })
})
it('rejects changed snapshot content and absent evidence', async () => {
  expect(await reader([{ payload_json: { ...payload, positionsRevision: 13 }, payload_sha256: contentHash(payload) }]).readPositions!(scope)).toBeNull()
  expect(await reader([]).readPositions!(scope)).toBeNull()
})
