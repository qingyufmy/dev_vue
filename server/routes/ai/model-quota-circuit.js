import crypto from 'crypto'
import { queryOne, queryRun } from '../../db.js'
import { listAdminAlertRecipients, sendSystemEmail } from '../../system-email.js'

const CIRCUIT_MINUTES = Math.max(5, Number.parseInt(process.env.AI_MODEL_QUOTA_CIRCUIT_MINUTES || '60') || 60)
const ALERT_DEDUPE_HOURS = Math.max(1, Number.parseInt(process.env.AI_MODEL_QUOTA_ALERT_DEDUPE_HOURS || '6') || 6)
const PROBE_LEASE_MINUTES = 5

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  })[char])
}

export function buildModelQuotaCircuitContext({ usageContext, provider, model, url }) {
  const profileId = Number(usageContext?.profileId || 0)
  if (!profileId) return null
  const providerName = String(provider || 'unknown').slice(0, 64)
  const modelName = String(model || 'unknown').slice(0, 191)
  const endpointHost = (() => {
    try { return new URL(url).host.slice(0, 191) } catch { return 'unknown' }
  })()
  const circuitKey = crypto.createHash('sha256')
    .update(`${profileId}:${providerName}:${modelName}:${endpointHost}`)
    .digest('hex')
  return { circuitKey, profileId, provider:providerName, model:modelName, endpointHost }
}

function circuitError(reason, context, details = {}) {
  return Object.assign(new Error(reason), {
    code:reason,
    modelQuotaCircuit:true,
    details:{
      model_profile_id:context?.profileId || null,
      provider:context?.provider || null,
      model:context?.model || null,
      ...details,
    },
  })
}

export async function assertModelQuotaAvailable(context) {
  if (!context) return { probe:false }
  const row = await queryOne(`SELECT status,
      (open_until IS NOT NULL AND open_until > NOW()) AS is_blocked,
      (probe_lease_until IS NOT NULL AND probe_lease_until > NOW()) AS probe_busy,
      open_until
    FROM ai_model_provider_incidents WHERE circuit_key = ? LIMIT 1`, [context.circuitKey])
  if (!row || row.status !== 'open') return { probe:false }
  if (Number(row.is_blocked) === 1) {
    throw circuitError('model_quota_exhausted', context, { retry_after:row.open_until || null })
  }
  if (Number(row.probe_busy) === 1) {
    throw circuitError('model_quota_probe_in_progress', context)
  }
  const claim = await queryRun(`UPDATE ai_model_provider_incidents
    SET probe_lease_until = DATE_ADD(NOW(), INTERVAL ? MINUTE), updated_at = NOW()
    WHERE circuit_key = ? AND status = 'open'
      AND (open_until IS NULL OR open_until <= NOW())
      AND (probe_lease_until IS NULL OR probe_lease_until <= NOW())`,
  [PROBE_LEASE_MINUTES, context.circuitKey])
  if (Number(claim?.changes || 0) !== 1) {
    throw circuitError('model_quota_probe_in_progress', context)
  }
  return { probe:true }
}

async function sendQuotaAlert(context, errorCode) {
  const recipients = await listAdminAlertRecipients()
  const result = await sendSystemEmail({
    to:recipients,
    subject:`【AURUM 告警】AI 模型额度已耗尽：${context.model}`,
    html:`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:auto;color:#172033;line-height:1.7">
      <div style="padding:28px;border:1px solid #e5e7eb;border-radius:14px">
        <h2 style="margin:0 0 14px;color:#b42318">AI 模型额度告警</h2>
        <p>模型服务返回了 HTTP 429，系统已按“额度耗尽”处理并暂停该模型的自动请求。</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:6px;color:#667085">模型配置 ID</td><td>${context.profileId}</td></tr>
          <tr><td style="padding:6px;color:#667085">供应商</td><td>${escapeHtml(context.provider)}</td></tr>
          <tr><td style="padding:6px;color:#667085">模型</td><td>${escapeHtml(context.model)}</td></tr>
          <tr><td style="padding:6px;color:#667085">接口主机</td><td>${escapeHtml(context.endpointHost)}</td></tr>
          <tr><td style="padding:6px;color:#667085">错误代码</td><td>${escapeHtml(errorCode)}</td></tr>
        </table>
        <p>请补充额度或检查订阅。系统将在 ${CIRCUIT_MINUTES} 分钟后仅放行一次恢复探测；持续失败的告警按 ${ALERT_DEDUPE_HOURS} 小时去重。</p>
      </div>
    </div>`,
  })
  if (!result.sent) throw new Error(result.reason || 'quota_alert_email_not_sent')
}

