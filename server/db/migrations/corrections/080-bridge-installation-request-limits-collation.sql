-- Preserve 080 and its journal checksum. Normalize only the new empty table's default.
ALTER TABLE bridge_installation_request_limits DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
