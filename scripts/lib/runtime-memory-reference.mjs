import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { createMysqlRuntimeStrategyMemoryReader } from '../../server/dist-v4/modules/reviews/composition.js'
import { verifyMemoryPreparationTransaction } from './runtime-memory-preparation-reference.mjs'

export async function verifyRuntimeMemoryReference(connection, pool) {
  const [[scope]] = await connection.query('SELECT DATABASE() db')
  assert.match(scope.db, /^dev_vue_strategy_ref_[0-9a-f]{32}$/)
  const sql = await readFile(new URL('../../server/db/migrations/20260904_012_review_memory_core.sql', import.meta.url), 'utf8')
  const statements = splitSqlStatements(sql).filter(statement => /^(CREATE TABLE IF NOT EXISTS (strategy_memory_libraries_v4|strategy_memory_library_revisions_v4)\s|ALTER TABLE strategy_memory_libraries_v4\s)/.test(statement))
  assert.equal(statements.length, 3)
  for (const statement of statements) await connection.query(statement)
  await connection.query("INSERT INTO users VALUES (8,'active',NULL)")
  const now = '2026-09-09 00:00:00.000', content = '人工确认后的策略经验'
  const digest = createHash('sha256').update(content).digest('hex')
  for (const [id, scope, owner] of [['60001', 'platform', null], ['60002', 'user', 7], ['60003', 'user', 8]]) {
    await connection.execute(`INSERT INTO strategies (id,kind,scope,owner_user_id,name,description,status,revision,created_at_utc,updated_at_utc)
      VALUES (?,'analysis',?,?,'memory reference','','active',1,?,?)`, [id, scope, owner, now, now])
  }
  for (const [id, library, revision, owner] of [['60001', 'memory-platform', 'memory-platform-revision', null], ['60002', 'memory-personal', 'memory-personal-revision', 7]]) {
    await connection.execute(`INSERT INTO strategy_memory_libraries_v4 (id,strategy_id,owner_user_id,mode,status,revision,created_at_utc,updated_at_utc)
      VALUES (?,?,?,'active','active',1,?,?)`, [library, id, owner, now, now])
    await connection.execute(`INSERT INTO strategy_memory_library_revisions_v4
      (id,library_id,version_number,content_text,content_sha256,source_kind,source_metadata_json,created_by_user_id,created_at_utc)
      VALUES (?,?,1,?,?,'manual_edit','{}',7,?)`, [revision, library, content, digest, now])
    await connection.execute('UPDATE strategy_memory_libraries_v4 SET current_revision_id=? WHERE id=?', [revision, library])
  }
  const reader = createMysqlRuntimeStrategyMemoryReader(connection), request = { userId: 7, strategyId: '60001', strategyKind: 'analysis' }
  assert.equal((await reader.read(request)).contentText, content)
  assert.equal((await reader.read({ ...request, strategyId: '60002' })).contentHash, digest)
  const checks = ['platform-and-owned-private-current-revision']
  await assert.rejects(reader.read({ ...request, userId: 8, strategyId: '60002' }), { code: 'strategy_memory_unavailable' })
  await assert.rejects(reader.read({ ...request, strategyKind: 'trader' }), { code: 'strategy_memory_unavailable' })
  assert.equal((await reader.read({ ...request, userId: 8, strategyId: '60003' })).state, 'absent')
  checks.push('scope-denial-distinct-from-authorized-absence')
  const mutation = async (name, sql, args, expectation) => {
    await connection.beginTransaction()
    try {
      await connection.execute(sql, args)
      const result = reader.read(request)
      if (expectation === 'disabled') assert.equal((await result).contentText, null)
      else await assert.rejects(result, { code: 'strategy_memory_evidence_invalid' })
      checks.push(name)
    } finally { await connection.rollback() }
  }
  await mutation('shadow-body-not-returned', 'UPDATE strategy_memory_libraries_v4 SET mode=? WHERE id=?', ['shadow', 'memory-platform'], 'disabled')
  await mutation('revalidating-body-not-returned', 'UPDATE strategy_memory_libraries_v4 SET status=? WHERE id=?', ['revalidating', 'memory-platform'], 'disabled')
  await mutation('library-owner-mismatch-rejected', 'UPDATE strategy_memory_libraries_v4 SET owner_user_id=? WHERE id=?', [7, 'memory-platform'])
  await mutation('tampered-body-rejected', 'UPDATE strategy_memory_library_revisions_v4 SET content_text=? WHERE id=?', ['changed', 'memory-platform-revision'])
  await mutation('oversized-body-not-selected-or-truncated', 'UPDATE strategy_memory_library_revisions_v4 SET content_text=? WHERE id=?', ['x'.repeat(65_537), 'memory-platform-revision'])
  await assert.rejects(connection.execute('UPDATE strategy_memory_libraries_v4 SET current_revision_id=? WHERE id=?', ['memory-personal-revision', 'memory-platform']), { code: 'ER_NO_REFERENCED_ROW_2' })
  checks.push('real-current-revision-library-composite-foreign-key')
  const injectionDdl = splitSqlStatements(sql).find(statement => /^CREATE TABLE IF NOT EXISTS strategy_memory_injection_logs_v4\s/.test(statement))
  assert.ok(injectionDdl)
  await connection.query(injectionDdl)
  await connection.execute(`INSERT INTO strategy_memory_injection_logs_v4
    (user_id,strategy_id,library_id,library_revision_id,runtime_kind,runtime_id,injected,matched_context_json,token_count,occurred_at_utc)
    VALUES (7,60001,'memory-platform','memory-platform-revision','analysis','legacy-memory',1,'{}',12,?)`, [now])
  const [[beforeDefinition]] = await connection.query('SHOW CREATE TABLE strategy_memory_injection_logs_v4')
  const auditDdl = await readFile(new URL('../../server/db/migrations/inplace/050_strategy_memory_runtime_audit.sql', import.meta.url), 'utf8')
  for (const statement of splitSqlStatements(auditDdl)) await connection.query(statement)
  const [[legacy]] = await connection.query("SELECT token_count,record_version,input_snapshot_id,estimated_token_count FROM strategy_memory_injection_logs_v4 WHERE runtime_id='legacy-memory'")
  assert.deepEqual({ ...legacy }, { token_count: 12, record_version: 1, input_snapshot_id: null, estimated_token_count: null })
  checks.push('audit-migration-preserves-legacy-token-count-and-row')
  await connection.execute(`INSERT INTO strategy_versions (id,strategy_id,version_number,prompt_text,prompt_sha256,input_contract_version,
    output_contract_version,config_json,created_by_user_id,created_at_utc) VALUES (60011,60001,1,'fixture',?,'fixture/v1','fixture/v1','{}',7,?)`, ['a'.repeat(64), now])
  await connection.execute(`INSERT INTO inference_snapshots (id,purpose,user_id,strategy_id,strategy_version_id,standard_symbol,payload_sha256,
    payload_bytes,captured_at_utc,created_at_utc) VALUES ('memory-snapshot','analysis',7,60001,60011,'XAUUSD',?,2,?,?)`, ['b'.repeat(64), now, now])
  const insertAudit = `INSERT INTO strategy_memory_injection_logs_v4
    (user_id,strategy_id,library_id,library_revision_id,runtime_kind,runtime_id,injected,matched_context_json,token_count,occurred_at_utc,
    record_version,input_snapshot_id,input_snapshot_sha256,estimated_token_count,token_estimate_method)
    VALUES (7,60001,'memory-platform','memory-platform-revision','trader',?,0,'{}',NULL,?,2,?,?,3,?)`
  await connection.execute(insertAudit, ['prepared-memory', now, 'memory-snapshot', 'b'.repeat(64), 'utf8_bytes_div4_v1'])
  const [[prepared]] = await connection.query("SELECT token_count,estimated_token_count,record_version,injected FROM strategy_memory_injection_logs_v4 WHERE runtime_id='prepared-memory'")
  assert.deepEqual({ ...prepared }, { token_count: null, estimated_token_count: 3, record_version: 2, injected: 0 })
  checks.push('trader-preparation-audit-keeps-real-usage-unknown')
  for (const [runtime, snapshot, digest, method, code] of [
    ['bad-snapshot', 'missing-snapshot', 'b'.repeat(64), 'utf8_bytes_div4_v1', 'ER_NO_REFERENCED_ROW_2'],
    ['bad-digest', 'memory-snapshot', 'B'.repeat(64), 'utf8_bytes_div4_v1', 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['bad-method', 'memory-snapshot', 'b'.repeat(64), 'unknown', 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ]) await assert.rejects(connection.execute(insertAudit, [runtime, now, snapshot, digest, method]), { code })
  checks.push('audit-snapshot-fk-hash-and-method-constraints')
  const [[afterDefinition]] = await connection.query('SHOW CREATE TABLE strategy_memory_injection_logs_v4')
  const preparation = await verifyMemoryPreparationTransaction(connection, pool)
  return { passed: true, checks, preparation, ddlSha256: createHash('sha256').update(statements.join('\n')).digest('hex'),
    auditBeforeDdl: beforeDefinition['Create Table'], auditAfterDdl: afterDefinition['Create Table'],
    auditDdlSha256: createHash('sha256').update(auditDdl).digest('hex'),
    scope: 'Real selected 012 library/revision DDL, public reader and composite FK; scaffold users/strategy parents. No runtime injection or historical migration proof.' }
}
