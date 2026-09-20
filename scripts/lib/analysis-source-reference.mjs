import assert from 'node:assert/strict'
import { createMysqlAnalysisSourceReader } from '../../server/dist-v4/modules/inference/composition.js'
import { contentHash } from '../../server/dist-v4/modules/inference/domain/inference.js'

export async function verifyAnalysisSourceReference(connection, inspectHealthySource) {
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const tables = []
  const create = async (name, columns) => {
    await connection.query(`CREATE TEMPORARY TABLE ${name} (${columns}) ENGINE=InnoDB`)
    tables.push(name)
  }
  const analysisId = '00000000-0000-4000-8000-000000000001', snapshotId = '00000000-0000-4000-8000-000000000002'
  const scope = { analysisId, userId: 70, analysisStrategyId: '60001', symbol: 'XAUUSD' }
  const payload = { kind: 'analysis', strategy: { id: '60001', versionId: '60011' }, market: { symbol: 'XAUUSD', source_account_id: '9' } }
  const checks = []
  try {
    await create('market_analyses', 'id CHAR(36) PRIMARY KEY,analysis_run_id CHAR(36),owner_user_id INT,owner_scope VARCHAR(16),strategy_id BIGINT,strategy_version_id BIGINT,standard_symbol VARCHAR(64),input_snapshot_id CHAR(36)')
    await create('ai_analysis_runs', 'id CHAR(36) PRIMARY KEY,user_id INT,strategy_id BIGINT,strategy_version_id BIGINT,standard_symbol VARCHAR(64),input_snapshot_id CHAR(36),status VARCHAR(32),market_source_account_id BIGINT NULL')
    await create('inference_snapshots', 'id CHAR(36) PRIMARY KEY,user_id INT,strategy_id BIGINT,strategy_version_id BIGINT,standard_symbol VARCHAR(64),purpose VARCHAR(16),trading_account_id BIGINT NULL,payload_sha256 CHAR(64)')
    await create('inference_snapshot_payloads', 'snapshot_id CHAR(36) PRIMARY KEY,encoding VARCHAR(16),payload_json JSON')
    await connection.execute("INSERT INTO market_analyses VALUES (?,'source-run',70,'user',60001,60011,'XAUUSD',?)", [analysisId, snapshotId])
    await connection.execute("INSERT INTO ai_analysis_runs VALUES ('source-run',70,60001,60011,'XAUUSD',?,'succeeded',9)", [snapshotId])
    await connection.execute("INSERT INTO inference_snapshots VALUES (?,70,60001,60011,'XAUUSD','analysis',NULL,?)", [snapshotId, contentHash(payload)])
    await connection.execute("INSERT INTO inference_snapshot_payloads VALUES (?,'json',?)", [snapshotId, JSON.stringify(payload)])
    const reader = createMysqlAnalysisSourceReader(connection)
    assert.equal((await reader.read(scope)).sourceAccountId, '9')
    checks.push('frozen-source-returned')
    if (inspectHealthySource) await inspectHealthySource(scope)
    for (const patch of [{ userId: 71 }, { analysisStrategyId: '60002' }, { symbol: 'EURUSD' }]) {
      assert.equal(await reader.read({ ...scope, ...patch }), null)
    }
    checks.push('scope-denial')
    for (const [name, sql] of [
      ['run-user-mismatch', 'UPDATE ai_analysis_runs SET user_id=71'],
      ['run-version-mismatch', 'UPDATE ai_analysis_runs SET strategy_version_id=60012'],
      ['run-symbol-mismatch', "UPDATE ai_analysis_runs SET standard_symbol='EURUSD'"],
      ['run-not-succeeded', "UPDATE ai_analysis_runs SET status='running'"],
      ['run-snapshot-mismatch', "UPDATE ai_analysis_runs SET input_snapshot_id='other'"],
      ['snapshot-user-mismatch', 'UPDATE inference_snapshots SET user_id=71'],
      ['snapshot-strategy-mismatch', 'UPDATE inference_snapshots SET strategy_id=60002'],
      ['snapshot-purpose-mismatch', "UPDATE inference_snapshots SET purpose='trader'"],
      ['snapshot-account-not-null', 'UPDATE inference_snapshots SET trading_account_id=9'],
      ['missing-payload', 'DELETE FROM inference_snapshot_payloads'],
    ]) {
      await connection.beginTransaction()
      try { await connection.query(sql); assert.equal(await reader.read(scope), null); checks.push(name) }
      finally { await connection.rollback() }
    }
    await connection.query('UPDATE ai_analysis_runs SET market_source_account_id=NULL')
    assert.equal((await reader.read(scope)).sourceAccountId, '9')
    checks.push('manual-source-from-snapshot')
    await connection.query('UPDATE ai_analysis_runs SET market_source_account_id=8')
    await assert.rejects(reader.read(scope), { code: 'analysis_source_evidence_invalid' })
    checks.push('conflicting-run-source-rejected')
    await connection.query('UPDATE ai_analysis_runs SET market_source_account_id=9')
    await connection.execute('UPDATE inference_snapshot_payloads SET payload_json=?', [JSON.stringify({ ...payload, market: { ...payload.market, source_account_id: '8' } })])
    await assert.rejects(reader.read(scope), { code: 'analysis_source_evidence_invalid' })
    checks.push('tampered-payload-rejected')
    return { passed: true, schema: 'isolated-temporary-minimal-fixtures', foreignKeysVerified: false, checks }
  } finally {
    for (const name of tables.reverse()) await connection.query(`DROP TEMPORARY TABLE ${name}`)
  }
}
