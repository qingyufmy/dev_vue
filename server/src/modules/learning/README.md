# Learning 模块边界

负责课程列表、详情、内容访问与学习完成状态。会员权益由外部端口提供，网页会话与CSRF使用auth公开能力；不自行决定会员授予或身份登录。

## 公开入口

`index.ts`公开学习用例、最小读取/会员/完成记录端口、DTO与错误。数据库读写适配器和HTTP路由保持内部实现。

`composition.ts`仅供运行组装及验证工具使用：createMysqlLearningService创建查询用例；createMysqlLearningCompletionService接收连接获取能力及同一事务连接的会员读取工厂；createLearningHttp封装课程和完成路由。读取及完成能力可按既有范围分别挂载，任一存在时必须提供wwwOrigin，Cookie安全策略在此唯一配置，默认开启。

API运行入口创建具体服务并注入HTTP插件，全局登记器不再了解课程路由或学习会员事务。现有只读验证脚本也使用该组装路径，其执行仍受脚本的开发库身份及只读检查约束。

## 数据与事务

当前V4源码写入learning_progress、learning_progress_changes。课程、课时及资源为本域读取来源，内容管理与历史表的完整写入所有权仍需全表矩阵核对。会员读取由commerce提供，完成写入使用同一连接上的FOR SHARE读取，不得换成事务外缓存。

用户有效性、课程发布与访问权、expectedRevision、requestId/body一致性、进度及变更凭证的原子性继续由MysqlLearningCompletion保障。提交结果未知保留learning_commit_unknown及原幂等键/请求体；不能因HTTP响应校验失败重发新写入。

## 验收与未完成范围

learning-read、learning-completion、auth-sso-service和browser-realtime-runtime覆盖读取、事务/幂等、Cookie、CSRF、提交未知及路由组装。类型检查/构建运行边界和合同生成门；实际API清单使用同一HTTP工厂。

本次封装未更改SQL行为、权限、会员策略或合同，未连接真实MySQL/Redis，也不表示课程管理全功能、全部API同源校验、前端流程和数据库规范化已经完成。
