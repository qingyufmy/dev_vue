import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AccountPrincipalReader } from '../../auth/index.js'
import type { ModelSelection, ModelSelectionService } from '../application/model-selection.js'
import { InferenceError } from '../domain/inference-error.js'

export function createModelSelection(pool: Pool, principals: (connection: PoolConnection) => AccountPrincipalReader): ModelSelectionService {
  async function transaction<T>(userId: number, work: (connection: PoolConnection, state: ModelSelection) => Promise<T>) {
    const connection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const principal = (await principals(connection).readMany([userId], 'share')).get(userId)
      if (!principal) throw new InferenceError('model_selection_forbidden', 403)
      // Serialize default changes, including users with no default row yet.
      const [defaults] = await connection.execute<RowDataPacket[]>('SELECT CAST(model_profile_id AS CHAR) id FROM user_model_defaults WHERE user_id=? FOR UPDATE', [userId])
      const [policies] = await connection.execute<RowDataPacket[]>('SELECT share_for_manual,allowed_plans FROM platform_model_usage_policy WHERE id=1 FOR SHARE')
      const policy = policies[0]
      const plans = typeof policy?.allowed_plans === 'string' ? JSON.parse(policy.allowed_plans) : policy?.allowed_plans
      const shared = !!policy?.share_for_manual && (plans === null || Array.isArray(plans) && plans.includes(principal.plan))
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT CAST(p.id AS CHAR) id,p.model_name name,p.scope,
        c.verification_status,c.protocol,p.provider,c.provider verified_provider,p.model_name,c.model_name verified_model,
        p.api_base_url,c.api_base_url verified_base
        FROM ai_model_profiles p LEFT JOIN ai_model_provider_capabilities c ON c.model_profile_id=p.id
        WHERE p.status='active' AND p.deleted_at IS NULL AND ((p.scope='user' AND p.owner_user_id=?) OR (p.scope='platform' AND p.owner_user_id=0))
        ORDER BY p.scope,p.id LIMIT 101 FOR SHARE`, [userId])
      const state: ModelSelection = { selected_model_profile_id: defaults[0]?.id ?? null, items: rows.map(row => {
        const verified = row.verification_status === 'verified' && row.provider === row.verified_provider && row.model_name === row.verified_model
          && normalizeBase(row.api_base_url) === normalizeBase(row.verified_base) && ['responses', 'chat_completions'].includes(row.protocol)
        const reason = !verified ? 'model_not_verified' : row.scope === 'platform' && !shared ? 'model_sharing_unavailable' : null
        return { id: row.id, name: row.name, scope: row.scope, available: reason === null, reason }
      }) }
      const result = await work(connection, state)
      await connection.commit()
      return result
    } catch (error) { await connection.rollback(); throw error }
    finally { connection.release() }
  }
  return {
    read: userId => transaction(userId, async (_connection, state) => state),
    select: (userId, modelId, expectedModelId) => transaction(userId, async (connection, state) => {
      if (!state.items.some(item => item.id === modelId && item.available)) throw new InferenceError('model_selection_unavailable', 409)
      if (state.selected_model_profile_id === modelId) return state
      if (state.selected_model_profile_id !== expectedModelId) throw new InferenceError('model_selection_conflict', 409)
      await connection.execute(`INSERT INTO user_model_defaults (user_id,model_profile_id,created_at,updated_at) VALUES (?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE model_profile_id=VALUES(model_profile_id),updated_at=UTC_TIMESTAMP(3)`, [userId, modelId])
      return { ...state, selected_model_profile_id: modelId }
    }),
  }
}
function normalizeBase(value: unknown) {
  if (typeof value !== 'string') return ''
  try { const url = new URL(value); url.pathname = url.pathname.replace(/\/+$/, ''); return url.toString() } catch { return value.trim() }
}
