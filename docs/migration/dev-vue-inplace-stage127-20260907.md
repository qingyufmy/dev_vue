# 阶段 127：配置精确标记修正与57步协调器

补查MySQL实际正则发现：`$`允许在最后一个换行前匹配，原018基础检查会接受带LF的标记。旧SQL保持不变，追加020_system_settings_exact_tokens.sql，拒绝namespace/key/type/sensitivity非法字符，并对布尔使用二进制精确比较、整数拒绝非数字/负号字符。合法字符串正文和JSON空白不受该修正影响。

参考库真实应用020，七类LF/CR输入全部被拒绝：namespace、key、type、sensitivity、boolean LF、integer LF、boolean CR；合法配置成功，事务回滚后零行，见[回执](dev-vue-settings-tokens-probe-20260907.json)。该SQL已经执行并冻结，固定SHA为ccaf209f262d3cad427090daa114ef5e04370efc6ad1400ac27350f02410ea10。

新增loadSettingsCoordinator，在完整54步后顺序追加system_settings、system_setting_changes和精确标记修正，共57步。绑定两份参考回执、原/后DDL指纹及SQL散列；配置表拒绝视图或附加触发器。CHECK追加使用精确绑定的独立步骤，不扩大旧FK-only helper的通用操作范围。原54步及历史回执未改写。

八项相关测试通过：三步安装、重复零DDL、任一CREATE后中断恢复、最后ALTER后中断恢复、未登记表冲突拒绝和旧54步兼容。当前dev_vue尚未执行55–57，恢复副本真实演练及显式入口升级仍待完成。完整配置回填、消费者切换及旧结构清理尚未完成。
