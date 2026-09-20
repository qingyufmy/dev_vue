CREATE TABLE IF NOT EXISTS manual_candidate_tasks_v4 (
  history_task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('pending','waiting','succeeded') NOT NULL DEFAULT 'pending',
  after_record_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  page_attempts BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_results_json JSON NULL,
  next_attempt_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (history_task_id),
  KEY idx_manual_candidate_tasks_due (status,next_attempt_at_utc,history_task_id),
  CONSTRAINT fk_manual_candidate_tasks_history FOREIGN KEY (history_task_id) REFERENCES history_collection_tasks_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
