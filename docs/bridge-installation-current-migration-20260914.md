# Bridge 安装授权业务库升级与本地联调

用户“继续吧”授权本轮业务库备份、080 迁移及本地 API/Bridge gateway 重启。目标固定为 MySQL `ac423207-6ef3-11f1-b302-000c29fda104` 上的 `dev_vue`，不涉及公网发布或真实交易。

## 备份

20260914-02 加密备份已通过独立恢复：315 表、342155 行，原库前后完整数据摘要相同；恢复后列元数据、语义 DDL、逐行摘要及重新导出 SQL 全部一致。归档在 `D:\dev_codex\.local-runtime\bridge-backup-20260914-02`，恢复库 `dev_vue_m1_source_20260914_02` 保留。私钥目录独立保护，明文 SQL 和临时 MySQL 配置已由工具清除。

首次备份 01 在 SQL 预检阶段遇到既有 `period_review_workflows_v4` 的 JSON_UNQUOTE/JSON_EXTRACT 表约束，未创建恢复库。追加 V3 检查器仅放行这两个纯函数，V1/V2 保持字节不变，144 项测试通过。第二次备份使用 V3 完整恢复通过。

## 080 默认排序规则纠正

080 第一个 CREATE TABLE 没有指定表默认字符集/排序规则。原参考库使用 unicode_ci，业务库使用 general_ci。因此第一条 DDL 已成功，但精确 postcondition 阻止继续；当时为 268 条日志（原 267 completed + 080_01 started），316 张表，仅新增一张空的限流表。

第一轮复审（需求、范围）：保持 080、028、原参考 proof 和所有原 checksum 不变；不改数据库默认值、不删表、不改业务行。新增 `corrections/080-bridge-installation-request-limits-collation.sql` 仅对新空表执行 DEFAULT 字符集/排序规则纠正，ASCII 列定义保持不变。

第二轮复审（数据、并发、恢复）：同连接持有升级锁，确认无其他业务客户端；校验备份加密文件 SHA256、原 314 张业务表原始列摘要和原 267 条日志。确认第一步 started、新表为空、全库唯一差异就是新表默认排序规则，才写入固定 checksum 的独立 correction started 记录并执行 ALTER。DDL 丢确认时按冻结 before/after hash 恢复。只有该 correction 已完成且 checksum 正确，才能在原 271 步协调器的 history 视图中剥离这一条；其它未知行仍拒绝。最终实际日志为 272，全部原 271 条 checksum 保留，最终仍为 318 张表。

真实纠正参考验证已通过，见 `architecture/bridge-installation-collation-reference-v1-20260914.json`：复现 general_ci 默认、ALTER 到 canonical hash、ASCII 列不变、模拟 DDL 确认丢失后重读恢复且不重复 DDL。该参考库已删除，验证期间业务库结构和日志未改。

## 当前验收状态

业务库纠正及剩余迁移已完成：原尝试执行 1 次 CREATE，恢复执行 1 次纠正 ALTER 和余下 3 次 DDL；272 条日志全部 completed，318 张表，全库结构 hash 为 `42abfbe0b38e90e9ff546550bad3649610b11ec4ec74f6fc993233dda4f17503`。314 张原业务表按原列顺序/主键顺序的逐行摘要与备份一致，原 267 条日志及全部原计划 checksum 保留，新表为空、旧会话两列为 NULL。独立进程完整重跑通过，纠正 DDL 和原 DDL 均为 0。

实际证明：`architecture/bridge-installation-current-v1-20260914.json`、`architecture/bridge-installation-current-replay-v1-20260914.json`。失败尝试保留在 `.local-runtime/bridge-installation-current-20260914-01.json`；首次失败备份 01 的冗余密文及密钥已删除，失败报告和元数据保留，成功备份 02 及其独立恢复库保留。

API 3010 和 Bridge gateway 3012 已通过可见 PowerShell 控制台启动；均通过新 272 条启动门禁及真实 MySQL/Redis 依赖检查，live/ready 全部 200。启动前 Redis 三个桥接队列均无待处理任务，活动桥接 lease 为 0；启动后 gateway connections 仍为 0，没有发送真实终端命令。

联调发现本地软件 `api_base=3010` 直连内部服务会被精确 trade Host 门禁拒绝（421）。已修正开发 example 及 review 产物为 `api_base=web_base=http://localhost:4174`，经现有 Vite 代理保持 trade Host 后到达内部 3010；gateway 仍为 3012。保留服务器 Host 门禁。配置通过实际客户端校验器；真实入口验证非法 native body=400、native Origin=403、确认页无会话=401，均 no-store。证据：`architecture/bridge-installation-local-runtime-20260914.json`。

浏览器原有 `http://localhost:4174/bridge` 页面已刷新，新“一次授权”引导正常显示。健康检查和拒绝请求证明不等于已经完成软件授权、额度读取或终端连接。

用户确认关闭旧窗口后，已核对旧进程退出，并启动 `bridge/prototypes/net48-win7/artifacts-review/LiangjianBridge.exe`。新进程仍在运行，API/gateway ready 均为 200；gateway connections 为 0。真实网页授权和 MT4/MT5 接入仍需用户操作后验收。

