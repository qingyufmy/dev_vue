import mysql from 'mysql2/promise'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
/** Get current Beijing time as 'YYYY-MM-DD HH:MM:SS' for MySQL DATETIME */
export function beijingNow() {
  const d = new Date(Date.now() + 8 * 3600_000)
  return d.toISOString().replace('T', ' ').substring(0, 19)
}


let pool
let _dbConfig = null
function getDBConfig() {
  if (!_dbConfig) {
    _dbConfig = {
      host: process.env.MYSQL_HOST,
      port: parseInt(process.env.MYSQL_PORT || '3306'),
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4',
      dateStrings: true,
      connectTimeout: 60000,
    }
  }
  return _dbConfig
}

/** Get or create MySQL connection pool */
export function getDB() {
  if (!pool) {
    const cfg = getDBConfig()
    console.log('[DB] Creating pool →', cfg.host + ':' + cfg.port, cfg.user + '/' + cfg.database)
    pool = mysql.createPool(cfg)
  }
  return pool
}

/** Run a query and return [rows, fields] */
export async function query(sql, params = []) {
  const p = getDB()
  return p.query(sql, params)
}

/** Run a query and return first row or null */
export async function queryOne(sql, params = []) {
  const [rows] = await query(sql, params)
  return rows.length ? rows[0] : null
}

/** Run a query and return all rows */
export async function queryAll(sql, params = []) {
  const [rows] = await query(sql, params)
  return rows
}

/** Run an insert/update/delete and return { changes, insertId } */
export async function queryRun(sql, params = []) {
  const [result] = await query(sql, params)
  return { changes: result.affectedRows, insertId: result.insertId }
}

