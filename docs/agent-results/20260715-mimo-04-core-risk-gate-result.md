# Task 04 交付结果：版本化风控骨架与 L1/L4/L5 核心闸门

> 执行者：Codex。用户取消 Mimo 委派后，由 Codex 直接实现并复审。

## 数据与版本

- migration 059 新增 `risk_policy_sets`、`risk_policy_versions`、`risk_policy_change_items`、`risk_profiles`、`risk_decisions`。
- `order_intents` 和 `auto_signal_deliveries` 保存订单意图、风控决策、原始订单与批准订单的关联副本。
- 规则注册表为每个字段声明编号、类型、单位、安全方向、默认值、系统允许范围、锁定属性和中文名称。
- 支持平台默认/允许范围/锁定值、账户策略和只能进一步收紧的策略风控档案。
- 同一次修改按字段分类：收紧字段立即生成不可变版本，放宽字段写入待生效项；不会把整次提交一起延迟。

## L5

- AI 输出要求显式合法的 `signal_type`、`entry_method`、建议手数、SL、所选 TP、参考价；挂单还必须有价格。
- 非法 entry method、类型与入场方式不一致、关键字段缺失、建议手数超出平台范围均降级为 hold，不回退市价，也不从 reasoning 读取执行指令。
- 默认和数据库中的活动输出 Schema 均加入 `entry_method`，避免升级后所有有效信号因缺字段被 hold。

## L1

- 已实现品种白名单、强制 SL、SL/TP 方向、ATR 止损上下限、最低 RR、挂单方向/偏离/默认有效期、AI 手数范围、账户/策略/平台最大手数和真实单笔风险。
- R1.3 只允许扩大已有 SL，并按距离同比向下缩手；之后重新检查最大止损、RR、手数和真实风险。
- 最终手数按经纪商 `volume_step` 向下取整，永不超过 AI 建议；低于平台或经纪商最小手数时拒绝。
- MT5 Bridge 的 quote/symbols 响应增加 tick value/size、contract size、volume min/max/step、digits、point、trade mode 和毫秒报价时间；关键数据缺失时失败关闭。

## L4 与三类价格限制

- 已实现信号 TTL、报价年龄、点差、周末保护和市价信号 ATR 漂移。
- 市价漂移、挂单百分比/ATR 偏离、经纪商 slippage 使用独立字段；Bridge 发送时才将 slippage 转为 `deviation` points。
- 交易时间窗的可编辑配置将在 Task 05 与账户状态/停机规则一起接入；本阶段未实现 L2/L3 状态型规则。

## 同步修复：历史统计默认范围

- `aurum_bridge_gui.py` 在用户未填写日期筛选或传入空日期时，默认从 `1970-01-01` 查询完整账户历史，不再隐式截断为最近 31 天。
- 显式的起止日期筛选保持不变；新增静态契约测试防止默认窗口回退。

## 验证

- 风控、订单意图、配置、LLM 和 Python Bridge 契约定向测试：87 项通过。
- Python Bridge 通过 `py_compile`。
- 全量回归：48 个测试文件、739 项测试通过。
- 对应 migration 已在真实 MySQL 应用并通过 readiness；真实 MT5 账户风控联调仍需在 Kill Switch 开启或模拟账户环境完成。
