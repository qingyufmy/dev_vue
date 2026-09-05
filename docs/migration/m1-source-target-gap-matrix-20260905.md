# M1 源表覆盖与目标结构差异清单

> 2026-09-05；只读现场与旧矩阵的机械交叉核对，不是已批准的字段映射，也不是迁移完成证明。

源：165 表、271,007 行、2,598 列；目标 A：102 表、1,293 列（含两张迁移元数据表）。原始不含数据内容的观测保存在 [清单 JSON](./m1-source-target-inventory-20260905.json)。容量为引擎估值，不是导出文件大小。

## 如何阅读

“候选目标”引用旧矩阵，名称不存在不一定表示功能未实现，也可能已更名或合并。13 张同名表同样必须逐列核对；不能按同名直接 INSERT。所有行均未获回填就绪结论。空表仍需保留功能设计与结构证据；删除候选不等于删除授权。

| 分类 | 源表数量 |
| --- | ---: |
| 同名待逐字段核对 | 13 |
| 候选目标结构缺口 | 110 |
| 候选目标均存在 | 22 |
| 仅删除候选 | 2 |
| 部分候选目标存在 | 16 |
| 归档方案待实现 | 2 |

## 165 张源表逐一覆盖

| 源表 | 当前行数 | 旧矩阵动作 | 已存在的候选目标 | 未匹配的候选目标 | 当前结论 |
| --- | ---: | --- | --- | --- | --- |
| `users` | 25 | 拆分 | `users` | `user_profiles`、`memberships` | 同名待逐字段核对 |
| `verification_codes` | 17 | 重塑 | — | `verification_challenges` | 候选目标结构缺口 |
| `schema_migrations` | 214 | 重塑 | `schema_migrations` | `data_migration_runs`、`data_migration_checkpoints` | 同名待逐字段核对 |
| `credential_migration_runs` | 0 | 合并 | — | `data_migration_runs` | 候选目标结构缺口 |
| `system_config` | 75 | 重塑 | — | `system_settings` | 候选目标结构缺口 |
| `system_prompts` | 1 | 合并 | `strategy_versions` | — | 候选目标均存在 |
| `ai_feature_flags` | 1 | 保留 | — | `ai_feature_flags` | 候选目标结构缺口 |
| `user_notices` | 0 | 候选删除 | — | `notifications` | 仅删除候选 |
| `broadcast_messages` | 0 | 候选删除 | — | `notification_campaigns` | 仅删除候选 |
| `audit_logs` | 1409 | 重塑 | — | `audit_events` | 候选目标结构缺口 |
| `courses` | 12 | 重塑 | — | `courses`、`course_lessons` | 候选目标结构缺口 |
| `course_resources` | 1 | 保留 | — | `course_resources` | 候选目标结构缺口 |
| `quiz_questions` | 0 | 重塑 | — | `quiz_questions`、`quiz_options` | 候选目标结构缺口 |
| `progress` | 5 | 重塑 | — | `course_progress` | 候选目标结构缺口 |
| `video_streams` | 0 | 合并 | — | `course_resources`、`stored_files` | 候选目标结构缺口 |
| `stored_files` | 0 | 保留 | — | `stored_files` | 候选目标结构缺口 |
| `storage_upload_sessions` | 0 | 保留 | — | `storage_upload_sessions` | 候选目标结构缺口 |
| `posts` | 6 | 重塑 | — | `posts`、`post_tag_links`、`post_asset_links` | 候选目标结构缺口 |
| `post_replies` | 2 | 重塑 | — | `post_replies`、`post_asset_links` | 候选目标结构缺口 |
| `post_tags` | 2 | 保留 | — | `post_tags` | 候选目标结构缺口 |
| `post_assets` | 3 | 合并 | — | `stored_files`、`post_asset_links` | 候选目标结构缺口 |
| `post_reports` | 0 | 保留 | — | `post_reports` | 候选目标结构缺口 |
| `comments` | 0 | 重塑 | — | `course_comments` | 候选目标结构缺口 |
| `comment_likes` | 0 | 保留 | — | `course_comment_likes` | 候选目标结构缺口 |
| `feedback` | 0 | 保留 | — | `feedback` | 候选目标结构缺口 |
| `orders` | 12 | 重塑 | — | `payment_orders` | 候选目标结构缺口 |
| `crypto_watch_list` | 8 | 重塑 | — | `payment_matches`、`payment_transactions` | 候选目标结构缺口 |
| `payment_side_effects` | 4 | 重塑 | `outbox_events` | `membership_activations` | 部分候选目标存在 |
| `wallet_keys` | 4 | 重塑 | — | `payment_wallet_addresses` | 候选目标结构缺口 |
| `referral_rules` | 4 | 保留 | — | `referral_rules` | 候选目标结构缺口 |
| `referrals` | 0 | 重塑 | — | `referral_attributions`、`referral_commissions` | 候选目标结构缺口 |
| `membership_expiry_notifications` | 100 | 合并 | — | `notification_deliveries` | 候选目标结构缺口 |
| `notification_campaigns` | 0 | 保留 | — | `notification_campaigns` | 候选目标结构缺口 |
| `notification_deliveries` | 0 | 保留 | — | `notification_deliveries` | 候选目标结构缺口 |
| `notification_idempotency_keys` | 0 | 合并 | — | `idempotency_records` | 候选目标结构缺口 |
| `notifications` | 15 | 重塑 | — | `notifications` | 候选目标结构缺口 |
| `bridge_device_pairings` | 1 | 保留 | — | `bridge_device_pairings` | 候选目标结构缺口 |
| `bridge_refresh_sessions` | 17 | 保留 | `bridge_refresh_sessions` | — | 同名待逐字段核对 |
| `bridge_update_events` | 0 | 保留 | — | `bridge_update_events` | 候选目标结构缺口 |
| `bridge_v3_terminal_sessions` | 7 | 拆分 | `terminal_profiles`、`bridge_connection_sessions` | `terminal_instances`、`terminal_bindings` | 部分候选目标存在 |
| `bridge_v3_account_latest` | 6 | 重塑 | — | `terminal_account_snapshots` | 候选目标结构缺口 |
| `bridge_v3_positions_latest` | 3 | 重塑 | — | `terminal_position_snapshots` | 候选目标结构缺口 |
| `bridge_v3_orders_latest` | 2 | 重塑 | — | `terminal_order_snapshots` | 候选目标结构缺口 |
| `bridge_v3_deals` | 0 | 重塑 | `terminal_history_deals_v4`、`account_trade_records_v4`、`account_trade_record_deals_v4` | — | 候选目标均存在 |
| `bridge_v3_stream_revisions` | 243 | 重塑 | — | `terminal_stream_revisions` | 候选目标结构缺口 |
| `bridge_v3_command_ledger` | 3525 | 重塑 | `bridge_commands_v4`、`bridge_command_payloads_v4`、`bridge_command_results_v4`、`bridge_command_events_v4`、`bridge_trade_state_snapshots_v4` | — | 候选目标均存在 |
| `bridge_v3_command_events` | 10506 | 重塑 | — | `bridge_command_events` | 候选目标结构缺口 |
| `trading_accounts` | 4 | 重塑 | `trading_accounts` | — | 同名待逐字段核对 |
| `mt5_account_bindings` | 3 | 合并 | `trading_account_ownerships` | `terminal_bindings` | 部分候选目标存在 |
| `mt5_account_ownership_history` | 274 | 重塑 | `trading_account_ownerships` | — | 候选目标均存在 |
| `mt5_account_performance_daily` | 21 | 重塑 | — | `trading_account_performance_daily` | 候选目标结构缺口 |
| `mt5_account_performance_totals` | 3 | 重塑 | — | `trading_account_performance_totals` | 候选目标结构缺口 |
| `mt5_account_performance_sync_state` | 3 | 重塑 | — | `trading_account_sync_states` | 候选目标结构缺口 |
| `user_bridge_settings` | 4 | 拆分 | `strategy_subscriptions` | `bridge_user_controls` | 部分候选目标存在 |
| `ai_observer_channels` | 2 | 保留 | `observer_channels` | — | 候选目标均存在 |
| `ai_observer_sources` | 2 | 重塑 | — | `observer_sources` | 候选目标结构缺口 |
| `ai_observer_channel_assignments` | 0 | 保留 | — | `observer_channel_assignments` | 候选目标结构缺口 |
| `auto_prompt_types` | 3 | 拆分 | `strategies`、`strategy_versions` | — | 候选目标均存在 |
| `strategy_subscriptions` | 5 | 重塑 | `strategy_subscriptions`、`subscription_schedules` | — | 同名待逐字段核对 |
| `auto_scheduler` | 18 | 合并 | `strategy_subscriptions` | `subscription_runtime_states` | 部分候选目标存在 |
| `global_auto_config` | 1 | 合并 | `strategies`、`strategy_versions` | `system_settings` | 部分候选目标存在 |
| `ai_inference_preferences` | 2 | 合并 | `strategy_subscriptions`、`user_model_defaults` | — | 候选目标均存在 |
| `ai_configs` | 3 | 合并 | `ai_model_profiles`、`user_model_defaults`、`strategy_subscriptions` | — | 候选目标均存在 |
| `close_config` | 4 | 合并 | `user_model_defaults` | `user_position_management_settings` | 部分候选目标存在 |
| `history_range_preferences` | 0 | 保留 | — | `account_history_preferences` | 候选目标结构缺口 |
| `market_data_sources` | 3 | 重塑 | — | `market_data_sources` | 候选目标结构缺口 |
| `market_candles` | 35725 | 保留 | `market_candles` | — | 同名待逐字段核对 |
| `market_clock_samples` | 6183 | 重塑 | — | `terminal_clock_calibrations` | 候选目标结构缺口 |
| `chan_structure_anchors` | 6 | 保留 | — | `chan_structure_anchors` | 候选目标结构缺口 |
| `ai_model_profiles` | 6 | 保留 | `ai_model_profiles` | — | 同名待逐字段核对 |
| `ai_model_provider_capabilities` | 5 | 保留 | `ai_model_provider_capabilities` | — | 同名待逐字段核对 |
| `ai_model_provider_incidents` | 3 | 保留 | — | `ai_model_provider_incidents` | 候选目标结构缺口 |
| `ai_model_purpose_defaults` | 0 | 合并 | `user_model_defaults` | — | 候选目标均存在 |
| `user_model_defaults` | 2 | 重塑 | `user_model_defaults` | — | 同名待逐字段核对 |
| `platform_model_usage_policy` | 1 | 保留 | `platform_model_usage_policy` | — | 同名待逐字段核对 |
| `ai_model_tasks` | 9317 | 保留 | `ai_model_tasks` | — | 同名待逐字段核对 |
| `ai_model_task_attempts` | 9179 | 保留 | — | `ai_model_task_attempts` | 候选目标结构缺口 |
| `ai_model_task_events` | 121821 | 保留 | — | `ai_model_task_events` | 候选目标结构缺口 |
| `ai_model_usage_logs` | 12139 | 保留 | `ai_model_usage_logs` | — | 同名待逐字段核对 |
| `ai_model_capacity_policies` | 1 | 保留 | — | `ai_model_capacity_policies` | 候选目标结构缺口 |
| `ai_model_capacity_waiters` | 9165 | 归档 | — | — | 归档方案待实现 |
| `ai_model_capacity_leases` | 9165 | 归档 | — | — | 归档方案待实现 |
| `ai_model_compare_jobs` | 0 | 保留 | — | `ai_model_compare_jobs` | 候选目标结构缺口 |
| `ai_model_compare_checkpoints` | 0 | 保留 | — | `ai_model_compare_checkpoints` | 候选目标结构缺口 |
| `ai_manual_analysis_jobs` | 0 | 保留 | — | `ai_manual_analysis_jobs` | 候选目标结构缺口 |
| `ai_market_benchmark_sets` | 0 | 保留 | — | `ai_market_benchmark_sets` | 候选目标结构缺口 |
| `ai_market_benchmark_cases` | 0 | 保留 | — | `ai_market_benchmark_cases` | 候选目标结构缺口 |
| `ai_signals` | 1764 | 拆分 | — | `ai_signals`、`ai_signal_payloads` | 候选目标结构缺口 |
| `inference_snapshots` | 789 | 拆分 | `inference_snapshots`、`inference_snapshot_payloads` | — | 同名待逐字段核对 |
| `ai_trade_theses` | 444 | 保留 | — | `ai_trade_theses` | 候选目标结构缺口 |
| `auto_signal_deliveries` | 1442 | 重塑 | — | `signal_deliveries` | 候选目标结构缺口 |
| `order_intents` | 412 | 重塑 | `operations`、`execution_intents`、`execution_intent_payloads` | — | 候选目标均存在 |
| `risk_reservations` | 362 | 重塑 | `risk_reservations_v4`、`risk_reservation_events_v4` | — | 候选目标均存在 |
| `admin_strategy_trade_dispatches` | 7 | 重塑 | `operations`、`execution_distributions` | — | 候选目标均存在 |
| `admin_strategy_trade_targets` | 22 | 重塑 | `execution_distribution_targets`、`execution_intents` | — | 候选目标均存在 |
| `admin_strategy_pending_cancel_jobs` | 3 | 合并 | `operations` | `execution_batches` | 部分候选目标存在 |
| `admin_strategy_pending_cancel_targets` | 9 | 合并 | `execution_intents` | `operation_targets` | 部分候选目标存在 |
| `admin_position_close_jobs` | 2 | 合并 | `operations` | `execution_batches` | 部分候选目标存在 |
| `admin_position_close_targets` | 4 | 合并 | `execution_intents` | `operation_targets` | 部分候选目标存在 |
| `admin_position_protection_jobs` | 2 | 合并 | `operations` | `execution_batches` | 部分候选目标存在 |
| `admin_position_protection_targets` | 3 | 合并 | `execution_intents` | `operation_targets` | 部分候选目标存在 |
| `pending_orders` | 0 | 合并 | — | `terminal_order_snapshots`、`trade_outcomes` | 候选目标结构缺口 |
| `close_signal_tickets` | 30 | 合并 | `execution_intents` | `trade_outcomes` | 部分候选目标存在 |
| `signal_outcomes` | 334 | 重塑 | `account_trade_attributions_v4` | `trade_outcomes`、`trade_outcome_payloads` | 部分候选目标存在 |
| `signal_outcome_deals` | 427 | 重塑 | `terminal_history_deals_v4`、`account_trade_record_deals_v4` | — | 候选目标均存在 |
| `trade_audit_logs` | 9660 | 重塑 | — | `trade_audit_events` | 候选目标结构缺口 |
| `risk_policy_sets` | 3 | 保留 | — | `risk_policy_sets` | 候选目标结构缺口 |
| `risk_policy_versions` | 10 | 保留 | — | `risk_policy_versions` | 候选目标结构缺口 |
| `risk_policy_change_items` | 60 | 保留 | — | `risk_policy_change_items` | 候选目标结构缺口 |
| `risk_profiles` | 0 | 合并 | — | `risk_policy_sets`、`risk_policy_versions` | 候选目标结构缺口 |
| `risk_account_state` | 4 | 重塑 | `account_risk_states`、`risk_state_events` | — | 候选目标均存在 |
| `risk_decisions` | 395 | 保留 | — | `risk_decisions` | 候选目标结构缺口 |
| `risk_rule_rollouts` | 19 | 保留 | — | `risk_rule_rollouts` | 候选目标结构缺口 |
| `global_risk_control` | 1 | 重塑 | `global_risk_controls`、`risk_state_events` | — | 候选目标均存在 |
| `ai_position_management_tasks` | 419 | 保留 | — | `position_management_tasks` | 候选目标结构缺口 |
| `ai_position_management_events` | 1235 | 保留 | — | `position_management_events` | 候选目标结构缺口 |
| `ai_position_management_evaluations` | 4415 | 保留 | — | `position_management_evaluations` | 候选目标结构缺口 |
| `ai_position_management_commands` | 85 | 合并 | `execution_intents` | `bridge_commands` | 部分候选目标存在 |
| `position_guard_profiles` | 1 | 保留 | — | `position_guard_profiles` | 候选目标结构缺口 |
| `position_guard_profile_versions` | 1 | 保留 | — | `position_guard_profile_versions` | 候选目标结构缺口 |
| `position_guard_position_states` | 6 | 重塑 | — | `position_guard_position_states`、`position_guard_events` | 候选目标结构缺口 |
| `user_position_guard_settings` | 1 | 重塑 | — | `account_position_guard_settings` | 候选目标结构缺口 |
| `user_position_management_settings` | 0 | 重塑 | — | `account_position_management_settings` | 候选目标结构缺口 |
| `position_management_account_rollouts` | 0 | 保留 | — | `position_management_account_rollouts` | 候选目标结构缺口 |
| `global_position_guard_control` | 1 | 重塑 | — | `global_runtime_controls` | 候选目标结构缺口 |
| `global_position_management_control` | 1 | 重塑 | — | `global_runtime_controls` | 候选目标结构缺口 |
| `trades` | 2 | 重塑 | — | `manual_trade_records` | 候选目标结构缺口 |
| `trade_review_cases` | 155 | 合并 | `review_cases_v4`、`review_case_sources_v4`、`review_evidence_payloads_v4` | — | 候选目标均存在 |
| `trade_review_jobs` | 0 | 保留 | — | `trade_review_jobs` | 候选目标结构缺口 |
| `trade_review_versions` | 0 | 保留 | — | `trade_review_versions` | 候选目标结构缺口 |
| `manual_trade_review_cases` | 3 | 合并 | `review_cases_v4`、`review_case_sources_v4`、`review_evidence_payloads_v4` | — | 候选目标均存在 |
| `manual_trade_review_sources` | 3 | 保留 | — | `manual_trade_review_sources` | 候选目标结构缺口 |
| `manual_trade_review_jobs` | 3 | 保留 | — | `manual_trade_review_jobs` | 候选目标结构缺口 |
| `manual_trade_review_stage_runs` | 18 | 保留 | — | `manual_trade_review_stage_runs` | 候选目标结构缺口 |
| `manual_trade_review_versions` | 1 | 保留 | — | `manual_trade_review_versions` | 候选目标结构缺口 |
| `manual_trade_review_counterfactual_points` | 27 | 保留 | — | `manual_trade_review_counterfactual_points` | 候选目标结构缺口 |
| `manual_trade_review_aggregate_cases` | 0 | 保留 | — | `manual_trade_review_aggregate_cases` | 候选目标结构缺口 |
| `manual_trade_review_aggregate_sources` | 0 | 保留 | — | `manual_trade_review_aggregate_sources` | 候选目标结构缺口 |
| `manual_trade_review_aggregate_versions` | 0 | 保留 | — | `manual_trade_review_aggregate_versions` | 候选目标结构缺口 |
| `period_review_cases` | 25 | 合并 | `review_cases_v4`、`review_case_sources_v4`、`review_evidence_payloads_v4` | — | 候选目标均存在 |
| `period_review_sources` | 176 | 保留 | — | `period_review_sources` | 候选目标结构缺口 |
| `period_review_versions` | 33 | 保留 | — | `period_review_versions` | 候选目标结构缺口 |
| `period_review_jobs` | 25 | 拆分 | — | `period_review_jobs`、`review_job_payloads` | 候选目标结构缺口 |
| `period_review_job_events` | 7208 | 保留 | — | `period_review_job_events` | 候选目标结构缺口 |
| `period_review_derivation_jobs` | 12 | 保留 | — | `period_review_derivation_jobs` | 候选目标结构缺口 |
| `period_review_monthly_checkpoints` | 8 | 拆分 | — | `period_review_monthly_checkpoints`、`review_checkpoint_payloads` | 候选目标结构缺口 |
| `period_review_user_states` | 33 | 保留 | — | `period_review_user_states` | 候选目标结构缺口 |
| `strategy_memory_libraries` | 2 | 拆分 | `strategy_memory_libraries_v4`、`strategy_memory_library_revisions_v4` | — | 候选目标均存在 |
| `strategy_memory_library_revisions` | 20 | 重塑 | `strategy_memory_library_revisions_v4` | — | 候选目标均存在 |
| `strategy_memory_pending_updates` | 10 | 重塑 | `strategy_memory_pending_updates_v4` | — | 候选目标均存在 |
| `strategy_memory_compression_jobs` | 0 | 保留 | — | `strategy_memory_compression_jobs` | 候选目标结构缺口 |
| `strategy_memory_injection_logs` | 5417 | 保留 | — | `strategy_memory_injection_logs` | 候选目标结构缺口 |
| `strategy_memory_consistency_jobs` | 48 | 拆分 | — | `strategy_memory_consistency_jobs`、`memory_job_payloads` | 候选目标结构缺口 |
| `strategy_memory_conflicts` | 2 | 保留 | — | `strategy_memory_conflicts` | 候选目标结构缺口 |
| `strategy_memory_conflict_bindings` | 1 | 保留 | — | `strategy_memory_conflict_bindings` | 候选目标结构缺口 |
| `strategy_memory_conflict_occurrences` | 2 | 保留 | — | `strategy_memory_conflict_occurrences` | 候选目标结构缺口 |
| `platform_strategy_experience_items` | 2 | 合并 | — | `strategy_memory_pending_updates`、`strategy_memory_library_revisions` | 候选目标结构缺口 |
| `platform_strategy_experience_logs` | 6093 | 合并 | — | `strategy_memory_injection_logs` | 候选目标结构缺口 |
| `platform_strategy_experience_policies` | 2 | 合并 | — | `strategy_memory_libraries` | 候选目标结构缺口 |
| `experience_long_term_memories` | 0 | 合并 | — | `strategy_memory_library_revisions` | 候选目标结构缺口 |
| `experience_memory_items` | 0 | 合并 | — | `strategy_memory_pending_updates` | 候选目标结构缺口 |
| `experience_memory_summaries` | 0 | 合并 | — | `strategy_memory_library_revisions` | 候选目标结构缺口 |
| `memory_compression_jobs` | 0 | 合并 | — | `strategy_memory_compression_jobs` | 候选目标结构缺口 |
| `memory_injection_logs` | 0 | 合并 | — | `strategy_memory_injection_logs` | 候选目标结构缺口 |
| `user_memory_settings` | 0 | 合并 | — | `strategy_memory_libraries`、`user_preferences` | 候选目标结构缺口 |