源码验证：SQL 检查器 V1/V2/V3 共 144 项、纠正 loader 5 项及原 loader 2 项、readiness 16 项通过；服务端类型检查、构建、生成一致性通过。当前工作区大量跨阶段未提交改动及依赖链仍无法安全拆分，本轮未混合提交/推送。

清理例外：空目录 `C:\Users\Administrator\.codex\bridge-backup-key-20260914-01` 的删除被自动审批策略拒绝（未提供具体原因），未重试或绕过；其中首次失败备份的密钥文件此前已成功删除。

用户随后确认手动删除该空目录，本地核对已不存在。

账号按钮跟进：MainForm 在本地授权已 approved 时隐藏“连接账号”，用户及额度继续显示；短暂网络错误保持隐藏，明确失效或退出后恢复显示。已随下面的列表改动更新 review 程序并重新启动，保留安装授权和档案数据。

列表交互跟进：移除顶部新增/编辑/连接/断开/删除按钮；右键档案提供编辑、连接、断开、删除（含重试移除），右键空白处提供新增。右键先选择命中的行，菜单打开时暂停列表刷新以固定操作目标；原操作保护和删除确认保留。支持 Shift+F10 菜单、F1 权限详情、Esc 关闭提示。终端列改为状态列，合并在线状态和交易权限摘要，悬停显示详细权限；服务器连接列保留。

权限仅供展示：在既有 account.snapshot 精确账户校验后更新连接专属缓存，25 秒过期，断线、读取失败、缺项与过期显示未知；不添加查询或修改 hello/执行门禁。MT4 使用适配器当前提供的综合许可；MT5 包含账户交易、账户自动交易、终端开关及外部 Python API，最后一项只在源属性确实为 bool 时提供。Core 严格编译及账户/权限定向行为测试通过，worker 74 项通过；Core、WinForms 编译、diff 检查通过。桌面视觉与真实终端权限变化尚未进行人工验收。

本次检测旧进程退出后，已将编译后的 EXE、Core DLL、worker.py 更新至 artifacts-review，并核对 SHA256 后重新启动。旧三份文件保留于 `.local-runtime/bridge-ui-before-context-menu-20260914`，构建产物保留于 `.local-runtime/bridge-ui-update-20260914`。

另一个权限测试临时目录 `C:\Users\Administrator\AppData\Local\Temp\bridge-permission-90a5295318104efc89af48457232dd45` 清理被自动策略拒绝，未提供具体原因；已保留，未重试或绕过。

### 2026-09-14 本地网关连接配置错误修复

- 根因：档案使用 ws://localhost:3012/bridge/v4/ws，连接工厂、RFC6455 传输和握手仍仅接受 wss，触发 bridge_channel_configuration_invalid。
- 三处统一使用 WebSocketEndpointPolicy：wss 保持 TLS 1.2 与系统证书校验；ws 只允许 localhost 或数字回环地址，连接时固定数字回环 IP，不经 DNS；拒绝相对地址、用户信息、fragment 和远程明文地址。
- 定向回归通过：localhost、127.0.0.1、IPv6 ::1 完整握手、Bearer 转发、客户端掩码帧及服务端消息；不安全地址在请求令牌/联网前被拒绝；既有会话令牌测试通过。
- Core 与桌面程序 .NET 4.8 x86 严格编译通过，产物位于 D:dev_codex.local-runtimeridge-loopback-fix-20260914。
- 当前旧版桌面进程仍在运行，尚未替换已加载文件；待用户关闭桥接后更新。不把模拟网关验证视为真实终端连接成功。未发送交易指令。

### 本地应用更新与 MT4 离线排查

- 用户授权关闭旧程序并启动新版；已替换 review 目录 Core/EXE，两文件 SHA-256 与 loopback 修复产物一致，新进程 PID 47532 正常响应。旧文件备份：D:dev_codex.local-runtimeridge-before-loopback-fix-20260914。
- MT4 进程 50784 正在运行，终端日志记录券商登录成功。档案 terminal_instance_id 与当前 MT4 数据目录计算结果一致。
- 09:09 日志加载两份 LiangjianBridgeV4MT4（XAUUSD/M5、XAUUSD.s/H1）。该旧子目录 EA 已不存在；10:02 安装的新版位于 MQL4ExpertsBridgeV4MT4.ex4，哈希与当前 Bridge 分发文件一致；日志尚无新版重新加载记录。
- 已请用户移除两份旧 EA，并只在一张图表挂载根目录新版。当前工具不支持原生 MT4 窗口操作，未改图表、交易设置或发送交易指令。实际终端重新上线仍待该步骤验证。

### WebSocket 长度编码溢出修复

