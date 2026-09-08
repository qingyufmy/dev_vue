# Settings 模块边界

负责配置的类型化读取、管理员读取和受约束的配置修改。`index.ts`是唯一业务公开入口，公开读取端口、结果类型、管理用例与仓储端口；不暴露SQL连接、数据库类或HTTP路由。原`management.ts`第二入口已移除。

## 组装与依赖

`composition.ts`负责绑定适配器：createSettingReader返回不带数据库参数的读取端口；createMysqlSettingsModule创建管理读写用例，并固定使用validateSettingMenu完成菜单语义校验；createSettingsHttp封装管理GET/PUT路由。API入口注入管理员认证能力，HTTP插件挂在既有精确admin host检查之下。

读取结果/类型归domain/setting-read.ts，SQL读写适配器共同引用；禁止为了读取类型而导入数据库文件。内部配置读取端口不等于HTTP授权，它可返回restricted值，且保留secret/credential的SQL遮蔽；对外管理员读取必须经过管理用例、白名单与身份重查。

## 数据与不变量

当前源码写入system_settings、system_setting_changes和system_setting_requests。更新事务保持actor → receipt → setting锁序，重复请求仍重查管理员资格；配置更新、变更记录与幂等凭证一次提交。菜单和其它值策略不得在组装时被省略。

missing、NULL、空字符串和文本不能互相兜底；ID和revision保留精度。读接口不泄露密钥，写接口不回传配置值。revision冲突、幂等冲突、提交/回滚未知的原错误语义保持，不能遇到未知结果就换新幂等键重试。

## 验证与范围

mysql-setting-reader/writer、setting-management/http、admin-setting-read、setting-menu/value-policy及browser-realtime-runtime为当前定向验证入口；类型检查和构建包含增量边界门。SQL实现、值规则及事务未在本次封装中改写，未执行真实配置写入。

当前扫描器只登记index的实现导出，原management第二入口没有完整计入债务；已移除该入口，但其它模块第二入口的扫描覆盖仍需补齐。模块封装通过不代表所有配置管理功能、API运行校验、数据迁移或真实数据库验收完成。
