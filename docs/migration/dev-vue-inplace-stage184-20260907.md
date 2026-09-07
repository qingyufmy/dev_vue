# 阶段 184：旧时间写入证据与学习域转换候选

## 结论

旧库混用北京时间 DATETIME 与 UTC 时间戳/日期字符串。不能将旧表全部按 UTC 原值搬运，也不能将全部字段统一减 8 小时。本次只有只读 SQL 和本地证据输出，没有业务回填。

## 代码与 Git 证据

只读参考仓库 wall-street-skill-local，HEAD `61610c3c`。私有证据绑定 db.js、admin/content-system.js、routes/user.js、services/admin-strategy-trades.js、routes/ai/config.js、migrations.js 的 SHA-256，未修改参考仓库已有改动。

- `645f4f7e`（2026-06-10）：加入 beijingNow，JS 当前时间加 8 小时后去除时区标识；多处 UTC_TIMESTAMP/DATE_ADD 改为 NOW。
- `29599418`（2026-07-08）：驱动 timezone 和 MySQL session time_zone 显式固定 +08:00。提交日期不能直接当作部署日期。
- 当前课程和进度：DATETIME 默认 NOW，更新同样用 NOW。按照当前代码约定为北京时间；6 月阶段的 SQL 会话仍取决于当时数据库设置。
- 当前 ai_signals 写入：created_at 使用 beijingNow，created_at_utc_msc 使用 Date.now，pending_valid_until 使用 UTC ISO 去除时区标识。同表已有不同语义。
- `e66dbcf0`（2026-08-03）的 `159_terminal_event_clock_evidence`：将部分旧 created_at 按 `TIMESTAMPDIFF(MICROSECOND, '1970-01-01 08:00:00', created_at) DIV 1000` 回填 UTC 毫秒。因此双字段一致可能源于回填，不能当作两份独立证据。

## 当前 dev_vue 实际只读结果

本地运行 `audit-legacy-time-local.mjs`，读取现有 env，固定 dev_vue 与备份 server UUID，设置 UTC / REPEATABLE READ / READ ONLY。SQL 按月统计，不输出用户、账户或交易明细。

| 来源 | 总行数 | 双时间有效行数 | DATE 与 UTC 毫秒差 |
| --- | ---: | ---: | --- |
| ai_signals | 1764 | 1764 | 全部约 +480 分钟，残差最多 1 秒 |
| trade_audit_logs | 9660 | 9395 | 全部约 +480 分钟，残差小于 1 秒 |

审计另外 265 行没有有效双时间，不能从配对统计得出结论。以上结果跨 6–9 月，符合旧代码约定，但不证明每条历史记录的独立真实时区。

## 学习域

重新读取来源，12 课程、5 进度，sourceHashes 与阶段 182 完全一致，4 张目标表仍为空。29 个非空时间字段已逐项生成 raw、候选 +480 偏移、candidateUtc，保存到仓库外私有 `learning-time-candidate-review-01.json`，含源码摘要及历史提交。

课程 created_at：6 月 5 个、7 月 1 个、8 月 6 个；updated_at：7 月 6 个、8 月 6 个。进度 updated_at：6 月 2 个、7 月 3 个。

候选明确 `applyEligible=false`，不冒充已批准的 manifest，不使用演练的合成证据。剩余是冻结来源时代的部署/导入时间依据，再将相应候选登记为 resolved；UTC 原字段保持原值。用户已授权开发库规范化，此处缺口是历史语义证据，不是要求重复授权。

## 验证与边界

只读工具语法、帮助入口及实际数据库统计通过；来源重读通过，关系缺失 0。本轮不启动网站、Redis、Bridge、终端；不访问公网，不改旧仓库，不回填或删除数据。
