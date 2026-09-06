import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { loadPaymentOrderCoordinator } from './inplace-payment-order-schema.mjs'
import { orderedSchemaStep } from './inplace-ordered-schema-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

export async function loadPaymentMatchCoordinator(root) {
  const proof = JSON.parse(await readFile(new URL('docs/migration/dev-vue-payment-match-schema-probe-20260907.json', root), 'utf8'))
  const raw = await readFile(new URL('server/db/migrations/inplace/013_payment_matches.sql', root), 'utf8')
  const names = ['payment_transactions', 'payment_matches']
  if (proof.kind !== 'payment-match-schema-probe/v1' || proof.identity.db !== 'dev_vue_m1_a'
    || proof.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104' || proof.sourceSqlSha256 !== sha256(raw)
    || proof.rolledBack !== true || proof.acceptedTransactions !== 2 || proof.acceptedMatches !== 3
    || proof.rejectedCases.length !== 18 || proof.amountDifferencePreserved !== true
    || !['matches_count', 'transactions_count', 'orders_count'].every(key => proof.counts[key] === 0)
    || proof.definitions.length !== 2 || splitSqlStatements(raw).length !== 2) throw new Error('inplace_payment_match_reference_invalid')
  const added = names.map((table, i) => {
    const definition = proof.definitions[i]
    if (definition.table !== table || !definition.ddl.startsWith(`CREATE TABLE \`${table}\` (`)) throw new Error('inplace_payment_match_definition_invalid')
    return orderedSchemaStep({ id: `inplace_012_0${i + 1}_${table}`, table, sql: definition.ddl,
      beforeHash: null, afterHash: tableDefinitionHash(definition.ddl) })
  })
  const prior = await loadPaymentOrderCoordinator(root)
  return { steps: [...prior.steps, ...added], transitions: [...prior.transitions, ...added.map(step => ({ step, key: step.table, before: null, after: step.afterHash }))],
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (!names.includes(name)) return base.tableHash(name)
        const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
        if (!tables.length) return null
        if (tables.length !== 1 || tables[0].type !== 'BASE TABLE') throw new Error('inplace_payment_match_table_conflict')
        const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
        if (triggers.length) throw new Error('inplace_payment_match_trigger_conflict')
        const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
        return tableDefinitionHash(row['Create Table'])
      } }
    } }
}
