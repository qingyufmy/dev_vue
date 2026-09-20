-- Legacy raw versions carry no inferred V4 conclusion.
ALTER TABLE review_versions_v4
  MODIFY COLUMN conclusion_code ENUM('effective','mixed','ineffective','insufficient_evidence','manual_trade_reviewed') NULL;