export async function logAudit({ userId, action, targetType, targetId, detail, ip, userAgent }) {
  try {
    let userEmail = '', userNickname = ''
    if (userId) {
      const user = await queryOne('SELECT email, nickname FROM users WHERE id = ?', [userId])
      if (user) { userEmail = user.email; userNickname = user.nickname }
    }
    await query(`INSERT INTO audit_logs (user_id, user_email, user_nickname, action, target_type, target_id, detail, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [userId || null, userEmail, userNickname, action, targetType || '', targetId || null, detail || '', ip || '', userAgent || ''])
  } catch (err) {
    console.error('logAudit error:', err)
  }
}

export async function initDB() {
  const p = getDB()

  // Create all tables
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      uid VARCHAR(32) UNIQUE,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      nickname VARCHAR(100) DEFAULT '',
      avatar VARCHAR(500) DEFAULT '',
      role VARCHAR(20) DEFAULT 'user',
      plan VARCHAR(20) DEFAULT 'free',
      plan_period VARCHAR(20) DEFAULT '',
      plan_expires_at DATETIME,
      telegram_id VARCHAR(100),
      telegram_username VARCHAR(100),
      telegram_name VARCHAR(100),
      telegram_chat_id VARCHAR(100),
      telegram_group_status VARCHAR(50) DEFAULT '',
      telegram_bot_started_at DATETIME,
      telegram_joined_at DATETIME,
      telegram_last_invite_sent_at DATETIME,
      referral_code VARCHAR(50) UNIQUE,
      referral_credit INT DEFAULT 0,
      referred_by VARCHAR(50),
      last_seen_at DATETIME,
      current_view VARCHAR(100) DEFAULT '',
      created_at DATETIME DEFAULT (NOW()),
      updated_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS courses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      episode_id INT UNIQUE,
      number INT,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      category VARCHAR(50) DEFAULT 'strategy',
      content_type VARCHAR(20) DEFAULT 'video',
      duration VARCHAR(20) DEFAULT '',
      youtube_id VARCHAR(50) DEFAULT '',
      cover VARCHAR(500) DEFAULT '',
      gradient VARCHAR(500) DEFAULT '',
      article_url VARCHAR(500) DEFAULT '',
      article_object_key VARCHAR(500) DEFAULT '',
      access_level VARCHAR(20) DEFAULT 'free',
      has_stream_video TINYINT DEFAULT 0,
      cf_stream_id VARCHAR(100) DEFAULT '',
      bilibili_id VARCHAR(50) DEFAULT '',
      local_video_path VARCHAR(500) DEFAULT '',
      quiz_count INT DEFAULT 0,
      knowledge_count INT DEFAULT 0,
      mindmap_count INT DEFAULT 0,
      structure_count INT DEFAULT 0,
      status VARCHAR(20) DEFAULT 'published',
      sort_order INT DEFAULT 0,
      created_at DATETIME DEFAULT (NOW()),
      updated_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS progress (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      episode_id INT NOT NULL,
      watched_seconds DOUBLE DEFAULT 0,
      total_duration DOUBLE DEFAULT 0,
      completed TINYINT DEFAULT 0,
      quiz_passed TINYINT DEFAULT 0,
      updated_at DATETIME DEFAULT (NOW()),
      UNIQUE KEY uq_user_episode (user_id, episode_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS comments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      episode_id INT NOT NULL,
      user_id INT NOT NULL,
      text TEXT NOT NULL,
      parent_id INT,
      likes INT DEFAULT 0,
      created_at DATETIME DEFAULT (NOW()),
      updated_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS comment_likes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      comment_id INT NOT NULL,
      created_at DATETIME DEFAULT (NOW()),
      UNIQUE KEY uq_user_comment (user_id, comment_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS posts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      board VARCHAR(50) DEFAULT 'ideas',
      title VARCHAR(500) NOT NULL,
      content TEXT NOT NULL,
      content_html TEXT,
      content_text TEXT,
      category VARCHAR(50) DEFAULT 'general',
      tags TEXT,
      images TEXT,
      asset_ids TEXT,
      pinned TINYINT DEFAULT 0,
      featured TINYINT DEFAULT 0,
      locked TINYINT DEFAULT 0,
      reply_count INT DEFAULT 0,
      view_count INT DEFAULT 0,
      image_count INT DEFAULT 0,
      last_reply_at DATETIME,
      last_reply_user_id INT,
      created_at DATETIME DEFAULT (NOW()),
      updated_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS post_replies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      post_id INT NOT NULL,
      user_id INT NOT NULL,
      content TEXT NOT NULL,
      content_html TEXT,
      content_text TEXT,
      images TEXT,
      asset_ids TEXT,
      quote_reply_id INT,
      floor_number INT DEFAULT 0,
      likes INT DEFAULT 0,
      created_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS post_reports (
      id INT AUTO_INCREMENT PRIMARY KEY,
      post_id INT,
      reply_id INT,
      user_id INT NOT NULL,
      reason VARCHAR(2000) DEFAULT '',
      detail VARCHAR(5000) DEFAULT '',
      status VARCHAR(20) DEFAULT 'pending',
      created_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS trades (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      trade_date DATE DEFAULT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      symbol VARCHAR(50) DEFAULT '',
      direction VARCHAR(20) DEFAULT '',
      result VARCHAR(20) DEFAULT '',
      entry_price VARCHAR(50) DEFAULT '',
      exit_price VARCHAR(50) DEFAULT '',
      profit_pct VARCHAR(50) DEFAULT '',
      pnl VARCHAR(50) DEFAULT '',
      notes TEXT,
      image_url VARCHAR(500) DEFAULT '',
      screenshot_url VARCHAR(500) DEFAULT '',
      status VARCHAR(20) DEFAULT 'open',
      is_public TINYINT DEFAULT 1,
      created_at DATETIME DEFAULT (NOW()),
      updated_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_no VARCHAR(100) UNIQUE NOT NULL,
      order_id VARCHAR(100) UNIQUE,
      user_id INT NOT NULL,
      plan VARCHAR(50) NOT NULL,
      plan_label VARCHAR(50) DEFAULT '',
      period VARCHAR(20) DEFAULT 'month',
      period_label VARCHAR(50) DEFAULT '',
      amount INT DEFAULT 0,
      amount_confirmed INT DEFAULT 0,
      currency VARCHAR(10) DEFAULT 'USD',
      status VARCHAR(20) DEFAULT 'pending',
      status_label VARCHAR(50) DEFAULT '',
      payment_method VARCHAR(50) DEFAULT '',
      paid_at DATETIME,
      created_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS notifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      actor_id INT,
      type VARCHAR(50) DEFAULT 'system',
      title VARCHAR(500) DEFAULT '',
      message VARCHAR(2000) DEFAULT '',
      link VARCHAR(500) DEFAULT '',
      post_id INT,
      meta VARCHAR(2000) DEFAULT '{}',
      is_read TINYINT DEFAULT 0,
      \`read\` TINYINT DEFAULT 0,
      created_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS verification_codes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      code VARCHAR(20) NOT NULL,
      purpose VARCHAR(20) DEFAULT 'login',
      expires_at DATETIME NOT NULL,
      used TINYINT DEFAULT 0,
      created_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS quiz_questions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      episode_id INT NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      answer INT DEFAULT 0,
      correct_index INT DEFAULT 0,
      explanation VARCHAR(5000) DEFAULT '',
      explanations VARCHAR(5000) DEFAULT '[]',
      hint VARCHAR(500) DEFAULT '',
      status VARCHAR(20) DEFAULT 'published',
      sort_order INT DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS course_resources (
      id INT AUTO_INCREMENT PRIMARY KEY,
      episode_id INT NOT NULL,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(500) DEFAULT '',
      content VARCHAR(10000) DEFAULT '',
      url VARCHAR(500) DEFAULT '',
      structure VARCHAR(5000) DEFAULT '',
      sort_order INT DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS referrals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      referrer_id INT NOT NULL,
      referred_id INT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      commission INT DEFAULT 0,
      amount_cents INT DEFAULT 0,
      plan_label VARCHAR(50) DEFAULT '',
      attributed_at DATETIME,
      created_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS user_notices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      notice_id VARCHAR(100) DEFAULT '',
      type VARCHAR(50) DEFAULT '',
      title VARCHAR(500) DEFAULT '',
      body VARCHAR(5000) DEFAULT '',
      link VARCHAR(500) DEFAULT '',
      source VARCHAR(100) DEFAULT '',
      \`read\` TINYINT DEFAULT 0,
      created_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS video_streams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      episode_id INT NOT NULL,
      video_key VARCHAR(255) NOT NULL,
      bilibili_id VARCHAR(50) DEFAULT '',
      local_path VARCHAR(500) DEFAULT '',
      qiniu_key VARCHAR(500) DEFAULT '',
      quality VARCHAR(20) DEFAULT '720p',
      duration DOUBLE DEFAULT 0,
      file_size INT DEFAULT 0,
      access_level VARCHAR(20) DEFAULT 'plus_pro',
      title VARCHAR(500) DEFAULT '',
      created_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS post_assets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      asset_id VARCHAR(100) UNIQUE NOT NULL,
      user_id INT NOT NULL,
      file_name VARCHAR(255) DEFAULT '',
      file_type VARCHAR(50) DEFAULT '',
      file_size INT DEFAULT 0,
      url VARCHAR(500) DEFAULT '',
      created_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS post_tags (
      id INT AUTO_INCREMENT PRIMARY KEY,
      slug VARCHAR(100) UNIQUE NOT NULL,
      label VARCHAR(100) NOT NULL,
      count INT DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS system_config (
      id INT AUTO_INCREMENT PRIMARY KEY,
      category VARCHAR(100) NOT NULL,
      \`key\` VARCHAR(100) NOT NULL,
      value MEDIUMTEXT,
      label VARCHAR(255) DEFAULT '',
      sort_order INT DEFAULT 0,
      created_at DATETIME DEFAULT (NOW()),
      updated_at DATETIME DEFAULT (NOW()),
      UNIQUE KEY uq_category_key (category, \`key\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS ai_configs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      session_id VARCHAR(100) NOT NULL DEFAULT 'default',
      api_provider VARCHAR(50) NOT NULL DEFAULT 'deepseek',
      api_key_encrypted TEXT,
      api_base_url VARCHAR(500),
      model_name VARCHAR(100) NOT NULL DEFAULT 'deepseek-chat',
      temperature DOUBLE NOT NULL DEFAULT 0.7,
      max_tokens INT NOT NULL DEFAULT 2000,
      enable_auto_trade TINYINT NOT NULL DEFAULT 0,
      enable_futures_trading TINYINT NOT NULL DEFAULT 0,
      risk_level VARCHAR(20) NOT NULL DEFAULT 'medium',
      max_position_size DOUBLE NOT NULL DEFAULT 0.05,
      selected_take_profit INT NOT NULL DEFAULT 1,
      system_prompt TEXT,
      model_sharing_enabled TINYINT NOT NULL DEFAULT 0,
      is_active TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT (NOW()),
      updated_at DATETIME NOT NULL DEFAULT (NOW()),
      UNIQUE KEY uq_user_session_provider (user_id, session_id, api_provider)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS ai_signals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      config_id INT,
      session_id VARCHAR(100) NOT NULL DEFAULT 'default',
      symbol VARCHAR(50) NOT NULL,
      timeframe VARCHAR(10) NOT NULL,
      signal_type VARCHAR(20) NOT NULL,
      confidence DOUBLE NOT NULL,
      recommended_volume DOUBLE NOT NULL,
      analysis TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      stop_loss_price DOUBLE,
      take_profit_1_price DOUBLE,
      take_profit_2_price DOUBLE,
      take_profit_3_price DOUBLE,
      market_data_json TEXT NOT NULL,
      ai_model VARCHAR(100) NOT NULL DEFAULT 'deepseek-chat',
      ttl_seconds INT,
      is_executed TINYINT NOT NULL DEFAULT 0,
      executed_at DATETIME,
      trade_ticket VARCHAR(100),
      execution_result TEXT,
      created_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS trade_audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      action VARCHAR(50) NOT NULL,
      symbol VARCHAR(50),
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      status VARCHAR(20) NOT NULL,
      created_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS ui_configs (
      user_id INT PRIMARY KEY,
      theme VARCHAR(50) NOT NULL DEFAULT 'theme2',
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS auto_scheduler (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL UNIQUE,
      symbols VARCHAR(1000) NOT NULL DEFAULT 'XAUUSD',
      enabled TINYINT NOT NULL DEFAULT 0,
      last_run_at DATETIME,
      created_at DATETIME NOT NULL DEFAULT (NOW()),
      updated_at DATETIME NOT NULL DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS global_auto_config (
      id INT PRIMARY KEY DEFAULT 1,
      symbols VARCHAR(1000) NOT NULL DEFAULT 'XAUUSD',
      interval_minutes INT NOT NULL DEFAULT 5,
      api_provider VARCHAR(50) DEFAULT 'deepseek',
      model_name VARCHAR(100) DEFAULT 'deepseek-chat',
      api_key_encrypted TEXT,
      api_base_url VARCHAR(500) DEFAULT 'https://api.deepseek.com',
      temperature DOUBLE DEFAULT 0.3,
      max_tokens INT DEFAULT 2000,
      risk_level VARCHAR(20) DEFAULT 'medium',
      max_position_size DOUBLE DEFAULT 0.05,
      selected_take_profit INT DEFAULT 2,
      enable_auto_trade TINYINT NOT NULL DEFAULT 0,
      system_prompt TEXT,
      updated_at DATETIME NOT NULL DEFAULT (NOW()),
      CONSTRAINT chk_singleton CHECK (id = 1)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      user_email VARCHAR(255) DEFAULT '',
      user_nickname VARCHAR(100) DEFAULT '',
      action VARCHAR(100) NOT NULL,
      target_type VARCHAR(50) DEFAULT '',
      target_id INT,
      detail VARCHAR(5000) DEFAULT '',
      ip VARCHAR(50) DEFAULT '',
      user_agent VARCHAR(500) DEFAULT '',
      created_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS broadcast_messages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(50) NOT NULL,
      user_id INT,
      nickname VARCHAR(100) DEFAULT '',
      group_name VARCHAR(100) DEFAULT '',
      message TEXT NOT NULL,
      created_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    `CREATE TABLE IF NOT EXISTS feedback (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT,
      type VARCHAR(50) NOT NULL,
      title VARCHAR(200) NOT NULL,
      description TEXT NOT NULL,
      contact VARCHAR(200) DEFAULT '',
      created_at DATETIME DEFAULT (NOW())
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ]

  for (const sql of tables) {
    await p.query(sql)
  }

  // Seed demo data if empty
  const [userRows] = await p.query('SELECT COUNT(*) as c FROM users')
  if (userRows[0].c === 0) {
    await seedData(p)
  }

  // Fix NULL UIDs for seed accounts
  await p.query("UPDATE users SET uid = CONCAT('WS', LPAD(id, 6, '0')) WHERE uid IS NULL")

  // Fix DATETIME columns that still have +8h defaults (from old schema)
  const [badCols] = await p.query(`
    SELECT TABLE_NAME, COLUMN_NAME
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
    AND COLUMN_DEFAULT LIKE '%interval 8 hour%'
  `)
  for (const col of badCols) {
    await p.query(`ALTER TABLE \`${col.TABLE_NAME}\` ALTER COLUMN \`${col.COLUMN_NAME}\` SET DEFAULT (NOW())`)
  }
  if (badCols.length) console.log(`[DB] Fixed ${badCols.length} columns with +8h defaults`)

  // v1.7: global_auto_config + cleanup
  const [gacExists] = await p.query('SELECT COUNT(*) as c FROM global_auto_config')
  if (gacExists[0].c === 0) {
    let oldGlobal = []
    try { [oldGlobal] = await p.query('SELECT * FROM auto_scheduler WHERE user_id = 0') } catch {}
    if (oldGlobal.length) {
      const g = oldGlobal[0]
      await p.query('INSERT INTO global_auto_config (id, symbols, interval_minutes, api_provider, model_name, api_key_encrypted, api_base_url, temperature, max_tokens, risk_level, max_position_size, selected_take_profit, system_prompt) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        g.symbols || 'XAUUSD', g.interval_minutes || 5, g.api_provider || 'deepseek',
        g.model_name || 'deepseek-chat', g.api_key_encrypted || null, g.api_base_url || 'https://api.deepseek.com',
        g.temperature || 0.3, g.max_tokens || 2000, g.risk_level || 'medium',
        g.max_position_size || 0.05, g.selected_take_profit || 2, g.system_prompt || null
      ])
      console.log('[DB] Migrated global auto config from auto_scheduler')
    } else {
      await p.query('INSERT INTO global_auto_config (id) VALUES (1)')
    }
  }
  try { await p.query('DELETE FROM auto_scheduler WHERE user_id = 0') } catch {}

  // Clean up auto_scheduler: drop model config columns
  for (const col of ['api_provider','model_name','api_key_encrypted','api_base_url','temperature','max_tokens','system_prompt','risk_level','max_position_size','selected_take_profit','interval_minutes']) {
    try { await p.query('ALTER TABLE auto_scheduler DROP COLUMN ' + col) } catch {}
  }

  // Drop system_prompts (prompt in ai_configs + global_auto_config now)
  try { await p.query('DROP TABLE IF EXISTS system_prompts') } catch {}

  // Clean notifications: drop unused 'read' column (reserved word)
  try { await p.query('ALTER TABLE notifications DROP COLUMN `read`') } catch {}

  // v1.7.3: add enable_auto_trade to global_auto_config
  try {
    const [eacCols] = await p.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'global_auto_config' AND COLUMN_NAME = 'enable_auto_trade'`)
    if (eacCols.length === 0) {
      await p.query('ALTER TABLE global_auto_config ADD COLUMN enable_auto_trade TINYINT NOT NULL DEFAULT 0 AFTER selected_take_profit')
      console.log('[DB] Added enable_auto_trade to global_auto_config')
    }
  } catch {}

  // v1.7.7: add auto_config_override to ai_configs
  try {
    const [acCols] = await p.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ai_configs' AND COLUMN_NAME = 'auto_config_override'`)
    if (acCols.length === 0) {
      await p.query('ALTER TABLE ai_configs ADD COLUMN auto_config_override TINYINT NOT NULL DEFAULT 0 AFTER model_sharing_enabled')
      console.log('[DB] Added auto_config_override to ai_configs')
    }
  } catch {}

  console.log('[DB] MySQL initialized')
}

