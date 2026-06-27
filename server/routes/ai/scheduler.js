// ai/scheduler.js — 自动调度 + 智能平仓

import { queryOne, queryAll, queryRun, beijingNow } from '../../db.js'
import { getOwnBridgeTradeMode, isBridgeAlive, sendToBrowsers } from '../../bridge-ws.js'
import { mt5Bridge, calculateMarketData } from './market-data.js'
import { maybeAiSignal } from './llm.js'
import { getAutoConfig, getGlobalAutoConfig, getAutoInferenceConfig, upsertAutoConfig, getCloseConfig, saveCloseConfig, getCloseSignalTickets, insertAudit, signalOrderPayload, getExecuteRiskConfig } from './config.js'
import { buildStrategyContextFromTags } from './strategy.js'
import { attachSignalTiming, signalTtlSeconds, stripTimeframeTags, round2 } from './utils.js'

const autoSchedulerState = {}
export const closeSchedulerState = {}

export function isAutoSchedulerRunning(userId) {
  return !!autoSchedulerState[userId]?.running
}

export async function startAutoScheduler(userId) {
  if (autoSchedulerState[userId]) {
    console.log(`[startAutoScheduler] Skipped user ${userId}: scheduler already in progress`)
    return
  }
  autoSchedulerState[userId] = { running: false, timer: null }

  const cfg = await getAutoConfig(null, userId)
  if (!cfg || !cfg.enabled) {
    autoSchedulerState[userId] = null
    console.log(`[startAutoScheduler] Skipped user ${userId}: auto_scheduler enabled=${cfg?.enabled}`)
    return
  }

  const inferenceCfg = await getAutoInferenceConfig(userId)
  const isOverride = inferenceCfg?._source === 'user_override'
  const raw = (cfg.symbols || 'XAUUSD').trim()
  let symbol = raw.startsWith('[') ? (JSON.parse(raw)[0] || 'XAUUSD') : raw.split(',')[0].trim() || 'XAUUSD'
  let intervalMinutes = (await getGlobalAutoConfig())?.interval_minutes || 5

  if (isOverride && inferenceCfg.auto_symbols) { symbol = inferenceCfg.auto_symbols.trim() }
  if (isOverride && inferenceCfg.auto_interval_minutes != null) { intervalMinutes = Number(inferenceCfg.auto_interval_minutes) }
  const intervalMs = intervalMinutes * 60_000
  autoSchedulerState[userId].running = true
  autoSchedulerState[userId].lastRunAt = cfg.last_run_at || null
  autoSchedulerState[userId]._waitCount = 0

  console.log(`[startAutoScheduler] Starting scheduler for user ${userId} (symbol=${symbol}, interval=${intervalMinutes}min)`)
  const tick = async () => {
    if (!autoSchedulerState[userId]?.running) return
    try {
      const tradeMode = getOwnBridgeTradeMode(userId)
      // tradeMode: 0=closed, 1=LONGONLY, 2=SHORTONLY, 3=CLOSEONLY, 4=FULL, -1=unknown
      if (tradeMode === 0 || tradeMode === -1) {
        const st = autoSchedulerState[userId]
        st._waitCount = (st._waitCount || 0) + 1
        if (st._waitCount === 1 || st._waitCount % 10 === 0) {
          const reason = tradeMode === 0 ? 'market_closed' : 'unknown'
          console.log(`[AutoScheduler-tick U${userId}] ${new Date().toISOString()} waiting: tradeMode=${tradeMode} (${reason}), retry#${st._waitCount}, symbol=${symbol}`)
        }
        autoSchedulerState[userId].timer = setTimeout(tick, 5000); return
      }
      if (autoSchedulerState[userId]) autoSchedulerState[userId]._waitCount = 0
      console.log(`[AutoScheduler-tick U${userId}] ${new Date().toISOString()} market OK (tradeMode=${tradeMode}), proceeding to runAutoCycle`)
    } catch (err) {
      const st = autoSchedulerState[userId]
      st._waitCount = (st._waitCount || 0) + 1
      if (st._waitCount === 1 || st._waitCount % 10 === 0) {
        console.error(`[AutoScheduler-tick U${userId}] ${new Date().toISOString()} getOwnBridgeTradeMode error (retry#${st._waitCount}):`, err.message)
      }
      autoSchedulerState[userId].timer = setTimeout(tick, 5000); return
    }
    try { await runAutoCycle(userId, symbol, 'M5') } catch (e) { console.error(`[AutoScheduler-tick U${userId}] ${new Date().toISOString()} cycle error:`, e.message) }
    if (autoSchedulerState[userId]?.running) {
      autoSchedulerState[userId].timer = setTimeout(tick, intervalMs)
    }
  }
  autoSchedulerState[userId].timer = setTimeout(tick, 5000)
}

