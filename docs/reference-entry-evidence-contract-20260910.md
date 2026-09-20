# 策略参考持仓的历史创建分析合同

状态：源码及离线/独立MySQL参考验证完成。不是终端成交时行情证明，不代表旧策略语义或运行验收完成。

## 所有权与输入

inference拥有历史决策/分析读取与模型投影；execution提供精确创建订单来源，trade-history提供持仓生命周期和来源证据，bootstrap负责同一事务组装。参考组合中的position仍只有不具备终端ticket含义的referenceId。当前账户的可执行仓位不与参考组合合并。

StrategyReferencePortfolio现有schemaVersion=2保持兼容，positions增加可选entryEvidence；旧提供者未提供时保持旧快照行为。新ReadStrategyReferencePortfolio为每个输出持仓提供明确的ready或unavailable状态。entryEvidence自身schemaVersion=1。

## entryEvidence

- unavailable：reason只允许not_collected、creation_decision_missing、entry_analysis_unavailable、capacity_exceeded。没有生成默认条件、补当前分析或只保留部分贡献订单。
- ready：purpose固定creation_analysis_only，entries保留每个贡献订单各自的历史分析，evidenceHash为entries的规范化摘要。ready仅证明来源及投影可用，不证明某个策略条件成立。
- 每个entry仅包含不可执行的referenceId、交易/分析策略版本、analysisHash、两份输入快照hash、原采集/分析/有效截止时间、marketBias、marketRegime、keyLevels、invalidation、dataGaps。不传递原ticket、决策/风险决策ID、快照ID、完整提示词或analysisBody。
- 原始keyLevels/invalidation保持原意，不在服务端按某策略ID计算、挑选、合并或补猜加速周期；模型只能使用已经明确记录的周期、方向和条件。

## 边界

一个持仓最多32个贡献条目、32 KiB；超出返回capacity_exceeded，不能截断条件。最终模型快照内所有历史entryEvidence总量最多256 KiB，超出拒绝创建该快照。最终冻结再次检查字段白名单、字段类型、摘要和数量，原始对象修改不会改变冻结结果。

历史分析可以在当前已经过期；它必须与原决策和交易员输入中的analysis.id/contentHash/result一致，且在当时交易员输入采集时有效。它是创建时分析，尤其对延迟成交的挂单，不能宣称等于终端实际成交瞬间的行情。

## 验证与未完成项

33项模型投影/组合测试通过，含多贡献订单、全周期条件保留、私人ID不被附带输出、原文摘要/作用域拒绝、容量边界与实际组合到最终冻结管道。strategy-write-reference-v71从完整推理DDL/外键中的真实历史SQL读取，再投影并冻结，modelEntryEvidenceVerified=true，随机库清理且开发库零写入。

旧ATR候选仍需逐项核对keyLevels中周期/方向/状态表达是否足够明确，尤其区分创建与实际成交时间；该合同不会自动批准角色迁移。80%部分平仓后的保护状态机、旧策略/订阅业务回填、canonical提升及记忆审计仍需完成。
