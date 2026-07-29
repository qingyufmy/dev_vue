# 量见智桥 Native 3.0.0 UI 等价迁移矩阵

## 1. 目标和禁止项

Native 3.0.0 是现有 .NET 量见智桥的 Rust 语言与进程架构重构。用户看到的窗口尺寸、控件层级、字体、颜色、间距、按钮顺序、中文文案、显隐条件、产品能力、任务流和权限边界保持不变；不是重新设计界面。

禁止以“首版”“状态壳”“轻量化”为理由省略现有入口；禁止用近似布局、自定义信息架构或新增控件替代 .NET 界面；禁止让 UI 直接读写 Bridge SQLite、控制 Worker 或向服务器发送交易请求；禁止把脱敏 `runtime-status.json` 扩展成包含账户、Broker、管理员权限或授权信息的旁路接口。

权威实现：

- 主界面：`bridge/app/AurumBridge/UI/BridgeMainForm.cs`
- 状态文案：`bridge/app/AurumBridge/UI/BridgeUiText.cs`
- 托盘与事件编排：`bridge/app/AurumBridge/UI/BridgeApplicationContext.cs`
- 连接设置：`bridge/app/AurumBridge/UI/BridgeSettingsForm.cs`
- 观摩源：`bridge/app/AurumBridge/UI/BridgeObserverProfileDialog.cs`
- 终端目录：`bridge/app/AurumBridge/UI/BridgeTerminalDirectoryDialog.cs`
- 内置日志：`bridge/app/AurumBridge/UI/BridgeLogViewerForm.cs`

## 2. 主界面等价项

| 区域 | .NET 现有行为 | Native 3.0.0 验收证据 |
| --- | --- | --- |
| 品牌区 | `量见智桥`、品牌副标题、应用图标；默认 620×700，最小 580×620，DPI 自适应 | Win10/11 100%/125%/150% 截图对比，无乱码、遮挡或裁切 |
| 更新条幅 | 下载、已就绪、等待、激活、失败、回滚、健康七种状态；紧急和普通颜色不同；支持“重启更新” | 七种黄金状态逐一渲染和按钮可用性测试 |
| 平台选择 | `MT5` / `MT4` 下拉；切换中禁用并显示“正在切换平台…” | 选择请求经 IPC 发给 Core，成功/失败均恢复一致状态 |
| 管理员入口 | 仅有权限的默认 Profile 显示“添加观摩源”；服务器未连接时仍可显示恢复用“连接设置” | 普通用户、管理员、离线管理员三类权限用例 |
| 退出账号 | 已选平台且不在授权/平台选择阶段时显示；退出后不自动打开浏览器 | 清除授权、Core 回到待授权，用户点击“连接账号”后才打开浏览器 |
| 终端选择 | 多个 MT5 显示“MT5 账户”；多个 MT4 显示“MT4 终端” | 候选身份、当前选择和切换失败恢复测试 |
| MT4 EA | 选择 MT4 后显示说明和“安装 / 修复 EA”；安装成功显示挂载与开关指引 | 缺失、覆盖、权限失败、成功、需重启五类用例 |
| 总状态 | 标题、描述、颜色点、服务器连接、最近同步、版本与 .NET `BridgeUiText` 语义一致 | 所有 `BridgeApplicationPhase` 黄金样本 |
| 账户列表 | 主账户始终在前；仅管理员显示观摩源；宽度足够横排、不足竖排；空态一致 | 0/1/2/6 账户及窗口宽度断点截图 |
| 账户卡片 | 角色、平台、登录号、Broker、运行状态、交易权限、EA 重启提示 | MT4/MT5 正常、检测中、异常、停止、恢复状态测试 |
| 权限提示 | hover 显示每个交易开关；已开启绿色、未开启红色、检测中黄色，并给出下一步 | MT4 四项、MT5 三项逐项颜色与文案测试 |
| 观摩源控制 | 未绑定显示“绑定”；未配置只显示设置；暂停显示启动；停止显示重试；运行显示暂停 | 每种观摩源状态的主按钮和设置按钮 IPC 测试 |
| 底部入口 | `连接账号`、`重新检测`、`查看日志`、`连接设置`、`退出桥接` 按现有显隐和顺序工作 | 每个按钮只产生一个受限控制请求；重复点击有 busy 防抖 |
| 关闭行为 | 标题栏关闭只隐藏到托盘；退出桥接不撤单、平仓或关闭 MT | UI 进程退出后 Core/Worker 仍运行；显式退出桥接只停 Bridge 进程树 |

## 3. 子界面和托盘等价项

