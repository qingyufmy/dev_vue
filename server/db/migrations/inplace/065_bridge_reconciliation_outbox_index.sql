ALTER TABLE outbox_events
  ADD INDEX idx_outbox_aggregate_event (aggregate_type, aggregate_id, event_type, id);
