# 同库升级第三十四批：时段SQL真实结构验证

在开发虚拟机的V4参考库 dev_vue_m1_a（MySQL8.4.8、UUID ac423207-6ef3-11f1-b302-000c29fda104）对6条实际SQL执行EXPLAIN和空结果SELECT，随后回滚。覆盖调度到期、分析窗口、交易员窗口、事务时钟来源、风险决策窗口、交易员自动分发。没有修改dev_vue或参考库业务数据，没有启动角色或终端。

首次运行发现 analysis_schedule 的参数化LIMIT报ER_WRONG_ARGUMENTS；诊断复跑确认发生在EXPLAIN。该驱动/服务端组合对JS number绑定LIMIT不兼容。仓库现验证limit为1–500安全整数，再以十进制字符串绑定。修复后6条EXPLAIN及6条SELECT均成功，独立第二次执行仍通过，结果均0行。输入摘要4edaea00d7f04ec3c38fadee1e0e3108038b5faa4a759c75f7771e175918fdf5，详见[输入](subscription-window-sql-input-20260907.json)与[回执](subscription-window-sql-validation-20260907.json)。17项本地测试和类型检查通过，服务端已重新构建。

5条查询通过构建后的实际类/函数和模拟连接捕获；分发查询从唯一WindowSubscriptionRow模板提取并拒绝动态插值。capture-subscription-window-sql.mjs要求先构建，输出文件wx保护。远端Python启动器只在Linux root运行，从面板读取密码到匿名0600 memfd，传给Node，不打印或落盘凭据。远端0700目录分为01/02诊断和03成功版，成功版3个文件SHA256均与本地一致；旧诊断包未覆盖。

此证据证明列/表引用、JOIN、FOR SHARE和参数绑定在真实V4参考结构中可执行。不存在业务fixture，因此没有证明正向授权、归属切换、锁竞争、真实时钟或运行端到端；不把零行查询等同业务验收。当前dev_vue仍有旧结构承接冲突，完整字段转换/业务回填、分发来源窗口、窗口版本冻结及全量自动升级仍待完成。
