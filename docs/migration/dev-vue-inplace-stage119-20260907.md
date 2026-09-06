# 阶段 119：钱包元数据转换与受限写入器

实现 `v4-wallet-address-rows.mjs` 和 `mysql-wallet-address-writer.mjs`，为已安装的 payment_wallet_addresses 提供完整 13 列转换及逐行写入。此阶段没有执行数据库 DDL/DML；阶段 118 的真实结构验收仍是最近数据库证据。

## 转换与数据保留

每条记录保留 wallet_keys 原五字段、原行 hash、时间依据和依据文件 hash。时间依据必须绑定整批 sourceHash、sourceSnapshotId、逐行 sourceHash 和原始 created_at；外部依据目录必须精确匹配 evidenceId/hash。目录的真实性由后续批次准入负责，转换器不会把调用方提供的 hash 本身当作已完成历史核实。

只有显式 wall_clock 偏移依据可以转换非空时间；源 NULL 只能按 source_null 规则保留。无默认偏移、不用当前终端时区推定历史值、不把非空时间改为 NULL。转换保留旧 ID、链、派生序号及地址；托管三字段均为 NULL，不生成私钥、不确认地址控制权。

## 写入与恢复边界

写入器固定预备条目，拒绝调用方修改来源、目标或依据；写前锁定并核对源五字段，逐一回读目标 13 列。完全相同的重复请求为空操作，任一字段冲突均拒绝覆盖。verifyOnly 不创建缺失行。写后必须完整一致；SQL/连接错误直接交给外层，不自动重放 INSERT。

事务、准入、来源归档、ID map、receipt/checkpoint、提交不确定恢复仍由后续批次适配器承担。这一逐行原语不独立提交，也不代表来源证据已经持久化。不能作为可直接执行真实钱包回填的入口。

## 验证与复核

运行 `pnpm exec vitest run tests/v4-wallet-address-rows.test.js tests/mysql-wallet-address-writer.test.js tests/v4-wallet-address-source.test.js tests/v4-wallet-watch-links.test.js`，4 文件 18 项通过。覆盖跨日时间、原 NULL、缺失/不匹配依据、来源漂移、目标全部字段冲突、重复写、verifyOnly 缺失、写后损坏和 INSERT 响应中断。测试为合成来源和 Mock 连接，不是实际 MySQL 事务证明。

定向复核确认：钱包五字段来源与支付固定收款地址关系保持独立；未给 payment_matches 增加错误外键；未更改已执行迁移或旧证明文件。补充异常回读及连接中断测试，确保底层不会自行提交或重发。

## 后续

当前四条旧钱包的非空 created_at 仍待历史时间依据。继续接入批次准入、同事务来源归档和独立对账，再在隔离库验证真实 writer/回滚/恢复。托管控制关系及运行消费者切换单独验收；此前不能删除 wallet_keys。全库规范化尚未完成。
