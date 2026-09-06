# 阶段 103：规范会员读取与 UTC 有效性

新增 commerce/domain/membership.ts 和 infrastructure/mysql-membership-reader.ts。reader 按指定用户主键读取 memberships 的业务字段，保留 revision 字符串，不读取 users.plan* 作为隐式回退。

领域计算由调用者传入可信当前时间，在到期瞬间（expires_at_utc <= observedAt）得到 effectivePlan=free，保留 storedPlan；no_expiry 仅表达当前态无到期边界。身份、注销、管理员权限、购买和连接额度不是该函数的职责。

缺失记录返回 null，不能视为已迁移的 free；无效用户、跨用户返回、重复记录、异常套餐/版本/到期组合均拒绝。正式调用方仍须在回填和对账完成后切换，并单独验证身份及访问权限。

## 验证

- 6 项定向测试通过，覆盖毫秒边界、显式无到期、错误日期/时钟、缺失、错用户、重复、非法到期组合和查询前校验。
- typecheck:server、build:server:v4 通过。初次类型检查发现测试 mock 参数签名缺失，修正后全部通过。
- 编译产物在 MySQL 8.4.8 参考库 dev_vue_m1_a 实际读取通过：revision=9007199254740993 保持文本，.123 毫秒与 UTC 格式一致，NULL 与空串保留，到期前 1 毫秒 pro、到期瞬间 free。
- 合成用户 777901 及会员记录全部回滚；当前 dev_vue 未写入，现有业务消费者未切换。

回执 [dev-vue-membership-reader-probe-20260907.json](dev-vue-membership-reader-probe-20260907.json)，原始 SHA-256 `f524858fb61946c117f02d2943f3992c6fc29fa6343cb48329d57921ad31b429`。绑定源码、编译产物和工具共 8 个文件，远端目录 `/www/backup/aurum-v4/m1/20260906-01/membership-reader-probe-01`。编译产物由构建生成，不提交 dist。

后续须完成真实会员依据、回填与独立验收，统一替换旧权限读取后才能删除旧会员字段。当前不宣称线上授权链路或全量自动升级已完成。
