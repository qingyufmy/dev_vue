import { canonicalEvidence } from '../../server/dist-v4/modules/trade-history/index.js'
import assert from 'node:assert/strict'
import { createStrategyReferenceEvidenceReader, createStrategyReferencePortfolioReader } from '../../server/dist-v4/bootstrap/strategy-reference-evidence.js'
import { verifyAnalysisSourceReference } from './analysis-source-reference.mjs'
import { verifyPendingOriginReference } from './pending-origin-reference.mjs'

// The outer probe owns this isolated connection and its temporary tables.
export async function verifyStrategyReferenceSourceReference(connection, route) {
  const checks = []
  let releases = 0
  const lease = new Proxy(connection, { get(target, key) {
    if (key === 'release') return () => { releases += 1 }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const reader = createStrategyReferenceEvidenceReader({ async getConnection() { return lease } }, { async current() { return route } })
  const portfolio = createStrategyReferencePortfolioReader({ async getConnection() { return lease } }, {
    async current() { return {...route,ownershipRevision:'1',sessionId:'reference-session',timezoneOffsetMinutes:180} },
  })
  await verifyAnalysisSourceReference(connection, async scope => {
    const read = patch => reader.read({ ...scope, asOf: new Date().toISOString(), ...patch })
    const readPortfolio = patch => portfolio.read({...scope,targetAccountId:'8',traderStrategyId:'22',asOf:new Date().toISOString(),...patch})
    const value = await read()
    assert.equal(value.source.sourceAccountId, '9')
    assert.equal(value.inventory.authorization.accountId, '9')
    assert.deepEqual(value.inventory.positions, { revision: 5, observedAt: value.inventory.observedAt, items: [] })
    assert.equal(new Date(value.inventory.positions.observedAt).toISOString(), value.inventory.positions.observedAt)
    assert.deepEqual(value.inventory.pendingOrders, { revision: 6, items: [] })
    assert.deepEqual(value.pendingOrigins, [])
    checks.push('actual-source-and-inventory-adapters-in-one-read-only-transaction')
    for (const patch of [{ userId: 71 }, { analysisStrategyId: '60002' }, { symbol: 'EURUSD' }]) {
      await assert.rejects(read(patch), { code: 'strategy_reference_source_unavailable' })
    }
    checks.push('analysis-scope-denials')
    await connection.query('UPDATE observer_channels SET active=0')
    try { await assert.rejects(read(), { code: 'strategy_reference_inventory_unavailable' }) }
    finally { await connection.query('UPDATE observer_channels SET active=1') }
    checks.push('current-observation-revocation-denied')
    await connection.query("UPDATE bridge_connection_sessions SET disconnected_at_utc=UTC_TIMESTAMP(3)")
    try { await assert.rejects(read(), { code: 'strategy_reference_inventory_unavailable' }) }
    finally { await connection.query('UPDATE bridge_connection_sessions SET disconnected_at_utc=NULL') }
    checks.push('disconnected-inventory-denied')
    assert.equal((await read()).source.sourceAccountId, '9')
    assert.equal(releases, 7)
    checks.push('connection-reusable-after-success-and-denial')
    const empty = await readPortfolio()
    assert.equal(empty.state,'ready');assert.equal(empty.sourceAccountId,'9')
    assert.deepEqual(empty.positions,[]);assert.deepEqual(empty.pendingOrders,[])
    checks.push('actual-portfolio-bootstrap-empty-authorized-inventory-ready')
    await verifyPendingOriginReference(connection, {}, async () => {
      const pending = { accountId: '9', ticket: '91', revision: 6, symbol: 'XAUUSD', type: 'buy_limit', volume: '0.1',
        price: '2500', stopLoss: '2490', takeProfit: '2520', createdAt: '2026-09-10T00:00:00.000Z', expiresAt: null,
        source: 'unknown', signalId: null }
      await connection.execute('INSERT INTO pending_order_snapshots VALUES (9,91,6,?)', [JSON.stringify(pending)])
      try {
        const result = await read()
        assert.equal(result.inventory.pendingOrders.items.length, 1)
        assert.deepEqual(result.pendingOrigins, [{ ticket: '91', status: 'unresolved' }])
        await assert.rejects(readPortfolio(),{code:'strategy_reference_portfolio_unavailable'})
        checks.push('actual-portfolio-bootstrap-unresolved-pending-origin-denied')
        checks.push('actual-bootstrap-same-ticket-on-other-account-remains-unresolved')
        await connection.query('DELETE FROM pending_order_snapshots WHERE trading_account_id=9 AND ticket=91')
        await connection.execute('INSERT INTO pending_order_snapshots VALUES (9,92,6,?)', [JSON.stringify({ ...pending, ticket: '92' })])
        for (const table of ['execution_intents', 'bridge_commands_v4']) {
          await connection.query(`UPDATE ${table} SET user_id=70,trading_account_id=9`)
        }
        await connection.query('UPDATE execution_outcomes SET trading_account_id=9')
        await connection.query('UPDATE execution_distribution_targets SET target_user_id=70,trading_account_id=9')
        // Historical terminal evidence must match the observed source route, including padded login.
        await connection.query("UPDATE bridge_commands_v4 SET terminal_instance_id='terminal',broker_server='broker',account_login='0007'")
        assert.deepEqual((await read()).pendingOrigins, [{ ticket: '92', status: 'strategy', userId: 70, accountId: '9', strategyId: '22' }])
        checks.push('actual-bootstrap-source-distribution-creation-attributed')
        const ready = await readPortfolio()
        assert.equal(ready.state,'ready');assert.equal(ready.pendingOrders.length,1)
        assert.match(ready.pendingOrders[0].referenceId,/^pending:[a-f0-9]{64}$/)
        assert.equal(ready.pendingOrders[0].entryPrice,'2500')
        assert.equal(ready.scope.targetAccountId,'8');assert.equal(ready.sourceAccountId,'9')
        assert.equal(Object.hasOwn(ready.pendingOrders[0],'ticket'),false)
        assert.deepEqual((await readPortfolio({traderStrategyId:'23'})).pendingOrders,[])
        checks.push('actual-portfolio-bootstrap-strategy-filter-and-non-executable-reference-id')
        await connection.query('DELETE FROM pending_order_snapshots WHERE trading_account_id=9 AND ticket=92')
        await connection.query('CREATE TEMPORARY TABLE terminal_history_deals_v4 (trading_account_id BIGINT,platform VARCHAR(4),deal_ticket VARCHAR(64),position_id VARCHAR(64),occurred_at_utc DATETIME(3),evidence_sha256 CHAR(64),evidence_json JSON) ENGINE=InnoDB')
        try {
          const observed = (await read()).inventory.positions.observedAt
          const raw = { ticket:'101',order:'92',position_id:'100',symbol:'XAUUSD',type:'buy',entry:'in',volume:'0.1',price:'2500',time_msc:Date.parse(observed)-500 }
          const evidence=canonicalEvidence(raw)
          await connection.execute('INSERT INTO terminal_history_deals_v4 VALUES (9,?,?,?,?,?,?)',['mt5','101','100',new Date(raw.time_msc),evidence.hash,evidence.json])
          const position={accountId:'9',ticket:'10',positionIdentifier:'100',revision:5,symbol:'XAUUSD',side:'buy',volume:'0.1',openPrice:'2500',currentPrice:'2500',stopLoss:null,takeProfit:null,floatingProfit:'0',openedAt:new Date(raw.time_msc).toISOString(),source:'unknown',signalId:null}
          await connection.execute('INSERT INTO open_position_snapshots VALUES (9,10,5,?)',[JSON.stringify(position)])
          const expected={status:'read',items:[{ticket:'10',status:'creation_strategy_matched',strategyId:'22',orderTickets:['92'],creationDecisions:null}]}
          assert.deepEqual((await read()).positionOrigins,expected)
          await connection.query("UPDATE execution_intents SET action_kind='market_order' WHERE id='intent-2'")
          assert.deepEqual((await read()).positionOrigins,expected)
          await connection.execute('UPDATE execution_outcomes SET result_json=? WHERE id=?',[JSON.stringify({position_ticket:'92',ticket:'92'}),'outcome-2'])
          assert.deepEqual((await read()).positionOrigins,{status:'read',items:[{ticket:'10',status:'unresolved',reason:'order_origin_missing'}]})
          checks.push('actual-bootstrap-position-history-and-pending-or-market-creation-same-snapshot')
        } finally {
          await connection.query('DELETE FROM open_position_snapshots WHERE trading_account_id=9 AND ticket=10')
          await connection.query('DROP TEMPORARY TABLE terminal_history_deals_v4')
        }
      } finally { await connection.query('DELETE FROM pending_order_snapshots WHERE trading_account_id=9 AND ticket IN (91,92)') }
    })
    assert.equal(releases, 17)
  })
  return { passed: true, checks, releases, schema: 'isolated-temporary-minimal-fixtures',
    poolLease: 'single-outer-owned-real-connection-with-release-counter',
    routeEvidence: 'injected-reference-route-not-live-redis', positionCreationVerified: true, executionAttributionVerified: false }
}
