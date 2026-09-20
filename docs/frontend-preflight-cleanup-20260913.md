# 前端开工前目录清理清单

日期：2026-09-13。范围：`D:\dev_codex\dev_vue`。

## 当前结果

用户已手动删除清单内十个目录，2026-09-13 本会话逐项核实全部不存在。本清单范围的清理已完成。四应用目录、共享 UI、V4 源码、环境配置、迁移、依赖及 Nuxt 声明目录仍存在；`node frontend/scripts/verify-boundaries.mjs` 通过。这是目录存在性与基础应用隔离检查，不是全量源码完整性、构建或浏览器验收。

此前完成目录、Git 状态、代码引用及项目进程检查后，自动删除命令曾被工具审批策略拒绝，返回 `blocked by policy`。用户随后自行完成删除；下方保留过程记录。

检查时工作区有 2224 条已修改/未跟踪/删除记录。清单内目标均无 Git 跟踪文件，已验证解析后的绝对路径位于本项目内，目标及其子目录未发现 reparse point。进程查询未发现命令行包含 dev_vue 的 Node/.NET/AURUM/量见进程；这不代表全机器服务审计。

## 已核实的删除清单

| 项目内相对路径 | 文件数 | 字节数 | 原因 |
| --- | ---: | ---: | --- |
| `.tmp` | 0 | 0 | 旧演练留下的空目录 |
| `bridge/.test-artifacts/legacy-frontend-tests-stage9-20260903` | 44 | 596101 | 已退出测试入口的旧前端测试临时副本 |
| `bridge/.test-artifacts/legacy-public-stage9-20260903` | 147 | 10392590 | 已退出应用的旧 public 临时副本；旧功能参考仓库仍为 wall-street-skill-local |
| `bridge/.test-artifacts/shadcn-cli-smoke` | 5249 | 103316520 | CLI 冒烟测试工作目录与安装产物 |
| `bridge/.test-artifacts/v3-v4-two-hop` | 1841 | 102160666 | 升级演练安装副本，可由现有演练脚本重建 |
| `frontend/apps/admin/dist` | 14 | 690151 | 可重建的前端构建输出 |
| `frontend/apps/auth/dist` | 3 | 448668 | 可重建的前端构建输出 |
| `frontend/apps/trade/dist` | 57 | 1371365 | 可重建的前端构建输出 |
| `frontend/apps/www/.output` | 194 | 5709466 | 可重建的 Nuxt 构建输出 |
| `server/dist-v4` | 1464 | 6180493 | 可重建的 V4 编译输出；删除后启动前必须重新构建 |

旧前端副本此前在 `docs/frontend-stage9-foundation-report.md` 第 31 行记录为临时恢复副本。真正删除后，应在本记录更新结果，原阶段报告作为历史记录保留。

## 本次保留及原因

- `frontend/` 源码、共享包、设计令牌、contracts 与现有 V4 服务端：当前开发成果，不能按未提交或创建日期判断为垃圾。
- `server/routes`、旧 JS 服务端、`bridge/native` 及相关测试：现有根测试仍直接引用，旧版本升级/核对仍有依赖。整批删除会涉及代码、测试及升级能力退役，不能作为无引用文件直接清掉。项目 AGENTS 第 11 节的旧版清理门尚未满足。
- `server/db/migrations`、`server/migrations.js`、迁移映射/回填/对账脚本及数据库验证报告：永久升级历史或现有数据证据。
- `.env`、上传目录、用户数据、项目外受控备份：属于运行配置或用户资产。
- `node_modules`：当前工作区开发依赖；`frontend/apps/www/.nuxt`：现有类型检查依赖的生成声明，本次不制造额外缺失。
- `bridge/.test-artifacts/prerequisites`：离线安装先决条件文件，不等同于已确认可重建的测试垃圾。
- `.review`、`.impeccable`、`docs`：含审查证据、工具配置、历史决策。虽有旧页面内容，尚未逐项完成引用和替代性核实，不批量删除。

## 定向复核

第一轮：确认仅清理已退出前端的临时副本、空目录和可重建产物，不扩大成后端/Bridge 退役。

第二轮：确认目标边界、链接、Git 跟踪和进程占用；保留迁移、用户数据、未提交源码及审查证据。删除被拒绝，因此尚未进行删除后的文件存在性、Git 差异和前端边界验证。

## 下一步

清单内目录已由用户删除并核实，可以进入前端实现。后端及应用构建输出已清除，启动前按所需应用重新构建。其余旧后端、Bridge、迁移、备份和根目录保留项仍按各自依赖及清理门处理。

## 用户要求重试与根目录检查

同日用户明确要求重试，并扩展检查到 `D:\dev_codex`。原删除命令再次被自动审批策略以 `blocked by policy` 拒绝，随后逐项确认上述十个目录全部仍存在。

根目录本次未找到可以直接判为无用的整个文件夹：

- `wall-street-skill-local`、`dev_vue`、`aurum-production-f6c304` 都是已登记 Git worktree；最后一个为 detached HEAD `f6c304bac32d2f84801b5ff97911133f2f2631b9`，不是普通临时目录。
- `aurum-local-backtest` 有源码、测试、研究和数据；`aurum-backtest-archive` 含 reset-20260911 归档。
- 四个 `.backup-*` 目录含加密备份和基线证据；`_private-recovery` 含 MySQL 恢复目录；`_private-observations` 含时钟观察证据。
- `.local-runtime/dev-vue` 含启动脚本、环境配置、测试身份及运行日志，不能整目录当缓存删除。
- `.tools/mysql-8.4.8-download` 实际含 mysql/mysqldump 工具，`docs/architecture/local-mysql-client-provision-20260908.json` 明确记录其使用路径，不是仅凭名字可删除的下载残留。
- `.codex-remote-attachments` 含两张用户图片；`.codex`、`.impeccable` 属工具配置目录，未授权将有效配置作为垃圾删除。

本次仅做只读检查与更新清单，没有删除根目录项目、备份、工具或附件。
