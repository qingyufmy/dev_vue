import assert from 'node:assert/strict'
import { createRuntimeStrategyAccess } from '../../server/dist-v4/modules/strategies/composition.js'
import { createAccountPrincipalReader, createActivePrincipalAccess } from '../../server/dist-v4/modules/auth/composition.js'
import { createMysqlModelUsageLedger } from '../../server/dist-v4/modules/inference/composition.js'

export async function verifyModelAccessReference(connection, pool) {
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  // Minimal user/model-policy/usage fixtures; not a full model configuration schema proof.
  await connection.query(`ALTER TABLE users ADD COLUMN plan VARCHAR(20) NOT NULL DEFAULT 'pro',
    ADD COLUMN plan_expires_at DATETIME(3) NULL,ADD COLUMN token_version INT NOT NULL DEFAULT 0`)
  await connection.query("INSERT INTO users (id,deletion_status) VALUES (70,'active')")
  await connection.query(`CREATE TABLE platform_model_usage_policy (id INT PRIMARY KEY,share_for_manual TINYINT,
    share_for_auto TINYINT,allowed_plans JSON,daily_requests_per_user INT,daily_tokens_per_user INT) ENGINE=InnoDB`)
  await connection.query('CREATE TABLE ai_model_usage_logs (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,user_id INT,'
    + 'model_profile_id BIGINT UNSIGNED,credential_source VARCHAR(32),'
    + '`usage` VARCHAR(16),strategy_id BIGINT UNSIGNED,request_phase VARCHAR(16),token_count BIGINT,'
    + 'request_status VARCHAR(16),error_code VARCHAR(128),accounting_status VARCHAR(32),created_at DATETIME(3)) ENGINE=InnoDB')
  await connection.query(`INSERT INTO platform_model_usage_policy VALUES (1,1,1,'["pro"]',1,100)`)
  const utcPool = { async getConnection() {
    const db = await pool.getConnection()
    try { await db.query("SET SESSION time_zone='+00:00'"); return db } catch (error) { db.release(); throw error }
  } }
  const ledger = createMysqlModelUsageLedger(utcPool, { principals: createAccountPrincipalReader, active: createActivePrincipalAccess })
  const context = { userId: 70, profileId: '1', strategyId: '60001', credentialSource: 'platform_shared', usage: 'auto' }
  const results = await Promise.allSettled([ledger.begin(context), ledger.begin(context)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.deepEqual(results.filter(result => result.status === 'rejected').map(result => result.reason.code), ['daily_request_limit'])
  const [[count]] = await connection.query('SELECT COUNT(*) n FROM ai_model_usage_logs')
  assert.equal(Number(count.n), 1)
  await connection.query("UPDATE users SET plan='free' WHERE id=8")
  await assert.rejects(ledger.begin({ ...context, userId: 8 }), { code: 'platform_model_sharing_unavailable' })
  await assert.rejects(ledger.begin({ ...context, userId: 999999 }), { code: 'platform_model_sharing_unavailable' })
  await connection.query("UPDATE users SET deleted_at=UTC_TIMESTAMP(3) WHERE id=70")
  await assert.rejects(ledger.begin(context), { code: 'platform_model_sharing_unavailable' })
  await connection.query('UPDATE users SET deleted_at=NULL WHERE id=70')
  await connection.query('UPDATE platform_model_usage_policy SET daily_requests_per_user=10,daily_tokens_per_user=5 WHERE id=1')
  await connection.query('UPDATE ai_model_usage_logs SET token_count=5')
  await assert.rejects(ledger.begin(context), { code: 'daily_token_limit' })
  await connection.query('UPDATE platform_model_usage_policy SET share_for_auto=0 WHERE id=1')
  await assert.rejects(ledger.begin(context), { code: 'platform_model_sharing_unavailable' })
  const [[after]] = await connection.query('SELECT COUNT(*) n FROM ai_model_usage_logs')
  assert.equal(Number(after.n), 1)

  const strategies = createRuntimeStrategyAccess(connection)
  await connection.query('UPDATE strategies SET active_version_id=60011 WHERE id=60001')
  assert.equal(await strategies.canUseCurrent(7, '60001', '60011'), true)
  assert.equal(await strategies.canUseCurrent(7, '60001', '60012'), false)
  assert.equal(await strategies.canUseFrozenReview(7, '60002'), true)
  assert.equal(await strategies.canUseFrozenReview(8, '60002'), false)
  await connection.query("UPDATE strategies SET status='retired' WHERE id=60001")
  assert.equal(await strategies.canUseCurrent(7, '60001', '60011'), false)
  assert.equal(await strategies.canUseFrozenReview(7, '60001'), true)
  await connection.query('UPDATE strategies SET deleted_at_utc=UTC_TIMESTAMP(3) WHERE id=60001')
  assert.equal(await strategies.canUseFrozenReview(7, '60001'), false)
  return { passed: true, modelAndUserSchema: 'minimal_reference_fixture', checks: [
    'concurrent-shared-quota-one-reservation-only', 'plan-missing-user-deleted-user-and-sharing-denials-write-zero-rows',
    'token-quota-rejection-preserves-reservations', 'live-active-version-and-frozen-retired-strategy-access',
  ] }
}
