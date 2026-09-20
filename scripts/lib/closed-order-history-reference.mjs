import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createMysqlClosedOrderHistoryReader } from '../../server/dist-v4/modules/trade-history/composition.js'
import { canonicalEvidence } from '../../server/dist-v4/modules/trade-history/index.js'
import {verifyCollectedHistoryParentProof} from './collected-history-parent-proof-reference.mjs'

/** Consumes the task/receipt/pages/deals produced by the actual queued collector reference. */
export async function verifyClosedOrderHistoryReference(connection,route,window){
  const [[identity]]=await connection.query('SELECT DATABASE() db')
  assert.match(identity.db,/^dev_vue_history_ref_[a-f0-9]{32}$/)
  const reader=createMysqlClosedOrderHistoryReader(connection),checks=[]
  const scope={route,orderTicket:'61002',receiptDealTickets:['60002'],positionIdentifier:'60000',symbol:'XAUUSD',positionSide:'buy',expectedVolume:'1',
    issuedAtUtcMsc:window.rangeStartUtcMsc+150,completedAtUtcMsc:window.rangeStartUtcMsc+250}
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  try{
    const proof=await reader.read(scope)
    assert.equal(proof.status,'matched');assert.equal(proof.closedVolume,'1');assert.equal(proof.orderTicket,'61002')
    assert.equal(proof.taskId,window.taskId);assert.equal(proof.deals.length,1);assert.equal(proof.deals[0].ticket,'60002')
    assert.ok(proof.deals[0].provenanceHashes.length>0)
    checks.push('actual-queued-task-pages-provenance-and-closed-order-fact-matched-in-read-only-snapshot')
    for(const patch of [{expectedVolume:'2'},{receiptDealTickets:['60001']},{positionIdentifier:'other'},{positionSide:'sell'},
      {symbol:'EURUSD'},{issuedAtUtcMsc:window.rangeStartUtcMsc+201},{completedAtUtcMsc:window.rangeStartUtcMsc+199}]){
      assert.deepEqual(await reader.read({...scope,...patch}),{status:'unresolved',reason:'fills_mismatch'})
    }
    assert.equal((await reader.read({...scope,route:{...route,login:'another'}})).reason,'coverage_unavailable')
    checks.push('wrong-volume-anchor-position-side-symbol-command-window-and-current-route-rejected')
  }finally{await connection.rollback()}
  await connection.beginTransaction()
  try{
    await connection.query("UPDATE terminal_history_deals_v4 SET evidence_sha256=REPEAT('a',64) WHERE deal_ticket='60002'")
    await assert.rejects(reader.read(scope),/closed_order_history_fact_corrupt/)
    checks.push('stored-deal-body-hash-corruption-rejected')
  }finally{await connection.rollback()}
  await connection.beginTransaction()
  try{
    await connection.query(`UPDATE terminal_history_deal_provenance_v4 p JOIN terminal_history_deals_v4 d ON d.id=p.terminal_history_deal_id
      SET p.source_revision='other' WHERE d.deal_ticket='60002'`)
    assert.deepEqual(await reader.read(scope),{status:'unresolved',reason:'source_missing'})
    checks.push('matching-quantity-without-same-task-source-rejected')
  }finally{await connection.rollback()}
  await connection.beginTransaction()
  try{
    const [[original]]=await connection.query("SELECT * FROM terminal_history_deals_v4 WHERE deal_ticket='60002'")
    const raw=typeof original.evidence_json==='string'?JSON.parse(original.evidence_json):structuredClone(original.evidence_json)
    raw.ticket='60003'
    const evidence=canonicalEvidence(raw)
    const extra={...original,id:randomUUID(),deal_ticket:'60003',evidence_json:evidence.json,evidence_sha256:evidence.hash}
    const keys=Object.keys(extra);assert.ok(keys.every(key=>/^[a-z0-9_]+$/.test(key)))
    await connection.execute(`INSERT INTO terminal_history_deals_v4 (${keys.map(key=>'`'+key+'`').join(',')}) VALUES (${keys.map(()=>'?').join(',')})`,Object.values(extra))
    assert.deepEqual(await reader.read({...scope,expectedVolume:'2'}),{status:'unresolved',reason:'source_missing'})
    checks.push('all-fills-require-page-membership-even-when-frozen-quantity-matches')
  }finally{await connection.rollback()}
  const parentProof=await verifyCollectedHistoryParentProof(connection,route,window)
  return {passed:true,checks,parentProof,historyTables:'actual-migrations-with-task-page-and-provenance-persistence',
    commandReceipt:'explicit-test-anchor',terminalTransport:'synthetic-query-port',realTerminalVerified:false}
}
