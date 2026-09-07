CREATE TABLE learning_progress_changes (
  user_id INT NOT NULL,
  request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  course_id INT NOT NULL,
  lesson_id INT NOT NULL,
  prior_revision BIGINT UNSIGNED NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  prior_completed TINYINT NULL,
  completed TINYINT NOT NULL,
  prior_updated_at_utc DATETIME(3) NULL,
  recorded_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id,request_id),
  UNIQUE KEY uk_learning_progress_change_revision (user_id,lesson_id,revision),
  KEY idx_learning_progress_change_lesson (lesson_id,recorded_at_utc),
  CONSTRAINT fk_learning_change_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_learning_change_course FOREIGN KEY (course_id) REFERENCES learning_courses(id),
  CONSTRAINT fk_learning_change_lesson FOREIGN KEY (lesson_id) REFERENCES learning_lessons(id),
  CONSTRAINT fk_learning_change_owner FOREIGN KEY (user_id,lesson_id) REFERENCES learning_progress(user_id,lesson_id),
  CONSTRAINT chk_learning_change_revision CHECK (revision>0 AND prior_revision=revision-1),
  CONSTRAINT chk_learning_change_before CHECK (prior_revision>0 OR (prior_completed IS NULL AND prior_updated_at_utc IS NULL)),
  CONSTRAINT chk_learning_change_completed CHECK (completed IN (0,1) AND (prior_completed IS NULL OR prior_completed IN (0,1))),
  CONSTRAINT chk_learning_change_request CHECK (
    REGEXP_LIKE(request_id,'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$','c')
    AND NOT REGEXP_LIKE(request_id,'[^0-9a-f-]','c')),
  CONSTRAINT chk_learning_change_hash CHECK (CHAR_LENGTH(request_sha256)=64 AND NOT REGEXP_LIKE(request_sha256,'[^0-9a-f]','c'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
