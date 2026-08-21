import crypto from 'crypto'
import { queryOne, queryRun } from '../../db.js'
import { listAdminAlertRecipients, sendSystemEmail } from '../../system-email.js'

const ALERT_DEDUPE_HOURS = Math.max(1, Number.parseInt(process.env.AI_MODEL_QUOTA_ALERT_DEDUPE_HOURS || '6') || 6)

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

export async function assertModelQuotaAvailable(context) {
  if (!context) return { recoveryCandidate:false, incidentErrorCount:null }
  const row = await queryOne(`SELECT status, error_count
    FROM ai_model_provider_incidents WHERE circuit_key = ? LIMIT 1`, [context.circuitKey])
  // A recorded 429 is observability state only. It must never delay or reject a
  // later automatic analysis request. Successful normal traffic closes it.
  return {
    recoveryCandidate:row?.status === 'open',
    incidentErrorCount:row?.status === 'open' ? Number(row.error_count || 0) : null,
  }
}

async function sendQuotaAlert(context, errorCode) {
  const recipients = await listAdminAlertRecipients()
  const result = await sendSystemEmail({
    to:recipients,
    subject:`【AURUM 告警】AI 模型请求返回 429：${context.model}`,
    html:`<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:auto;color:#172033;line-height:1.7">
      <div style="padding:28px;border:1px solid #e5e7eb;border-radius:14px">
        <h2 style="margin:0 0 14px;color:#b42318">AI 模型请求告警</h2>
        <p>模型服务返回了 HTTP 429，本次请求未成功。系统不会设置定时熔断，后续自动推理仍会按原计划继续请求。</p>
        <table style="border-collapse:collapse;width:100%">
          <tr><td style="padding:6px;color:#667085">模型配置 ID</td><td>${context.profileId}</td></tr>
          <tr><td style="padding:6px;color:#667085">供应商</td><td>${escapeHtml(context.provider)}</td></tr>
          <tr><td style="padding:6px;color:#667085">模型</td><td>${escapeHtml(context.model)}</td></tr>
          <tr><td style="padding:6px;color:#667085">接口主机</td><td>${escapeHtml(context.endpointHost)}</td></tr>
          <tr><td style="padding:6px;color:#667085">错误代码</td><td>${escapeHtml(errorCode)}</td></tr>
        </table>
        <p>请检查额度、订阅或服务商限流策略；持续失败的告警按 ${ALERT_DEDUPE_HOURS} 小时去重。</p>
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
        <p>后续自动推理请求已成功，模型 <strong>${escapeHtml(context.model)}</strong> 的服务状态已标记恢复，自动推理继续正常执行。</p>
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
    VALUES (?, ?, ?, ?, ?, 'open', NOW(), NOW(), NULL, 1, ?, NOW(), NOW())
    ON DUPLICATE KEY UPDATE status = 'open', last_detected_at = NOW(),
      open_until = NULL, probe_lease_until = NULL,
      error_count = error_count + 1, last_error_code = VALUES(last_error_code), updated_at = NOW()`, [
    context.circuitKey, context.profileId, context.provider, context.model, context.endpointHost,
    String(errorCode).slice(0, 191),
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

export async function recordModelQuotaRecovered(context, incidentState = {}) {
  const incidentErrorCount = Number(incidentState?.incidentErrorCount)
  if (!context || !Number.isSafeInteger(incidentErrorCount) || incidentErrorCount < 1) return
  const updated = await queryRun(`UPDATE ai_model_provider_incidents
    SET status = 'recovered', recovered_at = NOW(), recovery_sent_at = NOW(),
      open_until = NULL, probe_lease_until = NULL, updated_at = NOW()
    WHERE circuit_key = ? AND status = 'open' AND error_count = ?`, [context.circuitKey, incidentErrorCount])
  if (Number(updated?.changes || 0) !== 1) return
  try {
    await sendRecoveryAlert(context)
  } catch (error) {
    console.error('[LLM] Failed to email model quota recovery:', error.message)
  }
}

export async function keepModelQuotaIncidentOpen(context) {
  if (!context) return
  await queryRun(`UPDATE ai_model_provider_incidents
    SET open_until = NULL, probe_lease_until = NULL, updated_at = NOW()
    WHERE circuit_key = ? AND status = 'open'`, [context.circuitKey])
}