export function stopAutoScheduler(userId) {
  const state = autoSchedulerState[userId]
  if (state?.timer) clearTimeout(state.timer)
  if (autoSchedulerState[userId]) autoSchedulerState[userId].running = false
  autoSchedulerState[userId] = null
  console.log(`[stopAutoScheduler] User ${userId}: scheduler stopped (hadTimer=${!!state?.timer})`)
}

export async function initAutoSchedulers() {
  try {
    const rows = await queryAll('SELECT user_id FROM auto_scheduler WHERE enabled = 1')
    console.log(`[initAutoSchedulers] Found ${rows.length} enabled auto schedulers`)
    for (const row of rows) {
      try {
        await startAutoScheduler(row.user_id)
        console.log(`[initAutoSchedulers] Started auto scheduler for user ${row.user_id}`)
      } catch (e) {
        console.error(`[initAutoSchedulers] Failed to start scheduler for user ${row.user_id}:`, e.message)
      }
    }
    if (rows.length === 0) {
      const settings = await queryAll("SELECT user_id FROM user_bridge_settings WHERE auto_reasoning_enabled = 1")
      if (settings.length > 0) {
        console.log(`[initAutoSchedulers] Fallback: ${settings.length} users with auto_reasoning_enabled=1 in user_bridge_settings, syncing...`)
        for (const s of settings) {
          try {
            const globalCfg = await getGlobalAutoConfig()
            const symbols = globalCfg?.symbols || 'XAUUSD'
            await upsertAutoConfig(null, s.user_id, symbols, true)
            await startAutoScheduler(s.user_id)
            console.log(`[initAutoSchedulers] Recovered scheduler for user ${s.user_id} from user_bridge_settings`)
          } catch (e) {
            console.error(`[initAutoSchedulers] Failed to recover scheduler for user ${s.user_id}:`, e.message)
          }
        }
      }
    }
  } catch (e) {
    console.error('[initAutoSchedulers] Top-level error:', e.message)
  }

  try {
    const closeRows = await queryAll('SELECT user_id FROM close_config WHERE enabled = 1')
    for (const row of closeRows) {
      await startSmartCloseScheduler(row.user_id)
    }
  } catch (e) { console.error('[initAutoSchedulers] Failed to restore smart close schedulers:', e.message) }
}

function sendAutoProgress(userId, progress) {
  try {
    sendToBrowsers(userId, { type: 'auto_progress', ...progress })
  } catch (e) { console.error('[AutoScheduler] Failed to send progress:', e.message) }
}

