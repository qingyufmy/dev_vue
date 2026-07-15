/**
 * Database migrations — run once on startup.
 * Each migration has an id and an up() function.
 * Already-run migrations are tracked in the `schema_migrations` table.
 */
import { queryOne, queryAll, queryRun, beijingNow } from './db.js'

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
        trading_account_id INT DEFAULT NULL,
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
