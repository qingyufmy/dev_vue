import { canonical, exactKeys, hash, streamIdentity, requireBackfill as check } from './v4-backfill-contract.mjs'
import { accountSourceFields } from './v4-account-conversion.mjs'

const streams = [
  { table: 'trading_accounts', role: 'account-entity-settings-v1', fields: accountSourceFields },
  { table: 'mt5_account_ownership_history', role: 'ownership-interval-grants-v1', fields:
    ['id', 'broker_server_key', 'login_account', 'user_id', 'trading_account_id', 'started_at', 'ended_at', 'end_reason', 'created_at', 'updated_at'] },
]
export function sourceEvidencePayload(streamId, row) {
  const stream = streams.find(item => streamIdentity({ sourceTable: item.table, role: item.role }) === streamId)
  check(stream, 'backfill_source_evidence_stream_invalid')
  const source = row.payload?.provenance?.source, timeBasisHash = row.payload?.provenance?.timeBasisHash
  exactKeys(source, stream.fields)
  check(Object.values(source).every(value => value === null || typeof value === 'string'), 'backfill_source_evidence_value_invalid')
  check(row.pk.length === 1 && row.pk[0].type === 'integer' && row.pk[0].value === source.id
    && hash(source) === row.sourceHash && /^[a-f0-9]{64}$/.test(timeBasisHash ?? ''), 'backfill_source_evidence_mismatch')
  const payload = { version: 1, sourceTable: stream.table, source, timeBasisHash }
  check(Buffer.byteLength(canonical(payload)) <= 1024 * 1024, 'backfill_source_evidence_too_large')
  return payload
}
// Called immediately after the receipt INSERT on the same transaction connection.
export async function insertSourceEvidence(connection, run, stream, row) {
  const payload = sourceEvidencePayload(stream, row), pkHash = hash(row.pk)
  await connection.execute('INSERT INTO data_migration_source_rows (run_id,stream_id,source_pk_sha256,source_bytes_sha256,source_payload_json,created_at_utc) VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))',
    [run, stream, pkHash, row.sourceHash, canonical(payload)])
  const [[saved]] = await connection.execute('SELECT source_bytes_sha256,source_payload_json FROM data_migration_source_rows WHERE run_id=? AND stream_id=? AND source_pk_sha256=? FOR UPDATE', [run, stream, pkHash])
  const actual = typeof saved?.source_payload_json === 'string' ? JSON.parse(saved.source_payload_json) : saved?.source_payload_json
  check(saved?.source_bytes_sha256 === row.sourceHash && canonical(actual) === canonical(payload), 'backfill_source_evidence_readback_mismatch')
}
