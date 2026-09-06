# 阶段 77：当前库期初账本落地

当前 dev_vue 已写入 25 条 referral_credit_ledger opening。记录承接已有推荐账户期初，delta/previous_balance 为 NULL，余额 UPDATE 为 0；原 165 表/271007 行及推荐账户内容不变。

新增 `verifyReferralOpeningProof` 验证副本真实提交后断连、verifyOnly 完整结果、独立重复、原库/余额指纹、原 run 绑定及 132 文件工具 hash。实例、行数、余额变动、原指纹、文件集合或重复结果不符都拒绝提升。9 项证明门测试通过。

命令 `node scripts/apply-dev-vue-referral-openings.mjs --apply` 只接受 server/.env 的 dev_vue；校验备份和完整 47 步结构，使用当前库已冻结的推荐回填 run，在同一事务核验源证据、迁移记录、账户后写 opening。当前库不注入故障。首次执行 25 INSERT，随后 verifyOnly 和程序内重复均通过。

首次回执：`dev-vue-referral-openings-apply-20260907.json`。独立重复回执：`dev-vue-referral-openings-apply-repeat-ecd85ce9-164b-45b6-aa83-a3aed57fca77.json`，INSERT=0、余额 UPDATE=0，25 条记录完整一致。

重复结果文件采用新的唯一文件名，避免第三次执行覆盖历史证据。若本地首次回执缺失但数据库已有账本，先 verifyOnly；缺行或不一致直接失败，不以缺失本地文件授权重新写入。该缺失文件分支为源码补充；本轮真实执行覆盖首次写入和存在首次回执的独立重复，不冒称做过删除结果文件的恢复演练。

21 项证明门/写入器/期初规则测试通过。当前推荐域仅完成数据拆分、期初账本及迁移恢复，不包含实际支付扣款、退款、佣金账本事务或前端接口切换。当前 198 表/47 completed；全库规范化、自动部署升级和旧结构删除门仍未完成。
