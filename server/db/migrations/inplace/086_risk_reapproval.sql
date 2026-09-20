-- Preserve every approval; trade_decisions.risk_decision_id selects the current one.
ALTER TABLE risk_decisions_v4
  DROP INDEX uk_risk_decision_trade_decision,
  ADD INDEX idx_risk_decision_trade_decision (trade_decision_id);
