import { reviewEvidenceHash } from '../server/dist-v4/modules/reviews/infrastructure/review-evidence-integrity.js'
import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { ReviewService } from '../server/dist-v4/modules/reviews/application/review-service.js'
import { reviewContentFromWire } from '../server/dist-v4/modules/reviews/domain/review.js'
import { MysqlReviewRepository } from '../server/dist-v4/modules/reviews/infrastructure/mysql-review-repository.js'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--temporary-reference-only' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
const database = 'dev_vue_review_business_ref_' + randomUUID().replaceAll('-', '')
assert.match(database, /^dev_vue_review_business_ref_[0-9a-f]{32}$/)
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'review-business-reference/v1', passed: false, existingDatabaseWrites: 0,
  referenceDatabaseRemoved: false, checks: [],
  scope: 'Actual six review write repositories with original migration 012 and 049; scaffold prerequisite domains; not current database upgrade or historical restoration; source-revalidation port injected, not trade-source proof.' }
const sha = value => createHash('sha256').update(value).digest('hex')
let connection, pool, created = false
try {
  const sql = await readFile(new URL('../server/db/migrations/inplace/049_review_write_receipts.sql', import.meta.url), 'utf8')
  assert.equal(splitSqlStatements(sql).length, 1)
  report.migrationSha256 = sha(sql)
  const artifacts = ['scripts/verify-review-business-reference-local.mjs', 'scripts/run-review-business-reference-local.py',
    'server/dist-v4/modules/reviews/application/review-write-command.js',
    'server/dist-v4/modules/reviews/infrastructure/mysql-review-write-receipts.js',
    'server/dist-v4/modules/reviews/infrastructure/review-transaction.js',
    ...['mysql-review-repository','mysql-review-case-write','mysql-review-memory-write','mysql-manual-review-write','review-sql-time'].map(n => 'server/dist-v4/modules/reviews/infrastructure/' + n + '.js'),
    'server/dist-v4/modules/reviews/application/review-service.js','server/dist-v4/modules/reviews/domain/review-result.js']
  report.artifacts = await Promise.all(artifacts.map(async path => ({ path, sha256: sha(await readFile(new URL('../' + path, import.meta.url))) })))
  connection = await mysql.createConnection({ ...credential, timezone: 'Z', multipleStatements: false })
  const [[server]] = await connection.query('SELECT @@server_uuid uuid,@@version version')
  assert.equal(server.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  report.serverUuid = server.uuid; report.serverVersion = server.version
  report.referenceDatabase = database
  await connection.query(`CREATE DATABASE \`${database}\``); created = true
  await connection.query(`USE \`${database}\``)
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query("CREATE TABLE users (id INT PRIMARY KEY,deletion_status VARCHAR(20) NOT NULL,deleted_at DATETIME(3) NULL,write_allowed BOOLEAN NOT NULL) ENGINE=InnoDB")
  const parents = [
    'CREATE TABLE trading_accounts (id BIGINT UNSIGNED PRIMARY KEY,platform VARCHAR(10),account_login VARCHAR(50),broker_server VARCHAR(50)) ENGINE=InnoDB',
    "CREATE TABLE trading_account_ownerships (user_id INT NOT NULL,trading_account_id BIGINT UNSIGNED NOT NULL,role VARCHAR(20) NOT NULL,revoked_at_utc DATETIME(3),PRIMARY KEY(user_id,trading_account_id,role)) ENGINE=InnoDB",
    "CREATE TABLE strategies (id BIGINT UNSIGNED PRIMARY KEY,kind VARCHAR(20),name VARCHAR(50),owner_user_id INT,scope VARCHAR(20),status VARCHAR(20),active_version_id BIGINT UNSIGNED,deleted_at_utc DATETIME(3)) ENGINE=InnoDB",
    'CREATE TABLE strategy_versions (id BIGINT UNSIGNED NOT NULL,strategy_id BIGINT UNSIGNED NOT NULL,PRIMARY KEY(id),UNIQUE KEY pair(id,strategy_id)) ENGINE=InnoDB',
    'CREATE TABLE strategy_subscriptions (id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB',
    'CREATE TABLE ai_model_profiles (id INT PRIMARY KEY) ENGINE=InnoDB',
  ]
  for (const parent of parents) await connection.query(parent)
  const source = await readFile(new URL('../server/db/migrations/20260904_012_review_memory_core.sql', import.meta.url), 'utf8')
  report.reviewMigrationSha256 = sha(source)
  for (const statement of splitSqlStatements(source)) await connection.query(statement)
  const infrastructure = await readFile(new URL('../server/db/migrations/inplace/025_independent_runtime_structures.sql', import.meta.url), 'utf8')
  const outboxSql = splitSqlStatements(infrastructure).filter(statement => statement.startsWith('CREATE TABLE `outbox_events`'))
  assert.equal(outboxSql.length, 1)
  await connection.query(outboxSql[0])
  await connection.query(sql)
  await connection.query(await readFile(new URL('../server/db/migrations/inplace/073_manual_review_candidate_evidence.sql',import.meta.url),'utf8'))
  await connection.query("INSERT INTO users VALUES (7,'active',NULL,1)")
  await connection.query("INSERT INTO trading_accounts VALUES (5,'mt5','reference','demo')")
  await connection.query("INSERT INTO trading_account_ownerships VALUES (7,5,'owner',NULL)")
  await connection.query("INSERT INTO strategies VALUES (1,'analysis','reference',7,'private','active',1,NULL)")
  await connection.query('INSERT INTO strategy_versions VALUES (1,1)')
  pool = mysql.createPool({ ...credential, database, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, connectionLimit: 4 })
  let loseAck = false, failReceipt = false
  const wrapped = new Proxy(pool, { get(target, name) {
    if (name === 'getConnection') return async () => {
      const db = await target.getConnection()
      await db.query("SET SESSION time_zone='+00:00'")
      return new Proxy(db, { get(client, method) {
        if (method === 'commit') return async () => { await client.commit(); if (loseAck) { loseAck = false; throw Error('injected_postcommit_ack_loss') } }
        if (method === 'execute') return async (statement, values) => {
          if (failReceipt && statement.startsWith('INSERT INTO review_write_receipts_v4')) { failReceipt = false; throw Error('injected_receipt_insert_failure') }
          return client.execute(statement, values)
        }
        const value = Reflect.get(client, method); return typeof value === 'function' ? value.bind(client) : value
      } })
    }
    const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value
  } })
  const now = new Date('2026-09-09T12:00:00.000Z')
  const service = new ReviewService(new MysqlReviewRepository(wrapped,()=>({async verify(){ /* Source adapter verified separately against collected history. */ }})), () => now)
  const candidateId = randomUUID(), token = 'reference-selection-token-0001'
  await connection.execute(`INSERT INTO manual_review_candidates_v4
    (id,user_id,trading_account_id,stable_trade_key,ticket,position_id,symbol,side,volume,opened_at_utc,closed_at_utc,net_profit,terminal_timezone_offset_minutes,source_classification,eligibility_status,evidence_sha256,selection_token_sha256,selection_expires_at_utc,observed_at_utc)
    VALUES (?,7,5,'trade-1','123',NULL,'XAUUSD','buy','0.01',?,?,'1.25',180,'manual','eligible',?,?,?,?)`,
    [candidateId,new Date('2026-09-09T10:00:00.000Z'),new Date('2026-09-09T11:00:00.000Z'),'a'.repeat(64),sha(token),new Date('2026-09-10T00:00:00.000Z'),now])
  const frozenManual={schema_version:'manual-candidate-evidence.v4.1',authority:{source:'synthetic-reference'},trade:{
    status:'ready_as_of',taskId:'reference-task',receiptId:'reference-receipt',completionHash:'c'.repeat(64),asOfUtcMsc:now.getTime(),
    evidence:{source:'manual',userId:7,accountId:'5',recordId:randomUUID(),revision:1,facts:[{source:'synthetic-reference'}],
      openedAt:'2026-09-09T10:00:00.000Z',closedAt:'2026-09-09T11:00:00.000Z',terminalTimezoneOffsetMinutes:180,
      projection:{primaryTicket:'123',positionId:null,symbol:'XAUUSD',side:'buy',volumeOpened:'0.01',netProfit:'1.25'}}}}
  const frozenHash=reviewEvidenceHash(frozenManual), frozenJson=JSON.stringify(frozenManual)
  await connection.execute('UPDATE manual_review_candidates_v4 SET evidence_sha256=? WHERE id=?',[frozenHash,candidateId])
  await connection.execute(`INSERT INTO manual_review_candidate_evidence_v4
    (candidate_id,candidate_revision,trade_record_id,trade_record_revision,as_of_utc,evidence_json,evidence_sha256,payload_bytes,created_at_utc)
    VALUES (?,1,?,1,?,?,?,?,?)`,[candidateId,frozenManual.trade.evidence.recordId,now,frozenJson,frozenHash,Buffer.byteLength(frozenJson),now])
  const manual = { candidateIds: [candidateId], selectionTokens: [token], strategyId: '1', idempotencyKey: 'review-reference-manual' }
  await connection.execute("UPDATE manual_review_candidate_evidence_v4 SET evidence_json=JSON_SET(evidence_json,'$.trade.evidence.accountId','6') WHERE candidate_id=?",[candidateId])
  await assert.rejects(service.createManualCase(7,manual),{code:'manual_review_evidence_corrupt'})
  const foreignManual=structuredClone(frozenManual);foreignManual.trade.evidence.accountId='6'
  const foreignHash=reviewEvidenceHash(foreignManual)
  await connection.execute('UPDATE manual_review_candidate_evidence_v4 SET evidence_sha256=? WHERE candidate_id=?',[foreignHash,candidateId])
  await connection.execute('UPDATE manual_review_candidates_v4 SET evidence_sha256=? WHERE id=?',[foreignHash,candidateId])
  await assert.rejects(service.createManualCase(7,manual),{code:'manual_review_evidence_scope_mismatch'})
  await connection.execute('UPDATE manual_review_candidate_evidence_v4 SET evidence_json=?,evidence_sha256=?,candidate_revision=2 WHERE candidate_id=?',[frozenJson,frozenHash,candidateId])
  await connection.execute('UPDATE manual_review_candidates_v4 SET evidence_sha256=? WHERE id=?',[frozenHash,candidateId])
  await assert.rejects(service.createManualCase(7,manual),{code:'manual_review_evidence_unavailable'})
  for(const table of ['review_cases_v4','review_jobs_v4','outbox_events','review_write_receipts_v4']){
    const [[count]]=await connection.query(`SELECT COUNT(*) n FROM ${table}`);assert.equal(Number(count.n),0)
  }
  await connection.execute('UPDATE manual_review_candidate_evidence_v4 SET candidate_revision=1 WHERE candidate_id=?',[candidateId])
  report.checks.push('tampered_foreign_and_missing_candidate_payload_create_no_case_job_receipt_or_outbox')
  report.stage = 'create_manual'
  const [manualCreated, concurrent] = await Promise.all([service.createManualCase(7, manual), service.createManualCase(7, manual)])
  assert.deepEqual(manualCreated, concurrent)
  const caseId = manualCreated.summary.id
  assert.equal(manualCreated.summary.revision, 1)
  const [[createdPayload]]=await connection.execute('SELECT evidence_json FROM review_evidence_payloads_v4 WHERE review_case_id=?',[caseId])
  const createdEvidence=typeof createdPayload.evidence_json==='string'?JSON.parse(createdPayload.evidence_json):createdPayload.evidence_json
  assert.equal(createdEvidence.schema_version,'review-evidence.v4.2')
  assert.deepEqual(createdEvidence.frozen_candidates,[{candidate_id:candidateId,candidate_revision:1,evidence:frozenManual}])
  report.checks.push('manual_creation_concurrent_receipt_replay','manual_case_preserves_full_candidate_payload')
  await connection.execute("UPDATE review_jobs_v4 SET status='failed' WHERE review_case_id=?", [caseId])
  report.stage = 'generation'
  loseAck = true
  await assert.rejects(service.requestGeneration(7, caseId, 1, 'retry', 'review-reference-generation'), { code: 'review_commit_unknown' })
  const generation = await service.requestGeneration(7, caseId, 1, 'retry', 'review-reference-generation')
  assert.equal(generation.summary.revision, 2)
  assert.deepEqual(await service.requestGeneration(7, caseId, 1, 'retry', 'review-reference-generation'), generation)
  const wire = { schema_version: 'review.v4.1', conclusion: 'mixed', headline: 'Review', summary: 'Evidence',
    metrics: { net_profit: '1.25', trade_count: 1, win_rate_percent: '100', profit_factor: null }, trade_episodes: [],
    roles: Object.fromEntries(['analyst','trader','risk','execution'].map(role => [role,{ assessment:'effective',summary:'Evidence',evidence_refs:[] }])),
    counterexamples: [], memory_candidates: [{ strategy_id:'1',memory_key:'entry',update_kind:'short_term',title:'Evidence',content:'Use frozen evidence',evidence_refs:[] }], evidence_refs:[],full_analysis_text:'Evidence' }
  const seedVersionId = randomUUID(), domainContent = reviewContentFromWire(wire)
  await connection.execute(`INSERT INTO review_versions_v4 (id,review_case_id,version_number,author_kind,created_by_user_id,conclusion_code,content_sha256,created_at_utc) VALUES (?,?,1,'user',7,'mixed',?,?)`, [seedVersionId,caseId,'a'.repeat(64),now])
  await connection.execute(`INSERT INTO review_version_payloads_v4 VALUES (?,?,?,?,?)`, [seedVersionId,JSON.stringify(domainContent),'Evidence','a'.repeat(64),1])
  await connection.execute("UPDATE review_cases_v4 SET current_version_id=?,status='awaiting_confirmation' WHERE id=?", [seedVersionId,caseId])
  report.stage = 'create_version'
  const version = await service.createVersion(7,caseId,2,wire,'review-reference-version')
  assert.equal(version.summary.revision,3)
  assert.deepEqual(await service.createVersion(7,caseId,2,wire,'review-reference-version'),version)
  report.stage = 'return_case'
  const returned = await service.returnForChanges(7,caseId,3,'More evidence','review-reference-return')
  assert.equal(returned.summary.revision,4)
  assert.deepEqual(await service.returnForChanges(7,caseId,3,'More evidence','review-reference-return'),returned)
  const edited = await service.createVersion(7,caseId,4,wire,'review-reference-version-two')
  report.stage = 'confirm'
  const confirmed = await service.confirm(7,caseId,edited.currentVersion.id,5,'review-reference-confirm')
  assert.equal(confirmed.summary.revision,6)
  assert.deepEqual(await service.confirm(7,caseId,edited.currentVersion.id,5,'review-reference-confirm'),confirmed)
  const [[update]] = await connection.execute('SELECT id FROM strategy_memory_pending_updates_v4 WHERE source_review_case_id=?',[caseId])
  assert.ok(update.id)
  report.stage = 'memory_accept'
  const accepted = await service.decideMemoryUpdate(7,update.id,1,'accept','review-reference-memory-accept')
  assert.equal(accepted.status,'merged')
  assert.deepEqual(await service.decideMemoryUpdate(7,update.id,1,'accept','review-reference-memory-accept'),accepted)
  report.stage = 'memory_revoke'
  const revoked = await service.decideMemoryUpdate(7,update.id,2,'revoke','review-reference-memory-revoke')
  assert.equal(revoked.status,'superseded')
  assert.deepEqual(await service.decideMemoryUpdate(7,update.id,2,'revoke','review-reference-memory-revoke'),revoked)
  report.stage = 'memory_reject'
  const rejectedId = randomUUID()
  await connection.execute(`INSERT INTO strategy_memory_pending_updates_v4
    (id,library_id,source_review_case_id,source_review_version_id,update_kind,proposal_key,status,expected_library_revision,proposal_json,diff_preview_text,conflict_json,created_at_utc,updated_at_utc,revision)
    SELECT ?,library_id,source_review_case_id,source_review_version_id,update_kind,?,'awaiting_confirmation',3,proposal_json,diff_preview_text,conflict_json,created_at_utc,updated_at_utc,1 FROM strategy_memory_pending_updates_v4 WHERE id=?`, [rejectedId,sha('rejection-candidate'),update.id])
  const rejected = await service.decideMemoryUpdate(7,rejectedId,1,'reject','review-reference-memory-reject')
  assert.equal(rejected.status,'rejected')
  assert.deepEqual(await service.decideMemoryUpdate(7,rejectedId,1,'reject','review-reference-memory-reject'),rejected)
  report.checks.push('six_business_write_paths_all_memory_decisions_original_cas_replays_actual_foreign_keys')
  report.checks.push('dateStrings_utc_and_generation_actual_commit_injected_ack_loss_recovery')
  await connection.query("UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3) WHERE user_id=7")
  await assert.rejects(service.createManualCase(7,manual),{code:'review_case_not_found'})
  report.checks.push('manual_replay_denied_after_actual_owner_revocation')
  const [[counts]] = await connection.query('SELECT (SELECT COUNT(*) FROM review_write_receipts_v4) receipts,(SELECT COUNT(*) FROM review_cases_v4) cases,(SELECT COUNT(*) FROM review_versions_v4) versions,(SELECT COUNT(*) FROM strategy_memory_library_revisions_v4) memoryVersions')
  assert.equal(counts.receipts,9); assert.equal(counts.cases,1); assert.equal(counts.versions,3); assert.equal(counts.memoryVersions,2)
  report.counts = counts
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name ?? 'reference_failed'; process.exitCode = 1 }
finally {
  if (pool) await pool.end()
  if (connection) {
    try { if (created) { await connection.query(`DROP DATABASE \`${database}\``); report.referenceDatabaseRemoved = true } }
    catch { report.passed = false; report.cleanupError = true; report.referenceDatabase = database; process.exitCode = 1 }
    await connection.end()
  }
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errorCode: report.errorCode, stage: report.stage,
    referenceDatabaseRemoved: report.referenceDatabaseRemoved, existingDatabaseWrites: 0 }))
}