- 用户重载 EA 后报告终端在线、权限未知、最近错误为算术溢出。
- 用正在运行的 Core DLL 编码 256 字节消息，稳定复现 OverflowException，堆栈定位 WebSocketFrameCodec.WriteLength。
- /checked+ 编译下，16 位长度的低字节直接强转、64 位长度分字节时未掩码均会溢出。仅在每字节编码处补 & 0xff，保留整体溢出检查与最大消息限制。
- 验证 0/125/126/255/256/1024/65535/65536/1048576 字节的长度解码、掩码和完整载荷；超限拒绝、localhost/IPv4/IPv6 模拟网关往返、会话令牌回归通过。
- 已替换 Core 并重启桌面，PID 37056 正常响应；备份及新产物位于 D:dev_codex.local-runtimeridge-overflow-fix-20260914。实际权限显示是否恢复仍待界面反馈，不将编码回归等同真实账户验收。

### 重启后 MT4 不重连与右键菜单修复

- 用户确认重载 EA 后终端在线，但桥接重启后适配器数量归零。根因代码：EA 的 B4PipeHasData 无数据分支无限等待，未建立连接存活期限，无法从残留管道主动恢复。
- 复用已有 Ping/Pong 协议：Host 每 3 秒并行检查各终端，单终端与查询/命令共用 queryLock，忙时跳过；5 秒未应答关闭失效管道并移除对应会话。超时回调与完成状态同步，避免迟到回调关闭后续操作。
- EA 记录最近收到桥接消息的单调时钟；30 秒无消息释放管道并重新连接。现有绑定、查询、交易权限逻辑不变。MT5 采用独立 Worker，不将 MT4 修复宣称覆盖 MT5 重启。
- 菜单按连接、详情、编辑、删除分组；根据运行状态显示连接或断开，保留原动作防护；状态与权限详情可在菜单打开；增大菜单留白，空白处保留新增。
- 验证：Core/WinForms 严格编译；EA 0 errors/0 warnings；真实本机 NamedPipe 心跳应答及静默超时回归、WebSocket 长度边界与回环收发回归通过。
- 已更新 review 的 EXE/Core/EA 及匹配 MT4 数据目录中的 EA，桌面新 PID 61236。产物与旧版备份位于 D:dev_codex.local-runtimeridge-reconnect-fix-20260914。
- 待用户重新挂载一次更新 EA 后，再重启 Bridge 验证真实 MT4 自动恢复；当前不宣称已完成真实重启回归。未操作 MT4 图表或发送交易指令。
- 用户确认已重新挂载新版 EA；11:52:12 主动重启 Bridge（PID 50636），35 秒后进程正常。MT4 文件日志仍未刷出新记录，等待用户确认界面自动上线结果。
- 真实桌面重启回归：用户确认未重新挂载 EA，MT4 已自动恢复在线。此结论验证 MT4 终端管道恢复，不代表服务器授权、权限快照或交易链路均已通过。

### MT4 本地权限与菜单外观

- 原权限显示依赖服务器 active 状态及 account facts，造成终端在线但权限未知。MT4 改从当前本地会话心跳读取，不依赖服务器授权成功。
- Pong 兼容扩展：保留 type:int32 + utc_msc:int64，新增 connected:int32 + trade_allowed:int32（20 bytes）；12-byte 旧 Pong 仍接受但权限未知。bool 字段仅接受 0/1；显示只匹配同 terminal instance/server/login，25 秒过期或会话销毁后未知。这些字段仅供显示，不参与交易授权。
- 菜单采用独立原生渲染器：白底细边框、统一行高/宽度、淡色悬停、删除提示色，保留系统高对比度渲染。
- Core/桌面严格编译、EA 0 errors/0 warnings；旧 Pong、允许、受限、心跳超时回归通过。已更新本地程序及 EA，待用户重新挂载 EA 确认显示。产物和旧版备份：D:dev_codex.local-runtimeridge-permission-menu-fix-20260914。
- 本次解决 MT4 权限来源；MT5 使用独立 Worker，不能以该测试宣称 MT5 权限读取也已验证。菜单尚无原生窗口视觉验收证据。

### MT4/MT5 分项权限提示

- 按用户旧版参考实现彩色权限提示：标题、逐项名称、绿色已开启/红色未开启/黄色未能读取，以及关闭项汇总提示；状态列悬停展示，不把缺失字段当关闭。
- MT4：工具栏自动交易、桥接 EA 允许实时自动交易、账户 EA 权限、账户交易权限。Pong 由20字节扩至36字节，追加四个严格0/1标志；12/20字节旧响应兼容，缺分项时保持未知。数据仍绑定实例/服务器/登录账号和25秒时效，仅供显示。
- MT5：工具栏算法交易、账户 EA 权限、账户交易权限、外部 Python 交易接口；移除服务器active显示门，服务器暂断不抹除仍有效的本地事实。Worker未提供terminal_trade_allowed时保留未知，不默认false。
- 测试：分项开关逐个关闭、未知、过期、回绕、缓存隔离；36字节心跳及旧版兼容、超时通过；MT5 Worker74项通过；Core/桌面严格编译与EA零错误零警告通过。
- 已安装本地 EXE/Core/EA/Worker；备份产物 D:dev_codex.local-runtimeridge-permission-details-20260914。MT4需重载本轮EA，MT5新启动Worker读取。真实界面效果与当前账号开关状态仍待用户确认，不宣称真实交易验收。
