# 量见智桥 MT5 账户切换重新检测与 3.0.4 发布方案

## 1. 文档状态

- 状态：方案完成，修复实施中；构建、上传和部署尚未执行。
- 编制日期：2026-08-19。
- 代码审查与实施基线：`D:\dev_codex\.release-work\bridge-3.0.4-dev-20260819`，临时分支 `release/bridge-3.0.4-dev-20260819`，基于 `origin/dev_codex@483aa217`。
- 当前公网源码基线仅作部署前参考：公网正式阶段在 `dev_codex` 完整验证通过后，将同一已验收提交以 `--ff-only` 推进 `main`；不从 `origin/main` 创建本批发布分支。
- 当前 Bridge 公开版本：`3.0.3`；目标版本：`3.0.4`。
- 发布模式：签名模块更新（modular update），不重建、不替换完整安装器，不推进 `bootstrap`。
- 原始 `dev_codex` 工作区存在与本任务无关的未提交文件：`scripts/push_period_reviews_to_lark.py` 和 `tests/scripts/test_push_period_reviews_to_lark.py`。本批使用独立干净工作树，不得暂存、覆盖或带入这两处改动。

## 2. 目标与非目标

### 2.1 目标

1. MT5 在同一个 `terminal64.exe` 中切换 `login/server` 后，Bridge 不再长期保留旧账户为当前账户。
2. 用户点击“重新检测”时，必须验证每个运行中 MT5 的当前账户身份，不得仅因终端 ID 和路径不变就复用旧绑定。
3. 连续出现 `mt5_login_mismatch` 时，Core 自动调度一次受控身份恢复；手动“重新检测”可以立即走同一恢复通道。
4. 账户变化时原子替换该终端路由，推进 `connection_epoch`，旧 epoch 的数据和命令不得混入新账户。
5. 保持现有 fail-closed 身份保护：重新绑定完成前，任何旧账户路由的交易指令继续被拒绝，不得透传到新账户。
6. 生成、签名、验签并上传不可变的 3.0.4 模块产物到七牛云，先在测试虚拟机和隔离客户端完成 3.0.3 → 3.0.4 真实更新验收，再公网发布。

### 2.2 非目标

- 不改变网站会话、会员、策略、风控、下单和复盘业务合同。
- 不修改服务器账户所有权规则，不自动转移或删除网站交易账户。
- 不自动启动、关闭、重启、登录或切换 MT4/MT5。
- 不删除 Bridge SQLite、历史绑定、持仓、挂单或未决执行记录。
- 不更换 P-256 发布公钥，不引入 Authenticode，不使用仅 URL/SHA-256 的非签名更新通道。
- 3.0.4 本批不更新完整安装器、下载 descriptor 或新安装 `bootstrap`；如后续需要新安装用户直接获得 3.0.4，另开 full-installer 发布批次。

## 3. 已确认现象与根因

### 3.1 现场证据

2026-08-19 本机运行环境为量见智桥 3.0.3。MT5 切换账户后：

- Bridge 运行状态持续出现 `mt5_login_mismatch`，证明 Worker 读取到的 MT5 账户与存储路由不同；
- 点击“重新检测”后，日志记录 `native_mt5_terminal_probe_reused_binding`；
- 同一轮中运行状态仍然是 `ready=0` 且 `terminal_errors=mt5_login_mismatch`。

这证明按钮请求已进入 Core，问题不是 UI 事件丢失，而是强制检测在身份验证前提前复用了旧绑定。

### 3.2 代码根因

`bridge/native/apps/bridge-core/src/main.rs` 中的 `mt5_binding_reusable()` 只校验：

- platform 是 MT5；
- 终端仍在运行；
- `terminal_instance_id` 不变；
- 可执行文件路径不变。

该判断不含当前 `login/server`。强制检测命中时会直接 `accepted.push(...)` 并跳过 Python MT5 探针，SQLite 中的旧 `account_ref` 因此没有被替换。

