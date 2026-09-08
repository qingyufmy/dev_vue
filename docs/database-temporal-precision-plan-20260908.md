# 现有目标表UTC毫秒精度升级

43个类型差异的真实只读数据预检通过：数值列无负数，16个DATETIME列无零年/月/日。此结论不授权根ID或状态含义转换。此批仅提升6张现有目标表的16个时间列到DATETIME(3)，不改变已有值、NULL和写入来源。

范围为 users 的 plan_expires_at/deleted_at/created_at/updated_at，bridge_refresh_sessions 的 expires_at/revoked_at/last_used_at/created_at/updated_at，ai_model_profiles 的 created_at/updated_at/deleted_at，user_model_defaults 的 created_at/updated_at，platform_model_usage_policy.updated_at，ai_model_usage_logs.created_at。

每列独立追加ALTER步骤，75步历史不改；用户created_at/updated_at实际允许NULL且DEFAULT(now())，保留NULL能力并将默认表达式提升到now(3)。其它列没有自动更新时间，不引入ON UPDATE。目标设计中users两列NOT NULL的差异另行登记，不能借精度升级填假时间或改变可空语义。

先在恢复副本执行16步及逐步中断恢复，再对当前dev_vue执行。两次运行均核对所有既有表的逐列值、结构、自增值；时间统一用六位微秒DATE_FORMAT作比较，解决驱动对DATETIME与DATETIME(3)返回字符串格式不同的问题，但不截断到秒，因此任何时间数值变化仍会被发现。结构比较只将这16行经核实的精度/默认表达式还原用于前后对比，任何其它结构变化均拒绝。

第一轮复审：范围来自实际类型差异而非全库机械ALTER，只提升正在目标计划中的现表字段。旧时间按用户决定为UTC，不加减偏移，不修改DATE业务日期，不处理外部MT票据或根ID。源表和未来业务切换仍单独接续。

第二轮复审：全列语义摘要必须保留毫秒及微秒，不能用忽略小数来掩盖改值；精度变更可能重建表，以恢复副本耗时/数据/自增验证为准，DDL不能整体事务回滚。采用同连接锁、before/after列元数据、完整journal及逐步reconcile，现有应用默认关闭，升级不启动服务。旧冻结工具遇到新结构按版本拒绝，后续回填需适配当前版本，不能绕过checksum。
