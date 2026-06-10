import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.DB_PATH || join(__dirname, 'data.db')

let db

export function getDB() {
  if (!db) {
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

export function logAudit({ userId, action, targetType, targetId, detail, ip, userAgent }) {
  try {
    const db = getDB()
    let userEmail = '', userNickname = ''
    if (userId) {
      const user = db.prepare('SELECT email, nickname FROM users WHERE id = ?').get(userId)
      if (user) { userEmail = user.email; userNickname = user.nickname }
    }
    db.prepare(`
      INSERT INTO audit_logs (user_id, user_email, user_nickname, action, target_type, target_id, detail, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId || null, userEmail, userNickname, action, targetType || '', targetId || null, detail || '', ip || '', userAgent || '')
  } catch (err) {
    console.error('logAudit error:', err)
  }
}

export function initDB() {
  const db = getDB()

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      nickname TEXT DEFAULT '',
      avatar TEXT DEFAULT '',
      role TEXT DEFAULT 'user',
      plan TEXT DEFAULT 'free',
      plan_period TEXT DEFAULT '',
      plan_expires_at TEXT,
      telegram_id TEXT,
      telegram_username TEXT,
      telegram_name TEXT,
      telegram_chat_id TEXT,
      telegram_group_status TEXT DEFAULT '',
      telegram_bot_started_at TEXT,
      telegram_joined_at TEXT,
      telegram_last_invite_sent_at TEXT,
      referral_code TEXT UNIQUE,
      referral_credit INTEGER DEFAULT 0,
      referred_by TEXT,
      last_seen_at TEXT,
      current_view TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER UNIQUE,
      number INTEGER,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT DEFAULT 'strategy',
      content_type TEXT DEFAULT 'video',
      duration TEXT DEFAULT '',
      youtube_id TEXT DEFAULT '',
      cover TEXT DEFAULT '',
      gradient TEXT DEFAULT '',
      article_url TEXT DEFAULT '',
      article_object_key TEXT DEFAULT '',
      access_level TEXT DEFAULT 'free',
      has_stream_video INTEGER DEFAULT 0,
      cf_stream_id TEXT DEFAULT '',
      bilibili_id TEXT DEFAULT '',
      local_video_path TEXT DEFAULT '',
      quiz_count INTEGER DEFAULT 0,
      knowledge_count INTEGER DEFAULT 0,
      mindmap_count INTEGER DEFAULT 0,
      structure_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'published',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      episode_id INTEGER NOT NULL,
      watched_seconds REAL DEFAULT 0,
      total_duration REAL DEFAULT 0,
      completed INTEGER DEFAULT 0,
      quiz_passed INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
      UNIQUE(user_id, episode_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      parent_id INTEGER,
      likes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS comment_likes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      comment_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      UNIQUE(user_id, comment_id)
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      board TEXT DEFAULT 'ideas',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      content_html TEXT DEFAULT '',
      content_text TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      tags TEXT DEFAULT '[]',
      images TEXT DEFAULT '[]',
      asset_ids TEXT DEFAULT '[]',
      pinned INTEGER DEFAULT 0,
      featured INTEGER DEFAULT 0,
      locked INTEGER DEFAULT 0,
      reply_count INTEGER DEFAULT 0,
      view_count INTEGER DEFAULT 0,
      image_count INTEGER DEFAULT 0,
      last_reply_at TEXT,
      last_reply_user_id INTEGER,
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS post_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      content_html TEXT DEFAULT '',
      content_text TEXT DEFAULT '',
      images TEXT DEFAULT '[]',
      asset_ids TEXT DEFAULT '[]',
      quote_reply_id INTEGER,
      floor_number INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS post_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER,
      reply_id INTEGER,
      user_id INTEGER NOT NULL,
      reason TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      trade_date TEXT DEFAULT '',
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      symbol TEXT DEFAULT '',
      direction TEXT DEFAULT '',
      result TEXT DEFAULT '',
      entry_price TEXT DEFAULT '',
      exit_price TEXT DEFAULT '',
      profit_pct TEXT DEFAULT '',
      pnl TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      screenshot_url TEXT DEFAULT '',
      status TEXT DEFAULT 'open',
      is_public INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_no TEXT UNIQUE NOT NULL,
      order_id TEXT UNIQUE,
      user_id INTEGER NOT NULL,
      plan TEXT NOT NULL,
      plan_label TEXT DEFAULT '',
      period TEXT DEFAULT 'month',
      period_label TEXT DEFAULT '',
      amount INTEGER DEFAULT 0,
      amount_confirmed INTEGER DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      status TEXT DEFAULT 'pending',
      status_label TEXT DEFAULT '',
      payment_method TEXT DEFAULT '',
      paid_at TEXT,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      actor_id INTEGER,
      type TEXT DEFAULT 'system',
      title TEXT DEFAULT '',
      message TEXT DEFAULT '',
      link TEXT DEFAULT '',
      post_id INTEGER,
      meta TEXT DEFAULT '{}',
      is_read INTEGER DEFAULT 0,
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      purpose TEXT DEFAULT 'login',
      expires_at TEXT NOT NULL,
      used INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS quiz_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      options TEXT NOT NULL,
      answer INTEGER DEFAULT 0,
      correct_index INTEGER DEFAULT 0,
      explanation TEXT DEFAULT '',
      explanations TEXT DEFAULT '[]',
      hint TEXT DEFAULT '',
      status TEXT DEFAULT 'published',
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS course_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT DEFAULT '',
      content TEXT DEFAULT '',
      url TEXT DEFAULT '',
      structure TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_id INTEGER NOT NULL,
      referred_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      commission INTEGER DEFAULT 0,
      amount_cents INTEGER DEFAULT 0,
      plan_label TEXT DEFAULT '',
      attributed_at TEXT,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS user_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      notice_id TEXT DEFAULT '',
      type TEXT DEFAULT '',
      title TEXT DEFAULT '',
      body TEXT DEFAULT '',
      link TEXT DEFAULT '',
      source TEXT DEFAULT '',
      read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS video_streams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER NOT NULL,
      video_key TEXT NOT NULL,
      bilibili_id TEXT DEFAULT '',
      local_path TEXT DEFAULT '',
      qiniu_key TEXT DEFAULT '',
      quality TEXT DEFAULT '720p',
      duration REAL DEFAULT 0,
      file_size INTEGER DEFAULT 0,
      access_level TEXT DEFAULT 'plus_pro',
      title TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS post_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      file_name TEXT DEFAULT '',
      file_type TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      url TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );

    CREATE TABLE IF NOT EXISTS post_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS system_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT DEFAULT '',
      label TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
      UNIQUE(category, key)
    );

    CREATE TABLE IF NOT EXISTS ai_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL DEFAULT 'default',
      api_provider TEXT NOT NULL DEFAULT 'deepseek',
      api_key_encrypted TEXT,
      api_base_url TEXT,
      model_name TEXT NOT NULL DEFAULT 'deepseek-chat',
      temperature REAL NOT NULL DEFAULT 0.7,
      max_tokens INTEGER NOT NULL DEFAULT 2000,
      enable_auto_trade INTEGER NOT NULL DEFAULT 0,
      enable_futures_trading INTEGER NOT NULL DEFAULT 0,
      risk_level TEXT NOT NULL DEFAULT 'medium',
      max_position_size REAL NOT NULL DEFAULT 0.05,
      selected_take_profit INTEGER NOT NULL DEFAULT 1,
      system_prompt TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, session_id, api_provider)
    );

    CREATE TABLE IF NOT EXISTS ai_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      config_id INTEGER REFERENCES ai_configs(id) ON DELETE SET NULL,
      session_id TEXT NOT NULL DEFAULT 'default',
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      signal_type TEXT NOT NULL,
      confidence REAL NOT NULL,
      recommended_volume REAL NOT NULL,
      analysis TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      stop_loss_price REAL,
      take_profit_1_price REAL,
      take_profit_2_price REAL,
      take_profit_3_price REAL,
      market_data_json TEXT NOT NULL,
      ai_model TEXT NOT NULL DEFAULT 'deepseek-chat',
      ttl_seconds INTEGER,
      is_executed INTEGER NOT NULL DEFAULT 0,
      execution_result TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trade_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      symbol TEXT,
      request_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ui_configs (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme TEXT NOT NULL DEFAULT 'theme2',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auto_scheduler (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      symbols TEXT NOT NULL DEFAULT '["XAUUSD"]',
      timeframes TEXT NOT NULL DEFAULT '["M15"]',
      interval_seconds INTEGER NOT NULL DEFAULT 900,
      enabled INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', '+8 hours')),
      UNIQUE(user_id)
    );
  `)

  // Seed demo data if empty
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c
  if (userCount === 0) {
    seedData(db)
  } else {
    // Migration: add missing columns if needed
    migrateDB(db)
  }

}

function migrateDB(db) {
  const columns = db.prepare("PRAGMA table_info(users)").all().map(c => c.name)
  const addCol = (table, col, def) => {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`) } catch {}
  }
  if (!columns.includes('plan_period')) addCol('users', 'plan_period', "TEXT DEFAULT ''")
  if (!columns.includes('telegram_username')) addCol('users', 'telegram_username', "TEXT DEFAULT ''")
  if (!columns.includes('telegram_name')) addCol('users', 'telegram_name', "TEXT DEFAULT ''")
  if (!columns.includes('telegram_group_status')) addCol('users', 'telegram_group_status', "TEXT DEFAULT ''")
  if (!columns.includes('telegram_bot_started_at')) addCol('users', 'telegram_bot_started_at', "TEXT")
  if (!columns.includes('telegram_joined_at')) addCol('users', 'telegram_joined_at', "TEXT")
  if (!columns.includes('telegram_last_invite_sent_at')) addCol('users', 'telegram_last_invite_sent_at', "TEXT")
  if (!columns.includes('last_seen_at')) addCol('users', 'last_seen_at', "TEXT")
  if (!columns.includes('current_view')) addCol('users', 'current_view', "TEXT DEFAULT ''")
  if (!columns.includes('uid')) addCol('users', 'uid', "TEXT")

  // Generate UIDs for existing users without one
  try {
    const usersWithoutUid = db.prepare('SELECT id FROM users WHERE uid IS NULL OR uid = ""').all()
    const updateUid = db.prepare('UPDATE users SET uid = ? WHERE id = ?')
    for (const u of usersWithoutUid) {
      updateUid.run('WS' + String(u.id).padStart(6, '0'), u.id)
    }
  } catch {}

  const postCols = db.prepare("PRAGMA table_info(posts)").all().map(c => c.name)
  if (!postCols.includes('board')) addCol('posts', 'board', "TEXT DEFAULT 'ideas'")
  if (!postCols.includes('content_html')) addCol('posts', 'content_html', "TEXT DEFAULT ''")
  if (!postCols.includes('content_text')) addCol('posts', 'content_text', "TEXT DEFAULT ''")
  if (!postCols.includes('tags')) addCol('posts', 'tags', "TEXT DEFAULT '[]'")
  if (!postCols.includes('asset_ids')) addCol('posts', 'asset_ids', "TEXT DEFAULT '[]'")
  if (!postCols.includes('image_count')) addCol('posts', 'image_count', "INTEGER DEFAULT 0")
  if (!postCols.includes('last_reply_user_id')) addCol('posts', 'last_reply_user_id', "INTEGER")

  const replyCols = db.prepare("PRAGMA table_info(post_replies)").all().map(c => c.name)
  if (!replyCols.includes('content_html')) addCol('post_replies', 'content_html', "TEXT DEFAULT ''")
  if (!replyCols.includes('content_text')) addCol('post_replies', 'content_text', "TEXT DEFAULT ''")
  if (!replyCols.includes('asset_ids')) addCol('post_replies', 'asset_ids', "TEXT DEFAULT '[]'")
  if (!replyCols.includes('quote_reply_id')) addCol('post_replies', 'quote_reply_id', "INTEGER")
  if (!replyCols.includes('floor_number')) addCol('post_replies', 'floor_number', "INTEGER DEFAULT 0")

  const tradeCols = db.prepare("PRAGMA table_info(trades)").all().map(c => c.name)
  if (!tradeCols.includes('trade_date')) addCol('trades', 'trade_date', "TEXT DEFAULT ''")
  if (!tradeCols.includes('result')) addCol('trades', 'result', "TEXT DEFAULT ''")
  if (!tradeCols.includes('profit_pct')) addCol('trades', 'profit_pct', "TEXT DEFAULT ''")
  if (!tradeCols.includes('notes')) addCol('trades', 'notes', "TEXT DEFAULT ''")
  if (!tradeCols.includes('screenshot_url')) addCol('trades', 'screenshot_url', "TEXT DEFAULT ''")

  const orderCols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name)
  if (!orderCols.includes('order_id')) addCol('orders', 'order_id', "TEXT")
  if (!orderCols.includes('plan_label')) addCol('orders', 'plan_label', "TEXT DEFAULT ''")
  if (!orderCols.includes('period_label')) addCol('orders', 'period_label', "TEXT DEFAULT ''")
  if (!orderCols.includes('amount_confirmed')) addCol('orders', 'amount_confirmed', "INTEGER DEFAULT 0")
  if (!orderCols.includes('status_label')) addCol('orders', 'status_label', "TEXT DEFAULT ''")

  const notifCols = db.prepare("PRAGMA table_info(notifications)").all().map(c => c.name)
  if (!notifCols.includes('actor_id')) addCol('notifications', 'actor_id', "INTEGER")
  if (!notifCols.includes('post_id')) addCol('notifications', 'post_id', "INTEGER")
  if (!notifCols.includes('meta')) addCol('notifications', 'meta', "TEXT DEFAULT '{}'")
  if (!notifCols.includes('is_read')) addCol('notifications', 'is_read', "INTEGER DEFAULT 0")

  const courseCols = db.prepare("PRAGMA table_info(courses)").all().map(c => c.name)
  if (!courseCols.includes('cf_stream_id')) addCol('courses', 'cf_stream_id', "TEXT DEFAULT ''")
  if (!courseCols.includes('bilibili_id')) addCol('courses', 'bilibili_id', "TEXT DEFAULT ''")
  if (!courseCols.includes('local_video_path')) addCol('courses', 'local_video_path', "TEXT DEFAULT ''")

  const progressCols = db.prepare("PRAGMA table_info(progress)").all().map(c => c.name)
  if (!progressCols.includes('quiz_passed')) addCol('progress', 'quiz_passed', "INTEGER DEFAULT 0")

  const quizCols = db.prepare("PRAGMA table_info(quiz_questions)").all().map(c => c.name)
  if (!quizCols.includes('answer')) addCol('quiz_questions', 'answer', "INTEGER DEFAULT 0")
  if (!quizCols.includes('explanations')) addCol('quiz_questions', 'explanations', "TEXT DEFAULT '[]'")
  if (!quizCols.includes('hint')) addCol('quiz_questions', 'hint', "TEXT DEFAULT ''")
  if (!quizCols.includes('status')) addCol('quiz_questions', 'status', "TEXT DEFAULT 'published'")

  const resourceCols = db.prepare("PRAGMA table_info(course_resources)").all().map(c => c.name)
  if (!resourceCols.includes('structure')) addCol('course_resources', 'structure', "TEXT DEFAULT ''")

  const refCols = db.prepare("PRAGMA table_info(referrals)").all().map(c => c.name)
  if (!refCols.includes('amount_cents')) addCol('referrals', 'amount_cents', "INTEGER DEFAULT 0")
  if (!refCols.includes('plan_label')) addCol('referrals', 'plan_label', "TEXT DEFAULT ''")
  if (!refCols.includes('attributed_at')) addCol('referrals', 'attributed_at', "TEXT")

  const noticeCols = db.prepare("PRAGMA table_info(user_notices)").all().map(c => c.name)
  if (!noticeCols.includes('notice_id')) addCol('user_notices', 'notice_id', "TEXT DEFAULT ''")
  if (!noticeCols.includes('source')) addCol('user_notices', 'source', "TEXT DEFAULT ''")

  const reportCols = db.prepare("PRAGMA table_info(post_reports)").all().map(c => c.name)
  if (!reportCols.includes('detail')) addCol('post_reports', 'detail', "TEXT DEFAULT ''")

  const streamCols = db.prepare("PRAGMA table_info(video_streams)").all().map(c => c.name)
  if (!streamCols.includes('cf_stream_id')) addCol('video_streams', 'cf_stream_id', "TEXT DEFAULT ''")
  if (!streamCols.includes('access_level')) addCol('video_streams', 'access_level', "TEXT DEFAULT 'plus_pro'")
  if (!streamCols.includes('title')) addCol('video_streams', 'title', "TEXT DEFAULT ''")
  if (!streamCols.includes('bilibili_id')) addCol('video_streams', 'bilibili_id', "TEXT DEFAULT ''")
  if (!streamCols.includes('local_path')) addCol('video_streams', 'local_path', "TEXT DEFAULT ''")
  if (!streamCols.includes('qiniu_key')) addCol('video_streams', 'qiniu_key', "TEXT DEFAULT ''")

  // AI tables migration
  const aiSignalCols = db.prepare("PRAGMA table_info(ai_signals)").all().map(c => c.name)
  if (!aiSignalCols.includes('config_id')) addCol('ai_signals', 'config_id', 'INTEGER')
  if (!aiSignalCols.includes('session_id')) addCol('ai_signals', 'session_id', "TEXT NOT NULL DEFAULT 'default'")
  if (!aiSignalCols.includes('ai_model')) addCol('ai_signals', 'ai_model', "TEXT NOT NULL DEFAULT 'deepseek-chat'")
  if (!aiSignalCols.includes('ttl_seconds')) addCol('ai_signals', 'ttl_seconds', 'INTEGER')

  // Create tables that may not exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS post_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL,
      file_name TEXT DEFAULT '',
      file_type TEXT DEFAULT '',
      file_size INTEGER DEFAULT 0,
      url TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );
    CREATE TABLE IF NOT EXISTS post_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL,
      count INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS system_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT DEFAULT '',
      label TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now', '+8 hours')),
      updated_at TEXT DEFAULT (datetime('now', '+8 hours')),
      UNIQUE(category, key)
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      user_email TEXT DEFAULT '',
      user_nickname TEXT DEFAULT '',
      action TEXT NOT NULL,
      target_type TEXT DEFAULT '',
      target_id INTEGER,
      detail TEXT DEFAULT '',
      ip TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now', '+8 hours'))
    );
  `)
}

function seedData(db) {
  const hash = bcrypt.hashSync('admin123', 10)
  db.prepare(`
    INSERT INTO users (email, password, nickname, role, plan, plan_expires_at, referral_code)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('admin@wallstreetskill.com', hash, '街哥', 'admin', 'pro', '2027-12-31', 'ADMIN001')

  const demoHash = bcrypt.hashSync('demo123', 10)
  db.prepare(`
    INSERT INTO users (email, password, nickname, role, plan, referral_code)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('demo@example.com', demoHash, 'Demo User', 'user', 'free', 'DEMO001')

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

  const insertCourse = db.prepare(`
    INSERT INTO courses (episode_id, number, title, description, category, duration, youtube_id, cover, gradient, access_level, status, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', ?)
  `)

  for (let i = 0; i < episodeData.length; i++) {
    const ep = episodeData[i]
    insertCourse.run(i + 1, ep.number, ep.title, ep.description, ep.category, ep.duration, ep.youtubeId, `/covers/ep${String(i+1).padStart(2,'0')}.webp`, gradients[i % gradients.length], i < 3 ? 'free' : 'plus_pro', i + 1)
  }

  // Seed trades
  const insertTrade = db.prepare(`
    INSERT INTO trades (user_id, trade_date, title, symbol, direction, result, entry_price, exit_price, profit_pct, notes, is_public)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `)
  insertTrade.run(1, '2026-05-15', 'SPY 看多期权策略', 'SPY', 'long', 'win', '580', '592', '+12%', '基于均线偏空逻辑的看多期权操作')
  insertTrade.run(1, '2026-05-20', '黄金短线做空', 'GOLD', 'short', 'win', '242', '238', '+1.6%', '非农数据利空黄金，顺势做空')

  // Seed notifications (admin only)
  db.prepare(`
    INSERT INTO notifications (user_id, type, title, message, is_read) VALUES (1, 'system', '系统初始化完成', '后台配置已完成，可以开始使用了！', 0)
  `).run()

  // Seed tags
  db.prepare("INSERT OR IGNORE INTO post_tags (slug, label, count) VALUES (?, ?, ?)").run('gold', '黄金', 5)
  db.prepare("INSERT OR IGNORE INTO post_tags (slug, label, count) VALUES (?, ?, ?)").run('btc', '比特币', 3)
  db.prepare("INSERT OR IGNORE INTO post_tags (slug, label, count) VALUES (?, ?, ?)").run('spy', 'SPY', 2)
  db.prepare("INSERT OR IGNORE INTO post_tags (slug, label, count) VALUES (?, ?, ?)").run('short-term', '短线', 4)
  db.prepare("INSERT OR IGNORE INTO post_tags (slug, label, count) VALUES (?, ?, ?)").run('options', '期权', 1)

  // Seed system config
  const insertConfig = db.prepare(`
    INSERT OR IGNORE INTO system_config (category, key, value, label, sort_order) VALUES (?, ?, ?, ?, ?)
  `)
  // SMTP email config
  insertConfig.run('smtp', 'host', '', 'SMTP 服务器', 0)
  insertConfig.run('smtp', 'port', '587', '端口', 1)
  insertConfig.run('smtp', 'user', '', '用户名', 2)
  insertConfig.run('smtp', 'pass', '', '密码', 3)
  insertConfig.run('smtp', 'from', '', '发件人邮箱', 4)
  insertConfig.run('smtp', 'from_name', '街哥课堂', '发件人名称', 5)
  insertConfig.run('smtp', 'secure', 'false', 'SSL/TLS', 6)

  // Qiniu cloud storage config
  insertConfig.run('qiniu', 'access_key', '', 'Access Key', 0)
  insertConfig.run('qiniu', 'secret_key', '', 'Secret Key', 1)
  insertConfig.run('qiniu', 'bucket', '', '存储桶名称', 2)
  insertConfig.run('qiniu', 'domain', '', '访问域名', 3)
  insertConfig.run('qiniu', 'region', 'z0', '区域 (z0/cn-east/cn-south)', 4)

  // Financial toolbox items (stored as JSON array)
  insertConfig.run('toolbox', 'items', JSON.stringify([
    {
      category: '交易所',
      items: [
        { name: 'Binance（币安）', desc: '全球最大的交易所，交易量和流动性充沛，首选', icon: '🪙', url: 'https://www.bsmkweb.cc/join?ref=WSBNONAME', tag: '首选', tagColor: '#f0b90b', code: 'WSBNONAME', rebate: '返佣 20%' },
        { name: 'OKX（欧易）', desc: '仅次于币安的交易所，合约流动性好，期权功能完善', icon: '🔵', url: 'https://www.promooboost.com/join/CRYPTO618', code: 'CRYPTO618', rebate: '返佣 20%' },
        { name: 'Bybit', desc: '适合交易黄金白银外汇，TradFi 板块手续费低', icon: '🟡', url: 'https://partner.bybit.com/b/CRYPTO618', code: 'CRYPTO618', rebate: '返佣 33%' },
        { name: 'Bitget', desc: '跟单交易平台，一键跟随优质交易员策略', icon: '🟢', url: 'https://partner.hdmune.cn/bg/v8ju2ccn', code: 'WallStreet', rebate: '返佣 40%' },
        { name: 'BIT 美股交易所', desc: '美股交易所开户链接，适合美股相关交易使用', icon: '🇺🇸', url: 'https://bit.bshareweb.com/newRegister/cn?invite_code=CY3DKV', tag: '美股', tagColor: '#2563eb', code: 'CY3DKV' }
      ]
    },
    {
      category: '看盘工具',
      items: [
        { name: 'TradingView', desc: '街哥自用的专业看盘软件，支持技术指标、画线工具、多图表布局，新手必备', icon: '📊', url: 'https://cn.tradingview.com/?aff_id=158703', tag: '街哥自用', tagColor: '#f7931a' }
      ]
    },
    {
      category: '数据工具',
      items: [
        { name: 'CoinAnk', desc: '专业加密货币数据分析平台，链上数据、资金流向、市场情绪分析', icon: '📊', url: 'https://coinank.com/zh/invite/register?referral=1458068', code: '1458068' },
        { name: 'CoinGlass', desc: '合约数据看板，爆仓数据、资金费率、持仓量一目了然', icon: '📈', url: 'https://www.coinglass.com/?ref_code=YDHYYF' },
        { name: 'CoinMarketCap', desc: '加密货币市值排名、价格追踪、项目信息查询', icon: '💹', url: 'https://coinmarketcap.com/' }
      ]
    }
  ]), '金融工具箱', 0)

  // Stock market research menu items
  insertConfig.run('market_menu', 'items', JSON.stringify([
    { name: '美股财报日', icon: '📅', url: '/earnings/' },
    { name: 'AI泡沫周期监控', icon: '📉', url: '/ai泡沫周报/' },
    { name: 'AI 转折点月度报告', icon: '📰', url: '/weekly/' },
    { name: '全球市场股票深度研究', icon: '📈', url: '/research/' }
  ]), '股票市场研究菜单', 0)

}