`bridge/native/workers/mt5/worker.py` 中的 `_ensure_identity()` 正确比较实际 `account_info().login/server` 与路由身份，所以后续请求被 `mt5_login_mismatch` 拒绝。这是应保留的交易安全保护，不是需要放宽的错误。

### 3.3 旧方案的矛盾

`docs/bridge-mt5-redetect-and-3.0.0-package-plan.md` 第二轮现场优化为了避免 MT5 窗口前置，要求同路径运行绑定不再探测。该优化可以避免对“账户未变”的终端做无意义重连，但它错误地把“路径未变”当成“账户未变”。本方案取代该复用判断，但保留前台窗口恢复、结构化错误和失败占位条目。

## 4. 修复设计

### 4.1 统一身份恢复流程

手动重新检测和自动账户漂移恢复复用同一个 Core 生命周期通道：

1. 记录一次性 `mt5 identity refresh requested`，合并重复请求。
2. 取消并等待当前 Profile 的 Transport、数据采集和 MT5 Worker 退出；不关闭 MT5 进程。
3. 完整枚举当前运行的 MT5 路径，并通过精确可执行文件路径调用受控探针。
4. 探针只返回严格的 `terminal_path + broker_server + login`，且必须证明终端已连接。
5. 将探针结果与旧绑定比较：
   - 账户与路径均未变：保留绑定，不增加 epoch；
   - 同一终端路径的 `login/server` 变化：原子替换绑定并推进 epoch；
   - 新终端：新建绑定，不自动改变用户的主终端选择；
   - 探针失败：不覆盖最后一次已验证身份，但不得将其呈现为当前已就绪账户。
6. 使用新绑定重建对应 Worker，完成账户快照后再发布 `ready`。

显式“重新检测”不再允许仅凭路径跳过身份探测。只有探针已返回与旧绑定完全相同的 `account_ref`，才可称为“复用”。

### 4.2 自动恢复边界

- `mt5_login_mismatch` 连续达到有界阈值后，Core 只排队一次身份刷新，不在 Worker 内直接篡改路由。
- 自动失败后进入冷却期，保持 degraded 和 fail-closed，不形成循环探针或 Core 重启风暴。
- 手动重新检测可以越过自动冷却，但同一时刻仍只运行一个探测任务。
- `mt5_account_unavailable` 和短暂 `mt5_terminal_disconnected` 仍按现有阈值恢复，不等同于账户已切换。

### 4.3 数据和交易安全

- 新账户身份未完成原子激活前，不向服务器声称新路由可用。
- 激活新账户时必须调用现有 `activate_terminal_binding()` 的 epoch 和旧同步状态隔离机制，不手工绕过 Store 合同。
- 未决命令和对账任务继续绑定原 `terminal_instance_id + account_ref + connection_epoch`，账户切换后不自动重放。
- 服务器账户所有权、绑定冲突和订阅校验仍由现有服务器规则决定；Bridge 不自动解除旧账户的网站归属。
- 日志只记录 Profile、终端 ID、稳定错误码和“身份是否变化”，不记录余额、持仓、密码、令牌或私钥。

### 4.4 UI 语义

- 探测中：显示“正在确认 MT5 当前账户”，防止重复点击。
- 切换成功：账户列表展示新账户，连接状态必须基于新 Worker 快照，不仅依赖 SQLite 写入成功。
- 探测失败：显示本地化、可操作的原因，如“未登录”“未连接”“探测超时”；旧账户可作为最后已知历史身份保留，但必须标记为不就绪。
- 不向用户直接显示 `mt5_login_mismatch` 等内部错误码。

### 4.5 MT5 窗口副作用

为了读取同路径的新账户，必须使用 MetaTrader5 IPC 进行一次受控初始化。继续保留：