async function sendRecoveryAlert(context) {
  const recipients = await listAdminAlertRecipients()
  const result = await sendSystemEmail({
    to:recipients,
    subject:`【AURUM 恢复】AI 模型服务已恢复：${context.model}`,
    html:`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:auto;color:#172033;line-height:1.7">
      <div style="padding:28px;border:1px solid #d1fadf;border-radius:14px">
        <h2 style="margin:0 0 14px;color:#067647">AI 模型服务已恢复</h2>
        <p>恢复探测已成功，模型 <strong>${escapeHtml(context.model)}</strong> 的额度熔断已自动解除，后续自动推理可继续执行。</p>
      </div>
    </div>`,
  })
  if (!result.sent) throw new Error(result.reason || 'quota_recovery_email_not_sent')
}

export async function recordModelQuotaExhausted(context, errorCode = 'model_quota_exhausted') {
  if (!context) return
  await queryRun(`INSERT INTO ai_model_provider_incidents
      (circuit_key, model_profile_id, provider, model_name, endpoint_host, status,
       first_detected_at, last_detected_at, open_until, error_count, last_error_code, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'open', NOW(), NOW(), DATE_ADD(NOW(), INTERVAL ? MINUTE), 1, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE status = 'open', last_detected_at = NOW(),
      open_until = DATE_ADD(NOW(), INTERVAL ? MINUTE), probe_lease_until = NULL,
      error_count = error_count + 1, last_error_code = VALUES(last_error_code), updated_at = NOW()`, [
    context.circuitKey, context.profileId, context.provider, context.model, context.endpointHost,
    CIRCUIT_MINUTES, String(errorCode).slice(0, 191), CIRCUIT_MINUTES,
  ])
  const claim = await queryRun(`UPDATE ai_model_provider_incidents SET alert_sent_at = NOW(), updated_at = NOW()
    WHERE circuit_key = ? AND (alert_sent_at IS NULL OR alert_sent_at <= DATE_SUB(NOW(), INTERVAL ? HOUR))`,
  [context.circuitKey, ALERT_DEDUPE_HOURS])
  if (Number(claim?.changes || 0) !== 1) return
  try {
    await sendQuotaAlert(context, errorCode)
  } catch (error) {
    await queryRun(`UPDATE ai_model_provider_incidents SET alert_sent_at = NULL, updated_at = NOW()
      WHERE circuit_key = ? AND status = 'open'`, [context.circuitKey]).catch(() => {})
    console.error('[LLM] Failed to email model quota alert:', error.message)
  }
}

export async function recordModelQuotaRecovered(context) {
  if (!context) return
  const updated = await queryRun(`UPDATE ai_model_provider_incidents
    SET status = 'recovered', recovered_at = NOW(), recovery_sent_at = NOW(),
      open_until = NULL, probe_lease_until = NULL, updated_at = NOW()
    WHERE circuit_key = ? AND status = 'open'`, [context.circuitKey])
  if (Number(updated?.changes || 0) !== 1) return
  try {
    await sendRecoveryAlert(context)
  } catch (error) {
    console.error('[LLM] Failed to email model quota recovery:', error.message)
  }
}

export async function deferModelQuotaProbe(context) {
  if (!context) return
  await queryRun(`UPDATE ai_model_provider_incidents
    SET open_until = DATE_ADD(NOW(), INTERVAL 5 MINUTE), probe_lease_until = NULL, updated_at = NOW()
    WHERE circuit_key = ? AND status = 'open'`, [context.circuitKey])
}