## 13 张同名表的字段名/主键差异

这里只比较名称和主键类型，未比较每个同名字段的类型、默认值、排序规则和约束；“没有名称差异”也不能推导为可直接迁移。

### ai_model_profiles

- 源主键：`id int`；目标主键：`id int`。
- 仅源字段：`is_default`、`active_default_owner_key`。
- 仅目标字段：无。

### ai_model_provider_capabilities

- 源主键：`model_profile_id int`；目标主键：`model_profile_id int`。
- 仅源字段：`supports_stream`、`supports_request_id`、`supports_poll`、`supports_cancel`、`supports_idempotency`、`supports_usage_split`、`context_window_tokens`、`max_input_tokens`、`max_output_tokens`、`context_limit_semantics`、`token_limits_source`、`token_limits_status`、`token_limits_note`、`token_limits_updated_by`、`token_limits_updated_at_utc_msc`、`verified_at_utc_msc`、`updated_at_utc_msc`。
- 仅目标字段：`verified_at_utc`、`updated_at_utc`。

### ai_model_tasks

- 源主键：`task_id char(36)`；目标主键：`id char(36)`。
- 仅源字段：`task_id`、`task_kind`、`queue_class`、`owner_user_id`、`strategy_id`、`domain_type`、`domain_id`、`idempotency_key`、`snapshot_hash`、`input_hash`、`prompt_hash`、`output_contract_hash`、`frozen_provider`、`frozen_model`、`frozen_model_profile_id`、`frozen_protocol`、`frozen_credential_source`、`frozen_context_json`、`priority`、`attempt_count`、`max_attempts`、`scheduled_at_utc_msc`、`task_deadline_at_utc_msc`、`result_valid_until_utc_msc`、`lease_token`、`lease_expires_at_utc_msc`、`last_activity_at_utc_msc`、`estimated_input_tokens`、`selected_output_budget`、`schema_need_tokens`、`context_window_tokens`、`provider_max_input_tokens`、`context_limit_semantics`、`token_limits_source`、`token_limits_status`、`token_limits_updated_at_utc_msc`、`provider_output_cap`、`result_ref`、`result_hash`、`finish_reason`、`incomplete_details_json`、`error_code`、`error_message`、`completed_at_utc_msc`、`created_at_utc_msc`、`updated_at_utc_msc`。
- 仅目标字段：`id`、`purpose`、`user_id`、`trading_account_id`、`input_snapshot_id`、`model_profile_id`、`deadline_at_utc`、`lease_expires_at_utc`、`created_at_utc`、`updated_at_utc`、`completed_at_utc`。

