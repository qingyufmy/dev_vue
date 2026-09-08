CREATE TABLE `trading_context_changes_v4` (
  user_id INT NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action ENUM('select_account','enter_observer','leave_observer') NOT NULL,
  target_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  prior_revision BIGINT UNSIGNED NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  result_mode ENUM('full','observer','blocked') NOT NULL,
  result_account_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  result_observer_channel_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  result_read_only TINYINT UNSIGNED NOT NULL,
  recorded_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id,request_id),
  UNIQUE KEY uk_context_changes_revision (user_id,revision),
  KEY idx_context_changes_recorded (recorded_at_utc,user_id,revision),
  CONSTRAINT fk_context_changes_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT chk_context_changes_revision CHECK (prior_revision < 9007199254740991 AND revision = prior_revision + 1),
  CONSTRAINT chk_context_changes_read_only CHECK (result_read_only IN (0,1)),
  CONSTRAINT chk_context_changes_target CHECK (
    (action='leave_observer' AND target_id IS NULL) OR
    (action IN ('select_account','enter_observer') AND target_id IS NOT NULL AND CHAR_LENGTH(target_id)>0)
  ),
  CONSTRAINT chk_context_changes_result CHECK (
    (result_mode='full' AND result_account_id IS NOT NULL AND result_observer_channel_id IS NULL) OR
    (result_mode='observer' AND result_account_id IS NULL AND result_observer_channel_id IS NOT NULL AND result_read_only=1) OR
    (result_mode='blocked' AND result_account_id IS NULL AND result_observer_channel_id IS NULL AND result_read_only=1)
  ),
  CONSTRAINT chk_context_changes_action_result CHECK (
    (action='select_account' AND result_mode='full' AND result_account_id=target_id) OR
    (action='enter_observer' AND result_mode='observer' AND result_observer_channel_id=target_id) OR
    (action='leave_observer' AND result_mode IN ('full','blocked'))
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
