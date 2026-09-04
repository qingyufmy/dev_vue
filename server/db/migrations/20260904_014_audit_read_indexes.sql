-- Stage 12U: covering indexes for the read-only user audit feed.
-- The audit module reads authoritative append-only/domain records directly; it does not create a duplicate
-- universal log table, rewrite legacy evidence or copy raw JSON payloads. Application startup never runs DDL.

ALTER TABLE ai_trader_runs
  ADD KEY idx_ai_trader_user_audit (user_id, updated_at_utc DESC, id);

ALTER TABLE ai_analysis_runs
  ADD KEY idx_ai_analysis_user_audit (user_id, updated_at_utc DESC, id);

ALTER TABLE risk_decisions_v4
  ADD KEY idx_risk_decision_user_audit (user_id, created_at_utc DESC, id);

ALTER TABLE operations
  ADD KEY idx_operation_user_audit (user_id, updated_at_utc DESC, id);

ALTER TABLE bridge_commands_v4
  ADD KEY idx_bridge_command_user_audit (user_id, updated_at_utc DESC, id);

ALTER TABLE risk_policy_change_items_v4
  ADD KEY idx_risk_policy_change_actor_audit (requested_by_user_id, changed_at_utc DESC, id);

ALTER TABLE risk_manual_releases
  ADD KEY idx_risk_manual_release_user_audit (user_id, created_at_utc DESC, id);

ALTER TABLE account_trade_records_v4
  ADD KEY idx_account_trade_user_audit (user_id, closed_at_utc DESC, id);

-- Existing indexes already cover the remaining audit branches:
-- Account-scoped browsing can also use the existing account indexes; these additional indexes keep the
-- default all-account audit view from depending on a non-filtered account/status column in the key prefix.
-- Production migration must still use the release runner's checksum, checkpoint and online-DDL review;
-- this file is not executed during Stage 12U offline implementation.
