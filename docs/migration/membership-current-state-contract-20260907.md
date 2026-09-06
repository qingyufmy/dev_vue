# 会员当前态转换合同

范围：users 的七字段会员来源投影 → memberships 当前态。一个用户一行，以现有 users.id 为主键和外键；不新增会员历史事件、购买事实或 Bridge 额度事实。

## 字段与时间

- plan / plan_period / plan_source 分别保存为 plan_code / billing_period_code / source_code；保留 NULL 与空串差异，plan 当前仅接受已核实的 free/plus/pro，未知值阻断。
- 非空 plan_expires_at 经逐行来源散列、原值、快照及外部已核验依据绑定，转换为 expires_at_utc，expiration_kind=at_time。
- 空 plan_expires_at 对应 expiration_kind=no_expiry、expires_at_utc=NULL。须绑定原系统 NULL 到期规则的依据，含义只是当前态没有到期边界，不代表购买过永久套餐，也不创建 grant。
- current_state_observed_at_utc 使用迁移登记时间，表示本次记录当前态的时刻；不是旧会员创建或修改时刻。原 updated_at 与 role 留在完整来源证据，不冒充 UTC，也不通过本表授予管理员权限。
- 过期的原套餐仍保留原计划与原到期时间。消费者按可信当前 UTC 求有效套餐，不在导入时永久改写成 free。
- revision、origin、migration_run_id、source_sha256、imported_at_utc 使导入与原生写入可区分；原生行不得带导入来源字段。

## 两轮复核

第一轮（职责与需求）：不从最新订单或 completed 投递构造当前态；不从当前态伪造历史；不为管理员另建付费会员记录。NULL 到期和购买永久权益分离，调整为显式 expiration_kind。

第二轮（数据与异常）：父 users.id 类型一致，无级联删除；NULL/到期类型有 CHECK；有效性不写死为导入时状态；不使用 UTC+3 默认迁移时区；时间依据与 NULL 规则均须外部证据目录绑定。已执行迁移不改，新增 SQL 在真实参考库约束验证后才能加入协调器。

剩余风险：当前规则的历史适用范围需核实；现有权限 reader 尚直接读取 users.plan*，必须在回填、对账后统一切换。当前态之外的历史事件、赠送/撤销与额度来源仍须逐项处理。本合同不宣称完成权益业务迁移。
