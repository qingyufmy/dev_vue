# 模型与用量默认值规范化

当前114步库默认差异22项中，本批处理3表16项，列表由default-normalization-scope.mjs明确固定。采用已批准V4目标的默认值：模型owner/scope/provider/model删除显式默认；temperature/max_tokens/reasoning_effort未知为NULL；thinking_enabled=0、status=inactive；平台额度默认0，id必填；用量凭据来源/请求阶段/请求状态必填，accounting_status=usage_unknown。

同批另加1条独立机器键约束：bridge_refresh_sessions.token_hash从人类文本排序改为目标ascii_bin。17条摘要均为64位小写十六进制；真实执行前再次核验。类型CHAR(64)、唯一索引、NULL、默认和所有摘要原值保留。摘要由服务端SHA-256生成，不是用户原始token；新排序提供精确匹配，无需客户端传输协议改动。

现有模型、角色、额度、使用记录一律不改，不关闭当前模型或改变当前额度。仅未来省略字段的INSERT行为变化，显式旧值不会受影响。已核查V4用量writer显式提供凭据、阶段、reserved状态和usage_unknown，不依赖旧success/estimated默认；模型与额度管理写入口尚待后续业务实现，应遵守新目标合同。

用户created_at/updated_at的now(3)有既定保留依据，继续采用UTC连接会话生成毫秒时间。账户broker_server、行情tick_volume、模型任务status/fencing_token四项默认随根实体合同切换，不凭默认值差异直接改动未承接的业务。

第一轮复审：默认值不是历史事实，不通过UPDATE“纠正”已有记录；取消隐式active/success防止无明确输入却生成确定业务结论。所有改变来自冻结目标DDL，不发明新套餐、模型参数或权限。

第二轮复审：16条ALTER COLUMN和1条摘要排序ALTER独立记账；恢复副本逐DDL异常、reconcile、重复和全表原值/结构/自增对账后才执行dev_vue。前114步不改，除摘要ascii_bin外类型/NULL/排序不变。非空列删除显式默认不等于所有遗漏写入都会失败，ENUM仍可能使用首枚举值；业务管理写入口必须显式校验并提供这些字段，待配合；这不影响当前行，也不启动任何实际模型调用、服务或公网部署。
