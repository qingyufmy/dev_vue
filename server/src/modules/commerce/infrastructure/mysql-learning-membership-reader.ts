import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
export class MysqlLearningMembershipReader {
  constructor(private readonly pool: Pick<Pool, 'execute'>, private readonly lock = false) {}
  static forTransaction(connection: PoolConnection) { return new MysqlLearningMembershipReader(connection, true) }
  async activePlan(userId: number, now: Date): Promise<'free' | 'plus' | 'pro'> {
    const [rows] = await this.pool.execute<(RowDataPacket & { plan_code: string })[]>(`SELECT plan_code FROM memberships
      WHERE user_id=? AND (expiration_kind='no_expiry' OR (expiration_kind='at_time' AND expires_at_utc>?))${this.lock ? ' FOR SHARE' : ''}`, [userId, now])
    const plan = rows[0]?.plan_code
    return plan === 'plus' || plan === 'pro' ? plan : 'free'
  }
}