export async function runAutoCycle(userId, symbol, timeframe) {
  const ts = () => new Date().toISOString()
  const l = (msg) => console.log(`[AutoCycle U${userId}] ${ts()} ${symbol}/${timeframe}: ${msg}`)

  l('>>> cycle start')
  sendAutoProgress(userId, { stage: 'config', label: '检查配置...' })

  const cfg = await getAutoConfig(null, userId)
  if (!cfg || !cfg.enabled) { l(`BLOCKED: auto_scheduler not found or disabled (enabled=${cfg?.enabled})`); return }
  l(`auto_scheduler enabled=true`)

  const config = await getAutoInferenceConfig(userId)
  if (!config || !config.api_key_encrypted) {
    l(`BLOCKED: no API key (config=${!!config}, hasKey=${!!config?.api_key_encrypted}, source=${config?._source})`)
    return
  }
  l(`inference config ok: source=${config._source}, model=${config.model_name}, provider=${config.api_provider}`)

  const user = await queryOne('SELECT plan FROM users WHERE id = ?', [userId])
  if (!user || user.plan !== 'pro') {
    l(`BLOCKED: not Pro (plan=${user?.plan})`)
    return
  }
  l(`plan=pro ✓`)

  const tradeMode = getOwnBridgeTradeMode(userId)
  if (tradeMode !== 4) {
    l(`BLOCKED: market not open (tradeMode=${tradeMode})`)
    return
  }
  l(`market tradeMode=4 ✓`)

  try {
    sendAutoProgress(userId, { stage: 'bridge', label: '获取行情数据...' })
    l(`fetching bridge data (account+positions+rates)...`)
    const t0 = Date.now()
    const account = await mt5Bridge(userId, 'account', {})
    const positionsData = await mt5Bridge(userId, 'positions', { symbol })
    const positions = positionsData.positions || []
    l(`bridge account+positions done (${Date.now()-t0}ms, positions=${positions.length})`)

    const prompt = config.system_prompt || ''
    const { parseTimeframeTags } = await import('./utils.js')
    const tags = parseTimeframeTags(prompt, 'auto')
    const primaryTf = tags.length > 0 ? tags[0].tf : (timeframe || 'M5').toUpperCase()
    const primaryCount = tags.length > 0 ? tags[0].count : 100
    const t1 = Date.now()
    const ratesResp = await mt5Bridge(userId, 'rates', { symbol, timeframe: primaryTf, count: primaryCount })

    if (!ratesResp || ratesResp.status === 'error') {
      l(`BLOCKED: rates failed (${Date.now()-t1}ms, status=${ratesResp?.status}, error=${ratesResp?.error})`)
      return
    }
    const rates = ratesResp.rates || []
    if (!Array.isArray(rates) || rates.length === 0) {
      l(`BLOCKED: rates empty (${Date.now()-t1}ms, len=${rates?.length})`)
      return
    }
    l(`rates done (${Date.now()-t1}ms, bars=${rates.length}, tf=${primaryTf})`)

    sendAutoProgress(userId, { stage: 'market', label: '计算技术指标...' })
    const t2 = Date.now()
    const market = calculateMarketData(symbol, primaryTf, rates, account, positions)
    market.strategy_context = await buildStrategyContextFromTags(userId, symbol, account, positions, prompt, primaryTf, rates, 'auto')
    l(`market calc done (${Date.now()-t2}ms, price=${market.latest_price})`)

    sendAutoProgress(userId, { stage: 'ai', label: 'AI 模型推理中...' })
    const t3 = Date.now()
    l(`calling AI (model=${config.model_name})...`)
    const signal = await maybeAiSignal(null, config, market)
    market.inference_source = signal._inference_source || 'unknown'
    const aiSource = signal._inference_source
    delete signal._inference_source
    l(`AI done (${Date.now()-t3}ms, type=${signal.signal_type}, confidence=${signal.confidence}, source=${aiSource})`)

    const createdAt = beijingNow()
    const marketJson = JSON.stringify(market)
    const tokenCount = Math.round(((signal.analysis || '').length + (signal.reasoning || '').length + marketJson.length) / 4)
    const result = await queryRun(`
      INSERT INTO ai_signals(user_id, config_id, session_id, symbol, timeframe, signal_type, confidence,
        recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price,
        take_profit_2_price, take_profit_3_price, market_data_json, token_count, ai_model, ttl_seconds, is_executed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `, [
      userId, 0, 'default', symbol, timeframe.toUpperCase(),
      signal.signal_type, signal.confidence, signal.recommended_volume,
      signal.analysis, signal.reasoning, signal.stop_loss_price,
      signal.take_profit_1_price, signal.take_profit_2_price, signal.take_profit_3_price,
      marketJson, tokenCount, config.model_name || 'deepseek-chat', signalTtlSeconds(timeframe), createdAt
    ])
    signal.id = result.insertId
    signal.symbol = symbol
    signal.timeframe = timeframe.toUpperCase()
    signal.created_at = createdAt
    signal.market_data = market
    signal.is_executed = false
    attachSignalTiming(signal)
    l(`signal #${signal.id} saved to DB ✓`)

    let execResult = null
    if (config && config.enable_auto_trade && market.inference_source === 'ai' && !signal.is_stale && signal.signal_type !== 'hold') {
      const bridgeAlive = isBridgeAlive(userId)
      if (!bridgeAlive) {
        l(`auto-trade skipped: bridge not alive`)
      } else {
        const order = signalOrderPayload(signal, config, market, true)
        execResult = await executeOrder(userId, config, order, 'ai_auto_execute')
        if (execResult.status === 'success') {
          signal.is_executed = true
          const ticket = execResult.order || execResult.ticket || null
          await queryRun('UPDATE ai_signals SET is_executed = 1, execution_result = ?, trade_ticket = ?, executed_at = NOW() WHERE id = ?', [JSON.stringify(execResult), ticket, signal.id])
          l(`auto-executed: ticket=${ticket}`)
        } else {
          l(`auto-execute failed: ${execResult.message || execResult.status}`)
        }
      }
    } else if (market.inference_source !== 'ai') {
      l(`auto-trade skipped: inference_source=${market.inference_source}`)
    }

    const scanStatus = execResult
      ? (execResult.status === 'success' ? 'executed' : `exec_failed:${execResult.message || execResult.status}`)
      : (signal.signal_type === 'hold' ? 'skipped_hold' : 'skipped')
    await insertAudit(null, userId, 'ai_auto_scan', symbol, { trigger: 'timer', symbol, timeframe, signal_id: signal.id }, {
      status: scanStatus,
      signal_id: signal.id,
      signal_type: signal.signal_type,
      confidence: signal.confidence,
      inference_source: market.inference_source,
      is_executed: signal.is_executed || false,
    }, execResult && execResult.status === 'success' ? 'success' : 'info')
    l(`<<< cycle complete (audit=${scanStatus})`)
  } catch (err) {
    l(`<<< EXCEPTION: ${err.message}`)
    console.error(`[AutoScheduler] ${symbol}/${timeframe} error:`, err.message)
    await insertAudit(null, userId, 'ai_auto_scan', symbol, { trigger: 'timer', symbol, timeframe }, { status: 'error', message: err.message }, 'error')
  }

  await queryRun('UPDATE auto_scheduler SET last_run_at = ? WHERE user_id = ?', [beijingNow(), userId])
  if (autoSchedulerState[userId]) autoSchedulerState[userId].lastRunAt = beijingNow()
}

