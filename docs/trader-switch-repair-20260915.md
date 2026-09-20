# 自动交易开关保存修复

开发库的 `chk_strategy_receipt_action` 只接受原有七类策略操作，缺少 `set_account_trader`。保存开关时回执插入被拒绝，整个事务回滚，前端提示保存结果待确认。保留结果不确定时的真实错误提示，没有把失败伪装成成功。

追加迁移：`server/db/migrations/inplace/084_strategy_trader_receipt_action.sql`。升级登记 ID：`inplace_084_01_strategy_trader_receipt_action`；语句 SHA-256：`22855769b1512df934b2cc662bca0fbd49e1502c9b11bd0c375e332a6ba19cda`。

开发库执行入口：`node scripts/apply-trader-receipt-action-local.mjs`。脚本限定开发库，使用升级锁、台账、校验和和结构回读；支持已执行重放及 DDL 后台账未完成的恢复。没有修改历史迁移。虚拟机升级时需将本追加步骤纳入实际部署核对；本地入口不能用于其他数据库。

2026-09-15 已在 192.168.1.254/dev_vue 应用并完成台账登记，第二次执行确认无需 DDL。实际账户保存 SQL 和回执写入验证通过，测试将最终提交替换为回滚，未改变账户订阅或交易状态，未发送订单。服务端开关测试 8 项、前端开关测试 3 项通过。

顶栏开市文案改为“交易中”，休市保持“休市”，移除“市场”前缀；未知、受限状态仍如实显示。浏览器已验证新文案及原开关状态。

下一步：接入账户风控汇总生产链路，再进行完整分析与交易链路验证。
