# 阶段 186：学习域新表只读 API 与主站页面

## 已实现

新建 learning 模块，按 domain/application/infrastructure/transport 划分。生产 API 入口已装配新表读取；新增主站 `/courses`、`/courses/:id`，首页与导航链接进入课程列表。

- `GET /api/v4/learning/courses`：已发布课程摘要，每页 20 条，sort_order/id 游标，无媒体、用户进度或迁移字段，描述摘要限 240 字符。
- `GET /api/v4/learning/courses/:id`：课程摘要及访问状态；只识别 www-web 会话，不接受请求提供的用户 ID 作为身份。free/logged_in/plus_pro/pro_only 权限通过 commerce 的当前 memberships 读取端口判定，缺失或过期权益视为 free。
- 未授权详情返回锁定状态和空 lessons；未发布/不存在课程返回 404。所有接口限制 WWW Host，返回 private,no-store。
- 有权限时读取最多 100 节课，明确返回是否截断。进度只按服务端用户 ID 连接 learning_progress，BIGINT 时长保持文本，未有进度时保持 null。
- 媒体只生成合法 Bilibili/YouTube 导航 URL 或 HTTPS 文章链接；本地视频路径、对象键、未接入的资源类型不直接暴露给浏览器。没有自动播放或外部资源请求。
- 主站显示加载、失败重试、空列表、登录与会员限制，保留课程返回路径；更新时间和学习时间按北京时间显示。
- OpenAPI 合同、共享 Zod 解析同步覆盖生产者与消费者。错误不输出数据库细节。

方案两轮复核见 [实施范围](../learning-read-stage186-plan.md)。本次是读取接入，不新增学习进度写入接口，不删除旧表或替换旧网站的运行进程。

## 验证

- 后端权限、主站 Cookie 隔离、Host、游标、私有进度、媒体路径过滤、数值映射等 9 项测试通过；OpenAPI 正反例 1 项通过。
- 共享合同 7 文件、51 项测试通过，含新增学习合同 2 项。
- 服务端类型检查/构建通过，四应用前端类型检查/构建、应用隔离检查通过。WWW 最终构建通过。
- 本地 `verify-learning-read-local.mjs --read-only` 使用 dev_vue 的现有 env，在固定 UUID、UTC、REPEATABLE READ、READ ONLY 连接内执行。
- 真实库读出 12 门课程；12 门登录限制课程在匿名 HTTP 注入下都没有返回媒体/课节；5 条进度均与各自用户匹配。公开/个人响应均通过 OpenAPI Schema 校验。
- 真实校验曾发现 COALESCE(sort_order,0) 返回数值文本，导致接口整数合同不匹配；已在 reader 显式转换小范围排序值，补回归后重新通过。BIGINT 时长仍保持字符串。

## 本地接入配置

Nuxt 的学习域 BFF 仅代理 GET courses 及 courses/:id，不接受任意上游路径。私有运行配置：

- `NUXT_LEARNING_API_BASE`：V4 API 地址，默认 `http://127.0.0.1:3010`。
- `NUXT_LEARNING_WWW_ORIGIN`：与 API 的 WWW_ORIGIN 一致，默认 `http://localhost:3100`。

现有主站 SSO 的 /auth/start、回调和会话接口继续由原有路由/代理承担。配置上述学习读取代理不等同于完整 SSO 已联通。

## 证据边界与下一步

本轮未开网络监听、未启动网站/Redis/Worker/Bridge；数据库探针仅只读，不修改业务数据。HTTP 验证是 Fastify 内存注入，个人读取使用服务层测试用户作用域，不冒充真实 SSO 登录。未做浏览器视觉验收，也未验证外部媒体当前可播放。

下一步在本地完成主站 SSO 与课程页面端到端验收，再补带权限、CSRF、幂等和版本校验的进度写入。全面数据库规范化与其它域消费者切换仍在继续。