export async function startSmartCloseScheduler(userId) {
  if (closeSchedulerState[userId]?.timer) return
  const cfg = await getCloseConfig(userId)
  if (!cfg || !cfg.enabled) return

  const intervalMs = (cfg.check_interval_seconds || 30) * 1000
  closeSchedulerState[userId] = { running: true, timer: null }

  const tick = async () => {
    if (!closeSchedulerState[userId]?.running) return
    try {
      const tradeMode = getOwnBridgeTradeMode(userId)
      if (tradeMode !== 4) { closeSchedulerState[userId].timer = setTimeout(tick, 5000); return }
    } catch { closeSchedulerState[userId].timer = setTimeout(tick, 5000); return }
    try { await runSmartCloseCycle(userId) } catch (e) { console.error(`[SmartClose] User ${userId} tick error:`, e.message) }
    if (closeSchedulerState[userId]?.running) {
      closeSchedulerState[userId].timer = setTimeout(tick, intervalMs)
    }
  }
  closeSchedulerState[userId].timer = setTimeout(tick, 5000)
}

export function stopSmartCloseScheduler(userId) {
  const state = closeSchedulerState[userId]
  if (state?.timer) clearTimeout(state.timer)
  closeSchedulerState[userId] = null
}

async function runSmartCloseCycle(userId) {
  const closeCfg = await getCloseConfig(userId)
  if (!closeCfg || !closeCfg.enabled) return

  const user = await queryOne('SELECT plan FROM users WHERE id = ?', [userId])
  if (!user || user.plan !== 'pro') return

  const tradeMode = getOwnBridgeTradeMode(userId)
  if (tradeMode !== 4) { return }

  const positionsData = await mt5Bridge(userId, 'positions', {})
  const positions = positionsData?.positions || []
  if (positions.length === 0) return

  let account = null
  try {
    const accountData = await mt5Bridge(userId, 'account', {})
    account = accountData?.account || null
  } catch (e) { console.error('[SmartClose] Failed to get account:', e.message) }

  const ruleResults = runCloseRules(closeCfg, positions, account)
  if (ruleResults.length > 0) {
    for (const r of ruleResults) {
      try {
        const closeResult = await mt5Bridge(userId, 'close', { ticket: r.ticket })
        await insertAudit(null, userId, 'smart_close_rule', r.symbol || 'XAUUSD', { ticket: r.ticket, rule: r.rule, reason: r.reason }, closeResult, 'success')
      } catch (e) {
        await insertAudit(null, userId, 'smart_close_rule', r.symbol || 'XAUUSD', { ticket: r.ticket, error: e.message }, null, 'error')
      }
    }
  }

  const remainingData = await mt5Bridge(userId, 'positions', {})
  const remaining = remainingData?.positions || []
  if (remaining.length === 0) return

  try {
    const aiResults = await runSmartClose(userId, closeCfg, account, remaining)
    if (aiResults.length > 0) {}
  } catch (e) {
    console.error(`[SmartClose] User ${userId} AI cycle error:`, e.message)
  }
}

