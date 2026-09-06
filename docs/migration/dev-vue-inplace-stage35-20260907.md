# 同库升级第三十五批：订阅者手动单分发窗口

依据 trade-execution-state-machine.md §6.3，每个策略订阅者分发目标必须重新核对接收时段。新增 assertDistributionWindow，把目标ID、用户、账户、冻结订阅revision、分发策略/version、当前订阅开关、活跃策略和当前owner联结，再复用同事务窗口与时钟检查。接入策略分发子命令 persistCommand 以及 Bridge markDispatched，覆盖预览后排队与意图创建后等待的窗口变化；窗外按已有错误路径记录目标拒绝/发送前失败，不发送命令。

source_type=strategy_distribution适用；普通user_command保持人工账户命令规则。distribution_close依据§6.4对原分发已确认outcome和精确ticket归因，该节未规定接收窗口限制，本批不新增接收窗口拦截。它仍必须经过现有账户、风险和精确持仓检查；不把入口未套用时段限制称为缺失授权。第三十三批列出的分发来源待项据此明确为手动单分发，不泛化为全部平仓。

39项执行/分发/命令回归与服务端类型、构建通过。提取工具升级为v2的7条查询（旧v1输入和回执保留）；开发V4参考库MySQL8.4.8上7条EXPLAIN及SELECT全部通过，结果0行，事务回滚。见[输入v2](subscription-window-sql-input-v2-20260907.json)和[回执v2](subscription-window-sql-validation-v2-20260907.json)。远端0700的window-sql-20260907-04工具包三个文件hash与本地一致；凭据仍仅匿名memfd传递，无业务写入。

空结果验证不是有数据权限/锁竞争证明。分发预览尚未表达窗口可用性；窗口revision冻结、有数据演练、全量字段转换及dev_vue自动升级继续进行。旧结构删除条件尚未满足。