### ai_model_usage_logs

- 源主键：`id bigint`；目标主键：`id bigint unsigned`。
- 仅源字段：`finish_reason`、`incomplete_details_json`。
- 仅目标字段：无。

### bridge_refresh_sessions

- 源主键：`id bigint`；目标主键：`id bigint`。
- 仅源字段：无。
- 仅目标字段：`credential_version`、`installation_id`、`profile_id`、`generation`、`migration_key`、`source_fingerprint`、`source_refresh_session_id`。

### inference_snapshots

- 源主键：`id bigint`；目标主键：`id char(36)`。
- 仅源字段：`signal_id`、`strategy_version`、`strategy_scope`、`owner_user_id`、`market_source`、`system_prompt`、`user_prompt`、`prompt_hash`、`model_profile_id`、`provider`、`model_name`、`credential_source`、`output_schema_version`、`klines_json`、`market_snapshot_json`、`strategy_runtime_json`、`memory_mode`、`evidence_status`、`omitted_fields_json`、`content_hash`、`byte_size`、`created_at`。
- 仅目标字段：`purpose`、`user_id`、`trading_account_id`、`strategy_version_id`、`payload_sha256`、`payload_bytes`、`captured_at_utc`、`created_at_utc`。

### market_candles

- 源主键：`id bigint unsigned`；目标主键：`trading_account_id bigint unsigned`、`symbol varchar(64)`、`timeframe enum('M1','M5','M15','M30','H1','H4','D1')`、`open_time_utc datetime(3)`。
- 仅源字段：`id`、`source_id`、`broker_symbol`、`standard_symbol`、`open_time_utc_msc`、`broker_time`、`spread`、`updated_at`。
- 仅目标字段：`trading_account_id`、`symbol`、`open_time_utc`、`closed`、`revision`。

