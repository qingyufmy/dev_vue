# 阶段 97：会员当前态来源与支付历史边界

本阶段新增会员来源检查器和当前 dev_vue 只读核验脚本，覆盖 users.id/role/plan/plan_period/plan_source/plan_expires_at/updated_at 七个字段，关联完整订单来源及支付后投递记录，不生成权益或历史开通事件。

## 修正

逐表矩阵曾保留“从 users.plan* 与支付副作用回填当前态和历史事件”的旧表述。本次依据参考代码修正：会员状态由支付事务更新，payment_side_effects 的完成事务处理通知及佣金登记；completed 不能单独证明会员开通/续费历史。

参考代码：`wall-street-skill-local/server/crypto/monitor.js` 的 activateMembership，以及 `server/jobs/payment-side-effects.js` 的 completePaymentSideEffect。只读参考，未修改旧后端。

检查器保留当前用户套餐、来源和到期墙钟，不以最近一笔 paid 订单覆盖用户当前套餐；管理员角色也不改写成购买事实。NULL 到期保留为 NULL，非 free 的无限期权益语义单独列为待核验项。

## 实际核验

```powershell
node scripts/review-dev-vue-memberships.mjs --write
node scripts/review-dev-vue-memberships.mjs --verify
pnpm exec vitest run tests/v4-membership-source.test.js tests/v4-payment-effects-source.test.js
```

两次只读一致。当前 dev_vue 50 步结构完整、原始结构验证通过，25 用户：free 20、plus 1、pro 4。完整来源散列与脱敏阻断项见 [dev-vue-membership-source-review-20260907.json](dev-vue-membership-source-review-20260907.json)。本轮数据库写入 0；6 项定向测试通过。

## 剩余工作

历史到期/更新时间依据和部分无限期权益含义尚未确认，会员规范目标转换不能用 UTC+3 或当前套餐默认值填补。V4 现有 reader 有直接将 users.plan_expires_at 与 UTC_TIMESTAMP 比较的路径，会员转换及读写切换时必须统一处理，不能只修改数据库字段后假定权限计算正确。

尚需完成会员目标结构、来源字段与权益规则映射、迁移 writer、真实业务对账及消费者切换。本阶段不是会员迁移或全量自动升级完成证明。
