import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { projectReferralBalance } from '../domain/referral-credit.js'

export interface ReferralCreditPosting {
  userId: number
  expectedRevision: string
  kind: 'order_debit' | 'order_release' | 'commission_credit'
  sourceKey: string
  sourceSha256: string
  amount: string
}
interface BalanceRow extends RowDataPacket { balance: string; revision: string }
interface LedgerRow extends RowDataPacket { resulting_balance: string; account_revision: string }
interface EventRow extends LedgerRow { delta: string; source_sha256: string }

// The commerce use case owns the transaction and first locks/authorizes its source fact.
// It must roll back on any error; this primitive neither authorizes nor commits an event.
export async function postReferralCreditInTransaction(connection: PoolConnection, input: ReferralCreditPosting) {
  const command = { ...input }
  if (!Number.isSafeInteger(command.userId) || command.userId < 1 || command.userId > 2147483647
    || !/^[1-9]\d{0,19}$/.test(command.expectedRevision) || BigInt(command.expectedRevision) > 18446744073709551615n
    || !['order_debit', 'order_release', 'commission_credit'].includes(command.kind)
    || !/^[a-f0-9]{64}$/.test(command.sourceKey) || !/^[a-f0-9]{64}$/.test(command.sourceSha256)) throw new Error('referral_posting_invalid')
  const amount = projectReferralBalance('0', command.amount, 'credit').nextBalance
  const expectedDelta = command.kind === 'order_debit' ? `-${amount}` : amount
  const [balances] = await connection.execute<BalanceRow[]>(
    'SELECT referral_credit balance,CAST(revision AS CHAR) revision FROM user_referral_accounts WHERE user_id=? FOR UPDATE', [command.userId])
  const balance = balances[0]
  if (!balance) throw new Error('referral_account_missing')
  const [latest] = await connection.execute<LedgerRow[]>(
    'SELECT resulting_balance,CAST(account_revision AS CHAR) account_revision FROM referral_credit_ledger WHERE user_id=? ORDER BY account_revision DESC LIMIT 1 FOR UPDATE', [command.userId])
  if (!latest[0] || latest[0].account_revision !== balance.revision || latest[0].resulting_balance !== balance.balance) throw new Error('referral_ledger_diverged')
  const [events] = await connection.execute<EventRow[]>(
    'SELECT delta,source_sha256,resulting_balance,CAST(account_revision AS CHAR) account_revision FROM referral_credit_ledger WHERE user_id=? AND event_kind=? AND source_key=? FOR UPDATE',
    [command.userId, command.kind, command.sourceKey])
  if (events[0]) {
    const event = events[0]
    if (event.delta !== expectedDelta || event.source_sha256 !== command.sourceSha256) throw new Error('referral_event_conflict')
    return { applied: false, eventRevision: event.account_revision, eventBalance: event.resulting_balance }
  }
  if (balance.revision !== command.expectedRevision) throw new Error('referral_revision_conflict')
  const revision = BigInt(balance.revision) + 1n
  if (revision > 18446744073709551615n) throw new Error('referral_revision_overflow')
  const change = projectReferralBalance(balance.balance, amount, command.kind === 'order_debit' ? 'debit' : 'credit')
  await connection.execute(
    'INSERT INTO referral_credit_ledger (user_id,account_revision,event_kind,source_key,previous_balance,delta,resulting_balance,migration_run_id,source_sha256,recorded_at_utc) VALUES (?,?,?,?,?,?,?,NULL,?,UTC_TIMESTAMP(3))',
    [command.userId, revision.toString(), command.kind, command.sourceKey, change.previousBalance, change.delta, change.nextBalance, command.sourceSha256])
  const [updated] = await connection.execute<ResultSetHeader>(
    'UPDATE user_referral_accounts SET referral_credit=?,revision=?,updated_at_utc=UTC_TIMESTAMP(3) WHERE user_id=? AND revision=?',
    [change.nextBalance, revision.toString(), command.userId, balance.revision])
  if (updated.affectedRows !== 1) throw new Error('referral_revision_conflict')
  return { applied: true, eventRevision: revision.toString(), eventBalance: change.nextBalance }
}