- 探针子进程 `CREATE_NO_WINDOW`；
- 探针前记录当前前台窗口；
- 只在探测的 MT5 实际抢占前台时尝试恢复原窗口；
- 15 秒探针超时、有界 stdout/stderr 和进程清理。

不以“避免窗口短暂前置”为理由再次跳过显式身份验证。

## 5. 代码范围与版本面

### 5.1 预计代码范围

- `bridge/native/apps/bridge-core/src/main.rs`：重新检测、自动漂移恢复、探测结果比较和绑定替换。
- `bridge/native/apps/bridge-core/src/mt5_terminal_discovery.rs`：只在需要时补充探针/前台恢复验证，不扩大为任意进程探测。
- `bridge/native/workers/mt5/worker.py` 及其测试：保留身份 fail-closed；仅当 Core 需要额外的结构化探针契约时才修改。
- `bridge/native/apps/bridge-ui/src/main.rs` 和 `bridge-local-control`：只在需要“检测中/恢复失败”明确状态时修改，不增加服务器业务功能。
- 相应 Rust/Python/Node 契约测试、版本测试和发布元数据。

实施时如需改动此列表之外的服务器交易、账户归属、数据库迁移或前端业务代码，必须停止并重新审查范围。

### 5.2 3.0.4 版本面

正式构建前必须逐项对齐并记录：

| 版本面 | 3.0.4 要求 |
| --- | --- |
| Cargo workspace 与 Native UI/Core/Launcher | `3.0.4`，实际 PE `ProductVersion` 一致 |
| MT5 Worker | `WORKER_VERSION = "3.0.4"` |
| MT4 EA | `#property version "3.04"` |
| MT4 Rust adapter | 公开显示版本对齐 `3.0.4`；若握手兼容常量保持不变，必须明确记录兼容理由并通过合同测试 |
| 模块包 | `core` / `adapter.mt5.python` / `adapter.mt4` 均标识为 `3.0.4` |
| 更新清单 | `release_version = 3.0.4`，内部验收与公网稳定清单使用不同唯一 `release_id` |
| 安装器/download/bootstrap | 本批保持现状，不声称已升级到 3.0.4 |

历史中已出现过名为 3.0.4 的早期 updater acceptance 清单。本次必须使用新 `release_id` 和新的内容寻址对象；不覆盖、删除或复用旧七牛对象。

## 6. 实施、测试与发布门禁

### 阶段 A：独立发布工作树

1. `git fetch origin`，确认 `origin/dev_codex` 为 `483aa217` 基线及其工作树干净度。
2. 在 `dev_codex` 上使用独立临时分支 `release/bridge-3.0.4-dev-<date>` 工作；修复、测试、构建和 VM 验收全部在 dev_codex 线上完成。
3. 不带入未授权的文件或其他业务改动；公网阶段只在 dev_codex 完整验收后将同一提交快进到 `main`。
4. 完成修复后形成窄提交：修复/测试一个提交，3.0.4 版本面和发布元数据一个提交。
5. 每次提交前审查 staged diff，确保只有本方案文件。

### 阶段 B：修复回归测试

必须新增并通过：

1. 同路径、同账户：重新检测确实读取身份，绑定不变，epoch 不增加。
2. 同路径、新 login：旧绑定被原子替换，epoch 推进，账户列表只将新账户标记为当前就绪。
3. 同 login、新 server：按身份变化处理，不仅比较 login。
4. `mt5_login_mismatch` 在阈值内只触发一次自动恢复，失败后不循环重启。
5. 手动重新检测在冷却期仍可执行，重复点击合并。
6. 探针超时、未登录、未连接时，旧身份不被覆盖，UI 不显示为 ready。
7. 旧账户命令在新绑定完成前和 epoch 变化后均被拒绝，不存在跨账户重放。
8. 不同 MT5 路径互不覆盖，一个候选失败不阻塞其他候选。
9. 无任何显式启动、关闭或切换 MT5 账户的调用。

