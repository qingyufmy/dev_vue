import { hash } from './v4-backfill-contract.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { loadRiskPolicyReceiptUpgrade, riskReceiptPlanHash } from './risk-policy-receipt-upgrade.mjs'
import { mysqlColumnStore, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { readAccountRootSnapshot } from './mysql-account-root-snapshot.mjs'
import { legacyCandlePromotionSnapshot } from './legacy-candle-promotion.mjs'

const table = 'risk_policy_write_receipts'
const check = (value, code) => { if (!value) throw Error('risk_receipt_store_' + code) }
export async function assertRiskReceiptConnection(connection, expectedIdentity) {
  check(['dev_vue', 'dev_vue_m1_source_20260909_01'].includes(expectedIdentity?.database)
    && expectedIdentity.serverUuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'target')
  const [[row]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone timezone,CONNECTION_ID() id,CURRENT_USER() principal')
  check(row.db === expectedIdentity.database && row.uuid === expectedIdentity.serverUuid && row.timezone === '+00:00'
    && typeof row.principal === 'string' && row.principal.startsWith('root@'), 'identity')
  const [[lock]] = await connection.execute('SELECT IS_USED_LOCK(?) owner', ['aurum:inplace:' + row.db])
  check(lock.owner !== null && String(lock.owner) === String(row.id), 'lock')
  const [[clients]] = await connection.query('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()')
  check(Number(clients.n) === 0, 'other_clients')
}

export async function readRiskReceiptTable(connection) {
  const [objects] = await connection.execute('SELECT TABLE_TYPE kind,ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table])
  if (!objects.length) return null
  check(objects.length === 1 && objects[0].kind === 'BASE TABLE' && objects[0].engine === 'InnoDB', 'table_kind')
  const [[definition]] = await connection.query('SHOW CREATE TABLE `risk_policy_write_receipts`')
  const ddl = definition?.['Create Table']
  check(typeof ddl === 'string' && ddl.startsWith('CREATE TABLE `risk_policy_write_receipts` ('), 'definition')
  const [triggers] = await connection.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [table])
  check(triggers.length === 0, 'triggers')
  const [[count]] = await connection.query('SELECT CAST(COUNT(*) AS CHAR) n FROM `risk_policy_write_receipts`')
  check(/^(0|[1-9][0-9]*)$/.test(count?.n ?? '') && Number.isSafeInteger(Number(count.n)), 'row_count')
  return { hash: tableDefinitionHash(ddl), rows: Number(count.n), ddl }
}

/** Baseline must be durably recorded after full 174-step verification; reuse it on resume. */
export async function mysqlRiskPolicyReceiptStore(connection, plan, root, { reference, baseline, verifyPrior }) {
  const guard = () => assertRiskReceiptConnection(connection, baseline.identity)
  await guard()
  check(typeof verifyPrior === 'function' && baseline.kind === 'risk-receipt-baseline/v1'
    && baseline.priorHistory?.length === 174 && Array.isArray(baseline.protectedSnapshot)
    && baseline.protectedSnapshot.length > 0 && baseline.protectedSnapshot.every(row => row.name !== table), 'baseline')
  const journal = mysqlColumnStore(connection, true)
  const priorIds = new Set(plan.prior.steps.map(step => step.id))
  const verifyPlan = async candidate => {
    await guard()
    check(riskReceiptPlanHash(candidate) === riskReceiptPlanHash(plan)
      && riskReceiptPlanHash(plan) === riskReceiptPlanHash(await loadRiskPolicyReceiptUpgrade(root, reference)), 'plan_drift')
    await verifyInplaceJournal(connection)
  }
  const history = async () => { await guard(); return journal.history() }
  const verifyPriorHistory = async rows => {
    check(hash(rows) === hash(baseline.priorHistory), 'prior_history_changed')
    const result = await verifyPrior(rows, baseline.protectedSnapshot)
    check(result?.status === 'completed', 'prior_unverified')
  }
  const verifyProtected = async () => {
    await guard()
    const snapshot = legacyCandlePromotionSnapshot((await readAccountRootSnapshot(connection)).tables)
      .filter(row => row.name !== table)
    check(hash(snapshot) === hash(baseline.protectedSnapshot), 'protected_changed')
  }
  const beforeMutation = async step => {
    check(hash(step) === hash(plan.step), 'step')
    await verifyPlan(plan)
    await verifyPriorHistory((await history()).filter(row => priorIds.has(row.id)))
    await verifyProtected()
  }
  await verifyPlan(plan)
  return { verifyPlan, history, verifyPrior: verifyPriorHistory, verifyProtected,
    tableState: async () => { await guard(); return readRiskReceiptTable(connection) },
    async begin(step) {
      await beforeMutation(step)
      check(!(await history()).some(row => row.id === step.id) && await readRiskReceiptTable(connection) === null, 'begin_precondition')
      await journal.begin(step)
    },
    async execute(step) {
      await beforeMutation(step)
      const entry = (await history()).find(row => row.id === step.id)
      check(entry?.status === 'started' && entry.checksum === step.checksum && await readRiskReceiptTable(connection) === null, 'ddl_precondition')
      await guard(); await connection.query(step.sql)
    },
    async complete(step) {
      await beforeMutation(step)
      const state = await readRiskReceiptTable(connection)
      check(state?.hash === step.afterHash && state.rows === 0, 'complete_precondition')
      await guard(); await journal.complete(step)
    },
  }
}
