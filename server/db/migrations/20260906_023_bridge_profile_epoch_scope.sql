-- P5A: a connection epoch is persisted by one Bridge profile, not by a terminal.
-- Keep all historical session evidence, including pre-existing equal profile
-- epochs on different terminals. New registrations serialize on the profile
-- row and require a strictly increasing numeric epoch.
-- The opaque connection identity and its unique index remain unchanged.
-- Write-only migration artifact; never execute from application startup.
ALTER TABLE bridge_connection_sessions
  DROP INDEX uk_bridge_connection_route_epoch_v4,
  ADD KEY idx_bridge_connection_profile_epoch_v4
    (user_id, terminal_profile_id, connection_epoch_v4);