验证命令至少包含：

```powershell
Set-Location D:\dev_codex\.release-work\bridge-3.0.4-dev-20260819\bridge\native
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

Set-Location D:\dev_codex\.release-work\bridge-3.0.4-dev-20260819
python -X utf8 -m unittest discover -s bridge/native/workers/mt5/tests -p "test_*.py"
powershell -File scripts/bridge-native/test-native.ps1 -SkipRelease
powershell -File scripts/bridge-release/test-release.ps1
npx vitest run tests/bridge-release-tool.test.js tests/bridge-release-route.test.js tests/bridge-mt4-ea-contract.test.js tests/bridge-installer-release.test.js
git diff --check
```

生产构建前必须运行仓库 release preflight，要求发布工作树干净、分支已推送且与上游 ahead/behind 均为 0。

### 阶段 C：3.0.4 构建、签名和本地更新演练

1. 使用锁定依赖构建 Python 3.11 x64 MT5 runtime。
2. 对 `build-release.ps1` 先执行 `-DryRun`，再从已推送的干净提交构建正式产物。
3. 使用唯一内部验收 `release_id`，例如 `bridge-3.0.4-vm-<UTC timestamp>`，生成 `rollout_channel=internal`、`rollout_percentage=100`的签名清单。
4. 使用生产 P-256 签名器签名每个模块包和清单，立即用提交的公钥本地验签。
5. 使用 3.0.3 和 3.0.4 两个独立版本目录执行 `prepare-local-update-rehearsal.ps1` 和 `test-local-client-update.ps1`。
6. 本地演练必须证明：包下载和签名验证、旧进程退出、新版激活、Launcher 恢复启动、活动版本为 3.0.4、自定义服务器地址保持、非法包被拒绝。

任一编译、版本面、签名、演练或工作树门禁失败，都停在上传之前。

### 阶段 D：七牛云不可变上传

1. 从授权的项目配置加载七牛凭据，不输出访问密钥或数据库连接信息。
2. 执行 `verify-qiniu-access.ps1`。
3. 先对 `upload-qiniu.ps1` 执行 dry-run，确认 object key 为 `bridge/releases/3.0.4/<sha256>/<module>.zip`。
4. 上传 `core`、`adapter.mt5.python`、`adapter.mt4` 和已签名内部清单；不上传或改写完整安装器对象。
5. 通过 `verify-remote-release.ps1` 从 CDN 重新下载，逐个比对字节数、SHA-256 和签名。
6. 七牛对象只上传、不激活；远程校验通过前不修改任何 current 指针。

### 阶段 E：测试虚拟机和真实客户端验收

1. 记录虚拟机的实际 host、路径、分支、回滚提交、进程和 `/health` 基线；不从本地截图推断远程状态。
2. 使用仓库/Skill 的 VM 部署脚本先 `-DryRun`，再部署与 3.0.4 产物对应的精确发布提交。
3. 验证远程提交、工作树、进程、数据库/Redis `/health` 和有界启动日志；不执行 SQL 或手动迁移。
4. 只在测试 VM 发布 `internal` 签名清单，不修改公网 stable current。
5. 使用隔离测试安装和明确的 `internal` 更新通道，完成真实 3.0.3 → 3.0.4 自动更新。管理员显式设置的 VM HTTP/HTTPS 服务地址必须在更新后保留，不得被官方地址覆盖。

真实功能验收顺序：

