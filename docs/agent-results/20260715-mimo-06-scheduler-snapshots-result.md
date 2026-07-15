# Task 06 交付结果：账户无关共享调度、私有推理与推理快照

> 执行者：Codex。用户取消 Mimo 委派后，由 Codex 直接实现并复审。

## 两类调度语义

- 平台策略继续按“策略 + 标准品种”生成一次共享信号，但管理员 Bridge 只作为市场数据源。推理阶段不再请求管理员账户、持仓或挂单，管理员余额和仓位变化不会改变相同市场行情下的模型输入。
- 平台策略固定解析平台主模型。用户私有策略只允许 owner 调度，并按“策略绑定用户模型 → 用户默认模型 → 管理员允许共享的 auto 模型”解析。
- 显式绑定的用户模型被删除、停用、解密失败或调用失败时不会暗中切换平台模型；无可用模型时调度暂停并暴露具体原因。
- 私有策略使用 owner Bridge；平台共享信号仍为每位在线订阅用户生成独立 Delivery，执行时读取用户报价、品种映射和账户风控。
- 平台共享根信号只保存市场证据与 AI 原始建议，不写用户 ticket、批准订单、账户快照或个人风控状态。

## 共享模型输入白名单

共享输入仅包含：

- 标准品种、周期、市场时间与市场源；
- 最新价、涨跌、波动率、成交量；
- SMA、EMA、MACD、RSI、布林带、ATR、支撑阻力、K 线形态与趋势评分；
- 策略要求的多周期紧凑 K 线和对应技术摘要、缠论摘要（策略明确启用时）；
- 主周期、请求/实际/缺失周期；
- 平台允许的 AI 建议手数上下限。

明确排除 account、balance、equity、positions、pending orders、个人盈亏、个人风险等级和个人风控参数。共享提示词同时声明禁止模型猜测这些账户信息，账户持仓/挂单治理全部留给独立风控。

## 可复现推理快照

- migration 061 新增 `inference_snapshots`，与信号在同一事务写入。
- 保存实际渲染的 system/user prompt、prompt hash、策略 ID/版本/范围/owner、模型 profile/provider/name、credential source、标准品种、市场源、紧凑 K 线、市场白名单快照、输出 Schema hash、memory mode、内容 hash 和证据完整性。
- 快照递归移除 API key、Authorization、credential、password、secret、token 等敏感字段；表结构没有密钥或 Authorization 列。
- 单快照上限为 512 KiB。超限依次只保留每周期最近 50 根 K 线，再以 SHA-256 引用替代过大的 user prompt、市场快照或 system prompt，并标记 `evidence_status=incomplete` 与具体 omitted fields；仍无法满足硬上限时失败关闭，不保存不可审计信号。
- 个人订阅的 memory mode 会随快照保存，但本阶段不注入任何个人记忆。

## 验证

- 测试证明管理员余额、持仓和挂单变化不会改变共享市场快照。
- 测试覆盖共享提示词白名单、实际渲染提示词回传、Schema hash、递归密钥脱敏、512 KiB 限制与显式证据降级。
- 调度、LLM、模型解析和配置定向测试 149 项通过。
- 全量回归：50 个测试文件、758 项测试通过。
- 真实 MySQL migration、真实平台/用户 Bridge 与模型联调保留到 Task 11。
