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
        const [cols] = await queryAll("SHOW COLUMNS FROM verification_codes LIKE 'verify_token'")
        if (!cols.length) {
          await queryRun('ALTER TABLE verification_codes ADD COLUMN verify_token VARCHAR(36) DEFAULT NULL AFTER used')
        }
      } catch {}
    }
  },
  {
    id: '004_add_global_auto_config_enable_trade',
    up: async () => {
      try {
        const [cols] = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'global_auto_config' AND COLUMN_NAME = 'enable_auto_trade'")
        if (!cols.length) {
          await queryRun('ALTER TABLE global_auto_config ADD COLUMN enable_auto_trade TINYINT NOT NULL DEFAULT 0 AFTER selected_take_profit')
        }
      } catch {}
    }
  },
  {
    id: '005_add_ai_configs_override_fields',
    up: async () => {
      try {
        const [oc] = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_configs' AND COLUMN_NAME = 'auto_config_override'")
        if (!oc.length) {
          await queryRun('ALTER TABLE ai_configs ADD COLUMN auto_config_override TINYINT NOT NULL DEFAULT 0 AFTER model_sharing_enabled')
        }
        const [sym] = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_configs' AND COLUMN_NAME = 'auto_symbols'")
        if (!sym.length) {
          await queryRun('ALTER TABLE ai_configs ADD COLUMN auto_symbols VARCHAR(100) DEFAULT NULL AFTER auto_config_override')
        }
        const [iv] = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_configs' AND COLUMN_NAME = 'auto_interval_minutes'")
        if (!iv.length) {
          await queryRun('ALTER TABLE ai_configs ADD COLUMN auto_interval_minutes INT DEFAULT NULL AFTER auto_symbols')
        }
      } catch {}
    }
  },
  {
    id: '006_add_close_config_engine_fields',
    up: async () => {
      try {
        const [cols] = await queryAll("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'close_config' AND COLUMN_NAME = 'api_provider'")
        if (!cols.length) {
          await queryRun("ALTER TABLE close_config ADD COLUMN api_provider VARCHAR(50) DEFAULT 'deepseek' AFTER model_name")
          await queryRun("ALTER TABLE close_config ADD COLUMN api_base_url VARCHAR(255) DEFAULT 'https://api.deepseek.com' AFTER api_provider")
          await queryRun('ALTER TABLE close_config ADD COLUMN api_key_encrypted VARCHAR(500) DEFAULT NULL AFTER api_base_url')
          await queryRun('ALTER TABLE close_config ADD COLUMN temperature DOUBLE DEFAULT 0.3 AFTER api_key_encrypted')
          await queryRun('ALTER TABLE close_config ADD COLUMN max_tokens INT DEFAULT 1500 AFTER temperature')
        }
      } catch {}
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
      } catch {}
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
