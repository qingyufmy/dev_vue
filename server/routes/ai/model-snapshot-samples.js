import crypto from 'node:crypto'
import { queryAll, queryOne } from '../../db.js'
import { stripBrokerSuffix } from './utils.js'

const MIN_SELECTED_SNAPSHOTS = 2
const MAX_SELECTED_SNAPSHOTS = 30

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

function normalizedIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(Number)
    .filter(value => Number.isInteger(value) && value > 0))]
}

function publicSample(row) {
  return {
    snapshot_id:Number(row.snapshot_id),
    signal_id:Number(row.signal_id),
    strategy_id:Number(row.strategy_id),
    strategy_version:Number(row.strategy_version || 1),
    strategy_name:row.strategy_name || null,
    strategy_scope:row.strategy_scope || null,
    symbol:row.standard_symbol || null,
    original_signal_type:row.original_signal_type || null,
    original_confidence:Number(row.original_confidence || 0),
    model_name:row.original_model_name || null,
    provider:row.original_provider || null,
    output_schema_version:row.output_schema_version || null,
    evidence_status:row.evidence_status || 'incomplete',
    omitted_fields:parseJson(row.omitted_fields_json, []),
    net_profit:Number(row.net_profit || 0),
    closed_volume:Number(row.closed_volume || 0),
    trade_count:Number(row.trade_count || 0),
    signal_created_at:row.signal_created_at || null,
    fully_closed_at:row.fully_closed_at || null,
    selectable:row.evidence_status === 'complete',
  }
}

function sampleFilters({ strategyId, symbol, result }) {
  const clauses = [
    "snap.evidence_status = 'complete'",
    "snap.system_prompt NOT LIKE '[evidence omitted;%'",
    "snap.user_prompt NOT LIKE '[evidence omitted;%'",
    "snap.market_snapshot_json NOT LIKE '%\"evidence_ref\"%'",
  ]
  const params = []
  if (Number(strategyId) > 0) {
    clauses.push('snap.strategy_id = ?')
    params.push(Number(strategyId))
  }
  const normalizedSymbol = stripBrokerSuffix(String(symbol || '')).toUpperCase()
  if (normalizedSymbol) {
    clauses.push('snap.standard_symbol = ?')
    params.push(normalizedSymbol)
  }
  if (result === 'profit') clauses.push('outcome.net_profit > 0')
  if (result === 'loss') clauses.push('outcome.net_profit < 0')
  if (result === 'flat') clauses.push('outcome.net_profit = 0')
  return { sql:clauses.join(' AND '), params }
}

const SNAPSHOT_SAMPLE_FROM = `FROM inference_snapshots snap
  JOIN ai_signals signal_row ON signal_row.id = snap.signal_id
  LEFT JOIN auto_prompt_types strategy_row ON strategy_row.id = snap.strategy_id
  JOIN (
    SELECT signal_id, SUM(net_profit) AS net_profit, SUM(closed_volume) AS closed_volume,
      COUNT(*) AS trade_count, MAX(fully_closed_at) AS fully_closed_at
    FROM signal_outcomes
    WHERE user_id = ? AND status = 'closed' AND attribution_status = 'attributed'
      AND signal_id IS NOT NULL
    GROUP BY signal_id
  ) outcome ON outcome.signal_id = snap.signal_id
  WHERE snap.id = (SELECT MAX(latest.id) FROM inference_snapshots latest WHERE latest.signal_id = snap.signal_id)`

export async function listModelSnapshotSamples(userId, options = {}) {
  const actor = await queryOne('SELECT role FROM users WHERE id = ?', [Number(userId)])
  if (!actor || actor.role !== 'admin') throw new Error('admin_only')
  const page = Math.max(1, Number(options.page) || 1)
  const pageSize = Math.max(5, Math.min(30, Number(options.page_size) || 10))
  const filters = sampleFilters({
    strategyId:options.strategy_id,
    symbol:options.symbol,
    result:String(options.result || 'all'),
  })
  const baseParams = [Number(userId), ...filters.params]
  const count = await queryOne(`SELECT COUNT(*) AS total ${SNAPSHOT_SAMPLE_FROM} AND ${filters.sql}`, baseParams)
  const rows = await queryAll(`SELECT snap.id AS snapshot_id, snap.signal_id, snap.strategy_id,
      snap.strategy_version, snap.strategy_scope, snap.standard_symbol, snap.output_schema_version,
      snap.evidence_status, snap.omitted_fields_json, snap.model_name AS original_model_name,
      snap.provider AS original_provider, strategy_row.title AS strategy_name,
      signal_row.signal_type AS original_signal_type, signal_row.confidence AS original_confidence,
      signal_row.created_at AS signal_created_at, outcome.net_profit, outcome.closed_volume,
      outcome.trade_count, outcome.fully_closed_at
    ${SNAPSHOT_SAMPLE_FROM} AND ${filters.sql}
    ORDER BY outcome.fully_closed_at DESC, snap.id DESC LIMIT ? OFFSET ?`, [
    ...baseParams, pageSize, (page - 1) * pageSize,
  ])
  return {
    samples:rows.map(publicSample),
    pagination:{ page, page_size:pageSize, total:Number(count?.total || 0) },
  }
}

