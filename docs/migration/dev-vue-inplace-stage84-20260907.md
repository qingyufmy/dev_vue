# 阶段 84：订单目标表与真实 MySQL 约束演练

追加 `server/db/migrations/inplace/012_payment_orders.sql`，创建 payment_orders。物理合同见 [订单目标合同](payment-order-physical-contract-20260907.md)，包含源字段映射、迁移来源与 native 行边界、金额/时间/唯一性/父关系、两轮复审和剩余缺口。

SQL 已在开发参考库 dev_vue_m1_a 执行并冻结，未在当前 dev_vue 或恢复副本执行，未写入旧库的 schema_migrations 或伪造协调器日志。独立远端目录为 `/www/backup/aurum-v4/m1/20260906-01/payment-order-probe-01`；上传三个文件后检查 SHA，root 凭据通过匿名文件描述符传入，没有写入参数、日志或磁盘。

真实 MySQL 8.4.8 结果见 [回执](dev-vue-payment-order-schema-probe-20260907.json)：

- 3 条合法插入：零金额 native pending、历史取消订单（总额 300、旧 confirmed 1）、全额推荐抵扣 paid。
- 14 类拒绝：负总额、超额抵扣、负历史 confirmed、缺来源证据、native 混入历史来源、无迁移 run、无用户、重复 legacy ID、订单号大小写碰撞、外部标识大小写碰撞、paid 无日期、零 revision、未知状态、缺创建时间。
- 独立回读确认 300/1/0 三个金额精确保留。最终事务回滚，目标业务行、fixture 用户与迁移 run 均为零；新表本身保留供后续结构演练。AUTO_INCREMENT 元数据可能因测试消耗增加，不将回滚表述为整个参考库字节级还原。

回执 SHA-256 为 `54d6052803ba13d98f19f0e04fe0b5a41fdfeb55d62833a3f9f67760a3cf7647`，绑定源 SQL hash 与 MySQL SHOW CREATE TABLE。本轮完成真实结构/约束验证，未执行订单回填、支付操作或权益事件，也未改变当前 dev_vue 的 47 步注册结构。

下一步把第 48 步接入追加式协调器，先在恢复副本做 DDL 提交后断连恢复及重复运行，再安装当前库。业务回填仍需要历史 UTC、币种与支付匹配承接；旧 orders 的六个 crypto 字段尚待匹配表/来源证据落实，故不得删旧表或宣称全域完成。
