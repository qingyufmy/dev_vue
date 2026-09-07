CREATE TABLE learning_courses (
  id INT NOT NULL AUTO_INCREMENT,
  title VARCHAR(500) NOT NULL,
  description TEXT NULL,
  category_key VARCHAR(50) NULL,
  cover_locator VARCHAR(500) NULL,
  gradient_token VARCHAR(500) NULL,
  access_level VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  sort_order INT NULL,
  created_at_utc DATETIME(3) NULL,
  updated_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  origin VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  migration_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  imported_at_utc DATETIME(3) NULL,
  CONSTRAINT fk_learning_course_run FOREIGN KEY (migration_run_id) REFERENCES data_migration_runs(id),
  CONSTRAINT chk_learning_course_revision CHECK (revision > 0),
  CONSTRAINT chk_learning_course_hash CHECK (source_sha256 IS NULL OR
    (CHAR_LENGTH(source_sha256)=64 AND NOT REGEXP_LIKE(source_sha256,'[^0-9a-f]','c'))),
  CONSTRAINT chk_learning_course_origin CHECK (
    (BINARY origin=BINARY 'native' AND updated_at_utc IS NOT NULL
      AND migration_run_id IS NULL AND source_sha256 IS NULL AND imported_at_utc IS NULL)
    OR (BINARY origin=BINARY 'legacy_import' AND migration_run_id IS NOT NULL
      AND source_sha256 IS NOT NULL AND imported_at_utc IS NOT NULL)
  ),
  PRIMARY KEY (id),
  KEY idx_learning_course_list (status,sort_order,id),
  CONSTRAINT chk_learning_course_access CHECK (access_level IS NULL OR BINARY access_level IN (BINARY 'free',BINARY 'logged_in',BINARY 'plus_pro',BINARY 'pro_only')),
  CONSTRAINT chk_learning_course_status CHECK (status IS NULL OR BINARY status IN (BINARY 'draft',BINARY 'published',BINARY 'archived')),
  CONSTRAINT chk_learning_course_native CHECK (BINARY origin<>BINARY 'native' OR (created_at_utc IS NOT NULL AND access_level IS NOT NULL AND status IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_lessons (
  id INT NOT NULL AUTO_INCREMENT,
  course_id INT NOT NULL,
  public_episode_id INT NULL,
  display_number INT NULL,
  title VARCHAR(500) NOT NULL,
  content_type VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NULL,
  duration_ms BIGINT NULL,
  sort_order INT NOT NULL,
  created_at_utc DATETIME(3) NULL,
  updated_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  origin VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  migration_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  imported_at_utc DATETIME(3) NULL,
  CONSTRAINT fk_learning_lesson_run FOREIGN KEY (migration_run_id) REFERENCES data_migration_runs(id),
  CONSTRAINT chk_learning_lesson_revision CHECK (revision > 0),
  CONSTRAINT chk_learning_lesson_hash CHECK (source_sha256 IS NULL OR
    (CHAR_LENGTH(source_sha256)=64 AND NOT REGEXP_LIKE(source_sha256,'[^0-9a-f]','c'))),
  CONSTRAINT chk_learning_lesson_origin CHECK (
    (BINARY origin=BINARY 'native' AND updated_at_utc IS NOT NULL
      AND migration_run_id IS NULL AND source_sha256 IS NULL AND imported_at_utc IS NULL)
    OR (BINARY origin=BINARY 'legacy_import' AND migration_run_id IS NOT NULL
      AND source_sha256 IS NOT NULL AND imported_at_utc IS NOT NULL)
  ),
  PRIMARY KEY (id),
  UNIQUE KEY uk_learning_episode (public_episode_id),
  KEY idx_learning_lesson_course (course_id,sort_order,id),
  CONSTRAINT fk_learning_lesson_course FOREIGN KEY (course_id) REFERENCES learning_courses(id),
  CONSTRAINT chk_learning_lesson_id CHECK (public_episode_id IS NULL OR public_episode_id>0),
  CONSTRAINT chk_learning_lesson_duration CHECK (duration_ms IS NULL OR duration_ms>=0),
  CONSTRAINT chk_learning_lesson_type CHECK (content_type IS NULL OR BINARY content_type IN (BINARY 'video',BINARY 'article')),
  CONSTRAINT chk_learning_lesson_native CHECK (BINARY origin<>BINARY 'native' OR (created_at_utc IS NOT NULL AND content_type IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_media_references (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  lesson_id INT NOT NULL,
  source_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  locator VARCHAR(500) NOT NULL,
  created_at_utc DATETIME(3) NULL,
  updated_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  origin VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  migration_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  imported_at_utc DATETIME(3) NULL,
  CONSTRAINT fk_learning_media_run FOREIGN KEY (migration_run_id) REFERENCES data_migration_runs(id),
  CONSTRAINT chk_learning_media_revision CHECK (revision > 0),
  CONSTRAINT chk_learning_media_hash CHECK (source_sha256 IS NULL OR
    (CHAR_LENGTH(source_sha256)=64 AND NOT REGEXP_LIKE(source_sha256,'[^0-9a-f]','c'))),
  CONSTRAINT chk_learning_media_origin CHECK (
    (BINARY origin=BINARY 'native' AND updated_at_utc IS NOT NULL
      AND migration_run_id IS NULL AND source_sha256 IS NULL AND imported_at_utc IS NULL)
    OR (BINARY origin=BINARY 'legacy_import' AND migration_run_id IS NOT NULL
      AND source_sha256 IS NOT NULL AND imported_at_utc IS NOT NULL)
  ),
  PRIMARY KEY (id),
  UNIQUE KEY uk_learning_media_kind (lesson_id,source_kind),
  CONSTRAINT fk_learning_media_lesson FOREIGN KEY (lesson_id) REFERENCES learning_lessons(id),
  CONSTRAINT chk_learning_media_locator CHECK (OCTET_LENGTH(locator)>0),
  CONSTRAINT chk_learning_media_kind CHECK (BINARY source_kind IN (BINARY 'youtube_id',BINARY 'bilibili_id',BINARY 'cf_stream_id',BINARY 'local_video_path',BINARY 'article_url',BINARY 'article_object_key')),
  CONSTRAINT chk_learning_media_native CHECK (BINARY origin<>BINARY 'native' OR created_at_utc IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE learning_progress (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  lesson_id INT NOT NULL,
  watched_ms BIGINT NULL,
  reported_duration_ms BIGINT NULL,
  completed TINYINT NULL,
  quiz_passed TINYINT NULL,
  updated_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  origin VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  migration_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  imported_at_utc DATETIME(3) NULL,
  CONSTRAINT fk_learning_progress_run FOREIGN KEY (migration_run_id) REFERENCES data_migration_runs(id),
  CONSTRAINT chk_learning_progress_revision CHECK (revision > 0),
  CONSTRAINT chk_learning_progress_hash CHECK (source_sha256 IS NULL OR
    (CHAR_LENGTH(source_sha256)=64 AND NOT REGEXP_LIKE(source_sha256,'[^0-9a-f]','c'))),
  CONSTRAINT chk_learning_progress_origin CHECK (
    (BINARY origin=BINARY 'native' AND updated_at_utc IS NOT NULL
      AND migration_run_id IS NULL AND source_sha256 IS NULL AND imported_at_utc IS NULL)
    OR (BINARY origin=BINARY 'legacy_import' AND migration_run_id IS NOT NULL
      AND source_sha256 IS NOT NULL AND imported_at_utc IS NOT NULL)
  ),
  PRIMARY KEY (id),
  UNIQUE KEY uk_learning_progress_user_lesson (user_id,lesson_id),
  KEY idx_learning_progress_lesson (lesson_id,id),
  CONSTRAINT fk_learning_progress_user FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT fk_learning_progress_lesson FOREIGN KEY (lesson_id) REFERENCES learning_lessons(id),
  CONSTRAINT chk_learning_progress_watched CHECK (watched_ms IS NULL OR watched_ms>=0),
  CONSTRAINT chk_learning_progress_duration CHECK (reported_duration_ms IS NULL OR reported_duration_ms>=0),
  CONSTRAINT chk_learning_progress_completed CHECK (completed IS NULL OR completed IN (0,1)),
  CONSTRAINT chk_learning_progress_quiz CHECK (quiz_passed IS NULL OR quiz_passed IN (0,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