### platform_model_usage_policy

- 源主键：`id int`；目标主键：`id int`。
- 仅源字段：无。
- 仅目标字段：无。

### schema_migrations

- 源主键：`id varchar(255)`；目标主键：`id varchar(191)`。
- 仅源字段：`applied_at`。
- 仅目标字段：`checksum_sha256`、`execution_id`、`status`、`statement_count`、`completed_statements`、`started_at_utc`、`completed_at_utc`、`error_code`。

### strategy_subscriptions

- 源主键：`id int`；目标主键：`id bigint unsigned`。
- 仅源字段：`strategy_id`、`risk_profile_id`、`symbols_json`、`execution_enabled`、`memory_mode`、`conflicting_strategy_id`、`is_deleted`、`created_at`、`updated_at`、`schedule_enabled`、`schedule_timezone`、`schedule_weekdays_json`、`schedule_windows_json`、`outside_window_behavior`、`take_profit_mode`、`active_execution_user_key`。
- 仅目标字段：`standard_symbol`、`analysis_strategy_id`、`analysis_strategy_version_id`、`trader_strategy_id`、`trader_strategy_version_id`、`analysis_enabled`、`trader_enabled`、`trade_send_enabled`、`status`、`revision`、`active_execution_key`、`legacy_source_table`、`legacy_id`、`created_at_utc`、`updated_at_utc`。

