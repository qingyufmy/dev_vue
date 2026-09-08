# Bridge 精确会话证明只读投影

状态：当前源码投影合同；真实开发库执行计划、延迟预算及完整表所有权仍待验收。此声明不豁免新增跨域写入。

实现：`server/src/modules/bridge/infrastructure/mysql-bridge-gateway-route-repository.ts` 的 `selectSessionProof`。维护者为bridge；消费者仅为该仓储的激活、心跳及即时授权检查。结果不直接暴露给HTTP或Bridge客户端，仅返回会话ID与账户ownership_revision，非恰好一行时不提供证明。

## 来源与读取边界

| 表 | 目标数据所有者 | 本投影需要的事实 |
| --- | --- | --- |
| bridge_connection_sessions | bridge | 用户、账户、档案、实例、连接ID、两种epoch、pending/active状态 |
| terminal_profiles、terminal_account_bindings | bridge | 未删除的用户档案、installation/platform及未解除的精确账户实例绑定 |
| bridge_refresh_sessions | bridge | 同用户/installation/profile的V4有效凭据及generation |
| trading_accounts | trading | 精确platform/broker_server/login、未删除、ownership_revision |
| trading_account_ownerships、trading_account_ownership_intervals | trading | 当前未撤销owner、相同revision、开放且已开始的归属区间 |
| users | auth（权益语义与commerce仍需全表复核） | 用户有效性及现有admin/pro资格和到期条件 |

所有参数来自已校验的冻结route，不接受自由SQL条件或任意表名。连接身份同时限定用户、账户、profile、instance、connectionId、epoch和generation；经纪商服务器及login使用BINARY精确比较。凭据、档案、账户、归属或资格缺失均不返回证明。V4凭据不以旧兼容expires_at作为额外授权条件。

## 一致性与锁

激活和心跳在既有事务中先通过trading端口锁定账户/当前归属，再核对凭据和档案，随后执行本投影的FOR UPDATE版本，最后验证epoch并写会话。不得把会话行提前成第一把锁，不得在这几步之间提交或改用另一连接。

即时isAuthorized使用非加锁投影并随后查询最新profile epoch。它只证明读取时满足条件，不是长期授权缓存或免除派发前检查的许可；禁止将两次独立读取宣称为可串行化快照。当前不为该证明增加缓存。交易执行仍依既有链路验证自身冻结路由和权限。

## 索引与验证边界

查询按精确route过滤，没有跨账户列表或分页。迁移源提供bridge_connection_sessions的connection_epoch唯一键、terminal_account_bindings的profile/account/bound_at主键，以及账户归属区间主键/开放owner唯一键；profile epoch索引以追加迁移`20260906_023_bridge_profile_epoch_scope.sql`为准。此为源码索引依据，不能代替当前数据库SHOW INDEX或EXPLAIN。

后续真实依赖验收需检查精确route的实际执行计划、行数、锁等待、索引现状，以及并发撤销/轮换/接管时不能激活或延续旧会话。现有SQL double覆盖凭据与归属改变、旧epoch、已解绑、错误用户和失败回滚；未证明真实MySQL的并发行为。

新增字段、数据源或消费者须同步调整本合同及账户隔离/拒绝用例。普通账户查找和归属锁定已归trading，此跨域证明不能成为继续添加普通账户查询或业务写入的入口。
