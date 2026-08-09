CREATE TABLE IF NOT EXISTS terminal_bindings (
  terminal_instance_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  terminal_path TEXT NOT NULL,
  broker_server TEXT NOT NULL,
  login_account TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL,
  updated_at_utc_msc INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stream_revisions (
  terminal_instance_id TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL,
  stream TEXT NOT NULL,
  revision INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  observed_at_utc_msc INTEGER NOT NULL,
  source_time_msc INTEGER,
  PRIMARY KEY (terminal_instance_id, connection_epoch, stream)
);
CREATE TABLE IF NOT EXISTS account_latest (
  terminal_instance_id TEXT PRIMARY KEY,
  connection_epoch INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  observed_at_utc_msc INTEGER NOT NULL,
  source_time_msc INTEGER,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS positions_latest (
  terminal_instance_id TEXT NOT NULL,
  ticket TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  observed_at_utc_msc INTEGER NOT NULL,
  source_time_msc INTEGER,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (terminal_instance_id, ticket)
);
CREATE TABLE IF NOT EXISTS orders_latest (
  terminal_instance_id TEXT NOT NULL,
  ticket TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  observed_at_utc_msc INTEGER NOT NULL,
  source_time_msc INTEGER,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (terminal_instance_id, ticket)
);
CREATE TABLE IF NOT EXISTS deals_pending (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  ticket TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  deal_time_msc INTEGER NOT NULL,
  observed_at_utc_msc INTEGER NOT NULL,
  source_time_msc INTEGER,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (terminal_instance_id, broker_server, login_account, ticket)
);
CREATE INDEX IF NOT EXISTS idx_deals_pending_cursor
  ON deals_pending (
    terminal_instance_id, broker_server, login_account, deal_time_msc, ticket
  );
CREATE TABLE IF NOT EXISTS history_cursors (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  stream TEXT NOT NULL,
  cursor_value TEXT NOT NULL,
  updated_at_utc_msc INTEGER NOT NULL,
  PRIMARY KEY (terminal_instance_id, broker_server, login_account, stream)
);
CREATE TABLE IF NOT EXISTS outbox_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE,
  message_type TEXT NOT NULL,
  terminal_instance_id TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL,
  priority TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_utc_msc INTEGER,
  created_at_utc_msc INTEGER NOT NULL,
  acked_at_utc_msc INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outbox_ready
  ON outbox_messages (acked_at_utc_msc, priority, id);
CREATE INDEX IF NOT EXISTS idx_outbox_retry_ready
  ON outbox_messages (acked_at_utc_msc, next_attempt_at_utc_msc, priority, id);
CREATE INDEX IF NOT EXISTS idx_outbox_stream_scope
  ON outbox_messages (
    terminal_instance_id, connection_epoch, message_type, acked_at_utc_msc
  );
CREATE TABLE IF NOT EXISTS execution_receipts (
  command_id TEXT PRIMARY KEY,
  terminal_instance_id TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT NOT NULL,
  completed_at_utc_msc INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_execution_receipts_completed
  ON execution_receipts (completed_at_utc_msc DESC);
CREATE TABLE IF NOT EXISTS terminal_data_cache (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  connection_epoch INTEGER NOT NULL,
  action TEXT NOT NULL,
  params_hash TEXT NOT NULL,
  observed_at_utc_msc INTEGER NOT NULL,
  cached_at_utc_msc INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (
    terminal_instance_id, broker_server, login_account, connection_epoch, action, params_hash
  )
);
CREATE INDEX IF NOT EXISTS idx_terminal_data_cache_freshness
  ON terminal_data_cache (cached_at_utc_msc);
CREATE TABLE IF NOT EXISTS module_versions (
  module_id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at_utc_msc INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS update_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  active_version TEXT,
  staged_version TEXT,
  last_known_good_version TEXT,
  status TEXT NOT NULL,
  updated_at_utc_msc INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history_archive_items (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  platform TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  event_time_msc INTEGER NOT NULL,
  position_id TEXT,
  order_ticket TEXT,
  symbol TEXT,
  payload_json TEXT NOT NULL,
  direction TEXT,
  net_profit REAL,
  volume REAL,
  capital_kind TEXT,
  capital_amount REAL,
  summary_day_utc_msc INTEGER,
  updated_at_utc_msc INTEGER NOT NULL,
  PRIMARY KEY (
    terminal_instance_id, broker_server, login_account, item_kind, item_id
  )
);
CREATE INDEX IF NOT EXISTS idx_history_archive_page
  ON history_archive_items (
    terminal_instance_id, broker_server, login_account,
    item_kind, event_time_msc DESC, item_id DESC
  );
CREATE INDEX IF NOT EXISTS idx_history_archive_position
  ON history_archive_items (
    terminal_instance_id, broker_server, login_account,
    item_kind, position_id, event_time_msc
  );
CREATE INDEX IF NOT EXISTS idx_history_archive_order
  ON history_archive_items (
    terminal_instance_id, broker_server, login_account,
    item_kind, order_ticket, event_time_msc, item_id
  );
CREATE INDEX IF NOT EXISTS idx_history_archive_summary_scope
  ON history_archive_items (
    terminal_instance_id, broker_server, login_account, platform,
    item_kind, summary_day_utc_msc, direction, event_time_msc, item_id
  );
CREATE INDEX IF NOT EXISTS idx_history_archive_trade_filter
  ON history_archive_items (
    terminal_instance_id, broker_server, login_account, platform,
    item_kind, direction, net_profit, event_time_msc, item_id
  );
CREATE TABLE IF NOT EXISTS history_archive_state (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  cursor_value TEXT NOT NULL,
  is_complete INTEGER NOT NULL DEFAULT 0,
  updated_at_utc_msc INTEGER NOT NULL,
  PRIMARY KEY (terminal_instance_id, broker_server, login_account)
);

CREATE TABLE IF NOT EXISTS account_initialization_state (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('mt4', 'mt5')),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0 AND schema_version <= 1000),
  state TEXT NOT NULL CHECK (
    state IN (
      'detected', 'verifying_identity', 'warming_realtime_snapshot',
      'reconciling_local_commands', 'ready', 'retrying', 'blocked', 'superseded'
    )
  ),
  local_operational_ready INTEGER NOT NULL CHECK (local_operational_ready IN (0, 1)),
  last_error_code TEXT,
  initialized_at_utc_msc INTEGER NOT NULL CHECK (initialized_at_utc_msc > 0),
  updated_at_utc_msc INTEGER NOT NULL CHECK (updated_at_utc_msc > 0),
  CHECK (
    (state = 'ready' AND local_operational_ready = 1)
    OR (state <> 'ready' AND local_operational_ready = 0)
  ),
  PRIMARY KEY (terminal_instance_id, broker_server, login_account)
);

CREATE INDEX IF NOT EXISTS idx_account_initialization_updated
  ON account_initialization_state (
    terminal_instance_id, broker_server, login_account, updated_at_utc_msc DESC
  );

CREATE TABLE IF NOT EXISTS history_sync_jobs (
  job_id TEXT PRIMARY KEY,
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  job_kind TEXT NOT NULL CHECK (job_kind IN ('recent', 'on_demand', 'backfill')),
  priority TEXT NOT NULL CHECK (priority IN ('p1', 'p2', 'p3')),
  range_start_utc_msc INTEGER NOT NULL CHECK (range_start_utc_msc > 0),
  range_end_utc_msc INTEGER NOT NULL CHECK (
    range_end_utc_msc > range_start_utc_msc
  ),
  cursor_time_msc INTEGER NOT NULL CHECK (cursor_time_msc > 0),
  cursor_ticket TEXT NOT NULL CHECK (
    length(cursor_ticket) <= 32
    AND (cursor_ticket = '' OR cursor_ticket NOT GLOB '*[^0-9]*')
  ),
  window_msc INTEGER NOT NULL CHECK (window_msc > 0),
  state TEXT NOT NULL CHECK (
    state IN ('queued', 'running', 'retrying', 'blocked', 'superseded', 'completed')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 1000000),
  next_attempt_at_utc_msc INTEGER NOT NULL CHECK (next_attempt_at_utc_msc > 0),
  last_error_code TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at_utc_msc INTEGER CHECK (
    lease_expires_at_utc_msc IS NULL OR lease_expires_at_utc_msc > 0
  ),
  created_at_utc_msc INTEGER NOT NULL CHECK (created_at_utc_msc > 0),
  updated_at_utc_msc INTEGER NOT NULL CHECK (updated_at_utc_msc > 0),
  UNIQUE (
    terminal_instance_id, broker_server, login_account,
    range_start_utc_msc, range_end_utc_msc
  )
);

CREATE INDEX IF NOT EXISTS idx_history_sync_jobs_claim
  ON history_sync_jobs (
    terminal_instance_id, broker_server, login_account,
    state, priority, next_attempt_at_utc_msc, created_at_utc_msc
  );
CREATE INDEX IF NOT EXISTS idx_history_sync_jobs_scope
  ON history_sync_jobs (
    terminal_instance_id, broker_server, login_account, updated_at_utc_msc DESC
  );

CREATE TABLE IF NOT EXISTS history_coverage_ranges (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  range_start_utc_msc INTEGER NOT NULL CHECK (range_start_utc_msc > 0),
  range_end_utc_msc INTEGER NOT NULL CHECK (
    range_end_utc_msc > range_start_utc_msc
  ),
  observed_at_utc_msc INTEGER NOT NULL CHECK (observed_at_utc_msc > 0),
  updated_at_utc_msc INTEGER NOT NULL CHECK (updated_at_utc_msc > 0),
  PRIMARY KEY (
    terminal_instance_id, broker_server, login_account, range_start_utc_msc
  )
);

CREATE INDEX IF NOT EXISTS idx_history_coverage_ranges_scope
  ON history_coverage_ranges (
    terminal_instance_id, broker_server, login_account,
    range_start_utc_msc, range_end_utc_msc
  );

-- Additive runtime state.  The broker key is NOCASE and platform is part of
-- the primary key so MT4/MT5 (and accounts that reuse a login) never share a
-- revision or freshness marker.
CREATE TABLE IF NOT EXISTS history_scope_state (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('mt4', 'mt5')),
  head_ready INTEGER NOT NULL DEFAULT 0 CHECK (head_ready IN (0, 1)),
  head_range_start_utc_msc INTEGER,
  head_range_end_utc_msc INTEGER,
  coverage_complete INTEGER NOT NULL DEFAULT 0 CHECK (coverage_complete IN (0, 1)),
  freshness_state TEXT NOT NULL CHECK (freshness_state IN ('fresh', 'refreshing', 'stale', 'blocked')),
  fresh_through_utc_msc INTEGER,
  history_revision INTEGER NOT NULL DEFAULT 0 CHECK (history_revision >= 0),
  summary_revision INTEGER NOT NULL DEFAULT 0 CHECK (summary_revision >= 0),
  summary_status TEXT NOT NULL CHECK (summary_status IN ('pending', 'rebuilding', 'ready', 'unavailable')),
  updated_at_utc_msc INTEGER NOT NULL DEFAULT 0 CHECK (updated_at_utc_msc >= 0),
  CHECK (
    (head_ready = 0 AND head_range_start_utc_msc IS NULL AND head_range_end_utc_msc IS NULL)
    OR (head_ready = 1 AND head_range_start_utc_msc IS NOT NULL
        AND head_range_end_utc_msc IS NOT NULL
        AND head_range_end_utc_msc > head_range_start_utc_msc)
  ),
  CHECK (fresh_through_utc_msc IS NULL OR fresh_through_utc_msc > 0),
  PRIMARY KEY (terminal_instance_id, broker_server, login_account, platform)
);
CREATE INDEX IF NOT EXISTS idx_history_scope_state_updated
  ON history_scope_state (
    terminal_instance_id, broker_server, login_account, platform,
    updated_at_utc_msc DESC
  );

CREATE TABLE IF NOT EXISTS history_daily_summary (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('mt4', 'mt5')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  summary_day_utc_msc INTEGER NOT NULL CHECK (summary_day_utc_msc >= 0),
  item_kind TEXT NOT NULL CHECK (item_kind IN ('trade', 'deal')),
  direction TEXT NOT NULL DEFAULT '',
  profit_bucket TEXT NOT NULL DEFAULT '',
  trade_count INTEGER NOT NULL DEFAULT 0 CHECK (trade_count >= 0),
  net_profit REAL NOT NULL DEFAULT 0,
  volume REAL NOT NULL DEFAULT 0,
  deal_deposit REAL NOT NULL DEFAULT 0,
  deal_withdrawal REAL NOT NULL DEFAULT 0,
  deal_credit REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (
    terminal_instance_id, broker_server, login_account, platform,
    generation, summary_day_utc_msc, item_kind, direction, profit_bucket
  )
);
CREATE INDEX IF NOT EXISTS idx_history_daily_summary_active
  ON history_daily_summary (
    terminal_instance_id, broker_server, login_account, platform,
    generation, summary_day_utc_msc, item_kind, direction, profit_bucket
  );

CREATE TABLE IF NOT EXISTS history_summary_builds (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('mt4', 'mt5')),
  active_generation INTEGER CHECK (active_generation IS NULL OR active_generation > 0),
  building_generation INTEGER CHECK (building_generation IS NULL OR building_generation > 0),
  updated_at_utc_msc INTEGER NOT NULL CHECK (updated_at_utc_msc >= 0),
  PRIMARY KEY (terminal_instance_id, broker_server, login_account, platform)
);
CREATE INDEX IF NOT EXISTS idx_history_summary_builds_updated
  ON history_summary_builds (
    terminal_instance_id, broker_server, login_account, platform,
    updated_at_utc_msc DESC
  );
