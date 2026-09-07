# 阶段 188：学习进度保存与当前库无损升级

## 交付结果

主站课程页新增手动“标记已学完 / 取消完成标记”。后端、HTTP 合同、Nuxt 代理和页面均已接通；仅修改 completed、revision、updated_at_utc，保留原观看时长、报告时长、考试状态、迁移来源及源摘要。没有播放器采样时，不生成观看时间。

当前 dev_vue 已由 62 步升级至 64 步，增加 learning_progress_changes 审计兼幂等表。除升级日志外，210 张原有表、271,337 行的逐列摘要、结构和自增值升级前后完全一致。12 门课程和 5 条进度经新版本校验入口复核通过，29 个旧学习时间继续按 UTC 原值保留。当前开发库没有新增或修改实际个人学习进度。

## 数据库实现与真实证据

- 023 新建审计表，用户/请求唯一、用户/课节/结果版本唯一；外键、版本递增、完成状态、UUID 和摘要约束保证记录范围。
- MySQL 会在 CHAR(36) 的 CHECK 之前裁剪请求键尾部换行。恢复副本测试发现此行为后，没有修改已执行的 023，而是追加 024 将请求键改为 VARCHAR(64)，保留异常输入供原严格 CHECK 拒绝。
- 同用户按用户→课程→课节→权益→请求回执/进度锁序串行化。版本精确到 unsigned BIGINT 文本，首次创建以 expected_revision=0 表示；更新与审计同事务提交。
- 相同请求返回原回执；不同正文复用请求键和过期版本返回 409。重放重新检查有效用户、发布状态和会员权限。提交确认丢失销毁连接并返回 learning_commit_unknown，原请求键可确认真实结果；审计失败回滚进度。
- 本地真实 MySQL 测试验证了首次创建只有一个胜者、已有进度并发单胜者、会员过期及课程下架后拒绝重放、大整数不丢精度、超时长不截断、真实 COMMIT 后注入响应丢失及审计失败回滚。
- 新增两步使用同一数据库升级锁、checksum、结构指纹和 journal。恢复副本分别在两条 DDL 后注入中断，均经 reconcile 恢复；重复执行没有再次执行 DDL。
- 恢复副本四张学习表的 source_sha256 CHECK 仅存在 `_ascii` 与 `_utf8mb4` ASCII 正则字面量表示差异。适配限定该恢复库及四组精确原始/目标 hash，再验证只替换该片段能还原指纹；其它变动仍拒绝，当前 dev_vue 完全保持原严格检查。
- 临时权限在每次演练后恢复到原 SHOW GRANTS 摘要；演练仅处理恢复副本固定测试记录，清理后还原空表、自增值和临时会员值。虚拟机只提供数据库与必要的数据库权限操作。

机器回执：[事务和约束](dev-vue-learning-completion-probe-20260907.json)、[首次创建与权限](dev-vue-learning-completion-access-probe-20260908.json)、[DDL 中断恢复](dev-vue-learning-completion-upgrade-rehearsal-20260907.json)、[当前库升级](dev-vue-learning-completion-upgrade-20260908.json)。

## 接口、前端与兼容

`PUT /api/v4/learning/courses/:courseId/lessons/:lessonId/completion` 要求 WWW 会话、精确 Host、Origin、CSRF、UUID Idempotency-Key、completed 布尔值和 expected_revision 文本。拒绝附加用户 ID、观看时长、考试状态和查询参数。身份来自服务端，会话退出后写入被拒绝。

详情增加 viewer_user_id 和进度 revision。保存前刷新会话并比对页面用户；不匹配则清空旧快照并重新读取，不把原用户页面的操作应用到另一个账号。版本冲突必须先刷新；不自动用新版本覆盖。响应未知时保留同一个请求键和原正文，手动“确认保存结果”；课程切换、账号变化或组件销毁后的晚返回不更新新页面。

成功保存后读取权威快照，常规刷新保留课节 DOM；保存中使用 aria-disabled/aria-busy 与函数内重复操作保护，避免原生 disabled 使键盘焦点丢失。课节操作高度至少 44px，状态用文字和 aria-live 表达；时间显示北京时间。

旧客户端可以忽略新增读取字段；新前端需要新后端的 viewer_user_id/revision，部署顺序应先后端再前端。旧 62 步迁移工具和 SQL 保留历史语义，不修改旧冻结清单。64 步后的学习迁移审计使用下方 V2 入口：先验证完整 64 步，再对未变化的原导入结构使用原 62 步身份摘要；底层拒绝 DML/DDL，不能用它重新覆盖已有业务记录。已有业务写入后，原导入快照可能报告目标变化，应关联新审计记录解释，不能重跑旧回填覆盖。

```powershell
node scripts/upgrade-learning-completion-local.mjs --check <绝对路径回执.json>
node scripts/upgrade-learning-completion-local.mjs --apply <绝对路径回执.json>
node scripts/verify-learning-import-v2-local.mjs --verify <课程清单.json> <进度清单.json> <证据.json>
node scripts/verify-learning-read-local.mjs --read-only
```

前两条完整检查 64 步；首次 --apply 要求原 62 步齐全及冻结的真实恢复演练回执，重复运行不重做 DDL。旧 upgrade-dev-vue-schema.mjs 是 62 步基础升级入口，64 步数据库应使用上述当前入口，旧入口遇到新增历史会失败关闭。

## 验证范围

- 后端、读取与 HTTP 合同、升级版本适配共 36 项定向测试通过；原学习核心 schema 的 2 项回归另行通过。
- WWW 9 项测试通过，覆盖未知结果重试保留原请求、多页面版本冲突、跨用户旧快照、课程切换晚返回、组件销毁和重复激活。共享合同 51 项通过。
- 服务端类型/构建、四应用前端类型/构建及应用隔离检查通过；最后焦点修复后的 WWW 测试与生产构建重新通过。
- 当前 dev_vue 的只读 API 探针读出 12 门课程、匿名 12 门受限课程均无内容泄露、5 条个人进度匹配；新 V2 迁移校验 courses/progress 均 verified，数据库写入 0。
- Chrome 使用真实 Nuxt 生产构建和本地验收上游检查桌面、768×1024 平板、390×844 手机。无横向溢出；手机操作按钮高度 44px。先保存，再注入“已提交但响应丢失”，再次确认时共 3 个 PUT 只产生 2 条验收回执。最终键盘 Enter 保存后焦点仍在同一“取消完成标记”按钮。
- 浏览器上游、会话和数据是本地验收替身；SSO HTTP 使用真实 AuthService 但测试身份持久层。真实 MySQL repository 是独立恢复副本验证。不能合并这些证据声称真实账号/Redis/浏览器整链路已经通过。

本地验收监听、控制台、浏览器标签及临时验收脚本已清理。没有启动完整 API/Redis/Worker/Bridge，也没有部署公网。下一步是当前开发环境的真实登录联调，以及按迁移矩阵继续其它域的规范化与消费者接入；本阶段不代表全站架构重构完成。
