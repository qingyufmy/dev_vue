CREATE TABLE IF NOT EXISTS user_notification_preferences_v4 (
 user_id INT NOT NULL PRIMARY KEY,
 nickname VARCHAR(80) NOT NULL DEFAULT '',
 preferences_json JSON NOT NULL,
 revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
 updated_at_utc DATETIME(3) NOT NULL,
 created_at_utc DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS user_notifications_v4 (
 id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 user_id INT NOT NULL,
 kind VARCHAR(16) NOT NULL,
 resource_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 title VARCHAR(200) NOT NULL,
 summary TEXT NOT NULL,
 actionable TINYINT NOT NULL,
 created_at_utc DATETIME(3) NOT NULL,
 read_at_utc DATETIME(3) NULL,
 PRIMARY KEY(user_id,id),
 KEY notification_user_time(user_id,created_at_utc,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS notification_settings_receipts_v4 (
 user_id INT NOT NULL,
 request_key VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 response_json JSON NOT NULL,
 created_at_utc DATETIME(3) NOT NULL,
 PRIMARY KEY(user_id,request_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS notification_deliveries_v4 (
 user_id INT NOT NULL,
 message_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 channel VARCHAR(16) NOT NULL,
 status VARCHAR(16) NOT NULL,
 created_at_utc DATETIME(3) NOT NULL,
 completed_at_utc DATETIME(3) NULL,
 PRIMARY KEY(user_id,message_id,channel),
 KEY notification_pending(status,created_at_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