function runCloseRules(cfg, positions, account) {
  const results = []
  for (const pos of positions) {
    const profit = pos.profit || 0
    if (cfg.rule_soft_sl != null && profit < 0 && Math.abs(profit) >= cfg.rule_soft_sl) {
      results.push({ ticket: pos.ticket, symbol: pos.symbol, rule: 'soft_sl', reason: `亏损 $${Math.abs(profit).toFixed(2)} >= 软止损 $${cfg.rule_soft_sl}` })
      continue
    }
    if (cfg.rule_soft_tp != null && profit > 0 && profit >= cfg.rule_soft_tp) {
      results.push({ ticket: pos.ticket, symbol: pos.symbol, rule: 'soft_tp', reason: `盈利 $${profit.toFixed(2)} >= 软止盈 $${cfg.rule_soft_tp}` })
      continue
    }
    if (cfg.rule_timeout_minutes != null && pos.time) {
      const durationMin = (Date.now() / 1000 - pos.time) / 60
      if (durationMin >= cfg.rule_timeout_minutes && profit <= 0) {
        results.push({ ticket: pos.ticket, symbol: pos.symbol, rule: 'timeout', reason: `持仓 ${Math.floor(durationMin)} 分钟且浮亏，超时平仓` })
        continue
      }
    }
    if (cfg.rule_max_loss_pct != null && account?.balance && profit < 0) {
      const lossPct = (Math.abs(profit) / account.balance) * 100
      if (lossPct >= cfg.rule_max_loss_pct) {
        results.push({ ticket: pos.ticket, symbol: pos.symbol, rule: 'max_loss_pct', reason: `亏损 ${lossPct.toFixed(1)}% >= 最大亏损 ${cfg.rule_max_loss_pct}%` })
        continue
      }
    }
  }
  return results
}