1. 安装前确认版本 3.0.3、当前 MT5 终端路径和账户 A；不记录密码、余额或持仓细节。
2. 触发更新，确认进程安全退出和恢复为 3.0.4，MT5 不被关闭或重启。
3. 在同一 MT5 进程中从账户 A 切换到账户 B。
4. 验证自动恢复在有界时间内完成；若尚未恢复，点击一次“重新检测”。
5. Bridge 必须显示账户 B，不再把账户 A 标记为当前就绪；服务器收到的路由必须是账户 B 的 `login/server` 和新 epoch。
6. 运行只读账户快照/诊断请求，确认不再出现 `mt5_login_mismatch`。
7. 未获得额外真实交易授权时，不发送开仓、平仓、修改挂单或其他交易命令。使用路由、快照和 fail-closed 回归完成验收。
8. 连续观察更新日志、Core PID、终端状态和更新健康指标，确认无更新循环、重启风暴、签名错误或新启动异常。

阶段 E 任一点失败，立即停止，不生成或发布公网 stable 指针。

### 阶段 F：公网 stable 清单和源码推进

1. 使用与 VM 已验收完全相同的三个模块字节和 SHA-256，生成新的 `rollout_channel=stable` 签名清单；不重建模块包。
2. stable 清单使用新的生产 `release_id`，先设为小流量比例，建议 10%；重新签名并验签。
3. 将 stable 种子清单、必要的版本 API/路由测试作为独立发布元数据提交；不修改 installer descriptor 和 bootstrap。
4. 获取最新 `origin/main`，仅在它仍可由已验收的 `dev_codex` 发布提交以 `--ff-only` 推进时，才将同一提交推进 `main`；如 `main` 已前进或分叉，停止并重新审查，不使用强推或未审查合并。
5. 推送 Gitee `main` 后，记录精确公网目标提交和回滚提交。

### 阶段 G：公网部署、激活和观察

1. 通过 `deploy-aurum-public` 流程检查公网服务器：必须为 `main`、工作树干净、当前提交是 `origin/main` 祖先，且 BaoTa Node 项目与运行路径符合安全配置。
2. 先运行公网部署 `-DryRun`，再快进源码和正常重启；不运行 SQL、数据库客户端或手动迁移。
3. 验证远程 full commit、进程用户、本机/外部 `/health` 的 `status=ok` / `database=connected` / `redis=connected`、首页与 `/ai` HTTP 200、静态缓存 key 和有界启动日志。
4. 只有服务健康通过后，才通过 `publish-manifest.ps1` 在公网激活 stable 10% current，然后用 `verify-update-endpoint.ps1` 验证签名、版本、渠道、分流选择和不可变 CDN 对象。
5. 使用一个明确命中 stable canary 的测试安装验证 3.0.3 → 3.0.4，并运行 `get-release-health.ps1`。
6. 建议至少观察 30 分钟，门禁为：已选中客户端成功激活 3.0.4，更新失败数为 0，无新签名/下载/激活错误，Core 无重启风暴，账户切换用例仍成功。
7. 门禁通过后，生成并签名相同包字节的 stable 100% 新清单，使用另一个唯一 `release_id`，再次验签、发布和验证。
8. 本批不推进 bootstrap，不改变完整安装器下载地址。

## 7. 验收证据清单

最终发布报告必须分开报告：

- 源码：分支、完整 commit、上游同步状态、实际 diff 范围。
- 测试：Rust format/Clippy/workspace、Python Worker、Node release/route/MT4 合同、本地两版本更新演练。
- 产物：每个模块的本地路径、字节数、SHA-256、签名状态，以及 internal/stable 清单的 release ID。
- 七牛：不可变 URL，重新下载后的字节数和 SHA-256 一致证据。
- VM：部署前后 commit、回滚点、健康、启动日志、实际 3.0.3 → 3.0.4 更新、账户 A → B 识别证据。
- 公网：`main` 和精确 commit、部署前回滚 commit、内外 `/health`、路由/静态资产、stable 10% 和 100% 清单、观察结果。
- 跳过项：任何未执行的真机、交易、安装器或生产验证必须单独列出，不得以单元测试代替。

## 8. 失败处理与回滚

