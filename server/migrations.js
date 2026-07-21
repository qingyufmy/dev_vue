/**
 * Database migrations — run once on startup.
 * Each migration has an id and an up() function.
 * Already-run migrations are tracked in the `schema_migrations` table.
 */
import { queryOne, queryAll, queryRun, withTransaction, beijingNow } from './db.js'

export function applyPendingLifecycleSchema(schema) {
  return {
    ...schema,
    cancel_pending: '必须字段。不需要取消挂单时返回空数组 []。挂单有效期、过期识别和到期取消由 MT5 与后端负责；禁止比较任何时间字符串判断挂单是否过期，禁止以过期、超时、有效期结束或剩余时间不足为理由取消挂单。仅当当前 pending_orders 中确实存在对应挂单，且价格条件明显失效、市场结构被破坏或交易方向逻辑反转时，才允许输出取消条件。pending_orders 中不存在的挂单不得输出取消条件，也不得推断其已经过期或取消。每个元素包含：symbol（必填，品种）、pending_type（可选，如 buy_limit、sell_limit、buy_stop、sell_stop）、max_price（可选，取消低于或等于该价格的挂单）、min_price（可选，取消高于或等于该价格的挂单）、cancel_all（可选，布尔值，取消该品种全部挂单）、reason（必填，必须说明价格、结构或方向方面的非时间原因）。示例：[{"symbol":"XAUUSD","pending_type":"buy_limit","max_price":4110,"reason":"当前结构已经跌破原入场依据，原限价买入逻辑失效"}]；不需要取消时返回 []。',
    reasoning: '中文，说明信号方向、入场方式、风险和执行依据。挂单管理只能依据当前 pending_orders 中真实存在的挂单及价格、结构、方向条件进行分析。禁止比较时间字符串判断挂单是否过期，禁止声称挂单已过期、超时失效或已自动取消。挂单到期和过期取消由 MT5 与后端负责。',
  }
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
          schema.signal_type += '。挂单管理：同品种同方向最多保留1笔挂单，如果market_data_json.pending_orders中已有同品种同方向挂单且价格合理则返回hold不挂新单，仅在现有挂单价格明显不合理时才用cancel_pending取消旧单挂新单'
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
  }
]

export async function runMigrations() {
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
}
