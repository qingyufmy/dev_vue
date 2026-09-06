# 同库升级第二十批：发现并开始纠正历史金额单位缺口

实际源码核查确认：V4历史交易/成交表没有记录币种，mysql-trade-history-repository金额SUM不检查币种，前端使用当前账户币种作标签。单账户范围不能证明历史单位不变；这是规范化过程中需要修复的实际缺口。

已追加026纠正迁移，为terminal_history_deals_v4、account_trade_records_v4新增nullable account_currency及currency_evidence，并约束unknown/NULL与explicit_record/非空的关系。存量默认未知，不反填当前币种、不改金额。迁移尚未执行；当前dev_vue没有这两张V4历史表，不能直接运行全部根迁移。

规则、两轮复核和连续实施清单见 [历史币种纠正规则](trade-history-currency-correction-20260906.md)。根迁移装载顺序测试已更新，34项schema runner测试通过。原001–025和inplace001–005均未修改，本批无数据库写入。

此批只完成结构补丁和明确的联动设计。采集、投影、汇总SQL、OpenAPI、共享合同及前端仍需同步，现有无币种汇总问题尚未修复。下一步必须继续这些联动，不能把026文件存在当成业务验收。整体数据库升级、真实回填和旧结构清理仍未完成。
