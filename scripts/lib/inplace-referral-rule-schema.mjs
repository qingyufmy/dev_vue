import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { loadMembershipCoordinator } from './inplace-membership-schema.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './inplace-user-defaults.mjs'

export async function loadReferralRuleCoordinator(root) {
  const proof = JSON.parse(await readFile(new URL('docs/migration/dev-vue-referral-rule-schema-probe-20260907.json', root), 'utf8'))
  const source = JSON.parse(await readFile(new URL('docs/migration/dev-vue-referral-rule-schema-source-20260907.json', root), 'utf8'))
  const raw = await readFile(new URL('server/db/migrations/inplace/015_referral_rule_constraints.sql', root), 'utf8')
  const expectedCases = ['negative_rate', 'excess_rate', 'negative_enabled', 'excess_enabled', 'zero_revision']
  if (proof.kind !== 'referral-rule-schema-probe/v1' || proof.identity.db !== 'dev_vue_m1_a'
    || proof.identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104'
    || proof.sourceSqlSha256 !== sha256(raw) || proof.sourceSqlSha256 !== '5ea8da14048762e719341737b5a81d20f36cca9a052d2f040beee2cd71ec86be'
    || !proof.boundaryAccepted || !proof.probesRolledBack || proof.preservedRows !== 4
    || proof.sourceRowsSha256 !== sha256(JSON.stringify(source.rows))
    || tableDefinitionHash(source.ddl) !== tableDefinitionHash(proof.beforeDdl)
    || JSON.stringify(proof.rejectedCases.map(item => item.name)) !== JSON.stringify(expectedCases)
    || proof.rejectedCases.some(item => item.code !== 'ER_CHECK_CONSTRAINT_VIOLATED')) throw new Error('inplace_referral_rule_reference_invalid')
  const statements = splitSqlStatements(raw)
  if (statements.length !== 1) throw new Error('inplace_referral_rule_sql_invalid')
  const value = { id: 'inplace_014_01_referral_rule_constraints', table: 'referral_rules', sql: statements[0],
    beforeHash: tableDefinitionHash(proof.beforeDdl), afterHash: tableDefinitionHash(proof.afterDdl) }
  const step = Object.freeze({ ...value, checksum: sha256(JSON.stringify(value)) })
  const prior = await loadMembershipCoordinator(root)
  return { steps: [...prior.steps, step], transitions: [...prior.transitions, { step, key: step.table, before: step.beforeHash, after: step.afterHash }],
    referralRuleReference: proof,
    store(connection) {
      const base = prior.store(connection)
      return { ...base, async tableHash(name) {
        if (name !== step.table) return base.tableHash(name)
        const [tables] = await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
        if (tables.length !== 1 || tables[0].type !== 'BASE TABLE') throw new Error('inplace_referral_rule_table_conflict')
        const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
        if (triggers.length) throw new Error('inplace_referral_rule_trigger_conflict')
        const [[row]] = await connection.query('SHOW CREATE TABLE `referral_rules`')
        return tableDefinitionHash(row['Create Table'])
      } }
    } }
}

// Accept only the two complete reviewed definitions; never remove arbitrary
// columns/constraints to make a fingerprint pass. The journal decides which is valid.
export function originalReferralRuleDefinition(ddl, reference) {
  const actual = tableDefinitionHash(ddl)
  if (![reference.beforeDdl, reference.afterDdl].some(value => tableDefinitionHash(value) === actual))
    throw new Error('inplace_referral_rule_definition_conflict')
  return reference.beforeDdl
}

export function verifyOriginalSchemaWithReferralRules(connection, hash, excluded, reference) {
  return verifyOriginalSchemaWithUserDefaults({ query: async (...args) => {
    const result = await connection.query(...args)
    if (args[0] !== 'SHOW CREATE TABLE `referral_rules`') return result
    return [result[0].map(row => ({ ...row, 'Create Table': originalReferralRuleDefinition(row['Create Table'], reference) })), result[1]]
  } }, hash, excluded.filter(name => name !== 'referral_rules'))
}
