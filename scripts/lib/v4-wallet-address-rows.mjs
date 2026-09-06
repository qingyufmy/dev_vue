import { exactKeys, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { inspectWalletAddressSources } from './v4-wallet-address-source.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'

export function prepareWalletAddressRows(wallets, { run, basis, evidenceCatalog }) {
  exactKeys(run, ['id', 'sourceSnapshotId', 'registeredAtUtc'])
  check(typeof run.id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(run.id)
    && typeof run.sourceSnapshotId === 'string' && run.sourceSnapshotId.length > 0
    && typeof run.registeredAtUtc === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.registeredAtUtc), 'wallet_run_invalid')
  const registered = inspectWallClock(run.registeredAtUtc.replace('T', ' ').slice(0, -1)).canonicalWallClock
  const source = inspectWalletAddressSources(wallets)
  check(source.blockers.every(b => ['wallet_created_time_basis_required', 'wallet_custody_binding_unverified'].includes(b.code)), 'wallet_source_blocked')
  exactKeys(basis, ['version', 'sourceHash', 'sourceSnapshotId', 'resolutions'])
  check(basis.version === 'wallet-address-time/v1' && basis.sourceHash === source.sourceHash
    && basis.sourceSnapshotId === run.sourceSnapshotId && Array.isArray(basis.resolutions)
    && basis.resolutions.length === wallets.length && evidenceCatalog instanceof Map, 'wallet_basis_scope')
  const resolutions = new Map()
  for (const resolution of basis.resolutions) {
    exactKeys(resolution, ['sourceId', 'sourceHash', 'rawCreatedAt', 'timeKind', 'offsetMinutes', 'evidenceId', 'evidenceSha256'])
    check(!resolutions.has(resolution.sourceId), 'wallet_basis_duplicate')
    resolutions.set(resolution.sourceId, resolution)
  }
  const entries = source.entries.map(entry => {
    const row = entry.source, resolution = resolutions.get(entry.sourceId)
    check(resolution && resolution.sourceHash === entry.sourceHash && resolution.rawCreatedAt === row.created_at, 'wallet_basis_binding')
    check(typeof resolution.evidenceId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(resolution.evidenceId)
      && typeof resolution.evidenceSha256 === 'string' && /^[a-f0-9]{64}$/.test(resolution.evidenceSha256)
      && evidenceCatalog.get(resolution.evidenceId) === resolution.evidenceSha256, 'wallet_basis_evidence')
    let created = null
    if (row.created_at === null) {
      check(resolution.timeKind === 'source_null' && resolution.offsetMinutes === null, 'wallet_null_creation_rule')
    } else {
      check(resolution.timeKind === 'wall_clock' && Number.isInteger(resolution.offsetMinutes)
        && Math.abs(resolution.offsetMinutes) <= 840, 'wallet_creation_rule')
      const wall = inspectWallClock(row.created_at).canonicalWallClock
      const utc = new Date(Date.parse(wall.replace(' ', 'T') + 'Z') - resolution.offsetMinutes * 60000).toISOString()
      check(/^\d{4}-/.test(utc) && utc.slice(0, 4) >= '1000' && utc.slice(0, 4) <= '9999', 'wallet_creation_range')
      created = utc.replace('T', ' ').replace('Z', '')
    }
    const target = { id: row.id, chain: row.chain, address_index: row.address_index, address: row.address,
      created_at_utc: created, custody_reference: null, custody_evidence_sha256: null, custody_verified_at_utc: null,
      revision: '1', origin: 'legacy_import', migration_run_id: run.id, source_sha256: entry.sourceHash, imported_at_utc: registered }
    return { sourceId: entry.sourceId, sourceHash: entry.sourceHash, target, targetHash: hash(target),
      provenance: { source: row, basisHash: hash(basis), resolution: { ...resolution } } }
  })
  return { version: 'wallet-address-rows/v1', sourceHash: source.sourceHash, entries, transformHash: hash(entries),
    custodyVerified: false, privateKeysRead: false, businessWritesEnabled: false,
    unresolvedDependencies: ['custody_control_evidence', 'wallet_runtime_cutover'], fullWalletConverted: false }
}
