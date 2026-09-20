# 安装实例授权后端实现与迁移边界

实现范围：V4 安装授权请求、浏览器确认/拒绝、私有凭据轮询、安装身份额度读取、独立档案凭据登记、安装撤销。2026-09-14 经用户单独授权，已完成独立参考库验证；没有迁移既有业务库、启动服务或发布。

## 协议与所有权

合同源为 `contracts/http/domains/bridge.json`，7 个新 operation 登记到 `contracts/http/runtime.json`。成功响应统一 HTTP 200 和 `{data,meta}`；浏览器确认读/写使用 trade 当前会话，写操作校验 CSRF、Idempotency-Key、expected_revision、current_user_id。网页显示当前主体；提交时主体变化返回 409。

客户端预生成高熵 poll secret (`bip_`)、安装 token (`bi4_`) 和各档案 refresh token (`br4_`)，发起前持久化到 DPAPI CurrentUser。请求创建只提交 SHA-256 小写十六进制哈希。轮询需要客户端的两个秘密，网页只能读取请求展示字段；服务端不保存或回传长期明文秘密。原生端点拒绝 Origin 请求，不能把浏览器会话作为原生凭据。

请求有效期 10 分钟、持久轮询间隔 5 秒，过快返回 429 / Retry-After。创建按服务器解析的 IP 哈希数据库行串行化，每 10 分钟最多 10 个新请求；部署必须保持可信反向代理边界，不能接受任意外部伪造转发 IP。

安装凭据直到撤销有效，沿用当前 V4 持久凭据语义。10 分钟只限制待审批请求：pending 到期返回 expired；已 approved 的请求在校验私有秘密及安装仍有效后继续返回 approved，即使客户端重启后才轮询。revoked 始终保持 revoked，denied 保持 denied。长期授权结果由服务端一致表达，不要求客户端调用 status 猜测或补偿。

安装注册不占连接额度。status 复用 ConnectionCapacityService 的跨电脑用户 MySQL grants + Redis lease 快照；依赖失败返回错误，不返回零占用。新档案产生单独 refresh 行、profile ID 和凭据，真实连接仍经过已有账户绑定及 lease。此接口没有新增观摩源配额规则。

## 两轮复核与调整

第一轮检查主体和权限：保留旧配对与旧档案语义；安装 token 不能兑换任意既有档案；只登记服务端随机新 profile ID。拒绝授权不要求会员资格。浏览器不能获取私有轮询凭据。安装撤销后可用同安装标识重新授权，旧档案保持撤销；活动安装身份通过数据库唯一生成列防止跨用户并发抢占。

第二轮检查事务与异常：决策在用户/请求锁下做 revision 和同幂等键正文复核；安装与批准结果同事务；档案登记在用户/安装锁下校验父授权及同请求哈希；撤销同事务标记安装、请求和全部子凭据。profile 换会话票据、网关绑定和持续 route 校验追加父授权有效条件。SQL/提交异常不返回存储细节；提交确认丢失返回 commit_unknown，只能按原请求凭据核对。全设备撤销同步覆盖新安装授权。

## 迁移登记与参考库证明

- 空库追加源：`server/db/migrations/20260914_028_bridge_installation_authorizations.sql`，由现有序号加载器自动纳入。
- 就地追加源：`server/db/migrations/inplace/080_bridge_installation_authorizations.sql`，与 028 字节一致，`scripts/lib/bridge-installation-upgrade-source.mjs` 只登记来源及校验和；`bridge-installation-upgrade.mjs` 额外校验真实参考证明后组合 271 步计划。
- 旧 referral/macro/subscription 引用记录校验改为严格冻结前缀。拒绝历史删除、变更、重排或重复；追加 SQL 触及旧阶段保护表仍拒绝。旧记录不证明新迁移，未改写旧参考证据。

真实证明：`docs/architecture/bridge-installation-reference-v1-20260914.json`。源库 `dev_vue` 使用独立只读会话读取结构和升级历史；DDL/DML 仅在三份随机命名参考库内执行，完成后均删除。未复制真实用户数据。

已验证 315 → 318 表、267 → 271 步；四条 DDL 逐条注入确认丢失后恢复、完成后零 DDL 重跑；原 267 个 checksum 不变。空库路径使用既有 011 修正链，新增三表完整哈希及 refresh 新增列、索引和外键与就地路径一致。旧历史源与证明未修改。

真实仓库事务验证覆盖重复请求恢复、批准后延迟轮询、拒绝与过期、双审批及跨用户安装竞争、并发档案登记、独立凭据、登记/撤销竞争，以及创建/批准/登记/撤销四次真实 commit 后丢确认恢复。原库结构、升级记录前后相同；没有对原业务行做全量指纹比对，不将“只读连接无写入”扩展为数据迁移对账证据。

Bridge、Trading、Execution 三份 schema readiness 已从真实证明重新生成；API/Gateway 启动前新增 Bridge 门禁。12 项门禁异常回归属于 Fake 测试，未在现有服务执行启动。

后续用户授权下已完成既有业务库备份、独立恢复、080 迁移及本地服务重启。实际运行发现默认排序规则差异，新增不可变纠正 SQL 和专用日志层；实际 journal 为 272 条，原 271 条 checksum 保留，三个 readiness 同步要求纠正记录完成。314 张旧业务表全量原始列摘要与备份一致，重跑无 DDL。详见 `bridge-installation-current-migration-20260914.md`，参考库早期证明保持原样。

仍待运行验收：真实软件授权后的 Redis 全局额度、SSO/DPAPI/HTTP/WS/终端连通与存量路由撤销。当前本地健康及 HTTP 拒绝路径通过，不等于这些链路已通过。
