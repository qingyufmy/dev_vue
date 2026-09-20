import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { inspectLegacyRiskPolicy } from './risk-legacy-policy-mapping.mjs'
import { hash, canonical } from './v4-backfill-contract.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { createFrozenSourceBatch } from './frozen-source-batch.mjs'
import { DEFAULT_RISK_POLICY, ACCOUNT_EDITABLE_FIELDS, readPlatformRiskValues, readPlatformRiskControls, resolveRiskPolicy } from '../../server/dist-v4/modules/risk/index.js'

export const riskTables = ['risk_policy_sets_v4', 'risk_policy_versions_v4']
const sha = text => createHash('sha256').update(text).digest('hex')
const utc = value => inspectWallClock(value).canonicalWallClock
const pk = value => [{ type: 'integer', value }]
const q = name => { assert.match(name, /^[a-z][a-z0-9_]*$/); return `\`${name}\`` }
export const riskJson = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)

export function convertRiskPolicy(raw, scope) {
  assert.ok(['platform', 'account'].includes(scope))
  const inspected = inspectLegacyRiskPolicy(raw)
  assert.ok(inspected.valid, 'risk_source_invalid')
  assert.ok(inspected.issues.every(issue => ['execution_dedup_window_unmapped', 'execution_dedup_distance_unmapped'].includes(issue.code)), 'risk_source_unmapped')
  if (scope === 'account') {
    assert.equal(Object.keys(inspected.controls).length, 0, 'risk_account_controls_unexpected')
    assert.equal(Object.keys(inspected.retained).length, 0, 'risk_account_rules_unmapped')
    assert.ok(Object.keys(inspected.candidates).every(key => ACCOUNT_EDITABLE_FIELDS.includes(key)), 'risk_account_field_unmapped')
    return { policyJson: riskJson({ ...inspected.candidates, tradeSendEnabled: false }), disposition: 'account_patch_preserved_send_disabled' }
  }
  const distance = inspected.retained.dedup_price_atr, window = inspected.retained.dedup_window_seconds
  assert.ok(typeof distance === 'number' && Number.isFinite(distance) && distance >= 0 && distance <= 5, 'risk_dedup_distance_invalid')
  assert.ok(Number.isSafeInteger(window) && window >= 0 && window <= 86400, 'risk_dedup_window_invalid')
  const values = { ...DEFAULT_RISK_POLICY, ...inspected.candidates, pendingDedupAtrMultiplier: distance,
    manualReleaseEnabled: false, tradeSendEnabled: false }
  const policyJson = riskJson({ values, controls: inspected.controlCandidates })
  readPlatformRiskValues(policyJson); readPlatformRiskControls(policyJson)
  return { policyJson, disposition: 'dedup_window_archived_no_legacy_execution_consumer',
    legacyDedupWindowSeconds: window, explicitV4DefaultsJson: riskJson(Object.fromEntries(Object.entries(values)
      .filter(([key]) => !Object.hasOwn(inspected.candidates, key) && key !== 'pendingDedupAtrMultiplier'))) }
}

export async function readRiskSources(db, lock = false) {
  const rows = []
  for (const table of ['risk_policy_sets', 'risk_policy_versions']) {
    const [columns] = await db.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])
    assert.ok(columns.length)
    const [found] = await db.query(`SELECT ${columns.map(({ name }) => `CAST(${q(name)} AS CHAR) ${q(name)}`).join(',')} FROM ${table} ORDER BY id LIMIT 1001${lock ? ' FOR SHARE' : ''}`)
    assert.ok(found.length <= 1000); rows.push(found.map(row => ({ ...row })))
  }
  const [sets, versions] = rows
  assert.ok(versions.every(row => sets.some(set => set.id === row.policy_set_id)), 'risk_orphan_version')
  return sets.map(set => ({ id: set.id, set, versions: versions.filter(row => row.policy_set_id === set.id) }))
}

export function projectRiskTransition(sources, accounts, ownerships, users) {
  const entries = sources.map(source => {
    const old = source.set
    assert.ok(['platform', 'account'].includes(old.scope) && ['active', 'retired'].includes(old.status))
    const account = old.scope === 'account' ? accounts.find(row => row.sourcePk[0].value === old.trading_account_id) : null
    assert.ok(old.scope === 'platform' ? old.owner_user_id === '0' && old.trading_account_id === null : account && users.has(old.owner_user_id), 'risk_account_mapping_missing')
    const accountId = account?.target.pk[0].value ?? null
    const owns = ownerships.some(row => row.user_id === old.owner_user_id && row.account_id === accountId && row.role === 'owner' && row.revoked_at_utc === null)
    const versions = source.versions.map(row => {
      assert.match(row.version_no, /^[1-9]\d*$/); assert.ok(BigInt(row.version_no) <= 4294967295n)
      assert.ok(users.has(row.created_by), 'risk_actor_missing')
      const converted = convertRiskPolicy(row.config_json, old.scope)
      return { row: { id: row.id, policy_set_id: old.id, version_number: row.version_no, policy_json: converted.policyJson,
        policy_sha256: sha(converted.policyJson), created_by_user_id: row.created_by, change_reason: row.change_reason ?? 'Legacy migration (no original reason)',
        legacy_source_table: 'risk_policy_versions', legacy_id: row.id, created_at_utc: utc(row.created_at) }, conversion: converted }
    })
    assert.equal(new Set(versions.map(v => v.row.version_number)).size, versions.length, 'risk_duplicate_version')
    assert.ok(versions.some(v => v.row.id === old.active_version_id), 'risk_active_version_missing')
    return { source, sourceHash: hash(source), accountMapping: account,
      set: { id: old.id, scope: old.scope, owner_user_id: old.scope === 'platform' ? null : old.owner_user_id, trading_account_id: accountId,
        name: old.name, status: old.status === 'active' && (old.scope === 'platform' || owns) ? 'active' : 'retired',
        active_version_id: old.active_version_id, revision: '1', legacy_source_table: 'risk_policy_sets', legacy_id: old.id,
        created_at_utc: utc(old.created_at), updated_at_utc: utc(old.updated_at) }, versions }
  })
  const active = entries.filter(e => e.set.status === 'active')
  assert.equal(active.filter(e => e.set.scope === 'platform').length, 1)
  assert.equal(new Set(active.map(e => e.set.scope === 'platform' ? 'platform' : e.set.trading_account_id)).size, active.length)
  const platform = active.find(e => e.set.scope === 'platform')
  const raw = platform.versions.find(v => v.row.id === platform.set.active_version_id).row.policy_json
  for (const entry of active.filter(e => e.set.scope === 'account')) {
    const effective = resolveRiskPolicy({ accountId: entry.set.trading_account_id, userId: Number(entry.set.owner_user_id),
      platformPolicyVersionId: platform.set.active_version_id, accountPolicyVersionId: entry.set.active_version_id, policySetRevision: 1,
      platform: { values: readPlatformRiskValues(raw), controls: readPlatformRiskControls(raw), globalKillSwitch: false, revision: 1 },
      account: JSON.parse(entry.versions.find(v => v.row.id === entry.set.active_version_id).row.policy_json), updatedAt: '2026-09-11T00:00:00.000Z' })
    assert.equal(effective.values.tradeSendEnabled, false); assert.equal(effective.values.manualReleaseEnabled, false)
  }
  return entries
}

