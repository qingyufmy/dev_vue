/**
 * Database migrations — run once on startup.
 * Each migration has an id and an up() function.
 * Already-run migrations are tracked in the `schema_migrations` table.
 */
import { queryOne, queryAll, queryRun } from './db.js'

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
            recommended_volume: "0.01-0.05手，不得超过0.05。根据风险等级调整：low=0.01-0.02, medium=0.02-0.03, high=0.03-0.05。hold时返回0",
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
      // Ignore "Duplicate column" errors (already exists)
      if (e.message?.includes('Duplicate column')) {
        await queryRun('INSERT INTO schema_migrations (id) VALUES (?)', [m.id])
        console.log(`[Migrations] Already exists, marked: ${m.id}`)
      } else {
        console.error(`[Migrations] Failed: ${m.id}`, e.message)
      }
    }
  }
}
