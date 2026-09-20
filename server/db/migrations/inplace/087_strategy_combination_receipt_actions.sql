-- Preserve all existing receipt actions and permit atomic strategy-combination writes.
ALTER TABLE strategy_write_receipts_v4
  DROP CHECK chk_strategy_receipt_action,
  ADD CONSTRAINT chk_strategy_receipt_action CHECK (action IN (
    'create_strategy','update_metadata','create_version','publish_version','retire_strategy',
    'create_subscription','update_subscription','set_account_trader',
    'create_strategy_combination','create_strategy_combination_version'));
