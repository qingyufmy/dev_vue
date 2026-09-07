import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { persistCredentialPlan } from './lib/v4-settings-credential-plan.mjs'
import { readFile, unlink } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { BackfillError, canonical, hash, streamIdentity } from './lib/v4-backfill-contract.mjs'
import { createCredentialSettingsBackfill } from './lib/v4-settings-credential-backfill.mjs'
import { MysqlSettingsBackfillRepositoryV2, readSettingsTargetIdentityV2 } from './lib/mysql-settings-backfill-v2.mjs'
import { prepareBackfillRun, executeBackfillBatch, recoverBackfillBatch } from './lib/v4-settings-backfill-runner.mjs'
import { auditCredentialSettingsImport, settingsAuditFields } from './lib/v4-settings-credential-audit.mjs'
import { createCredentialSettingsWriter } from './lib/mysql-settings-credential-writer.mjs'
import { readOriginalRows, validateColumnEvidence } from './lib/inplace-column-evidence.mjs'
import { verifyOriginalSchemaWithReferralRules } from './lib/inplace-referral-rule-schema.mjs'
import { loadSettingRequestCoordinator } from './lib/inplace-setting-request-schema.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { writePrivateJson } from './lib/v4-backup-io.mjs'

const root = new URL('../', import.meta.url), base = '/www/backup/aurum-v4/m1/20260906-01'
const database = 'dev_vue_m1_source_20260907_02', runId = 'ffffffff-ffff-4fff-8fff-ffffffffff34'
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const check = (ok, code) => { if (!ok) throw new Error(code) }
let c, pool
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'settings_backfill_probe_scope')
  const manifest = await json(new URL('../tools.json', root))
  for (const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..'), 'settings_backfill_probe_path')
    check(sha256(await readFile(new URL(file.path, root))) === file.sha256, 'settings_backfill_probe_tools')
  }
  const backup = await json(`${base}/artifacts/receipt.json`), columns = await json(`${base}/column-rehearsal/receipt.json`)
  validateColumnEvidence(backup, columns)
  const credentials = await json(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`)
  const { default: mysql } = await import(pathToFileURL(process.env.V4_BACKUP_MYSQL2_MODULE).href)
  pool = mysql.createPool({ ...credentials, database, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 3 })
  c = await pool.getConnection()
  await c.query("SET SESSION time_zone='+00:00'")
  const identity = await readSettingsTargetIdentityV2(c)
  check(identity.database === database && identity.serverUuid === backup.serverUuid, 'settings_backfill_probe_identity')
  const plan = await loadSettingRequestCoordinator(root)
  const excluded = [...new Set(plan.steps.filter(step => !step.column).map(step => step.table))]
  const verifyOriginal = async () => {
    await verifyOriginalSchemaWithReferralRules(c, backup.schemaSha256, excluded, plan.referralRuleReference)
    check(canonical(await readOriginalRows(c, columns.originalColumns)) === canonical(columns.parity), 'settings_backfill_probe_original_changed')
  }
  const report = await withInplaceUpgradeLock(c, database, async () => {
    await verifyOriginal()
    const protectedTables = []
    for (const name of excluded) {
      const [fields] = await c.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name])
      const [primary] = await c.execute("SELECT COLUMN_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [name])
      protectedTables.push({ name, columns: fields.map(row => row.name), primary: primary.map(row => row.name) })
    }
    const protectedBefore = await readOriginalRows(c, protectedTables)
    const [selected] = await c.query("SELECT CAST(id AS CHAR) id,category,`key`,value,label,CAST(sort_order AS CHAR) sort_order,created_at,updated_at FROM system_config WHERE category='qiniu' AND `key` IN ('access_key','secret_key') ORDER BY id")
    check(selected.length===2,'settings_backfill_probe_source_scope')
    const sources=selected.map(row=>({...row})),ids=sources.map(row=>row.id)
    const [[occupied]]=await c.execute('SELECT COUNT(*) n FROM system_settings WHERE id IN (?,?)',ids)
    check(Number(occupied.n)===0,'settings_backfill_probe_fixture_exists')
    const proof={evidenceId:'synthetic-settings-only',evidenceSha256:'b'.repeat(64)}
    const time=raw=>({raw,kind:raw===null?'source_null':'wall_clock',offsetMinutes:raw===null?null:480,...proof})
    const options={run:{id:runId,sourceSnapshotId:'settings-rehearsal-only',registeredAtUtc:'2026-09-07T00:00:00.000Z'},
      evidenceCatalog:new Map([[proof.evidenceId,proof.evidenceSha256]]),basis:{version:'settings-credential-import/v1',sourceHash:hash(sources),sourceSnapshotId:'settings-rehearsal-only',
        resolutions:sources.map(source=>({sourceId:source.id,sourceHash:hash(source),sourceFormat:'plaintext',createdAt:time(source.created_at),updatedAt:time(source.updated_at),valueEvidence:{...proof,requirements:['semantic_review','credential_plan_authenticated']}}))}}
    const planPath=new URL('../credential-plan.json',root)
    const credentialSources=sources.map(source=>({sourceId:source.id,namespace:source.category,key:source.key,
      sourceRowHash:hash(source),sourceFormat:'plaintext',value:source.value}))
    const binding={runId,snapshotHash:hash(sources)},keyring=new Map([['rehearsal',randomBytes(32)]])
    options.credentialKeyring=keyring
    options.credentialPlan=await persistCredentialPlan(planPath,credentialSources,binding,{keyring,activeVersion:'rehearsal'})
    options.expectedPlanChecksum=options.credentialPlan.checksum
    let recipe = createCredentialSettingsBackfill(sources, options, { batchSize: 1 })
    const spec = { runId, admission: { approved: true, blockers: [] }, bindings: { logicalSourceId: 'settings-rehearsal-only', sourceDatabase: database,
      mirrorDatabase: 'dev_vue_m1_source_20260906_01', targetDatabase: database, targetServerUuid: identity.serverUuid, schemaHash: identity.schemaHash,
      snapshotHash: recipe.sourceHash, manifestHash: hash(manifest), transformHash: recipe.transformHash, storageMode: 'inplace-settings-v1', streams: [recipe.stream] } }
    let loseCommit = false, failEvidence = false
    const wrapped = new WeakSet()
    const repository = new MysqlSettingsBackfillRepositoryV2({ async getConnection() {
      const conn = await pool.getConnection()
      if (!wrapped.has(conn)) {
        wrapped.add(conn); const commit = conn.commit.bind(conn)
        conn.commit = async () => { await commit(); if (loseCommit) { loseCommit = false; conn.destroy(); throw new Error('synthetic_commit_response_lost') } }
      }
      return conn
    } }, (stream, row) => {
      if (failEvidence) { failEvidence = false; throw new BackfillError('backfill_fixture_evidence_failed') }
      return recipe.sourceEvidence(stream, row)
    })
    const counts = async () => {
      const [[row]] = await c.execute('SELECT (SELECT COUNT(*) FROM system_settings WHERE migration_run_id=?) targets,(SELECT COUNT(*) FROM data_migration_id_maps WHERE created_run_id=?) maps,(SELECT COUNT(*) FROM data_migration_row_receipts WHERE run_id=?) receipts,(SELECT COUNT(*) FROM data_migration_source_rows WHERE run_id=?) sources,(SELECT COUNT(*) FROM data_migration_batches WHERE run_id=?) batches,(SELECT COUNT(*) FROM data_migration_checkpoints WHERE run_id=?) checkpoints,(SELECT COUNT(*) FROM data_migration_runs WHERE id=?) runs', Array(7).fill(runId))
      return row
    }
    check(Object.values(await counts()).every(n => Number(n) === 0), 'settings_backfill_probe_run_exists')
    const reviewPath=new URL('../review.json',root),manifestPath=new URL('../migration.json',root)
    const {credentialKeyring,credentialPlan,...serialOptions}=options
    serialOptions.evidenceCatalog=[...options.evidenceCatalog]
    const review={kind:'credential',sourceIds:ids,options:serialOptions,logicalSourceId:'settings-cli-rehearsal-only',
      mirrorDatabase:spec.bindings.mirrorDatabase,admission:{approved:true,blockers:[]},batchSize:1,credentialPlanPath:'credential-plan.json'}
    await writePrivateJson(reviewPath.pathname,review)
    const commandResults=[]
    const invoke=mode=>{
      const config={MYSQL_DATABASE:database,MYSQL_USER:credentials.user,MYSQL_PASSWORD:credentials.password,MYSQL_SOCKET:'/tmp/mysql.sock',
        AI_CREDENTIAL_KEYS_JSON:JSON.stringify({rehearsal:keyring.get('rehearsal').toString('base64')})}
      const args=[new URL('scripts/run-settings-cli-command.py',root).pathname,mode,
        mode==='prepare'?reviewPath.pathname:manifestPath.pathname,...(mode==='prepare'?[manifestPath.pathname]:[])]
      const result=spawnSync('python3',args,{input:JSON.stringify(config),encoding:'utf8',timeout:180000,maxBuffer:1048576})
      if(result.status!==0){let code='settings_backfill_probe_cli';try{code=JSON.parse(result.stderr.trim()).code}catch{};throw new Error(code)}
      const resultData=JSON.parse(result.stdout.trim())
      commandResults.push({mode,status:resultData.status})
      return resultData
    }
    // Each actual CLI acquires its own global migration lock. Release this outer
    // rehearsal lock while running the commands, then reacquire before cleanup.
    const [[released]]=await c.execute('SELECT RELEASE_LOCK(?) released',[`aurum:inplace:${database}`])
    check(Number(released.released)===1,'settings_backfill_probe_cli_unlock')
    let loaded,committedCounts
    try {
      invoke('prepare')
      const beforeCheck=await counts()
      check(invoke('check').status==='checked' && canonical(await counts())===canonical(beforeCheck),'settings_backfill_probe_cli_check')
      check(invoke('apply').status==='verified','settings_backfill_probe_cli_apply')
      committedCounts=await counts()
      check(invoke('recover').status==='verified' && invoke('verify').status==='verified','settings_backfill_probe_cli_recover')
      check(invoke('apply').status==='verified' && canonical(await counts())===canonical(committedCounts),'settings_backfill_probe_cli_repeat')
      loaded=await json(manifestPath)
    } finally {
      const [[claimed]]=await c.execute('SELECT GET_LOCK(?,0) acquired',[`aurum:inplace:${database}`])
      check(Number(claimed.acquired)===1,'settings_backfill_probe_cli_relock')
    }
    // Bind the independently audited recipe to the actual generated manifest.
    Object.assign(spec,loaded.spec)
    const rowVerifier=createCredentialSettingsWriter(sources,options)
    const streamId = streamIdentity(recipe.stream)
    const [[checkpoint]] = await c.execute('SELECT sequence_number,processed_rows,cursor_json FROM data_migration_checkpoints WHERE run_id=? AND stream_id=?', [runId, streamId])
    const decode = value => typeof value === 'string' ? JSON.parse(value) : value
    check(Number(checkpoint.sequence_number) === 2 && String(checkpoint.processed_rows) === '2'
      && canonical(decode(checkpoint.cursor_json)) === canonical(recipe.batches[1].endCursor), 'settings_backfill_probe_checkpoint')
    const [maps] = await c.execute('SELECT logical_source_id,entity_kind,source_table,source_pk_sha256,source_pk_json,target_json FROM data_migration_id_maps WHERE created_run_id=?', [runId])
    const [receipts] = await c.execute('SELECT source_pk_sha256,batch_id,source_bytes_sha256,transformed_sha256,targets_json FROM data_migration_row_receipts WHERE run_id=? AND stream_id=?', [runId, streamId])
    for (const batch of recipe.batches) {
      const row = batch.rows[0], mapping = maps.find(m => m.source_pk_sha256 === hash(row.pk)), receipt = receipts.find(r => r.source_pk_sha256 === hash(row.pk))
      check(mapping?.logical_source_id === spec.bindings.logicalSourceId && mapping.entity_kind === 'settings' && mapping.source_table === 'system_config'
        && canonical(decode(mapping.source_pk_json)) === canonical(row.pk) && canonical(decode(mapping.target_json)) === canonical(row.targets[0]), 'settings_backfill_probe_mapping')
      check(receipt?.batch_id === batch.batchId && receipt.source_bytes_sha256 === row.sourceHash && receipt.transformed_sha256 === row.transformedHash
        && canonical(decode(receipt.targets_json)) === canonical(row.targets), 'settings_backfill_probe_receipt')
    }
    const [evidence] = await c.execute('SELECT source_pk_sha256,source_bytes_sha256,source_payload_json FROM data_migration_source_rows WHERE run_id=? AND stream_id=?', [runId, streamId])
    for (const batch of recipe.batches) {
      const row = batch.rows[0], saved = evidence.find(e => e.source_pk_sha256 === hash(row.pk))
      const payload = typeof saved?.source_payload_json === 'string' ? JSON.parse(saved.source_payload_json) : saved?.source_payload_json
      check(saved?.source_bytes_sha256 === row.sourceHash && canonical(payload) === canonical(recipe.sourceEvidence(streamId, row)), 'settings_backfill_probe_evidence')
    }
    const integerFields = ['id', 'sort_order', 'revision'], timeFields = ['created_at_utc', 'updated_at_utc', 'imported_at_utc']
    const projection = settingsAuditFields.map(field => integerFields.includes(field) ? `CAST(${field} AS CHAR) ${field}`
      : timeFields.includes(field) ? `DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f') ${field}` : field).join(',')
    const [actual] = await c.execute(`SELECT ${projection} FROM system_settings WHERE migration_run_id=? ORDER BY system_settings.id`, [runId])
    const archives = evidence.map(saved => ({ sourceId: decode(saved.source_payload_json).source.id, runId,
      sourcePkHash: saved.source_pk_sha256, sourceHash: saved.source_bytes_sha256, payload: decode(saved.source_payload_json) }))
    const audit = auditCredentialSettingsImport(sources, actual.map(row => ({ ...row })), archives, options)
    check(audit.importMatchesReviewedInputs, 'settings_backfill_probe_audit')
    await c.beginTransaction()
    for (const entry of rowVerifier.prepared.entries) await rowVerifier.write(c, entry, { verifyOnly: true })
    await c.rollback()
    await c.beginTransaction()
    await c.execute('DELETE FROM system_settings WHERE migration_run_id=? AND id IN (?,?)', [runId, ...ids])
    for (const table of ['data_migration_source_rows', 'data_migration_row_receipts', 'data_migration_batches', 'data_migration_checkpoints']) await c.execute(`DELETE FROM ${table} WHERE run_id=?`, [runId])
    await c.execute('DELETE FROM data_migration_id_maps WHERE created_run_id=? AND logical_source_id=?', [runId, spec.bindings.logicalSourceId])
    await c.execute('DELETE FROM data_migration_runs WHERE id=?', [runId])
    await c.commit()
    const finalCounts = await counts()
    check(Object.values(finalCounts).every(n => Number(n) === 0), 'settings_backfill_probe_cleanup')
    await verifyOriginal()
    check(canonical(await readOriginalRows(c, protectedTables)) === canonical(protectedBefore), 'settings_backfill_probe_protected_changed')
    await unlink(reviewPath)
    await unlink(manifestPath)
    await unlink(planPath)
    for(const key of keyring.values())key.fill(0)
    return { kind: 'settings-cli-backfill-probe/v1', commandResults, syntheticEncryptionKey:true, protectedSourceRecoveryVerified:true, identity, fixtureOnly: true, sourceRowsFromRestoredSystemConfig: true, syntheticTimeEvidence: true, toolManifest: manifest, cliEndToEndVerified:true,
       committedCounts, finalCounts, repeatNoop: true, checkpoint, mapsAndReceiptsVerified: true, audit,
      originalRows: backup.parity.rows, originalParityHash: sha256(JSON.stringify(columns.parity)), protectedTablesVerified: true, protectedRowsHash: hash(protectedBefore), currentDevVueWritten: false, originalTablesWritten: false, realHistoricalTimeValidated: false }
  })
  await writePrivateJson(new URL('../receipt.json', root).pathname, report)
  console.log(JSON.stringify({ status: 'verified', cliEndToEndVerified:true, rows: 2, fixtureCleanup: true, originalRows: report.originalRows }))
} catch (error) {
  await c?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^(settings_backfill_probe|backfill|settings|credential)_[a-z_]+$/.test(error.message) ? error.message : 'settings_backfill_probe_failed' })); process.exitCode = 1
} finally { c?.release(); await pool?.end() }