async function runSmartClose(userId, closeConfig, account, positions) {
  if (!positions || positions.length === 0) return []

  const symbol = positions[0].symbol || 'XAUUSD'
  const prompt = closeConfig.system_prompt
  if (!prompt) { console.error('[SmartClose] No system_prompt configured'); return [] }
  const model = closeConfig.model_name || 'deepseek-chat'

  let strategyContext = {}
  try {
    strategyContext = await buildStrategyContextFromTags(userId, symbol, account, positions, prompt, 'M5', null, 'close')
  } catch (e) {
    console.error('[SmartClose] Failed to build strategy context:', e.message)
  }

  const recentSignal = await queryOne(
    'SELECT signal_type, analysis FROM ai_signals WHERE user_id = ? ORDER BY id DESC LIMIT 1',
    [userId]
  )

  const details = (positions || []).map(p => ({
    ticket: p.ticket, symbol: p.symbol,
    type: p.type === 'buy' ? 'BUY' : 'SELL',
    volume: p.volume,
    open_price: p.open_price || p.price_open,
    current_price: p.price_current,
    profit: round2(p.profit || 0),
    sl: p.sl || null, tp: p.tp || null,
    duration_minutes: p.time ? Math.floor((Date.now() / 1000 - p.time) / 60) : null,
  }))
  const closeContext = {
    positions: { total: details.length, details },
    account: account ? { balance: account.balance, equity: account.equity, profit: account.profit } : null,
    recent_signal: recentSignal ? { type: recentSignal.signal_type, analysis: recentSignal.analysis } : null,
  }
  const contextPayload = { ...strategyContext, ...closeContext, latest_price: positions[0].price_current || 0 }

  let apiKey, baseUrl
  if (closeConfig.api_key_encrypted) {
    apiKey = closeConfig.api_key_encrypted
    baseUrl = closeConfig.api_base_url || 'https://api.deepseek.com'
  } else {
    const config = await getActiveConfig(null, userId)
    if (!config) return []
    apiKey = config.api_key_encrypted
    baseUrl = closeConfig.api_base_url || config.api_base_url || 'https://api.deepseek.com'
  }
  const temperature = closeConfig.temperature ?? 0.3
  let maxTokens = closeConfig.max_tokens || 4000
  if (/reason|think|flash/i.test(model) && maxTokens < 8000) {
    maxTokens = Math.min(maxTokens * 2, 8000)
  }

  try {
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model, temperature, max_tokens: maxTokens,
        messages: [
          { role: 'system', content: stripTimeframeTags(prompt) },
          { role: 'user', content: JSON.stringify(contextPayload) },
        ],
      }),
    })
    const data = await resp.json()
    let content = data.choices?.[0]?.message?.content || ''
    if (!content) {
      const reasoning = data.choices?.[0]?.message?.reasoning_content || ''
      if (reasoning) {
        const jsonMatch = reasoning.match(/\{[\s\S]*"positions"[\s\S]*\]/)
        if (jsonMatch) {
          let candidate = jsonMatch[0]
          const openBraces = (candidate.match(/\{/g) || []).length
          const closeBraces = (candidate.match(/\}/g) || []).length
          if (openBraces > closeBraces) candidate += '}'.repeat(openBraces - closeBraces)
          content = candidate
        } else {
          console.error('[SmartClose] No JSON found in reasoning_content (first 500):', reasoning.substring(0, 500))
          return []
        }
      } else {
        console.error('[SmartClose] Empty AI response. Status:', resp.status, 'Response:', JSON.stringify(data).substring(0, 300))
        return []
      }
    }

    let jsonStr = content.replace(/```json\n?|```/g, '').trim()
    const firstBrace = jsonStr.indexOf('{')
    const lastBrace = jsonStr.lastIndexOf('}')
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = jsonStr.substring(firstBrace, lastBrace + 1)
    }
    let parsed
    try {
      parsed = JSON.parse(jsonStr)
    } catch (e) {
      console.error('[SmartClose] JSON parse error:', e.message, '\nRaw content (first 500):', content.substring(0, 500))
      return []
    }

    if (!Array.isArray(parsed.positions)) return []

    const avgConfidence = parsed.positions.reduce((s, p) => s + (p.confidence || 0.5), 0) / parsed.positions.length
    const analysisJson = JSON.stringify(parsed.positions)
    const reasoningText = `智能平仓分析：${positions.length}笔持仓`
    const contextJson = JSON.stringify(contextPayload)

    const createdAt = beijingNow()
    const tokenCount = Math.round((analysisJson.length + reasoningText.length + contextJson.length) / 4)
    const closeSignalResult = await queryRun(
      `INSERT INTO ai_signals(user_id, session_id, symbol, timeframe, signal_type, confidence, recommended_volume,
        analysis, reasoning, market_data_json, token_count, ai_model, ttl_seconds, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, 'smart_close', symbol, 'CLOSE', 'close', avgConfidence, 0,
        analysisJson, reasoningText, contextJson, tokenCount, model, 3600, createdAt]
    )
    const closeSignalId = closeSignalResult?.insertId

    const validTickets = new Set(positions.map(p => String(p.ticket)))
    const results = []
    for (const item of parsed.positions) {
      if (!validTickets.has(String(item.ticket))) continue
      if (item.action !== 'close') continue

      const pos = positions.find(p => String(p.ticket) === String(item.ticket))
      if (!pos) continue

      try {
        const closeResult = await mt5Bridge(userId, 'close', { ticket: pos.ticket })
        results.push({ ticket: pos.ticket, success: true, price: closeResult?.price, reason: item.reason })

        if (closeSignalId) {
          await queryRun(
            'INSERT IGNORE INTO close_signal_tickets (user_id, original_ticket, close_signal_id, close_price) VALUES (?, ?, ?, ?)',
            [userId, String(pos.ticket), closeSignalId, closeResult?.price || pos.price_current]
          )
        }

        await insertAudit(null, userId, 'smart_close', symbol, { ticket: pos.ticket, reason: item.reason, confidence: item.confidence }, closeResult, 'success')
      } catch (e) {
        results.push({ ticket: pos.ticket, success: false, error: e.message })
        await insertAudit(null, userId, 'smart_close', symbol, { ticket: pos.ticket, error: e.message }, null, 'error')
      }
    }

    const successCount = results.filter(r => r.success).length
    if (closeSignalId && successCount > 0) {
      await queryRun('UPDATE ai_signals SET is_executed = 1, execution_result = ? WHERE id = ?',
        [JSON.stringify({ closed: successCount, total: results.length, results }), closeSignalId])
    }

    return results
  } catch (e) {
    console.error('[SmartClose] AI error:', e.message)
    return []
  }
}

async function executeOrder(userId, config, request, action) {
  let accountResult, positionsResult, quote
  accountResult = await mt5Bridge(userId, 'account', {})
  positionsResult = await mt5Bridge(userId, 'positions', {})
  const positions = positionsResult.positions || []
  const account = accountResult

  if (request.symbol) {
    try {
      quote = await mt5Bridge(userId, 'quote', { symbol: request.symbol })
      request.quote_price = parseFloat(request.order_type === 'buy' ? quote.ask : quote.bid)
      const pointSize = quote.point || (request.quote_price > 1000 ? 0.01 : 0.0001)
      if (request.stop_loss_points && !request.sl) {
        request.sl = request.order_type === 'buy'
          ? round2(request.quote_price - request.stop_loss_points * pointSize)
          : round2(request.quote_price + request.stop_loss_points * pointSize)
      }
      if (request.take_profit_points && !request.tp) {
        request.tp = request.order_type === 'buy'
          ? round2(request.quote_price + request.take_profit_points * pointSize)
          : round2(request.quote_price - request.take_profit_points * pointSize)
      }
    } catch (e) { console.error('[ExecuteOrder] Failed to get quote:', e.message) }
  }

  let result
  try {
    const { validateTradeRequest, RiskReject } = await import('./config.js')
    const risk = validateTradeRequest(config, account, positions, request)
    let openResult
    openResult = await mt5Bridge(userId, 'open', request)
    result = { ...openResult, risk }
    if (quote) result.quote = quote
  } catch (err) {
    if (err instanceof (await import('./config.js')).RiskReject) {
      result = {
        status: err.reason === 'confirmation_required' ? 'needs_confirmation' : 'rejected',
        message: err.reason,
        details: err.details,
      }
    } else {
      result = { status: 'error', message: err.message }
    }
  }

  await insertAudit(null, userId, action, request.symbol, request, result, result.status)
  return result
}

async function getActiveConfig(db, userId) {
  const { getActiveConfig: getConfig } = await import('./config.js')
  return getConfig(db, userId)
}