export async function resolveModelSnapshotSelection(userId, snapshotIds, expected = {}) {
  const ids = normalizedIds(snapshotIds)
  if (ids.length < MIN_SELECTED_SNAPSHOTS) throw new Error('snapshot_compare_minimum_not_met')
  if (ids.length > MAX_SELECTED_SNAPSHOTS) throw new Error('snapshot_compare_limit_exceeded')
  const placeholders = ids.map(() => '?').join(',')
  const rows = await queryAll(`SELECT snap.*, signal_row.created_at AS signal_created_at,
      signal_row.signal_type AS original_signal_type, signal_row.confidence AS original_confidence,
      outcome.net_profit, outcome.closed_volume, outcome.trade_count, outcome.fully_closed_at
    ${SNAPSHOT_SAMPLE_FROM} AND snap.id IN (${placeholders})
      AND snap.evidence_status = 'complete'
      AND snap.system_prompt NOT LIKE '[evidence omitted;%'
      AND snap.user_prompt NOT LIKE '[evidence omitted;%'
      AND snap.market_snapshot_json NOT LIKE '%\"evidence_ref\"%'
    ORDER BY snap.id`, [Number(userId), ...ids])
  if (rows.length !== ids.length) throw new Error('snapshot_compare_selection_invalid')

  const strategyIds = new Set(rows.map(row => Number(row.strategy_id)))
  const strategyVersions = new Set(rows.map(row => Number(row.strategy_version || 1)))
  const symbols = new Set(rows.map(row => stripBrokerSuffix(row.standard_symbol || '').toUpperCase()))
  const schemaVersions = new Set(rows.map(row => row.output_schema_version || ''))
  if (strategyIds.size !== 1) throw new Error('snapshot_compare_strategy_mismatch')
  if (strategyVersions.size !== 1) throw new Error('snapshot_compare_strategy_version_mismatch')
  if (symbols.size !== 1) throw new Error('snapshot_compare_symbol_mismatch')
  if (schemaVersions.size !== 1) throw new Error('snapshot_compare_schema_mismatch')
  if (Number(expected.strategy_id) > 0 && !strategyIds.has(Number(expected.strategy_id))) {
    throw new Error('snapshot_compare_strategy_mismatch')
  }
  const expectedSymbol = stripBrokerSuffix(String(expected.symbol || '')).toUpperCase()
  if (expectedSymbol && !symbols.has(expectedSymbol)) throw new Error('snapshot_compare_symbol_mismatch')

  const samples = rows.map(row => ({
    ...publicSample(row),
    system_prompt:row.system_prompt,
    user_prompt:row.user_prompt,
    prompt_hash:row.prompt_hash,
    content_hash:row.content_hash,
    market_snapshot:parseJson(row.market_snapshot_json, {}),
    klines:parseJson(row.klines_json, {}),
    memory_mode:row.memory_mode || 'off',
  }))
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(samples.map(sample => ({
    snapshot_id:sample.snapshot_id,
    content_hash:sample.content_hash,
    prompt_hash:sample.prompt_hash,
  })))).digest('hex')
  return {
    samples,
    snapshot_ids:samples.map(sample => sample.snapshot_id),
    strategy_id:[...strategyIds][0],
    strategy_version:[...strategyVersions][0],
    symbol:[...symbols][0],
    output_schema_version:[...schemaVersions][0],
    fingerprint,
  }
}

export const MODEL_SNAPSHOT_SELECTION_LIMITS = {
  minimum:MIN_SELECTED_SNAPSHOTS,
  maximum:MAX_SELECTED_SNAPSHOTS,
}
