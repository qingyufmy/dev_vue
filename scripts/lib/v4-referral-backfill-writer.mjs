import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { convertReferralAccounts } from './v4-referral-conversion.mjs'

const fields = ['user_id', 'referral_code', 'referred_by_code', 'referral_credit', 'revision', 'updated_at_utc']
const pk = value => [{ type: 'integer', value }]
const select = "SELECT CAST(user_id AS CHAR) user_id,referral_code,referred_by_code,referral_credit,CAST(revision AS CHAR) revision,DATE_FORMAT(updated_at_utc,'%Y-%m-%d %H:%i:%s.%f') updated_at_utc FROM user_referral_accounts WHERE user_id=? FOR UPDATE"

export function createReferralBackfill(rows, registeredAtUtc, { batchSize = 100 } = {}) {
  check(Number.isInteger(batchSize) && batchSize > 0 && batchSize <= 500, 'referral_writer_batch_size_invalid')
  const converted = convertReferralAccounts(rows, registeredAtUtc)
  const stream = { sourceTable: 'users', role: 'referral-account-v1' }
  const transformHash = hash({ version: 'referral-writer/v1', conversion: converted.version, registeredAtUtc, fields })
  const prepared = converted.entries.map(entry => {
    const target = { table: 'user_referral_accounts', pk: pk(entry.source.id) }
    const targets = [target], payload = { target: entry.target, provenance: { source: entry.source, registeredAtUtc } }
    return { pk: pk(entry.source.id), sourceHash: entry.sourceHash, targets, payload, transformedHash: hash({ payload, targets }),
      idMaps: [{ entityKind: 'referral-account', sourceTable: 'users', sourcePk: pk(entry.source.id), target }] }
  })
  const expected = new Map(prepared.map(row => [canonical(row.pk), canonical(row)])), batches = []
  let cursor = null
  for (let offset = 0; offset < prepared.length; offset += batchSize) {
    const members = prepared.slice(offset, offset + batchSize)
    const content = { stream, sequence: batches.length + 1, startCursor: cursor, endCursor: members.at(-1).pk, rows: members }
    batches.push({ batchId: hash({ transformHash, content }), ...content }); cursor = content.endCursor
  }
  const writer = { storageMode: 'inplace-referral-v1', transformHash, async write(connection, row) {
    check(expected.get(canonical(row.pk)) === canonical(row), 'referral_writer_row_mismatch')
    const target = row.payload.target
    const read = async () => {
      const [saved] = await connection.execute(select, [target.user_id])
      check(saved.length <= 1, 'referral_writer_duplicate')
      if (!saved.length) return null
      const value = { ...saved[0] }
      check(typeof value.updated_at_utc === 'string' && /\.\d{3}000$/.test(value.updated_at_utc), 'referral_writer_time_precision')
      value.updated_at_utc = value.updated_at_utc.slice(0, -3)
      return value
    }
    const current = await read()
    if (current) check(canonical(current) === canonical(target), 'referral_writer_target_conflict')
    else {
      await connection.execute(`INSERT INTO user_referral_accounts (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(field => target[field]))
      check(canonical(await read()) === canonical(target), 'referral_writer_readback_mismatch')
    }
    return { transformedHash: row.transformedHash }
  } }
  return { batches: structuredClone(batches), writer, stream, transformHash, sourceHash: converted.sourceHash,
    sourceRows: prepared.length, registeredAtUtc, sourceProvenancePersisted: false, businessWritesPerformed: false }
}
