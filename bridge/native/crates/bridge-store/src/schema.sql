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
CREATE TABLE IF NOT EXISTS history_archive_state (
  terminal_instance_id TEXT NOT NULL,
  broker_server TEXT COLLATE NOCASE NOT NULL,
  login_account TEXT NOT NULL,
  cursor_value TEXT NOT NULL,
  is_complete INTEGER NOT NULL DEFAULT 0,
  updated_at_utc_msc INTEGER NOT NULL,
  PRIMARY KEY (terminal_instance_id, broker_server, login_account)
);
