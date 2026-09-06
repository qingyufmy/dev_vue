import { readFile } from 'node:fs/promises'
import { loadSettingsCoordinator } from './inplace-settings-schema.mjs'
import { verifyOriginalSchemaWithReferralRules } from './inplace-referral-rule-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { readOriginalRows, validateColumnEvidence } from './inplace-column-evidence.mjs'
import { verifyInplaceJournal, withInplaceUpgradeLock } from './mysql-inplace-column-store.mjs'
const root = new URL('../../', import.meta.url)
const check = (ok, code) => { if (!ok) throw new Error(code) }

export async function executeSettingsUpgrade(connection, { database, apply = false, injectAfterDdl = false }) {
  check(database === 'dev_vue_m1_source_20260907_02', 'settings_upgrade_scope')
  check(!injectAfterDdl || (apply && database !== 'dev_vue'), 'settings_upgrade_fault_scope')
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root)))
  const evidence = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json', root)))
  validateColumnEvidence(backup, evidence)
  const plan = await loadSettingsCoordinator(root)
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === database && identity.uuid === backup.serverUuid, 'settings_upgrade_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  return withInplaceUpgradeLock(connection, database, async () => {
    check(await verifyInplaceJournal(connection), 'settings_upgrade_journal')
    const store = plan.store(connection)
    const planned = await coordinateInplaceSchema(store, plan)
    check(planned.steps.slice(0, -3).every(step => step.status === 'completed'), 'settings_upgrade_prerequisites')
    const tables = [...new Set(plan.steps.filter(step => !step.column).map(step => step.table))]
    const verifyOriginal = async () => {
      await verifyOriginalSchemaWithReferralRules(connection, backup.schemaSha256, tables, plan.referralRuleReference)
      check(JSON.stringify(await readOriginalRows(connection, evidence.originalColumns)) === JSON.stringify(evidence.parity), 'settings_upgrade_original_rows')
    }
    await verifyOriginal()
    const addedTables = []
    for (const name of tables.filter(name => !['system_settings', 'system_setting_changes'].includes(name))) {
      const [columns] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name])
      const [primary] = await connection.execute("SELECT COLUMN_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [name])
      addedTables.push({ name, columns: columns.map(row => row.name), primary: primary.map(row => row.name) })
    }
    const protectedBefore = await readOriginalRows(connection, addedTables)
    const readSettings = async () => {
      const states = {}
      for (const name of ['system_settings','system_setting_changes']) {
        const [[exists]] = await connection.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[name])
        if (!Number(exists.n)) { states[name]=null;continue }
        const [columns] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[name])
        const [primary] = await connection.execute("SELECT COLUMN_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX",[name])
        states[name]=await readOriginalRows(connection,[{name,columns:columns.map(r=>r.name),primary:primary.map(r=>r.name)}])
      }
      return states
    }
    const settingsBefore = await readSettings(), faultSteps=[]
    let ddlCount=0
    const wrapped={...store,execute:async sql=>{
      const step=plan.steps.slice(-3).find(step=>step.sql===sql)
      check(step,'settings_upgrade_unexpected_ddl')
      await store.execute(sql);ddlCount++
      if(injectAfterDdl){faultSteps.push(step.id);throw Error('settings_upgrade_injected_after_ddl')}
    }}
    let result
    for(let attempt=0;attempt<4;attempt++) {
      try{result=await coordinateInplaceSchema(wrapped,plan,{apply});break}
      catch(error){
        if(!injectAfterDdl || error.message!=='settings_upgrade_injected_after_ddl')throw error
        const recovery=await coordinateInplaceSchema(store,plan)
        check(recovery.steps.find(step=>step.id===faultSteps.at(-1))?.status==='reconcile','settings_upgrade_recovery_state')
      }
    }
    check(result,'settings_upgrade_unfinished')
    if(injectAfterDdl)check(ddlCount===3 && new Set(faultSteps).size===3,'settings_upgrade_fault_not_exercised')
    if (apply) {
      const repeated = await coordinateInplaceSchema(wrapped, plan, { apply: true })
      check(repeated.steps.every(step => step.status === 'completed'), 'settings_upgrade_repeat')
      const [revisions] = await connection.query('SELECT CAST(revision AS CHAR) revision FROM referral_rules ORDER BY id')
      check(revisions.length === 4 && revisions.every(row => row.revision === '1'), 'settings_upgrade_revision')
    }
    await verifyOriginal()
    const settingsAfter=await readSettings()
    for(const name of Object.keys(settingsBefore)) {
      if(settingsBefore[name]!==null)check(JSON.stringify(settingsAfter[name])===JSON.stringify(settingsBefore[name]),'settings_upgrade_setting_rows')
      else if(apply)check(settingsAfter[name].every(row=>String(row.rows)==='0'),'settings_upgrade_setting_not_empty')
    }
    check(JSON.stringify(await readOriginalRows(connection, addedTables)) === JSON.stringify(protectedBefore), 'settings_upgrade_protected_rows')
    return { kind: 'settings-upgrade/v1', identity, apply, schemaSteps: plan.steps.length, result, ddlCount,
      faultSteps, originalRows: backup.parity.rows, protectedBefore, originalRowsVerified: true,
      protectedRowsVerified: true, repeated: apply, businessConsumersSwitched: false }
  })
}