### trading_accounts

- 源主键：`id int`；目标主键：`id bigint unsigned`。
- 仅源字段：`user_id`、`login_account`、`nickname`、`margin_mode`、`review_status`、`observe_status`、`is_deleted`、`created_at`、`updated_at`、`observed_until`、`identity_verified_at`、`first_verified_at`、`anomaly_code`。
- 仅目标字段：`platform`、`account_login`、`currency`、`created_at_utc`、`updated_at_utc`、`deleted_at_utc`。

### user_model_defaults

- 源主键：`user_id int`；目标主键：`user_id int`。
- 仅源字段：无。
- 仅目标字段：无。

### users

- 源主键：`id int`；目标主键：`id int`。
- 仅源字段：`email_verified`、`auth_method`、`plan_period`、`telegram_id`、`telegram_username`、`telegram_name`、`telegram_chat_id`、`telegram_group_status`、`telegram_bot_started_at`、`telegram_joined_at`、`telegram_last_invite_sent_at`、`referral_code`、`referral_credit`、`referred_by`、`last_seen_at`、`bridge_heartbeat`、`phone_verified`、`changelog_seen_version`、`plan_source`。
- 仅目标字段：无。

## 名称漂移与真正缺口必须分开

- `ai_model_task_attempts` 的当前运行表为 `ai_model_attempts`，但任务目的、前置快照和状态合同不同，不能仅改表名复制。
- `bridge_v3_command_events` 对应候选 `bridge_command_events_v4`；仍需精确命令映射和禁止重放标记。
- 分析、复盘和记忆已有新的统一权威模型，但旧平台分析、手动多阶段复盘、经验/冲突/压缩历史是否能无损表达仍待字段级决策。
- 课程、商业、通知与部分用户配置尚缺目标持久化承接；不能用数据归档代替仍需提供的用户功能。
- 旧矩阵的 `risk_reservations` 曾在执行和风控域各列一次；本清单只计一次，完整覆盖 165 个不同源表。
