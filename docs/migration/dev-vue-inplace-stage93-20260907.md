# 阶段 93：匹配逐行 writer 与父订单保护

新增 mysql-payment-match-writer.mjs，准备并冻结允许写入的完整条目。事务内先调用父订单 verifyOnly（完整字段、FOR UPDATE），再锁匹配行；父订单缺失/变更先拒绝，匹配已有且一致返回 applied=false，冲突不覆盖，缺失 verifyOnly 不补写。插入使用参数化 SQL，随后回读全部 21 字段。writer 不创建父订单、交易或运行监听，事务由调用方管理。

新增独立 9 字段源事实对账，直接从旧监听比较 legacy ID、用户、链、地址、期望金额、状态、确认策略、旧确认数和钱包索引，不调用最终目标转换器。报告缺行/多行/金额和用户差异、拒绝重复 legacy ID；时间、资产和引用的独立核验仍标记未完成，不能当作完整回填验收。

24 项测试通过（匹配 writer 6、匹配转换 11、订单 writer 7），原匹配合成 fixture 提取为共享测试模块。覆盖父→子锁序、缺父/父变化、verifyOnly、幂等、金额冲突、条目篡改及独立事实对账。

真实 MySQL 8.4.8 验证见 [回执](dev-vue-payment-match-writer-probe-20260907.json)，SHA-256 `455bee6b9f0b58127e2e6344d64aff34df0fedcd04782fe752acef3e3f06dcce`。在 dev_vue_m1_a 使用合成用户/目标 ID 777404，16 个工具文件逐一校验 hash，远端目录 `/www/backup/aurum-v4/m1/20260906-01/payment-match-writer-probe-01`：

- 实际父订单缺失拒绝；创建合成父订单后，匹配 verifyOnly 缺行仍拒绝。
- 实际首次匹配 INSERT、全字段回读及重复无插入通过，9 字段源事实独立回读一致。
- 将合成父订单 revision 改为 2 后拒绝父漂移；恢复 savepoint 后改匹配 expected_amount，再拒绝匹配冲突。
- 全事务回滚，用户/订单/匹配/run 的合成记录均为零；自增元数据可能增加，不表述为整库字节级还原。

本轮未改当前 dev_vue，也未对真实历史时间/资产依据作确认。匹配完整批次的 ID map、回执、源证据、检查点与真实提交未知恢复仍需接入；已有链上认领分支仍待完整交易事实支持，目标没有缩减为单行 writer。
