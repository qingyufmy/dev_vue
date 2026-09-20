import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'
import { decodeTerminalHistoryPage } from '../../server/dist-v4/modules/trade-history/domain/terminal-history-projection.js'
import { persistHistoryDealProvenance } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-deal-provenance-writer.js'

export async function verifyHistoryDealProvenanceReference(connection, snapshots) {
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_history_ref_[a-f0-9]{32}$/)
  await connection.query(snapshots.find(t => t.name === 'terminal_history_deals_v4').ddl)
  const sql = await readFile(new URL('../../server/db/migrations/inplace/052_terminal_history_deal_provenance.sql', import.meta.url), 'utf8')
  await connection.query(sql)
  const [[definition]] = await connection.query('SHOW CREATE TABLE terminal_history_deal_provenance_v4')
  const now = new Date('2026-09-10T00:00:00.000Z')
  const route = { userId: 7, accountId: '5', platform: 'mt5', terminalInstanceId: 'terminal', terminalProfileId: 'profile',
    brokerServer: 'Broker', login: '001', connectionEpoch: 3, connectionId: 'connection', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
  const raw = { ticket: '18446744073709551615', position_id: '91', order: '90', type: 'buy', entry: 'in', time_msc: now.getTime()-1000, volume: '1', price: '2500' }
  const fact = decodeTerminalHistoryPage('deals', [raw])[0], id = randomUUID()
  const response = { v: 4, type: 'query.response', message_id: 'response-1', correlation_id: 'query-1', sent_at_utc_msc: now.getTime(),
    route: { terminal_instance_id: 'terminal', account_ref: { broker_server: 'Broker', login: '001' }, connection_epoch: 3 },
    payload: { request_id: 'request-1', resource: 'history.deals', source: 'terminal', source_revision: 'r1', observed_at_utc_msc: now.getTime()-1,
      items: [raw], has_more: false, next_cursor: null } }
  const input = { route, fact, response, receivedAt: now }, checks = []
  await connection.execute(`INSERT INTO terminal_history_deals_v4
    (id,trading_account_id,platform,deal_ticket,order_ticket,position_id,deal_kind,entry_kind,side,volume,price,
     occurred_at_utc,terminal_timezone_offset_minutes,evidence_sha256,evidence_json,observed_at_utc,created_at_utc,updated_at_utc)
    VALUES (?,5,'mt5',?,?,?,?,?,?,?,?,?,180,?,?,?,?,?)`, [id, fact.ticket, fact.orderTicket, fact.positionId, fact.dealKind,
    fact.entryKind, fact.side, fact.volume, fact.price, new Date(fact.occurredAtUtcMsc), fact.evidenceHash, fact.evidenceJson, now, now, now])
  const count = async () => Number((await connection.query('SELECT COUNT(*) n FROM terminal_history_deal_provenance_v4'))[0][0].n)
  await connection.beginTransaction()
  await persistHistoryDealProvenance(connection, input)
  await connection.rollback()
  assert.equal(await count(), 0); checks.push('provenance-rollback-with-caller-transaction')
  await connection.beginTransaction()
  const first = await persistHistoryDealProvenance(connection, input)
  await connection.commit()
  await connection.beginTransaction()
  assert.deepEqual(await persistHistoryDealProvenance(connection, { ...input, receivedAt: new Date(now.getTime()+100) }), { id: first.id, created: false })
  await connection.commit()
  assert.equal(await count(), 1); checks.push('same-deal-response-replay-one-association')
  const changed = structuredClone(input); changed.response.payload.source_revision = 'other'
  await connection.beginTransaction()
  await assert.rejects(persistHistoryDealProvenance(connection, changed), { message: 'trade_history_provenance_conflict' })
  await connection.rollback(); checks.push('same-response-different-provenance-rejected')
  for (const mutation of ["terminal_history_deal_id='missing'", 'trading_account_id=999999', 'user_id=999999']) {
    await connection.beginTransaction()
    try { await assert.rejects(connection.query(`UPDATE terminal_history_deal_provenance_v4 SET ${mutation}`), { code: 'ER_NO_REFERENCED_ROW_2' }) }
    finally { await connection.rollback() }
  }
  checks.push('actual-deal-account-user-foreign-keys')
  for (const mutation of ['connection_epoch=0', 'ownership_revision=0', "fact_sha256=REPEAT('A',64)"]) {
    await connection.beginTransaction()
    try { await assert.rejects(connection.query(`UPDATE terminal_history_deal_provenance_v4 SET ${mutation}`)) }
    finally { await connection.rollback() }
  }
  checks.push('positive-revisions-and-case-sensitive-hash-constraints')
  return { passed: true, checks, canonicalDdl: definition['Create Table'], migrationSha256: sha256(sql), collectorIntegrationVerified: false }
}

export async function verifyHistoryDealCollectorReference(connection, repository, route, now, inject) {
  await connection.query("UPDATE trade_history_sync_states_v4 SET status='syncing' WHERE trading_account_id=5")
  const raw = { ticket: '12345', type: 'buy', entry: 'in', time_msc: now.getTime()-500, volume: '1', price: '2500' }
  const response = { v: 4, type: 'query.response', message_id: 'collector-response-1', correlation_id: 'collector-query-1', sent_at_utc_msc: now.getTime(),
    route: { terminal_instance_id: route.terminalInstanceId, account_ref: { broker_server: route.brokerServer, login: route.login }, connection_epoch: route.connectionEpoch },
    payload: { request_id: 'collector-request-1', resource: 'history.deals', source: 'terminal', source_revision: 'collector-r1', observed_at_utc_msc: now.getTime()-1,
      items: [raw], has_more: false, next_cursor: null } }
  const state = async () => {
    const [[facts]] = await connection.query("SELECT COUNT(*) n FROM terminal_history_deals_v4 WHERE deal_ticket='12345'")
    const [[provenance]] = await connection.query("SELECT COUNT(*) n FROM terminal_history_deal_provenance_v4 WHERE response_message_id='collector-response-1'")
    const [[sync]] = await connection.query('SELECT status,history_revision,updated_at_utc FROM trade_history_sync_states_v4 WHERE trading_account_id=5')
    return { facts: Number(facts.n), provenance: Number(provenance.n), sync: { ...sync } }
  }
  const before = await state()
  inject('deal-provenance-before-commit')
  await assert.rejects(repository.persistPage(route, 'history.deals', response, now), { message: 'injected_deal_provenance_failure' })
  assert.deepEqual(await state(), before)
  await repository.persistPage(route, 'history.deals', response, now)
  const committed = await state()
  assert.equal(committed.facts, 1); assert.equal(committed.provenance, 1)
  assert.equal(committed.sync.status, 'syncing')
  await repository.persistPage(route, 'history.deals', response, now)
  assert.deepEqual(await state(), committed)
  return { passed: true, checks: ['actual-persist-page-fact-provenance-and-sync-rollback', 'actual-persist-page-commit-and-idempotent-provenance'],
    platform: 'mt5', closedPositionProjectionVerified: false }
}