export function createRiskTransitionBatch(entries, options) {
  return createFrozenSourceBatch(entries, options, {
    sourceTable: 'risk_policy_sets', role: 'risk-policy-history-v1', errorPrefix: 'risk',
    projectRow(entry) { return { pk: pk(entry.source.id), source: entry.source, sourceHash: entry.sourceHash,
      targets: [{ table: riskTables[0], pk: pk(entry.set.id) }, ...entry.versions.map(v => ({ table: riskTables[1], pk: pk(v.row.id) }))], transformedHash: hash(entry) } },
    createWriter(frozen, { runId, logicalSourceId }) {
      return { async write(tx, entry, { verifyOnly = false } = {}) {
        assert.ok(frozen.some(row => canonical(row) === canonical(entry)))
        const current = (await readRiskSources(tx.connection, true)).find(row => row.id === entry.source.id)
        assert.equal(hash(current), entry.sourceHash, 'risk_source_changed')
        if (entry.accountMapping) assert.equal(canonical(await tx.findMapping(logicalSourceId, { entityKind: 'trading_account', sourceTable: 'trading_accounts', ...entry.accountMapping })), canonical(entry.accountMapping), 'risk_account_mapping_changed')
        if (entry.set.scope === 'account') {
          const [owners] = await tx.connection.execute("SELECT user_id FROM trading_account_ownerships WHERE trading_account_id=? AND user_id=? AND role='owner' AND revoked_at_utc IS NULL FOR SHARE", [entry.set.trading_account_id, entry.set.owner_user_id])
          assert.equal(entry.set.status, entry.source.set.status === 'active' && owners.length ? 'active' : 'retired', 'risk_ownership_changed')
        }
        const writeRow = async (table, row, initial = row) => {
          const keys = Object.keys(row)
          const [found] = await tx.connection.execute(`SELECT ${keys.map(key => `CAST(${q(key)} AS CHAR) ${q(key)}`).join(',')} FROM ${table} WHERE id=? FOR UPDATE`, [row.id])
          if (found.length) {
            const normalized = { ...found[0] }
            for (const key of keys) {
              if (key.endsWith('_at_utc')) normalized[key] = utc(normalized[key])
              if (key === 'policy_json') normalized[key] = riskJson(JSON.parse(normalized[key]))
            }
            assert.equal(canonical(normalized), canonical(row), 'risk_target_conflict'); return false
          }
          assert.ok(!verifyOnly, 'risk_target_missing')
          await tx.connection.execute(`INSERT INTO ${table} (${keys.map(q).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(key => initial[key]))
          return true
        }
        const inserted = await writeRow(riskTables[0], entry.set, { ...entry.set, active_version_id: null })
        for (const version of entry.versions) { await writeRow(riskTables[1], version.row); await writeRow(riskTables[1], version.row) }
        if (inserted) await tx.connection.execute('UPDATE risk_policy_sets_v4 SET active_version_id=? WHERE id=? AND active_version_id IS NULL', [entry.set.active_version_id, entry.set.id])
        await writeRow(riskTables[0], entry.set)
        const mappings = [{ entityKind: 'risk-policy-set', sourceTable: 'risk_policy_sets', sourcePk: pk(entry.source.id), target: { table: riskTables[0], pk: pk(entry.set.id) } },
          ...entry.versions.map(v => ({ entityKind: 'risk-policy-version', sourceTable: 'risk_policy_versions', sourcePk: pk(v.row.legacy_id), target: { table: riskTables[1], pk: pk(v.row.id) } }))]
        for (const mapping of mappings) {
          if (!await tx.findMapping(logicalSourceId, mapping)) { assert.ok(!verifyOnly); await tx.insertMapping(runId, logicalSourceId, mapping) }
          assert.equal(canonical(await tx.findMapping(logicalSourceId, mapping)), canonical({ sourcePk: mapping.sourcePk, target: mapping.target }))
        }
      } }
    },
  })
}
