import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
import { loadWalletAddressCoordinator } from './inplace-wallet-address-schema.mjs'
import { orderedSchemaStep } from './inplace-ordered-schema-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

export async function loadSettingsCoordinator(root) {
  const read = path => readFile(new URL(path, root), 'utf8')
  const proof = JSON.parse(await read('docs/migration/dev-vue-settings-schema-probe-20260907.json'))
  const tokens = JSON.parse(await read('docs/migration/dev-vue-settings-tokens-probe-20260907.json'))
  const check = (ok, code) => { if (!ok) throw Error(code) }
  for (const result of [proof, tokens]) check(result.identity.db === 'dev_vue_m1_a'
    && result.identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104' && result.rolledBack, 'inplace_settings_reference')
  check(proof.kind === 'settings-schema-probe/v1' && proof.definitions.length === 2 && proof.acceptedRows === 3
    && proof.rejected.length === 13 && proof.auditRequestUnique && proof.exactPrecision
    && Number(proof.counts.settings) === 0 && Number(proof.counts.changes) === 0, 'inplace_settings_reference')
  check(tokens.kind === 'settings-exact-tokens-probe/v1' && tokens.regexBoundaryObserved
    && tokens.rejected.length === 7 && tokens.remainingRows === 0, 'inplace_settings_tokens')
  const additions = []
  for (const [i, table, file] of [[0,'system_settings','018_system_settings.sql'],[1,'system_setting_changes','019_system_setting_changes.sql']]) {
    const definition = proof.definitions[i]
    const raw = await read(`server/db/migrations/inplace/${file}`)
    check(definition.table === table && definition.file === file && definition.sourceSqlSha256 === sha256(raw), 'inplace_settings_sql')
    additions.push(orderedSchemaStep({id:`inplace_017_0${i+1}_${table}`,table,sql:definition.ddl,beforeHash:null,afterHash:tableDefinitionHash(definition.ddl)}))
  }
  const correction = await read('server/db/migrations/inplace/020_system_settings_exact_tokens.sql')
  check(tokens.sourceSqlSha256 === sha256(correction) && tokens.sourceSqlSha256 === 'ccaf209f262d3cad427090daa114ef5e04370efc6ad1400ac27350f02410ea10'
    && tableDefinitionHash(tokens.beforeDdl) === additions[0].afterHash, 'inplace_settings_token_chain')
  const statements = splitSqlStatements(correction)
  check(statements.length === 1, 'inplace_settings_token_sql')
  // Exact evidence-bound CHECK addition; do not broaden the older FK-only helper.
  check(statements[0].startsWith('ALTER TABLE system_settings\n  ADD CONSTRAINT chk_system_setting_exact_tokens CHECK ('), 'inplace_settings_token_sql')
  const correctionStep = {id:'inplace_017_03_system_settings_exact_tokens',table:'system_settings',sql:statements[0],
    beforeHash:tableDefinitionHash(tokens.beforeDdl),afterHash:tableDefinitionHash(tokens.afterDdl)}
  check(correctionStep.beforeHash !== correctionStep.afterHash, 'inplace_settings_token_no_change')
  additions.push(Object.freeze({...correctionStep,checksum:sha256(JSON.stringify(correctionStep))}))
  const prior = await loadWalletAddressCoordinator(root)
  return {referralRuleReference:prior.referralRuleReference,steps:[...prior.steps,...additions],
    transitions:[...prior.transitions,...additions.map(step=>({step,key:step.table,before:step.beforeHash,after:step.afterHash}))],
    store(connection) {
      const base=prior.store(connection)
      return {...base,async tableHash(name){
        if(!['system_settings','system_setting_changes'].includes(name)) return base.tableHash(name)
        const [tables]=await connection.execute('SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[name])
        if(!tables.length)return null
        check(tables.length===1 && tables[0].type==='BASE TABLE','inplace_settings_table')
        const [triggers]=await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?',[name])
        check(triggers.length===0,'inplace_settings_trigger')
        const [[row]]=await connection.query(`SHOW CREATE TABLE ${name}`)
        return tableDefinitionHash(row['Create Table'])
      }}
    }}
}