async function seedData(p) {
  const hash = bcrypt.hashSync('admin123', 10)
  const demoHash = bcrypt.hashSync('demo123', 10)

  await p.query(`INSERT INTO users (email, password, nickname, role, plan, plan_expires_at, referral_code) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['admin@wallstreetskill.com', hash, '街哥', 'admin', 'pro', '2027-12-31', 'ADMIN001'])

  await p.query(`INSERT INTO users (email, password, nickname, role, plan, referral_code) VALUES (?, ?, ?, ?, ?, ?)`,
    ['demo@example.com', demoHash, 'Demo User', 'user', 'free', 'DEMO001'])

  const episodeData = [
    { title: '裸K交易与穿头破脚假突破', description: '25年10月11日 · 第一期', category: 'indicator', duration: '18:30', youtubeId: '05JRtvPsk-M', number: 1 },
    { title: '暴跌长针复盘与期权看多策略', description: '25年10月12日 · 第二期', category: 'indicator', duration: '22:15', youtubeId: 'Bw8rDLGGA_w', number: 2 },
    { title: '均线偏空下的多空逻辑博弈', description: '25年10月23日 · 第三期', category: 'indicator', duration: '19:45', youtubeId: 'aJA3vIda0wg', number: 3 },
    { title: '黄金暴跌抄底与远离币安合约', description: '25年10月28日 · 第四期', category: 'indicator', duration: '16:20', youtubeId: 'bgyGzldmVJo', number: 4 },
    { title: '降息前行情推演及黄金顶背离', description: '25年10月29日 · 第五期', category: 'indicator', duration: '22:30', youtubeId: 'iNuXmPh0oUY', number: 5 },
    { title: '均线缠绕震荡与防范下跌扩大', description: '25年11月1日 · 第六期', category: 'indicator', duration: '20:15', youtubeId: 'kMXcSbHjYT0', number: 6 },
    { title: '非农数据行情博弈与期权策略', description: '25年11月8日 · 第七期', category: 'strategy', duration: '25:10', youtubeId: 'QTZtF9OqSb8', number: 7 },
    { title: '布林带收口变盘与趋势跟踪', description: '25年11月15日 · 第八期', category: 'indicator', duration: '19:30', youtubeId: 'D3JfVOfCs4I', number: 8 },
    { title: 'MACD背离实战与量价配合', description: '25年11月22日 · 第九期', category: 'indicator', duration: '21:45', youtubeId: 'UMMYdWfMpc4', number: 9 },
    { title: 'RSI超买超卖与反转信号捕捉', description: '25年11月29日 · 第十期', category: 'indicator', duration: '18:20', youtubeId: 'vU5WfYPHmPA', number: 10 },
  ]

  const gradients = [
    'linear-gradient(135deg, #667eea, #764ba2)', 'linear-gradient(135deg, #f093fb, #f5576c)',
    'linear-gradient(135deg, #4facfe, #00f2fe)', 'linear-gradient(135deg, #43e97b, #38f9d7)',
    'linear-gradient(135deg, #fa709a, #fee140)', 'linear-gradient(135deg, #a18cd1, #fbc2eb)',
    'linear-gradient(135deg, #fccb90, #d57eeb)', 'linear-gradient(135deg, #e0c3fc, #8ec5fc)',
    'linear-gradient(135deg, #f5576c, #ff6f91)', 'linear-gradient(135deg, #13547a, #80d0c7)',
  ]

  for (let i = 0; i < episodeData.length; i++) {
    const ep = episodeData[i]
    await p.query(`INSERT INTO courses (episode_id, number, title, description, category, duration, youtube_id, cover, gradient, access_level, status, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)`,
      [i + 1, ep.number, ep.title, ep.description, ep.category, ep.duration, ep.youtubeId, `/covers/ep${String(i + 1).padStart(2, '0')}.webp`, gradients[i % gradients.length], i < 3 ? 'free' : 'plus_pro', i + 1])
  }

  await p.query(`INSERT INTO trades (user_id, trade_date, title, symbol, direction, result, entry_price, exit_price, profit_pct, notes, is_public) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [1, '2026-05-15', 'SPY 看多期权策略', 'SPY', 'long', 'win', '580', '592', '+12%', '基于均线偏空逻辑的看多期权操作'])

  await p.query(`INSERT INTO trades (user_id, trade_date, title, symbol, direction, result, entry_price, exit_price, profit_pct, notes, is_public) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [1, '2026-05-20', '黄金短线做空', 'GOLD', 'short', 'win', '242', '238', '+1.6%', '非农数据利空黄金，顺势做空'])

  await p.query(`INSERT INTO notifications (user_id, type, title, message, is_read) VALUES (1, 'system', '系统初始化完成', '后台配置已完成，可以开始使用了！', 0)`)

  // Seed tags
  await p.query("INSERT IGNORE INTO post_tags (slug, label, count) VALUES (?, ?, ?)", ['gold', '黄金', 5])
  await p.query("INSERT IGNORE INTO post_tags (slug, label, count) VALUES (?, ?, ?)", ['btc', '比特币', 3])
  await p.query("INSERT IGNORE INTO post_tags (slug, label, count) VALUES (?, ?, ?)", ['spy', 'SPY', 2])
  await p.query("INSERT IGNORE INTO post_tags (slug, label, count) VALUES (?, ?, ?)", ['short-term', '短线', 4])
  await p.query("INSERT IGNORE INTO post_tags (slug, label, count) VALUES (?, ?, ?)", ['options', '期权', 1])

  // Seed system config
  const sysConfigs = [
    ['smtp', 'host', '', 'SMTP 服务器', 0], ['smtp', 'port', '587', '端口', 1],
    ['smtp', 'user', '', '用户名', 2], ['smtp', 'pass', '', '密码', 3],
    ['smtp', 'from', '', '发件人邮箱', 4], ['smtp', 'from_name', '街哥课堂', '发件人名称', 5],
    ['smtp', 'secure', 'false', 'SSL/TLS', 6],
    ['qiniu', 'access_key', '', 'Access Key', 0], ['qiniu', 'secret_key', '', 'Secret Key', 1],
    ['qiniu', 'bucket', '', '存储桶名称', 2], ['qiniu', 'domain', '', '访问域名', 3],
    ['qiniu', 'region', 'z0', '区域 (z0/cn-east/cn-south)', 4],
  ]
  for (const [cat, key, val, label, order] of sysConfigs) {
    await p.query("INSERT IGNORE INTO system_config (category, `key`, `value`, label, sort_order) VALUES (?, ?, ?, ?, ?)", [cat, key, val, label, order])
  }

  // Financial toolbox
  await p.query("INSERT IGNORE INTO system_config (category, `key`, `value`, label, sort_order) VALUES (?, ?, ?, ?, ?)", [
    'toolbox', 'items', JSON.stringify([
      { category: '交易所', items: [
        { name: 'Binance（币安）', desc: '全球最大的交易所，交易量和流动性充沛，首选', icon: '🪙', url: 'https://www.bsmkweb.cc/join?ref=WSBNONAME', tag: '首选', tagColor: '#f0b90b', code: 'WSBNONAME', rebate: '返佣 20%' },
        { name: 'OKX（欧易）', desc: '仅次于币安的交易所，合约流动性好，期权功能完善', icon: '🔵', url: 'https://www.promooboost.com/join/CRYPTO618', code: 'CRYPTO618', rebate: '返佣 20%' },
        { name: 'Bybit', desc: '适合交易黄金白银外汇，TradFi 板块手续费低', icon: '🟡', url: 'https://partner.bybit.com/b/CRYPTO618', code: 'CRYPTO618', rebate: '返佣 33%' },
        { name: 'Bitget', desc: '跟单交易平台，一键跟随优质交易员策略', icon: '🟢', url: 'https://partner.hdmune.cn/bg/v8ju2ccn', code: 'WallStreet', rebate: '返佣 40%' },
        { name: 'BIT 美股交易所', desc: '美股交易所开户链接，适合美股相关交易使用', icon: '🇺🇸', url: 'https://bit.bshareweb.com/newRegister/cn?invite_code=CY3DKV', tag: '美股', tagColor: '#2563eb', code: 'CY3DKV' }
      ]},
      { category: '看盘工具', items: [
        { name: 'TradingView', desc: '街哥自用的专业看盘软件，支持技术指标、画线工具、多图表布局，新手必备', icon: '📊', url: 'https://cn.tradingview.com/?aff_id=158703', tag: '街哥自用', tagColor: '#f7931a' }
      ]},
      { category: '数据工具', items: [
        { name: 'CoinAnk', desc: '专业加密货币数据分析平台，链上数据、资金流向、市场情绪分析', icon: '📊', url: 'https://coinank.com/zh/invite/register?referral=1458068', code: '1458068' },
        { name: 'CoinGlass', desc: '合约数据看板，爆仓数据、资金费率、持仓量一目了然', icon: '📈', url: 'https://www.coinglass.com/?ref_code=YDHYYF' },
        { name: 'CoinMarketCap', desc: '加密货币市值排名、价格追踪、项目信息查询', icon: '💹', url: 'https://coinmarketcap.com/' }
      ]}
    ]), '金融工具箱', 0
  ])

  // Market menu
  await p.query("INSERT IGNORE INTO system_config (category, `key`, `value`, label, sort_order) VALUES (?, ?, ?, ?, ?)", [
    'market_menu', 'items', JSON.stringify([
      { name: '美股财报日', icon: '📅', url: '/earnings/' },
      { name: 'AI泡沫周期监控', icon: '📉', url: '/ai%E6%B3%A1%E6%B2%AB%E5%91%A8%E6%8A%A5/' },
      { name: 'AI 转折点月度报告', icon: '📰', url: '/weekly/' },
      { name: '全球市场股票深度研究', icon: '📈', url: '/research/' }
    ]), '股票市场研究菜单', 0
  ])
}
