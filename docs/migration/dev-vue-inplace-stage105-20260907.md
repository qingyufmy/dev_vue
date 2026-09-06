# 阶段 105：空到期会员的真实规则与批次范围

本阶段解决 NULL 到期记录的规则依据，不推断四条非空到期时间。参考旧 server/membership.js 的 isMembershipExpired 对 NULL 返回 false，getEffectivePlan 保留已知套餐；原 auth SQL 也仅在 plan_expires_at IS NOT NULL 时判断过期。实际调用旧 getEffectivePlan 和已构建的新 evaluateMembership，对 free/plus/pro 三种 NULL 到期情况逐项比较一致。

含义是承接当前态无到期边界，不证明购买永久套餐，不生成历史开通、赠送或额度事实；身份、管理员角色与注销权限仍独立。

## 当前只读证据

当前 dev_vue 51 步及原结构验证通过；两次独立只读结果一致。25 用户中选中 21 条空到期记录（free 20、pro 1），4 条非空到期记录暂不转换。原 updated_at 只原样归档，新观察时间使用迁移登记时间，不作历史 UTC 转换。

回执 [dev-vue-null-membership-review-20260907.json](dev-vue-null-membership-review-20260907.json) 绑定完整 25 用户七字段散列、21 行选择散列、规则、参考函数源码及新源码/构建散列。文件 SHA-256 `d787e0dfb878873225589be5235be12cb6beb02703f1e8340c41807ba6260830`。

此证据来自当前源码和只读数据，未宣称运行中旧服务版本或公网已核验；它仅支持 NULL 原值的当前态无损映射，不支持非空历史时间转换或业务切换。

## 实现

prepareNullExpiryMembershipBackfill 只接受与回执完整来源一致的投影，固定选取 NULL 到期，逐行绑定真实规则回执字节散列，按 10 行形成批次。即使发生变化的是暂缓用户，也拒绝沿用原选择范围；调用方须独立验证回执真实性，不能接受任意自构 review。

11 项关联测试通过，覆盖精确选择、依据绑定、暂缓用户变化和禁止生成历史 grant。只读核验命令：`node scripts/review-dev-vue-null-memberships.mjs --write|--verify`。

本轮数据库写入 0。下一步把 21 行范围接入有恢复证明和完整归档对账的实际执行入口，先恢复副本、后当前 dev_vue；四条非空到期仍需时间依据，所有业务消费者维持现状。
