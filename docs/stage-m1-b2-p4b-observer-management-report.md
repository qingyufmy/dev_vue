# M1 / B2 / P4B：观摩管理与授权写入

> 2026-09-05；基线 `9969fe20`。用户已确认继续。状态：源码与离线验收完成；未执行真实依赖、迁移、部署及终端操作。管理页面视觉实现不在本批。

## 实施前两轮复审

第一轮（职责与需求）：使用独立 admin-web 会话和 admin 子域，不复用 trade-web Cookie。源、频道、默认项和授权独立用例，不提供通用表写接口或删除历史。新源操作者固定当前管理员，既有源操作者不可通过请求改写；绑定必须通过该操作者的真实 owner/区间/版本证明。非 owner 发布仍为 P5。管理配置不影响本人订阅，Pro 无桥接订阅仍为后续订阅 B2。

第二轮（安全与并发）：管理员身份事务内重验；全部管理写入先锁单个 registry 行，串行化低频配置及默认切换，再锁有关实体，不写 trading_contexts，避免与 P4A context→授权锁反序。独立 operation receipt 保存 actor/key/hash、结果和审计元数据，与业务修改、revision、outbox 同事务；重放不重复写，异参同 key 冲突。仅追加 022，旧 SQL 与冻结映射不动。真实锁计划和并发性能仍需 MySQL 验收，离线不能证明无死锁。

## 冻结实施合同

- `/api/v4/admin/observer`：GET sources/channels/channel accesses/operations 为有界游标列表；POST sources/channels 创建；PUT source/channel 全量配置更新；PUT channel access 授予或撤销；PUT default-channel 切换或清空默认项。
- 浏览器写入需 admin 会话、精确 admin Host、CSRF、Idempotency-Key 和更新的 expected_revision。拒绝未知字段，不能传 operator_user_id/created_by/source_trading_account_id。
- source 创建默认 disabled/pending；启用须有效账户/操作者及可选 analysis 策略。频道 active 须 source active/ready；新频道默认 assigned/inactive。默认项不能指向不可用频道；禁用默认频道清除默认项。source 换账户须同事务更新所有引用频道的兼容账户投影及版本。
- access 撤销仅撤销显式 grant，不等于禁止受众 all/会员规则已授予的查看权；管理响应/文档须说明。缺记录以 expected_revision=0 创建（含撤销 tombstone），恢复增加 revision，不删除历史审计。
- outbox `observer.authorization.changed` 只携 source_id/channel_id/user_id（nullable 定位维度）与 registry_revision。独立 dispatcher 发布到内部 Redis 控制频道；网关按已授权 source/channel/user 清除匹配观摩订阅并发 resync/close，控制 payload 不转发浏览器。失效投递失败继续 outbox 重试；P4A 最长 30 秒授权仍兜底，不承诺零延迟。
- 主动退出不依赖频道仍有效或本人账户在线；无账户退出只表示无终端目标，不停订阅、不自动入观摩。补 HTTP/前端晚返回防串号回归，不进行视觉改版。

## 验证记录

| 验证 | 本地结果 |
| --- | --- |
| `pnpm exec vitest run server/tests` | 54 files / 392 tests 通过 |
| 迁移/备份/字段/观摩合同相关测试 | 23 files / 183 tests 通过 |
| `pnpm run test:frontend` | 30 files / 136 tests 通过；其中 trade 18 / 74 |
| 服务端与全前端类型检查 | 通过 |
| 服务端与全前端构建、前端模块边界 | 通过 |
| 迁移文件计划 | 23 文件 / 157 语句；022 三条语句，未执行 |
| 保护产物 | 相对 `9969fe20`，旧 SQL/bootstrap/correction 与两份冻结 identity JSON 共 25 个逐字节不变 |
| OpenAPI 本地引用与 operation ID | 1125 个本地引用有效、83 个 operation ID 唯一 |
| `git diff --check` | 通过 |

核查要点：source/channel/access CAS 冲突、幂等异参拒绝、已撤销管理员禁止 receipt 重放、outbox 失败整体回滚、默认频道切换及 source 禁用清理、source operator 不可变、source 账户更换联动频道投影、分页上限与数字 ID 游标、实体/registry revision 溢出回滚。管理员 DTO 显式白名单，成功操作审计保留规范化 command，不返回幂等键/hash；没有额外承诺所有失败请求形成持久业务审计。

实时核查覆盖控制频道与浏览器事件隔离、无 SQL 的发布路径、无关 owner 订阅不受影响、重复/乱序失效、初次鉴权和在途投递竞态。默认频道切换使用全空维度，保守失效全部观摩订阅，避免遗漏旧默认频道。前端回归验证退出无本人账户、无账户不自动进入观摩、切换开始清空旧终端状态、旧响应不覆盖新切换；没有修改个人订阅。

构建存在 Nuxt 依赖的 `DEP0155` 提示，构建退出码为 0；未通过升级依赖顺带扩大范围。

## 剩余边界与下一确认门

- 本批不是管理后台可视化页面验收，亦未用浏览器/真实账号验证管理操作。HTTP/source/config/receipt/outbox 的 MySQL 查询和锁行为由离线 SQL double 验证，不能证明真实 MySQL 无死锁。
- Redis Pub/Sub 发布成功不代表所有网关接收；outbox 投递重试、授权短期 TTL 和重新鉴权共同兜底，不承诺即时零延迟吊销。
- operations 列表目前按稳定 UUID 游标遍历，不代表最新时间倒序；后续管理 UI 需按使用需求单独设计时间游标，不能将当前分页解释为按时间排序。
- 显式 grant 撤销不是 audience deny；all/会员受众仍可能有查看权。未增加隐式黑名单。
- 022 只新建 registry/operations 并种入唯一协调行，不生成观摩授权、不修改旧用户/账户数据。真实迁移仍需独立授权和恢复验收；不执行逆向删表来回滚。
- P5：补真实设备档案登记、非 owner 观摩源的只读发布能力与撤销边界，先源码/离线验收；后续 B3 再做历史证据适配及回填。开始前单独确认，不触碰真实终端。
- Pro 无本人 Bridge 的分析订阅全链路仍为后续策略/订阅 B2，当前没有移除账户调度依赖，不得标成完成。
