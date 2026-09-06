import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { loadReferralLedgerCoordinator } from './inplace-referral-ledger-schema.mjs'
import { orderedSchemaStep } from './inplace-ordered-schema-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

export async function loadPaymentOrderCoordinator(root) {
  const proof = JSON.parse(await readFile(new URL('docs/migration/dev-vue-payment-order-schema-probe-20260907.json', root), 'utf8'))
  const raw = await readFile(new URL('server/db/migrations/inplace/012_payment_orders.sql', root), 'utf8')
  if (proof.kind !== 'payment-order-schema-probe/v1' || proof.identity.db !== 'dev_vue_m1_a'
    || proof.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104' || proof.sourceSqlSha256 !== sha256(raw)
    || proof.rolledBack !== true || proof.paymentOrderRows !== 0 || proof.acceptedInserts !== 3 || proof.rejectedCases.length !== 14
    || !proof.ddl.startsWith('CREATE TABLE `payment_orders` (')) throw new Error('inplace_payment_order_reference_invalid')
  const statements = splitSqlStatements(raw)
  if (statements.length !== 1) throw new Error('inplace_payment_order_sql_invalid')
  const step = orderedSchemaStep({ id: 'inplace_011_01_payment_orders', table: 'payment_orders',
    sql: proof.ddl, beforeHash: null, afterHash: tableDefinitionHash(proof.ddl) })
  const prior = await loadReferralLedgerCoordinator(root)
  return { steps: [...prior.steps, step], transitions: [...prior.transitions, { step, key: step.table, before: null, after: step.afterHash }],
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (name !== step.table) return base.tableHash(name)
        const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
        if (!tables.length) return null
        if (tables.length !== 1 || tables[0].type !== 'BASE TABLE') throw new Error('inplace_payment_order_table_conflict')
        const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
        if (triggers.length) throw new Error('inplace_payment_order_trigger_conflict')
        const [[row]] = await connection.query('SHOW CREATE TABLE `payment_orders`')
        return tableDefinitionHash(row['Create Table'])
      } }
    } }
}
