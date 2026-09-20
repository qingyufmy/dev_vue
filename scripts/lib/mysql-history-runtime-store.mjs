import { hash } from './v4-backfill-contract.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { loadHistoryRuntimeUpgrade, historyRuntimePlanHash } from './history-runtime-upgrade.mjs'
import { inspectHistoryRuntimeUpgrade } from './history-runtime-coordinator.mjs'
import { assertHistoryProvenanceConnection } from './mysql-history-provenance-store.mjs'
import { mysqlColumnStore, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { readAccountRootSnapshot } from './mysql-account-root-snapshot.mjs'
import { legacyCandlePromotionSnapshot } from './legacy-candle-promotion.mjs'

const tables = new Set(['trade_history_sync_states_v4', 'terminal_history_orders_v4', 'terminal_history_deals_v4',
  'account_trade_records_v4', 'account_trade_record_deals_v4', 'account_trade_attributions_v4',
  'account_trade_daily_summaries_v4', 'terminal_history_order_provenance_v4'])
const check = (value, code) => { if (!value) throw Error(`history_runtime_store_${code}`) }

export async function assertHistoryRuntimeParents(connection) {
  const [rows] = await connection.query(`SELECT c.TABLE_NAME tableName,c.COLUMN_TYPE columnType,c.COLLATION_NAME collationName,
    c.IS_NULLABLE nullable,t.ENGINE engine,c.COLUMN_KEY columnKey
    FROM information_schema.COLUMNS c INNER JOIN information_schema.TABLES t ON t.TABLE_SCHEMA=c.TABLE_SCHEMA AND t.TABLE_NAME=c.TABLE_NAME
    WHERE c.TABLE_SCHEMA=DATABASE() AND c.TABLE_NAME IN ('users','trading_accounts','trading_account_ownership_intervals') AND c.COLUMN_NAME='id'`)
  const expected = { users: 'int', trading_accounts: 'bigint unsigned', trading_account_ownership_intervals: 'char(36)' }
  check(rows.length === 3 && new Set(rows.map(row => row.tableName)).size === 3 && rows.every(row =>
    row.columnType === expected[row.tableName] && row.nullable === 'NO' && row.engine === 'InnoDB' && row.columnKey === 'PRI'
      && (row.tableName !== 'trading_account_ownership_intervals' || row.collationName === 'ascii_bin')), 'parents_unready')
}

export async function readHistoryRuntimeTable(connection, table) {
  check(tables.has(table), 'table_scope')
  const [objects] = await connection.execute('SELECT TABLE_TYPE kind,ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table])
  if (!objects.length) return null
  check(objects.length === 1 && objects[0].kind === 'BASE TABLE' && objects[0].engine === 'InnoDB', 'table_kind')
  const [[definition]] = await connection.query(`SHOW CREATE TABLE \`${table}\``)
  const ddl = definition?.['Create Table']
  check(typeof ddl === 'string' && ddl.startsWith(`CREATE TABLE \`${table}\` (`), 'definition')
  const [triggers] = await connection.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [table])
  check(triggers.length === 0, 'triggers')
  const [[count]] = await connection.query(`SELECT CAST(COUNT(*) AS CHAR) n FROM \`${table}\``)
  check(/^(0|[1-9][0-9]*)$/.test(count?.n ?? '') && Number.isSafeInteger(Number(count.n)), 'row_count')
  return { hash: tableDefinitionHash(ddl), rows: Number(count.n), ddl }
}

// A durable baseline is captured once after verifying the original 176 steps and reused on resume.
export async function mysqlHistoryRuntimeStore(connection, plan, root, { reference, baseline, verifyPrior }) {
  check(baseline?.kind === 'history-runtime-baseline/v1' && baseline.priorHistory?.length === 176
    && Array.isArray(baseline.protectedSnapshot) && baseline.protectedSnapshot.length > 0
    && baseline.protectedSnapshot.every(row => !tables.has(row.name)) && typeof verifyPrior === 'function', 'baseline')
  // Keep caller-owned objects from changing the accepted plan or baseline during awaits.
  plan = structuredClone({ steps: plan.steps, added: plan.added, prior: { steps: plan.prior.steps },
    finalTableHashes: plan.finalTableHashes, referenceHash: plan.referenceHash })
  baseline = structuredClone(baseline); reference = structuredClone(reference)
  const guard = () => assertHistoryProvenanceConnection(connection, baseline.identity)
  await guard()
  const journal = mysqlColumnStore(connection, true)
  const verifyPlan = async candidate => {
    await guard()
    await assertHistoryRuntimeParents(connection)
    check(historyRuntimePlanHash(candidate) === historyRuntimePlanHash(plan)
      && historyRuntimePlanHash(plan) === historyRuntimePlanHash(await loadHistoryRuntimeUpgrade(root, reference)), 'plan_drift')
    check(await verifyInplaceJournal(connection), 'journal_missing')
  }
  const store = {
    verifyPlan,
    async history() { await guard(); return journal.history() },
    async verifyPrior(rows) {
      check(hash(rows) === hash(baseline.priorHistory), 'prior_history_changed')
      const result = await verifyPrior(rows, structuredClone(baseline.protectedSnapshot))
      check(result?.status === 'completed', 'prior_unverified')
    },
    async verifyProtected() {
      await guard()
      const snapshot = legacyCandlePromotionSnapshot((await readAccountRootSnapshot(connection)).tables)
        .filter(row => !tables.has(row.name))
      check(hash(snapshot) === hash(baseline.protectedSnapshot), 'protected_changed')
    },
    async tableState(table) { await guard(); return readHistoryRuntimeTable(connection, table) },
    async begin(step) {
      step = structuredClone(step)
      await beforeMutation(step, 'pending', false)
      await guard(); await journal.begin(step)
    },
    async execute(step) {
      step = structuredClone(step)
      await beforeMutation(step, 'pending', true)
      await guard(); await connection.query(step.sql)
    },
    async complete(step) {
      step = structuredClone(step)
      await beforeMutation(step, 'reconcile', true)
      await guard(); await journal.complete(step)
    },
  }
  const beforeMutation = async (step, status, recorded) => {
    const accepted = plan.added.find(item => item.id === step.id)
    check(accepted !== undefined && hash(step) === hash(accepted), 'step')
    const state = await inspectHistoryRuntimeUpgrade(store, plan)
    check(state.status === status && state.step?.id === step.id && state.recorded === recorded, 'mutation_precondition')
  }
  await verifyPlan(plan)
  return store
}
