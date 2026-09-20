-- Append-only history admission. Apply only through the reviewed upgrade coordinator.
-- Existing enum ordinals and case rows remain unchanged.
ALTER TABLE review_cases_v4
  MODIFY COLUMN kind ENUM('daily','monthly','manual','trade') NOT NULL;
