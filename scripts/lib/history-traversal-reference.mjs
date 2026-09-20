import assert from 'node:assert/strict'
import { historyCollectionReceipt } from '../../server/dist-v4/modules/trade-history/application/history-collection-receipt.js'
import { persistHistoryCollectionReceipt } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-collection-receipt-writer.js'
import { createMysqlHistoryTraversalReader } from '../../server/dist-v4/modules/trade-history/composition.js'

export async function verifyHistoryTraversalReference(admin, pool, originalRoute) {
  const route = { ...originalRoute, terminalInstanceId: 'traversal-reference-terminal' }
  const at = Date.parse('2026-09-10T00:00:00Z')
  async function save(start, end, source = 'terminal') {
    return persistHistoryCollectionReceipt(admin, historyCollectionReceipt(route,end,
      ['history.orders','history.deals'].map(resource => ({ resource, rangeStartUtcMsc:start, rangeEndUtcMsc:end,
        source, sourceRevision:'traversal-v1', pageCount:1,itemCount:0,pageChainHash:'b'.repeat(64) }))),new Date(at))
  }
  await save(at-4000,at-2000)
  const connection = await pool.getConnection()
  try {
    await connection.query("SET SESSION time_zone='+08:00'")
    const reader = createMysqlHistoryTraversalReader(connection)
    const scope = { route, rangeStartUtcMsc:at-3000, rangeEndUtcMsc:at }
    assert.equal((await reader.read(scope)).status,'unresolved')
    await save(at-2000,at,'local_projection')
    assert.equal((await reader.read(scope)).status,'unresolved')
    const added = await save(at-2000,at)
    const result = await reader.read(scope)
    assert.equal(result.status,'traversed'); assert.equal(result.completeHistoryProven,false)
    assert.equal(result.receiptIds.length,2)
    await admin.execute("UPDATE terminal_history_collection_receipts_v4 SET evidence_sha256=REPEAT('e',64) WHERE id=?",[added.id])
    await assert.rejects(reader.read(scope),/history_traversal_receipt_corrupt/)
    return { passed:true, completeHistoryProven:false, checks:['utc-session-independent-window','missing-terminal-range-unresolved','local-projection-insufficient','contiguous-receipts-traversed','corrupt-receipt-rejected'] }
  } finally { connection.release() }
}
