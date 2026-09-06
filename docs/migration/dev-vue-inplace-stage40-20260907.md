# 同库升级第四十批：订阅配置源语义检查

新增 v4-subscription-config-review.mjs，并在原只读采集器增加 --write-config / --verify-config。继续使用 server/.env 的 dev_vue、固定 server UUID、一致快照只读事务，以及第二十五批已冻结的源基线：dev-vue-strategy-source-review-20260906.json。报告不包含提示词或账户登录信息，写入使用 wx；不执行业务 DDL/DML。

本批检查 memory_mode、take_profit_mode、risk_profile_id、conflicting_strategy_id、active_execution_user_key 五个源字段。源 ID 使用字符串精确比较，风险档案引用检查存在性及用户归属，冲突策略检查存在性，生成列按旧 execution_enabled/is_deleted/user_id 规则核对。未知模式、无效或缺失引用、错误归属及生成列不符均明确报错，不静默置空。

源码依据：strategy-ownership.js 的 normalizeMemoryMode 区分平台 platform_only 与私人 personal/off/shadow，私人 shared/isolated 仅记录为保存入口的 personal 别名，不据此宣称运行时已等价。config.js 的 signalOrderPayload 使用 conservative/standard/trend 对应 1/2/3 档；ai_recommended 缺推荐档时回退 1 档，档位无有效价格仍需保留原规则。getDeliveryExecuteRiskConfig 实际读取用户或全局调度开关，不能把旧 risk_profile_id 直接变成新的执行风控授权。

真实开发库结果：3 条策略、5 条订阅，源摘要与原基线一致。5 条均为 platform_only / ai_recommended；risk_profile_id 与 conflicting_strategy_id 全部为空；5 条生成列全部符合旧规则，无模式归一或引用异常。完整回执见 [dev-vue-subscription-config-review-20260907.json](dev-vue-subscription-config-review-20260907.json)。独立 --verify-config 重采一致。

8 项定向测试通过，覆盖模式、档位、未知值、大整数引用、跨用户引用及删除状态生成键。普通修复复核：报告只承认源语义 recognized，始终 executable=false；没有把旧用户级唯一键搬成账户品种执行许可，没有把保存入口的默认值冒充已验证的记忆运行行为。

剩余工作：V4 订阅目标尚未承接这些配置，需完成记忆注入规则、止盈选择消费者及风控权威映射，再纳入逐字段 writer 和对账。当前空引用不等于允许删除风险档案或历史结构。全量业务回填、部署升级入口、旧结构清理仍未完成。
