# 阶段128：统一配置恢复副本升级

恢复副本dev_vue_m1_source_20260907_02已由54步升级至57步，新增system_settings、system_setting_changes并追加精确标记约束。三条DDL各执行一次，每条成功后分别注入应用异常，协调器识别实际结构已变化，下一次仅补该步完成状态后继续。最终重复执行所有57步均为completed，没有再次执行DDL。

原165表的结构与271007行校验通过；此前已有新增表全部显式字段/主键顺序行hash与升级前一致，包含钱包、会员、推荐、支付、规则和迁移业务证据。两张新配置表零行，未发生配置回填或配置生效。

[演练回执](dev-vue-settings-upgrade-rehearsal-20260907.json)绑定186文件，SHA-256为947a02e9fdbbcff63f4afdf2447f780fb6b2165f2f0d14454184297bd2343c7d，远端目录/www/backup/aurum-v4/m1/20260906-01/settings-upgrade-rehearsal-01。八项相关离线测试通过。

executeSettingsUpgrade当前仅允许该恢复副本，未扩大当前库写入口。下一步绑定此真实回执到当前库显式升级入口，保留原54步证明链后应用55–57；当前dev_vue本轮未写，仍54步。配置原字段回填、密钥恢复、消费者切换与旧结构删除仍未完成。
