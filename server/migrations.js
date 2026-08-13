/**
 * Database migrations — run once on startup.
 * Each migration has an id and an up() function.
 * Already-run migrations are tracked in the `schema_migrations` table.
 */
import { queryOne, queryAll, queryRun, withConnection, withTransaction, beijingNow } from './db.js'
import crypto from 'node:crypto'
import { terminalOffsetFromClockPairs } from './routes/ai/utils.js'
import { sanitizeLegacyStrategyMemoryContent } from './routes/ai/strategy-memory-legacy.js'

export function applyPendingLifecycleSchema(schema) {
  return {
    ...schema,
    cancel_pending: '必须字段。不需要取消挂单时返回空数组 []。挂单有效期、过期识别和到期取消由 MT5 与后端负责；禁止比较任何时间字符串判断挂单是否过期，禁止以过期、超时、有效期结束或剩余时间不足为理由取消挂单。仅当当前 pending_orders 中确实存在对应挂单，且价格条件明显失效、市场结构被破坏或交易方向逻辑反转时，才允许输出取消条件。pending_orders 中不存在的挂单不得输出取消条件，也不得推断其已经过期或取消。每个元素包含：symbol（必填，品种）、pending_type（可选，如 buy_limit、sell_limit、buy_stop、sell_stop）、max_price（可选，取消低于或等于该价格的挂单）、min_price（可选，取消高于或等于该价格的挂单）、cancel_all（可选，布尔值，取消该品种全部挂单）、reason（必填，必须说明价格、结构或方向方面的非时间原因）。示例：[{"symbol":"XAUUSD","pending_type":"buy_limit","max_price":4110,"reason":"当前结构已经跌破原入场依据，原限价买入逻辑失效"}]；不需要取消时返回 []。',
    reasoning: '中文，说明信号方向、入场方式、风险和执行依据。挂单管理只能依据当前 pending_orders 中真实存在的挂单及价格、结构、方向条件进行分析。禁止比较时间字符串判断挂单是否过期，禁止声称挂单已过期、超时失效或已自动取消。挂单到期和过期取消由 MT5 与后端负责。',
  }
}

const LEGACY_SINGLE_DIRECTION_PENDING_RULE = '。挂单管理：同品种同方向最多保留1笔挂单，如果market_data_json.pending_orders中已有同品种同方向挂单且价格合理则返回hold不挂新单，仅在现有挂单价格明显不合理时才用cancel_pending取消旧单挂新单'
const MODEL_DRIVEN_PENDING_RULE = '。挂单管理：系统不按同品种或同方向的挂单数量限制新增挂单。必须结合输入中的全部持仓与挂单逐笔判断；需要保留现有挂单并新增时使用 pending_action=none，仅保留且不新增时返回 hold 并使用 keep，取消或替换时使用 cancel 或 cancel_replace。'

export function applyModelDrivenPendingSchema(schema) {
  const updated = schema && typeof schema === 'object' && !Array.isArray(schema) ? { ...schema } : {}
  const signalType = String(updated.signal_type || '')
  updated.signal_type = signalType.includes(LEGACY_SINGLE_DIRECTION_PENDING_RULE)
    ? signalType.replace(LEGACY_SINGLE_DIRECTION_PENDING_RULE, MODEL_DRIVEN_PENDING_RULE)
    : signalType.includes('系统不按同品种或同方向的挂单数量限制新增挂单')
      ? signalType
      : `${signalType}${signalType ? MODEL_DRIVEN_PENDING_RULE : MODEL_DRIVEN_PENDING_RULE.slice(1)}`
  updated.pending_action = '必须字段。仅允许 none | keep | cancel | cancel_replace。已有挂单不会触发系统侧数量限制；保留现有挂单并新增时使用 none，仅保留现有挂单且不新增时返回 hold 并使用 keep。只有原逻辑失效时才能 cancel，方向反转且新挂单成立时才能 cancel_replace。'
  updated.management_direction = '必须字段。仅允许 buy | sell | none。pending_action 为 cancel 或 cancel_replace 时填写被管理挂单方向；none 或 keep 时填 none。'
  const reasoning = String(updated.reasoning || '')
  const modelDecisionRule = '挂单数量本身不能作为拒绝新信号的理由；是否新增必须由模型结合全部持仓、挂单价格、方向与当前结构决定。'
  updated.reasoning = reasoning.includes(modelDecisionRule) ? reasoning : `${reasoning}${reasoning ? ' ' : ''}${modelDecisionRule}`
  return updated
}

const migrations = [
  {
    id: '001_add_bridge_heartbeat',
    up: async () => {
      await queryRun('ALTER TABLE users ADD COLUMN bridge_heartbeat DATETIME DEFAULT NULL')
    }
  },
  {
    id: '002_add_performance_indexes',
    up: async () => {
      const indexes = [
        'CREATE INDEX idx_users_last_seen ON users(last_seen_at)',
        'CREATE INDEX idx_ai_signals_user_created ON ai_signals(user_id, created_at)',
        'CREATE INDEX idx_orders_user_status ON orders(user_id, status)',
        'CREATE INDEX idx_auto_scheduler_enabled ON auto_scheduler(enabled)',
        'CREATE INDEX idx_audit_logs_user_action ON audit_logs(user_id, action)',
        'CREATE INDEX idx_notifications_user_read ON notifications(user_id, is_read)',
        'CREATE INDEX idx_trades_user ON trades(user_id)',
      ]
      for (const sql of indexes) {
        try {
          await queryRun(sql)
        } catch (e) {
          if (!e.message?.includes('Duplicate')) {
            console.error(`[Migrations] Index creation failed:`, e.message)
          }
        }
      }
    }
  },
  {
    id: '003_add_verify_token',
    up: async () => {
      try {
        const cols = await queryAll("SHOW COLUMNS FROM verification_codes LIKE 'verify_token'")
        if (!cols || !cols.length) {
          await queryRun('ALTER TABLE verification_codes ADD COLUMN verify_token VARCHAR(36) DEFAULT NULL AFTER used')
        }
      } catch (e) { if (!e.message?.includes('Duplicate')) console.error('[Migrations] 003 error:', e.message) }
    }
  },
  {
    id: '004_add_global_auto_config_enable_trade',
    up: async () => {
      try {
        const cols = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'global_auto_config' AND COLUMN_NAME = 'enable_auto_trade'")
        if (!cols || !cols.length) {
          await queryRun('ALTER TABLE global_auto_config ADD COLUMN enable_auto_trade TINYINT NOT NULL DEFAULT 0 AFTER selected_take_profit')
        }
      } catch (e) { if (!e.message?.includes('Duplicate')) console.error('[Migrations] 004 error:', e.message) }
    }
  },
  {
    id: '005_add_ai_configs_override_fields',
    up: async () => {
      try {
        const oc = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_configs' AND COLUMN_NAME = 'auto_config_override'")
        if (!oc || !oc.length) {
          await queryRun('ALTER TABLE ai_configs ADD COLUMN auto_config_override TINYINT NOT NULL DEFAULT 0 AFTER model_sharing_enabled')
        }
        const sym = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_configs' AND COLUMN_NAME = 'auto_symbols'")
        if (!sym || !sym.length) {
          await queryRun('ALTER TABLE ai_configs ADD COLUMN auto_symbols VARCHAR(100) DEFAULT NULL AFTER auto_config_override')
        }
        const iv = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_configs' AND COLUMN_NAME = 'auto_interval_minutes'")
        if (!iv || !iv.length) {
          await queryRun('ALTER TABLE ai_configs ADD COLUMN auto_interval_minutes INT DEFAULT NULL AFTER auto_symbols')
        }
      } catch (e) { if (!e.message?.includes('Duplicate')) console.error('[Migrations] 005 error:', e.message) }
    }
  },
  {
    id: '006_add_close_config_engine_fields',
    up: async () => {
      try {
        const cols = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'close_config' AND COLUMN_NAME = 'api_provider'")
        if (!cols || !cols.length) {
          await queryRun("ALTER TABLE close_config ADD COLUMN api_provider VARCHAR(50) DEFAULT 'deepseek' AFTER model_name")
          await queryRun("ALTER TABLE close_config ADD COLUMN api_base_url VARCHAR(255) DEFAULT 'https://api.deepseek.com' AFTER api_provider")
          await queryRun('ALTER TABLE close_config ADD COLUMN api_key_encrypted VARCHAR(500) DEFAULT NULL AFTER api_base_url')
          await queryRun('ALTER TABLE close_config ADD COLUMN temperature DOUBLE DEFAULT 0.3 AFTER api_key_encrypted')
          await queryRun('ALTER TABLE close_config ADD COLUMN max_tokens INT DEFAULT 1500 AFTER temperature')
        }
      } catch (e) { if (!e.message?.includes('Duplicate')) console.error('[Migrations] 006 error:', e.message) }
    }
  },
  {
    id: '007_cleanup_auto_scheduler_columns',
    up: async () => {
      const cols = ['api_provider','model_name','api_key_encrypted','api_base_url','temperature','max_tokens','system_prompt','risk_level','max_position_size','selected_take_profit','interval_minutes']
      for (const col of cols) {
        try { await queryRun('ALTER TABLE auto_scheduler DROP COLUMN ' + col) } catch {}
      }
      try { await queryRun('DELETE FROM auto_scheduler WHERE user_id = 0') } catch {}
    }
  },
  {
    id: '008_drop_system_prompts_table',
    up: async () => {
      try { await queryRun('DROP TABLE IF EXISTS system_prompts') } catch {}
    }
  },
  {
    id: '009_fix_bilibili_covers_https',
    up: async () => {
      try {
        await queryRun("UPDATE courses SET cover = REPLACE(cover, 'http://', 'https://') WHERE cover LIKE 'http://i%.hdslb.com/%'")
      } catch (e) { if (!e.message?.includes('Duplicate')) console.error('[Migrations] 009 error:', e.message) }
    }
  },
  {
    id: '010_add_token_count_to_signals',
    up: async () => {
      try {
        const cols = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_signals' AND COLUMN_NAME = 'token_count'")
        if (!cols || !cols.length) {
          await queryRun('ALTER TABLE ai_signals ADD COLUMN token_count INT DEFAULT 0 AFTER market_data_json')
          // 回填历史数据
          await queryRun('UPDATE ai_signals SET token_count = ROUND((LENGTH(analysis) + LENGTH(reasoning) + LENGTH(market_data_json)) / 4) WHERE token_count = 0')
        }
      } catch (e) { if (!e.message?.includes('Duplicate')) console.error('[Migrations] 010 error:', e.message) }
    }
  },
  {
    id: '011_add_auto_scheduler_new_columns',
    up: async () => {
      const cols = [
        { name: 'prompt_type_id', def: "ADD COLUMN prompt_type_id INT DEFAULT NULL AFTER user_id" },
        { name: 'risk_level', def: "ADD COLUMN risk_level VARCHAR(20) NOT NULL DEFAULT 'medium' AFTER enabled" },
        { name: 'max_position_size', def: "ADD COLUMN max_position_size DOUBLE NOT NULL DEFAULT 0.05 AFTER risk_level" },
        { name: 'selected_take_profit', def: "ADD COLUMN selected_take_profit INT NOT NULL DEFAULT 2 AFTER max_position_size" },
        { name: 'enable_auto_trade', def: "ADD COLUMN enable_auto_trade TINYINT NOT NULL DEFAULT 0 AFTER selected_take_profit" },
      ]
      for (const col of cols) {
        try {
          const existing = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_scheduler' AND COLUMN_NAME = ?", [col.name])
          if (!existing || existing.length === 0) await queryRun(`ALTER TABLE auto_scheduler ${col.def}`)
        } catch (e) {
          if (!e.message?.includes('Duplicate column')) {
            console.error(`[Migrations] 011 column ${col.name} failed:`, e.message)
          }
        }
      }
    }
  },
  {
    id: '012_add_ai_signals_new_columns',
    up: async () => {
      const cols = [
        { name: 'prompt_type_id', def: "ADD COLUMN prompt_type_id INT DEFAULT NULL AFTER config_id" },
        { name: 'source', def: "ADD COLUMN source VARCHAR(30) NOT NULL DEFAULT 'manual' AFTER session_id" },
      ]
      for (const col of cols) {
        try {
          const existing = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_signals' AND COLUMN_NAME = ?", [col.name])
          if (!existing || existing.length === 0) await queryRun(`ALTER TABLE ai_signals ${col.def}`)
        } catch (e) {
          if (!e.message?.includes('Duplicate column')) {
            console.error(`[Migrations] 012 column ${col.name} failed:`, e.message)
          }
        }
      }
    }
  },
  {
    id: '013_add_unified_indexes',
    up: async () => {
      const indexes = [
        'CREATE INDEX idx_auto_prompt_types_active_sort ON auto_prompt_types(is_active, sort_order, id)',
        'CREATE INDEX idx_auto_scheduler_prompt_enabled ON auto_scheduler(prompt_type_id, enabled)',
        'CREATE INDEX idx_auto_scheduler_enabled_prompt ON auto_scheduler(enabled, prompt_type_id)',
        'CREATE INDEX idx_auto_deliveries_user_created ON auto_signal_deliveries(user_id, created_at)',
        'CREATE INDEX idx_auto_deliveries_signal ON auto_signal_deliveries(signal_id)',
        'CREATE INDEX idx_auto_deliveries_prompt_symbol ON auto_signal_deliveries(prompt_type_id, symbol)',
        'CREATE INDEX idx_ai_signals_source_created ON ai_signals(source, created_at)',
        'CREATE INDEX idx_ai_signals_prompt_symbol_created ON ai_signals(prompt_type_id, symbol, created_at)',
      ]
      for (const sql of indexes) {
        try { await queryRun(sql) } catch (e) {
          if (!e.message?.includes('Duplicate')) console.error(`[Migrations] Index creation failed:`, e.message)
        }
      }
    }
  },
  {
    id: '014_migrate_old_auto_config',
    up: async () => {
      try {
        // 1. 如果 auto_prompt_types 为空，从 global_auto_config 迁移默认策略
        const cnt = await queryAll('SELECT COUNT(*) as c FROM auto_prompt_types')
        if ((cnt[0]?.c || 0) === 0) {
          const globalCfg = await queryOne('SELECT * FROM global_auto_config WHERE id = 1')
          if (globalCfg) {
            let symbolsArr = ['XAUUSD']
            try {
              const raw = (globalCfg.symbols || 'XAUUSD').trim()
              symbolsArr = raw.startsWith('[') ? JSON.parse(raw) : raw.split(',').map(s => s.trim()).filter(Boolean)
            } catch {}
            const now = new Date().toISOString().replace('T', ' ').substring(0, 19)
            await queryRun(
              `INSERT INTO auto_prompt_types (title, description, system_prompt, symbols_json, interval_minutes, is_active, sort_order, created_by, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 1, 0, 1, ?, ?)`,
              ['默认自动推理策略', '由旧全局自动推理配置迁移生成', globalCfg.system_prompt || '', JSON.stringify(symbolsArr), globalCfg.interval_minutes || 5, now, now]
            )
            console.log('[Migrations] Migrated default prompt type from global_auto_config')
          }
        }

        // 2. 旧 auto_scheduler.enabled=1 但 prompt_type_id 为空的用户，指向默认策略
        const defaultPt = await queryAll('SELECT id FROM auto_prompt_types LIMIT 1')
        if (defaultPt && defaultPt.length) {
          const ptId = defaultPt[0].id
          await queryRun(
            'UPDATE auto_scheduler SET prompt_type_id = ? WHERE enabled = 1 AND prompt_type_id IS NULL',
            [ptId]
          )
          // 同步 user_bridge_settings
          await queryRun(
            `INSERT INTO user_bridge_settings (user_id, auto_reasoning_enabled, updated_at)
             SELECT user_id, 1, NOW() FROM auto_scheduler WHERE enabled = 1
             ON DUPLICATE KEY UPDATE auto_reasoning_enabled = 1, updated_at = NOW()`
          )
        }

        // 3. 迁移 ai_configs.auto_config_override 的风控字段到 auto_scheduler
        const overrides = await queryAll(
          "SELECT user_id, risk_level, max_position_size, selected_take_profit, enable_auto_trade FROM ai_configs WHERE auto_config_override = 1 AND is_active = 1"
        )
        for (const cfg of overrides) {
          await queryRun(
            `UPDATE auto_scheduler SET risk_level = ?, max_position_size = ?, selected_take_profit = ?, enable_auto_trade = ?
             WHERE user_id = ?`,
            [cfg.risk_level || 'medium', cfg.max_position_size || 0.05, cfg.selected_take_profit || 1, cfg.enable_auto_trade ? 1 : 0, cfg.user_id]
          )
        }
      } catch (e) {
        console.error('[Migrations] 014_migrate_old_auto_config error:', e.message)
      }
    }
  },
  {
    id: '015_default_enable_auto_trade_and_prompt',
    up: async () => {
      try {
        await queryRun('UPDATE auto_scheduler SET enable_auto_trade = 1 WHERE enable_auto_trade = 0')
        await queryRun('UPDATE ai_configs SET enable_auto_trade = 1 WHERE enable_auto_trade = 0')
        await queryRun('UPDATE global_auto_config SET enable_auto_trade = 1 WHERE enable_auto_trade = 0 AND id = 1')
        const defaultPt = await queryOne('SELECT id FROM auto_prompt_types WHERE is_active = 1 AND deleted_at IS NULL ORDER BY sort_order ASC, id ASC LIMIT 1')
        if (defaultPt) {
          await queryRun('UPDATE auto_scheduler SET prompt_type_id = ? WHERE prompt_type_id IS NULL', [defaultPt.id])
        }
      } catch (e) {
        console.error('[Migrations] 015 error:', e.message)
      }
    }
  },
  {
    id: '016_bridge_connection_status',
    up: async () => {
      try {
        await queryRun(`CREATE TABLE IF NOT EXISTS bridge_connection_status (
          user_id BIGINT PRIMARY KEY,
          connected TINYINT DEFAULT 0,
          connected_at DATETIME NULL,
          disconnected_at DATETIME NULL,
          last_seen_at DATETIME NULL,
          last_pong_at DATETIME NULL,
          last_message_type VARCHAR(32) NULL,
          last_close_code INT NULL,
          last_close_reason VARCHAR(255) NULL,
          last_error VARCHAR(255) NULL,
          client_version VARCHAR(32) NULL,
          mt5_collect_timeout_count INT DEFAULT 0,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`)
      } catch (e) {
        console.error('[Migrations] 016 error:', e.message)
      }
    }
  },
  {
    id: '017_ai_signal_schema',
    up: async () => {
      try {
        const cols = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_signal_schema' AND COLUMN_NAME = 'name'")
        if (!cols || !cols.length) {
          await queryRun(`CREATE TABLE IF NOT EXISTS ai_signal_schema (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(50) NOT NULL DEFAULT 'default',
            schema_json TEXT NOT NULL,
            is_active TINYINT NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT (NOW()),
            updated_at DATETIME DEFAULT (NOW())
          )`)
        }
        const existing = await queryAll('SELECT COUNT(*) as c FROM ai_signal_schema')
        if ((existing[0]?.c || 0) === 0) {
          const defaultSchema = JSON.stringify({
            signal_type: "buy | sell | hold | buy_limit | sell_limit | buy_stop | sell_stop | buy_stop_limit | sell_stop_limit。禁止其他值。buy/sell=市价立即执行; buy_limit/sell_limit=挂限价单; buy_stop/sell_stop=突破追单; buy_stop_limit/sell_stop_limit=突破后限价。方向优势不清晰、关键位距离过近、短线波动过大、已有持仓风险不合适时必须返回hold",
            confidence: "0.00-1.00，动态估算，禁止固定值。按趋势强度、位置结构、波动噪音、风险状态综合评估。BUY/SELL弱优势0.52-0.62，中等0.63-0.74，强共振>0.75。HOLD时0.55-0.68，明确回避风险可>0.70。hold时也不得为0",
            recommended_volume: "0.01至输入市场数据中的max_position_size手，不得超过max_position_size。应根据当前风险与止损距离合理建议；hold时返回0",
            limit_price: "挂单价。buy_limit/sell_limit:入场价,订单直接挂在此价; buy_stop/sell_stop:触发价,价格到达后以市价成交; buy_stop_limit/sell_stop_limit:触发价,到达后按stop_limit_price挂限价单。方向：限价买单须低于当前价,限价卖单须高于当前价;突破单相反,买单触发价须高于当前价,卖单触发价须低于当前价。距离参考：M15一般0.5-2 ATR,H1一般1-3 ATR",
            stop_limit_price: "止损触发价，仅buy_stop_limit/sell_stop_limit时需要。触发后按limit_price成交。通常设在关键支撑/阻力突破位，limit_price设在突破后合理入场位",
            pending_valid_minutes: "挂单有效期(分钟)，1-1440，默认240",
            stop_loss_price: "数字，buy/sell/挂单必须给出，hold可为null。买单止损须低于入场价，卖单止损须高于入场价。距离参考：1-2倍ATR(14)。止损过近容易被噪音扫损，过远风险回报比不划算",
            take_profit_1_price: "止盈-保守(第一目标位)，数字，buy/sell/挂单必须给出，hold可为null。买单止盈须高于入场价，卖单止盈须低于入场价。建议设在最近的支撑/阻力位，R:R至少1:1",
            take_profit_2_price: "止盈-标准(第二目标位)，数字，buy/sell/挂单必须给出，hold可为null。距离应大于tp1，R:R建议1:1.5-1:2",
            take_profit_3_price: "止盈-激进(第三目标位)，数字，可选。距离应大于tp2，R:R建议1:2-1:3。仅在趋势明确且有延续依据时提供",
            analysis: "中文，按以下顺序：1.当前趋势方向和强度 2.关键支撑/阻力位 3.当前价与均线关系 4.波动率状态 5.潜在催化剂或风险事件",
            reasoning: "中文，按以下结构：1.信号方向依据（哪些指标/形态支持） 2.入场方式选择理由（为什么用市价/限价/挂单） 3.风险评估（潜在不利因素） 4.执行建议（为什么可以执行或为什么观望）"
          }, null, 2)
          await queryRun('INSERT INTO ai_signal_schema (name, schema_json, is_active) VALUES (?, ?, 1)', ['default', defaultSchema])
        }
      } catch (e) {
        console.error('[Migrations] 017 error:', e.message)
      }
    }
  },
  {
    id: '018_add_stop_limit_price_column',
    up: async () => {
      try {
        const existing = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_signals' AND COLUMN_NAME = 'stop_limit_price'")
        if (!existing || existing.length === 0) {
          await queryRun('ALTER TABLE ai_signals ADD COLUMN stop_limit_price DOUBLE DEFAULT NULL AFTER limit_price')
        }
      } catch (e) {
        if (!e.message?.includes('Duplicate column')) {
          console.error('[Migrations] 018 error:', e.message)
        }
      }
    }
  },
  {
    id: '021_add_phone_auth',
    up: async () => {
      try {
        const usersCols = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'")
        const usersColNames = (usersCols || []).map(c => c.COLUMN_NAME)

        if (!usersColNames.includes('email_verified')) {
          await queryRun("ALTER TABLE users ADD COLUMN email_verified TINYINT DEFAULT 1 AFTER email")
        }
        if (!usersColNames.includes('auth_method')) {
          await queryRun("ALTER TABLE users ADD COLUMN auth_method VARCHAR(20) DEFAULT 'email' AFTER email_verified")
        }
        if (!usersColNames.includes('phone')) {
          await queryRun("ALTER TABLE users ADD COLUMN phone VARCHAR(20) DEFAULT NULL AFTER email")
        }
        if (!usersColNames.includes('phone_verified')) {
          await queryRun("ALTER TABLE users ADD COLUMN phone_verified TINYINT DEFAULT 0 AFTER phone")
        }
      } catch (e) {
        if (!e.message?.includes('Duplicate column')) {
          console.error('[Migrations] 021 users columns error:', e.message)
        }
      }

      try {
        const vcCols = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verification_codes'")
        const vcColNames = (vcCols || []).map(c => c.COLUMN_NAME)

        if (!vcColNames.includes('phone')) {
          await queryRun("ALTER TABLE verification_codes ADD COLUMN phone VARCHAR(20) DEFAULT NULL AFTER email")
        }
      } catch (e) {
        if (!e.message?.includes('Duplicate column')) {
          console.error('[Migrations] 021 verification_codes columns error:', e.message)
        }
      }
    }
  },
  {
    id: '022_pending_order_lifecycle',
    up: async () => {
      const cols = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_signal_deliveries'")
      const colNames = (cols || []).map(c => c.COLUMN_NAME)
      if (!colNames.includes('pending_ticket')) {
        await queryRun("ALTER TABLE auto_signal_deliveries ADD COLUMN pending_ticket VARCHAR(32) DEFAULT NULL AFTER trade_ticket")
      }
      if (!colNames.includes('pending_state')) {
        await queryRun("ALTER TABLE auto_signal_deliveries ADD COLUMN pending_state VARCHAR(12) DEFAULT NULL AFTER pending_ticket")
      }
      if (!colNames.includes('pending_valid_until')) {
        await queryRun("ALTER TABLE auto_signal_deliveries ADD COLUMN pending_valid_until VARCHAR(20) DEFAULT NULL AFTER pending_state")
      }
    }
  },
  {
    id: '023_cleanup_indexes_and_dead_columns',
    up: async () => {
      // 1. Add missing indexes on frequently queried columns
      const indexes = [
        'CREATE INDEX idx_comments_episode ON comments(episode_id)',
        'CREATE INDEX idx_post_replies_post ON post_replies(post_id)',
        'CREATE INDEX idx_quiz_questions_episode ON quiz_questions(episode_id)',
        'CREATE INDEX idx_course_resources_episode ON course_resources(episode_id)',
        'CREATE INDEX idx_verification_codes_phone ON verification_codes(phone)',
      ]
      for (const sql of indexes) {
        try { await queryRun(sql) } catch (e) {
          if (!e.message?.includes('Duplicate')) console.error(`[Migrations] Index creation failed:`, e.message)
        }
      }

      // 2. Drop duplicate index on auto_scheduler (keep prompt_enabled, drop enabled_prompt)
      try { await queryRun('DROP INDEX idx_auto_scheduler_enabled_prompt ON auto_scheduler') } catch {}

      // 3. Drop dead columns — each wrapped individually for safety
      const deadCols = [
        "ALTER TABLE notifications DROP COLUMN `read`",
        'ALTER TABLE trades DROP COLUMN description',
        'ALTER TABLE trades DROP COLUMN image_url',
        'ALTER TABLE trades DROP COLUMN pnl',
        'ALTER TABLE trades DROP COLUMN status',
        'ALTER TABLE trades DROP COLUMN updated_at',
        'ALTER TABLE quiz_questions DROP COLUMN answer',
        'ALTER TABLE video_streams DROP COLUMN video_key',
      ]
      for (const sql of deadCols) {
        try { await queryRun(sql) } catch (e) {
          if (!e.message?.includes('Duplicate') && !e.message?.includes('doesn\'t exist') && !e.message?.includes('Can\'t DROP')) {
            console.error(`[Migrations] Column drop failed:`, e.message)
          }
        }
      }
    }
  },
  {
    id: '024_drop_dead_tables_and_fix_bigint',
    up: async () => {
      // Drop tables that are never queried
      try { await queryRun('DROP TABLE IF EXISTS user_notices') } catch {}
      try { await queryRun('DROP TABLE IF EXISTS broadcast_messages') } catch {}

      // Fix BIGINT → INT for bridge_connection_status.user_id (all other user_id columns are INT)
      try { await queryRun('ALTER TABLE bridge_connection_status MODIFY COLUMN user_id INT PRIMARY KEY') } catch {}
    }
  },
  {
    id: '025_drop_ui_configs_and_dead_columns',
    up: async () => {
      // Drop ui_configs — never SELECTed/INSERTed/UPDATEd, only DELETEd on user removal
      try { await queryRun('DROP TABLE IF EXISTS ui_configs') } catch {}

      // Drop users.current_view — zero SQL references in codebase
      try { await queryRun('ALTER TABLE users DROP COLUMN current_view') } catch (e) {
        if (!e.message?.includes("doesn't exist") && !e.message?.includes("Can't DROP")) {
          console.error('[Migrations] 025 drop current_view failed:', e.message)
        }
      }

      // Drop trades.dead columns already handled by migration 023, but ensure CREATE TABLE is consistent
      // (description, image_url, pnl removed from CREATE TABLE in db.js)
    }
  },
  {
    id: '026_changelog_system',
    up: async () => {
      // Add changelog_seen_version to users table
      try { await queryRun('ALTER TABLE users ADD COLUMN changelog_seen_version INT DEFAULT 0') } catch (e) {
        if (!e.message?.includes('Duplicate column')) throw e
      }
      // Seed changelog data in system_config
      const existing = await queryOne("SELECT id FROM system_config WHERE category = 'changelog' AND `key` = 'version'")
      if (!existing) {
        await queryRun("INSERT INTO system_config (category, `key`, `value`, label) VALUES (?, ?, ?, ?)", ['changelog', 'version', '1', '当前版本号'])
        await queryRun("INSERT INTO system_config (category, `key`, `value`, label) VALUES (?, ?, ?, ?)", ['changelog', 'content', '', '更新日志内容（HTML）'])
      }
    }
  },
  {
    id: '027_add_usdt_payment_fields',
    up: async () => {
      // 1. Add crypto columns to orders table
      const orderCols = [
        { name: 'crypto_chain', def: "ADD COLUMN crypto_chain VARCHAR(10) DEFAULT NULL" },
        { name: 'crypto_address', def: "ADD COLUMN crypto_address VARCHAR(100) DEFAULT NULL" },
        { name: 'crypto_amount', def: "ADD COLUMN crypto_amount DECIMAL(20,8) DEFAULT NULL" },
        { name: 'crypto_tx_hash', def: "ADD COLUMN crypto_tx_hash VARCHAR(100) DEFAULT NULL" },
        { name: 'crypto_confirmations', def: "ADD COLUMN crypto_confirmations INT DEFAULT 0" },
        { name: 'crypto_expires_at', def: "ADD COLUMN crypto_expires_at DATETIME DEFAULT NULL" },
      ]
      for (const col of orderCols) {
        try {
          const existing = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = ?", [col.name])
          if (!existing || existing.length === 0) {
            await queryRun(`ALTER TABLE orders ${col.def}`)
          }
        } catch (e) {
          if (!e.message?.includes('Duplicate column')) {
            console.error(`[Migrations] 027 orders.${col.name} failed:`, e.message)
          }
        }
      }

      // 2. Create crypto_watch_list table
      try {
        await queryRun(`CREATE TABLE IF NOT EXISTS crypto_watch_list (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id VARCHAR(36) NOT NULL,
          user_id INT NOT NULL,
          chain VARCHAR(10) NOT NULL,
          address VARCHAR(100) NOT NULL,
          expected_amount DECIMAL(20,8) NOT NULL,
          status VARCHAR(20) DEFAULT 'pending',
          tx_hash VARCHAR(100) DEFAULT NULL,
          confirmations INT DEFAULT 0,
          required_confirmations INT DEFAULT 19,
          wallet_index INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME NOT NULL,
          INDEX idx_watch_status (status),
          INDEX idx_watch_address (chain, address),
          INDEX idx_watch_expires (expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      } catch (e) {
        if (!e.message?.includes('Duplicate')) {
          console.error('[Migrations] 027 crypto_watch_list failed:', e.message)
        }
      }

      // 3. Create wallet_keys table
      try {
        await queryRun(`CREATE TABLE IF NOT EXISTS wallet_keys (
          id INT AUTO_INCREMENT PRIMARY KEY,
          chain VARCHAR(10) NOT NULL,
          address_index INT NOT NULL,
          address VARCHAR(100) NOT NULL,
          created_at DATETIME DEFAULT (NOW()),
          UNIQUE KEY uk_wallet_chain_index (chain, address_index),
          UNIQUE KEY uk_wallet_chain_address (chain, address)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      } catch (e) {
        if (!e.message?.includes('Duplicate')) {
          console.error('[Migrations] 027 wallet_keys failed:', e.message)
        }
      }
    }
  },
  {
    id: '028_ai_signals_pending_state',
    up: async () => {
      try {
        const existing = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_signals' AND COLUMN_NAME = 'pending_state'")
        if (!existing || existing.length === 0) {
          await queryRun("ALTER TABLE ai_signals ADD COLUMN pending_state VARCHAR(12) DEFAULT NULL")
          console.log('[Migrations] 028 added ai_signals.pending_state')
        }
      } catch (e) {
        if (!e.message?.includes('Duplicate column')) {
          console.error('[Migrations] 028 failed:', e.message)
        }
      }
    }
  },
  {
    id: '029_verification_token_used',
    up: async () => {
      try {
        const existing = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verification_codes' AND COLUMN_NAME = 'token_used'")
        if (!existing || existing.length === 0) {
          await queryRun("ALTER TABLE verification_codes ADD COLUMN token_used TINYINT DEFAULT 0")
          console.log('[Migrations] 029 added verification_codes.token_used')
        }
      } catch (e) {
        if (!e.message?.includes('Duplicate column')) {
          console.error('[Migrations] 029 failed:', e.message)
        }
      }
    }
  },
  {
    id: '030_fix_verification_codes_email_not_null',
    up: async () => {
      try {
        const col = await queryAll("SELECT COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'verification_codes' AND COLUMN_NAME = 'email'")
        if (col && col.length && col[0].COLUMN_DEFAULT === null) {
          await queryRun("ALTER TABLE verification_codes MODIFY COLUMN email VARCHAR(255) DEFAULT NULL")
          console.log('[Migrations] 030 changed verification_codes.email to DEFAULT NULL')
        }
      } catch (e) {
        if (!e.message?.includes('Duplicate')) {
          console.error('[Migrations] 030 failed:', e.message)
        }
      }
    }
  },
  {
    id: '032_fix_users_email_nullable',
    up: async () => {
      try {
        await queryRun("ALTER TABLE users MODIFY COLUMN email VARCHAR(255) DEFAULT NULL")
        console.log('[Migrations] 032 changed users.email to DEFAULT NULL')
      } catch (e) {
        if (!e.message?.includes('Duplicate')) {
          console.error('[Migrations] 032 failed:', e.message)
        }
      }
    }
  },
  {
    id: '033_normalize_phone_numbers',
    up: async () => {
      try {
        await queryRun("UPDATE users SET phone = TRIM(LEADING '+86' FROM phone) WHERE phone LIKE '+86%'")
        await queryRun("UPDATE verification_codes SET phone = TRIM(LEADING '+86' FROM phone) WHERE phone LIKE '+86%'")
        console.log('[Migrations] 033 normalized all phone numbers (stripped +86 prefix)')
      } catch (e) {
        console.error('[Migrations] 033 failed:', e.message)
      }
    }
  },
  {
    id: '034_unique_phone_index',
    up: async () => {
      try {
        await queryRun(`
          UPDATE users u1
          INNER JOIN (
            SELECT phone, MAX(id) AS keep_id
            FROM users
            WHERE phone IS NOT NULL AND phone != ''
            GROUP BY phone
            HAVING COUNT(*) > 1
          ) dup ON u1.phone = dup.phone AND u1.id != dup.keep_id
          SET u1.phone = NULL
        `)
        console.log('[Migrations] 034 cleaned duplicate phone numbers')
        await queryRun('CREATE UNIQUE INDEX idx_users_phone ON users(phone)')
        console.log('[Migrations] 034 added unique index on users.phone')
      } catch (e) {
        if (e.message?.includes('Duplicate')) {
          console.error('[Migrations] 034 duplicate phones remain, skipping index')
        } else if (e.message?.includes('Duplicate key name')) {
          console.log('[Migrations] 034 unique index already exists')
        } else {
          console.error('[Migrations] 034 failed:', e.message)
        }
      }
    }
  },
  {
    id: '031_cleanup_dead_columns',
    up: async () => {
      const drops = [
        'ALTER TABLE auto_scheduler DROP COLUMN symbols',
        'ALTER TABLE global_auto_config DROP COLUMN symbols',
        'ALTER TABLE global_auto_config DROP COLUMN system_prompt',
        'ALTER TABLE notifications DROP COLUMN actor_id',
        'ALTER TABLE notifications DROP COLUMN post_id',
        'ALTER TABLE notifications DROP COLUMN meta',
      ]
      for (const sql of drops) {
        try { await queryRun(sql) } catch (e) {
          if (!e.message?.includes("doesn't exist") && !e.message?.includes("Can't DROP")) {
            console.error(`[Migrations] 031 drop failed:`, e.message)
          }
        }
      }
    }
  },
  {
    id: '035_default_bridge_settings',
    up: async () => {
      try {
        await queryRun("UPDATE user_bridge_settings SET trade_send_enabled = 1 WHERE trade_send_enabled = 0")
        await queryRun("UPDATE user_bridge_settings SET auto_reasoning_enabled = 1 WHERE auto_reasoning_enabled = 0")
        await queryRun("UPDATE auto_scheduler SET enable_auto_trade = 1 WHERE enable_auto_trade = 0")
        console.log('[Migrations] 035 set default bridge/scheduler settings to enabled')
      } catch (e) {
        console.error('[Migrations] 035 failed:', e.message)
      }
    }
  },
  {
    id: '036_crypto_tx_unique',
    up: async () => {
      try {
        // 清理重复 tx_hash：保留 id 最小的行，其余置 NULL 并回退为 pending
        await queryRun(`
          UPDATE crypto_watch_list SET tx_hash = NULL, status = 'pending'
          WHERE id NOT IN (
            SELECT * FROM (
              SELECT MIN(id) FROM crypto_watch_list WHERE tx_hash IS NOT NULL GROUP BY tx_hash
            ) t
          ) AND tx_hash IS NOT NULL
        `)
        await queryRun('CREATE UNIQUE INDEX idx_watch_tx_hash ON crypto_watch_list(tx_hash)')
        console.log('[Migrations] 036 added UNIQUE index on crypto_watch_list.tx_hash')
      } catch (e) {
        if (e.message?.includes('Duplicate') || e.message?.includes('Duplicate entry')) {
          console.warn('[Migrations] 036 index may already exist:', e.message)
        } else {
          console.error('[Migrations] 036 failed:', e.message)
        }
      }
      try {
        await queryRun('CREATE UNIQUE INDEX idx_orders_crypto_tx_hash ON orders(crypto_tx_hash)')
        console.log('[Migrations] 036 added UNIQUE index on orders.crypto_tx_hash')
      } catch (e) {
        if (e.message?.includes('Duplicate') || e.message?.includes('Duplicate entry')) {
          console.warn('[Migrations] 036 orders index may already exist:', e.message)
        } else {
          console.error('[Migrations] 036 orders index failed:', e.message)
        }
      }
    }
  },
  {
    id: '037_add_ai_signals_entry_method',
    up: async () => {
      try {
        await queryRun("ALTER TABLE ai_signals ADD COLUMN entry_method VARCHAR(8) DEFAULT 'market' AFTER ai_model")
        console.log('[Migrations] 037 added entry_method to ai_signals')
      } catch (e) {
        if (e.message?.includes('Duplicate column')) {
          console.log('[Migrations] 037 entry_method already exists')
        } else {
          console.error('[Migrations] 037 failed:', e.message)
        }
      }
    }
  },
  {
    id: '038_add_ai_signals_pending_ticket',
    up: async () => {
      try {
        await queryRun("ALTER TABLE ai_signals ADD COLUMN pending_ticket VARCHAR(32) DEFAULT NULL AFTER trade_ticket")
        console.log('[Migrations] 038 added pending_ticket to ai_signals')
      } catch (e) {
        if (e.message?.includes('Duplicate column')) {
          console.log('[Migrations] 038 pending_ticket already exists')
        } else {
          console.error('[Migrations] 038 failed:', e.message)
        }
      }
    }
  },
  {
    id: '039_add_ai_signals_pending_cols',
    up: async () => {
      const cols = [
        { name: 'limit_price', def: "DOUBLE DEFAULT NULL" },
        { name: 'stop_limit_price', def: "DOUBLE DEFAULT NULL" },
        { name: 'pending_valid_until', def: "DATETIME DEFAULT NULL" },
        { name: 'order_state', def: "VARCHAR(12) DEFAULT NULL" },
      ]
      for (const col of cols) {
        try {
          await queryRun(`ALTER TABLE ai_signals ADD COLUMN ${col.name} ${col.def}`)
          console.log(`[Migrations] 039 added ${col.name} to ai_signals`)
        } catch (e) {
          if (e.message?.includes('Duplicate column')) {
            console.log(`[Migrations] 039 ${col.name} already exists`)
          } else {
            console.error(`[Migrations] 039 ${col.name} failed:`, e.message)
          }
        }
      }
    }
  },
  {
    id: '040_add_ai_signals_ticket_indexes',
    up: async () => {
      const indexes = [
        'CREATE INDEX idx_ai_signals_pending_ticket ON ai_signals(pending_ticket)',
        'CREATE INDEX idx_ai_signals_trade_ticket ON ai_signals(trade_ticket)',
      ]
      for (const sql of indexes) {
        try {
          await queryRun(sql)
          console.log(`[Migrations] 040 applied: ${sql.match(/idx_\w+/)[0]}`)
        } catch (e) {
          if (e.message?.includes('Duplicate key') || e.message?.includes('already exists')) {
            console.log(`[Migrations] 040 index already exists`)
          } else {
            console.error(`[Migrations] 040 failed:`, e.message)
          }
        }
      }
    }
  },
  {
    id: '041_add_cancel_pending_to_schema',
    up: async () => {
      try {
        const row = await queryOne('SELECT id, schema_json FROM ai_signal_schema WHERE is_active = 1 LIMIT 1')
        if (!row) { console.log('[Migrations] 041 no active schema found, skip'); return }
        const schema = JSON.parse(row.schema_json)
        if (schema.cancel_pending) { console.log('[Migrations] 041 cancel_pending already exists'); return }
        // Insert cancel_pending before analysis + fix stop_loss_price description
        const newSchema = {}
        for (const [k, v] of Object.entries(schema)) {
          if (k === 'stop_loss_price') {
            newSchema[k] = '数字，buy/sell/挂单必须给出，hold可为null。买单止损须低于入场价，卖单止损须高于入场价。最小距离由风险等级决定：low=2倍ATR(14), medium=1.5倍, high=1倍，过近会被系统自动修正。建议设在关键支撑/阻力位外侧，给足波动空间'
          } else {
            newSchema[k] = v
          }
          if (k === 'take_profit_3_price') {
            newSchema.cancel_pending = '可选数组，不填或空数组=不取消。每个元素指定取消条件：symbol(必填)品种, pending_type(可选)挂单类型如buy_limit, max_price(可选)取消此价格以下的挂单(限买单), min_price(可选)取消此价格以上的挂单(限卖单), cancel_all(可选bool)取消该品种所有挂单。reason(必填)取消原因。示例：[{"symbol":"XAUUSD","pending_type":"buy_limit","max_price":4110,"reason":"价格偏离过远"}]'
          }
        }
        await queryRun('UPDATE ai_signal_schema SET schema_json = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(newSchema, null, 2), row.id])
        console.log('[Migrations] 041 added cancel_pending to ai_signal_schema')
      } catch (e) {
        console.error('[Migrations] 041 error:', e.message)
      }
    }
  },
  {
    id: '042_fix_sl_description_in_schema',
    up: async () => {
      try {
        const row = await queryOne('SELECT id, schema_json FROM ai_signal_schema WHERE is_active = 1 LIMIT 1')
        if (!row) { console.log('[Migrations] 042 no active schema found, skip'); return }
        const schema = JSON.parse(row.schema_json)
        const correctSl = '数字，buy/sell/挂单必须给出，hold可为null。买单止损须低于入场价，卖单止损须高于入场价。最小距离由风险等级决定：low=2倍ATR(14), medium=1.5倍, high=1倍，过近会被系统自动修正。建议设在关键支撑/阻力位外侧，给足波动空间'
        if (schema.stop_loss_price === correctSl) { console.log('[Migrations] 042 stop_loss_price already correct'); return }
        schema.stop_loss_price = correctSl
        await queryRun('UPDATE ai_signal_schema SET schema_json = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(schema, null, 2), row.id])
        console.log('[Migrations] 042 fixed stop_loss_price description in ai_signal_schema')
      } catch (e) {
        console.error('[Migrations] 042 error:', e.message)
      }
    }
  },
  {
    id: '043_add_pending_management_to_schema',
    up: async () => {
      try {
        const row = await queryOne('SELECT id, schema_json FROM ai_signal_schema WHERE is_active = 1 LIMIT 1')
        if (!row) { console.log('[Migrations] 043 no active schema found, skip'); return }
        const schema = JSON.parse(row.schema_json)
        let changed = false
        // Update signal_type: add pending management rule
        if (schema.signal_type && !schema.signal_type.includes('挂单管理')) {
          schema.signal_type += MODEL_DRIVEN_PENDING_RULE
          changed = true
        }
        // Update reasoning: add item 5
        if (schema.reasoning && !schema.reasoning.includes('挂单管理')) {
          schema.reasoning += ' 5.挂单管理：检查现有挂单状态，是否需要取消、是否已有同方向挂单'
          changed = true
        }
        if (changed) {
          await queryRun('UPDATE ai_signal_schema SET schema_json = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(schema, null, 2), row.id])
          console.log('[Migrations] 043 added pending management rules to ai_signal_schema')
        } else {
          console.log('[Migrations] 043 pending management rules already exist')
        }
      } catch (e) {
        console.error('[Migrations] 043 error:', e.message)
      }
    }
  },
  {
    id: '044_add_plan_source',
    up: async () => {
      try {
        await queryRun('ALTER TABLE users ADD COLUMN plan_source VARCHAR(20) DEFAULT NULL')
        console.log('[Migrations] 044 added plan_source to users')
      } catch (e) {
        if (e.message?.includes('Duplicate column')) {
          console.log('[Migrations] 044 plan_source already exists')
        } else {
          console.error('[Migrations] 044 error:', e.message)
        }
      }
    }
  },
  {
    id: '045_update_cancel_pending_description',
    up: async () => {
      try {
        const row = await queryOne('SELECT id, schema_json FROM ai_signal_schema WHERE is_active = 1 LIMIT 1')
        if (!row) { console.log('[Migrations] 045 no active schema found, skip'); return }
        const schema = JSON.parse(row.schema_json)
        const newDesc = '必须字段（条件触发）。需要取消现有挂单时，此字段必须输出对应的取消条件数组，不能为空。不需要取消时返回空数组 []。每个元素：symbol(必填)品种, pending_type(可选)挂单类型如buy_limit/sell_limit/buy_stop/sell_stop, max_price(可选)取消此价格以下的挂单(限买单), min_price(可选)取消此价格以上的挂单(限卖单), cancel_all(可选bool)取消该品种所有挂单, reason(必填)取消原因。示例：需要取消XAUUSD上价格不合理的买单时：[{"symbol":"XAUUSD","pending_type":"buy_limit","max_price":4110,"reason":"价格偏离过远，成交概率极低"}]；不需要取消时：[]'
        if (schema.cancel_pending === newDesc) { console.log('[Migrations] 045 cancel_pending description already up to date'); return }
        schema.cancel_pending = newDesc
        await queryRun('UPDATE ai_signal_schema SET schema_json = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(schema, null, 2), row.id])
        console.log('[Migrations] 045 updated cancel_pending description in ai_signal_schema')
      } catch (e) {
        console.error('[Migrations] 045 error:', e.message)
      }
    }
  },
  {
    id: '046_update_sl_description_m15',
    up: async () => {
      try {
        const row = await queryOne('SELECT id, schema_json FROM ai_signal_schema WHERE is_active = 1 LIMIT 1')
        if (!row) { console.log('[Migrations] 046 no active schema found, skip'); return }
        const schema = JSON.parse(row.schema_json)
        const newSl = '数字，buy/sell/挂单必须给出，hold可为null。买单止损须低于入场价，卖单止损须高于入场价。最小距离由风险等级决定：low=2倍ATR(14), medium=1.5倍, high=1倍，过近会被系统自动修正。止损位必须参考M15 K线的关键支撑/阻力位（support_resistance.s1/s2/r1/r2），设在M15级别关键位外侧，给足波动空间'
        if (schema.stop_loss_price === newSl) { console.log('[Migrations] 046 stop_loss_price already up to date'); return }
        schema.stop_loss_price = newSl
        await queryRun('UPDATE ai_signal_schema SET schema_json = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(schema, null, 2), row.id])
        console.log('[Migrations] 046 updated stop_loss_price to reference M15 support/resistance')
      } catch (e) {
        console.error('[Migrations] 046 error:', e.message)
      }
    }
  },
  {
    id: '047_add_thinking_mode',
    up: async () => {
      try {
        await queryRun('ALTER TABLE global_auto_config ADD COLUMN thinking_enabled TINYINT(1) NOT NULL DEFAULT 1')
        console.log('[Migrations] 047 added thinking_enabled to global_auto_config')
      } catch (e) {
        if (e.message?.includes('Duplicate column')) {
          console.log('[Migrations] 047 thinking_enabled already exists')
        } else {
          console.error('[Migrations] 047 error:', e.message)
        }
      }
      try {
        await queryRun("ALTER TABLE global_auto_config ADD COLUMN reasoning_effort VARCHAR(10) NOT NULL DEFAULT 'max'")
        console.log('[Migrations] 047 added reasoning_effort to global_auto_config')
      } catch (e) {
        if (e.message?.includes('Duplicate column')) {
          console.log('[Migrations] 047 reasoning_effort already exists')
        } else {
          console.error('[Migrations] 047 error:', e.message)
        }
      }
    }
  },
  {
    id: '048_delivery_claiming_and_symbols',
    up: async () => {
      // Add execution_claimed_at and execution_claimed_by for idempotent delivery claiming
      try {
        await queryRun('ALTER TABLE auto_signal_deliveries ADD COLUMN execution_claimed_at DATETIME DEFAULT NULL')
        console.log('[Migrations] 048 added execution_claimed_at to auto_signal_deliveries')
      } catch (e) {
        if (e.message?.includes('Duplicate column')) console.log('[Migrations] 048 execution_claimed_at already exists')
        else throw e // Fix 9: non-duplicate errors must throw
      }
      // Add selected_symbols_json for user-level symbol persistence
      try {
        await queryRun('ALTER TABLE auto_scheduler ADD COLUMN selected_symbols_json TEXT DEFAULT NULL')
        console.log('[Migrations] 048 added selected_symbols_json to auto_scheduler')
      } catch (e) {
        if (e.message?.includes('Duplicate column')) console.log('[Migrations] 048 selected_symbols_json already exists')
        else throw e // Fix 9: non-duplicate errors must throw
      }
    }
  },
  {
    id: '049_repair_048_fields',
    up: async () => {
      // Fix 9: repair migration — verify 048 fields exist, create if missing
      const checkCol = async (table, col) => {
        const rows = await queryAll(`SELECT COUNT(*) as cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}' AND COLUMN_NAME = '${col}'`)
        return rows[0]?.cnt > 0
      }
      if (!await checkCol('auto_signal_deliveries', 'execution_claimed_at')) {
        await queryRun('ALTER TABLE auto_signal_deliveries ADD COLUMN execution_claimed_at DATETIME DEFAULT NULL')
        console.log('[Migrations] 049 repaired: added execution_claimed_at')
      }
      if (!await checkCol('auto_scheduler', 'selected_symbols_json')) {
        await queryRun('ALTER TABLE auto_scheduler ADD COLUMN selected_symbols_json TEXT DEFAULT NULL')
        console.log('[Migrations] 049 repaired: added selected_symbols_json')
      }
      console.log('[Migrations] 049 repair check complete')
    }
  },
  {
    id: '050_hold_signal_cleanup_index',
    up: async () => {
      try {
        await queryRun('CREATE INDEX idx_ai_signals_hold_cleanup ON ai_signals(signal_type, created_at, id)')
        console.log('[Migrations] 050 added hold signal cleanup index')
      } catch (e) {
        if (e.message?.includes('Duplicate key name')) {
          console.log('[Migrations] 050 hold signal cleanup index already exists')
        } else {
          throw e
        }
      }
    }
  },
  {
    id: '051_update_pending_lifecycle_schema',
    up: async () => {
      const rows = await queryAll('SELECT id, schema_json FROM ai_signal_schema WHERE is_active = 1')
      if (!rows.length) {
        console.log('[Migrations] 051 no active schema found, skip')
        return
      }
      for (const row of rows) {
        const schema = JSON.parse(row.schema_json)
        const updated = applyPendingLifecycleSchema(schema)
        await queryRun(
          'UPDATE ai_signal_schema SET schema_json = ?, updated_at = NOW() WHERE id = ?',
          [JSON.stringify(updated, null, 2), row.id]
        )
      }
      console.log(`[Migrations] 051 updated pending lifecycle rules in ${rows.length} active schema(s)`)
    }
  },
  {
    id: '052_inherit_admin_manual_prompt',
    up: async () => {
      const result = await queryRun(`
        UPDATE ai_configs c
        JOIN users u ON u.id = c.user_id
        SET c.system_prompt = NULL, c.updated_at = NOW()
        WHERE u.role <> 'admin'
          AND c.system_prompt IS NOT NULL
          AND (
            c.system_prompt LIKE '%## 输出格式（JSON Schema）%'
            OR c.system_prompt LIKE '%Return strict JSON with signal_type,%'
          )
      `)
      console.log(`[Migrations] 052 reset ${result?.affectedRows || 0} legacy manual prompt(s) to administrator inheritance`)
    }
  },
  {
    id: '053_manual_temperature_default',
    up: async () => {
      await queryRun('ALTER TABLE ai_configs ALTER COLUMN temperature SET DEFAULT 0.3')
      console.log('[Migrations] 053 set manual inference temperature default to 0.3')
    }
  },
  {
    id: '054_single_trade_volume_limit_schema',
    up: async () => {
      const rows = await queryAll('SELECT id, schema_json FROM ai_signal_schema WHERE is_active = 1')
      const recommendedVolumeRule = '0.01至输入市场数据中的max_position_size手，不得超过max_position_size。应根据当前风险与止损距离合理建议；hold时返回0'
      let updatedCount = 0
      for (const row of rows) {
        const schema = JSON.parse(row.schema_json)
        if (!schema || typeof schema !== 'object' || Array.isArray(schema)) continue
        schema.recommended_volume = recommendedVolumeRule
        await queryRun(
          'UPDATE ai_signal_schema SET schema_json = ?, updated_at = NOW() WHERE id = ?',
          [JSON.stringify(schema, null, 2), row.id]
        )
        updatedCount++
      }
      console.log(`[Migrations] 054 updated single-trade volume rule in ${updatedCount} active schema(s)`)
    }
  },
  {
    id: '055_course_morning_category',
    up: async () => {
      const result = await queryRun(`
        UPDATE courses c
        SET c.category = 'morning', c.updated_at = NOW()
        WHERE c.content_type = 'video'
          AND c.category <> 'morning'
          AND (
            c.has_stream_video = 1
            OR COALESCE(c.bilibili_id, '') <> ''
            OR COALESCE(c.youtube_id, '') <> ''
            OR COALESCE(c.local_video_path, '') <> ''
            OR EXISTS (
              SELECT 1 FROM video_streams vs WHERE vs.episode_id = c.episode_id
            )
          )
      `)
      console.log(`[Migrations] 055 moved ${result?.affectedRows || 0} existing video course(s) to morning category`)
    }
  },
  {
    id: '056_model_profiles_tables',
    up: async () => {
      const stmts = [
        `CREATE TABLE IF NOT EXISTS ai_model_profiles (
          id INT AUTO_INCREMENT PRIMARY KEY,
          owner_user_id INT NOT NULL DEFAULT 0,
          scope ENUM('user','platform') NOT NULL DEFAULT 'user',
          provider VARCHAR(32) NOT NULL DEFAULT 'deepseek',
          model_name VARCHAR(128) NOT NULL DEFAULT 'deepseek-chat',
          api_base_url VARCHAR(512) DEFAULT NULL,
          api_key_encrypted TEXT DEFAULT NULL,
          key_version VARCHAR(32) DEFAULT NULL,
          temperature DECIMAL(3,2) DEFAULT 0.30,
          max_tokens INT DEFAULT 2000,
          thinking_enabled TINYINT NOT NULL DEFAULT 1,
          reasoning_effort VARCHAR(16) DEFAULT 'max',
          is_default TINYINT NOT NULL DEFAULT 0,
          status VARCHAR(16) NOT NULL DEFAULT 'active',
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL,
          deleted_at DATETIME DEFAULT NULL,
          INDEX idx_model_profiles_owner (owner_user_id, deleted_at),
          INDEX idx_model_profiles_scope (scope, status, deleted_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        `CREATE TABLE IF NOT EXISTS user_model_defaults (
          user_id INT NOT NULL PRIMARY KEY,
          model_profile_id INT NOT NULL,
          created_at DATETIME NOT NULL,
          updated_at DATETIME NOT NULL,
          INDEX idx_umd_profile (model_profile_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        `CREATE TABLE IF NOT EXISTS platform_model_usage_policy (
          id INT NOT NULL DEFAULT 1 PRIMARY KEY,
          share_for_manual TINYINT NOT NULL DEFAULT 0,
          share_for_auto TINYINT NOT NULL DEFAULT 0,
          share_for_review TINYINT NOT NULL DEFAULT 0,
          share_for_memory_compression TINYINT NOT NULL DEFAULT 0,
          allowed_plans JSON DEFAULT NULL,
          daily_requests_per_user INT NOT NULL DEFAULT 100,
          daily_tokens_per_user INT NOT NULL DEFAULT 500000,
          updated_at DATETIME NOT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

        `CREATE TABLE IF NOT EXISTS ai_model_usage_logs (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          model_profile_id INT DEFAULT NULL,
          credential_source VARCHAR(32) NOT NULL DEFAULT 'user',
          \`usage\` VARCHAR(32) NOT NULL,
          strategy_id INT DEFAULT NULL,
          token_count INT NOT NULL DEFAULT 0,
          request_status VARCHAR(16) NOT NULL DEFAULT 'success',
          error_code VARCHAR(128) DEFAULT NULL,
          created_at DATETIME NOT NULL,
          INDEX idx_usage_logs_user (user_id, created_at),
          INDEX idx_usage_logs_usage (\`usage\`, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      ]
      for (const sql of stmts) {
        await queryRun(sql)
      }
    }
  },
  {
    id: '057_strategy_ownership',
    up: async () => {
      // 1. Extend auto_prompt_types with ownership/visibility columns (idempotent)
      const aptCols = [
        { name: 'scope', def: "ADD COLUMN scope VARCHAR(20) NOT NULL DEFAULT 'platform'" },
        { name: 'owner_user_id', def: 'ADD COLUMN owner_user_id INT NOT NULL DEFAULT 0' },
        { name: 'model_profile_id', def: 'ADD COLUMN model_profile_id INT DEFAULT NULL' },
        { name: 'inference_mode', def: "ADD COLUMN inference_mode VARCHAR(32) NOT NULL DEFAULT 'platform_model'" },
        { name: 'visibility_status', def: "ADD COLUMN visibility_status VARCHAR(20) NOT NULL DEFAULT 'active'" },
        { name: 'version', def: 'ADD COLUMN version INT NOT NULL DEFAULT 1' },
        { name: 'version_label', def: "ADD COLUMN version_label VARCHAR(50) DEFAULT ''" },
      ]
      for (const col of aptCols) {
        const existing = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_prompt_types' AND COLUMN_NAME = ?", [col.name])
        if (!existing || existing.length === 0) {
          await queryRun(`ALTER TABLE auto_prompt_types ${col.def}`)
          console.log(`[Migrations] 057 added ${col.name} to auto_prompt_types`)
        }
      }

      // Index for scope+owner lookups (idempotent)
      const idxRows = await queryAll("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_prompt_types' AND INDEX_NAME = 'idx_apt_scope_owner'")
      if (!idxRows || idxRows.length === 0) {
        await queryRun('CREATE INDEX idx_apt_scope_owner ON auto_prompt_types(scope, owner_user_id, deleted_at)')
      }

      // 2. Create trading_accounts table
      await queryRun(`CREATE TABLE IF NOT EXISTS trading_accounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        broker_server VARCHAR(100) NOT NULL DEFAULT '',
        login_account VARCHAR(50) NOT NULL DEFAULT '',
        nickname VARCHAR(100) DEFAULT '',
        margin_mode VARCHAR(20) NOT NULL DEFAULT 'netting',
        review_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        observe_status VARCHAR(20) NOT NULL DEFAULT 'active',
        is_deleted TINYINT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT (NOW()),
        updated_at DATETIME NOT NULL DEFAULT (NOW()),
        INDEX idx_ta_user (user_id, is_deleted)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      // 3. Create strategy_subscriptions table
      await queryRun(`CREATE TABLE IF NOT EXISTS strategy_subscriptions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        trading_account_id INT NOT NULL,
        strategy_id INT NOT NULL,
        risk_profile_id INT DEFAULT NULL,
        symbols_json TEXT DEFAULT NULL,
        execution_enabled TINYINT NOT NULL DEFAULT 0,
        memory_mode VARCHAR(20) NOT NULL DEFAULT 'shared',
        conflicting_strategy_id INT DEFAULT NULL,
        is_deleted TINYINT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT (NOW()),
        updated_at DATETIME NOT NULL DEFAULT (NOW()),
        INDEX idx_ss_user_strategy (user_id, strategy_id, is_deleted),
        INDEX idx_ss_account_strategy (trading_account_id, strategy_id, is_deleted),
        INDEX idx_ss_account_exec (trading_account_id, execution_enabled, is_deleted)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      // 4. Backfill existing auto_prompt_types
      await queryRun("UPDATE auto_prompt_types SET scope = 'platform', owner_user_id = 0 WHERE scope = 'platform' AND owner_user_id = 0 AND deleted_at IS NULL")
    }
  },
  {
    id: '058_order_intent_gateway',
    up: async () => {
      await queryRun(`CREATE TABLE IF NOT EXISTS order_intents (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        idempotency_key VARCHAR(191) NOT NULL,
        user_id INT NOT NULL,
        trading_account_id INT NOT NULL DEFAULT 0,
        source_type VARCHAR(32) NOT NULL,
        source_id VARCHAR(64) DEFAULT NULL,
        client_request_id VARCHAR(128) DEFAULT NULL,
        action VARCHAR(32) NOT NULL,
        symbol VARCHAR(64) DEFAULT NULL,
        request_json LONGTEXT DEFAULT NULL,
        risk_json LONGTEXT DEFAULT NULL,
        bridge_payload_json LONGTEXT DEFAULT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'preparing',
        lease_token VARCHAR(64) DEFAULT NULL,
        lease_expires_at DATETIME DEFAULT NULL,
        bridge_command_ref VARCHAR(32) DEFAULT NULL,
        trade_ticket VARCHAR(64) DEFAULT NULL,
        pending_ticket VARCHAR(64) DEFAULT NULL,
        result_json LONGTEXT DEFAULT NULL,
        error_code VARCHAR(128) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        completed_at DATETIME DEFAULT NULL,
        UNIQUE KEY uk_order_intent_idempotency (idempotency_key),
        INDEX idx_order_intent_account_status (trading_account_id, status, updated_at),
        INDEX idx_order_intent_user_status (user_id, status, updated_at),
        INDEX idx_order_intent_lease (status, lease_expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS risk_reservations (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        order_intent_id BIGINT NOT NULL,
        user_id INT NOT NULL,
        trading_account_id INT DEFAULT NULL,
        symbol VARCHAR(64) DEFAULT NULL,
        reserved_volume DECIMAL(18,8) NOT NULL DEFAULT 0,
        reserved_risk_amount DECIMAL(20,8) DEFAULT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'active',
        expires_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_risk_reservation_intent (order_intent_id),
        INDEX idx_risk_reservation_account (trading_account_id, status, expires_at),
        INDEX idx_risk_reservation_user (user_id, status, expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '059_core_risk_policy',
    up: async () => {
      const stmts = [
        `CREATE TABLE IF NOT EXISTS risk_policy_sets (
          id BIGINT AUTO_INCREMENT PRIMARY KEY, scope VARCHAR(24) NOT NULL,
          owner_user_id INT NOT NULL DEFAULT 0, trading_account_id INT DEFAULT NULL,
          name VARCHAR(128) NOT NULL, active_version_id BIGINT DEFAULT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'active', created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
          INDEX idx_risk_policy_scope (scope, owner_user_id, trading_account_id, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS risk_policy_versions (
          id BIGINT AUTO_INCREMENT PRIMARY KEY, policy_set_id BIGINT NOT NULL, version_no INT NOT NULL,
          config_json LONGTEXT NOT NULL, created_by INT NOT NULL, change_reason VARCHAR(500) DEFAULT NULL,
          effective_at DATETIME NOT NULL, created_at DATETIME NOT NULL,
          UNIQUE KEY uk_risk_policy_version (policy_set_id, version_no), INDEX idx_risk_policy_effective (policy_set_id, effective_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS risk_policy_change_items (
          id BIGINT AUTO_INCREMENT PRIMARY KEY, policy_set_id BIGINT NOT NULL, field_code VARCHAR(80) NOT NULL,
          old_value_json TEXT DEFAULT NULL, new_value_json TEXT NOT NULL, change_class VARCHAR(20) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending', requested_by INT NOT NULL, reason VARCHAR(500) DEFAULT NULL,
          effective_at DATETIME NOT NULL, cancelled_at DATETIME DEFAULT NULL, created_at DATETIME NOT NULL,
          INDEX idx_risk_change_due (policy_set_id, status, effective_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS risk_profiles (
          id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, name VARCHAR(128) NOT NULL,
          config_json LONGTEXT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'active',
          created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, deleted_at DATETIME DEFAULT NULL,
          INDEX idx_risk_profile_user (user_id, status, deleted_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
        `CREATE TABLE IF NOT EXISTS risk_decisions (
          id BIGINT AUTO_INCREMENT PRIMARY KEY, order_intent_id BIGINT NOT NULL,
          policy_version_ids_json TEXT DEFAULT NULL, original_order_json LONGTEXT NOT NULL,
          approved_order_json LONGTEXT DEFAULT NULL, rule_results_json LONGTEXT NOT NULL,
          decision_status VARCHAR(20) NOT NULL, reject_code VARCHAR(128) DEFAULT NULL, created_at DATETIME NOT NULL,
          UNIQUE KEY uk_risk_decision_intent (order_intent_id), INDEX idx_risk_decision_status (decision_status, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      ]
      for (const sql of stmts) await queryRun(sql)

      const additions = [
        ['order_intents', 'original_order_json', 'LONGTEXT DEFAULT NULL'],
        ['order_intents', 'approved_order_json', 'LONGTEXT DEFAULT NULL'],
        ['order_intents', 'risk_decision_id', 'BIGINT DEFAULT NULL'],
        ['auto_signal_deliveries', 'order_intent_id', 'BIGINT DEFAULT NULL'],
        ['auto_signal_deliveries', 'risk_decision_id', 'BIGINT DEFAULT NULL'],
        ['auto_signal_deliveries', 'approved_order_json', 'LONGTEXT DEFAULT NULL'],
      ]
      for (const [table, name, definition] of additions) {
        const rows = await queryAll('SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', [table, name])
        if (!rows.length) await queryRun(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
      }

      // L5 requires an explicit entry method. Upgrade every active persisted
      // schema so production does not silently hold otherwise valid signals.
      const schemas = await queryAll('SELECT id, schema_json FROM ai_signal_schema WHERE is_active = 1')
      for (const row of schemas) {
        let schema
        try { schema = JSON.parse(row.schema_json || '{}') } catch { continue }
        if (schema.entry_method !== undefined) continue
        schema.entry_method = '必须字段。仅允许 market | limit | stop | stop_limit | observe，且必须与 signal_type 一致'
        await queryRun('UPDATE ai_signal_schema SET schema_json = ?, updated_at = ? WHERE id = ?', [JSON.stringify(schema, null, 2), beijingNow(), row.id])
      }
    }
  },
  {
    id: '060_stateful_risk_governance',
    up: async () => {
      const accountAdditions = [
        ['observed_until', 'DATETIME DEFAULT NULL'],
        ['identity_verified_at', 'DATETIME DEFAULT NULL'],
      ]
      for (const [name, definition] of accountAdditions) {
        const rows = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_accounts' AND COLUMN_NAME = ?", [name])
        if (!rows.length) await queryRun(`ALTER TABLE trading_accounts ADD COLUMN ${name} ${definition}`)
      }
      const identityIndex = await queryAll("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_accounts' AND INDEX_NAME = 'uk_trading_account_identity'")
      if (!identityIndex.length) {
        const duplicates = await queryAll(`SELECT user_id, broker_server, login_account FROM trading_accounts
          GROUP BY user_id, broker_server, login_account HAVING COUNT(*) > 1`)
        for (const duplicate of duplicates) {
          const rows = await queryAll(`SELECT id, is_deleted FROM trading_accounts
            WHERE user_id = ? AND broker_server = ? AND login_account = ?
            ORDER BY is_deleted ASC, updated_at DESC, id DESC`, [duplicate.user_id, duplicate.broker_server, duplicate.login_account])
          const keeper = rows[0]
          const redundant = rows.slice(1).map(row => Number(row.id))
          if (keeper && redundant.length) {
            await queryRun(`UPDATE strategy_subscriptions SET trading_account_id = ? WHERE trading_account_id IN (${redundant.map(() => '?').join(',')})`, [keeper.id, ...redundant])
            await queryRun(`DELETE FROM trading_accounts WHERE id IN (${redundant.map(() => '?').join(',')})`, redundant)
          }
        }
        await queryRun('CREATE UNIQUE INDEX uk_trading_account_identity ON trading_accounts(user_id, broker_server, login_account)')
      }

      await queryRun(`CREATE TABLE IF NOT EXISTS risk_account_state (
        trading_account_id INT NOT NULL PRIMARY KEY, user_id INT NOT NULL,
        business_date DATE DEFAULT NULL, day_start_equity DECIMAL(20,8) DEFAULT NULL,
        day_realized_net DECIMAL(20,8) NOT NULL DEFAULT 0, day_floating_pnl DECIMAL(20,8) NOT NULL DEFAULT 0,
        cumulative_cash_flow DECIMAL(20,8) DEFAULT NULL, equity_high_water DECIMAL(20,8) DEFAULT NULL,
        drawdown_pct DECIMAL(12,6) NOT NULL DEFAULT 0, consecutive_losses INT NOT NULL DEFAULT 0,
        cooldown_until DATETIME DEFAULT NULL, halt_status VARCHAR(24) NOT NULL DEFAULT 'active',
        halt_reason VARCHAR(128) DEFAULT NULL, user_kill_switch TINYINT NOT NULL DEFAULT 0,
        data_complete TINYINT NOT NULL DEFAULT 0, last_success_open_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
        INDEX idx_risk_state_user (user_id, halt_status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS risk_recovery_requests (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, trading_account_id INT NOT NULL, user_id INT NOT NULL,
        request_type VARCHAR(32) NOT NULL, reason VARCHAR(1000) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending',
        requested_by INT NOT NULL, reviewed_by INT DEFAULT NULL, review_reason VARCHAR(1000) DEFAULT NULL,
        created_at DATETIME NOT NULL, reviewed_at DATETIME DEFAULT NULL,
        INDEX idx_recovery_account (trading_account_id, status, created_at), INDEX idx_recovery_status (status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS global_risk_control (
        id INT NOT NULL PRIMARY KEY, global_kill_switch TINYINT NOT NULL DEFAULT 0,
        reason VARCHAR(1000) DEFAULT NULL, changed_by INT DEFAULT NULL, updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`INSERT INTO global_risk_control (id, global_kill_switch, updated_at)
        VALUES (1, 0, ?) ON DUPLICATE KEY UPDATE id = id`, [beijingNow()])

      const reservationAdditions = [
        ['reserved_daily_count', 'INT NOT NULL DEFAULT 1'],
        ['reserved_notional', 'DECIMAL(20,8) DEFAULT NULL'],
      ]
      for (const [name, definition] of reservationAdditions) {
        const rows = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'risk_reservations' AND COLUMN_NAME = ?", [name])
        if (!rows.length) await queryRun(`ALTER TABLE risk_reservations ADD COLUMN ${name} ${definition}`)
      }
    }
  },
  {
    id: '061_inference_snapshots',
    up: async () => {
      await queryRun(`CREATE TABLE IF NOT EXISTS inference_snapshots (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        signal_id BIGINT DEFAULT NULL, strategy_id INT NOT NULL, strategy_version INT NOT NULL DEFAULT 1,
        strategy_scope VARCHAR(20) NOT NULL, owner_user_id INT NOT NULL DEFAULT 0,
        standard_symbol VARCHAR(64) NOT NULL, market_source VARCHAR(64) NOT NULL,
        system_prompt LONGTEXT NOT NULL, user_prompt LONGTEXT NOT NULL, prompt_hash CHAR(64) NOT NULL,
        model_profile_id INT DEFAULT NULL, provider VARCHAR(50) DEFAULT NULL, model_name VARCHAR(150) DEFAULT NULL,
        credential_source VARCHAR(32) NOT NULL, output_schema_version CHAR(64) NOT NULL,
        klines_json LONGTEXT DEFAULT NULL, market_snapshot_json LONGTEXT NOT NULL,
        memory_mode VARCHAR(20) NOT NULL DEFAULT 'off', evidence_status VARCHAR(24) NOT NULL DEFAULT 'complete',
        omitted_fields_json TEXT DEFAULT NULL, content_hash CHAR(64) NOT NULL, byte_size INT NOT NULL,
        created_at DATETIME NOT NULL,
        INDEX idx_inference_snapshot_signal (signal_id),
        INDEX idx_inference_snapshot_strategy (strategy_id, created_at),
        INDEX idx_inference_snapshot_owner (owner_user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '062_signal_outcomes',
    up: async () => {
      await queryRun(`CREATE TABLE IF NOT EXISTS signal_outcomes (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, signal_id BIGINT DEFAULT NULL, delivery_id BIGINT DEFAULT NULL,
        order_intent_id BIGINT NOT NULL, user_id INT NOT NULL, trading_account_id INT NOT NULL,
        margin_mode VARCHAR(20) NOT NULL, symbol VARCHAR(64) NOT NULL,
        entry_order_ticket VARCHAR(64) DEFAULT NULL, entry_deal_ticket VARCHAR(64) DEFAULT NULL,
        pending_ticket VARCHAR(64) DEFAULT NULL, position_id VARCHAR(64) DEFAULT NULL,
        expected_volume DECIMAL(18,8) NOT NULL DEFAULT 0, entry_volume DECIMAL(18,8) NOT NULL DEFAULT 0,
        closed_volume DECIMAL(18,8) NOT NULL DEFAULT 0, gross_profit DECIMAL(20,8) NOT NULL DEFAULT 0,
        commission DECIMAL(20,8) NOT NULL DEFAULT 0, swap DECIMAL(20,8) NOT NULL DEFAULT 0,
        fee DECIMAL(20,8) NOT NULL DEFAULT 0, net_profit DECIMAL(20,8) NOT NULL DEFAULT 0,
        status VARCHAR(32) NOT NULL DEFAULT 'open', attribution_status VARCHAR(32) NOT NULL DEFAULT 'pending',
        external_intervention TINYINT NOT NULL DEFAULT 0, intervention_json TEXT DEFAULT NULL,
        closing_candidate_hash CHAR(64) DEFAULT NULL, fee_stable_at DATETIME DEFAULT NULL,
        fully_closed_at DATETIME DEFAULT NULL, review_eligible_at DATETIME DEFAULT NULL,
        last_scan_at DATETIME DEFAULT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_signal_outcome_intent (order_intent_id),
        INDEX idx_outcome_user_status (user_id, status, updated_at),
        INDEX idx_outcome_account_status (trading_account_id, status, updated_at),
        INDEX idx_outcome_position (trading_account_id, position_id),
        INDEX idx_outcome_ticket (trading_account_id, entry_order_ticket)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS signal_outcome_deals (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, outcome_id BIGINT NOT NULL, user_id INT NOT NULL,
        trading_account_id INT NOT NULL, deal_ticket VARCHAR(64) NOT NULL, position_id VARCHAR(64) DEFAULT NULL,
        order_ticket VARCHAR(64) DEFAULT NULL, entry_type INT DEFAULT NULL, magic BIGINT DEFAULT NULL,
        reason INT DEFAULT NULL, comment VARCHAR(255) DEFAULT NULL, volume DECIMAL(18,8) NOT NULL DEFAULT 0,
        price DECIMAL(20,8) DEFAULT NULL, profit DECIMAL(20,8) NOT NULL DEFAULT 0,
        commission DECIMAL(20,8) NOT NULL DEFAULT 0, swap DECIMAL(20,8) NOT NULL DEFAULT 0,
        fee DECIMAL(20,8) NOT NULL DEFAULT 0, deal_time DATETIME DEFAULT NULL, raw_json TEXT DEFAULT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uk_outcome_account_deal (trading_account_id, deal_ticket),
        INDEX idx_outcome_deals_outcome (outcome_id, deal_time),
        INDEX idx_outcome_deals_position (trading_account_id, position_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '063_trade_review_workflow',
    up: async () => {
      await queryRun(`CREATE TABLE IF NOT EXISTS trade_review_cases (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, outcome_id BIGINT NOT NULL, signal_id BIGINT DEFAULT NULL,
        user_id INT NOT NULL, trading_account_id INT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'evidence_pending',
        evidence_status VARCHAR(24) NOT NULL DEFAULT 'pending', evidence_reason VARCHAR(255) DEFAULT NULL,
        evidence_json LONGTEXT DEFAULT NULL, evidence_hash CHAR(64) DEFAULT NULL,
        trade_process_issue_status VARCHAR(24) NOT NULL DEFAULT 'unreviewed',
        review_content_status VARCHAR(24) NOT NULL DEFAULT 'pending',
        current_version_id BIGINT DEFAULT NULL, approved_version_id BIGINT DEFAULT NULL,
        deferred_at DATETIME DEFAULT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_trade_review_outcome (outcome_id),
        INDEX idx_trade_review_owner (user_id, status, updated_at),
        INDEX idx_trade_review_health (status, evidence_status, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS trade_review_versions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, case_id BIGINT NOT NULL, version_no INT NOT NULL,
        parent_version_id BIGINT DEFAULT NULL, author_type VARCHAR(16) NOT NULL,
        author_user_id INT DEFAULT NULL, content_json LONGTEXT NOT NULL, content_hash CHAR(64) NOT NULL,
        change_note VARCHAR(500) DEFAULT NULL, created_at DATETIME NOT NULL,
        UNIQUE KEY uk_trade_review_version (case_id, version_no),
        INDEX idx_trade_review_versions_case (case_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS trade_review_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, case_id BIGINT NOT NULL, idempotency_key VARCHAR(180) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'queued', attempt_count INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3, lease_token CHAR(36) DEFAULT NULL,
        lease_expires_at DATETIME DEFAULT NULL, model_profile_id INT DEFAULT NULL,
        credential_source VARCHAR(32) DEFAULT NULL, last_error_code VARCHAR(128) DEFAULT NULL,
        created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, completed_at DATETIME DEFAULT NULL,
        UNIQUE KEY uk_trade_review_job_key (idempotency_key),
        INDEX idx_trade_review_job_claim (status, lease_expires_at, updated_at),
        INDEX idx_trade_review_job_case (case_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '064_personal_experience_memory',
    up: async () => {
      await queryRun(`CREATE TABLE IF NOT EXISTS user_memory_settings (
        user_id INT NOT NULL PRIMARY KEY, enabled TINYINT NOT NULL DEFAULT 1,
        runtime_token_budget INT NOT NULL DEFAULT 800, retrieval_mode VARCHAR(16) NOT NULL DEFAULT 'active',
        updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS experience_memory_items (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, review_case_id BIGINT NOT NULL,
        review_version_id BIGINT NOT NULL, strategy_id INT DEFAULT NULL, symbol VARCHAR(64) DEFAULT NULL,
        timeframe VARCHAR(16) DEFAULT NULL, direction VARCHAR(20) DEFAULT NULL,
        entry_method VARCHAR(20) DEFAULT NULL, market_regime VARCHAR(64) DEFAULT NULL,
        scope_json TEXT NOT NULL, conditions_json TEXT NOT NULL, lesson_text TEXT NOT NULL,
        anti_pattern_text TEXT DEFAULT NULL, evidence_refs_json TEXT NOT NULL,
        ancestor_memory_ids_json TEXT NOT NULL, content_hash CHAR(64) NOT NULL,
        token_count INT NOT NULL, confidence DECIMAL(8,6) NOT NULL DEFAULT 0.5,
        status VARCHAR(24) NOT NULL DEFAULT 'active', confirmed_at DATETIME NOT NULL,
        revoked_at DATETIME DEFAULT NULL, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_memory_review_version (review_version_id),
        INDEX idx_memory_retrieval (user_id, status, strategy_id, symbol, timeframe, updated_at),
        INDEX idx_memory_hash (user_id, content_hash)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS experience_memory_summaries (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, scope_key VARCHAR(191) NOT NULL,
        version_no INT NOT NULL, source_memory_ids_json LONGTEXT NOT NULL, source_set_hash CHAR(64) NOT NULL,
        summary_text LONGTEXT NOT NULL, token_count INT NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'active',
        model_profile_id INT DEFAULT NULL, credential_source VARCHAR(32) DEFAULT NULL,
        created_at DATETIME NOT NULL, invalidated_at DATETIME DEFAULT NULL,
        UNIQUE KEY uk_memory_summary_version (user_id, scope_key, version_no),
        INDEX idx_memory_summary_active (user_id, scope_key, status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS memory_compression_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, scope_key VARCHAR(191) NOT NULL,
        source_memory_ids_json LONGTEXT NOT NULL, source_set_hash CHAR(64) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'queued', attempt_count INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3, lease_token CHAR(36) DEFAULT NULL,
        lease_expires_at DATETIME DEFAULT NULL, last_error_code VARCHAR(128) DEFAULT NULL,
        created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL, completed_at DATETIME DEFAULT NULL,
        UNIQUE KEY uk_memory_compression_source (user_id, scope_key, source_set_hash),
        INDEX idx_memory_compression_claim (status, lease_expires_at, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS memory_injection_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, signal_id BIGINT DEFAULT NULL,
        inference_snapshot_id BIGINT DEFAULT NULL, strategy_id INT DEFAULT NULL, symbol VARCHAR(64) DEFAULT NULL,
        mode VARCHAR(16) NOT NULL, experiment_group VARCHAR(24) NOT NULL,
        selected_item_ids_json TEXT NOT NULL, selected_summary_ids_json TEXT NOT NULL,
        token_count INT NOT NULL DEFAULT 0, retrieval_reasons_json LONGTEXT NOT NULL,
        created_at DATETIME NOT NULL,
        INDEX idx_memory_injection_user (user_id, created_at),
        INDEX idx_memory_injection_signal (signal_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '065_ai_rollout_governance',
    up: async () => {
      const userColumns = [
        { name: 'deleted_at', definition: 'ADD COLUMN deleted_at DATETIME DEFAULT NULL' },
        { name: 'deletion_status', definition: "ADD COLUMN deletion_status VARCHAR(24) NOT NULL DEFAULT 'active'" },
      ]
      for (const column of userColumns) {
        const rows = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = ?", [column.name])
        if (!rows.length) await queryRun(`ALTER TABLE users ${column.definition}`)
      }
      const userIndex = await queryAll("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'idx_users_deletion_status'")
      if (!userIndex.length) await queryRun('CREATE INDEX idx_users_deletion_status ON users(deletion_status, deleted_at)')

      await queryRun(`CREATE TABLE IF NOT EXISTS ai_feature_flags (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        scope VARCHAR(16) NOT NULL,
        user_id INT NOT NULL DEFAULT 0,
        review_generation_enabled TINYINT DEFAULT NULL,
        experience_memory_enabled TINYINT DEFAULT NULL,
        memory_compression_enabled TINYINT DEFAULT NULL,
        retrieval_shadow_enabled TINYINT DEFAULT NULL,
        paired_experiment_enabled TINYINT DEFAULT NULL,
        updated_by INT DEFAULT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_ai_feature_scope_user (scope, user_id),
        INDEX idx_ai_feature_user (user_id, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`INSERT IGNORE INTO ai_feature_flags
        (scope, user_id, review_generation_enabled, experience_memory_enabled, memory_compression_enabled,
         retrieval_shadow_enabled, paired_experiment_enabled, updated_at)
        VALUES ('global', 0, 0, 0, 0, 1, 0, ?)`, [beijingNow()])

      await queryRun(`CREATE TABLE IF NOT EXISTS risk_rule_rollouts (
        rule_code VARCHAR(80) PRIMARY KEY,
        mode VARCHAR(16) NOT NULL DEFAULT 'shadow',
        forced_enforce TINYINT NOT NULL DEFAULT 0,
        updated_by INT DEFAULT NULL,
        updated_at DATETIME NOT NULL,
        INDEX idx_risk_rule_rollout_mode (mode, forced_enforce)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      for (const code of ['ownership','entitlement','account_review','kill_switch','data_complete','idempotency','volume_bounds']) {
        await queryRun(`INSERT IGNORE INTO risk_rule_rollouts (rule_code, mode, forced_enforce, updated_at)
          VALUES (?, 'enforce', 1, ?)`, [code, beijingNow()])
      }

      await queryRun(`CREATE TABLE IF NOT EXISTS credential_migration_runs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        status VARCHAR(24) NOT NULL,
        migrated_count INT NOT NULL DEFAULT 0,
        rotated_count INT NOT NULL DEFAULT 0,
        failed_count INT NOT NULL DEFAULT 0,
        legacy_cleared TINYINT NOT NULL DEFAULT 0,
        error_code VARCHAR(128) DEFAULT NULL,
        started_at DATETIME NOT NULL,
        completed_at DATETIME DEFAULT NULL,
        INDEX idx_credential_migration_status (status, started_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '066_paired_inference_evidence',
    up: async () => {
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_paired_inference_runs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL, strategy_id INT DEFAULT NULL, signal_id BIGINT DEFAULT NULL,
        memory_injection_log_id BIGINT DEFAULT NULL,
        treatment_digest_json TEXT NOT NULL, control_digest_json TEXT DEFAULT NULL,
        treatment_hash CHAR(64) NOT NULL, control_hash CHAR(64) DEFAULT NULL,
        status VARCHAR(24) NOT NULL, error_code VARCHAR(128) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        INDEX idx_paired_inference_user (user_id, created_at),
        INDEX idx_paired_inference_signal (signal_id),
        INDEX idx_paired_inference_status (status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      const adjustableRules = [
        'R1.1_SYMBOL_NOT_ALLOWED', 'R1.4_STOP_LOSS_TOO_FAR', 'R1.5_RR_TOO_LOW',
        'R1.7_PENDING_DEVIATION', 'R4.2_WEEKEND_PROTECTION', 'R4.3_SIGNAL_EXPIRED',
        'R4.4_QUOTE_STALE', 'R4.5_SPREAD_TOO_WIDE', 'R4.6_MARKET_SIGNAL_DRIFT',
        'R2.1_DIRECTIONAL_EXPOSURE', 'R2.2_MIN_OPEN_INTERVAL', 'R2.3_DAILY_OPEN_COUNT',
        'R2.4_PRICE_TIME_DUPLICATE', 'R3.1_DAILY_LOSS_LIMIT', 'R3.2_LOSS_COOLDOWN',
        'R3.2_CONSECUTIVE_LOSS_COOLDOWN', 'R3.3_MAX_DRAWDOWN', 'R3.4_MARGIN_LEVEL',
        'R3.4_NOTIONAL_EXPOSURE',
      ]
      for (const code of adjustableRules) {
        await queryRun(`INSERT IGNORE INTO risk_rule_rollouts
          (rule_code, mode, forced_enforce, updated_at) VALUES (?, 'enforce', 0, ?)`, [code, beijingNow()])
      }
    }
  },
  {
    id: '067_manual_inference_snapshots',
    up: async () => {
      await queryRun('ALTER TABLE inference_snapshots MODIFY strategy_id INT DEFAULT NULL')
      await queryRun('ALTER TABLE ai_paired_inference_runs MODIFY strategy_id INT DEFAULT NULL')
    }
  },
  {
    id: '068_inference_preferences',
    up: async () => {
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_inference_preferences (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        session_id VARCHAR(100) NOT NULL DEFAULT 'default',
        system_prompt LONGTEXT DEFAULT NULL,
        enable_auto_trade TINYINT NOT NULL DEFAULT 0,
        enable_futures_trading TINYINT NOT NULL DEFAULT 0,
        risk_level VARCHAR(16) NOT NULL DEFAULT 'medium',
        max_position_size DECIMAL(12,4) NOT NULL DEFAULT 0.05,
        selected_take_profit TINYINT NOT NULL DEFAULT 2,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_inference_preference_user_session (user_id, session_id),
        INDEX idx_inference_preference_updated (user_id, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`INSERT IGNORE INTO ai_inference_preferences
        (user_id, session_id, system_prompt, enable_auto_trade, enable_futures_trading,
         risk_level, max_position_size, selected_take_profit, created_at, updated_at)
        SELECT c.user_id, c.session_id, c.system_prompt, c.enable_auto_trade, c.enable_futures_trading,
          COALESCE(c.risk_level, 'medium'), COALESCE(c.max_position_size, 0.05),
          COALESCE(c.selected_take_profit, 2), COALESCE(c.created_at, ?), COALESCE(c.updated_at, ?)
        FROM ai_configs c
        INNER JOIN (
          SELECT user_id, session_id, MAX(id) AS id
          FROM ai_configs WHERE is_active = 1 GROUP BY user_id, session_id
        ) latest ON latest.id = c.id`, [beijingNow(), beijingNow()])
    }
  },
  {
    id: '069_trading_account_identity_lifecycle',
    up: async () => {
      const columns = [
        ['first_verified_at', 'DATETIME DEFAULT NULL'],
        ['anomaly_code', 'VARCHAR(64) DEFAULT NULL'],
      ]
      for (const [name, definition] of columns) {
        const rows = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_accounts' AND COLUMN_NAME = ?", [name])
        if (!rows.length) await queryRun(`ALTER TABLE trading_accounts ADD COLUMN ${name} ${definition}`)
      }
      await queryRun(`UPDATE trading_accounts
        SET first_verified_at = identity_verified_at
        WHERE first_verified_at IS NULL AND identity_verified_at IS NOT NULL`)
    }
  },
  {
    id: '070_strategy_market_plan_entry_methods',
    up: async () => {
      const columns = [
        ['market_data_plan_json', 'TEXT DEFAULT NULL'],
        ['entry_methods_json', `VARCHAR(255) NOT NULL DEFAULT '["market","limit","stop","stop_limit"]'`],
      ]
      for (const [name, definition] of columns) {
        const rows = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_prompt_types' AND COLUMN_NAME = ?", [name])
        if (!rows.length) await queryRun(`ALTER TABLE auto_prompt_types ADD COLUMN ${name} ${definition}`)
      }
      const strategies = await queryAll('SELECT id, system_prompt, market_data_plan_json FROM auto_prompt_types')
      for (const strategy of strategies) {
        if (strategy.market_data_plan_json) continue
        const timeframes = []
        const seen = new Set()
        const regex = /\{\{[MAC]TF:([A-Za-z0-9]+):(\d+)\}\}/gi
        let match
        while ((match = regex.exec(String(strategy.system_prompt || ''))) !== null) {
          const timeframe = match[1].toUpperCase()
          if (!['M1','M5','M15','M30','H1','H4','D1'].includes(timeframe) || seen.has(timeframe)) continue
          seen.add(timeframe)
          timeframes.push({ timeframe, kline_count: Math.min(500, Math.max(10, Number(match[2]) || 100)) })
        }
        if (!timeframes.length) timeframes.push({ timeframe: 'M30', kline_count: 100 })
        await queryRun('UPDATE auto_prompt_types SET market_data_plan_json = ? WHERE id = ?', [
          JSON.stringify({ primary_timeframe: timeframes[0].timeframe, timeframes }), strategy.id,
        ])
      }
    }
  },
  {
    id: '071_structured_strategy_control_tags',
    up: async () => {
      const chanColumn = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_prompt_types' AND COLUMN_NAME = 'use_chan_analysis'")
      if (!chanColumn.length) await queryRun('ALTER TABLE auto_prompt_types ADD COLUMN use_chan_analysis TINYINT NOT NULL DEFAULT 0')

      const strategies = await queryAll('SELECT id, system_prompt, market_data_plan_json, use_chan_analysis FROM auto_prompt_types')
      for (const strategy of strategies) {
        const prompt = String(strategy.system_prompt || '')
        const tags = []
        const seen = new Set()
        const regex = /\{\{[MAC]TF:([A-Za-z0-9]+):(\d+)\}\}/gi
        let match
        while ((match = regex.exec(prompt)) !== null) {
          const timeframe = match[1].toUpperCase()
          if (!['M1','M5','M15','M30','H1','H4','D1'].includes(timeframe) || seen.has(timeframe)) continue
          seen.add(timeframe)
          tags.push({ timeframe, kline_count: Math.min(500, Math.max(10, Number(match[2]) || 100)) })
        }

        let currentPlan = null
        try { currentPlan = JSON.parse(strategy.market_data_plan_json || 'null') } catch {}
        const currentRows = Array.isArray(currentPlan?.timeframes) ? currentPlan.timeframes : []
        const looksLikeBadLegacyDefault = currentRows.length === 1
          && currentRows[0]?.timeframe === 'M30' && Number(currentRows[0]?.kline_count) === 100
          && currentPlan?.primary_timeframe === 'M30'
        const migratedPlan = tags.length && (!currentRows.length || looksLikeBadLegacyDefault)
          ? { primary_timeframe: tags[0].timeframe, timeframes: tags }
          : currentPlan
        const useChan = Number(strategy.use_chan_analysis) === 1 || /\{\{USE_CHAN\}\}/i.test(prompt)
        const cleanPrompt = prompt
          .replace(/\{\{[MAC]TF:[A-Za-z0-9]+:\d+\}\}/gi, '')
          .replace(/\{\{USE_CHAN\}\}/gi, '')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        await queryRun(
          'UPDATE auto_prompt_types SET system_prompt = ?, market_data_plan_json = ?, use_chan_analysis = ? WHERE id = ?',
          [cleanPrompt, migratedPlan ? JSON.stringify(migratedPlan) : strategy.market_data_plan_json, useChan ? 1 : 0, strategy.id],
        )
      }
    }
  },
  {
    id: '072_subscription_runtime_schedule',
    up: async () => {
      const columns = [
        ['schedule_enabled', 'TINYINT NOT NULL DEFAULT 0'],
        ['schedule_timezone', "VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai'"],
        ['schedule_weekdays_json', "VARCHAR(64) NOT NULL DEFAULT '[1,2,3,4,5]'"],
        ['schedule_windows_json', 'TEXT DEFAULT NULL'],
        ['outside_window_behavior', "VARCHAR(24) NOT NULL DEFAULT 'pause_all'"],
      ]
      for (const [name, definition] of columns) {
        const rows = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'strategy_subscriptions' AND COLUMN_NAME = ?", [name])
        if (!rows.length) await queryRun(`ALTER TABLE strategy_subscriptions ADD COLUMN ${name} ${definition}`)
      }
      await queryRun(`UPDATE strategy_subscriptions
        SET schedule_windows_json = '[{"start":"00:00","end":"23:59"}]'
        WHERE schedule_windows_json IS NULL OR schedule_windows_json = ''`)

      // The compatibility scheduler stores one active strategy per user. Keep
      // the most recently edited subscription active and make the invariant
      // explicit instead of silently ignoring older enabled subscriptions.
      const duplicates = await queryAll(`SELECT user_id FROM strategy_subscriptions
        WHERE execution_enabled = 1 AND is_deleted = 0
        GROUP BY user_id HAVING COUNT(*) > 1`)
      for (const row of duplicates) {
        const active = await queryAll(`SELECT id, strategy_id, symbols_json FROM strategy_subscriptions
          WHERE user_id = ? AND execution_enabled = 1 AND is_deleted = 0
          ORDER BY updated_at DESC, id DESC`, [row.user_id])
        if (active[0]) {
          await queryRun(`UPDATE auto_scheduler SET enabled = 1, prompt_type_id = ?,
            selected_symbols_json = ?, updated_at = NOW() WHERE user_id = ?`,
          [active[0].strategy_id, active[0].symbols_json, row.user_id])
        }
        const disableIds = active.slice(1).map(item => Number(item.id))
        if (disableIds.length) {
          await queryRun(`UPDATE strategy_subscriptions SET execution_enabled = 0
            WHERE id IN (${disableIds.map(() => '?').join(',')})`, disableIds)
        }
      }
    }
  },
  {
    id: '073_subscription_mt5_timezone_default',
    up: async () => {
      // Preserve every saved subscription value; this only changes the
      // database fallback used by newly inserted rows.
      await queryRun(`ALTER TABLE strategy_subscriptions
        MODIFY COLUMN schedule_timezone VARCHAR(64) NOT NULL DEFAULT 'Etc/GMT-3'`)
    }
  },
  {
    id: '074_platform_market_data',
    up: async () => {
      await queryRun(`CREATE TABLE IF NOT EXISTS market_data_sources (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        bridge_user_id BIGINT UNSIGNED NOT NULL,
        broker_server VARCHAR(128) DEFAULT NULL,
        timezone_offset_minutes SMALLINT DEFAULT NULL,
        clock_status VARCHAR(32) NOT NULL DEFAULT 'unknown',
        clock_residual_ms INT DEFAULT NULL,
        last_calibrated_at DATETIME DEFAULT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_market_source_bridge (bridge_user_id),
        INDEX idx_market_source_status (clock_status, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS market_clock_samples (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        source_id BIGINT UNSIGNED NOT NULL,
        raw_tick_time_msc BIGINT DEFAULT NULL,
        normalized_utc_msc BIGINT DEFAULT NULL,
        timezone_offset_minutes SMALLINT DEFAULT NULL,
        residual_ms INT DEFAULT NULL,
        status VARCHAR(32) NOT NULL,
        sampled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_clock_source_time (source_id, sampled_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS market_candles (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        source_id BIGINT UNSIGNED NOT NULL,
        broker_symbol VARCHAR(64) NOT NULL,
        standard_symbol VARCHAR(64) NOT NULL,
        timeframe VARCHAR(8) NOT NULL,
        open_time_utc_msc BIGINT NOT NULL,
        broker_time VARCHAR(32) NOT NULL,
        open_price DECIMAL(24,10) NOT NULL,
        high_price DECIMAL(24,10) NOT NULL,
        low_price DECIMAL(24,10) NOT NULL,
        close_price DECIMAL(24,10) NOT NULL,
        tick_volume BIGINT NOT NULL DEFAULT 0,
        spread INT NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_market_candle (source_id, broker_symbol, timeframe, open_time_utc_msc),
        INDEX idx_market_candle_lookup (source_id, standard_symbol, timeframe, open_time_utc_msc)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '075_market_source_identity',
    up: async () => {
      const accountLoginColumn = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'market_data_sources' AND COLUMN_NAME = 'account_login'")
      if (!accountLoginColumn.length) {
        await queryRun('ALTER TABLE market_data_sources ADD COLUMN account_login BIGINT DEFAULT NULL AFTER broker_server')
      }
      const sourceKeyColumn = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'market_data_sources' AND COLUMN_NAME = 'source_key'")
      if (!sourceKeyColumn.length) {
        await queryRun("ALTER TABLE market_data_sources ADD COLUMN source_key VARCHAR(191) NOT NULL DEFAULT 'legacy' AFTER account_login")
      }
      await queryRun(`UPDATE market_data_sources
        SET source_key = CONCAT(LOWER(COALESCE(NULLIF(broker_server, ''), 'unknown')), '|', COALESCE(account_login, 0))
        WHERE source_key = 'legacy' OR source_key = ''`)
      const oldIndex = await queryAll("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'market_data_sources' AND INDEX_NAME = 'uk_market_source_bridge'")
      if (oldIndex.length) await queryRun('ALTER TABLE market_data_sources DROP INDEX uk_market_source_bridge')
      const identityIndex = await queryAll("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'market_data_sources' AND INDEX_NAME = 'uk_market_source_identity'")
      if (!identityIndex.length) {
        await queryRun('ALTER TABLE market_data_sources ADD UNIQUE INDEX uk_market_source_identity (bridge_user_id, source_key)')
      }
    }
  },
  {
    id: '076_remove_risk_recovery_workflow',
    up: async () => {
      await queryRun('DROP TABLE IF EXISTS risk_recovery_requests')
    }
  },
  {
    id: '077_platform_strategy_experience',
    up: async () => {
      await queryRun(`CREATE TABLE IF NOT EXISTS platform_strategy_experience_items (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        strategy_id BIGINT UNSIGNED NOT NULL,
        review_case_id BIGINT UNSIGNED NOT NULL,
        review_version_id BIGINT UNSIGNED NOT NULL,
        source_admin_user_id BIGINT UNSIGNED NOT NULL,
        lesson_text TEXT NOT NULL,
        context_json TEXT DEFAULT NULL,
        content_hash CHAR(64) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'candidate',
        platform_version INT DEFAULT NULL,
        published_by BIGINT UNSIGNED DEFAULT NULL,
        published_at DATETIME DEFAULT NULL,
        revoked_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_platform_experience_review_version (review_version_id),
        INDEX idx_platform_experience_runtime (strategy_id, status, platform_version),
        INDEX idx_platform_experience_updated (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS platform_strategy_experience_policies (
        strategy_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
        mode VARCHAR(16) NOT NULL DEFAULT 'shadow',
        max_items SMALLINT NOT NULL DEFAULT 5,
        runtime_token_budget SMALLINT NOT NULL DEFAULT 800,
        policy_version INT NOT NULL DEFAULT 1,
        updated_by BIGINT UNSIGNED DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS platform_strategy_experience_logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        strategy_id BIGINT UNSIGNED NOT NULL,
        policy_mode VARCHAR(16) NOT NULL,
        selected_item_ids_json TEXT DEFAULT NULL,
        token_count INT NOT NULL DEFAULT 0,
        symbol VARCHAR(64) DEFAULT NULL,
        timeframe VARCHAR(16) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        INDEX idx_platform_experience_log_strategy (strategy_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      // Platform subscriptions never own user memory. Legacy personal/shared
      // values are collapsed to the fixed platform-managed runtime mode.
      await queryRun(`UPDATE strategy_subscriptions ss
        JOIN auto_prompt_types apt ON apt.id = ss.strategy_id
        SET ss.memory_mode = 'platform_only'
        WHERE apt.scope = 'platform' AND ss.memory_mode <> 'platform_only'`)
      await queryRun(`UPDATE strategy_subscriptions ss
        JOIN auto_prompt_types apt ON apt.id = ss.strategy_id
        SET ss.memory_mode = 'personal'
        WHERE apt.scope = 'private' AND ss.memory_mode NOT IN ('personal','shadow','off')`)

      // The admin identity is an observation/platform-governance identity.
      // Archive legacy admin-owned private strategies and stop their runtime.
      await queryRun(`UPDATE auto_prompt_types apt
        JOIN users u ON u.id = apt.owner_user_id
        SET apt.visibility_status = 'archived', apt.is_active = 0, apt.deleted_at = COALESCE(apt.deleted_at, NOW())
        WHERE apt.scope = 'private' AND u.role = 'admin'`)
      await queryRun(`UPDATE strategy_subscriptions ss
        JOIN auto_prompt_types apt ON apt.id = ss.strategy_id
        JOIN users u ON u.id = apt.owner_user_id
        SET ss.execution_enabled = 0, ss.updated_at = NOW()
        WHERE apt.scope = 'private' AND u.role = 'admin' AND ss.is_deleted = 0`)
      await queryRun(`UPDATE auto_scheduler scheduler
        JOIN auto_prompt_types apt ON apt.id = scheduler.prompt_type_id
        JOIN users u ON u.id = apt.owner_user_id
        SET scheduler.enabled = 0, scheduler.updated_at = NOW()
        WHERE apt.scope = 'private' AND u.role = 'admin'`)
      await queryRun(`UPDATE user_bridge_settings ubs
        JOIN users u ON u.id = ubs.user_id
        SET ubs.auto_reasoning_enabled = 0, ubs.updated_at = NOW()
        WHERE u.role = 'admin'
          AND NOT EXISTS (SELECT 1 FROM strategy_subscriptions ss
            WHERE ss.user_id = u.id AND ss.execution_enabled = 1 AND ss.is_deleted = 0)`)
      await queryRun(`UPDATE user_memory_settings ums JOIN users u ON u.id = ums.user_id
        SET ums.enabled = 0, ums.updated_at = NOW() WHERE u.role = 'admin'`)
      await queryRun(`UPDATE experience_memory_items emi JOIN users u ON u.id = emi.user_id
        SET emi.status = 'revoked', emi.revoked_at = COALESCE(emi.revoked_at, NOW()), emi.updated_at = NOW()
        WHERE u.role = 'admin' AND emi.status <> 'revoked'`)
      await queryRun(`UPDATE experience_memory_summaries ems JOIN users u ON u.id = ems.user_id
        SET ems.status = 'stale', ems.invalidated_at = COALESCE(ems.invalidated_at, NOW())
        WHERE u.role = 'admin' AND ems.status = 'active'`)
      await queryRun(`UPDATE memory_compression_jobs mcj JOIN users u ON u.id = mcj.user_id
        SET mcj.status = 'cancelled', mcj.lease_token = NULL, mcj.lease_expires_at = NULL, mcj.updated_at = NOW()
        WHERE u.role = 'admin' AND mcj.status IN ('queued','leased')`)
    }
  },
  {
    id: '078_incremental_risk_snapshot',
    up: async () => {
      const additions = [
        ['last_deal_time_msc', 'BIGINT NOT NULL DEFAULT 0'],
        ['last_deal_ticket', 'BIGINT NOT NULL DEFAULT 0'],
        ['last_risk_snapshot_at', 'DATETIME DEFAULT NULL'],
        ['data_incomplete_reason', 'VARCHAR(255) DEFAULT NULL'],
      ]
      for (const [name, definition] of additions) {
        const rows = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'risk_account_state' AND COLUMN_NAME = ?`, [name])
        if (!rows.length) await queryRun(`ALTER TABLE risk_account_state ADD COLUMN ${name} ${definition}`)
      }
    }
  },
  {
    id: '079_incremental_risk_snapshot_baseline',
    up: async () => {
      // Existing rows already contain cumulative metrics built by the legacy
      // history snapshot. Start their first cursor at that snapshot boundary
      // so the incremental collector cannot count old deals a second time.
      await queryRun(`UPDATE risk_account_state
        SET last_risk_snapshot_at = updated_at
        WHERE last_risk_snapshot_at IS NULL AND updated_at IS NOT NULL`)
    }
  },
  {
    id: '080_signal_presentation_v2',
    up: async () => {
      const additions = [
        ['schema_version', 'SMALLINT NOT NULL DEFAULT 1'],
        ['decision_json', 'TEXT DEFAULT NULL'],
      ]
      for (const [name, definition] of additions) {
        const rows = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_signals' AND COLUMN_NAME = ?`, [name])
        if (!rows.length) await queryRun(`ALTER TABLE ai_signals ADD COLUMN ${name} ${definition}`)
      }
      const schemas = await queryAll('SELECT id, schema_json FROM ai_signal_schema WHERE is_active = 1')
      for (const row of schemas) {
        let schema
        try { schema = JSON.parse(row.schema_json || '{}') } catch { schema = {} }
        schema.decision_summary = '必填，中文，一句话给出结论，不超过80字；观望时说明为什么暂不执行'
        schema.trigger_condition = '中文，说明建议成立或挂单触发需要满足的市场条件；没有则返回空字符串'
        schema.invalidation_condition = '中文，说明什么市场变化会使建议失效；观望时可说明重新评估条件'
        schema.key_reasons = ['2至4条关键行情依据，每条不超过60字，不包含账户、持仓或风控结论']
        schema.risk_factors = ['0至4条市场层面的不利因素，每条不超过60字，不包含账户或仓位信息']
        await queryRun('UPDATE ai_signal_schema SET schema_json = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(schema, null, 2), row.id])
      }
    }
  },
  {
    id: '081_execution_outcome_repair_and_direction_bias',
    up: async () => {
      const schemas = await queryAll('SELECT id, schema_json FROM ai_signal_schema WHERE is_active = 1')
      for (const row of schemas) {
        let schema
        try { schema = JSON.parse(row.schema_json || '{}') } catch { schema = {} }
        schema.bullish_score = '0-100，市场偏多倾向分；必须与bearish_score合计为100，不代表胜率或执行概率'
        schema.bearish_score = '0-100，市场偏空倾向分；必须与bullish_score合计为100，不代表胜率或执行概率'
        await queryRun('UPDATE ai_signal_schema SET schema_json = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(schema, null, 2), row.id])
      }

      // Repair deliveries where MT5 accepted the order but outcome persistence
      // previously failed after sending. The durable order intent is the source
      // of truth and prevents users from submitting the same signal again.
      await queryRun(`UPDATE auto_signal_deliveries d
        JOIN order_intents oi ON oi.id = d.order_intent_id AND oi.status = 'succeeded'
        SET d.execution_status = 'success',
            d.pending_ticket = COALESCE(d.pending_ticket, oi.pending_ticket),
            d.trade_ticket = COALESCE(d.trade_ticket, oi.trade_ticket),
            d.pending_state = CASE WHEN COALESCE(d.pending_ticket, oi.pending_ticket) IS NOT NULL THEN 'pending' ELSE d.pending_state END,
            d.is_executed = CASE WHEN COALESCE(d.trade_ticket, oi.trade_ticket) IS NOT NULL THEN 1 ELSE d.is_executed END,
            d.execution_result = COALESCE(oi.result_json, d.execution_result)`)

      await queryRun(`INSERT IGNORE INTO signal_outcomes
        (signal_id, delivery_id, order_intent_id, user_id, trading_account_id, margin_mode, symbol,
         entry_order_ticket, pending_ticket, expected_volume, status, attribution_status, created_at, updated_at)
        SELECT CASE WHEN oi.source_id REGEXP '^[0-9]+' THEN CAST(SUBSTRING_INDEX(oi.source_id, ':', 1) AS UNSIGNED) ELSE NULL END,
          d.id, oi.id, oi.user_id, oi.trading_account_id, COALESCE(ta.margin_mode, 'netting'),
          COALESCE(JSON_UNQUOTE(JSON_EXTRACT(COALESCE(oi.approved_order_json, oi.request_json), '$.symbol')), ''),
          COALESCE(oi.pending_ticket, oi.trade_ticket), oi.pending_ticket,
          COALESCE(JSON_EXTRACT(COALESCE(oi.approved_order_json, oi.request_json), '$.volume'), 0),
          'open', 'pending', oi.created_at, NOW()
        FROM order_intents oi
        LEFT JOIN auto_signal_deliveries d ON d.order_intent_id = oi.id
        LEFT JOIN trading_accounts ta ON ta.id = oi.trading_account_id
        LEFT JOIN signal_outcomes so ON so.order_intent_id = oi.id
        WHERE oi.status = 'succeeded' AND oi.user_id IS NOT NULL AND oi.trading_account_id IS NOT NULL AND so.id IS NULL`)
    }
  },
  {
    id: '082_expand_ai_signal_entry_method',
    up: async () => {
      // `stop_limit` is ten characters. The original VARCHAR(8) column made a
      // valid buy_stop_limit/sell_stop_limit signal fail after inference while
      // persisting ai_signals, before it could reach the execution pipeline.
      await queryRun("ALTER TABLE ai_signals MODIFY COLUMN entry_method VARCHAR(20) DEFAULT 'market'")
    }
  },
  {
    id: '083_reject_deterministic_mt5_errors',
    up: async () => {
      const deterministicWhere = `LOWER(COALESCE(oi.error_code, '')) IN
        ('invalid price','invalid stops','invalid volume','invalid expiration','invalid order','market closed','trade disabled','not enough money')`
      await queryRun(`UPDATE auto_signal_deliveries d
        JOIN order_intents oi ON oi.id = d.order_intent_id
        SET d.execution_status = 'rejected',
            d.execution_result = CASE
              WHEN JSON_VALID(d.execution_result) THEN JSON_SET(d.execution_result, '$.status', 'rejected')
              ELSE JSON_OBJECT('status', 'rejected', 'message', oi.error_code)
            END
        WHERE oi.status = 'uncertain' AND oi.trade_ticket IS NULL AND oi.pending_ticket IS NULL AND ${deterministicWhere}`)
      await queryRun(`UPDATE risk_reservations rr
        JOIN order_intents oi ON oi.id = rr.order_intent_id
        SET rr.status = 'released', rr.updated_at = NOW()
        WHERE rr.status = 'active' AND oi.status = 'uncertain' AND oi.trade_ticket IS NULL AND oi.pending_ticket IS NULL AND ${deterministicWhere}`)
      await queryRun(`UPDATE order_intents oi
        SET oi.status = 'rejected',
            oi.result_json = CASE
              WHEN JSON_VALID(oi.result_json) THEN JSON_SET(oi.result_json, '$.status', 'rejected')
              ELSE JSON_OBJECT('status', 'rejected', 'message', oi.error_code)
            END,
            oi.completed_at = COALESCE(oi.completed_at, NOW()), oi.updated_at = NOW()
        WHERE oi.status = 'uncertain' AND oi.trade_ticket IS NULL AND oi.pending_ticket IS NULL AND ${deterministicWhere}`)
    }
  },
  {
    id: '084_explicit_take_profit_selection',
    up: async () => {
      const hasColumn = async (table, column) => {
        const rows = await queryAll(
          'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
          [table, column]
        )
        return rows.length > 0
      }
      if (!await hasColumn('strategy_subscriptions', 'take_profit_mode')) {
        await queryRun("ALTER TABLE strategy_subscriptions ADD COLUMN take_profit_mode VARCHAR(24) NOT NULL DEFAULT 'ai_recommended' AFTER outside_window_behavior")
      }
      if (!await hasColumn('ai_signals', 'recommended_take_profit_tier')) {
        await queryRun('ALTER TABLE ai_signals ADD COLUMN recommended_take_profit_tier TINYINT DEFAULT NULL AFTER take_profit_3_price')
      }
      const schemas = await queryAll('SELECT id, schema_json FROM ai_signal_schema WHERE is_active = 1')
      for (const row of schemas) {
        let schema
        try { schema = JSON.parse(row.schema_json || '{}') } catch { schema = {} }
        schema.recommended_take_profit_tier = '必须字段。非hold仅允许1、2、3，表示AI建议实际执行的止盈目标档位，对应目标价格必须存在；hold返回null。'
        await queryRun('UPDATE ai_signal_schema SET schema_json = ?, updated_at = NOW() WHERE id = ?', [JSON.stringify(schema, null, 2), row.id])
      }
    }
  },
  {
    id: '085_chan_structure_anchors',
    up: async () => {
      await queryRun(`CREATE TABLE IF NOT EXISTS chan_structure_anchors (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        source_id BIGINT UNSIGNED NOT NULL,
        standard_symbol VARCHAR(64) NOT NULL,
        timeframe VARCHAR(8) NOT NULL,
        anchor_time_utc_msc BIGINT NOT NULL,
        last_confirmed_segment_time_utc_msc BIGINT DEFAULT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_chan_structure_anchor (source_id, standard_symbol, timeframe),
        INDEX idx_chan_structure_anchor_time (source_id, anchor_time_utc_msc)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '086_backfill_risk_decision_links',
    up: async () => {
      await queryRun(`UPDATE order_intents oi
        JOIN risk_decisions rd ON rd.order_intent_id = oi.id
        SET oi.risk_decision_id = rd.id, oi.updated_at = NOW()
        WHERE oi.risk_decision_id IS NULL OR oi.risk_decision_id <> rd.id`)
      await queryRun(`UPDATE auto_signal_deliveries d
        JOIN order_intents oi ON oi.id = d.order_intent_id
        SET d.risk_decision_id = oi.risk_decision_id, d.updated_at = NOW()
        WHERE oi.risk_decision_id IS NOT NULL
          AND (d.risk_decision_id IS NULL OR d.risk_decision_id <> oi.risk_decision_id)`)
    }
  },
  {
    id: '087_apply_pending_risk_changes_immediately',
    up: async () => {
      const sets = await queryAll("SELECT DISTINCT policy_set_id FROM risk_policy_change_items WHERE status = 'pending' ORDER BY policy_set_id")
      for (const row of sets) {
        await withTransaction(async run => {
          const [pending] = await run("SELECT * FROM risk_policy_change_items WHERE policy_set_id = ? AND status = 'pending' ORDER BY id FOR UPDATE", [row.policy_set_id])
          if (!pending.length) return
          const [[current]] = await run('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? ORDER BY version_no DESC LIMIT 1 FOR UPDATE', [row.policy_set_id])
          let config = {}
          try { config = JSON.parse(current?.config_json || '{}') } catch { config = {} }
          const values = config.values && typeof config.values === 'object' ? { ...config.values } : { ...config }
          for (const item of pending) {
            try { values[item.field_code] = JSON.parse(item.new_value_json) }
            catch { values[item.field_code] = item.new_value_json }
          }
          const nextConfig = config.values && typeof config.values === 'object' ? { ...config, values } : values
          const now = beijingNow()
          const actorId = Number(pending.at(-1)?.requested_by || current?.created_by || 1)
          const [insert] = await run(`INSERT INTO risk_policy_versions
            (policy_set_id, version_no, config_json, created_by, change_reason, effective_at, created_at)
            VALUES (?, ?, ?, ?, '待生效风控参数改为立即生效', ?, ?)`,
          [row.policy_set_id, Number(current?.version_no || 0) + 1, JSON.stringify(nextConfig), actorId, now, now])
          await run('UPDATE risk_policy_sets SET active_version_id = ?, updated_at = ? WHERE id = ?', [insert.insertId, now, row.policy_set_id])
          await run("UPDATE risk_policy_change_items SET status = 'applied', effective_at = ? WHERE policy_set_id = ? AND status = 'pending'", [now, row.policy_set_id])
        })
      }
    }
  },
  {
    id: '088_review_path_and_tiered_memory',
    up: async () => {
      const addColumn = async (table, name, definition) => {
        const rows = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, name])
        if (!rows.length) await queryRun(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`)
      }
      const addIndex = async (table, name, definition) => {
        const rows = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [table, name])
        if (!rows.length) await queryRun(`CREATE INDEX \`${name}\` ON \`${table}\` (${definition})`)
      }

      await addColumn('trade_review_cases', 'path_evidence_status', "path_evidence_status VARCHAR(24) NOT NULL DEFAULT 'pending' AFTER evidence_hash")
      await addColumn('trade_review_cases', 'path_evidence_reason', 'path_evidence_reason VARCHAR(255) DEFAULT NULL AFTER path_evidence_status')
      await addColumn('trade_review_cases', 'path_evidence_hash', 'path_evidence_hash CHAR(64) DEFAULT NULL AFTER path_evidence_reason')

      await addColumn('experience_memory_items', 'strategy_version', 'strategy_version INT NOT NULL DEFAULT 1 AFTER strategy_id')
      await addColumn('experience_memory_items', 'memory_tier', "memory_tier VARCHAR(16) NOT NULL DEFAULT 'short' AFTER strategy_version")
      await addColumn('experience_memory_items', 'expires_at', 'expires_at DATETIME DEFAULT NULL AFTER confirmed_at')
      await addColumn('experience_memory_items', 'last_matched_at', 'last_matched_at DATETIME DEFAULT NULL AFTER expires_at')
      await addColumn('experience_memory_items', 'match_count', 'match_count INT NOT NULL DEFAULT 0 AFTER last_matched_at')
      await addIndex('experience_memory_items', 'idx_memory_tier_retrieval', 'user_id, status, memory_tier, strategy_id, strategy_version, expires_at')

      await queryRun(`CREATE TABLE IF NOT EXISTS experience_long_term_memories (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL, strategy_id INT NOT NULL, strategy_version INT NOT NULL,
        symbol VARCHAR(64) DEFAULT NULL, timeframe VARCHAR(16) DEFAULT NULL,
        direction VARCHAR(20) DEFAULT NULL, entry_method VARCHAR(32) DEFAULT NULL,
        market_regime VARCHAR(64) DEFAULT NULL,
        source_memory_ids_json LONGTEXT NOT NULL, source_set_hash CHAR(64) NOT NULL,
        summary_text LONGTEXT NOT NULL, conditions_json LONGTEXT NOT NULL,
        confidence DECIMAL(8,6) NOT NULL DEFAULT 0.5, support_count INT NOT NULL DEFAULT 0,
        token_count INT NOT NULL DEFAULT 0, status VARCHAR(24) NOT NULL DEFAULT 'candidate',
        candidate_reason VARCHAR(255) DEFAULT NULL, confirmed_at DATETIME DEFAULT NULL,
        revoked_at DATETIME DEFAULT NULL, last_matched_at DATETIME DEFAULT NULL,
        match_count INT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL, updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_long_memory_source_set (user_id, strategy_id, strategy_version, source_set_hash),
        INDEX idx_long_memory_retrieval (user_id, status, strategy_id, strategy_version, symbol, timeframe, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await addColumn('memory_injection_logs', 'strategy_version', 'strategy_version INT DEFAULT NULL AFTER strategy_id')
      await addColumn('memory_injection_logs', 'selected_long_memory_ids_json', 'selected_long_memory_ids_json TEXT DEFAULT NULL AFTER selected_summary_ids_json')
      await queryRun(`UPDATE experience_memory_items SET memory_tier = 'short', strategy_version = COALESCE(strategy_version, 1)
        WHERE memory_tier IS NULL OR memory_tier = '' OR strategy_version IS NULL`)
    }
  },
  {
    id: '089_period_review_foundation',
    up: async () => {
      await queryRun(`CREATE TABLE IF NOT EXISTS period_review_cases (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        period_type VARCHAR(16) NOT NULL,
        period_key VARCHAR(16) NOT NULL,
        user_id INT NOT NULL,
        trading_account_id INT DEFAULT NULL,
        strategy_id INT NOT NULL,
        strategy_version INT NOT NULL DEFAULT 1,
        strategy_scope VARCHAR(20) NOT NULL,
        timezone_offset_minutes SMALLINT NOT NULL,
        period_start_utc_msc BIGINT NOT NULL,
        period_end_utc_msc BIGINT NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'evidence_pending',
        evidence_status VARCHAR(24) NOT NULL DEFAULT 'pending',
        evidence_reason VARCHAR(255) DEFAULT NULL,
        evidence_json LONGTEXT DEFAULT NULL,
        evidence_hash CHAR(64) DEFAULT NULL,
        source_count INT NOT NULL DEFAULT 0,
        current_version_id BIGINT DEFAULT NULL,
        approved_version_id BIGINT DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_period_review_scope (period_type, period_key, user_id, trading_account_id, strategy_id, strategy_version),
        INDEX idx_period_review_owner (user_id, period_type, status, period_key),
        INDEX idx_period_review_jobs_source (period_type, evidence_status, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS period_review_sources (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        period_case_id BIGINT NOT NULL,
        outcome_id BIGINT NOT NULL,
        trade_review_case_id BIGINT DEFAULT NULL,
        source_hash CHAR(64) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uk_period_review_source (period_case_id, outcome_id),
        INDEX idx_period_review_source_outcome (outcome_id),
        INDEX idx_period_review_source_trade_case (trade_review_case_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS period_review_versions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        period_case_id BIGINT NOT NULL,
        version_no INT NOT NULL,
        parent_version_id BIGINT DEFAULT NULL,
        author_type VARCHAR(16) NOT NULL,
        author_user_id INT DEFAULT NULL,
        content_json LONGTEXT NOT NULL,
        content_hash CHAR(64) NOT NULL,
        change_note VARCHAR(500) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uk_period_review_version (period_case_id, version_no),
        INDEX idx_period_review_version_case (period_case_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS period_review_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        period_case_id BIGINT NOT NULL,
        job_type VARCHAR(24) NOT NULL,
        idempotency_key VARCHAR(191) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'queued',
        attempt_count INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        lease_token CHAR(36) DEFAULT NULL,
        lease_expires_at DATETIME DEFAULT NULL,
        model_profile_id INT DEFAULT NULL,
        credential_source VARCHAR(32) DEFAULT NULL,
        last_error_code VARCHAR(128) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        completed_at DATETIME DEFAULT NULL,
        UNIQUE KEY uk_period_review_job_key (idempotency_key),
        INDEX idx_period_review_job_claim (job_type, status, lease_expires_at, updated_at),
        INDEX idx_period_review_job_case (period_case_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '090_monthly_review_sources',
    up: async () => {
      const addColumn = async (table, name, definition) => {
        const rows = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, name])
        if (!rows.length) await queryRun(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`)
      }
      const addIndex = async (table, name, definition, unique = false) => {
        const rows = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [table, name])
        if (!rows.length) await queryRun(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` ON \`${table}\` (${definition})`)
      }
      await queryRun(`ALTER TABLE period_review_sources MODIFY outcome_id BIGINT DEFAULT NULL`)
      await addColumn('period_review_sources', 'source_period_case_id', 'source_period_case_id BIGINT DEFAULT NULL AFTER trade_review_case_id')
      await addIndex('period_review_sources', 'uk_period_review_period_source', 'period_case_id, source_period_case_id', true)
      await addIndex('period_review_sources', 'idx_period_review_source_period', 'source_period_case_id')
    }
  },
  {
    id: '091_period_review_memory_lineage',
    up: async () => {
      const addColumn = async (table, name, definition) => {
        const rows = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, name])
        if (!rows.length) await queryRun(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`)
      }
      const addIndex = async (table, name, definition, unique = false) => {
        const rows = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [table, name])
        if (!rows.length) await queryRun(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` ON \`${table}\` (${definition})`)
      }
      await queryRun('ALTER TABLE experience_memory_items MODIFY review_case_id BIGINT DEFAULT NULL')
      await queryRun('ALTER TABLE experience_memory_items MODIFY review_version_id BIGINT DEFAULT NULL')
      await addColumn('experience_memory_items', 'period_review_case_id', 'period_review_case_id BIGINT DEFAULT NULL AFTER review_version_id')
      await addColumn('experience_memory_items', 'period_review_version_id', 'period_review_version_id BIGINT DEFAULT NULL AFTER period_review_case_id')
      await addColumn('experience_memory_items', 'period_key', 'period_key VARCHAR(16) DEFAULT NULL AFTER period_review_version_id')
      await addIndex('experience_memory_items', 'uk_memory_period_review_version', 'period_review_version_id', true)
      await addIndex('experience_memory_items', 'idx_memory_period_review_case', 'period_review_case_id')

      await addColumn('experience_memory_summaries', 'period_review_case_id', 'period_review_case_id BIGINT DEFAULT NULL AFTER scope_key')
      await addColumn('experience_memory_summaries', 'period_review_version_id', 'period_review_version_id BIGINT DEFAULT NULL AFTER period_review_case_id')
      await addColumn('experience_memory_summaries', 'period_key', 'period_key VARCHAR(16) DEFAULT NULL AFTER period_review_version_id')
      await addIndex('experience_memory_summaries', 'uk_memory_summary_period_review', 'period_review_version_id', true)

      await addColumn('experience_long_term_memories', 'period_review_case_id', 'period_review_case_id BIGINT DEFAULT NULL AFTER strategy_version')
      await addColumn('experience_long_term_memories', 'period_review_version_id', 'period_review_version_id BIGINT DEFAULT NULL AFTER period_review_case_id')
      await addColumn('experience_long_term_memories', 'period_key', 'period_key VARCHAR(16) DEFAULT NULL AFTER period_review_version_id')
      await addIndex('experience_long_term_memories', 'idx_long_memory_period_review', 'period_review_case_id')
    }
  },
  {
    id: '092_platform_period_experience_lineage',
    up: async () => {
      const addColumn = async (table, name, definition) => {
        const rows = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, name])
        if (!rows.length) await queryRun(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`)
      }
      const addIndex = async (table, name, definition, unique = false) => {
        const rows = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [table, name])
        if (!rows.length) await queryRun(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` ON \`${table}\` (${definition})`)
      }
      await queryRun('ALTER TABLE platform_strategy_experience_items MODIFY review_case_id BIGINT UNSIGNED DEFAULT NULL')
      await queryRun('ALTER TABLE platform_strategy_experience_items MODIFY review_version_id BIGINT UNSIGNED DEFAULT NULL')
      await addColumn('platform_strategy_experience_items', 'period_review_case_id', 'period_review_case_id BIGINT DEFAULT NULL AFTER review_version_id')
      await addColumn('platform_strategy_experience_items', 'period_review_version_id', 'period_review_version_id BIGINT DEFAULT NULL AFTER period_review_case_id')
      await addColumn('platform_strategy_experience_items', 'period_key', 'period_key VARCHAR(16) DEFAULT NULL AFTER period_review_version_id')
      await addIndex('platform_strategy_experience_items', 'uk_platform_experience_period_version', 'period_review_version_id', true)
    }
  },
  {
    id: '093_period_review_single_job_slot',
    up: async () => {
      const columns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'period_review_jobs' AND COLUMN_NAME = 'job_slot'`)
      if (!columns.length) await queryRun('ALTER TABLE period_review_jobs ADD COLUMN job_slot BIGINT NOT NULL DEFAULT 0 AFTER job_type')
      await queryRun(`UPDATE period_review_jobs jobs
        JOIN (SELECT period_case_id, job_type, MIN(id) AS keep_id FROM period_review_jobs GROUP BY period_case_id, job_type HAVING COUNT(*) > 1) duplicates
          ON duplicates.period_case_id = jobs.period_case_id AND duplicates.job_type = jobs.job_type
        SET jobs.job_slot = jobs.id, jobs.status = 'superseded', jobs.lease_token = NULL, jobs.lease_expires_at = NULL,
          jobs.last_error_code = 'duplicate_job_superseded', jobs.updated_at = ?
        WHERE jobs.id <> duplicates.keep_id`, [beijingNow()])
      const indexes = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'period_review_jobs' AND INDEX_NAME = 'uk_period_review_case_job_slot'`)
      if (!indexes.length) await queryRun(`CREATE UNIQUE INDEX uk_period_review_case_job_slot
        ON period_review_jobs (period_case_id, job_type, job_slot)`)
    }
  },
  {
    id: '094_period_review_retry_backoff',
    up: async () => {
      const columns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'period_review_jobs' AND COLUMN_NAME = 'next_attempt_at'`)
      if (!columns.length) await queryRun('ALTER TABLE period_review_jobs ADD COLUMN next_attempt_at DATETIME DEFAULT NULL AFTER lease_expires_at')
      const indexes = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'period_review_jobs' AND INDEX_NAME = 'idx_period_review_retry'`)
      if (!indexes.length) await queryRun('CREATE INDEX idx_period_review_retry ON period_review_jobs (job_type, status, next_attempt_at)')
    }
  },
  {
    id: '095_period_review_failed_state_repair',
    up: async () => {
      await queryRun(`UPDATE period_review_cases cases JOIN period_review_jobs jobs
        ON jobs.period_case_id = cases.id AND jobs.job_slot = 0
        SET cases.status = 'failed', cases.updated_at = ?
        WHERE jobs.status = 'failed' AND cases.current_version_id IS NULL AND cases.status <> 'failed'`, [beijingNow()])
    }
  },
  {
    id: '096_period_review_observability',
    up: async () => {
      const jobColumns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'period_review_jobs'
          AND COLUMN_NAME IN ('progress_stage', 'stage_updated_at')`)
      const existing = new Set(jobColumns.map(row => row.COLUMN_NAME))
      if (!existing.has('progress_stage')) await queryRun("ALTER TABLE period_review_jobs ADD COLUMN progress_stage VARCHAR(32) NOT NULL DEFAULT 'queued' AFTER status")
      if (!existing.has('stage_updated_at')) await queryRun('ALTER TABLE period_review_jobs ADD COLUMN stage_updated_at DATETIME DEFAULT NULL AFTER progress_stage')
      await queryRun(`CREATE TABLE IF NOT EXISTS period_review_job_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_id BIGINT NOT NULL,
        period_case_id BIGINT NOT NULL,
        attempt_no INT NOT NULL DEFAULT 0,
        stage VARCHAR(32) NOT NULL,
        event_status VARCHAR(16) NOT NULL DEFAULT 'info',
        message_code VARCHAR(128) DEFAULT NULL,
        metadata_json JSON DEFAULT NULL,
        created_at DATETIME NOT NULL,
        INDEX idx_period_review_events_job (job_id, id),
        INDEX idx_period_review_events_case (period_case_id, id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS period_review_user_states (
        period_case_id BIGINT NOT NULL,
        user_id INT NOT NULL,
        last_seen_version_id BIGINT DEFAULT NULL,
        first_seen_at DATETIME DEFAULT NULL,
        last_seen_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (period_case_id, user_id),
        INDEX idx_period_review_user_states_user (user_id, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`UPDATE period_review_jobs SET progress_stage = CASE
        WHEN status = 'failed' THEN 'failed'
        WHEN status = 'succeeded' THEN 'succeeded'
        WHEN status = 'leased' THEN 'model_request'
        WHEN status = 'queued' AND next_attempt_at IS NOT NULL THEN 'retry_wait'
        ELSE 'queued' END
        WHERE stage_updated_at IS NULL`)
    }
  },
  {
    id: '097_platform_experience_retrieval_evidence',
    up: async () => {
      const columns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_strategy_experience_logs'
          AND COLUMN_NAME IN ('retrieval_context_json', 'selection_details_json')`)
      const existing = new Set(columns.map(row => row.COLUMN_NAME))
      if (!existing.has('retrieval_context_json')) await queryRun(`ALTER TABLE platform_strategy_experience_logs
        ADD COLUMN retrieval_context_json JSON DEFAULT NULL AFTER timeframe`)
      if (!existing.has('selection_details_json')) await queryRun(`ALTER TABLE platform_strategy_experience_logs
        ADD COLUMN selection_details_json JSON DEFAULT NULL AFTER retrieval_context_json`)
    }
  },
  {
    id: '098_ai_runtime_active_uniqueness',
    up: async () => {
      const duplicateDefaults = await queryAll(`SELECT owner_user_id FROM ai_model_profiles
        WHERE is_default = 1 AND status = 'active' AND deleted_at IS NULL
        GROUP BY owner_user_id HAVING COUNT(*) > 1`)
      for (const row of duplicateDefaults) {
        const profiles = await queryAll(`SELECT id FROM ai_model_profiles
          WHERE owner_user_id = ? AND is_default = 1 AND status = 'active' AND deleted_at IS NULL
          ORDER BY updated_at DESC, id DESC`, [row.owner_user_id])
        const staleIds = profiles.slice(1).map(profile => Number(profile.id))
        if (staleIds.length) await queryRun(`UPDATE ai_model_profiles SET is_default = 0
          WHERE id IN (${staleIds.map(() => '?').join(',')})`, staleIds)
      }

      const duplicateSubscriptions = await queryAll(`SELECT user_id FROM strategy_subscriptions
        WHERE execution_enabled = 1 AND is_deleted = 0
        GROUP BY user_id HAVING COUNT(*) > 1`)
      for (const row of duplicateSubscriptions) {
        const subscriptions = await queryAll(`SELECT id FROM strategy_subscriptions
          WHERE user_id = ? AND execution_enabled = 1 AND is_deleted = 0
          ORDER BY updated_at DESC, id DESC`, [row.user_id])
        const staleIds = subscriptions.slice(1).map(subscription => Number(subscription.id))
        if (staleIds.length) await queryRun(`UPDATE strategy_subscriptions SET execution_enabled = 0
          WHERE id IN (${staleIds.map(() => '?').join(',')})`, staleIds)
      }

      const modelColumns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_model_profiles'
          AND COLUMN_NAME = 'active_default_owner_key'`)
      if (!modelColumns.length) await queryRun(`ALTER TABLE ai_model_profiles
        ADD COLUMN active_default_owner_key INT GENERATED ALWAYS AS
          (CASE WHEN is_default = 1 AND status = 'active' AND deleted_at IS NULL THEN owner_user_id ELSE NULL END) STORED INVISIBLE`)
      const modelIndexes = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_model_profiles'
          AND INDEX_NAME = 'uk_model_active_default_owner'`)
      if (!modelIndexes.length) await queryRun(`CREATE UNIQUE INDEX uk_model_active_default_owner
        ON ai_model_profiles (active_default_owner_key)`)

      const subscriptionColumns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'strategy_subscriptions'
          AND COLUMN_NAME = 'active_execution_user_key'`)
      if (!subscriptionColumns.length) await queryRun(`ALTER TABLE strategy_subscriptions
        ADD COLUMN active_execution_user_key INT GENERATED ALWAYS AS
          (CASE WHEN execution_enabled = 1 AND is_deleted = 0 THEN user_id ELSE NULL END) STORED INVISIBLE`)
      const subscriptionIndexes = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'strategy_subscriptions'
          AND INDEX_NAME = 'uk_subscription_active_execution_user'`)
      if (!subscriptionIndexes.length) await queryRun(`CREATE UNIQUE INDEX uk_subscription_active_execution_user
        ON strategy_subscriptions (active_execution_user_key)`)
    }
  },
  {
    id: '099_cleanup_orphan_inference_artifacts',
    up: async () => {
      await queryRun(`DELETE paired FROM ai_paired_inference_runs paired
        LEFT JOIN ai_signals signal_row ON signal_row.id = paired.signal_id
        WHERE paired.signal_id IS NOT NULL AND signal_row.id IS NULL`)
      await queryRun(`DELETE memory_log FROM memory_injection_logs memory_log
        LEFT JOIN ai_signals signal_row ON signal_row.id = memory_log.signal_id
        WHERE memory_log.signal_id IS NOT NULL AND signal_row.id IS NULL`)
      await queryRun(`DELETE snapshot_row FROM inference_snapshots snapshot_row
        LEFT JOIN ai_signals signal_row ON signal_row.id = snapshot_row.signal_id
        LEFT JOIN signal_outcomes outcome_row ON outcome_row.signal_id = snapshot_row.signal_id
        LEFT JOIN trade_review_cases review_row ON review_row.signal_id = snapshot_row.signal_id
        WHERE snapshot_row.signal_id IS NOT NULL AND signal_row.id IS NULL
          AND outcome_row.id IS NULL AND review_row.id IS NULL`)
    }
  },
  {
    id: '100_remove_account_review_gate',
    up: async () => {
      await queryRun(`UPDATE trading_accounts SET review_status = 'approved',
        observe_status = CASE
          WHEN anomaly_code = 'admin_rejected' AND identity_verified_at IS NULL THEN 'unverified'
          WHEN anomaly_code = 'admin_rejected' AND observed_until > NOW() THEN 'observing'
          WHEN anomaly_code = 'admin_rejected' THEN 'active'
          ELSE observe_status
        END,
        anomaly_code = CASE WHEN anomaly_code = 'admin_rejected' THEN NULL ELSE anomaly_code END,
        updated_at = NOW()
        WHERE is_deleted = 0 AND (review_status <> 'approved' OR anomaly_code = 'admin_rejected')`)
    }
  },
  {
    id: '101_period_review_derivation_jobs',
    up: async () => {
      await queryRun(`CREATE TABLE IF NOT EXISTS period_review_derivation_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        period_case_id BIGINT NOT NULL,
        period_version_id BIGINT NOT NULL,
        user_id INT NOT NULL,
        target_type VARCHAR(32) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'queued',
        attempt_count INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 5,
        next_attempt_at DATETIME DEFAULT NULL,
        lease_token VARCHAR(64) DEFAULT NULL,
        lease_expires_at DATETIME DEFAULT NULL,
        last_error_code VARCHAR(128) DEFAULT NULL,
        completed_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_period_review_derivation (period_case_id, period_version_id, target_type),
        INDEX idx_period_review_derivation_claim (status, next_attempt_at, lease_expires_at, updated_at),
        INDEX idx_period_review_derivation_user (user_id, status, updated_at)
      )`)
      await queryRun(`INSERT IGNORE INTO period_review_derivation_jobs
        (period_case_id, period_version_id, user_id, target_type, status, attempt_count, max_attempts, completed_at, created_at, updated_at)
        SELECT cases.id, cases.approved_version_id, cases.user_id,
          CASE WHEN cases.strategy_scope = 'platform' THEN 'platform_experience' ELSE 'personal_memory' END,
          CASE
            WHEN cases.strategy_scope = 'platform' AND platform_item.id IS NOT NULL THEN 'succeeded'
            WHEN cases.strategy_scope = 'private' AND (memory_item.id IS NOT NULL OR memory_summary.id IS NOT NULL) THEN 'succeeded'
            ELSE 'queued'
          END,
          0, 5,
          CASE
            WHEN cases.strategy_scope = 'platform' AND platform_item.id IS NOT NULL THEN NOW()
            WHEN cases.strategy_scope = 'private' AND (memory_item.id IS NOT NULL OR memory_summary.id IS NOT NULL) THEN NOW()
            ELSE NULL
          END,
          NOW(), NOW()
        FROM period_review_cases cases
        LEFT JOIN platform_strategy_experience_items platform_item ON platform_item.period_review_version_id = cases.approved_version_id
        LEFT JOIN experience_memory_items memory_item ON memory_item.period_review_version_id = cases.approved_version_id
        LEFT JOIN experience_memory_summaries memory_summary ON memory_summary.period_review_version_id = cases.approved_version_id
        WHERE cases.status = 'approved' AND cases.approved_version_id IS NOT NULL`)
    }
  },
  {
    id: '102_disable_legacy_trade_review_generation',
    up: async () => {
      await queryRun(`UPDATE trade_review_jobs SET status = 'skipped',
        last_error_code = 'legacy_trade_review_disabled', lease_token = NULL,
        lease_expires_at = NULL, updated_at = NOW()
        WHERE status IN ('queued','leased')`)
      await queryRun(`UPDATE trade_review_cases SET
        status = CASE WHEN evidence_status = 'complete' THEN 'ready' ELSE 'incomplete' END,
        updated_at = NOW()
        WHERE status = 'generating' AND current_version_id IS NULL`)
    }
  },
  {
    id: '103_private_strategy_portfolio_context',
    up: async () => {
      const columns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_prompt_types'
          AND COLUMN_NAME = 'include_portfolio_context'`)
      if (!columns.length) await queryRun(`ALTER TABLE auto_prompt_types
        ADD COLUMN include_portfolio_context TINYINT NOT NULL DEFAULT 0 AFTER use_chan_analysis`)
      await queryRun(`UPDATE auto_prompt_types SET include_portfolio_context = 0
        WHERE scope = 'platform' AND include_portfolio_context <> 0`)
    }
  },
  {
    id: '105_add_model_profile_timeout',
    async up() {
      const cols = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_model_profiles' AND COLUMN_NAME = 'request_timeout_ms'`)
      if (!cols.length) {
        await queryRun(`ALTER TABLE ai_model_profiles ADD COLUMN request_timeout_ms INT DEFAULT NULL AFTER reasoning_effort`)
        console.log('[Migrations] 105 added request_timeout_ms to ai_model_profiles')
      }
    }
  },
  {
    id: '106_disable_smart_close_runtime',
    async up() {
      await queryRun('UPDATE close_config SET enabled = 0 WHERE enabled <> 0')
    }
  },
  {
    id: '107_model_compare_job_history',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_model_compare_jobs (
        id CHAR(36) PRIMARY KEY,
        user_id INT NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'queued',
        stage VARCHAR(32) NOT NULL DEFAULT 'queued',
        progress_percent INT NOT NULL DEFAULT 0,
        completed_steps INT NOT NULL DEFAULT 0,
        total_steps INT NOT NULL DEFAULT 0,
        params_json LONGTEXT NOT NULL,
        result_json LONGTEXT DEFAULT NULL,
        error_code VARCHAR(255) DEFAULT NULL,
        cancel_requested TINYINT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        completed_at DATETIME DEFAULT NULL,
        INDEX idx_model_compare_user_created (user_id, created_at),
        INDEX idx_model_compare_status_updated (status, updated_at)
      )`)
    }
  },
  {
    id: '108_review_compacted_snapshot_evidence',
    async up() {
      await queryRun(`UPDATE inference_snapshots SET evidence_status = 'complete'
        WHERE evidence_status = 'incomplete'
          AND JSON_VALID(omitted_fields_json)
          AND JSON_LENGTH(omitted_fields_json) = 1
          AND JSON_CONTAINS(omitted_fields_json, JSON_QUOTE('klines_before_retained_window'))
          AND system_prompt NOT LIKE '[evidence omitted;%'
          AND user_prompt NOT LIKE '[evidence omitted;%'
          AND market_snapshot_json NOT LIKE '%"evidence_ref"%'`)
      await queryRun(`UPDATE trade_review_cases review_case
        JOIN inference_snapshots snap ON snap.signal_id = review_case.signal_id
        SET review_case.status = 'evidence_pending', review_case.evidence_status = 'pending',
          review_case.evidence_reason = 'evidence_rebuild_required', review_case.updated_at = NOW()
        WHERE review_case.current_version_id IS NULL
          AND review_case.evidence_reason LIKE '%inference_snapshot_incomplete%'
          AND snap.evidence_status = 'complete'`)
      await queryRun(`UPDATE period_review_cases period_case
        SET period_case.status = 'evidence_pending', period_case.evidence_status = 'pending',
          period_case.evidence_reason = 'evidence_rebuild_required', period_case.updated_at = NOW()
        WHERE period_case.current_version_id IS NULL
          AND EXISTS (SELECT 1 FROM period_review_sources source
            JOIN trade_review_cases review_case ON review_case.id = source.trade_review_case_id
            WHERE source.period_case_id = period_case.id
              AND review_case.evidence_reason = 'evidence_rebuild_required')`)
    }
  },
  {
    id: '109_review_compacted_snapshot_followup',
    async up() {
      // A running old process may still write a legacy classification between
      // migration 108 and the deployment restart. Reconcile that narrow race;
      // new snapshots are classified correctly by prepareInferenceSnapshot.
      await queryRun(`UPDATE inference_snapshots SET evidence_status = 'complete'
        WHERE evidence_status = 'incomplete'
          AND JSON_VALID(omitted_fields_json)
          AND JSON_LENGTH(omitted_fields_json) = 1
          AND JSON_CONTAINS(omitted_fields_json, JSON_QUOTE('klines_before_retained_window'))`)
      await queryRun(`UPDATE trade_review_cases review_case
        JOIN inference_snapshots snap ON snap.signal_id = review_case.signal_id
        SET review_case.status = 'evidence_pending', review_case.evidence_status = 'pending',
          review_case.evidence_reason = 'evidence_rebuild_required', review_case.updated_at = NOW()
        WHERE review_case.current_version_id IS NULL
          AND review_case.evidence_reason LIKE '%inference_snapshot_incomplete%'
          AND snap.evidence_status = 'complete'`)
    }
  },
  {
    id: '110_model_compare_benchmarks',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_market_benchmark_sets (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        set_code VARCHAR(96) NOT NULL,
        name VARCHAR(160) NOT NULL,
        version INT NOT NULL DEFAULT 1,
        symbol VARCHAR(32) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'active',
        description VARCHAR(500) DEFAULT NULL,
        case_count INT NOT NULL DEFAULT 0,
        selection_config_json LONGTEXT DEFAULT NULL,
        fingerprint CHAR(64) NOT NULL,
        created_by INT NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_market_benchmark_version (set_code, version),
        INDEX idx_market_benchmark_symbol_status (symbol, status, version)
      )`)
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_market_benchmark_cases (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        benchmark_set_id BIGINT NOT NULL,
        case_key VARCHAR(128) NOT NULL,
        title VARCHAR(160) NOT NULL,
        regime_type VARCHAR(40) NOT NULL,
        start_time_utc_msc BIGINT NOT NULL,
        decision_time_utc_msc BIGINT NOT NULL,
        end_time_utc_msc BIGINT NOT NULL,
        tags_json LONGTEXT DEFAULT NULL,
        metrics_json LONGTEXT DEFAULT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uk_market_benchmark_case (benchmark_set_id, case_key),
        INDEX idx_market_benchmark_case_time (benchmark_set_id, decision_time_utc_msc),
        CONSTRAINT fk_market_benchmark_case_set FOREIGN KEY (benchmark_set_id)
          REFERENCES ai_market_benchmark_sets(id) ON DELETE CASCADE
      )`)
    }
  },
  {
    id: '111_simplify_risk_policy_boundaries',
    async up() {
      const sets = await queryAll("SELECT id FROM risk_policy_sets WHERE scope = 'platform' AND status = 'active' ORDER BY id LIMIT 1")
      if (sets[0]) {
        const versions = await queryAll('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? ORDER BY version_no DESC LIMIT 1', [sets[0].id])
        let raw = {}
        try { raw = versions[0]?.config_json ? JSON.parse(versions[0].config_json) : {} } catch {}
        const values = {
          ...(raw.values || raw.defaults || raw),
          sl_atr_max:4, min_rr:1.1, pending_price_deviation_pct:1, pending_price_deviation_atr:2,
          pending_valid_minutes:180, max_position_size:0.05, max_risk_per_trade_pct:1,
          signal_ttl_seconds:300, max_quote_age_seconds:15, max_spread_points:120,
          market_signal_drift_atr:0.5, broker_slippage_points:30, weekend_close_minutes:60,
          max_directional_exposure_lots:0.1, min_open_interval_seconds:30, max_daily_open_count:20,
          dedup_window_seconds:180, dedup_price_atr:0.05, daily_loss_limit_pct:3,
          consecutive_loss_limit:3, loss_cooldown_minutes:60, max_drawdown_pct:8,
          min_margin_level_pct:300,
        }
        for (const key of ['sl_atr_min','ai_volume_min','ai_volume_max','ai_volume_step','max_notional_exposure_pct','observation_hours','observation_max_lot']) delete values[key]
        const controls = {
          sl_atr_max:{ allowed_min:0.5, allowed_max:4, locked_value:null, user_editable:true },
          min_rr:{ allowed_min:1.1, allowed_max:10, locked_value:null, user_editable:true },
          pending_price_deviation_pct:{ allowed_min:0.01, allowed_max:1, locked_value:null, user_editable:true },
          pending_price_deviation_atr:{ allowed_min:0.1, allowed_max:2, locked_value:null, user_editable:true },
          pending_valid_minutes:{ allowed_min:5, allowed_max:180, locked_value:null, user_editable:true },
          max_position_size:{ allowed_min:0.001, allowed_max:0.05, locked_value:null, user_editable:true },
          max_risk_per_trade_pct:{ allowed_min:0.01, allowed_max:1, locked_value:null, user_editable:true },
          max_spread_points:{ allowed_min:1, allowed_max:120, locked_value:null, user_editable:true },
          market_signal_drift_atr:{ allowed_min:0.01, allowed_max:0.5, locked_value:null, user_editable:true },
          broker_slippage_points:{ allowed_min:0, allowed_max:30, locked_value:null, user_editable:true },
          weekend_close_minutes:{ allowed_min:60, allowed_max:2880, locked_value:null, user_editable:true },
          max_directional_exposure_lots:{ allowed_min:0.001, allowed_max:0.1, locked_value:null, user_editable:true },
          min_open_interval_seconds:{ allowed_min:30, allowed_max:86400, locked_value:null, user_editable:true },
          max_daily_open_count:{ allowed_min:1, allowed_max:20, locked_value:null, user_editable:true },
          daily_loss_limit_pct:{ allowed_min:0.1, allowed_max:3, locked_value:null, user_editable:true },
          consecutive_loss_limit:{ allowed_min:1, allowed_max:3, locked_value:null, user_editable:true },
          loss_cooldown_minutes:{ allowed_min:60, allowed_max:10080, locked_value:null, user_editable:true },
          max_drawdown_pct:{ allowed_min:0.1, allowed_max:8, locked_value:null, user_editable:true },
          min_margin_level_pct:{ allowed_min:300, allowed_max:100000, locked_value:null, user_editable:true },
        }
        const now = new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
        const nextVersion = Number(versions[0]?.version_no || 0) + 1
        const inserted = await queryRun(`INSERT INTO risk_policy_versions
          (policy_set_id, version_no, config_json, created_by, change_reason, effective_at, created_at)
          VALUES (?, ?, ?, 0, '风控规则分层与默认值优化', ?, ?)`,
        [sets[0].id, nextVersion, JSON.stringify({ values, controls }), now, now])
        await queryRun('UPDATE risk_policy_sets SET active_version_id = ?, updated_at = ? WHERE id = ?', [inserted.insertId, now, sets[0].id])
      }
      await queryRun("DELETE FROM risk_rule_rollouts WHERE rule_code IN ('account_review','R3.4_NOTIONAL_EXPOSURE')")
      await queryRun("UPDATE trading_accounts SET observe_status = 'active', observed_until = NULL WHERE observe_status = 'observing'")
      await queryRun(`INSERT INTO risk_rule_rollouts (rule_code, mode, forced_enforce, updated_at)
        VALUES ('R3.4_PROJECTED_MARGIN_LEVEL', 'enforce', 0, NOW())
        ON DUPLICATE KEY UPDATE mode = VALUES(mode), forced_enforce = VALUES(forced_enforce), updated_at = VALUES(updated_at)`)
    }
  },
  {
    id: '112_unify_execution_price_deviation',
    async up() {
      const sets = await queryAll("SELECT id, scope FROM risk_policy_sets WHERE status = 'active' ORDER BY id")
      const now = new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
      const retiredKeys = ['pending_price_deviation_pct','pending_price_deviation_atr','market_signal_drift_atr','broker_slippage_points']
      for (const set of sets) {
        const [latest] = await queryAll('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? ORDER BY version_no DESC LIMIT 1', [set.id])
        if (!latest) continue
        let raw = {}
        try { raw = latest.config_json ? JSON.parse(latest.config_json) : {} } catch {}
        const wrapped = Boolean(raw.values || raw.defaults || raw.controls)
        const values = { ...(raw.values || raw.defaults || raw) }
        const controls = { ...(raw.controls || {}) }
        for (const key of retiredKeys) { delete values[key]; delete controls[key] }
        if (set.scope === 'platform') {
          values.max_execution_price_deviation_pct = 0.1
          controls.max_execution_price_deviation_pct = {
            allowed_min:0.001, allowed_max:0.1, locked_value:null, user_editable:true,
          }
        }
        const config = wrapped ? { ...raw, values, controls } : values
        const inserted = await queryRun(`INSERT INTO risk_policy_versions
          (policy_set_id, version_no, config_json, created_by, change_reason, effective_at, created_at)
          VALUES (?, ?, ?, 0, '统一执行价格偏差为百分比', ?, ?)`,
        [set.id, Number(latest.version_no || 0) + 1, JSON.stringify(config), now, now])
        await queryRun('UPDATE risk_policy_sets SET active_version_id = ?, updated_at = ? WHERE id = ?', [inserted.insertId, now, set.id])
      }
      await queryRun("DELETE FROM risk_rule_rollouts WHERE rule_code IN ('R1.7_PENDING_DEVIATION','R4.6_MARKET_SIGNAL_DRIFT','PX.3_BROKER_SLIPPAGE')")
      await queryRun(`INSERT INTO risk_rule_rollouts (rule_code, mode, forced_enforce, updated_at)
        VALUES ('R4.6_EXECUTION_PRICE_DEVIATION', 'enforce', 0, NOW())
        ON DUPLICATE KEY UPDATE mode = VALUES(mode), forced_enforce = VALUES(forced_enforce), updated_at = VALUES(updated_at)`)
    }
  },
  {
    id: '113_retire_redundant_risk_rules',
    async up() {
      const retiredKeys = ['sl_atr_max','min_rr','max_directional_exposure_lots','min_margin_level_pct']
      const sets = await queryAll("SELECT id FROM risk_policy_sets WHERE status = 'active' ORDER BY id")
      const now = new Date(Date.now() + 8 * 3600_000).toISOString().replace('T', ' ').slice(0, 19)
      for (const set of sets) {
        const [latest] = await queryAll('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? ORDER BY version_no DESC LIMIT 1', [set.id])
        if (!latest) continue
        let raw = {}
        try { raw = latest.config_json ? JSON.parse(latest.config_json) : {} } catch {}
        const wrapped = Boolean(raw.values || raw.defaults || raw.controls)
        const values = { ...(raw.values || raw.defaults || raw) }
        const defaults = { ...(raw.defaults || {}) }
        const controls = { ...(raw.controls || {}) }
        const cleanedRaw = { ...raw }
        for (const key of retiredKeys) {
          delete values[key]
          delete defaults[key]
          delete controls[key]
          delete cleanedRaw[key]
        }
        const config = wrapped
          ? { ...cleanedRaw, ...(raw.defaults ? { defaults } : {}), values, controls }
          : values
        const inserted = await queryRun(`INSERT INTO risk_policy_versions
          (policy_set_id, version_no, config_json, created_by, change_reason, effective_at, created_at)
          VALUES (?, ?, ?, 0, '移除冗余风控规则', ?, ?)`,
        [set.id, Number(latest.version_no || 0) + 1, JSON.stringify(config), now, now])
        await queryRun('UPDATE risk_policy_sets SET active_version_id = ?, updated_at = ? WHERE id = ?', [inserted.insertId, now, set.id])
      }
      await queryRun(`DELETE FROM risk_rule_rollouts WHERE rule_code IN (
        'R1.4_STOP_LOSS_TOO_FAR','R1.5_RR_TOO_LOW','R1.5_TP_TIER_UPGRADED',
        'R2.1_DIRECTIONAL_EXPOSURE','R3.4_MARGIN_LEVEL','R3.4_MARGIN_DATA_INCOMPLETE',
        'R3.4_PROJECTED_MARGIN_LEVEL'
      )`)
    }
  },
  {
    id: '114_platform_tiered_memory',
    async up() {
      const columns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_strategy_experience_items'
          AND COLUMN_NAME = 'memory_tier'`)
      if (!columns.length) {
        await queryRun(`ALTER TABLE platform_strategy_experience_items
          ADD COLUMN memory_tier VARCHAR(16) NOT NULL DEFAULT 'short' AFTER strategy_id`)
      }
      await queryRun(`UPDATE platform_strategy_experience_items items
        LEFT JOIN period_review_cases cases ON cases.id = items.period_review_case_id
        SET items.memory_tier = CASE WHEN cases.period_type = 'monthly' THEN 'long' ELSE 'short' END
        WHERE items.memory_tier IS NULL OR items.memory_tier = '' OR cases.period_type = 'monthly'`)
      const indexes = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_strategy_experience_items'
          AND INDEX_NAME = 'idx_platform_memory_retrieval'`)
      if (!indexes.length) {
        await queryRun(`CREATE INDEX idx_platform_memory_retrieval
          ON platform_strategy_experience_items (strategy_id, status, memory_tier, platform_version)`)
      }
    }
  },
  {
    id: '115_mt5_account_current_owner',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS mt5_account_bindings (
        broker_server_key VARCHAR(100) NOT NULL,
        login_account VARCHAR(50) NOT NULL,
        current_user_id INT NOT NULL,
        current_trading_account_id INT NOT NULL,
        last_verified_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (broker_server_key, login_account),
        UNIQUE KEY uk_mt5_binding_account (current_trading_account_id),
        INDEX idx_mt5_binding_user (current_user_id, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      const rows = await queryAll(`SELECT id, user_id, broker_server, login_account,
          observe_status, identity_verified_at, updated_at
        FROM trading_accounts WHERE is_deleted = 0 AND broker_server <> '' AND login_account <> ''
        ORDER BY CASE WHEN observe_status = 'active' THEN 0 ELSE 1 END,
          identity_verified_at DESC, updated_at DESC, id DESC`)
      const seen = new Set()
      for (const row of rows) {
        const serverKey = String(row.broker_server || '').trim().toUpperCase()
        const login = String(row.login_account || '').trim()
        const key = `${serverKey}\n${login}`
        if (!serverKey || !login || seen.has(key)) continue
        seen.add(key)
        const verifiedAt = row.identity_verified_at || row.updated_at || beijingNow()
        await queryRun(`INSERT INTO mt5_account_bindings
          (broker_server_key, login_account, current_user_id, current_trading_account_id, last_verified_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE
            current_user_id = VALUES(current_user_id), current_trading_account_id = VALUES(current_trading_account_id),
            last_verified_at = VALUES(last_verified_at), updated_at = VALUES(updated_at)`,
        [serverKey, login, row.user_id, row.id, verifiedAt, beijingNow(), beijingNow()])
      }
    }
  },
  {
    id: '116_inference_storage_and_network_metrics',
    async up() {
      const wanted = {
        request_bytes: 'BIGINT NOT NULL DEFAULT 0',
        response_bytes: 'BIGINT NOT NULL DEFAULT 0',
        duration_ms: 'INT NOT NULL DEFAULT 0',
      }
      const columns = new Set((await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_model_usage_logs'`)).map(row => row.COLUMN_NAME))
      for (const [name, definition] of Object.entries(wanted)) {
        if (!columns.has(name)) await queryRun(`ALTER TABLE ai_model_usage_logs ADD COLUMN ${name} ${definition}`)
      }
    }
  },
  {
    id: '117_versionless_contextual_memory',
    async up() {
      const addColumn = async (table, name, definition) => {
        const rows = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, name])
        if (!rows.length) await queryRun(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`)
      }
      const addIndex = async (table, name, definition, unique = false) => {
        const rows = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [table, name])
        if (!rows.length) await queryRun(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${name}\` ON \`${table}\` (${definition})`)
      }
      await addColumn('period_review_cases', 'strategy_versions_json', "strategy_versions_json TEXT DEFAULT NULL AFTER strategy_version")
      await addColumn('period_review_cases', 'strategy_compatibility_hash', "strategy_compatibility_hash CHAR(64) DEFAULT NULL AFTER strategy_versions_json")

      for (const table of ['experience_memory_items', 'experience_long_term_memories']) {
        const categoryPosition = table === 'experience_memory_items' ? 'AFTER memory_tier' : 'AFTER strategy_version'
        await addColumn(table, 'memory_category', `memory_category VARCHAR(32) NOT NULL DEFAULT 'general' ${categoryPosition}`)
        await addColumn(table, 'applicability_json', "applicability_json LONGTEXT DEFAULT NULL AFTER conditions_json")
        await addColumn(table, 'avoid_when_json', "avoid_when_json LONGTEXT DEFAULT NULL AFTER applicability_json")
        await addColumn(table, 'strategy_compatibility_hash', "strategy_compatibility_hash CHAR(64) DEFAULT NULL AFTER avoid_when_json")
      }
      await addColumn('experience_memory_summaries', 'strategy_id', 'strategy_id INT DEFAULT NULL AFTER user_id')
      await addColumn('experience_memory_summaries', 'memory_category', "memory_category VARCHAR(32) NOT NULL DEFAULT 'general' AFTER strategy_id")
      await addColumn('experience_memory_summaries', 'applicability_json', 'applicability_json LONGTEXT DEFAULT NULL AFTER memory_category')
      await addColumn('experience_memory_summaries', 'avoid_when_json', 'avoid_when_json LONGTEXT DEFAULT NULL AFTER applicability_json')
      await addColumn('experience_memory_summaries', 'strategy_compatibility_hash', 'strategy_compatibility_hash CHAR(64) DEFAULT NULL AFTER avoid_when_json')

      await addColumn('platform_strategy_experience_items', 'memory_category', "memory_category VARCHAR(32) NOT NULL DEFAULT 'general' AFTER memory_tier")
      await addColumn('platform_strategy_experience_items', 'applicability_json', 'applicability_json LONGTEXT DEFAULT NULL AFTER context_json')
      await addColumn('platform_strategy_experience_items', 'avoid_when_json', 'avoid_when_json LONGTEXT DEFAULT NULL AFTER applicability_json')
      await addColumn('platform_strategy_experience_items', 'strategy_compatibility_hash', 'strategy_compatibility_hash CHAR(64) DEFAULT NULL AFTER avoid_when_json')
      await addColumn('platform_strategy_experience_logs', 'signal_id', 'signal_id BIGINT DEFAULT NULL AFTER strategy_id')
      await addColumn('platform_strategy_experience_logs', 'inference_snapshot_id', 'inference_snapshot_id BIGINT DEFAULT NULL AFTER signal_id')

      await addIndex('experience_memory_items', 'idx_memory_contextual_retrieval', 'user_id, status, strategy_id, memory_category, symbol, timeframe, updated_at')
      await addIndex('experience_long_term_memories', 'idx_long_memory_contextual_retrieval', 'user_id, status, strategy_id, memory_category, symbol, timeframe, updated_at')
      await addIndex('experience_memory_summaries', 'idx_memory_summary_contextual', 'user_id, status, strategy_id, memory_category, created_at')
      await addIndex('platform_strategy_experience_items', 'idx_platform_memory_contextual', 'strategy_id, status, memory_category, updated_at')
      await addIndex('platform_strategy_experience_logs', 'idx_platform_experience_log_signal', 'signal_id')

      // Preserve every historical case, but nominate one canonical case for
      // each versionless review scope. NULL hashes leave old duplicates
      // readable while the unique hash prevents new duplicates.
      const periodRows = await queryAll(`SELECT id, period_type, period_key, user_id,
          COALESCE(trading_account_id, 0) AS trading_account_id, strategy_id, status
        FROM period_review_cases
        ORDER BY CASE WHEN status = 'approved' THEN 0 ELSE 1 END, updated_at DESC, id DESC`)
      const canonicalScopes = new Set()
      for (const row of periodRows) {
        const scope = [row.period_type, row.period_key, row.user_id, row.trading_account_id, row.strategy_id].join(':')
        if (canonicalScopes.has(scope)) continue
        canonicalScopes.add(scope)
        await queryRun('UPDATE period_review_cases SET strategy_compatibility_hash = SHA2(?, 256) WHERE id = ?', [scope, row.id])
      }
      await addIndex('period_review_cases', 'uk_period_review_compatibility', 'strategy_compatibility_hash', true)
      await queryRun(`UPDATE period_review_jobs jobs
        JOIN period_review_cases cases ON cases.id = jobs.period_case_id
        SET jobs.status = 'skipped', jobs.last_error_code = 'superseded_by_versionless_review',
          jobs.lease_token = NULL, jobs.lease_expires_at = NULL, jobs.next_attempt_at = NULL, jobs.updated_at = NOW()
        WHERE cases.strategy_compatibility_hash IS NULL AND jobs.status IN ('queued', 'leased')`)
      await queryRun(`UPDATE period_review_derivation_jobs jobs
        JOIN period_review_cases cases ON cases.id = jobs.period_case_id
        SET jobs.status = 'superseded', jobs.last_error_code = 'superseded_by_versionless_review',
          jobs.lease_token = NULL, jobs.lease_expires_at = NULL, jobs.next_attempt_at = NULL, jobs.updated_at = NOW()
        WHERE cases.strategy_compatibility_hash IS NULL AND jobs.status IN ('queued', 'leased', 'paused')`)

      const dropIndexIfExists = async (table, name) => {
        const rows = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`, [table, name])
        if (rows.length) await queryRun(`ALTER TABLE \`${table}\` DROP INDEX \`${name}\``)
      }
      await dropIndexIfExists('experience_memory_items', 'uk_memory_period_review_version')
      await dropIndexIfExists('platform_strategy_experience_items', 'uk_platform_experience_period_version')
      await addIndex('experience_memory_items', 'uk_memory_period_review_content', 'period_review_version_id, content_hash', true)
      await addIndex('platform_strategy_experience_items', 'uk_platform_experience_period_content', 'period_review_version_id, content_hash', true)

      await queryRun(`UPDATE period_review_cases SET strategy_versions_json = JSON_ARRAY(strategy_version)
        WHERE strategy_versions_json IS NULL`)
      await queryRun(`UPDATE experience_memory_items SET applicability_json = scope_json
        WHERE applicability_json IS NULL`)
      await queryRun(`UPDATE experience_memory_items SET memory_category = CASE
        WHEN CONCAT_WS(' ', lesson_text, anti_pattern_text) REGEXP '缠论|中枢|线段|背驰|背离|买卖点|分型' THEN 'chan_structure'
        WHEN CONCAT_WS(' ', lesson_text, anti_pattern_text) REGEXP '挂单|入场|突破|回调|追涨|追空|限价|止损单' THEN 'entry_setup'
        WHEN CONCAT_WS(' ', lesson_text, anti_pattern_text) REGEXP '趋势|方向|多头|空头|震荡|盘整|反转' THEN 'market_regime'
        WHEN CONCAT_WS(' ', lesson_text, anti_pattern_text) REGEXP '止损|止盈|风险|仓位|手数|滑点' THEN 'risk_execution'
        ELSE 'general' END`)
      await queryRun(`UPDATE experience_long_term_memories SET applicability_json = conditions_json
        WHERE applicability_json IS NULL`)
      await queryRun(`UPDATE experience_long_term_memories SET memory_category = CASE
        WHEN summary_text REGEXP '缠论|中枢|线段|背驰|背离|买卖点|分型' THEN 'chan_structure'
        WHEN summary_text REGEXP '挂单|入场|突破|回调|追涨|追空|限价|止损单' THEN 'entry_setup'
        WHEN summary_text REGEXP '趋势|方向|多头|空头|震荡|盘整|反转' THEN 'market_regime'
        WHEN summary_text REGEXP '止损|止盈|风险|仓位|手数|滑点' THEN 'risk_execution'
        ELSE 'general' END`)
      await queryRun(`UPDATE platform_strategy_experience_items SET applicability_json = context_json
        WHERE applicability_json IS NULL`)
      await queryRun(`UPDATE platform_strategy_experience_items SET memory_category = CASE
        WHEN lesson_text REGEXP '缠论|中枢|线段|背驰|背离|买卖点|分型' THEN 'chan_structure'
        WHEN lesson_text REGEXP '挂单|入场|突破|回调|追涨|追空|限价|止损单' THEN 'entry_setup'
        WHEN lesson_text REGEXP '趋势|方向|多头|空头|震荡|盘整|反转' THEN 'market_regime'
        WHEN lesson_text REGEXP '止损|止盈|风险|仓位|手数|滑点' THEN 'risk_execution'
        ELSE 'general' END`)

      const parseJson = (value, fallback = {}) => { try { return value ? JSON.parse(value) : fallback } catch { return fallback } }
      const normalizedDirection = value => {
        const text = String(value || '').toLowerCase()
        if (text.startsWith('buy') || text === 'up' || text === 'bullish') return 'buy'
        if (text.startsWith('sell') || text === 'down' || text === 'bearish') return 'sell'
        return text === 'hold' || text === 'neutral' ? 'hold' : null
      }
      const memoryRows = await queryAll(`SELECT memory.id, memory.scope_json, cases.evidence_json
        FROM experience_memory_items memory
        LEFT JOIN period_review_cases cases ON cases.id = memory.period_review_case_id`)
      for (const row of memoryRows) {
        const scope = parseJson(row.scope_json, {})
        const evidence = parseJson(row.evidence_json, {})
        const sources = Array.isArray(evidence.sources) ? evidence.sources : []
        const values = key => [...new Set(sources.map(source => source?.evidence).map(item => {
          const signal = item?.inference_time?.signal || {}
          const order = item?.inference_time?.approved_order || item?.inference_time?.original_order || {}
          const outcome = item?.post_trade?.outcome || {}
          if (key === 'symbol') return outcome.symbol || order.symbol
          if (key === 'timeframe') return signal.timeframe
          if (key === 'direction') return normalizedDirection(signal.signal_type)
          if (key === 'entry_method') return order.entry_method || order.action
          return null
        }).concat(scope[key]).map(value => String(value || '').trim().toLowerCase()).filter(Boolean))]
        const applicability = { applicable_when:{ universal:false, symbols:values('symbol'), timeframes:values('timeframe'),
          directions:values('direction'), entry_methods:values('entry_method'), market_regimes:scope.market_regime ? [String(scope.market_regime).toLowerCase()] : [] }, avoid_when:{} }
        await queryRun('UPDATE experience_memory_items SET applicability_json = ?, avoid_when_json = ? WHERE id = ?',
        [JSON.stringify(applicability), '{}', row.id])
      }
      const platformRows = await queryAll(`SELECT memory.id, memory.context_json, cases.evidence_json
        FROM platform_strategy_experience_items memory
        LEFT JOIN period_review_cases cases ON cases.id = memory.period_review_case_id`)
      for (const row of platformRows) {
        const context = parseJson(row.context_json, {})
        const evidence = parseJson(row.evidence_json, {})
        const sources = Array.isArray(evidence.sources) ? evidence.sources : []
        const collect = getter => [...new Set(sources.map(source => getter(source?.evidence || {}))
          .map(value => String(value || '').trim().toLowerCase()).filter(Boolean))]
        const applicability = { applicable_when:{ universal:false,
          symbols:collect(item => item?.post_trade?.outcome?.symbol || item?.inference_time?.approved_order?.symbol).concat(context.symbol ? [String(context.symbol).toLowerCase()] : []),
          timeframes:collect(item => item?.inference_time?.signal?.timeframe).concat(context.timeframe ? [String(context.timeframe).toLowerCase()] : []),
          trend_direction:collect(item => normalizedDirection(item?.inference_time?.signal?.signal_type)).concat(context.trend_direction ? [String(context.trend_direction).toLowerCase()] : []),
          entry_methods:collect(item => item?.inference_time?.approved_order?.entry_method || item?.inference_time?.signal?.entry_method),
          market_regime:context.market_regime ? [String(context.market_regime).toLowerCase()] : [] }, avoid_when:{} }
        await queryRun('UPDATE platform_strategy_experience_items SET applicability_json = ?, avoid_when_json = ? WHERE id = ?',
        [JSON.stringify(applicability), '{}', row.id])
      }
    }
  },
  {
    id: '118_observer_sources_and_channels',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_observer_sources (
        id BIGINT NOT NULL AUTO_INCREMENT,
        name VARCHAR(80) NOT NULL,
        bridge_user_id INT NOT NULL,
        trading_account_id INT DEFAULT NULL,
        status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
        notes VARCHAR(255) DEFAULT NULL,
        created_by_user_id INT NOT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uk_observer_source_bridge_user (bridge_user_id),
        KEY idx_observer_source_status (status, updated_at),
        KEY idx_observer_source_account (trading_account_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_observer_channels (
        id BIGINT NOT NULL AUTO_INCREMENT,
        name VARCHAR(80) NOT NULL,
        slug VARCHAR(64) NOT NULL,
        description VARCHAR(255) DEFAULT NULL,
        source_id BIGINT NOT NULL,
        audience ENUM('all', 'plus', 'pro', 'assigned') NOT NULL DEFAULT 'all',
        status ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
        is_default TINYINT(1) NOT NULL DEFAULT 0,
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uk_observer_channel_slug (slug),
        KEY idx_observer_channel_default (is_default, status, sort_order),
        KEY idx_observer_channel_source (source_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_observer_channel_assignments (
        channel_id BIGINT NOT NULL,
        user_id INT NOT NULL,
        created_by_user_id INT NOT NULL,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (channel_id, user_id),
        KEY idx_observer_assignment_user (user_id, channel_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '119_position_sizing_and_reference_strategy',
    async up() {
      const addColumn = async (table, column, definition) => {
        const existing = await queryAll(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column])
        if (!existing.length) await queryRun(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`)
      }
      await addColumn('ai_signals', 'position_size_tier', 'position_size_tier VARCHAR(16) DEFAULT NULL AFTER recommended_volume')
      await addColumn('ai_signals', 'position_size_factor', 'position_size_factor DOUBLE DEFAULT NULL AFTER position_size_tier')
      await addColumn('ai_signals', 'position_size_reason', 'position_size_reason VARCHAR(255) DEFAULT NULL AFTER position_size_factor')
      await addColumn('ai_observer_sources', 'strategy_id', 'strategy_id INT DEFAULT NULL AFTER trading_account_id')
      const indexes = await queryAll(`SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_observer_sources' AND INDEX_NAME = 'idx_observer_source_strategy'`)
      if (!indexes.length) await queryRun('CREATE INDEX idx_observer_source_strategy ON ai_observer_sources(strategy_id, status)')
    }
  },
  {
    id: '120_mt5_account_performance',
    async up() {
      const bindingColumns = [
        ['first_connected_at', 'DATETIME DEFAULT NULL'],
        ['last_connected_at', 'DATETIME DEFAULT NULL'],
        ['account_currency', 'VARCHAR(16) DEFAULT NULL'],
      ]
      for (const [column, definition] of bindingColumns) {
        const existing = await queryAll(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'mt5_account_bindings' AND COLUMN_NAME = ?`, [column])
        if (!existing.length) await queryRun(`ALTER TABLE mt5_account_bindings ADD COLUMN \`${column}\` ${definition}`)
      }
      await queryRun(`UPDATE mt5_account_bindings bindings
        LEFT JOIN (
          SELECT UPPER(broker_server) AS broker_server_key, login_account,
            MIN(COALESCE(first_verified_at, identity_verified_at, created_at)) AS first_connected_at,
            MAX(COALESCE(identity_verified_at, updated_at, created_at)) AS last_connected_at
          FROM trading_accounts WHERE broker_server <> '' AND login_account <> ''
          GROUP BY UPPER(broker_server), login_account
        ) accounts ON accounts.broker_server_key = bindings.broker_server_key
          AND accounts.login_account = bindings.login_account
        SET bindings.first_connected_at = COALESCE(bindings.first_connected_at, accounts.first_connected_at, bindings.created_at),
          bindings.last_connected_at = COALESCE(bindings.last_connected_at, accounts.last_connected_at, bindings.updated_at)`)

      await queryRun(`CREATE TABLE IF NOT EXISTS mt5_account_ownership_history (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        broker_server_key VARCHAR(100) NOT NULL,
        login_account VARCHAR(50) NOT NULL,
        user_id INT NOT NULL,
        trading_account_id INT NOT NULL,
        started_at DATETIME NOT NULL,
        ended_at DATETIME DEFAULT NULL,
        end_reason VARCHAR(64) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        KEY idx_mt5_ownership_identity (broker_server_key, login_account, started_at),
        KEY idx_mt5_ownership_user (user_id, started_at),
        KEY idx_mt5_ownership_account (trading_account_id, started_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`INSERT INTO mt5_account_ownership_history
        (broker_server_key, login_account, user_id, trading_account_id, started_at, ended_at, end_reason, created_at, updated_at)
        SELECT UPPER(ta.broker_server), ta.login_account, ta.user_id, ta.id,
          COALESCE(ta.first_verified_at, ta.identity_verified_at, ta.created_at),
          CASE WHEN bindings.current_trading_account_id = ta.id THEN NULL ELSE ta.updated_at END,
          CASE WHEN bindings.current_trading_account_id = ta.id THEN NULL ELSE 'historical_backfill' END,
          NOW(), NOW()
        FROM trading_accounts ta
        JOIN mt5_account_bindings bindings ON bindings.broker_server_key = UPPER(ta.broker_server)
          AND bindings.login_account = ta.login_account
        LEFT JOIN mt5_account_ownership_history history ON history.trading_account_id = ta.id
          AND history.started_at = COALESCE(ta.first_verified_at, ta.identity_verified_at, ta.created_at)
        WHERE ta.broker_server <> '' AND ta.login_account <> '' AND history.id IS NULL`)

      await queryRun(`CREATE TABLE IF NOT EXISTS mt5_account_performance_daily (
        ownership_history_id BIGINT NOT NULL,
        trading_account_id INT NOT NULL,
        business_date DATE NOT NULL,
        account_currency VARCHAR(16) DEFAULT NULL,
        trade_profit DECIMAL(20,8) NOT NULL DEFAULT 0,
        commission DECIMAL(20,8) NOT NULL DEFAULT 0,
        swap DECIMAL(20,8) NOT NULL DEFAULT 0,
        fee DECIMAL(20,8) NOT NULL DEFAULT 0,
        pnl_adjustment DECIMAL(20,8) NOT NULL DEFAULT 0,
        realized_net DECIMAL(20,8) NOT NULL DEFAULT 0,
        deposit DECIMAL(20,8) NOT NULL DEFAULT 0,
        withdrawal DECIMAL(20,8) NOT NULL DEFAULT 0,
        credit_change DECIMAL(20,8) NOT NULL DEFAULT 0,
        other_capital_change DECIMAL(20,8) NOT NULL DEFAULT 0,
        exit_deal_count INT NOT NULL DEFAULT 0,
        closed_position_count INT NOT NULL DEFAULT 0,
        winning_exit_count INT NOT NULL DEFAULT 0,
        losing_exit_count INT NOT NULL DEFAULT 0,
        closed_volume DECIMAL(20,8) NOT NULL DEFAULT 0,
        first_deal_time_msc BIGINT NOT NULL DEFAULT 0,
        last_deal_time_msc BIGINT NOT NULL DEFAULT 0,
        last_deal_ticket BIGINT NOT NULL DEFAULT 0,
        source_hash CHAR(64) DEFAULT NULL,
        data_complete TINYINT NOT NULL DEFAULT 1,
        data_issue VARCHAR(255) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (ownership_history_id, business_date),
        KEY idx_mt5_performance_account (trading_account_id, business_date),
        KEY idx_mt5_performance_date (business_date, trading_account_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS mt5_account_performance_totals (
        ownership_history_id BIGINT NOT NULL PRIMARY KEY,
        trading_account_id INT NOT NULL,
        account_currency VARCHAR(16) DEFAULT NULL,
        period_start_date DATE DEFAULT NULL,
        period_end_date DATE DEFAULT NULL,
        realized_net DECIMAL(20,8) NOT NULL DEFAULT 0,
        deposit DECIMAL(20,8) NOT NULL DEFAULT 0,
        withdrawal DECIMAL(20,8) NOT NULL DEFAULT 0,
        credit_change DECIMAL(20,8) NOT NULL DEFAULT 0,
        other_capital_change DECIMAL(20,8) NOT NULL DEFAULT 0,
        net_funding DECIMAL(20,8) NOT NULL DEFAULT 0,
        net_account_change DECIMAL(20,8) NOT NULL DEFAULT 0,
        exit_deal_count INT NOT NULL DEFAULT 0,
        closed_position_count INT NOT NULL DEFAULT 0,
        winning_exit_count INT NOT NULL DEFAULT 0,
        losing_exit_count INT NOT NULL DEFAULT 0,
        closed_volume DECIMAL(20,8) NOT NULL DEFAULT 0,
        data_complete TINYINT NOT NULL DEFAULT 0,
        last_synced_at DATETIME DEFAULT NULL,
        updated_at DATETIME NOT NULL,
        KEY idx_mt5_performance_totals_account (trading_account_id, period_end_date),
        KEY idx_mt5_performance_totals_result (realized_net, trading_account_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS mt5_account_performance_sync_state (
        ownership_history_id BIGINT NOT NULL PRIMARY KEY,
        trading_account_id INT NOT NULL,
        sync_from_date DATE NOT NULL,
        synced_through_date DATE DEFAULT NULL,
        timezone_offset_minutes INT DEFAULT NULL,
        sync_status VARCHAR(24) NOT NULL DEFAULT 'pending',
        last_error VARCHAR(255) DEFAULT NULL,
        last_attempt_at DATETIME DEFAULT NULL,
        last_success_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        KEY idx_mt5_performance_sync_account (trading_account_id, updated_at),
        KEY idx_mt5_performance_sync_status (sync_status, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '121_bridge_refresh_sessions',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS bridge_refresh_sessions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at DATETIME NOT NULL,
        revoked_at DATETIME DEFAULT NULL,
        last_used_at DATETIME DEFAULT NULL,
        user_agent VARCHAR(255) DEFAULT NULL,
        last_ip VARCHAR(64) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_bridge_refresh_token (token_hash),
        KEY idx_bridge_refresh_user (user_id, revoked_at, expires_at),
        KEY idx_bridge_refresh_expiry (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '122_expand_account_risk_boundaries',
    async up() {
      const sets = await queryAll("SELECT id FROM risk_policy_sets WHERE scope = 'platform' AND status = 'active' ORDER BY id LIMIT 1")
      if (!sets[0]) return
      const versions = await queryAll('SELECT * FROM risk_policy_versions WHERE policy_set_id = ? ORDER BY version_no DESC LIMIT 1', [sets[0].id])
      if (!versions[0]) return
      let raw = {}
      try { raw = versions[0].config_json ? JSON.parse(versions[0].config_json) : {} } catch {}
      const flatValues = { ...raw }
      delete flatValues.values
      delete flatValues.defaults
      delete flatValues.controls
      delete flatValues._controls
      const values = { ...(raw.values || raw.defaults || flatValues) }
      const controls = { ...(raw.controls || raw._controls || {}) }
      values.max_position_size = Math.min(5, Math.max(0.001, Number(values.max_position_size) || 0.05))
      values.max_risk_per_trade_pct = Math.min(100, Math.max(0.01, Number(values.max_risk_per_trade_pct) || 1))
      controls.max_position_size = {
        ...(controls.max_position_size || {}),
        allowed_min:Math.min(5, Math.max(0.001, Number(controls.max_position_size?.allowed_min) || 0.001)),
        allowed_max:5,
        locked_value:controls.max_position_size?.locked_value == null
          ? null : Math.min(5, Math.max(0.001, Number(controls.max_position_size.locked_value) || values.max_position_size)),
        user_editable:controls.max_position_size?.user_editable !== false,
      }
      controls.max_risk_per_trade_pct = {
        ...(controls.max_risk_per_trade_pct || {}),
        allowed_min:Math.min(100, Math.max(0.01, Number(controls.max_risk_per_trade_pct?.allowed_min) || 0.01)),
        allowed_max:100,
        locked_value:controls.max_risk_per_trade_pct?.locked_value == null
          ? null : Math.min(100, Math.max(0.01, Number(controls.max_risk_per_trade_pct.locked_value) || values.max_risk_per_trade_pct)),
        user_editable:controls.max_risk_per_trade_pct?.user_editable !== false,
      }
      const now = beijingNow()
      const inserted = await queryRun(`INSERT INTO risk_policy_versions
        (policy_set_id, version_no, config_json, created_by, change_reason, effective_at, created_at)
        VALUES (?, ?, ?, 0, '扩大账户单笔手数与风险可选上限', ?, ?)`, [
        sets[0].id, Number(versions[0].version_no || 0) + 1,
        JSON.stringify({ values, controls }), now, now,
      ])
      await queryRun('UPDATE risk_policy_sets SET active_version_id = ?, updated_at = ? WHERE id = ?', [inserted.insertId, now, sets[0].id])
    }
  },
  {
    id: '123_membership_expiry_notifications',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS membership_expiry_notifications (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        plan VARCHAR(16) NOT NULL,
        plan_expires_at DATETIME NOT NULL,
        days_before TINYINT UNSIGNED NOT NULL,
        channel VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempt_count INT NOT NULL DEFAULT 0,
        next_attempt_at DATETIME DEFAULT NULL,
        sent_at DATETIME DEFAULT NULL,
        read_at DATETIME DEFAULT NULL,
        last_error VARCHAR(500) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_membership_expiry_delivery (user_id, plan_expires_at, days_before, channel),
        KEY idx_membership_expiry_dispatch (channel, status, next_attempt_at),
        KEY idx_membership_expiry_user (user_id, channel, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`INSERT INTO system_config (category, \`key\`, \`value\`, label, sort_order)
        VALUES ('sms', 'template_code_membership_expiry', '', '会员到期提醒模板', 7)
        ON DUPLICATE KEY UPDATE label = VALUES(label), sort_order = VALUES(sort_order)`)
    }
  },
  {
    id: '124_membership_expired_notification_template',
    async up() {
      await queryRun(`INSERT INTO system_config (category, \`key\`, \`value\`, label, sort_order)
        VALUES ('sms', 'template_code_membership_expired', '', '会员已过期提醒模板', 8)
        ON DUPLICATE KEY UPDATE label = VALUES(label), sort_order = VALUES(sort_order)`)
    }
  },
  {
    id: '125_expired_payment_order_cleanup_indexes',
    async up() {
      const indexes = [
        { table: 'orders', name: 'idx_orders_expired_cleanup_expiry', columns: 'status, crypto_expires_at, id' },
        { table: 'orders', name: 'idx_orders_expired_cleanup_created', columns: 'status, created_at, id' },
        { table: 'crypto_watch_list', name: 'idx_watch_order_cleanup', columns: 'order_id, status' },
      ]
      for (const index of indexes) {
        const existing = await queryAll(
          `SELECT INDEX_NAME FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
          [index.table, index.name],
        )
        if (!existing?.length) {
          await queryRun(`CREATE INDEX \`${index.name}\` ON \`${index.table}\` (${index.columns})`)
        }
      }
    }
  },
  {
    id: '126_position_management_foundation',
    async up() {
      const addColumn = async (table, name, definition) => {
        const existing = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, name])
        if (!existing.length) await queryRun(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${definition}`)
      }

      await queryRun(`CREATE TABLE IF NOT EXISTS ai_trade_theses (
        thesis_id VARCHAR(64) NOT NULL,
        management_group_id VARCHAR(64) NOT NULL,
        signal_id BIGINT NOT NULL,
        strategy_id INT NOT NULL,
        strategy_version INT NOT NULL DEFAULT 1,
        strategy_scope VARCHAR(20) NOT NULL,
        owner_user_id INT NOT NULL DEFAULT 0,
        standard_symbol VARCHAR(64) NOT NULL,
        direction VARCHAR(8) NOT NULL,
        entry_method VARCHAR(20) NOT NULL,
        decision_timeframe VARCHAR(16) NOT NULL,
        closed_bar_time_utc_ms BIGINT DEFAULT NULL,
        market_snapshot_hash CHAR(64) NOT NULL,
        output_contract_version VARCHAR(40) NOT NULL,
        model_profile_id BIGINT DEFAULT NULL,
        model_name VARCHAR(150) DEFAULT NULL,
        core_entry_reason VARCHAR(1000) DEFAULT NULL,
        original_stop_loss DECIMAL(20,8) DEFAULT NULL,
        original_take_profits_json TEXT DEFAULT NULL,
        invalidation_conditions_json LONGTEXT NOT NULL,
        evidence_refs_json LONGTEXT NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'proposed',
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        PRIMARY KEY (thesis_id),
        UNIQUE KEY uk_trade_thesis_signal (signal_id),
        KEY idx_trade_thesis_group (management_group_id, status),
        KEY idx_trade_thesis_strategy (strategy_id, standard_symbol, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS ai_position_management_tasks (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        task_key CHAR(64) NOT NULL,
        task_type VARCHAR(32) NOT NULL,
        execution_mode VARCHAR(20) NOT NULL DEFAULT 'display',
        user_id INT NOT NULL,
        trading_account_id INT NOT NULL,
        ownership_history_id BIGINT DEFAULT NULL,
        broker_server_key VARCHAR(100) DEFAULT NULL,
        login_account VARCHAR(50) DEFAULT NULL,
        bridge_generation BIGINT DEFAULT NULL,
        original_symbol VARCHAR(64) NOT NULL,
        standard_symbol VARCHAR(64) NOT NULL,
        strategy_id INT NOT NULL,
        strategy_version INT NOT NULL DEFAULT 1,
        management_group_id VARCHAR(64) NOT NULL,
        thesis_id VARCHAR(64) NOT NULL,
        origin_signal_id BIGINT DEFAULT NULL,
        decision_signal_id BIGINT DEFAULT NULL,
        outcome_id BIGINT DEFAULT NULL,
        decision_timeframe VARCHAR(16) NOT NULL,
        closed_bar_time_utc_ms BIGINT NOT NULL,
        market_snapshot_hash CHAR(64) NOT NULL,
        candidate_action VARCHAR(16) NOT NULL,
        reversal_candidate TINYINT(1) NOT NULL DEFAULT 0,
        model_evaluation_json LONGTEXT NOT NULL,
        evidence_validation_json LONGTEXT DEFAULT NULL,
        precondition_hash CHAR(64) DEFAULT NULL,
        status VARCHAR(40) NOT NULL DEFAULT 'CANDIDATE',
        state_version BIGINT NOT NULL DEFAULT 1,
        lease_token VARCHAR(64) DEFAULT NULL,
        lease_expires_at DATETIME DEFAULT NULL,
        fencing_token BIGINT NOT NULL DEFAULT 0,
        candidate_expires_at DATETIME DEFAULT NULL,
        completed_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_position_management_task (task_key),
        KEY idx_position_management_user (user_id, status, updated_at),
        KEY idx_position_management_account (trading_account_id, status, updated_at),
        KEY idx_position_management_group (management_group_id, closed_bar_time_utc_ms),
        KEY idx_position_management_lease (status, lease_expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS ai_position_management_commands (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        task_id BIGINT NOT NULL,
        command_sequence INT NOT NULL,
        operation_id VARCHAR(96) NOT NULL,
        command_type VARCHAR(32) NOT NULL,
        expected_state_json LONGTEXT NOT NULL,
        request_json LONGTEXT NOT NULL,
        send_status VARCHAR(24) NOT NULL DEFAULT 'prepared',
        bridge_command_id VARCHAR(64) DEFAULT NULL,
        bridge_result_json LONGTEXT DEFAULT NULL,
        reconciliation_status VARCHAR(32) NOT NULL DEFAULT 'pending',
        reconciled_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_position_management_operation (operation_id),
        UNIQUE KEY uk_position_management_sequence (task_id, command_type, command_sequence),
        KEY idx_position_management_command_task (task_id, created_at),
        KEY idx_position_management_command_reconcile (reconciliation_status, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS ai_position_management_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        task_id BIGINT NOT NULL,
        from_status VARCHAR(40) DEFAULT NULL,
        to_status VARCHAR(40) NOT NULL,
        event_type VARCHAR(48) NOT NULL,
        summary VARCHAR(500) NOT NULL,
        details_json LONGTEXT DEFAULT NULL,
        actor_type VARCHAR(24) NOT NULL DEFAULT 'system',
        actor_user_id INT DEFAULT NULL,
        created_at DATETIME NOT NULL,
        KEY idx_position_management_event_task (task_id, id),
        KEY idx_position_management_event_type (event_type, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS user_position_management_settings (
        user_id INT NOT NULL PRIMARY KEY,
        execution_mode VARCHAR(20) NOT NULL DEFAULT 'auto_exit',
        auto_exit_daily_limit INT NOT NULL DEFAULT 0,
        auto_reverse_daily_limit INT NOT NULL DEFAULT 0,
        cooldown_minutes INT NOT NULL DEFAULT 60,
        updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS global_position_management_control (
        id INT NOT NULL PRIMARY KEY,
        maximum_mode VARCHAR(20) NOT NULL DEFAULT 'auto_exit',
        ai_pending_order_enabled TINYINT(1) NOT NULL DEFAULT 1,
        ai_pending_cancel_enabled TINYINT(1) NOT NULL DEFAULT 1,
        block_new_risk TINYINT(1) NOT NULL DEFAULT 0,
        freeze_automatic_operations TINYINT(1) NOT NULL DEFAULT 0,
        emergency_flatten_enabled TINYINT(1) NOT NULL DEFAULT 0,
        changed_by INT DEFAULT NULL,
        reason VARCHAR(1000) DEFAULT NULL,
        updated_at DATETIME NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`INSERT INTO global_position_management_control
        (id, maximum_mode, ai_pending_order_enabled, ai_pending_cancel_enabled,
         block_new_risk, freeze_automatic_operations, emergency_flatten_enabled, updated_at)
        VALUES (1, 'auto_exit', 1, 1, 0, 0, 0, NOW()) ON DUPLICATE KEY UPDATE id = id`)

      const signalColumns = [
        ['thesis_id', 'VARCHAR(64) DEFAULT NULL AFTER decision_json'],
        ['management_group_id', 'VARCHAR(64) DEFAULT NULL AFTER thesis_id'],
      ]
      for (const [name, definition] of signalColumns) await addColumn('ai_signals', name, definition)

      const outcomeColumns = [
        ['strategy_id', 'INT DEFAULT NULL AFTER trading_account_id'],
        ['strategy_version', 'INT DEFAULT NULL AFTER strategy_id'],
        ['thesis_id', 'VARCHAR(64) DEFAULT NULL AFTER strategy_version'],
        ['management_group_id', 'VARCHAR(64) DEFAULT NULL AFTER thesis_id'],
        ['ownership_history_id', 'BIGINT DEFAULT NULL AFTER management_group_id'],
        ['broker_server_key', 'VARCHAR(100) DEFAULT NULL AFTER ownership_history_id'],
        ['login_account', 'VARCHAR(50) DEFAULT NULL AFTER broker_server_key'],
        ['original_symbol', 'VARCHAR(64) DEFAULT NULL AFTER symbol'],
        ['entry_direction', 'VARCHAR(8) DEFAULT NULL AFTER original_symbol'],
        ['system_magic', 'BIGINT DEFAULT NULL AFTER entry_direction'],
        ['original_stop_loss', 'DECIMAL(20,8) DEFAULT NULL AFTER expected_volume'],
        ['original_take_profits_json', 'TEXT DEFAULT NULL AFTER original_stop_loss'],
        ['actual_stop_loss', 'DECIMAL(20,8) DEFAULT NULL AFTER original_take_profits_json'],
        ['actual_take_profit', 'DECIMAL(20,8) DEFAULT NULL AFTER actual_stop_loss'],
        ['protection_status', "VARCHAR(32) NOT NULL DEFAULT 'unknown' AFTER actual_take_profit"],
        ['protection_modified', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER protection_status'],
        ['last_position_snapshot_json', 'LONGTEXT DEFAULT NULL AFTER protection_modified'],
      ]
      for (const [name, definition] of outcomeColumns) await addColumn('signal_outcomes', name, definition)

      // Existing open outcomes must not become orphaned merely because their
      // originating signal predates the v1.1 contract. Backfill immutable
      // legacy theses conservatively; legacy-only conditions remain shadow or
      // manual-review evidence and never authorize automatic exit by themselves.
      const legacyRows = await queryAll(`SELECT outcomes.id AS outcome_id, outcomes.user_id,
          outcomes.trading_account_id, outcomes.signal_id, outcomes.symbol, outcomes.pending_ticket,
          signals.prompt_type_id AS strategy_id, signals.signal_type, signals.entry_method,
          signals.timeframe, signals.stop_loss_price, signals.take_profit_1_price,
          signals.take_profit_2_price, signals.take_profit_3_price, signals.reasoning,
          signals.decision_json, signals.market_data_json, signals.ai_model, signals.created_at,
          strategies.version AS strategy_version, strategies.scope AS strategy_scope,
          strategies.owner_user_id, ownership.id AS ownership_history_id,
          ownership.broker_server_key, ownership.login_account
        FROM signal_outcomes outcomes
        JOIN ai_signals signals ON signals.id = outcomes.signal_id
        JOIN auto_prompt_types strategies ON strategies.id = signals.prompt_type_id
        LEFT JOIN mt5_account_ownership_history ownership
          ON ownership.trading_account_id = outcomes.trading_account_id
          AND ownership.user_id = outcomes.user_id AND ownership.ended_at IS NULL
        WHERE outcomes.status IN ('open','closing') AND outcomes.thesis_id IS NULL
        ORDER BY outcomes.id`)
      for (const row of legacyRows) {
        const direction = String(row.signal_type || '').toLowerCase().startsWith('buy') ? 'buy'
          : String(row.signal_type || '').toLowerCase().startsWith('sell') ? 'sell' : null
        if (!direction || !row.strategy_id || !row.signal_id) continue
        const standardSymbol = String(row.symbol || '').replace(/\.(a|s|c|pro|std|z|ecn|m|raw|mini)$/i, '').toUpperCase()
        const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
        const thesisId = `thesis_${digest([row.signal_id, row.strategy_id, row.strategy_version || 1, standardSymbol, direction]).slice(0, 32)}`
        const managementGroupId = `group_${digest([row.strategy_id, row.strategy_version || 1, standardSymbol, thesisId, direction]).slice(0, 32)}`
        let decision = {}
        try { decision = JSON.parse(row.decision_json || '{}') } catch {}
        const closedBarTime = Date.parse(`${String(row.created_at || '').replace(' ', 'T')}+08:00`) || null
        const conditions = []
        const stopLoss = Number(row.stop_loss_price)
        if (stopLoss > 0) {
          const conditionId = `cond_${digest(['protective_stop', direction, stopLoss, row.timeframe]).slice(0, 32)}`
          conditions.push({ condition_id:conditionId, kind:'hard', type:'protective_stop',
            timeframe:row.timeframe, operator:direction === 'buy' ? 'closed_bar_lte' : 'closed_bar_gte',
            threshold:stopLoss, required_closed_bars:1, immutable:true })
        }
        const invalidation = String(decision.invalidation_condition || '').trim()
        if (invalidation) {
          const conditionId = `cond_${digest(['soft_thesis_invalidation', invalidation, row.timeframe]).slice(0, 32)}`
          conditions.push({ condition_id:conditionId, kind:'soft', type:'model_evidence', timeframe:row.timeframe,
            operator:'model_confirmed', threshold:null, required_closed_bars:2,
            description:invalidation.slice(0, 1000), immutable:true, legacy_backfill:true })
        }
        if (!conditions.length) {
          const conditionId = `cond_${digest(['legacy_manual_review', thesisId]).slice(0, 32)}`
          conditions.push({ condition_id:conditionId, kind:'soft', type:'legacy_manual_review',
            timeframe:row.timeframe, operator:'manual_only', threshold:null, required_closed_bars:2,
            description:'历史交易缺少结构化失效条件，只允许展示和人工复核', immutable:true, legacy_backfill:true })
        }
        const evidenceRefs = [
          ...(closedBarTime ? [`bar:${row.timeframe}:${closedBarTime}`] : []),
          ...conditions.map(condition => `condition:${condition.condition_id}`),
        ]
        const marketHash = digest(row.market_data_json || '{}')
        const takeProfits = [row.take_profit_1_price, row.take_profit_2_price, row.take_profit_3_price]
          .map(Number).filter(value => value > 0)
        const now = beijingNow()
        await queryRun(`INSERT INTO ai_trade_theses
          (thesis_id, management_group_id, signal_id, strategy_id, strategy_version, strategy_scope,
           owner_user_id, standard_symbol, direction, entry_method, decision_timeframe,
           closed_bar_time_utc_ms, market_snapshot_hash, output_contract_version, model_name,
           core_entry_reason, original_stop_loss, original_take_profits_json,
           invalidation_conditions_json, evidence_refs_json, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'position-management-v1.1', ?, ?, ?, ?, ?, ?, 'active', ?, ?)
          ON DUPLICATE KEY UPDATE thesis_id = thesis_id`, [
          thesisId, managementGroupId, row.signal_id, row.strategy_id, row.strategy_version || 1,
          row.strategy_scope || 'platform', row.owner_user_id || 0, standardSymbol, direction,
          row.entry_method || 'market', row.timeframe || 'M30', closedBarTime, marketHash,
          row.ai_model || null, String(row.reasoning || '').slice(0, 1000), stopLoss > 0 ? stopLoss : null,
          JSON.stringify(takeProfits), JSON.stringify(conditions), JSON.stringify(evidenceRefs),
          row.created_at || now, now,
        ])
        await queryRun('UPDATE ai_signals SET thesis_id = ?, management_group_id = ? WHERE id = ?',
          [thesisId, managementGroupId, row.signal_id])
        await queryRun(`UPDATE signal_outcomes SET strategy_id = ?, strategy_version = ?, thesis_id = ?,
          management_group_id = ?, ownership_history_id = ?, broker_server_key = ?, login_account = ?,
          original_symbol = COALESCE(original_symbol, symbol), entry_direction = ?, system_magic = 234000,
          original_stop_loss = ?, original_take_profits_json = ?, updated_at = ? WHERE id = ?`, [
          row.strategy_id, row.strategy_version || 1, thesisId, managementGroupId,
          row.ownership_history_id || null, row.broker_server_key || null, row.login_account || null,
          direction, stopLoss > 0 ? stopLoss : null, JSON.stringify(takeProfits), now, row.outcome_id,
        ])
      }
    }
  },
  {
    id: '127_terminal_pending_outcome_cleanup',
    async up() {
      const terminal = await queryRun(`UPDATE signal_outcomes outcomes
        LEFT JOIN auto_signal_deliveries deliveries ON deliveries.id = outcomes.delivery_id
        LEFT JOIN ai_signals signals ON signals.id = outcomes.signal_id
        SET outcomes.status = COALESCE(deliveries.pending_state, signals.pending_state),
          outcomes.attribution_status = 'not_filled', outcomes.last_scan_at = NOW(), outcomes.updated_at = NOW()
        WHERE outcomes.status IN ('open','closing') AND outcomes.position_id IS NULL
          AND outcomes.pending_ticket IS NOT NULL
          AND COALESCE(deliveries.pending_state, signals.pending_state) IN ('cancelled','expired','superseded')`)
      await queryRun(`UPDATE ai_trade_theses theses SET theses.status = 'closed', theses.updated_at = NOW()
        WHERE theses.status IN ('proposed','active')
          AND NOT EXISTS (SELECT 1 FROM signal_outcomes outcomes
            WHERE outcomes.thesis_id = theses.thesis_id AND outcomes.status IN ('open','closing'))`)
      console.log(`[Migrations] 127 closed ${Number(terminal?.changes || 0)} terminal pending outcome(s)`)
    }
  },
  {
    id: '128_position_management_account_rollouts',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS position_management_account_rollouts (
        trading_account_id INT NOT NULL PRIMARY KEY,
        user_id INT NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 0,
        maximum_mode VARCHAR(20) NOT NULL DEFAULT 'display',
        auto_exit_daily_limit INT NOT NULL DEFAULT 1,
        cooldown_minutes INT NOT NULL DEFAULT 60,
        approved_by INT DEFAULT NULL,
        reason VARCHAR(1000) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_position_management_rollout_user_account (user_id, trading_account_id),
        KEY idx_position_management_rollout_enabled (enabled, maximum_mode, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '129_remove_position_management_shadow_mode',
    async up() {
      await queryRun(`UPDATE global_position_management_control
        SET maximum_mode = 'display', updated_at = NOW()
        WHERE maximum_mode = 'shadow'`)
      await queryRun(`UPDATE user_position_management_settings
        SET execution_mode = 'display', updated_at = NOW()
        WHERE execution_mode = 'shadow'`)
      await queryRun(`UPDATE position_management_account_rollouts
        SET maximum_mode = 'display', updated_at = NOW()
        WHERE maximum_mode = 'shadow'`)
      await queryRun(`ALTER TABLE global_position_management_control
        MODIFY maximum_mode VARCHAR(20) NOT NULL DEFAULT 'display'`)
      await queryRun(`ALTER TABLE user_position_management_settings
        MODIFY execution_mode VARCHAR(20) NOT NULL DEFAULT 'display'`)
      await queryRun(`ALTER TABLE position_management_account_rollouts
        MODIFY maximum_mode VARCHAR(20) NOT NULL DEFAULT 'display'`)
    }
  },
  {
    id: '130_default_automatic_close_enabled',
    async up() {
      // Only change the default for users without an explicit preference.
      // Existing rows, including users who manually selected "display", are
      // intentionally preserved across platform close-switch changes.
      await queryRun(`ALTER TABLE user_position_management_settings
        MODIFY execution_mode VARCHAR(20) NOT NULL DEFAULT 'auto_exit'`)
      await queryRun(`ALTER TABLE global_position_management_control
        MODIFY maximum_mode VARCHAR(20) NOT NULL DEFAULT 'auto_exit'`)
    }
  },
  {
    id: '131_independent_ai_pending_order_controls',
    async up() {
      const addColumn = async (name, definition) => {
        const existing = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'global_position_management_control'
            AND COLUMN_NAME = ?`, [name])
        if (!existing.length) {
          await queryRun(`ALTER TABLE global_position_management_control ADD COLUMN \`${name}\` ${definition}`)
        }
      }
      await addColumn('ai_pending_order_enabled', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER maximum_mode')
      await addColumn('ai_pending_cancel_enabled', 'TINYINT(1) NOT NULL DEFAULT 1 AFTER ai_pending_order_enabled')
      await queryRun(`UPDATE global_position_management_control
        SET block_new_risk = 0, freeze_automatic_operations = 0, emergency_flatten_enabled = 0
        WHERE id = 1`)
    }
  },
  {
    id: '132_ai_model_quota_circuit',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_model_provider_incidents (
        circuit_key CHAR(64) NOT NULL PRIMARY KEY,
        model_profile_id BIGINT NOT NULL,
        provider VARCHAR(64) NOT NULL,
        model_name VARCHAR(191) NOT NULL,
        endpoint_host VARCHAR(191) DEFAULT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        first_detected_at DATETIME NOT NULL,
        last_detected_at DATETIME NOT NULL,
        open_until DATETIME DEFAULT NULL,
        probe_lease_until DATETIME DEFAULT NULL,
        recovered_at DATETIME DEFAULT NULL,
        alert_sent_at DATETIME DEFAULT NULL,
        recovery_sent_at DATETIME DEFAULT NULL,
        error_count INT UNSIGNED NOT NULL DEFAULT 1,
        last_error_code VARCHAR(191) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        KEY idx_ai_model_incident_profile (model_profile_id, status),
        KEY idx_ai_model_incident_open (status, open_until)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '133_admin_position_protection_jobs',
    async up() {
      const addColumn = async (table, name, definition) => {
        const existing = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, name])
        if (!existing.length) await queryRun(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${definition}`)
      }

      await queryRun(`CREATE TABLE IF NOT EXISTS admin_position_protection_jobs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        idempotency_key VARCHAR(128) NOT NULL,
        actor_user_id INT NOT NULL,
        source_user_id INT NOT NULL,
        source_trading_account_id INT NOT NULL,
        source_outcome_id BIGINT DEFAULT NULL,
        source_signal_id BIGINT DEFAULT NULL,
        source_ticket VARCHAR(64) NOT NULL,
        source_symbol VARCHAR(64) NOT NULL,
        source_direction VARCHAR(8) NOT NULL,
        requested_stop_loss DECIMAL(20,8) DEFAULT NULL,
        requested_take_profit DECIMAL(20,8) DEFAULT NULL,
        sync_scope VARCHAR(24) NOT NULL DEFAULT 'source_only',
        change_reason VARCHAR(500) NOT NULL,
        preview_hash CHAR(64) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'queued',
        total_users INT NOT NULL DEFAULT 0,
        total_positions INT NOT NULL DEFAULT 0,
        succeeded_positions INT NOT NULL DEFAULT 0,
        failed_positions INT NOT NULL DEFAULT 0,
        skipped_positions INT NOT NULL DEFAULT 0,
        pending_positions INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        started_at DATETIME DEFAULT NULL,
        completed_at DATETIME DEFAULT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_admin_position_protection_job_key (idempotency_key),
        KEY idx_admin_position_protection_job_status (status, updated_at),
        KEY idx_admin_position_protection_job_actor (actor_user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS admin_position_protection_targets (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_id BIGINT NOT NULL,
        target_order INT NOT NULL,
        is_source TINYINT(1) NOT NULL DEFAULT 0,
        user_id INT NOT NULL,
        trading_account_id INT NOT NULL,
        ownership_history_id BIGINT DEFAULT NULL,
        signal_id BIGINT DEFAULT NULL,
        outcome_id BIGINT DEFAULT NULL,
        broker_server_key VARCHAR(100) NOT NULL,
        login_account VARCHAR(50) NOT NULL,
        ticket VARCHAR(64) NOT NULL,
        symbol VARCHAR(64) NOT NULL,
        direction VARCHAR(8) NOT NULL,
        volume DECIMAL(18,8) NOT NULL DEFAULT 0,
        magic BIGINT NOT NULL DEFAULT 234000,
        expected_stop_loss DECIMAL(20,8) DEFAULT NULL,
        expected_take_profit DECIMAL(20,8) DEFAULT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'pending',
        attempt_count INT NOT NULL DEFAULT 0,
        error_code VARCHAR(128) DEFAULT NULL,
        error_message VARCHAR(500) DEFAULT NULL,
        result_json LONGTEXT DEFAULT NULL,
        started_at DATETIME DEFAULT NULL,
        completed_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_admin_position_protection_target (job_id, user_id, trading_account_id, ticket),
        KEY idx_admin_position_protection_target_job (job_id, target_order, status),
        KEY idx_admin_position_protection_target_outcome (outcome_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await addColumn('signal_outcomes', 'authorized_stop_loss',
        'DECIMAL(20,8) DEFAULT NULL AFTER actual_take_profit')
      await addColumn('signal_outcomes', 'authorized_take_profit',
        'DECIMAL(20,8) DEFAULT NULL AFTER authorized_stop_loss')
      await addColumn('signal_outcomes', 'protection_revision',
        'INT NOT NULL DEFAULT 0 AFTER authorized_take_profit')
      await addColumn('signal_outcomes', 'protection_updated_by',
        'INT DEFAULT NULL AFTER protection_revision')
      await addColumn('signal_outcomes', 'protection_updated_at',
        'DATETIME DEFAULT NULL AFTER protection_updated_by')
      await addColumn('signal_outcomes', 'protection_job_id',
        'BIGINT DEFAULT NULL AFTER protection_updated_at')
    }
  },
  {
    id: '134_admin_position_protection_hardening',
    async up() {
      const addColumn = async (table, name, definition) => {
        const existing = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, name])
        if (!existing.length) await queryRun(`ALTER TABLE \`${table}\` ADD COLUMN \`${name}\` ${definition}`)
      }
      await addColumn('admin_position_protection_targets', 'expected_stop_loss',
        'DECIMAL(20,8) DEFAULT NULL AFTER magic')
      await addColumn('admin_position_protection_targets', 'expected_take_profit',
        'DECIMAL(20,8) DEFAULT NULL AFTER expected_stop_loss')
    }
  },
  {
    id: '135_remove_paired_inference_experiment',
    async up() {
      await queryRun('DROP TABLE IF EXISTS ai_paired_inference_runs')
      const columns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_feature_flags'
          AND COLUMN_NAME = 'paired_experiment_enabled'`)
      if (columns.length) {
        await queryRun('ALTER TABLE ai_feature_flags DROP COLUMN paired_experiment_enabled')
      }
    }
  },
  {
    id: '136_order_referral_credit_ledger',
    async up() {
      const existing = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
          AND COLUMN_NAME = 'referral_credit_applied'`)
      if (!existing.length) {
        await queryRun(`ALTER TABLE orders
          ADD COLUMN referral_credit_applied INT NOT NULL DEFAULT 0 AFTER amount_confirmed`)
      }
    }
  },
  {
    id: '137_users_token_version',
    async up() {
      const existing = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
          AND COLUMN_NAME = 'token_version'`)
      if (!existing.length) {
        await queryRun(`ALTER TABLE users
          ADD COLUMN token_version INT NOT NULL DEFAULT 0 AFTER changelog_seen_version`)
      }
    }
  },
  {
    id: '138_payment_money_and_referral_precision',
    async up() {
      await queryRun('UPDATE users SET referral_credit = 0 WHERE referral_credit IS NULL')
      await queryRun(`UPDATE orders SET amount = COALESCE(amount, 0),
        amount_confirmed = COALESCE(amount_confirmed, 0),
        referral_credit_applied = COALESCE(referral_credit_applied, 0)`)
      await queryRun('UPDATE referrals SET commission = 0 WHERE commission IS NULL')
      await queryRun(`ALTER TABLE users
        MODIFY COLUMN referral_credit DECIMAL(20,8) NOT NULL DEFAULT 0`)
      await queryRun(`ALTER TABLE orders
        MODIFY COLUMN amount DECIMAL(20,8) NOT NULL DEFAULT 0,
        MODIFY COLUMN amount_confirmed DECIMAL(20,8) NOT NULL DEFAULT 0,
        MODIFY COLUMN referral_credit_applied DECIMAL(20,8) NOT NULL DEFAULT 0`)
      await queryRun(`ALTER TABLE referrals
        MODIFY COLUMN commission DECIMAL(20,8) NOT NULL DEFAULT 0`)

      const referralColumns = new Set((await queryAll(`SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'referrals'
          AND COLUMN_NAME IN ('amount_cents', 'cash_amount', 'order_id')`)).map(row => row.COLUMN_NAME))
      if (referralColumns.has('amount_cents') && !referralColumns.has('cash_amount')) {
        await queryRun('UPDATE referrals SET amount_cents = 0 WHERE amount_cents IS NULL')
        await queryRun(`ALTER TABLE referrals
          CHANGE COLUMN amount_cents cash_amount DECIMAL(20,8) NOT NULL DEFAULT 0`)
      } else if (referralColumns.has('cash_amount')) {
        await queryRun('UPDATE referrals SET cash_amount = 0 WHERE cash_amount IS NULL')
        await queryRun(`ALTER TABLE referrals
          MODIFY COLUMN cash_amount DECIMAL(20,8) NOT NULL DEFAULT 0`)
      } else {
        await queryRun(`ALTER TABLE referrals
          ADD COLUMN cash_amount DECIMAL(20,8) NOT NULL DEFAULT 0 AFTER commission`)
      }
      if (!referralColumns.has('order_id')) {
        await queryRun(`ALTER TABLE referrals ADD COLUMN order_id VARCHAR(100) DEFAULT NULL AFTER referred_id`)
      }

      const indexes = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'referrals'
          AND INDEX_NAME = 'uq_referrals_order_id'`)
      if (!indexes.length) {
        await queryRun('ALTER TABLE referrals ADD UNIQUE KEY uq_referrals_order_id (order_id)')
      }
    }
  },
  {
    id: '139_durable_payment_side_effects',
    async up() {
      const notificationColumns = await queryAll(`SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications'
          AND COLUMN_NAME = 'dedupe_key'`)
      if (!notificationColumns.length) {
        await queryRun('ALTER TABLE notifications ADD COLUMN dedupe_key VARCHAR(191) DEFAULT NULL AFTER link')
      }
      const notificationIndexes = await queryAll(`SELECT INDEX_NAME
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications'
          AND INDEX_NAME = 'uq_notifications_dedupe_key'`)
      if (!notificationIndexes.length) {
        await queryRun('ALTER TABLE notifications ADD UNIQUE KEY uq_notifications_dedupe_key (dedupe_key)')
      }

      await queryRun(`CREATE TABLE IF NOT EXISTS payment_side_effects (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        order_id VARCHAR(100) NOT NULL,
        user_id INT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        attempt_count INT NOT NULL DEFAULT 0,
        next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        locked_at DATETIME DEFAULT NULL,
        completed_at DATETIME DEFAULT NULL,
        last_error VARCHAR(1000) DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_payment_side_effect_order (order_id),
        KEY idx_payment_side_effect_ready (status, next_attempt_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '140_bridge_v3_command_ledger',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS bridge_v3_command_ledger (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        command_id VARCHAR(128) NOT NULL,
        user_id INT NOT NULL,
        terminal_instance_id VARCHAR(128) NOT NULL,
        broker_server VARCHAR(128) NOT NULL,
        login_account VARCHAR(64) NOT NULL,
        connection_epoch BIGINT UNSIGNED NOT NULL,
        action VARCHAR(32) NOT NULL,
        params_json LONGTEXT NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'queued',
        deadline_at_utc_msc BIGINT UNSIGNED NOT NULL,
        dispatch_attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
        last_dispatched_at_utc_msc BIGINT UNSIGNED DEFAULT NULL,
        completed_at_utc_msc BIGINT UNSIGNED DEFAULT NULL,
        result_status VARCHAR(24) DEFAULT NULL,
        result_json LONGTEXT DEFAULT NULL,
        result_hash CHAR(64) DEFAULT NULL,
        error_code VARCHAR(128) DEFAULT NULL,
        error_message VARCHAR(1000) DEFAULT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        UNIQUE KEY uk_bridge_v3_command_id (command_id),
        KEY idx_bridge_v3_command_ready (status, deadline_at_utc_msc),
        KEY idx_bridge_v3_command_route (user_id, terminal_instance_id, connection_epoch, status),
        KEY idx_bridge_v3_command_updated (updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS bridge_v3_command_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        command_id VARCHAR(128) NOT NULL,
        event_type VARCHAR(32) NOT NULL,
        from_status VARCHAR(24) DEFAULT NULL,
        to_status VARCHAR(24) NOT NULL,
        detail_json LONGTEXT DEFAULT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        KEY idx_bridge_v3_command_event (command_id, id),
        KEY idx_bridge_v3_command_event_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '141_bridge_v3_incremental_read_model',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS bridge_v3_terminal_sessions (
        terminal_instance_id VARCHAR(128) PRIMARY KEY,
        user_id INT NOT NULL,
        platform VARCHAR(8) NOT NULL,
        broker_server VARCHAR(128) NOT NULL,
        login_account VARCHAR(64) NOT NULL,
        connection_epoch BIGINT UNSIGNED NOT NULL,
        session_id VARCHAR(128) NOT NULL,
        client_version VARCHAR(64) DEFAULT NULL,
        connected TINYINT(1) NOT NULL DEFAULT 1,
        last_seen_at_utc_msc BIGINT UNSIGNED NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        KEY idx_bridge_v3_terminal_user (user_id, connected, updated_at),
        KEY idx_bridge_v3_terminal_account (broker_server, login_account, connected)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS bridge_v3_stream_revisions (
        terminal_instance_id VARCHAR(128) NOT NULL,
        connection_epoch BIGINT UNSIGNED NOT NULL,
        stream VARCHAR(24) NOT NULL,
        revision BIGINT UNSIGNED NOT NULL,
        message_id VARCHAR(128) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        observed_at_utc_msc BIGINT UNSIGNED NOT NULL,
        source_time_msc BIGINT UNSIGNED DEFAULT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (terminal_instance_id, connection_epoch, stream),
        KEY idx_bridge_v3_stream_freshness (stream, observed_at_utc_msc)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS bridge_v3_account_latest (
        terminal_instance_id VARCHAR(128) PRIMARY KEY,
        connection_epoch BIGINT UNSIGNED NOT NULL,
        revision BIGINT UNSIGNED NOT NULL,
        observed_at_utc_msc BIGINT UNSIGNED NOT NULL,
        source_time_msc BIGINT UNSIGNED DEFAULT NULL,
        payload_json LONGTEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS bridge_v3_positions_latest (
        terminal_instance_id VARCHAR(128) NOT NULL,
        ticket VARCHAR(64) NOT NULL,
        connection_epoch BIGINT UNSIGNED NOT NULL,
        revision BIGINT UNSIGNED NOT NULL,
        observed_at_utc_msc BIGINT UNSIGNED NOT NULL,
        source_time_msc BIGINT UNSIGNED DEFAULT NULL,
        payload_json LONGTEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (terminal_instance_id, ticket),
        KEY idx_bridge_v3_position_updated (terminal_instance_id, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS bridge_v3_orders_latest (
        terminal_instance_id VARCHAR(128) NOT NULL,
        ticket VARCHAR(64) NOT NULL,
        connection_epoch BIGINT UNSIGNED NOT NULL,
        revision BIGINT UNSIGNED NOT NULL,
        observed_at_utc_msc BIGINT UNSIGNED NOT NULL,
        source_time_msc BIGINT UNSIGNED DEFAULT NULL,
        payload_json LONGTEXT NOT NULL,
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (terminal_instance_id, ticket),
        KEY idx_bridge_v3_order_updated (terminal_instance_id, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '142_bridge_device_pairing',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS bridge_device_pairings (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        device_code_hash CHAR(64) NOT NULL,
        user_code_hash CHAR(64) NOT NULL,
        user_id INT DEFAULT NULL,
        approved_token_version INT DEFAULT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        device_name VARCHAR(120) DEFAULT NULL,
        created_ip VARCHAR(64) DEFAULT NULL,
        approved_ip VARCHAR(64) DEFAULT NULL,
        expires_at DATETIME NOT NULL,
        approved_at DATETIME DEFAULT NULL,
        consumed_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_bridge_pair_device_code (device_code_hash),
        UNIQUE KEY uk_bridge_pair_user_code (user_code_hash),
        KEY idx_bridge_pair_expiry (status, expires_at),
        KEY idx_bridge_pair_user (user_id, status, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '143_bridge_v3_deal_history',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS bridge_v3_deals (
        terminal_instance_id VARCHAR(128) NOT NULL,
        deal_ticket VARCHAR(64) NOT NULL,
        user_id INT NOT NULL,
        connection_epoch BIGINT UNSIGNED NOT NULL,
        order_ticket VARCHAR(64) DEFAULT NULL,
        position_id VARCHAR(64) DEFAULT NULL,
        symbol VARCHAR(64) DEFAULT NULL,
        deal_time_msc BIGINT UNSIGNED NOT NULL,
        observed_at_utc_msc BIGINT UNSIGNED NOT NULL,
        source_time_msc BIGINT UNSIGNED DEFAULT NULL,
        payload_json LONGTEXT NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        PRIMARY KEY (terminal_instance_id, deal_ticket),
        KEY idx_bridge_v3_deals_user_time (user_id, deal_time_msc),
        KEY idx_bridge_v3_deals_position (terminal_instance_id, position_id, deal_time_msc)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '144_remove_future_market_candles',
    async up() {
      // Broker-local epochs were briefly persisted as UTC by the modular MT5
      // worker. A candle opening more than two minutes in the future is invalid.
      await queryRun('DELETE FROM market_candles WHERE open_time_utc_msc > ?', [Date.now() + 120000])
    }
  },
  {
    id: '145_manual_orders_outside_ai_protection',
    async up() {
      // Older direct website orders were recorded as AI-managed outcomes.
      // Retire only those explicitly created with source_type=manual; terminal
      // manual trades never had an outcome and need no migration.
      await queryRun(`UPDATE signal_outcomes outcomes
        JOIN order_intents intents ON intents.id = outcomes.order_intent_id
        SET outcomes.status = 'manual_exempt',
          outcomes.attribution_status = 'manual_exempt',
          outcomes.protection_status = 'not_applicable',
          outcomes.updated_at = NOW()
        WHERE intents.source_type = 'manual'
          AND outcomes.status IN ('open','closing')`)
      await queryRun(`UPDATE risk_account_state risk_state
        SET halt_status = 'active', halt_reason = NULL, updated_at = NOW()
        WHERE risk_state.halt_status = 'protection_incident'
          AND risk_state.halt_reason IN ('missing_stop_loss','invalid_stop_loss_direction')
          AND EXISTS (
            SELECT 1 FROM signal_outcomes manual_outcomes
            JOIN order_intents manual_intents ON manual_intents.id = manual_outcomes.order_intent_id
            WHERE manual_outcomes.trading_account_id = risk_state.trading_account_id
              AND manual_outcomes.status = 'manual_exempt'
              AND manual_intents.source_type = 'manual'
          )
          AND NOT EXISTS (
            SELECT 1 FROM signal_outcomes outcomes
            JOIN order_intents intents ON intents.id = outcomes.order_intent_id
            WHERE outcomes.trading_account_id = risk_state.trading_account_id
              AND outcomes.status IN ('open','closing','attribution_ambiguous')
              AND outcomes.protection_status IN ('missing_stop_loss','invalid_stop_loss_direction')
              AND intents.source_type <> 'manual'
          )`)
    }
  },
  {
    id: '146_bridge_release_observability',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS bridge_update_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        installation_id VARCHAR(64) NOT NULL,
        release_id VARCHAR(128) NOT NULL,
        target_version VARCHAR(64) NOT NULL,
        state VARCHAR(24) NOT NULL,
        started_at_utc_msc BIGINT UNSIGNED DEFAULT NULL,
        updated_at_utc_msc BIGINT UNSIGNED NOT NULL,
        error_code VARCHAR(128) DEFAULT NULL,
        bridge_version VARCHAR(64) DEFAULT NULL,
        received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        UNIQUE KEY uk_bridge_update_event (installation_id, release_id, state, updated_at_utc_msc),
        KEY idx_bridge_update_release (release_id, state, updated_at_utc_msc),
        KEY idx_bridge_update_installation (installation_id, updated_at_utc_msc)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      const existingColumns = new Set((await queryAll(`SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bridge_v3_terminal_sessions'`))
        .map(row => String(row.COLUMN_NAME)))
      const existingIndexes = new Set((await queryAll(`SELECT DISTINCT INDEX_NAME
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bridge_v3_terminal_sessions'`))
        .map(row => String(row.INDEX_NAME)))
      const additions = []
      const columns = [
        ['installation_id', 'VARCHAR(64) DEFAULT NULL'],
        ['bridge_version', 'VARCHAR(64) DEFAULT NULL'],
        ['update_release_id', 'VARCHAR(128) DEFAULT NULL'],
        ['update_target_version', 'VARCHAR(64) DEFAULT NULL'],
        ['update_state', 'VARCHAR(24) DEFAULT NULL'],
        ['update_started_at_utc_msc', 'BIGINT UNSIGNED DEFAULT NULL'],
        ['update_reported_at_utc_msc', 'BIGINT UNSIGNED DEFAULT NULL'],
        ['update_error_code', 'VARCHAR(128) DEFAULT NULL'],
      ]
      for (const [name, definition] of columns) {
        if (!existingColumns.has(name)) additions.push(`ADD COLUMN ${name} ${definition}`)
      }
      if (!existingIndexes.has('idx_bridge_v3_installation')) {
        additions.push('ADD KEY idx_bridge_v3_installation (installation_id, connected, last_seen_at_utc_msc)')
      }
      if (!existingIndexes.has('idx_bridge_v3_update_release')) {
        additions.push('ADD KEY idx_bridge_v3_update_release (update_release_id, update_state)')
      }
      if (additions.length) {
        await queryRun(`ALTER TABLE bridge_v3_terminal_sessions ${additions.join(', ')}`)
      }
    }
  },
  {
    id: '147_position_management_inference_confirmations',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_position_management_evaluations (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        decision_signal_id BIGINT NOT NULL,
        user_id INT NOT NULL,
        trading_account_id INT NOT NULL,
        outcome_id BIGINT NOT NULL,
        position_id VARCHAR(64) DEFAULT NULL,
        management_group_id VARCHAR(64) NOT NULL,
        thesis_id VARCHAR(64) NOT NULL,
        original_symbol VARCHAR(64) NOT NULL,
        standard_symbol VARCHAR(64) NOT NULL,
        action VARCHAR(16) NOT NULL,
        validation_status VARCHAR(16) NOT NULL DEFAULT 'valid',
        matched_condition_id VARCHAR(64) DEFAULT NULL,
        reason VARCHAR(1000) DEFAULT NULL,
        evidence_refs_json LONGTEXT NOT NULL,
        model_evaluation_json LONGTEXT NOT NULL,
        decision_timeframe VARCHAR(16) NOT NULL,
        closed_bar_time_utc_ms BIGINT NOT NULL,
        market_snapshot_hash CHAR(64) NOT NULL,
        inference_source VARCHAR(32) NOT NULL DEFAULT 'automatic_scheduler',
        consecutive_exit_count TINYINT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uk_position_management_evaluation (decision_signal_id, outcome_id),
        KEY idx_position_management_evaluation_outcome (outcome_id, management_group_id, id),
        KEY idx_position_management_evaluation_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      const taskColumns = await queryAll(`SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_position_management_tasks'
          AND COLUMN_NAME IN ('confirmation_count', 'required_confirmations')`)
      const taskColumnNames = new Set(taskColumns.map(row => row.COLUMN_NAME))
      if (!taskColumnNames.has('confirmation_count')) {
        await queryRun(`ALTER TABLE ai_position_management_tasks
          ADD COLUMN confirmation_count TINYINT NOT NULL DEFAULT 0 AFTER evidence_validation_json`)
      }
      if (!taskColumnNames.has('required_confirmations')) {
        await queryRun(`ALTER TABLE ai_position_management_tasks
          ADD COLUMN required_confirmations TINYINT NOT NULL DEFAULT 2 AFTER confirmation_count`)
      }

      // Old candidates used closed-bar confirmation semantics and cannot be
      // mixed with the new consecutive-inference counter.
      await queryRun(`UPDATE ai_position_management_tasks
        SET status = 'EXPIRED', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE task_type = 'position_exit' AND status = 'CANDIDATE'`)
    }
  },
  {
    id: '148_single_inference_pending_cancel',
    async up() {
      // Retire stale two-round candidates without executing them. If the order
      // is still active, a later inference can create a fresh one-round task.
      await queryRun(`UPDATE ai_position_management_tasks
        SET status = 'EXPIRED', completed_at = COALESCE(completed_at, NOW()), updated_at = NOW()
        WHERE task_type = 'pending_cancel' AND status = 'CANDIDATE'`)
    }
  },
  {
    id: '149_chan_structure_anchor_version',
    async up() {
      const columns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chan_structure_anchors'
          AND COLUMN_NAME = 'algorithm_version'`)
      if (!columns.length) {
        await queryRun(`ALTER TABLE chan_structure_anchors
          ADD COLUMN algorithm_version VARCHAR(64) NOT NULL DEFAULT 'legacy' AFTER timeframe`)
      }
    }
  },
  {
    id: '150_chan_structure_anchor_identity',
    async up() {
      const columns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'chan_structure_anchors'
          AND COLUMN_NAME IN ('bootstrap_core_stable_id', 'bootstrap_entry_segment_stable_id',
            'bootstrap_observation_time_utc_msc')`)
      const existing = new Set(columns.map(row => String(row.COLUMN_NAME)))
      const additions = []
      if (!existing.has('bootstrap_core_stable_id')) {
        additions.push('ADD COLUMN bootstrap_core_stable_id VARCHAR(1024) DEFAULT NULL AFTER last_confirmed_segment_time_utc_msc')
      }
      if (!existing.has('bootstrap_entry_segment_stable_id')) {
        additions.push('ADD COLUMN bootstrap_entry_segment_stable_id VARCHAR(255) DEFAULT NULL AFTER bootstrap_core_stable_id')
      }
      if (!existing.has('bootstrap_observation_time_utc_msc')) {
        additions.push('ADD COLUMN bootstrap_observation_time_utc_msc BIGINT DEFAULT NULL AFTER bootstrap_entry_segment_stable_id')
      }
      if (additions.length) await queryRun(`ALTER TABLE chan_structure_anchors ${additions.join(', ')}`)
    }
  },
  {
    id: '151_expand_ai_signal_market_data',
    async up() {
      const column = await queryOne(`SELECT DATA_TYPE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_signals'
          AND COLUMN_NAME = 'market_data_json'`)
      if (!column) throw new Error('ai_signals.market_data_json_missing')
      if (String(column.DATA_TYPE).toLowerCase() !== 'longtext') {
        await queryRun('ALTER TABLE ai_signals MODIFY COLUMN market_data_json LONGTEXT NOT NULL')
      }
    }
  },
  {
    id: '152_bridge_runtime_control',
    async up() {
      const columns = new Set((await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'user_bridge_settings'
          AND COLUMN_NAME IN ('connection_enabled', 'connection_control_revision',
            'connection_control_changed_at')`)).map(row => String(row.COLUMN_NAME)))
      const additions = []
      if (!columns.has('connection_enabled')) {
        additions.push('ADD COLUMN connection_enabled TINYINT NOT NULL DEFAULT 1 AFTER auto_reasoning_enabled')
      }
      if (!columns.has('connection_control_revision')) {
        additions.push('ADD COLUMN connection_control_revision BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER connection_enabled')
      }
      if (!columns.has('connection_control_changed_at')) {
        additions.push('ADD COLUMN connection_control_changed_at DATETIME(3) DEFAULT NULL AFTER connection_control_revision')
      }
      if (additions.length) await queryRun(`ALTER TABLE user_bridge_settings ${additions.join(', ')}`)
    }
  },
  {
    id: '153_strategy_policy_runtime',
    async up() {
      const strategyColumns = new Set((await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_prompt_types'
          AND COLUMN_NAME = 'strategy_policy_json'`)).map(row => String(row.COLUMN_NAME)))
      if (!strategyColumns.has('strategy_policy_json')) {
        await queryRun(`ALTER TABLE auto_prompt_types
          ADD COLUMN strategy_policy_json LONGTEXT DEFAULT NULL AFTER market_data_plan_json`)
      }

      const snapshotColumns = new Set((await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'inference_snapshots'
          AND COLUMN_NAME = 'strategy_runtime_json'`)).map(row => String(row.COLUMN_NAME)))
      if (!snapshotColumns.has('strategy_runtime_json')) {
        await queryRun(`ALTER TABLE inference_snapshots
          ADD COLUMN strategy_runtime_json LONGTEXT DEFAULT NULL AFTER market_snapshot_json`)
      }
    }
  },
  {
    id: '154_hardcoded_ema34_filter',
    async up() {
      const columns = new Set((await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'auto_prompt_types'
          AND COLUMN_NAME = 'use_ema34_filter'`)).map(row => String(row.COLUMN_NAME)))
      if (!columns.has('use_ema34_filter')) {
        await queryRun(`ALTER TABLE auto_prompt_types
          ADD COLUMN use_ema34_filter TINYINT NOT NULL DEFAULT 0 AFTER use_chan_analysis`)
      }

      const strategies = await queryAll(`SELECT id, strategy_policy_json
        FROM auto_prompt_types
        WHERE strategy_policy_json IS NOT NULL AND strategy_policy_json <> ''`)
      for (const strategy of strategies) {
        let policy
        try { policy = JSON.parse(strategy.strategy_policy_json) } catch { continue }
        const enabled = policy?.mode !== 'off' && Array.isArray(policy?.indicators) && policy.indicators.some(indicator =>
          indicator?.enabled !== false
          && String(indicator?.kind || '').toLowerCase() === 'ema'
          && String(indicator?.source?.timeframe || '').toUpperCase() === 'M5'
          && Number(indicator?.params?.period) === 34)
        if (enabled) await queryRun('UPDATE auto_prompt_types SET use_ema34_filter = 1 WHERE id = ?', [strategy.id])
      }
    }
  },
  {
    id: '155_repair_pending_position_identity',
    async up() {
      await queryRun(`UPDATE signal_outcomes outcomes
        LEFT JOIN auto_signal_deliveries deliveries ON deliveries.id = outcomes.delivery_id
        LEFT JOIN ai_signals signals ON signals.id = outcomes.signal_id
        SET outcomes.position_id = NULL, outcomes.attribution_status = 'pending',
          outcomes.status = 'open', outcomes.updated_at = NOW()
        WHERE outcomes.pending_ticket IS NOT NULL
          AND outcomes.position_id = outcomes.pending_ticket
          AND outcomes.entry_deal_ticket IS NULL
          AND outcomes.attribution_status = 'pending'
          AND COALESCE(deliveries.pending_state, signals.pending_state) = 'pending'`)
      await queryRun(`UPDATE ai_position_management_tasks tasks
        JOIN signal_outcomes outcomes ON outcomes.id = tasks.outcome_id
        LEFT JOIN auto_signal_deliveries deliveries ON deliveries.id = outcomes.delivery_id
        LEFT JOIN ai_signals signals ON signals.id = outcomes.signal_id
        SET tasks.status = 'EXPIRED', tasks.confirmation_count = 0,
          tasks.completed_at = COALESCE(tasks.completed_at, NOW()), tasks.updated_at = NOW()
        WHERE tasks.task_type = 'position_exit'
          AND tasks.status IN ('CANDIDATE','EVIDENCE_CONFIRMED')
          AND outcomes.position_id IS NULL AND outcomes.pending_ticket IS NOT NULL
          AND COALESCE(deliveries.pending_state, signals.pending_state) = 'pending'`)
    }
  },
  {
    id: '156_normalize_zero_deal_pending_identity',
    async up() {
      // MT4/MT5 report deal=0 while a pending order has not filled. Normalize
      // that transport sentinel before repairing legacy order/position aliases.
      await queryRun(`UPDATE signal_outcomes
        SET entry_deal_ticket = NULL, updated_at = NOW()
        WHERE TRIM(COALESCE(entry_deal_ticket, '')) IN ('', '0')
          AND entry_deal_ticket IS NOT NULL`)
      await queryRun(`UPDATE signal_outcomes outcomes
        LEFT JOIN auto_signal_deliveries deliveries ON deliveries.id = outcomes.delivery_id
        LEFT JOIN ai_signals signals ON signals.id = outcomes.signal_id
        SET outcomes.position_id = NULL, outcomes.attribution_status = 'pending',
          outcomes.status = 'open', outcomes.updated_at = NOW()
        WHERE outcomes.pending_ticket IS NOT NULL
          AND outcomes.position_id = outcomes.pending_ticket
          AND outcomes.entry_deal_ticket IS NULL
          AND outcomes.attribution_status = 'pending'
          AND COALESCE(deliveries.pending_state, signals.pending_state) = 'pending'`)
      await queryRun(`UPDATE ai_position_management_tasks tasks
        JOIN signal_outcomes outcomes ON outcomes.id = tasks.outcome_id
        LEFT JOIN auto_signal_deliveries deliveries ON deliveries.id = outcomes.delivery_id
        LEFT JOIN ai_signals signals ON signals.id = outcomes.signal_id
        SET tasks.status = 'EXPIRED', tasks.confirmation_count = 0,
          tasks.completed_at = COALESCE(tasks.completed_at, NOW()), tasks.updated_at = NOW()
        WHERE tasks.task_type = 'position_exit'
          AND tasks.status IN ('CANDIDATE','EVIDENCE_CONFIRMED')
          AND outcomes.position_id IS NULL AND outcomes.pending_ticket IS NOT NULL
          AND COALESCE(deliveries.pending_state, signals.pending_state) = 'pending'`)
    }
  },
  {
    id: '157_terminal_server_schedule_timezone',
    async up() {
      await queryRun(`ALTER TABLE strategy_subscriptions
        MODIFY COLUMN schedule_timezone VARCHAR(64) NOT NULL DEFAULT 'terminal_server'`)
      await queryRun(`UPDATE strategy_subscriptions
        SET schedule_timezone = 'terminal_server'
        WHERE schedule_timezone <> 'terminal_server'`)
    }
  },
  {
    id: '158_supersede_legacy_cross_account_monthly_reviews',
    async up() {
      const columns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'period_review_cases'
          AND COLUMN_NAME IN ('superseded_by_case_id', 'superseded_reason')`)
      const existingColumns = new Set(columns.map(row => row.COLUMN_NAME))
      if (!existingColumns.has('superseded_by_case_id')) {
        await queryRun(`ALTER TABLE period_review_cases
          ADD COLUMN superseded_by_case_id BIGINT DEFAULT NULL AFTER approved_version_id`)
      }
      if (!existingColumns.has('superseded_reason')) {
        await queryRun(`ALTER TABLE period_review_cases
          ADD COLUMN superseded_reason VARCHAR(64) DEFAULT NULL AFTER superseded_by_case_id`)
      }
      const indexes = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'period_review_cases'
          AND INDEX_NAME = 'idx_period_review_superseded'`)
      if (!indexes.length) {
        await queryRun(`CREATE INDEX idx_period_review_superseded
          ON period_review_cases (superseded_by_case_id, status)`)
      }

      const legacyCases = await queryAll(`SELECT id FROM period_review_cases
        WHERE period_type = 'monthly' AND trading_account_id = 0 AND status <> 'superseded'
        ORDER BY id`)
      for (const row of legacyCases) {
        await withTransaction(async run => {
          const [lockedRows] = await run(`SELECT * FROM period_review_cases
            WHERE id = ? AND period_type = 'monthly' AND trading_account_id = 0
              AND status <> 'superseded' FOR UPDATE`, [row.id])
          const legacyCase = lockedRows[0]
          if (!legacyCase) return
          const [sourceAccounts] = await run(`SELECT DISTINCT daily.trading_account_id
            FROM period_review_sources sources
            JOIN period_review_cases daily ON daily.id = sources.source_period_case_id
            WHERE sources.period_case_id = ? AND daily.period_type = 'daily'
              AND daily.trading_account_id > 0
            ORDER BY daily.trading_account_id`, [legacyCase.id])
          const accountIds = sourceAccounts.map(item => Number(item.trading_account_id)).filter(id => id > 0)
          if (!accountIds.length) return

          let replacementCaseId = null
          if (accountIds.length === 1) {
            const targetAccountId = accountIds[0]
            const [targets] = await run(`SELECT id FROM period_review_cases
              WHERE period_type = 'monthly' AND period_key = ? AND user_id = ?
                AND trading_account_id = ? AND strategy_id = ? AND status <> 'superseded'
              ORDER BY CASE WHEN status = 'approved' THEN 0 WHEN current_version_id IS NOT NULL THEN 1 ELSE 2 END,
                updated_at DESC, id DESC LIMIT 1 FOR UPDATE`, [legacyCase.period_key, legacyCase.user_id,
              targetAccountId, legacyCase.strategy_id])
            replacementCaseId = Number(targets[0]?.id || 0) || null
            if (!replacementCaseId) {
              const scope = ['monthly', legacyCase.period_key, legacyCase.user_id, targetAccountId, legacyCase.strategy_id].join(':')
              await run(`UPDATE period_review_cases SET trading_account_id = ?, strategy_compatibility_hash = ?,
                superseded_by_case_id = NULL, superseded_reason = NULL, updated_at = NOW() WHERE id = ?`,
              [targetAccountId, crypto.createHash('sha256').update(scope).digest('hex'), legacyCase.id])
              return
            }
          } else {
            const placeholders = accountIds.map(() => '?').join(',')
            const [targets] = await run(`SELECT id FROM period_review_cases
              WHERE period_type = 'monthly' AND period_key = ? AND user_id = ?
                AND trading_account_id IN (${placeholders}) AND strategy_id = ? AND status <> 'superseded'
              ORDER BY CASE WHEN status = 'approved' THEN 0 WHEN current_version_id IS NOT NULL THEN 1 ELSE 2 END,
                updated_at DESC, id DESC LIMIT 1 FOR UPDATE`, [legacyCase.period_key, legacyCase.user_id,
              ...accountIds, legacyCase.strategy_id])
            replacementCaseId = Number(targets[0]?.id || 0) || null
          }

          const now = beijingNow()
          await run(`UPDATE period_review_cases SET status = 'superseded', strategy_compatibility_hash = NULL,
            superseded_by_case_id = ?, superseded_reason = 'legacy_cross_account_monthly', updated_at = ?
            WHERE id = ?`, [replacementCaseId, now, legacyCase.id])
          await run(`UPDATE period_review_jobs SET status = 'skipped', progress_stage = 'skipped', stage_updated_at = ?,
            last_error_code = 'superseded_by_account_scoped_review', lease_token = NULL, lease_expires_at = NULL,
            next_attempt_at = NULL, completed_at = COALESCE(completed_at, ?), updated_at = ?
            WHERE period_case_id = ? AND status IN ('queued', 'leased')`, [now, now, now, legacyCase.id])
          await run(`UPDATE period_review_derivation_jobs SET status = 'superseded',
            last_error_code = 'superseded_by_account_scoped_review', lease_token = NULL, lease_expires_at = NULL,
            next_attempt_at = NULL, updated_at = ?
            WHERE period_case_id = ? AND status IN ('queued', 'leased', 'paused')`, [now, legacyCase.id])
        })
      }
    }
  },
  {
    id: '159_terminal_event_clock_evidence',
    async up() {
      const additions = {
        ai_signals:[
          ['created_at_utc_msc', 'BIGINT DEFAULT NULL AFTER pending_ticket'],
          ['terminal_timezone_offset_minutes', 'SMALLINT DEFAULT NULL AFTER created_at_utc_msc'],
          ['terminal_clock_status', 'VARCHAR(32) DEFAULT NULL AFTER terminal_timezone_offset_minutes'],
          ['terminal_clock_source', 'VARCHAR(64) DEFAULT NULL AFTER terminal_clock_status'],
        ],
        trade_audit_logs:[
          ['trading_account_id', 'INT DEFAULT NULL AFTER status'],
          ['created_at_utc_msc', 'BIGINT DEFAULT NULL AFTER trading_account_id'],
          ['terminal_timezone_offset_minutes', 'SMALLINT DEFAULT NULL AFTER created_at_utc_msc'],
          ['terminal_clock_status', 'VARCHAR(32) DEFAULT NULL AFTER terminal_timezone_offset_minutes'],
          ['terminal_clock_source', 'VARCHAR(64) DEFAULT NULL AFTER terminal_clock_status'],
        ],
      }
      for (const [table, columns] of Object.entries(additions)) {
        const existing = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`, [table])
        const names = new Set(existing.map(row => row.COLUMN_NAME))
        for (const [name, definition] of columns) {
          if (!names.has(name)) await queryRun(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
        }
        await queryRun(`UPDATE ${table}
          SET created_at_utc_msc = TIMESTAMPDIFF(MICROSECOND, '1970-01-01 08:00:00', created_at) DIV 1000
          WHERE created_at_utc_msc IS NULL AND created_at IS NOT NULL`)
      }
      const indexes = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trade_audit_logs'
          AND INDEX_NAME = 'idx_trade_audit_account_time'`)
      if (!indexes.length) {
        await queryRun(`CREATE INDEX idx_trade_audit_account_time
          ON trade_audit_logs (user_id, trading_account_id, created_at_utc_msc)`)
      }
    }
  },
  {
    id: '160_backfill_recent_signal_terminal_clock',
    async up() {
      const recent = await queryAll(`SELECT id,
          COALESCE(
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.M5.klines[0].time_server_msc')),
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.M15.klines[0].time_server_msc')),
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.H1.klines[0].time_server_msc')),
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.H4.klines[0].time_server_msc'))
          ) AS server_0,
          COALESCE(
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.M5.klines[0].time_utc_msc')),
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.M15.klines[0].time_utc_msc')),
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.H1.klines[0].time_utc_msc')),
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.H4.klines[0].time_utc_msc'))
          ) AS utc_0,
          COALESCE(
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.M5.klines[1].time_server_msc')),
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.M15.klines[1].time_server_msc')),
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.H1.klines[1].time_server_msc')),
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.H4.klines[1].time_server_msc'))
          ) AS server_1,
          COALESCE(
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.M5.klines[1].time_utc_msc')),
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.M15.klines[1].time_utc_msc')),
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.H1.klines[1].time_utc_msc')),
            JSON_UNQUOTE(JSON_EXTRACT(market_data_json, '$.strategy_context.timeframes.H4.klines[1].time_utc_msc'))
          ) AS utc_1
        FROM (SELECT id, market_data_json FROM ai_signals
          WHERE terminal_timezone_offset_minutes IS NULL AND JSON_VALID(market_data_json)
          ORDER BY id DESC LIMIT 500) recent`)
      for (const row of recent) {
        const offset = terminalOffsetFromClockPairs([
          { time_server_msc:row.server_0, time_utc_msc:row.utc_0 },
          { time_server_msc:row.server_1, time_utc_msc:row.utc_1 },
        ])
        if (offset == null) continue
        await queryRun(`UPDATE ai_signals SET terminal_timezone_offset_minutes = ?,
          terminal_clock_status = 'snapshot_pair_verified',
          terminal_clock_source = 'legacy_signal_market_snapshot'
          WHERE id = ? AND terminal_timezone_offset_minutes IS NULL`, [offset, row.id])
      }
    }
  },
  {
    id: '161_model_usage_completion_evidence',
    async up() {
      const wanted = {
        input_tokens:'INT NOT NULL DEFAULT 0',
        output_tokens:'INT NOT NULL DEFAULT 0',
        reasoning_tokens:'INT NOT NULL DEFAULT 0',
        cached_tokens:'INT NOT NULL DEFAULT 0',
        provider_request_id:'VARCHAR(191) DEFAULT NULL',
        finish_reason:'VARCHAR(64) DEFAULT NULL',
        incomplete_details_json:'TEXT DEFAULT NULL',
        accounting_status:"VARCHAR(24) NOT NULL DEFAULT 'estimated'",
      }
      const columns = new Set((await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_model_usage_logs'`)).map(row => row.COLUMN_NAME))
      for (const [name, definition] of Object.entries(wanted)) {
        if (!columns.has(name)) await queryRun(`ALTER TABLE ai_model_usage_logs ADD COLUMN ${name} ${definition}`)
      }
      const indexes = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_model_usage_logs'
          AND INDEX_NAME = 'idx_usage_provider_request'`)
      if (!indexes.length) {
        await queryRun('CREATE INDEX idx_usage_provider_request ON ai_model_usage_logs (provider_request_id)')
      }
    }
  },
  {
    id: '162_model_task_runtime_envelope',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_model_tasks (
        task_id CHAR(36) PRIMARY KEY,
        task_kind VARCHAR(48) NOT NULL,
        queue_class VARCHAR(24) NOT NULL DEFAULT 'background',
        owner_user_id INT NOT NULL DEFAULT 0,
        strategy_id INT DEFAULT NULL,
        domain_type VARCHAR(48) DEFAULT NULL,
        domain_id VARCHAR(191) DEFAULT NULL,
        idempotency_key VARCHAR(191) DEFAULT NULL,
        snapshot_hash CHAR(64) DEFAULT NULL,
        input_hash CHAR(64) DEFAULT NULL,
        prompt_hash CHAR(64) DEFAULT NULL,
        output_contract_hash CHAR(64) DEFAULT NULL,
        frozen_provider VARCHAR(64) DEFAULT NULL,
        frozen_model VARCHAR(191) DEFAULT NULL,
        frozen_model_profile_id INT DEFAULT NULL,
        frozen_protocol VARCHAR(32) DEFAULT NULL,
        frozen_credential_source VARCHAR(32) DEFAULT NULL,
        frozen_context_json LONGTEXT DEFAULT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'queued',
        priority INT NOT NULL DEFAULT 0,
        attempt_count INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 1,
        scheduled_at_utc_msc BIGINT NOT NULL,
        task_deadline_at_utc_msc BIGINT DEFAULT NULL,
        result_valid_until_utc_msc BIGINT DEFAULT NULL,
        lease_token CHAR(36) DEFAULT NULL,
        fencing_token BIGINT NOT NULL DEFAULT 0,
        lease_owner VARCHAR(191) DEFAULT NULL,
        lease_expires_at_utc_msc BIGINT DEFAULT NULL,
        last_activity_at_utc_msc BIGINT DEFAULT NULL,
        estimated_input_tokens INT NOT NULL DEFAULT 0,
        selected_output_budget INT NOT NULL DEFAULT 0,
        schema_need_tokens INT NOT NULL DEFAULT 0,
        context_window_tokens INT DEFAULT NULL,
        provider_output_cap INT DEFAULT NULL,
        result_ref VARCHAR(255) DEFAULT NULL,
        result_hash CHAR(64) DEFAULT NULL,
        finish_reason VARCHAR(64) DEFAULT NULL,
        incomplete_details_json TEXT DEFAULT NULL,
        error_code VARCHAR(128) DEFAULT NULL,
        error_message VARCHAR(512) DEFAULT NULL,
        completed_at_utc_msc BIGINT DEFAULT NULL,
        created_at_utc_msc BIGINT NOT NULL,
        updated_at_utc_msc BIGINT NOT NULL,
        UNIQUE KEY uk_model_task_idempotency (task_kind, idempotency_key),
        KEY idx_model_task_claim (queue_class, status, priority, scheduled_at_utc_msc),
        KEY idx_model_task_lease (status, lease_expires_at_utc_msc),
        KEY idx_model_task_owner (owner_user_id, created_at_utc_msc)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_model_task_attempts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        task_id CHAR(36) NOT NULL,
        attempt_no INT NOT NULL,
        fencing_token BIGINT NOT NULL,
        provider_request_id VARCHAR(191) DEFAULT NULL,
        provider_idempotency_key VARCHAR(191) DEFAULT NULL,
        status VARCHAR(32) NOT NULL,
        request_started_at_utc_msc BIGINT DEFAULT NULL,
        first_byte_at_utc_msc BIGINT DEFAULT NULL,
        response_received_at_utc_msc BIGINT DEFAULT NULL,
        last_activity_at_utc_msc BIGINT DEFAULT NULL,
        request_bytes BIGINT NOT NULL DEFAULT 0,
        response_bytes BIGINT NOT NULL DEFAULT 0,
        input_tokens INT NOT NULL DEFAULT 0,
        output_tokens INT NOT NULL DEFAULT 0,
        reasoning_tokens INT NOT NULL DEFAULT 0,
        cached_tokens INT NOT NULL DEFAULT 0,
        total_tokens INT NOT NULL DEFAULT 0,
        finish_reason VARCHAR(64) DEFAULT NULL,
        incomplete_details_json TEXT DEFAULT NULL,
        http_status INT DEFAULT NULL,
        error_code VARCHAR(128) DEFAULT NULL,
        error_message VARCHAR(512) DEFAULT NULL,
        created_at_utc_msc BIGINT NOT NULL,
        updated_at_utc_msc BIGINT NOT NULL,
        UNIQUE KEY uk_model_task_attempt (task_id, attempt_no),
        KEY idx_model_attempt_request (provider_request_id),
        CONSTRAINT fk_model_attempt_task FOREIGN KEY (task_id) REFERENCES ai_model_tasks(task_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_model_task_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        task_id CHAR(36) NOT NULL,
        attempt_id BIGINT DEFAULT NULL,
        event_type VARCHAR(64) NOT NULL,
        payload_json TEXT DEFAULT NULL,
        created_at_utc_msc BIGINT NOT NULL,
        KEY idx_model_event_task (task_id, id),
        CONSTRAINT fk_model_event_task FOREIGN KEY (task_id) REFERENCES ai_model_tasks(task_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_model_provider_capabilities (
        model_profile_id INT PRIMARY KEY,
        supports_stream TINYINT NOT NULL DEFAULT 0,
        supports_request_id TINYINT NOT NULL DEFAULT 0,
        supports_poll TINYINT NOT NULL DEFAULT 0,
        supports_cancel TINYINT NOT NULL DEFAULT 0,
        supports_idempotency TINYINT NOT NULL DEFAULT 0,
        supports_structured_output TINYINT NOT NULL DEFAULT 0,
        supports_usage_split TINYINT NOT NULL DEFAULT 0,
        context_window_tokens INT DEFAULT NULL,
        max_output_tokens INT DEFAULT NULL,
        verification_status VARCHAR(24) NOT NULL DEFAULT 'unverified',
        verified_by_user_id INT DEFAULT NULL,
        verified_at_utc_msc BIGINT DEFAULT NULL,
        updated_at_utc_msc BIGINT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      const linkedTables = ['period_review_jobs', 'trade_review_jobs', 'memory_compression_jobs', 'ai_model_compare_jobs']
      for (const table of linkedTables) {
        const columns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'model_task_id'`, [table])
        if (!columns.length) await queryRun(`ALTER TABLE ${table} ADD COLUMN model_task_id CHAR(36) DEFAULT NULL`)
      }
      const signalColumns = await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_signals' AND COLUMN_NAME = 'inference_task_id'`)
      if (!signalColumns.length) await queryRun('ALTER TABLE ai_signals ADD COLUMN inference_task_id CHAR(36) DEFAULT NULL')
      const signalIndexes = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_signals' AND INDEX_NAME = 'uk_ai_signal_inference_task'`)
      if (!signalIndexes.length) await queryRun('CREATE UNIQUE INDEX uk_ai_signal_inference_task ON ai_signals (inference_task_id)')
    }
  },
  {
    id: '163_model_compare_checkpoints',
    async up() {
      const jobColumns = new Set((await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_model_compare_jobs'`)).map(row => row.COLUMN_NAME))
      if (!jobColumns.has('checkpoint_manifest_json')) {
        await queryRun('ALTER TABLE ai_model_compare_jobs ADD COLUMN checkpoint_manifest_json LONGTEXT DEFAULT NULL AFTER params_json')
      }
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_model_compare_checkpoints (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_id CHAR(36) NOT NULL,
        model_id INT NOT NULL,
        unit_key VARCHAR(191) NOT NULL,
        unit_index INT NOT NULL,
        checkpoint_status VARCHAR(24) NOT NULL DEFAULT 'completed',
        error_code VARCHAR(128) DEFAULT NULL,
        decision_time_utc_msc BIGINT NOT NULL,
        outcome_time_utc_msc BIGINT DEFAULT NULL,
        snapshot_id BIGINT DEFAULT NULL,
        strategy_fingerprint CHAR(64) NOT NULL,
        prompt_hash CHAR(64) NOT NULL,
        snapshot_fingerprint CHAR(64) DEFAULT NULL,
        model_config_fingerprint CHAR(64) NOT NULL,
        output_contract_hash CHAR(64) NOT NULL,
        market_evidence_hash CHAR(64) NOT NULL,
        result_json LONGTEXT DEFAULT NULL,
        telemetry_json TEXT DEFAULT NULL,
        input_evidence_json TEXT DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_model_compare_checkpoint (job_id, model_id, unit_key),
        KEY idx_model_compare_checkpoint_job (job_id, unit_index)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      const checkpointColumns = new Set((await queryAll(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_model_compare_checkpoints'`)).map(row => row.COLUMN_NAME))
      if (!checkpointColumns.has('checkpoint_status')) {
        await queryRun("ALTER TABLE ai_model_compare_checkpoints ADD COLUMN checkpoint_status VARCHAR(24) NOT NULL DEFAULT 'completed' AFTER unit_index")
        if (checkpointColumns.has('status')) {
          await queryRun("UPDATE ai_model_compare_checkpoints SET checkpoint_status = status WHERE status IN ('submitting','completed','failed')")
        }
      }
      if (!checkpointColumns.has('error_code')) {
        await queryRun("ALTER TABLE ai_model_compare_checkpoints ADD COLUMN error_code VARCHAR(128) DEFAULT NULL AFTER checkpoint_status")
      }
      const resultColumn = (await queryAll(`SELECT IS_NULLABLE FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_model_compare_checkpoints'
          AND COLUMN_NAME = 'result_json'`))[0]
      if (resultColumn?.IS_NULLABLE === 'NO') {
        await queryRun('ALTER TABLE ai_model_compare_checkpoints MODIFY COLUMN result_json LONGTEXT DEFAULT NULL')
      }
    }
  },
  {
    id: '164_manual_analysis_jobs',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_manual_analysis_jobs (
        job_id CHAR(36) PRIMARY KEY,
        user_id INT NOT NULL,
        strategy_id INT NOT NULL,
        strategy_version INT NOT NULL DEFAULT 1,
        strategy_prompt_hash CHAR(64) NOT NULL,
        request_hash CHAR(64) NOT NULL,
        params_json LONGTEXT NOT NULL,
        model_task_id CHAR(36) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'queued',
        stage VARCHAR(48) NOT NULL DEFAULT 'queued',
        result_json LONGTEXT DEFAULT NULL,
        signal_id BIGINT DEFAULT NULL,
        error_code VARCHAR(128) DEFAULT NULL,
        error_message VARCHAR(512) DEFAULT NULL,
        cancel_requested TINYINT NOT NULL DEFAULT 0,
        lease_token CHAR(36) DEFAULT NULL,
        fencing_token BIGINT NOT NULL DEFAULT 0,
        deadline_at_utc_msc BIGINT NOT NULL,
        completed_at_utc_msc BIGINT DEFAULT NULL,
        created_at_utc_msc BIGINT NOT NULL,
        updated_at_utc_msc BIGINT NOT NULL,
        UNIQUE KEY uk_manual_analysis_model_task (model_task_id),
        KEY idx_manual_analysis_user_created (user_id, created_at_utc_msc),
        KEY idx_manual_analysis_status (status, updated_at_utc_msc),
        CONSTRAINT fk_manual_analysis_model_task FOREIGN KEY (model_task_id) REFERENCES ai_model_tasks(task_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '165_monthly_review_chunk_checkpoints',
    async up() {
      // Monthly chunks are an isolated, append-preserving execution ledger.
      // Existing period-review jobs/evidence require no backfill: the next
      // monthly run materializes its own frozen evidence revision.
      await queryRun(`CREATE TABLE IF NOT EXISTS period_review_monthly_checkpoints (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        period_review_job_id BIGINT NOT NULL,
        evidence_hash CHAR(64) NOT NULL,
        source_hash CHAR(64) NOT NULL,
        chunk_index INT NOT NULL,
        chunk_count INT NOT NULL,
        max_days INT NOT NULL DEFAULT 8,
        expected_period_case_ids_json TEXT NOT NULL,
        expected_ids_hash CHAR(64) NOT NULL,
        sources_json LONGTEXT NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'queued',
        attempt_count INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        next_attempt_at_utc_msc BIGINT DEFAULT NULL,
        model_task_id CHAR(36) DEFAULT NULL,
        lease_token CHAR(36) DEFAULT NULL,
        lease_owner VARCHAR(191) DEFAULT NULL,
        fencing_token BIGINT NOT NULL DEFAULT 0,
        lease_expires_at_utc_msc BIGINT DEFAULT NULL,
        content_json LONGTEXT DEFAULT NULL,
        content_hash CHAR(64) DEFAULT NULL,
        reused_from_checkpoint_id BIGINT DEFAULT NULL,
        error_code VARCHAR(128) DEFAULT NULL,
        error_message VARCHAR(512) DEFAULT NULL,
        superseded_reason VARCHAR(128) DEFAULT NULL,
        completed_at_utc_msc BIGINT DEFAULT NULL,
        created_at_utc_msc BIGINT NOT NULL,
        updated_at_utc_msc BIGINT NOT NULL,
        UNIQUE KEY uk_monthly_review_checkpoint_key (period_review_job_id, evidence_hash, chunk_index),
        KEY idx_monthly_review_checkpoint_claim (period_review_job_id, status, lease_expires_at_utc_msc, chunk_index),
        KEY idx_monthly_review_checkpoint_evidence (period_review_job_id, evidence_hash, chunk_index),
        KEY idx_monthly_review_checkpoint_model_task (model_task_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '166_model_task_capacity_reservations',
    async up() {
      // Capacity policy is durable and database-configured. The default row is
      // intentionally conservative; profile rows may override individual
      // nullable fields without changing the shared default.
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_model_capacity_policies (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        policy_scope VARCHAR(16) NOT NULL DEFAULT 'default',
        model_profile_id BIGINT NOT NULL DEFAULT 0,
        max_concurrency INT DEFAULT NULL,
        reserve_execution_critical_slots INT DEFAULT NULL,
        background_per_user_cap INT DEFAULT NULL,
        lease_ms INT DEFAULT NULL,
        conservative_lease_ms INT DEFAULT NULL,
        waiter_poll_ms INT DEFAULT NULL,
        starvation_age_ms INT DEFAULT NULL,
        enabled TINYINT NOT NULL DEFAULT 1,
        created_at_utc_msc BIGINT NOT NULL,
        updated_at_utc_msc BIGINT NOT NULL,
        UNIQUE KEY uk_model_capacity_policy_scope_profile (policy_scope, model_profile_id),
        KEY idx_model_capacity_policy_profile (model_profile_id, enabled)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_model_capacity_waiters (
        waiter_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        owner_token CHAR(36) NOT NULL,
        model_task_id CHAR(36) DEFAULT NULL,
        model_profile_id BIGINT DEFAULT NULL,
        user_id INT DEFAULT NULL,
        usage_kind VARCHAR(32) NOT NULL,
        queue_class VARCHAR(32) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'waiting',
        lease_id CHAR(36) DEFAULT NULL,
        requested_at_utc_msc BIGINT NOT NULL,
        deadline_at_utc_msc BIGINT DEFAULT NULL,
        granted_at_utc_msc BIGINT DEFAULT NULL,
        cancelled_at_utc_msc BIGINT DEFAULT NULL,
        created_at_utc_msc BIGINT NOT NULL,
        updated_at_utc_msc BIGINT NOT NULL,
        UNIQUE KEY uk_model_capacity_waiter_owner (owner_token),
        KEY idx_model_capacity_waiter_queue (status, requested_at_utc_msc, waiter_id),
        KEY idx_model_capacity_waiter_task (model_task_id, status),
        KEY idx_model_capacity_waiter_deadline (status, deadline_at_utc_msc)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      await queryRun(`CREATE TABLE IF NOT EXISTS ai_model_capacity_leases (
        lease_id CHAR(36) PRIMARY KEY,
        owner_token CHAR(36) NOT NULL,
        waiter_id BIGINT DEFAULT NULL,
        model_task_id CHAR(36) DEFAULT NULL,
        model_profile_id BIGINT DEFAULT NULL,
        user_id INT DEFAULT NULL,
        usage_kind VARCHAR(32) NOT NULL,
        queue_class VARCHAR(32) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        acquired_at_utc_msc BIGINT NOT NULL,
        lease_expires_at_utc_msc BIGINT NOT NULL,
        conservative_until_utc_msc BIGINT DEFAULT NULL,
        release_reason VARCHAR(128) DEFAULT NULL,
        released_at_utc_msc BIGINT DEFAULT NULL,
        created_at_utc_msc BIGINT NOT NULL,
        updated_at_utc_msc BIGINT NOT NULL,
        UNIQUE KEY uk_model_capacity_lease_owner (lease_id, owner_token),
        KEY idx_model_capacity_lease_active (status, lease_expires_at_utc_msc),
        KEY idx_model_capacity_lease_profile (model_profile_id, status, lease_expires_at_utc_msc),
        KEY idx_model_capacity_lease_user_queue (user_id, queue_class, status, lease_expires_at_utc_msc),
        KEY idx_model_capacity_lease_task (model_task_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      const now = Date.now()
      await queryRun(`INSERT INTO ai_model_capacity_policies
        (policy_scope, model_profile_id, max_concurrency,
         reserve_execution_critical_slots, background_per_user_cap,
         lease_ms, conservative_lease_ms, waiter_poll_ms, starvation_age_ms,
         enabled, created_at_utc_msc, updated_at_utc_msc)
        VALUES ('default', 0, 4, 1, 1, 120000, 300000, 250, 5000, 1, ?, ?)
        ON DUPLICATE KEY UPDATE updated_at_utc_msc = updated_at_utc_msc`, [now, now])
    }
  },
  {
    id: '167_bridge_v3_command_envelope_hash',
    async up() {
      const columns = await queryAll(`SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bridge_v3_command_ledger'
          AND COLUMN_NAME = 'envelope_hash'`)
      if (!columns.length) await queryRun(
        'ALTER TABLE bridge_v3_command_ledger ADD COLUMN envelope_hash CHAR(64) DEFAULT NULL AFTER payload_hash'
      )
    }
  },
  {
    id: '168_model_usage_request_phase',
    async up() {
      const columns = await queryAll(`SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_model_usage_logs'
          AND COLUMN_NAME = 'request_phase'`)
      if (!columns.length) {
        await queryRun("ALTER TABLE ai_model_usage_logs ADD COLUMN request_phase VARCHAR(16) NOT NULL DEFAULT 'request' AFTER `usage`")
      }
    }
  },
  {
    id: '169_bridge_v3_command_retention_index',
    async up() {
      const indexes = await queryAll(`SELECT INDEX_NAME
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bridge_v3_command_ledger'
          AND INDEX_NAME = 'idx_bridge_v3_command_retention' LIMIT 1`)
      if (!indexes.length) await queryRun(`ALTER TABLE bridge_v3_command_ledger
        ADD KEY idx_bridge_v3_command_retention (status, completed_at_utc_msc, command_id)`)
    }
  },
  {
    id: '170_remove_legacy_bridge_connection_status',
    async up() {
      // Bridge V3 terminal sessions are now the sole connection authority.
      // This legacy table contained only ephemeral online status.
      await queryRun('DROP TABLE IF EXISTS bridge_connection_status')
    }
  },
  {
    id: '171_model_driven_pending_inventory',
    async up() {
      const schemas = await queryAll('SELECT id, schema_json FROM ai_signal_schema WHERE is_active = 1')
      for (const row of schemas) {
        let schema
        try {
          schema = JSON.parse(row.schema_json || '{}')
        } catch {
          throw new Error(`Active AI signal schema ${row.id} contains invalid JSON`)
        }
        const updated = applyModelDrivenPendingSchema(schema)
        await queryRun(
          'UPDATE ai_signal_schema SET schema_json = ?, updated_at = NOW() WHERE id = ?',
          [JSON.stringify(updated, null, 2), row.id]
        )
      }
    }
  },
  {
    id: '172_expand_position_management_bridge_command_id',
    async up() {
      const columns = await queryAll(`SELECT COLUMN_NAME, CHARACTER_MAXIMUM_LENGTH
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_position_management_commands'
          AND COLUMN_NAME = 'bridge_command_id'`)
      const column = columns?.[0]
      if (!column) {
        await queryRun('ALTER TABLE ai_position_management_commands ADD COLUMN bridge_command_id VARCHAR(128) DEFAULT NULL')
      } else if (Number(column.CHARACTER_MAXIMUM_LENGTH) < 128) {
        await queryRun('ALTER TABLE ai_position_management_commands MODIFY COLUMN bridge_command_id VARCHAR(128) DEFAULT NULL')
      }
    }
  },
  {
    id: '173_remove_database_ai_signal_schema',
    async up() {
      // Output contracts are now versioned in llm.js. The old mutable table
      // must not remain an alternate source of model instructions.
      await queryRun('DROP TABLE IF EXISTS ai_signal_schema')
    }
  },
  {
    id: '174_unified_media_storage_foundation',
    async up() {
      // New storage facts are append-only. Existing upload tables and paths
      // remain readable and are intentionally not backfilled here.
      await queryRun(`CREATE TABLE IF NOT EXISTS stored_files (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        purpose VARCHAR(24) NOT NULL,
        storage_provider VARCHAR(16) NOT NULL,
        object_key VARCHAR(512) NOT NULL,
        original_name VARCHAR(255) NOT NULL DEFAULT '',
        mime_type VARCHAR(128) NOT NULL DEFAULT '',
        extension VARCHAR(32) NOT NULL DEFAULT '',
        size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        sha256 CHAR(64) DEFAULT NULL,
        visibility VARCHAR(24) NOT NULL DEFAULT 'authenticated',
        owner_type VARCHAR(48) DEFAULT NULL,
        owner_id BIGINT UNSIGNED DEFAULT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'uploading',
        created_by INT DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at DATETIME DEFAULT NULL,
        UNIQUE KEY uk_stored_files_provider_object (storage_provider, object_key),
        KEY idx_stored_files_purpose_status (purpose, status, created_at),
        KEY idx_stored_files_owner (owner_type, owner_id, status),
        KEY idx_stored_files_provider_status (storage_provider, status, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      const configs = [
        ['media_storage', 'default_provider', 'local', '默认存储位置（初始本地，连接后可启用七牛）', 0],
        ['media_storage', 'video_provider', 'inherit', '课程视频存储位置', 1],
        ['media_storage', 'attachment_provider', 'inherit', '课程附件存储位置', 2],
        ['media_storage', 'image_provider', 'inherit', '图片存储位置', 3],
        ['media_storage', 'resource_provider', 'inherit', '其他资源存储位置', 4],
        ['media_storage', 'local_root', '', '本地存储目录（只读）', 5],
        ['media_storage', 'qiniu_connection_test_version', '', '七牛连接测试配置版本（只读）', 6],
        ['media_storage', 'qiniu_connection_test_status', 'not_tested', '七牛连接测试状态（只读）', 7],
        ['media_storage', 'qiniu_connection_test_stage', '', '七牛连接测试阶段（只读）', 8],
        ['media_storage', 'qiniu_connection_tested_at', '', '七牛连接测试时间（只读）', 9],
        ['media_storage', 'qiniu_connection_test_error', '', '七牛连接测试安全错误（只读）', 10],
        ['media_storage', 'qiniu_connection_test_cleanup_pending', 'false', '七牛测试对象待清理（只读）', 11],
        ['qiniu', 'private_bucket', 'true', '私有空间（系统固定）', 5],
      ]
      for (const [category, key, value, label, sortOrder] of configs) {
        await queryRun(
          'INSERT IGNORE INTO system_config (category, `key`, `value`, label, sort_order) VALUES (?, ?, ?, ?, ?)',
          [category, key, value, label, sortOrder],
        )
      }
    }
  },
  {
    id: '175_unified_media_business_links',
    async up() {
      // Phase 2/3 links are nullable by design. Legacy URLs and
      // course-attachment:// records remain the read fallback until a
      // business row is explicitly written with a stored_file_id.
      for (const table of ['course_resources', 'post_assets']) {
        const column = await queryAll(
          'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = \'stored_file_id\'',
          [table],
        )
        if (!column.length) {
          await queryRun(`ALTER TABLE ${table} ADD COLUMN stored_file_id BIGINT UNSIGNED DEFAULT NULL`)
        }
      }
      const indexes = [
        ['course_resources', 'idx_course_resources_stored_file', 'stored_file_id'],
        ['post_assets', 'idx_post_assets_stored_file', 'stored_file_id'],
      ]
      for (const [table, indexName, column] of indexes) {
        const existing = await queryAll(
          'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
          [table, indexName],
        )
        if (!existing.length) await queryRun(`ALTER TABLE ${table} ADD INDEX ${indexName} (${column})`)
      }
      // Direct-upload state contains no credentials or signed URLs. It is
      // intentionally a small, append-only coordination record; expiry and
      // status make stale browser sessions harmless.
      await queryRun(`CREATE TABLE IF NOT EXISTS storage_upload_sessions (
        id CHAR(36) PRIMARY KEY,
        stored_file_id BIGINT UNSIGNED NOT NULL,
        provider VARCHAR(16) NOT NULL,
        purpose VARCHAR(24) NOT NULL,
        object_key VARCHAR(512) NOT NULL,
        original_name VARCHAR(255) NOT NULL DEFAULT '',
        mime_type VARCHAR(128) NOT NULL DEFAULT '',
        size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
        owner_type VARCHAR(48) DEFAULT NULL,
        owner_id BIGINT UNSIGNED DEFAULT NULL,
        created_by INT DEFAULT NULL,
        config_version CHAR(64) DEFAULT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        expires_at DATETIME NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        confirmed_at DATETIME DEFAULT NULL,
        KEY idx_storage_upload_sessions_status (status, expires_at),
        KEY idx_storage_upload_sessions_stored_file (stored_file_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '176_unified_video_storage_links',
    async up() {
      // Managed video links are nullable so legacy Bilibili/YouTube,
      // local-path, and qiniu-key rows remain readable without a backfill.
      const columns = await queryAll(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'video_streams\' AND COLUMN_NAME IN (\'stored_file_id\', \'video_source\')',
      )
      const names = new Set(columns.map(row => row.COLUMN_NAME))
      if (!names.has('stored_file_id')) {
        await queryRun('ALTER TABLE video_streams ADD COLUMN stored_file_id BIGINT UNSIGNED DEFAULT NULL')
      }
      if (!names.has('video_source')) {
        await queryRun("ALTER TABLE video_streams ADD COLUMN video_source VARCHAR(24) DEFAULT NULL")
      }
      const indexes = [
        ['idx_video_streams_stored_file', 'stored_file_id'],
        ['idx_video_streams_source_episode', 'video_source, episode_id'],
      ]
      for (const [indexName, expression] of indexes) {
        const existing = await queryAll(
          'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = \'video_streams\' AND INDEX_NAME = ?',
          [indexName],
        )
        if (!existing.length) await queryRun(`ALTER TABLE video_streams ADD INDEX ${indexName} (${expression})`)
      }
    }
  },
  {
    id: '177_notification_center',
    async up() {
      // The notification center extends the legacy notifications table while
      // preserving its is_read/dedupe_key contract.  Every ALTER is guarded
      // by information_schema so a partially applied deployment can safely
      // resume without relying on duplicate-column errors.
      const columns = await queryAll(`SELECT COLUMN_NAME
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications'`)
      const names = new Set(columns.map(row => row.COLUMN_NAME))
      const additions = [
        ['campaign_id', 'BIGINT UNSIGNED DEFAULT NULL AFTER dedupe_key'],
        ['priority', "VARCHAR(16) NOT NULL DEFAULT 'normal' AFTER message"],
        ['requires_ack', 'TINYINT NOT NULL DEFAULT 0 AFTER priority'],
        ['read_at', 'DATETIME DEFAULT NULL AFTER is_read'],
        ['acknowledged_at', 'DATETIME DEFAULT NULL AFTER read_at'],
      ]
      for (const [name, definition] of additions) {
        if (!names.has(name)) await queryRun(`ALTER TABLE notifications ADD COLUMN ${name} ${definition}`)
      }

      const notificationIndexes = [
        ['idx_notifications_user_read_created', 'user_id, is_read, created_at'],
        ['idx_notifications_campaign_user', 'campaign_id, user_id'],
        ['idx_notifications_user_state', 'user_id, requires_ack, acknowledged_at, created_at'],
      ]
      for (const [indexName, expression] of notificationIndexes) {
        const existing = await queryAll(`SELECT INDEX_NAME
          FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'notifications' AND INDEX_NAME = ?`, [indexName])
        if (!existing.length) await queryRun(`ALTER TABLE notifications ADD KEY ${indexName} (${expression})`)
      }

      await queryRun(`CREATE TABLE IF NOT EXISTS notification_campaigns (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(100) NOT NULL,
        message VARCHAR(1000) NOT NULL,
        priority VARCHAR(16) NOT NULL DEFAULT 'normal',
        requires_ack TINYINT NOT NULL DEFAULT 0,
        link VARCHAR(500) DEFAULT NULL,
        recipient_scope VARCHAR(16) NOT NULL,
        recipient_filter_json MEDIUMTEXT NOT NULL,
        preview_recipient_count INT NOT NULL DEFAULT 0,
        recipient_count INT NOT NULL DEFAULT 0,
        in_app_enabled TINYINT NOT NULL DEFAULT 1,
        email_enabled TINYINT NOT NULL DEFAULT 0,
        in_app_sent_count INT NOT NULL DEFAULT 0,
        email_sent_count INT NOT NULL DEFAULT 0,
        email_failed_count INT NOT NULL DEFAULT 0,
        email_skipped_count INT NOT NULL DEFAULT 0,
        status VARCHAR(24) NOT NULL DEFAULT 'queued',
        created_by INT NOT NULL,
        idempotency_key VARCHAR(191) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME DEFAULT NULL,
        completed_at DATETIME DEFAULT NULL,
        cancelled_at DATETIME DEFAULT NULL,
        last_error VARCHAR(500) DEFAULT NULL,
        UNIQUE KEY uk_notification_campaign_idempotency (created_by, idempotency_key),
        KEY idx_notification_campaign_status (status, created_at),
        KEY idx_notification_campaign_creator (created_by, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS notification_deliveries (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        campaign_id BIGINT UNSIGNED NOT NULL,
        user_id INT NOT NULL,
        notification_id INT DEFAULT NULL,
        channel VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempt_count INT NOT NULL DEFAULT 0,
        next_attempt_at DATETIME DEFAULT NULL,
        sent_at DATETIME DEFAULT NULL,
        read_at DATETIME DEFAULT NULL,
        acknowledged_at DATETIME DEFAULT NULL,
        message_id VARCHAR(255) DEFAULT NULL,
        provider_response_summary VARCHAR(500) DEFAULT NULL,
        last_error VARCHAR(500) DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_notification_delivery (campaign_id, user_id, channel),
        KEY idx_notification_delivery_ready (channel, status, next_attempt_at, id),
        KEY idx_notification_delivery_campaign (campaign_id, channel, status),
        KEY idx_notification_delivery_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      // Create/cancel/retry are separate idempotency operations.  Keeping
      // keys out of audit detail prevents request tokens from being logged.
      await queryRun(`CREATE TABLE IF NOT EXISTS notification_idempotency_keys (
        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        actor_user_id INT NOT NULL,
        operation VARCHAR(32) NOT NULL,
        idempotency_key VARCHAR(191) NOT NULL,
        campaign_id BIGINT UNSIGNED NOT NULL,
        response_json MEDIUMTEXT DEFAULT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_notification_idempotency (actor_user_id, operation, idempotency_key),
        KEY idx_notification_idempotency_campaign (campaign_id, operation)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '178_manual_trade_strategy_review',
    async up() {
      // Manual strategy review is an append-only evidence contract. It does
      // not reuse trade_review_* rows, which are tied to AI signal outcomes.
      await queryRun(`CREATE TABLE IF NOT EXISTS manual_trade_review_cases (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        client_request_id VARCHAR(191) NOT NULL,
        user_id INT NOT NULL,
        trading_account_id INT NOT NULL,
        strategy_id BIGINT UNSIGNED NOT NULL,
        strategy_version INT NOT NULL,
        strategy_scope VARCHAR(16) NOT NULL DEFAULT 'platform',
        strategy_snapshot_json MEDIUMTEXT NOT NULL,
        strategy_snapshot_hash CHAR(64) NOT NULL,
        user_thesis_text TEXT DEFAULT NULL,
        user_thesis_hash CHAR(64) DEFAULT NULL,
        selection_hash CHAR(64) NOT NULL,
        evidence_json MEDIUMTEXT DEFAULT NULL,
        evidence_hash CHAR(64) DEFAULT NULL,
        evidence_status VARCHAR(24) NOT NULL DEFAULT 'pending',
        evidence_reason VARCHAR(128) DEFAULT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'evidence_pending',
        current_version_id BIGINT UNSIGNED DEFAULT NULL,
        approved_version_id BIGINT UNSIGNED DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_manual_review_client_request (user_id, client_request_id),
        KEY idx_manual_review_owner_state (user_id, status, updated_at),
        KEY idx_manual_review_account_created (trading_account_id, created_at),
        KEY idx_manual_review_selection (selection_hash)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS manual_trade_review_sources (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        case_id BIGINT UNSIGNED NOT NULL,
        source_identity_hash CHAR(64) NOT NULL,
        trade_source_hash CHAR(64) NOT NULL,
        trading_account_id INT NOT NULL,
        terminal_instance_id VARCHAR(128) NOT NULL,
        broker_server VARCHAR(100) NOT NULL,
        login_account VARCHAR(50) NOT NULL,
        position_id VARCHAR(64) DEFAULT NULL,
        entry_order_ticket VARCHAR(64) DEFAULT NULL,
        entry_time_utc_msc BIGINT DEFAULT NULL,
        close_time_utc_msc BIGINT DEFAULT NULL,
        symbol VARCHAR(64) DEFAULT NULL,
        direction VARCHAR(8) DEFAULT NULL,
        normalized_trade_json MEDIUMTEXT NOT NULL,
        manual_classification_json TEXT NOT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uk_manual_review_source_identity (case_id, source_identity_hash),
        KEY idx_manual_review_source_case (case_id, id),
        KEY idx_manual_review_source_position (trading_account_id, position_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS manual_trade_review_versions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        case_id BIGINT UNSIGNED NOT NULL,
        version_no INT NOT NULL,
        parent_version_id BIGINT UNSIGNED DEFAULT NULL,
        author_type VARCHAR(16) NOT NULL,
        author_user_id INT DEFAULT NULL,
        content_json MEDIUMTEXT NOT NULL,
        content_hash CHAR(64) NOT NULL,
        change_note VARCHAR(500) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uk_manual_review_version (case_id, version_no),
        KEY idx_manual_review_version_case (case_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS manual_trade_review_jobs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        case_id BIGINT UNSIGNED NOT NULL,
        idempotency_key VARCHAR(191) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'queued',
        attempt_count INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        lease_token CHAR(36) DEFAULT NULL,
        lease_expires_at DATETIME DEFAULT NULL,
        model_profile_id BIGINT UNSIGNED DEFAULT NULL,
        credential_source VARCHAR(32) DEFAULT NULL,
        model_task_id VARCHAR(128) DEFAULT NULL,
        progress_stage VARCHAR(32) NOT NULL DEFAULT 'queued',
        stage_updated_at DATETIME DEFAULT NULL,
        last_error_code VARCHAR(128) DEFAULT NULL,
        next_attempt_at DATETIME DEFAULT NULL,
        completed_at DATETIME DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_manual_review_job_key (idempotency_key),
        UNIQUE KEY uk_manual_review_job_case (case_id),
        KEY idx_manual_review_job_claim (status, lease_expires_at, next_attempt_at, updated_at),
        KEY idx_manual_review_job_case (case_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      const sourceIndex = await queryAll(`SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'manual_trade_review_sources'
          AND INDEX_NAME = 'idx_manual_review_source_account'`)
      if (!sourceIndex.length) await queryRun(`ALTER TABLE manual_trade_review_sources
        ADD KEY idx_manual_review_source_account (case_id, broker_server, login_account)`)
    }
  },
  {
    id: '179_history_range_preferences',
    async up() {
      // A saved history start is a query preference, not a rewrite of the
      // binding's first_connected_at or the Bridge coverage facts.  Keep the
      // key tied to the source user and the currently bound trading account;
      // a new account therefore starts with an empty preference.  The scope
      // check is enforced again by the server write path so this table cannot
      // become a generic per-user setting.
      await queryRun(`CREATE TABLE IF NOT EXISTS history_range_preferences (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        trading_account_id INT NOT NULL,
        scope VARCHAR(16) NOT NULL,
        start_date DATE NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_history_range_preference_account_scope (user_id, trading_account_id, scope),
        KEY idx_history_range_preference_account (trading_account_id, user_id, updated_at),
        CONSTRAINT chk_history_range_preference_scope CHECK (scope IN ('all', 'platform'))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
    }
  },
  {
    id: '180_model_physical_token_limits',
    async up() {
      // Token limits are manual model facts and must not share the transport
      // provider verification flag. Keep the old max_tokens profile column as
      // legacy audit data; runtime callers will use these capability fields.
      const capabilityColumns = {
        max_input_tokens: 'INT DEFAULT NULL AFTER context_window_tokens',
        context_limit_semantics: "VARCHAR(24) NOT NULL DEFAULT 'shared_context' AFTER max_output_tokens",
        token_limits_source: "VARCHAR(32) NOT NULL DEFAULT 'generic_default' AFTER context_limit_semantics",
        token_limits_status: "VARCHAR(32) NOT NULL DEFAULT 'default_unconfirmed' AFTER token_limits_source",
        token_limits_note: 'VARCHAR(512) DEFAULT NULL AFTER token_limits_status',
        token_limits_updated_by: 'INT DEFAULT NULL AFTER token_limits_note',
        token_limits_updated_at_utc_msc: 'BIGINT DEFAULT NULL AFTER token_limits_updated_by',
        provider: 'VARCHAR(64) DEFAULT NULL AFTER model_profile_id',
        model_name: 'VARCHAR(191) DEFAULT NULL AFTER provider',
        api_base_url: 'VARCHAR(512) DEFAULT NULL AFTER model_name',
        protocol: 'VARCHAR(32) DEFAULT NULL AFTER api_base_url',
      }
      const existingCapabilityColumns = new Set((await queryAll(`SELECT COLUMN_NAME
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'ai_model_provider_capabilities'`)).map(row => row.COLUMN_NAME))
      for (const [name, definition] of Object.entries(capabilityColumns)) {
        if (!existingCapabilityColumns.has(name)) {
          await queryRun(`ALTER TABLE ai_model_provider_capabilities ADD COLUMN ${name} ${definition}`)
        }
      }

      // Existing capability rows predate the manual token contract. Reset
      // non-manual values to the conservative generic defaults, while keeping
      // an explicitly manual confirmation intact. This statement is safe to
      // rerun after a partially applied migration.
      await queryRun(`UPDATE ai_model_provider_capabilities
        SET context_window_tokens = CASE WHEN token_limits_source = 'manual_confirmed'
          THEN context_window_tokens ELSE 1048576 END,
            max_input_tokens = CASE WHEN token_limits_source = 'manual_confirmed'
          THEN max_input_tokens ELSE 1048576 END,
            max_output_tokens = CASE WHEN token_limits_source = 'manual_confirmed'
          THEN max_output_tokens ELSE 393216 END,
            context_limit_semantics = COALESCE(NULLIF(context_limit_semantics, ''), 'shared_context'),
            token_limits_source = COALESCE(NULLIF(token_limits_source, ''), 'generic_default'),
            token_limits_status = CASE WHEN token_limits_source = 'manual_confirmed'
          THEN COALESCE(NULLIF(token_limits_status, ''), 'confirmed') ELSE 'default_unconfirmed' END`)

      const profiles = await queryAll(`SELECT id, provider, model_name, api_base_url
        FROM ai_model_profiles WHERE deleted_at IS NULL`)
      for (const profile of profiles) {
        const capability = await queryOne(`SELECT model_profile_id, token_limits_source
          FROM ai_model_provider_capabilities WHERE model_profile_id = ? LIMIT 1`, [profile.id])
        if (!capability) {
          await queryRun(`INSERT INTO ai_model_provider_capabilities
            (model_profile_id, context_window_tokens, max_input_tokens, max_output_tokens,
             context_limit_semantics, token_limits_source, token_limits_status,
             provider, model_name, api_base_url, protocol, updated_at_utc_msc)
            VALUES (?, 1048576, 1048576, 393216, 'shared_context', 'generic_default',
              'default_unconfirmed', ?, ?, ?, NULL, ?)`,
          [profile.id, profile.provider, profile.model_name, profile.api_base_url, Date.now()])
        } else {
          await queryRun(`UPDATE ai_model_provider_capabilities
            SET provider = ?, model_name = ?, api_base_url = ?,
                context_window_tokens = CASE WHEN token_limits_source = 'manual_confirmed'
                  THEN context_window_tokens ELSE 1048576 END,
                max_input_tokens = CASE WHEN token_limits_source = 'manual_confirmed'
                  THEN max_input_tokens ELSE 1048576 END,
                max_output_tokens = CASE WHEN token_limits_source = 'manual_confirmed'
                  THEN max_output_tokens ELSE 393216 END,
                context_limit_semantics = COALESCE(NULLIF(context_limit_semantics, ''), 'shared_context'),
                token_limits_source = CASE WHEN token_limits_source = 'manual_confirmed'
                  THEN token_limits_source ELSE 'generic_default' END,
                token_limits_status = CASE WHEN token_limits_source = 'manual_confirmed'
                  THEN COALESCE(NULLIF(token_limits_status, ''), 'confirmed') ELSE 'default_unconfirmed' END,
                updated_at_utc_msc = ?
            WHERE model_profile_id = ?`,
          [profile.provider, profile.model_name, profile.api_base_url, Date.now(), profile.id])
        }
      }

      const taskColumns = {
        provider_max_input_tokens: 'INT DEFAULT NULL AFTER context_window_tokens',
        context_limit_semantics: "VARCHAR(24) DEFAULT NULL AFTER provider_max_input_tokens",
        token_limits_source: 'VARCHAR(32) DEFAULT NULL AFTER context_limit_semantics',
        token_limits_status: 'VARCHAR(32) DEFAULT NULL AFTER token_limits_source',
        token_limits_updated_at_utc_msc: 'BIGINT DEFAULT NULL AFTER token_limits_status',
      }
      const existingTaskColumns = new Set((await queryAll(`SELECT COLUMN_NAME
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'ai_model_tasks'`)).map(row => row.COLUMN_NAME))
      for (const [name, definition] of Object.entries(taskColumns)) {
        if (!existingTaskColumns.has(name)) {
          await queryRun(`ALTER TABLE ai_model_tasks ADD COLUMN ${name} ${definition}`)
        }
      }
    }
  },
  {
    id: '181_unified_strategy_memory_library',
    async up() {
      await queryRun(`CREATE TABLE IF NOT EXISTS strategy_memory_libraries (
        strategy_id INT NOT NULL PRIMARY KEY,
        strategy_scope VARCHAR(16) NOT NULL,
        owner_user_id INT NOT NULL DEFAULT 0,
        content_text LONGTEXT NOT NULL,
        version_no INT NOT NULL DEFAULT 0,
        content_hash CHAR(64) NOT NULL,
        char_count INT NOT NULL DEFAULT 0,
        estimated_token_count INT NOT NULL DEFAULT 0,
        capacity_chars INT NOT NULL DEFAULT 120000,
        compression_target_ratio DECIMAL(5,4) NOT NULL DEFAULT 0.6000,
        conflict_alert_threshold INT NOT NULL DEFAULT 3,
        pending_update_count INT NOT NULL DEFAULT 0,
        compression_status VARCHAR(24) NOT NULL DEFAULT 'idle',
        last_compacted_at DATETIME DEFAULT NULL,
        updated_by_user_id INT DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        KEY idx_strategy_memory_owner (owner_user_id, strategy_scope, updated_at),
        KEY idx_strategy_memory_compression (compression_status, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS strategy_memory_library_revisions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        strategy_id INT NOT NULL,
        version_no INT NOT NULL,
        change_reason VARCHAR(32) NOT NULL,
        source_type VARCHAR(32) DEFAULT NULL,
        source_id BIGINT DEFAULT NULL,
        content_text LONGTEXT NOT NULL,
        content_hash CHAR(64) NOT NULL,
        char_count INT NOT NULL,
        estimated_token_count INT NOT NULL,
        actor_user_id INT DEFAULT NULL,
        source_metadata_json LONGTEXT DEFAULT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uk_strategy_memory_revision (strategy_id, version_no),
        KEY idx_strategy_memory_revision_created (strategy_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS strategy_memory_pending_updates (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        strategy_id INT NOT NULL,
        update_kind VARCHAR(32) NOT NULL,
        source_period_case_id BIGINT DEFAULT NULL,
        source_period_review_version_id BIGINT NOT NULL,
        content_text LONGTEXT NOT NULL,
        content_hash CHAR(64) NOT NULL,
        source_refs_json LONGTEXT DEFAULT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'pending',
        merged_revision_id BIGINT UNSIGNED DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        completed_at DATETIME DEFAULT NULL,
        UNIQUE KEY uk_strategy_memory_review_update
          (strategy_id, source_period_review_version_id, update_kind),
        KEY idx_strategy_memory_pending (strategy_id, status, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS strategy_memory_conflicts (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        strategy_id INT NOT NULL,
        conflict_key CHAR(64) NOT NULL,
        conflict_category VARCHAR(32) NOT NULL DEFAULT 'general',
        conflict_summary TEXT NOT NULL,
        strategy_excerpt TEXT DEFAULT NULL,
        suggested_change TEXT DEFAULT NULL,
        evidence_count INT NOT NULL DEFAULT 0,
        alert_threshold INT NOT NULL DEFAULT 3,
        status VARCHAR(24) NOT NULL DEFAULT 'observing',
        first_observed_at DATETIME NOT NULL,
        last_observed_at DATETIME NOT NULL,
        resolved_at DATETIME DEFAULT NULL,
        resolved_by_user_id INT DEFAULT NULL,
        resolution_note TEXT DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        UNIQUE KEY uk_strategy_memory_conflict (strategy_id, conflict_key),
        KEY idx_strategy_memory_conflict_status (strategy_id, status, evidence_count, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS strategy_memory_conflict_occurrences (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        conflict_id BIGINT UNSIGNED NOT NULL,
        strategy_id INT NOT NULL,
        period_review_case_id BIGINT NOT NULL,
        period_review_version_id BIGINT NOT NULL,
        evidence_json LONGTEXT DEFAULT NULL,
        created_at DATETIME NOT NULL,
        UNIQUE KEY uk_strategy_memory_conflict_review (conflict_id, period_review_version_id),
        KEY idx_strategy_memory_conflict_occurrence (strategy_id, period_review_case_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS strategy_memory_compression_jobs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        strategy_id INT NOT NULL,
        trigger_type VARCHAR(32) NOT NULL,
        source_version_no INT NOT NULL,
        source_content_hash CHAR(64) NOT NULL,
        source_set_hash CHAR(64) NOT NULL,
        pending_update_ids_json LONGTEXT NOT NULL,
        target_chars INT NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'queued',
        attempt_count INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        lease_token CHAR(36) DEFAULT NULL,
        lease_expires_at DATETIME DEFAULT NULL,
        next_attempt_at DATETIME DEFAULT NULL,
        model_task_id CHAR(36) DEFAULT NULL,
        last_error_code VARCHAR(128) DEFAULT NULL,
        result_revision_id BIGINT UNSIGNED DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        completed_at DATETIME DEFAULT NULL,
        UNIQUE KEY uk_strategy_memory_compression_source
          (strategy_id, trigger_type, source_version_no, source_set_hash),
        KEY idx_strategy_memory_compression_claim (status, lease_expires_at, next_attempt_at, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS strategy_memory_injection_logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        strategy_id INT NOT NULL,
        library_version_no INT NOT NULL,
        library_content_hash CHAR(64) NOT NULL,
        char_count INT NOT NULL DEFAULT 0,
        estimated_token_count INT NOT NULL DEFAULT 0,
        usage_kind VARCHAR(32) NOT NULL,
        user_id INT DEFAULT NULL,
        signal_id BIGINT DEFAULT NULL,
        inference_snapshot_id BIGINT DEFAULT NULL,
        period_review_case_id BIGINT DEFAULT NULL,
        model_task_id CHAR(36) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        KEY idx_strategy_memory_injection_signal (signal_id),
        KEY idx_strategy_memory_injection_review (period_review_case_id, created_at),
        KEY idx_strategy_memory_injection_library (strategy_id, library_version_no, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      // A monthly review is processed one chunk per worker turn. Persist the
      // exact strategy and memory-library snapshot so every chunk, retry and
      // final merge sees the same evidence even after a restart.
      const reviewJobColumns = {
        memory_library_version_no: 'INT DEFAULT NULL',
        memory_library_content_hash: 'CHAR(64) DEFAULT NULL',
        memory_library_snapshot_text: 'LONGTEXT DEFAULT NULL',
        memory_strategy_snapshot_text: 'LONGTEXT DEFAULT NULL',
      }
      const existingReviewJobColumns = new Set((await queryAll(`SELECT COLUMN_NAME
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'period_review_jobs'`)).map(row => row.COLUMN_NAME))
      for (const [name, definition] of Object.entries(reviewJobColumns)) {
        if (!existingReviewJobColumns.has(name)) {
          await queryRun(`ALTER TABLE period_review_jobs ADD COLUMN ${name} ${definition}`)
        }
      }

      // Import only currently effective, unambiguously strategy-bound legacy
      // knowledge. Old rows remain untouched and therefore stay available for
      // audit or an application rollback. GROUP_CONCAT is intentionally not
      // used because its server limit can silently truncate memory text.
      const strategies = await queryAll(`SELECT id, scope, owner_user_id
        FROM auto_prompt_types WHERE deleted_at IS NULL ORDER BY id`)
      const hash = value => crypto.createHash('sha256').update(String(value || '')).digest('hex')
      const clean = value => String(value || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').trim()
      const appendSection = (parts, title, rows, textField, type) => {
        const usable = rows.filter(row => clean(row[textField]))
        if (!usable.length) return
        parts.push(`## ${title}`)
        for (const row of usable) {
          const source = `${type} #${Number(row.id)}`
          const context = clean(row.applicability_json || row.conditions_json || row.context_json)
          parts.push(`- ${clean(row[textField])}${context ? `\n  - 适用条件：${context}` : ''}\n  - 迁移来源：${source}`)
        }
      }
      for (const strategy of strategies) {
        const existing = await queryOne(`SELECT strategy_id, version_no, content_text,
          content_hash, char_count, estimated_token_count
          FROM strategy_memory_libraries WHERE strategy_id = ? LIMIT 1`, [strategy.id])
        if (existing && Number(existing.version_no || 0) > 1) continue
        const parts = ['# 策略记忆库', '', '> 以下内容由旧记忆系统中仍有效且归属明确的记录一次性导入。']
        const personalItems = await queryAll(`SELECT id, lesson_text, applicability_json, conditions_json
          FROM experience_memory_items WHERE strategy_id = ? AND status = 'active' ORDER BY id`, [strategy.id])
        const personalLong = await queryAll(`SELECT id, summary_text, applicability_json, conditions_json
          FROM experience_long_term_memories WHERE strategy_id = ? AND status = 'active' ORDER BY id`, [strategy.id])
        const personalSummaries = await queryAll(`SELECT id, summary_text, applicability_json
          FROM experience_memory_summaries WHERE strategy_id = ? AND status = 'active' ORDER BY id`, [strategy.id])
        const platformItems = await queryAll(`SELECT id, lesson_text, applicability_json, context_json
          FROM platform_strategy_experience_items WHERE strategy_id = ? AND status = 'active' ORDER BY id`, [strategy.id])
        appendSection(parts, '已确认复盘经验', personalItems, 'lesson_text', 'personal_item')
        appendSection(parts, '稳定经验', personalLong, 'summary_text', 'personal_long')
        appendSection(parts, '历史压缩结论', personalSummaries, 'summary_text', 'personal_summary')
        appendSection(parts, '平台已发布经验', platformItems, 'lesson_text', 'platform_item')
        if (parts.length === 3) parts.length = 0
        const content = clean(parts.join('\n\n'))
        const now = beijingNow()
        const version = content ? 1 : 0
        const contentHash = hash(content)
        const charCount = [...content].length
        const estimatedTokens = content ? Math.max(1, Math.ceil(Buffer.byteLength(content, 'utf8') / 4)) : 0
        await queryRun(`INSERT IGNORE INTO strategy_memory_libraries
          (strategy_id, strategy_scope, owner_user_id, content_text, version_no, content_hash,
           char_count, estimated_token_count, capacity_chars, compression_target_ratio,
           conflict_alert_threshold, pending_update_count, compression_status,
           updated_by_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 120000, 0.6000, 3, 0, 'idle', NULL, ?, ?)`,
          [strategy.id, strategy.scope, Number(strategy.owner_user_id || 0), content, version,
          contentHash, charCount, estimatedTokens, now, now])
        const current = existing || { version_no:version, content_text:content, content_hash:contentHash,
          char_count:charCount, estimated_token_count:estimatedTokens }
        if (Number(current.version_no || 0) === 1) await queryRun(`INSERT IGNORE INTO strategy_memory_library_revisions
          (strategy_id, version_no, change_reason, source_type, source_id, content_text,
           content_hash, char_count, estimated_token_count, actor_user_id,
           source_metadata_json, created_at)
          VALUES (?, 1, 'legacy_import', 'legacy_memory_tables', NULL, ?, ?, ?, ?, NULL, ?, ?)`,
        [strategy.id, current.content_text, current.content_hash, Number(current.char_count || 0),
          Number(current.estimated_token_count || 0),
          JSON.stringify({ imported_by_migration:'181_unified_strategy_memory_library' }), now])
      }

      // The old compression worker must not keep mutating legacy summaries
      // after the new current-library contract becomes authoritative.
      await queryRun(`UPDATE memory_compression_jobs SET status = 'retired', lease_token = NULL,
        lease_expires_at = NULL, last_error_code = 'unified_strategy_memory_library',
        completed_at = COALESCE(completed_at, ?), updated_at = ?
        WHERE status IN ('queued','leased','failed','status_unknown')`, [beijingNow(), beijingNow()])
    }
  },
  {
    id: '182_strategy_memory_merge_integrity',
    async up() {
      // Migration 181 is already deployed in some environments. Add only the
      // result-validation fields required to distinguish durable merge from a
      // compression request outcome; never rewrite existing memory content.
      const columns = {
        result_content_hash: 'CHAR(64) DEFAULT NULL AFTER result_revision_id',
        result_validation_status: "VARCHAR(24) DEFAULT NULL AFTER result_content_hash",
        result_validation_json: 'LONGTEXT DEFAULT NULL AFTER result_validation_status',
      }
      const existing = new Set((await queryAll(`SELECT COLUMN_NAME
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'strategy_memory_compression_jobs'`)).map(row => row.COLUMN_NAME))
      for (const [name, definition] of Object.entries(columns)) {
        if (!existing.has(name)) {
          await queryRun(`ALTER TABLE strategy_memory_compression_jobs ADD COLUMN ${name} ${definition}`)
        }
      }
    }
  },
  {
    id: '183_strategy_memory_conflict_bindings_and_checks',
    async up() {
      // This migration only adds the structures needed to locate a conflict
      // in an exact strategy/library snapshot and to persist asynchronous
      // consistency checks. It deliberately does not scan or rewrite any
      // existing memory/conflict rows and never calls a model provider.
      const addColumns = async (table, definitions) => {
        const existing = new Set((await queryAll(`SELECT COLUMN_NAME
          FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?`, [table])).map(row => String(row.COLUMN_NAME)))
        for (const [name, definition] of Object.entries(definitions)) {
          if (!existing.has(name)) {
            await queryRun(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`)
          }
        }
      }

      const addIndex = async (table, indexName, definition) => {
        const existing = new Set((await queryAll(`SELECT DISTINCT INDEX_NAME
          FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = ?`, [table])).map(row => String(row.INDEX_NAME)))
        if (!existing.has(indexName)) await queryRun(`ALTER TABLE ${table} ADD ${definition}`)
      }

      await addColumns('strategy_memory_conflicts', {
        identity_version: 'SMALLINT NOT NULL DEFAULT 1',
        conflict_kind: 'VARCHAR(32) DEFAULT NULL',
        strategy_rule_hash: 'CHAR(64) DEFAULT NULL',
        canonical_lineage_key: 'CHAR(64) DEFAULT NULL',
        detection_count: 'INT NOT NULL DEFAULT 0',
        verification_status: "VARCHAR(24) NOT NULL DEFAULT 'location_stale'",
        last_detected_at: 'DATETIME DEFAULT NULL',
        last_validated_at: 'DATETIME DEFAULT NULL',
      })

      await addColumns('strategy_memory_conflict_occurrences', {
        binding_id: 'BIGINT UNSIGNED DEFAULT NULL',
        strategy_version: 'INT DEFAULT NULL',
        library_version_no: 'INT DEFAULT NULL',
        library_content_hash: 'CHAR(64) DEFAULT NULL',
        memory_block_id: 'CHAR(64) DEFAULT NULL',
        memory_block_hash: 'CHAR(64) DEFAULT NULL',
        memory_excerpt: 'TEXT DEFAULT NULL',
        conflict_kind: 'VARCHAR(32) DEFAULT NULL',
      })

      await addColumns('ai_feature_flags', {
        strategy_memory_markdown_preview_enabled: 'TINYINT(1) NOT NULL DEFAULT 1',
        strategy_memory_consistency_checks_enabled: 'TINYINT(1) NOT NULL DEFAULT 1',
      })

      await queryRun(`CREATE TABLE IF NOT EXISTS strategy_memory_conflict_bindings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        conflict_id BIGINT UNSIGNED NOT NULL,
        strategy_id INT NOT NULL,
        strategy_version INT NOT NULL,
        library_version_no INT NOT NULL,
        library_content_hash CHAR(64) NOT NULL,
        memory_block_id CHAR(64) NOT NULL,
        memory_block_hash CHAR(64) NOT NULL,
        memory_excerpt TEXT NOT NULL,
        memory_claim_hash CHAR(64) NOT NULL,
        strategy_excerpt TEXT NOT NULL,
        strategy_rule_hash CHAR(64) NOT NULL,
        location_status VARCHAR(24) NOT NULL DEFAULT 'matched',
        detector_contract_version VARCHAR(64) NOT NULL DEFAULT 'strategy-memory-consistency-v1',
        consistency_job_id BIGINT UNSIGNED DEFAULT NULL,
        created_at DATETIME NOT NULL,
        validated_at DATETIME DEFAULT NULL,
        superseded_at DATETIME DEFAULT NULL,
        UNIQUE KEY uk_strategy_memory_binding_snapshot
          (conflict_id, strategy_version, library_version_no, memory_block_id),
        KEY idx_strategy_memory_binding_snapshot
          (strategy_id, strategy_version, library_version_no, location_status),
        KEY idx_strategy_memory_binding_conflict (conflict_id, location_status),
        KEY idx_strategy_memory_binding_job (consistency_job_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      await queryRun(`CREATE TABLE IF NOT EXISTS strategy_memory_consistency_jobs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
        strategy_id INT NOT NULL,
        strategy_version INT NOT NULL,
        library_version_no INT NOT NULL,
        library_content_hash CHAR(64) NOT NULL,
        strategy_content_hash CHAR(64) NOT NULL,
        strategy_text_snapshot LONGTEXT NOT NULL,
        memory_content_snapshot LONGTEXT NOT NULL,
        trigger_type VARCHAR(32) NOT NULL,
        input_set_hash CHAR(64) NOT NULL,
        detector_contract_version VARCHAR(64) NOT NULL DEFAULT 'strategy-memory-consistency-v1',
        status VARCHAR(24) NOT NULL DEFAULT 'queued',
        attempt_count INT NOT NULL DEFAULT 0,
        max_attempts INT NOT NULL DEFAULT 3,
        next_attempt_at DATETIME DEFAULT NULL,
        lease_token CHAR(36) DEFAULT NULL,
        lease_expires_at DATETIME DEFAULT NULL,
        model_task_id CHAR(36) DEFAULT NULL,
        conflict_count INT NOT NULL DEFAULT 0,
        matched_count INT NOT NULL DEFAULT 0,
        stale_count INT NOT NULL DEFAULT 0,
        result_hash CHAR(64) DEFAULT NULL,
        result_json LONGTEXT DEFAULT NULL,
        last_error_code VARCHAR(128) DEFAULT NULL,
        created_at DATETIME NOT NULL,
        updated_at DATETIME NOT NULL,
        completed_at DATETIME DEFAULT NULL,
        UNIQUE KEY uk_strategy_memory_consistency_input
          (strategy_id, strategy_version, library_version_no, input_set_hash),
        KEY idx_strategy_memory_consistency_claim
          (status, lease_expires_at, next_attempt_at, updated_at),
        KEY idx_strategy_memory_consistency_strategy
          (strategy_id, strategy_version, library_version_no, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

      // A deployment may have created the table from an earlier 183 build.
      // Reconcile missing snapshot/result columns without touching queued rows.
      await addColumns('strategy_memory_consistency_jobs', {
        strategy_content_hash: 'CHAR(64) DEFAULT NULL',
        strategy_text_snapshot: 'LONGTEXT DEFAULT NULL',
        memory_content_snapshot: 'LONGTEXT DEFAULT NULL',
        detector_contract_version: "VARCHAR(64) NOT NULL DEFAULT 'strategy-memory-consistency-v1'",
        result_json: 'LONGTEXT DEFAULT NULL',
      })

      const detectorColumns = await queryAll(`SELECT TABLE_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
          AND COLUMN_NAME = 'detector_contract_version'
          AND TABLE_NAME IN ('strategy_memory_conflict_bindings', 'strategy_memory_consistency_jobs')`)
      for (const column of detectorColumns) {
        if (String(column.DATA_TYPE).toLowerCase() !== 'varchar' || Number(column.CHARACTER_MAXIMUM_LENGTH || 0) < 64) {
          await queryRun(`ALTER TABLE ${column.TABLE_NAME} MODIFY COLUMN detector_contract_version
            VARCHAR(64) NOT NULL DEFAULT 'strategy-memory-consistency-v1'`)
        }
      }

      // The table creation above is idempotent, but these checks make the
      // expected lookup indexes explicit when a partially-applied deployment
      // created an older version of either table.
      await addIndex('strategy_memory_conflict_bindings', 'idx_strategy_memory_binding_snapshot',
        'KEY idx_strategy_memory_binding_snapshot (strategy_id, strategy_version, library_version_no, location_status)')
      await addIndex('strategy_memory_consistency_jobs', 'idx_strategy_memory_consistency_claim',
        'KEY idx_strategy_memory_consistency_claim (status, lease_expires_at, next_attempt_at, updated_at)')
    }
  },
  {
    id: '184_strategy_memory_legacy_applicability_cleanup',
    async up() {
      // Migration 181 imported applicability into the Markdown body. Repair
      // only rows that still contain recognizable structured residue. Every
      // correction gets a new revision; old revisions remain untouched for
      // audit and restore. No derivation/compression job is retried here.
      const hash = value => crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
      const rowsOf = raw => Array.isArray(raw?.[0]) ? raw[0] : []
      const resultOf = raw => Array.isArray(raw) ? (raw[0] || {}) : (raw || {})
      const candidates = await queryAll(`SELECT lib.strategy_id, lib.content_text, lib.content_hash, lib.version_no
        FROM strategy_memory_libraries lib
       WHERE lib.content_text IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM strategy_memory_library_revisions imported
            WHERE imported.strategy_id = lib.strategy_id
              AND imported.version_no <= lib.version_no
              AND imported.change_reason = 'legacy_import'
         )
       ORDER BY lib.strategy_id`)
      for (const candidate of candidates) {
        if (!sanitizeLegacyStrategyMemoryContent(candidate.content_text || '').changed) continue
        await withTransaction(async run => {
          const locked = rowsOf(await run(
            'SELECT * FROM strategy_memory_libraries WHERE strategy_id = ? FOR UPDATE', [candidate.strategy_id]))[0]
          if (!locked) return
          const cleaned = sanitizeLegacyStrategyMemoryContent(locked.content_text || '')
          if (!cleaned.changed) return
          if (sanitizeLegacyStrategyMemoryContent(cleaned.content).changed) {
            throw new Error('strategy_memory_legacy_cleanup_validation_failed')
          }
          const capacity = Number(locked.capacity_chars || 120000)
          const charCount = [...cleaned.content].length
          if (!Number.isSafeInteger(capacity) || capacity <= 0 || charCount > capacity) {
            throw new Error('strategy_memory_legacy_cleanup_capacity_exceeded')
          }
          const contentHash = hash(cleaned.content)
          const previousVersion = Number(locked.version_no || 0)
          const nextVersion = previousVersion + 1
          const previousHash = String(locked.content_hash || hash(locked.content_text || ''))
          const existingRevision = rowsOf(await run(
            `SELECT id, content_hash, content_text FROM strategy_memory_library_revisions
              WHERE strategy_id = ? AND version_no = ? LIMIT 1 FOR UPDATE`,
            [locked.strategy_id, nextVersion]))[0]
          let revisionId = Number(existingRevision?.id || 0) || null
          if (existingRevision) {
            if (String(existingRevision.content_hash || '') !== contentHash
                || String(existingRevision.content_text || '') !== cleaned.content) {
              throw new Error('strategy_memory_legacy_cleanup_revision_conflict')
            }
          } else {
            const revision = resultOf(await run(`INSERT INTO strategy_memory_library_revisions
              (strategy_id, version_no, change_reason, source_type, source_id, content_text,
               content_hash, char_count, estimated_token_count, actor_user_id,
               source_metadata_json, created_at)
             VALUES (?, ?, 'legacy_applicability_cleanup', 'migration', NULL, ?, ?, ?, ?, NULL, ?, ?)`,
            [locked.strategy_id, nextVersion, cleaned.content, contentHash, charCount,
              cleaned.content ? Math.max(1, Math.ceil(Buffer.byteLength(cleaned.content, 'utf8') / 4)) : 0,
              JSON.stringify({ migration_id:'184_strategy_memory_legacy_applicability_cleanup',
                cleanup_contract:'strategy-memory-legacy-v1', removed_items:cleaned.removed,
                previous_version_no:previousVersion, previous_content_hash:previousHash }), beijingNow()]))
            revisionId = Number(revision.insertId || 0) || null
            if (!revisionId) throw new Error('strategy_memory_legacy_cleanup_revision_create_failed')
          }
          const updated = resultOf(await run(`UPDATE strategy_memory_libraries
            SET content_text = ?, version_no = ?, content_hash = ?, char_count = ?,
                estimated_token_count = ?, updated_at = ?
            WHERE strategy_id = ? AND version_no = ? AND content_hash = ?`,
          [cleaned.content, nextVersion, contentHash, charCount,
            cleaned.content ? Math.max(1, Math.ceil(Buffer.byteLength(cleaned.content, 'utf8') / 4)) : 0,
            beijingNow(), locked.strategy_id, previousVersion, previousHash]))
          if (Number(updated.affectedRows ?? updated.changes ?? 0) !== 1) {
            // A concurrent writer may have already completed the same repair.
            // Re-read under the migration lock and leave it untouched if the
            // durable current row is now clean; never create a second revision.
            const latest = rowsOf(await run(
              'SELECT content_text FROM strategy_memory_libraries WHERE strategy_id = ? LIMIT 1', [locked.strategy_id]))[0]
            if (!latest || sanitizeLegacyStrategyMemoryContent(latest.content_text || '').changed) {
              throw new Error('strategy_memory_legacy_cleanup_library_cas_failed')
            }
          }
          // Keep this local variable intentionally referenced in the audit path
          // above; the migration does not enqueue or mutate any job row.
          void revisionId
        })
      }
    }
  }
]

export async function withMigrationLock(fn, { timeoutSeconds = 60 } = {}) {
  return withConnection(async run => {
    const [rows] = await run(`SELECT GET_LOCK(
      CONCAT('wss:mig:', LEFT(SHA2(COALESCE(DATABASE(), 'unknown'), 256), 56)), ?
    ) AS acquired`, [timeoutSeconds])
    if (Number(rows?.[0]?.acquired) !== 1) {
      throw new Error('Could not acquire the database migration lock')
    }
    try {
      return await fn()
    } finally {
      const [releaseRows] = await run(`SELECT RELEASE_LOCK(
        CONCAT('wss:mig:', LEFT(SHA2(COALESCE(DATABASE(), 'unknown'), 256), 56))
      ) AS released`)
      if (Number(releaseRows?.[0]?.released) !== 1) {
        console.error('[Migrations] Failed to release the database migration lock cleanly')
      }
    }
  })
}

export async function runMigrations() {
  return withMigrationLock(async () => {
  // Ensure tracking table exists
  await queryRun(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id VARCHAR(255) PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`)

  const applied = new Set((await queryAll('SELECT id FROM schema_migrations')).map(r => r.id))

  for (const m of migrations) {
    if (applied.has(m.id)) continue
    try {
      await m.up()
      await queryRun('INSERT INTO schema_migrations (id) VALUES (?)', [m.id])
      console.log(`[Migrations] Applied: ${m.id}`)
    } catch (e) {
      // Every migration must be idempotent on its own. Never mark a partially
      // applied migration complete merely because one statement collided.
      console.error(`[Migrations] FATAL: ${m.id} — ${e.message}`)
      throw e
    }
  }
  })
}
