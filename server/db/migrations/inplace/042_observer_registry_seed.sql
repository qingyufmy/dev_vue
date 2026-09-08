-- Run only through the reviewed observer-registry-seed coordinator.
-- An existing row must retain its revision. A missing row may be initialized
-- only when sources, channels, grants, management receipts and related outbox are empty.
INSERT INTO observer_management_registry (id,revision) VALUES (1,0);