| 界面 | 必须保留的能力 |
| --- | --- |
| 连接设置 | 跟随官方配置、自定义单一服务器地址、输入框垂直居中、测试连接、恢复官方配置、保存并重启；远程 HTTPS/本机 HTTP 规则一致 |
| 新增/设置观摩源 | Profile 名称、绑定观摩账户、MT4/MT5、独立终端目录、浏览、校验、创建/保存并连接 |
| 终端目录选择 | 自动检测目录、本机固定磁盘树、异步展开、不可访问目录容错、已选择目录确认；不得再出现浏览卡死 |
| 内置日志 | 软件内只读查看、3 秒自动刷新、手动刷新、复制全部、刷新状态、等宽字体；不以打开文件管理器代替 |
| 托盘菜单 | 打开量见智桥、开机自动启动、连接设置、恢复官方连接、退出桥接；权限与自定义地址决定显隐 |
| 授权 | 首次由用户点击“连接账号”后打开浏览器；成功后长期复用刷新凭据；主动退出前不二次登录 |

## 4. Core ↔ UI 本地合同

UI 通过当前用户 SID 限制的命名管道读取完整状态并发送控制请求。每个请求包含 `schema_version`、`request_id`、`profile_id` 和动作参数；Core 校验 Profile、权限、当前状态和幂等请求 ID 后执行。

完整状态至少等价于 .NET `BridgeApplicationStatus`、`BridgeObserverProfileView` 和 `BridgeUpdateNoticeView`：

- Phase、DetailCode、ServerConnected、LastDataSync、BridgeVersion。
- SelectedPlatform、SelectedTerminalInstanceId、TerminalCandidates。
- 主账户与观摩源终端的账户身份、运行状态、交易权限和 MT4 EA 重启标记。
- CanManageObserverSources、IsAdministrator；普通用户状态中不得出现观摩源目录或管理员配置。
- 观摩源绑定、配置、启停和运行摘要。
- 更新版本、紧急性、阶段和手动激活状态。

控制动作固定为：`pair`、`logout`、`select_platform`、`select_terminal`、`redetect`、`install_mt4_ea`、`observer_create`、`observer_update`、`observer_bind`、`observer_start`、`observer_pause`、`observer_retry`、`settings_test`、`settings_save`、`settings_restore_official`、`autostart_set`、`update_activate`、`bridge_exit`。

`runtime-status.json` 只允许显示 Core 启动、连接、过期和崩溃兜底，不是完整 UI 数据源。

## 5. 分批实施门

1. 先实现并测试版本化本地 IPC 状态/动作合同，禁止按钮直接操作数据库或 Worker。
2. 再按主界面区域逐项迁移；未接通的动作不能显示为可用按钮。
3. 再迁移设置、观摩源、目录和日志子界面及托盘菜单。
4. 用相同黄金状态和相同逻辑窗口尺寸分别驱动 .NET 和 Rust 界面；字段、文案、显隐、动作、控件位置和 DPI 缩放必须一致，并保留同尺寸截图证据。
5. 完成 Win10/11、DPI、普通用户、管理员和多账户真实验收后，Native UI 才能进入安装清单。

## 6. 当前验收记录

- 2026-07-30：在本机 100% DPI 的 Rust 演示状态中实际打开主界面、连接设置、新增观摩源、MT5 目录选择和内置日志；窗口尺寸、控件顺序、中文文案、输入框、按钮和滚动区域均完整可见，目录树异步打开未卡死。
- 2026-07-30：管理员观摩源已由默认 Profile 的 Core 异步聚合，配置、启停、运行阶段、当前账户路由及交易权限均来自各自隔离档案；运行状态超过 5 秒、账户或 connection epoch 不匹配时失败关闭。普通用户状态仍不包含观摩源目录或控制能力。
- 2026-07-30：实际打开管理员双账户演示并点击观摩源“设置”，已确认复用现有编辑对话框，原 Profile、观摩账户、平台和终端目录正确回填，按钮未遮挡；创建、保存、绑定、启动、暂停和重试使用受限 IPC，观摩源动作采用 30 秒独立超时。
- 自动化合同覆盖 100%/125%/150% 逻辑尺寸换算；子窗口实现了 `WM_DPICHANGED` 后的字体重建、控件重排和建议窗口矩形应用，并已通过编译与 Clippy，但仍需下述跨屏实机验证。
- 仍待完成：Win10/11 实机 125%/150% 同状态 .NET/Rust 截图对比，以及普通用户、管理员、多账户全部黄金状态截图。完成前不得宣称 Native UI 已通过最终安装验收。