| 失败点 | 处理 |
| --- | --- |
| 修复、测试、版本面或本地更新演练失败 | 停在本地，不上传 |
| 七牛远程字节不一致 | 保留不可变对象供审计，不发布任何 current |
| VM 部署或健康失败 | 停止 internal 激活；需回滚时另行确认并使用记录的 VM 回滚提交 |
| VM 更新或账户切换验收失败 | 不推进 main，不生成/发布 stable current |
| 公网部署健康失败 | 不发布 stable current，保持 3.0.3 更新指针 |
| stable canary 更新异常 | 立即 `stop-rollout.ps1`，调查后再决定恢复或 `rollback-manifest.ps1` |
| 100% 激活后出现高风险回归 | 停止流量并将 current 回退到已验证 3.0.3 清单；不删除 3.0.4 CDN 对象 |

源码回滚、服务器回滚、current 指针回滚和 bootstrap 是独立边界。本方案不授权在失败时自动执行任何破坏性回滚。

## 9. 实施顺序与授权检查点

1. 在 `dev_codex` 修复代码、测试、版本面、提交并推送临时发布分支。
2. 构建、签名并完成本地更新演练。
3. 上传七牛并校验远程字节，不激活公网。
4. 部署测试 VM，只激活 internal 清单，完成真实更新和账户切换验收。
5. VM 验收通过后，准备 stable 清单，并把已在 `dev_codex` 完整验证的同一提交以快进方式推进 Gitee `main`。
6. 部署公网 main，先验证服务健康，再激活 stable 10% canary。
7. 观察通过后扩大到 stable 100%；不改 bootstrap 或完整安装器。

用户本次给出的目标已覆盖修复、制作 3.0.4 更新包、七牛上传、VM 测试和公网发布的总体顺序。真正执行时仍必须在每个环境记录精确目标和基线，且不得因为前一步成功就跳过后一步的干净度、健康和签名门禁。

## 10. 计划审查记录

### 第一次审查：修复正确性与交易安全

结论：初始方案如果只删除 `mt5_binding_reusable()` 提前返回，可以修复手动重新检测，但未完整定义账户未变时的 epoch、自动恢复、探针失败呈现和跨账户未决命令边界。

调整：

- 将“复用”改为必须先获取当前 `account_ref` 后才能判断；
- 增加“身份未变不推进 epoch，身份变化必须推进 epoch”契约；
- 保留 Worker `_ensure_identity()` 的 fail-closed 校验，明确未决命令不跨账户重放；
- 增加有界自动恢复、冷却和手动越过冷却的验收；
- 探针失败时保留历史身份作为审计事实，但不将其呈现为已就绪。

剩余风险：MetaTrader5 IPC 没有“绝对不前置窗口”的官方参数，前台恢复只能缓解短暂抢占；必须由真机验收覆盖。

### 第二次审查：发布隔离与公网风险

结论：直接在当前 `dev_codex` 修复并快进 `main` 会额外带入与 Bridge 无关的复盘修复；将 VM 验收清单直接用作公网清单又会混淆 `internal` 与 `stable` 渠道。

调整：

- 从 `origin/dev_codex@483aa217` 创建独立、干净的 3.0.4 临时发布分支/工作树，排除当前脏文件和未授权变更；公网阶段再将同一已验收提交快进到 `main`；
- 七牛只存储不可变包，VM 和公网用不同 release ID/渠道的签名清单，但必须引用完全相同的模块字节和 SHA-256；
- 公网先部署并验证健康，再激活 stable current，不把部署成功当成更新激活成功；
- 公网正式更新增加 10% canary 和至少 30 分钟观察，通过后再生成 stable 100% 清单；
- 保持 installer、bootstrap、源码部署和 current 激活为独立边界。

剩余风险：本方案不更新完整安装器，所以在下一个 full-installer 批次之前，新安装用户仍可能先安装当前 installer 版本，再通过签名模块更新到 3.0.4。这不影响 3.0.3 存量客户端的自动更新，但应在发布报告中明确标记。
