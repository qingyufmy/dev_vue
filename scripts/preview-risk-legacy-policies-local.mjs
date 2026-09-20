import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { readPlatformRiskValues, readPlatformRiskControls, resolveRiskPolicy } from '../server/dist-v4/modules/risk/domain/risk.js'
import { inspectLegacyRiskPolicy } from './lib/risk-legacy-policy-mapping.mjs'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const output = await open(destination, 'wx', 0o600)
const pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
let connection
try {
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone tz')
  assert.deepEqual({ ...identity }, { db: 'dev_vue', uuid: 'ac423207-6ef3-11f1-b302-000c29fda104', tz: '+00:00' })
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [rows] = await connection.query(`SELECT v.id,s.id policySetId,s.scope,s.status,s.owner_user_id ownerUserId,
    CAST(s.trading_account_id AS CHAR) accountId,s.active_version_id=v.id activeVersion,v.config_json,
    EXISTS(SELECT 1 FROM trading_account_ownerships o WHERE o.user_id=s.owner_user_id AND o.trading_account_id=s.trading_account_id AND o.role='owner' AND o.revoked_at_utc IS NULL) currentOwner,
    EXISTS(SELECT 1 FROM trading_account_ownerships o WHERE o.user_id=s.owner_user_id AND o.trading_account_id=s.trading_account_id AND o.role='owner' AND o.revoked_at_utc IS NOT NULL) revokedOwner
    FROM risk_policy_versions v JOIN risk_policy_sets s ON s.id=v.policy_set_id ORDER BY v.id LIMIT 1001`)
  assert.ok(rows.length <= 1000)
  const versions = rows.map(row => {
    const mapped = inspectLegacyRiskPolicy(row.config_json)
    let platformCandidateCheck = null
    if (row.scope === 'platform' && mapped.valid) {
      const raw = { values: { ...mapped.candidates, manualReleaseEnabled: false }, controls: mapped.controlCandidates }
      try {
        const values = readPlatformRiskValues(raw), controls = readPlatformRiskControls(raw)
        resolveRiskPolicy({ userId: 1, accountId: 'preview-only', platformPolicyVersionId: String(row.id),
          accountPolicyVersionId: null, policySetRevision: 0, platform: { values, controls, globalKillSwitch: false, revision: 1 },
          account: null, updatedAt: '2026-09-09T00:00:00.000Z' })
        platformCandidateCheck = 'accepted'
      }
      catch (error) { platformCandidateCheck = error.code ?? 'candidate_invalid' }
    }
    return { id: String(row.id), scope: row.scope, activeVersion: Number(row.activeVersion) === 1, sourceSha256: mapped.sourceSha256,
      valid: mapped.valid, activationReady: false, candidateFields: Object.keys(mapped.candidates ?? {}),
      controlCandidateFields: Object.keys(mapped.controlCandidates ?? {}), issues: mapped.issues, platformCandidateCheck, manualReleaseMigration: row.scope === 'platform' ? 'disabled_no_legacy_authorization' : null }
  })
  const issueCounts = {}
  for (const version of versions) for (const issue of version.issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1
  const platforms = rows.filter(row => row.scope === 'platform' && row.status === 'active' && Number(row.activeVersion) === 1)
  const activeAccounts = rows.filter(row => row.scope === 'account' && row.status === 'active' && Number(row.activeVersion) === 1)
  const accountChecks = activeAccounts.map(row => {
    const base = { versionId: String(row.id), policySetId: String(row.policySetId), currentOwner: Number(row.currentOwner) === 1 }
    if (platforms.length !== 1) return { ...base, result: 'platform_selection_ambiguous' }
    if (Number(row.currentOwner) !== 1 && Number(row.revokedOwner) === 1) return { ...base, result: 'historical_revoked_owner_preserve_without_activation' }
    if (Number(row.currentOwner) !== 1 || !row.accountId || !Number.isSafeInteger(row.ownerUserId) || row.ownerUserId <= 0) return { ...base, result: 'account_ownership_mapping_required' }
    const platform = inspectLegacyRiskPolicy(platforms[0].config_json), account = inspectLegacyRiskPolicy(row.config_json)
    if (!platform.valid || !account.valid || account.issues.length) return { ...base, result: 'unmapped_account_fields' }
    const raw = { values: { ...platform.candidates, manualReleaseEnabled: false }, controls: platform.controlCandidates }
    try {
      const policy = resolveRiskPolicy({ userId: row.ownerUserId, accountId: row.accountId, platformPolicyVersionId: String(platforms[0].id),
        accountPolicyVersionId: String(row.id), policySetRevision: 0,
        platform: { values: readPlatformRiskValues(raw), controls: readPlatformRiskControls(raw), globalKillSwitch: false, revision: 1 },
        account: account.candidates, updatedAt: '2026-09-09T00:00:00.000Z' })
      return { ...base, result: 'accepted', platformVersionId: String(platforms[0].id),
        mappedFields: Object.keys(account.candidates), effectiveFields: Object.keys(account.candidates).filter(key => Object.hasOwn(policy.values, key)) }
    } catch (error) { return { ...base, result: error.code ?? 'effective_account_invalid' } }
  })
  await connection.rollback()
  const report = { kind: 'risk-policy-mapping-preview/v2', identity, observedAt: new Date().toISOString(), versions,
    sourceVersions: versions.length, controlCandidates: versions.reduce((sum, row) => sum + row.controlCandidateFields.length, 0),
    issueCounts, accountChecks, writes: 0, scope: 'Platform candidates and current active account selection/ownership checked; historical version lineage, semantic equivalence and activation remain unverified.' }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ sourceVersions: report.sourceVersions, controlCandidates: report.controlCandidates, issueCounts,
    platformCandidateChecks: versions.filter(row => row.scope === 'platform').map(row => row.platformCandidateCheck), accountChecks, writes: 0 }))
} catch (error) {
  await output.writeFile(JSON.stringify({ inspected: false, code: error.code ?? 'risk_policy_preview_failed' }) + '\n')
  console.log(JSON.stringify({ inspected: false, code: error.code ?? 'risk_policy_preview_failed' })); process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.release() }
  await pool.end(); await output.sync(); await output.close()
}
