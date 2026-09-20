import type { PoolConnection, RowDataPacket } from 'mysql2/promise'

import type { WalletAddress, WalletChain } from '../application/wallet-address-reader.js'
interface WalletRow extends RowDataPacket {
  id: string; chain: WalletChain; address_index: string; address: string; created_at_utc: string | null
  revision: string; custody_reference: string | null; custody_evidence_sha256: string | null; custody_verified_at_utc: string | null
}
const integer = (value: unknown, minimum: bigint, maximum: bigint): value is string => typeof value === 'string'
  && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20 && BigInt(value) >= minimum && BigInt(value) <= maximum
const utc = (value: unknown): value is string => typeof value === 'string'
  && /^[1-9][0-9]{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const projection = `CAST(id AS CHAR) id,chain,CAST(address_index AS CHAR) address_index,address,
  CONCAT(LEFT(DATE_FORMAT(created_at_utc,'%Y-%m-%dT%H:%i:%s.%f'),23),'Z') created_at_utc,
  CAST(revision AS CHAR) revision,custody_reference,custody_evidence_sha256,
  CONCAT(LEFT(DATE_FORMAT(custody_verified_at_utc,'%Y-%m-%dT%H:%i:%s.%f'),23),'Z') custody_verified_at_utc`

// Returns registration metadata, not authorization to sign or sweep funds.
// Cutover must establish migration completeness before an empty page is meaningful.
export async function listWalletAddresses(connection: Pick<PoolConnection, 'execute'>,
  input: { chain: WalletChain; afterId?: string; limit?: number }): Promise<{ items: WalletAddress[]; nextAfterId: string | null }> {
  const { chain, afterId = '0', limit = 100 } = input
  if (!['TRON', 'ETH', 'BSC', 'SOL'].includes(chain) || !integer(afterId, 0n, 2147483647n)
    || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('wallet_read_scope_invalid')
  // Interpolation is limited to the validated bounded integer; identities are bound parameters.
  const [rows] = await connection.execute<WalletRow[]>(
    `SELECT ${projection} FROM payment_wallet_addresses WHERE chain=? AND id>? ORDER BY id LIMIT ${limit + 1}`, [chain, afterId])
  if (rows.length > limit + 1) throw new Error('wallet_read_page_invalid')
  let previous = BigInt(afterId)
  const items = rows.map(row => {
    if (!integer(row.id, 1n, 2147483647n) || BigInt(row.id) <= previous || row.chain !== chain
      || !integer(row.address_index, 0n, 2147483647n) || typeof row.address !== 'string'
      || !/^[\x21-\x7e]{1,100}$/.test(row.address) || !integer(row.revision, 1n, 18446744073709551615n)
      || (row.created_at_utc !== null && !utc(row.created_at_utc))) throw new Error('wallet_read_state_invalid')
    previous = BigInt(row.id)
    let custody: WalletAddress['custody']
    if (row.custody_reference === null && row.custody_evidence_sha256 === null && row.custody_verified_at_utc === null) custody = { status: 'unverified' }
    else {
      if (typeof row.custody_reference !== 'string' || row.custody_reference.length > 191 || !row.custody_reference.trim()
        || !/^[\x00-\x7f]+$/.test(row.custody_reference) || typeof row.custody_evidence_sha256 !== 'string'
        || !/^[a-f0-9]{64}$/.test(row.custody_evidence_sha256) || !utc(row.custody_verified_at_utc)) throw new Error('wallet_read_custody_invalid')
      custody = { status: 'verified', reference: row.custody_reference, evidenceSha256: row.custody_evidence_sha256, verifiedAtUtc: row.custody_verified_at_utc }
    }
    return { id: row.id, chain, addressIndex: row.address_index, address: row.address, createdAtUtc: row.created_at_utc, revision: row.revision, custody }
  })
  return { items: items.slice(0, limit), nextAfterId: items.length > limit ? items[limit - 1]!.id : null }
}
