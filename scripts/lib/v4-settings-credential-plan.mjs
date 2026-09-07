import { open, readFile } from 'node:fs/promises'
import { hash, exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
import { settingsValueContracts } from './v4-settings-value-contract.mjs'
import { convertSettingCredential } from './v4-settings-credential-conversion.mjs'

const credentialKeys = new Set(settingsValueContracts().filter(rule => rule.type === 'credential').map(rule => `${rule.namespace}/${rule.key}`))
const digest = /^[a-f0-9]{64}$/
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
function scope(sources, binding) {
  exactKeys(binding, ['runId', 'snapshotHash'])
  check(typeof binding.runId === 'string' && uuid.test(binding.runId)
    && typeof binding.snapshotHash === 'string' && digest.test(binding.snapshotHash), 'credential_plan_binding')
  check(Array.isArray(sources) && sources.length > 0 && sources.length <= credentialKeys.size, 'credential_plan_sources')
  const ids = new Set(), keys = new Set()
  for (const source of sources) {
    exactKeys(source, ['sourceId', 'namespace', 'key', 'sourceRowHash', 'sourceFormat', 'value'])
    const key = `${source.namespace}/${source.key}`
    check(typeof source.sourceId === 'string' && /^[1-9][0-9]{0,9}$/.test(source.sourceId)
      && BigInt(source.sourceId) <= 2147483647n && !ids.has(source.sourceId)
      && credentialKeys.has(key) && !keys.has(key)
      && typeof source.sourceRowHash === 'string' && digest.test(source.sourceRowHash)
      && typeof source.value === 'string', 'credential_plan_source')
    ids.add(source.sourceId); keys.add(key)
  }
  return [...sources].sort((a, b) => BigInt(a.sourceId) < BigInt(b.sourceId) ? -1 : 1)
}
function identity(source) {
  return { sourceId: source.sourceId, namespace: source.namespace, key: source.key,
    sourceRowHash: source.sourceRowHash, sourceFormat: source.sourceFormat }
}
function body(plan) {
  return { version: plan.version, binding: plan.binding, entries: plan.entries }
}
export function prepareCredentialPlan(sources, binding, { keyring, activeVersion }) {
  const entries = scope(sources, binding).map(source => {
    const result = convertSettingCredential(source.value, { sourceFormat: source.sourceFormat, keyring, activeVersion })
    return { ...identity(source), targetValue: result.value }
  })
  const plan = { version: 'settings-credential-plan/v1', binding: structuredClone(binding), entries }
  return { ...plan, checksum: hash(plan) }
}
export function verifyCredentialPlan(plan, sources, binding, { keyring }) {
  const sorted = scope(sources, binding)
  exactKeys(plan, ['version', 'binding', 'entries', 'checksum'])
  check(plan.version === 'settings-credential-plan/v1' && hash(plan.binding) === hash(binding)
    && plan.checksum === hash(body(plan)) && Array.isArray(plan.entries)
    && plan.entries.length === sorted.length, 'credential_plan_mismatch')
  for (let i = 0; i < sorted.length; i++) {
    const source = sorted[i], entry = plan.entries[i]
    exactKeys(entry, ['sourceId', 'namespace', 'key', 'sourceRowHash', 'sourceFormat', 'targetValue'])
    check(hash(identity(entry)) === hash(identity(source)), 'credential_plan_source_changed')
    const result = convertSettingCredential(source.value, { sourceFormat: source.sourceFormat, keyring, existingTarget: entry.targetValue })
    check(result.reused, 'credential_plan_reuse_required')
    if (source.sourceFormat === 'encrypted') check(entry.targetValue === source.value, 'credential_plan_ciphertext_changed')
  }
  return structuredClone(plan)
}

// File contains ciphertext only (plus source identifiers/hashes), never source
// plaintext or keyring. Caller chooses a controlled private path outside Git.
// Persist and verify this plan BEFORE opening a database write transaction.
// An incomplete/corrupt existing file fails closed; it is never overwritten.
export async function persistCredentialPlan(path, sources, binding, options) {
  check(options.expectedChecksum === undefined || (typeof options.expectedChecksum === 'string'
    && digest.test(options.expectedChecksum)), 'credential_plan_expected_checksum')
  const load = async () => {
    let plan
    try { plan = JSON.parse(await readFile(path, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') throw error; throw new Error('credential_plan_file_invalid') }
    const verified = verifyCredentialPlan(plan, sources, binding, options)
    check(options.expectedChecksum === undefined || verified.checksum === options.expectedChecksum, 'credential_plan_expected_checksum')
    return verified
  }
  try { return await load() } catch (error) {
    if (error.code !== 'ENOENT') throw error
    check(options.expectedChecksum === undefined, 'credential_plan_committed_file_missing')
  }
  const plan = prepareCredentialPlan(sources, binding, options)
  let file
  try { file = await open(path, 'wx', 0o600) }
  catch (error) { if (error.code === 'EEXIST') return load(); throw new Error('credential_plan_file_create_failed') }
  try { await file.writeFile(JSON.stringify(plan) + '\n', 'utf8'); await file.sync() }
  catch { throw new Error('credential_plan_file_write_unknown') }
  finally { await file.close() }
  return load()
}
