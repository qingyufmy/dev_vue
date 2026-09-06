# 阶段 76：真实期初账本与提交后断连恢复

恢复副本 dev_vue_m1_source_20260907_02 已在同一事务写入 25 条 opening。COMMIT 成功后主动销毁连接，共用事务层报告 commit_unknown；新连接调用 verifyOnly，逐行确认 25 条已存在且完全一致，没有补写缺失行或重新增加余额。

程序内重复执行插入数为 0。独立再次启动只读核验及重复 writer 均通过，INSERT 为 0。原 165 表/271007 行及 25 条推荐账户全字段 hash 前后相同，余额 UPDATE 为 0。账本记录通过旧 run、源证据、映射/批次/checkpoint 与现有账户核对，来源历史时间没有转成假交易日期。

证据：

- `dev-vue-referral-openings-rehearsal-20260907.json`，SHA-256 `7b6fc1e97fb70ccc356cf340d1d8427ede76f90bff22ae2d401eaad0b67f0dc9`。
- `dev-vue-referral-openings-repeat-20260907.json`，SHA-256 `a794621de90aba7d81b565420811ef077d3e83f4be0237528b41c023581a7ef3`。
- 132 文件工具包 SHA-256 `6ab0d7a35109ed6235ec6d307d27a2b5ca5e74550cb835778693f05700bdd4b8`，执行前及下载回执后逐文件核验一致。远端 referral-openings-01 保留；本地临时 tar 删除。

本次只覆盖事务已提交但响应丢失的真实故障；未提交/缺行拒绝补写由阶段 75 的测试覆盖，不能表述为该路径也已真实断连演练。当前 dev_vue 账本仍为空，没有向当前库写入 opening。下一步把本次证据绑定到当前库入口，执行 25 条期初并独立回读；应用财务协议、全库迁移、自动部署升级与旧结构删除仍未完成。
