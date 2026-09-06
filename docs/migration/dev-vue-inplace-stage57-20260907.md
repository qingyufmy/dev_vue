# dev_vue 同库升级阶段 57：复盘查询字段规范化

按执行计划第 6 节已列出的“复盘详情/锁查询”推进查询合同。账户历史时区仍待确认；本批不修改时间值、不重复已有历史币种审查、不执行数据库写入。

## 改动与查询登记

`server/src/modules/reviews/infrastructure/mysql-review-repository.ts` 移除全部 5 处通配符查询，改为显式字段。另将原本已显式选择的手动候选列表与锁定选择复用同一列清单。

| 入口 | 表与作用域 | 返回字段/锁 |
| --- | --- | --- |
| listManualCandidates / createManualCase | manual_review_candidates_v4；账户所有权关联及候选 ID | CandidateRow 实际消费字段；创建选择保留 FOR UPDATE |
| listMemoryUpdates | strategy_memory_pending_updates_v4；library_id 和用户/平台库权限 | MemoryUpdateRow 13 字段，created_at/id 排序 |
| decideMemoryUpdate | pending updates + library + current revision；update_id，读取后校验 owner_user_id | 上述 13 字段及决策必需的库/当前版本字段；保留 FOR UPDATE |
| decideMemoryUpdate 回读 | pending updates；update_id | 显式 13 字段，LIMIT 1 |
| requestGeneration / createUserVersion / confirmVersion / returnCase 的 lockCase | review_cases_v4；id + user_id | revision/status/evidence_status/evidence_sha256/evidence_revision/current_version_id 共 6 字段；保留 FOR UPDATE |

不新增或删除索引，不改变 WHERE、排序、授权条件或事务边界。锁查询使用独立的 CaseLockRow 类型，避免继续将仅含锁判定字段的结果误标为完整列表 DTO。

## 验证与限制

- 新增 3 项锁路径回归：找不到用户所属 case、revision 已变化、状态不允许时，均在业务写入前拒绝并回滚，保留用户过滤与行锁。
- 复盘记忆与 Worker 回归共 12 项；合计 15 项通过。
- 服务端类型检查与 V4 构建通过。
- 本批没有真实 EXPLAIN/负载测量，不声称延迟或扫描量已降低；该查询登记仍待真实性能预算验收。

历史币种证据已由阶段 19 明确：271 个归属区间没有业绩记录，旧业绩币种可覆盖，不能当不可变历史。本批没有将当前币种写入未知历史。全域字段转换、账户真实回填、最终自动升级与旧结构删除仍未完成。
