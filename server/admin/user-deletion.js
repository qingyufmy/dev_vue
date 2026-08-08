import bcrypt from 'bcryptjs'
import { queryOne, withTransaction } from '../db.js'
import { disconnectUserSockets } from '../bridge-ws.js'

export async function anonymizeAdminUser({ actor, targetUserId }) {
  const userId = Number(targetUserId)
  if (!Number.isInteger(userId) || userId <= 0) throw new Error('invalid_user_id')
  const user = await queryOne('SELECT id, email, role FROM users WHERE id = ?', [userId])
  if (!user) throw new Error('user_not_found')
  if (user.role === 'admin') throw new Error('admin_user_cannot_be_deleted')
  const destroyedPassword = await bcrypt.hash(`deleted:${userId}:${Date.now()}:${Math.random()}`, 10)
  const anonymizedEmail = `deleted-${userId}@anonymized.invalid`
  await withTransaction(async run => {
    await run('DELETE FROM notifications WHERE user_id = ?', [userId])
    await run('DELETE FROM referrals WHERE referrer_id = ? OR referred_id = ?', [userId, userId])
    await run('DELETE FROM verification_codes WHERE email = ?', [user.email])
    await run('DELETE FROM progress WHERE user_id = ?', [userId])
    await run('DELETE FROM comments WHERE user_id = ?', [userId])
    await run('DELETE FROM comment_likes WHERE user_id = ?', [userId])
    await run('DELETE FROM post_replies WHERE user_id = ?', [userId])
    await run('DELETE FROM posts WHERE user_id = ?', [userId])
    await run('DELETE FROM feedback WHERE user_id = ?', [userId])
    await run('UPDATE ai_configs SET api_key_encrypted = NULL, is_active = 0 WHERE user_id = ?', [userId])
    await run('UPDATE close_config SET api_key_encrypted = NULL, enabled = 0 WHERE user_id = ?', [userId])
    await run("UPDATE ai_model_profiles SET api_key_encrypted = NULL, status = 'deleted', deleted_at = NOW(), updated_at = NOW() WHERE owner_user_id = ? AND scope = 'user'", [userId])
    await run('DELETE FROM user_model_defaults WHERE user_id = ?', [userId])
    await run('UPDATE auto_scheduler SET enabled = 0, enable_auto_trade = 0 WHERE user_id = ?', [userId])
    await run('UPDATE strategy_subscriptions SET execution_enabled = 0, is_deleted = 1, updated_at = NOW() WHERE user_id = ?', [userId])
    await run("UPDATE trading_accounts SET observe_status = 'deleted', is_deleted = 1, updated_at = NOW() WHERE user_id = ?", [userId])
    await run('DELETE FROM user_bridge_settings WHERE user_id = ?', [userId])
    await run('DELETE FROM crypto_watch_list WHERE user_id = ?', [userId])
    await run('UPDATE bridge_refresh_sessions SET revoked_at = COALESCE(revoked_at, NOW()), updated_at = NOW() WHERE user_id = ?', [userId])
    await run(`UPDATE users SET email = ?, phone = NULL, password = ?, nickname = ?, avatar = '',
      role = 'user', plan = 'free', plan_expires_at = NULL, telegram_id = NULL, telegram_username = NULL,
      telegram_name = NULL, telegram_chat_id = NULL, referral_code = NULL, referral_credit = 0,
      token_version = token_version + 1, deletion_status = 'anonymized', deleted_at = NOW(), updated_at = NOW() WHERE id = ?`,
    [anonymizedEmail, destroyedPassword, `已删除用户 #${userId}`, userId])
    await run(`INSERT INTO audit_logs (user_id, user_email, user_nickname, action, target_type, target_id, detail, created_at)
      VALUES (?, ?, ?, 'user_anonymized', 'user', ?, ?, NOW())`, [actor.id, actor.email || '', actor.nickname || '', userId,
      JSON.stringify({ retained:['orders','trade_audit_logs','order_intents','risk_decisions','inference_snapshots','review_evidence'], credentials_destroyed:true })])
  })
  disconnectUserSockets(userId, 'User account anonymized')
  return { id:userId, email:user.email }
}
