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
