# 阶段 118：派生钱包元数据结构与同库升级

当前 dev_vue 完成 `inplace_016_01_payment_wallet_addresses`，为 204 表、54 个 completed 步骤。新表为空；四条 wallet_keys 原记录和所有历史支付收款地址均保留。

## 结构与真实约束验证

追加 `017_payment_wallet_addresses.sql`，13 列承接派生登记身份、创建时间、托管引用/证据、版本和导入来源。该 SQL 已执行，不得改写。chain/index、chain/address 分别唯一；机器地址精确大小写比较；链/地址尾空格通过字节长度约束拒绝；托管字段三项俱全或三项全空；来源/托管 hash 必须为小写十六进制。没有向 payment_matches 强加派生钱包外键。

隔离参考库 dev_vue_m1_a 接受三类合法形状（native、legacy、完整托管证据夹具），拒绝十五种非法/冲突输入，验证跨链同文本、大小写、毫秒时间和大整数 revision；测试事务回滚后零记录，见 [结构回执](dev-vue-wallet-address-schema-probe-20260907.json)。这些夹具不是有效链地址或真实托管验证。

## 升级与数据证据

恢复副本 dev_vue_m1_source_20260907_02 实际建表后注入异常，再次协调只补完成日志；重复执行不建表。所有原 271007 行及现有新增表完整受保护行散列一致。

[恢复回执](dev-vue-wallet-address-rehearsal-20260907.json)绑定 176 文件，SHA-256 `60c9352b3fccee5ce892b9206424c21e89adfaa3df372a46a5a59f31b8bbb85f`，远端 `/www/backup/aurum-v4/m1/20260906-01/wallet-address-rehearsal-01`。

显式入口 `upgrade-dev-vue-schema.mjs` 为 v11，保留历史证明链，新增钱包全 13 列数据保护。当前库[首次应用](dev-vue-schema-upgrade-6e12a89f-7e8f-4795-b1d9-c9674b9c9154.json) verified：1 DDL、2 次日志写入；[独立重跑](dev-vue-schema-upgrade-8502ff06-b4c0-487c-9fe4-002d7ddf9f38.json) verified：0 DDL、0 日志写入。原始及会员/推荐/支付/规则审计数据校验通过。十一项相关离线测试通过。

## 尚未完成

四条旧钱包 created_at 非 NULL，仍需历史时间依据；密钥控制关系未经验证。新表允许 legacy 的 created_at_utc 为 NULL，只能用于源原值确为 NULL 的转换，不能作为绕过现存时间歧义的方法。托管为空表示未验证，不表示可签名或可归集。

下一步继续实现五字段严格转换及来源归档；固定收款配置另行承接。当前安装的是结构，不是业务钱包迁移或运行切换，不能据此删除 wallet_keys。全库自动升级、其余域迁移及旧结构退出仍未完成。
