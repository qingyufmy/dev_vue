-- Additive source proof only. Existing account/position/pending rows are preserved.
-- No historical quote provenance is inferred or backfilled.
ALTER TABLE trading_projection_provenance_v4
  DROP CHECK chk_projection_provenance_kind,
  ADD CONSTRAINT chk_projection_provenance_kind
    CHECK (resource_kind IN ('account.metrics','positions','pending_orders','market.quote'));
