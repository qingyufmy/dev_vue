# 量见智桥 3.0.0 Native

本目录承载量见智桥 3.0.0 的 Rust 原生实现。现有 .NET Bridge 只作为功能与协议对照，不作为正式双栈、迁移接管或回退目标；服务器 V3 JSON 协议继续作为对外通信合同。

## 当前阶段

- 已建立独立 Rust workspace，不覆盖现有 V3 构建入口。
- Native 重构只替换实现语言和内部进程架构，不重新设计用户界面；现有 .NET 版的窗口尺寸、布局、控件文案、颜色、显示条件和托盘交互是 3.0.0 的固定产品合同。Rust UI 的新增状态只能落入同一套界面结构，不能另起一套视觉方案。
- `bridge-contract` 固定首批外部协议常量和 JSON 包络校验。
- `bridge-foundation` 固定 Launcher 参数、安装目录、Profile 隔离、运行时文件和 SQLite WAL 健康检查合同。
- `bridge-security-win` 与 V3 共用 DPAPI CurrentUser、固定 entropy、JSON 字段和原子凭据轮换合同。
- `bridge-store` 可由 Native Core 在全新 Profile 中事务化创建完整 SQLite 表与索引，并固定 WAL、`synchronous=FULL` 和外键检查；上次建库中断留下的空文件可安全继续初始化，但部分建成或列不完整的数据库拒绝原地猜测修复。兼容检查测试仍直接对照当前 C# 建库源码以阻止静默漂移。
- `bridge-store` 以 Profile SQLite 的 `terminal_bindings` 作为终端配置权威源：账户、平台或路径激活会在同一事务中递增 `connection_epoch`，并只清理该终端旧 epoch 的数据同步 revision 与 `data_delta` Outbox。MT4 同一平台与数据目录切换账户时，新账户绑定写入和旧账户绑定删除在同一事务完成；非法配置不会消耗 epoch，读取时重新校验终端 ID、平台、绝对路径和账户身份，避免损坏记录被 Core 启动。
- `bridge-store` 提供 V3 Outbox、执行回执、数据 delta 和历史归档兼容层：账户/持仓/挂单的 revision、最新 SQLite 投影与服务器 Outbox 在同一事务提交；重复 revision 必须匹配原 message/hash，gap 不写入，full snapshot 会替换旧投影并压缩该流的待发 Outbox。历史成交、历史订单和规范化交易按终端/经纪商/登录账户隔离，以最多 250 条的原子批次和单调游标写入；正式 Core 已接入 MT5 后台增量回填和服务器 `data_request: history` 分页读取，只返回当前页关联证据，并在 4 MiB 协议上限前优先裁剪证据，绝不构造无边界全量消息。`rates` 与 `symbols` 使用既有 `terminal_data_cache`，按终端、账户、epoch、动作和完整参数哈希隔离，分别缓存 2 秒和 5 分钟；缓存只用于加速，读写失败不会覆盖真实 MT5 结果。交易优先、持久化重试、回执/Outbox 同事务写入和 applied / duplicate 删除语义保持不变。
- `bridge-terminal-data` 已实现 MT5 快照投影与采集协调器：从 SQLite 恢复账户/持仓/挂单 revision 与当前集合，按 ticket 计算 upsert/delete，无变化只刷新内存 freshness；首次连接、账户 epoch 变化、主动 reconciliation 或服务器 gap 会发送 full snapshot。gap 会采用存储返回的当前 revision 后再以 `current + 1` 恢复，避免旧 revision 重试循环。协调器会在空闲时每 1 秒、有持仓或挂单时每 250 毫秒采集，交易完成或 reconciliation 请求可立即唤醒；Worker 重启期间按上限 10 秒退避，并在投影前再次校验账户路由。Core 正式进程入口已经接入该协调器。
- `bridge-terminal-session` 已把 MT5 Worker supervisor、数据路由、SQLite 投影和采集器组合成单终端会话。账户变化必须提升 `connection_epoch`；合法替换会先等待旧采集器退出，再停止旧 Worker，最后启动新会话。非法 epoch 或采集配置会在停止旧会话前拒绝，旧控制句柄在切换后失效；只有 Worker 与初始投影都 Ready 时会话才报告数据就绪。Core 本地终端域可启动多个隔离管理器，不受服务器授权或断线影响，只在终端绑定被替换、Profile 停用或 Core 整体退出时倒序关闭。
- `liangjian-bridge-core` 使用真实 Profile 启动准备链路：创建或打开该 Profile 的 SQLite、读取终端绑定，并独立校验 DPAPI 凭据状态；MT5 绑定会校验安装目录中的最小 Python 与 Worker，MT4 绑定会建立当前用户专用的 EA 管道会话，两者都使用与账户 epoch 完全一致的路由。该步骤不记录令牌或账户内容；缺少网站授权时仍启动并监管本地终端会话，只禁止服务器连接、远端数据转发和远端命令接收。
- 全新 Native Profile 不再依赖旧 .NET Bridge 预先写入 SQLite：选择 MT5 后，Core 会合并当前运行进程、MetaQuotes HKCU/HKLM 32/64 位注册表及 `origin.txt` 发现安装目录，优先只读探测正在运行的终端；探测子进程使用安装包内 Python/Worker、15 秒硬超时和 16 KiB 严格输出，只接受精确终端路径及合法 Broker/登录身份。成功结果才会激活 SQLite 账户路由；一个终端自动选中，多个终端继续使用原有下拉选择。管理员新建 MT5 观摩源也通过同一闭环建立独立 Profile 绑定。
- 全新 MT4 Profile 同样不再依赖旧 .NET 数据库：Core 从正在运行的终端、MetaQuotes `origin.txt` 数据目录及便携安装发现 MT4，一个安装自动选中、多个安装沿用现有下拉选择，并在账户尚未注册前自动部署 EA。“安装 / 修复 EA”也可直接作用于选中的安装目录。默认 Core 是 `AURUMBridgeV3` 公共注册管道的唯一总控；它按数据目录优先匹配观摩 Profile 的保留路径，再匹配普通用户唯一主账户，把设备、目录、Broker 和登录号组成的账户级身份原子写入目标 Profile SQLite，并通过 Welcome 把 EA 交给该终端专用重连管道。暂停的观摩源不会被主账户回退误接管；同目录切换账号会替换旧绑定并重启正确的 Profile，不会执行任何交易。
- `liangjian-bridge-core` 的正式入口把生命周期拆为本地终端域与服务器会话域：终端目录统一启动/倒序停止多个 MT5 会话，凭据源只驱动首次授权、主动退出和服务器监督器；凭据新增或清除不得停止 MT4 EA 管道、MT5 Worker 或本地采集。Core 每 500 毫秒检测 SQLite 终端绑定指纹，只有账户、平台、路径或 epoch 变化才有序重建对应终端会话；服务器会话按凭据独立建立 Hello 路由，已 ACK 的交易命令不会重放。管理员管理的观摩源服务器凭据被撤销或判为非法时，默认 Core 只在重新确认当前管理员身份和观摩源归属后重新签发该 Profile 的凭据，观摩 MT4/MT5 本地会话及采集器不重启；状态文件的 UI 聚合有效期也为 5 秒落盘周期保留调度余量，避免健康权限在相邻落盘间瞬时显示为检测中。服务器 gap 只允许命中当前 terminal/epoch 后请求 full snapshot，真实执行且回执已持久化的成功命令只唤醒一次对应采集器。未授权时 Core 常驻、本地终端照常运行且不自动打开浏览器；主动退出只关闭服务器会话并回到等待授权。心跳 freshness 来自当前采集状态，版本通知保留给后续 Native UI/Updater。
- Native UI 的“安装 / 修复 EA”已经接通 Core：既支持当前 Profile 中唯一或明确选中的 MT4 SQLite 绑定，也支持尚未挂载 EA、没有账户绑定的已发现安装目录；EA 按正式模块、显式开发覆盖和仓库开发目录解析，限制为 16 MiB，写入前使用 SHA-256 判断是否已是当前版本，并通过同目录临时文件和 Windows write-through 原子替换部署到 `MQL4/Experts/AURUMBridgeEA.ex4`。成功后界面会按现有 .NET 版提示刷新导航器、挂载 EA、开启两层自动交易开关，且明确说明无需 DLL 或 WebRequest。
- Native UI 同时保持现有 Launcher 的稳定入口合同：发布时仍命名为 `AURUMBridge.exe`，后台静默托管同目录 `AURUMBridge.Core.exe`，原样转发健康检查、ready 文件、预期终端和最小化启动参数。UI 使用独立单实例锁，重复启动只唤醒已有窗口；Core 异常退出按有界退避恢复，用户主动“退出桥接”后停止恢复。观摩源仍由默认 Core 管理，不额外打开窗口，也不各自运行更新器。
- 管理员多账户总控已通过真实进程级隔离测试：默认 Core 启动一个主 Profile 和一个已启用观摩 Profile，两条服务器 WebSocket 同时在线并各自只发送本账户终端的全量快照，运行状态不泄漏另一账户的 Broker 或登录号，全程没有第二个 UI。默认 Core 退出时先禁止观摩 Supervisor 重启，再向观摩 Core 发送专用 shutdown 事件并等待其写入 `stopped`、释放单实例锁；10 秒内未退出才回退 Job 强制终止，避免后台残留或状态文件虚假在线。
- 更新后的 Launcher Ready 门已覆盖同一安装实例的管理员多账户：默认 Core 只接受属于自身或已启用且完整配置观摩 Profile 的预期终端，并聚合主 Profile 与观摩子 Core 的服务器连接、初始数据完成、新鲜状态及 SQLite 路由/epoch 绑定后写入统一 ready 文件。任一更新前健康观摩源缺少授权、尚未同步或路由不一致时保持运行但不假报 ready，由 Launcher 超时回滚。
- `liangjian-bridge-launcher` 已替换稳定入口并保持相同的 `current.json`、`update-state.json`、启动参数和中文失败提示合同：正常启动先对活动版本执行 5 秒健康检查；pending 版本必须在 20 秒内连接服务器并满足全部预期终端 ready，随后稳定存活 2 秒才会原子标记 healthy 并清理本地维护租约。失败时先切换到 last-known-good，再对回退版本执行健康检查和 25 秒 ready 校验；回退成功会保留 `rolled_back` 与原始失败原因。Release 冒烟已经从稳定 Rust Launcher 启动真实 Rust UI/Core，并确认最小化、单 Core 子进程及本地服务器地址。原生卸载工作进程已按当前用户默认安装根、保留或删除数据选择、注册表和快捷方式清理合同完成；版本包构建器也已改为输出 Rust UI/Core 与原生 MT5 Worker，并把 Rust Launcher 放入签名覆盖的 `core.zip/launcher`。标准离线安装器继续使用原有 Inno 中文界面，隐藏安装后端已切换为 Rust；可选联网安装器也已保持原 .NET 中文界面与命令行排练合同并切换到 Rust。两条路径共用签名清单、包验签、原子首次安装、修复恢复、Launcher 提升、版本指针和卸载注册，不再依赖旧 .NET 安装后端；测试构建仅允许 HTTP 回环地址，正式地址留到明确授权的最终打包阶段注入。
- Native 发布构建现在自动生成 SPDX 2.3 SBOM、去重第三方许可证正文和依赖审计，覆盖 Cargo.lock 中 172 个 Rust 第三方包以及包内 CPython、MetaTrader5 和 NumPy。审计会解析 Rust EXE 的 PE 导入表并拒绝 OpenSSL/native-tls、Python 或 .NET 动态运行时，校验 Release 的 LTO、尺寸优化、panic abort 和符号剥离设置，同时拒绝把 PDB、LIB、RLIB、OBJ、PYC 等开发文件写入模块包。Python 优化器会在受控临时目录中删除字节码缓存、构建链接库、ensurepip/venv/Idle/Tk 组件以及 Worker 不使用的 OpenSSL 动态库，再以 `-I -B` 验证 SHA-256、NumPy、MetaTrader5 和正式 Worker 模块；旧运行时可裁剪 729 个文件、28,784,052 字节，从独立 CPython 按哈希锁重新构建时裁剪 591 个文件、24,454,407 字节，进入 Release 后再次优化为零变更。裁剪后的 Python 已在两个真实 MT5 demo 终端通过 110 笔成交/109 笔订单历史分页、100 根 M5 行情、85 个品种、经纪商 UTC+3 时钟及完整风控扩展数据只读冒烟，未发送交易。
- Windows 模块包改用显式正斜杠 ZIP 条目生成器，避免系统 ZIP API 生成反斜杠路径后被 Rust 目录穿越防护拒绝。3.0.0 workspace、PE ProductVersion、Core 健康版本与 MT5 Worker 版本现在必须精确一致，预发布后缀不再能混入稳定清单。本地测试证书签名的标准 Inno 离线安装器已完成首次安装、同版本修复替换、版本指针推进、无残留备份和安装后 Core 健康检查；安装器为 26,381,942 字节（25.16 MiB），安装目录不含受禁开发/OpenSSL/.NET 运行时文件，且只包含 `http://127.0.0.1:3000`，没有正式域名。正式地址仍只允许在用户明确授权最终打包时注入。
- `bridge-update` 已冻结与 .NET Launcher 共用的 `update-state.json` 合同：严格校验全部阶段、版本、暂存时间、维护租约和错误字段，以 write-through 原子替换持久化；默认 Profile 会把可信更新状态投影到原有更新条幅，“重启更新”只把 `manual_activation_requested` 从 `false` 原子改为 `true`。观摩源进程、开发目录和缺少 Launcher/公钥/版本指针的非安装布局不会启用更新控制。
- `bridge-update` 已兼容现有 .NET / Node 发布链的 P-256 双层签名合同：清单与每个模块均独立验签，规范化文本由跨运行时黄金夹具共同锁定；清单最多 128 KiB，模块最多 512 MiB，只接受 HTTPS 或本机回环 HTTP。下载按声明长度和 SHA-256 流式校验后进入内容寻址缓存，ZIP 在写入前完整预检路径穿越、符号链接、NTFS ADS/设备名、大小写碰撞、条目数量和 1 GiB 解压上限，并只允许解压到全新隔离目录；下载前按缺失包体、四倍展开估算和 256 MiB 安全余量检查磁盘，验包后再按 ZIP 实际展开体积复核。重启后从 `waiting_window`、`acquiring_lease`、`draining` 或尚未交给 Launcher 的 `activating` 恢复时，会重新验证 Manifest、缓存 ZIP 的大小与 SHA-256，并逐字节核对全部已解压 Core、MT5 Worker、MT4 EA 文件且拒绝额外文件；损坏但尚未成为 pending 指针的版本会被限定在目标版本目录内清理，状态退出激活中并允许下一周期重新下载，已成为 pending 的版本则保留给 Launcher 健康检查和回滚，避免 Core 破坏回滚证据。默认 Profile 会在启动后及每 15 分钟从当前服务器地址检查一次，创建与 .NET 完全相同的安装身份和发布通道请求头；版本较新时依次暂存 Native Core、MT5 与 MT4 模块并写入 `waiting_window`。
- Native 更新激活已接通服务器维护租约与稳定 Launcher 交接：普通、紧急和手动更新都必须由服务器按当前主账户、在线观摩源终端及观摩源用户范围授权；Core 在租约内通过当前用户保护的内部管道暂停默认 Profile 与全部更新前在线的观摩 Profile，共享 30 秒期限等待真实 Command Dispatcher 在途集合归零，任一超时或连接失败都会按逆序恢复已暂停 Profile，再释放租约并延迟重试。进程级测试已证明活动交易会阻止切换、超时后准入可恢复，默认 Core 与观摩子 Core 都能独立暂停和恢复；本地控制服务会在释放旧连接前创建下一管道实例，避免连续排空/恢复请求抢连旧实例。排空成功后续租并原子写入与 .NET 完全相同的 `current.json` pending 指针，随后有序退出。旧 UI 释放单实例锁后只启动安装根目录中的 `AURUMBridge.Launcher.exe`，新 Core 就绪前先释放持久化租约；损坏指针、错误目录、未签名暂存包、主账户不在线或没有主终端时均失败关闭。更新预检错误会持久化并有界延迟重试，避免请求风暴；普通 Profile 和观摩源进程不会各自运行更新器。
- `bridge-command` 已建立持久化命令账本和进程内单航班执行：命令先落盘再分发，重复命令复用同一回执，超时、Worker panic、路由错配及重启中断都会持久化为 `uncertain`，不会自动重放交易。周期核对服务只读取 `dispatched` 无回执命令和服务器已 ACK 的 uncertain 回执；只读核对无证据、超时、panic 或返回非法路由时保持待核对，只有同路由的最终事实才会原子生成新交易回执并重新等待服务器 ACK。MT5 只读核对适配器已接入正式 Core：启动后立即核对、随后每 5 秒分批运行，每次生成全新查询 ID，优先采用原回执票号，否则按原命令的 comment/magic 查询终端事实；30 秒结算窗口内无证据继续等待，窗口后才产生明确失败。核对任务与服务器及 Worker 共用取消边界，退出不会等待完整批次。
- `bridge-worker-host` 已建立版本化 Core ↔ Worker IPC 合同：4 MiB 小端长度前缀 JSON 帧、会话 nonce、终端/账户/epoch 路由、请求关联、超时后通道熔断和能力协商均严格校验；`query_execution` 使用独立只读操作，不能进入交易执行操作。Windows 管道使用当前用户 SID 的保护 DACL、拒绝远程客户端和首实例防抢占；Worker 只有在受 Job Object 管理的子进程完成严格握手后才会交付客户端。注册表通过终端 claim 和单调代际号原子替换客户端，请求前后均执行 fencing；崩溃按 1/2/4/8/10 秒退避重启，新账户 claim 会终止旧 supervisor，避免路由争抢。
- `bridge-mt4` 已冻结 Rust 与 MT4 EA / .NET 对照实现共用的本地二进制合同：4 MiB 小端长度前缀、严格 UTF-8、协议 3 的 Hello / Welcome、账户/持仓/挂单采集、扩展数据、历史分页、交易指令/结果和关闭消息。正式 EA 3.0.0 的执行请求会同时核对终端实例、Broker、登录号、epoch、期限及 MT4 四层交易权限；管理指令将服务端 `expected_state.volume` 作为执行前持仓手数，将顶层 `volume` 作为本次平仓手数，因而能在防串单校验不降级的前提下部分平仓。挂单修改同样必须核对品种、方向、Magic、手数及旧 SL/TP，并在 `OrderModify` 后复查终端事实。MQL4 解码器会在零长度 UTF-8 字段处直接返回空字符串，避免把后续二进制帧误当成可选价格、备注或查询参数；首次注册后会主动切换到 Core 分配的专用账户管道，专用管道连续失败 5 次才回退公共注册管道，避免重复注册造成运行时重载风暴，同时保留 Core 重启及切换账户后的自恢复能力。此前 3.2.x 开发握手号会明确提示重新加载；正式 3.0.0 只在新鲜 tick 到达时校准 Broker 时区偏移，并按“登录号 + Broker 服务器”隔离持久化最近有效样本；停市时冻结偏移并标记缓存状态，避免 `TimeCurrent()` 停止而本机 UTC 继续前进造成时区漂移，也不会在同登录号跨服务器切换时复用旧偏移。响应 ID、格式或管道超时异常会熔断当前连接。历史归档仍以 250 条和 4 MiB 为硬边界，但首次同步窗口覆盖完整时间范围，避免从 2000 年开始按 30 天重复扫描大量空窗口；交易完成后 Core 立即唤醒快照和历史采集。已 dispatch 但没有可信结果的命令进入持久化 `uncertain`，只允许根据 EA 返回的活动订单、活动持仓或历史事实核对，不自动重发交易。连接层使用当前用户 SID 保护 DACL、拒绝远程客户端并支持首实例防抢占，正式 Core 已接入默认 MT4 注册管道和按终端隔离的重连管道。
- MT5 交易动作参数合同已在 Core → Worker IPC 边界冻结：`place_order`、`cancel_order`、`modify_order`、`modify_position`、`close_position` 与只读 `query_execution` 按服务器业务适配器的实际字段逐项校验；缺失必填字段、非法票号/数值、管理目标快照不完整或未知字段均在写入 Worker 管道前失败关闭。正式 Core 已启用 MT5 Dispatcher，但只有服务器确认当前账户、持仓和挂单三类初始全量快照后才放行交易。
- `workers/mt5` 已实现独立的 MT5 Python Worker：每次请求复核终端、经纪商服务器、登录号和连接状态；账户、持仓和挂单字段无损转发，列表带 ticket 且受 4 MiB 帧限制；报价、品种列表和最多 5,000 根 K 线通过独立只读 IPC 动作返回，K 线沿用经纪商时区校准，时钟未可信时失败关闭。交易侧已声明 `execute_command` / `query_execution` 能力，在进入交易适配器、`order_check` 前及 `order_send` 前复核账户和算法交易权限，执行结果缺失或发送异常只返回 `uncertain` 且按 command id 缓存，绝不在 Worker 内自动重放。终端会话失效会先返回稳定错误，再主动结束当前 Worker，交由 Rust supervisor 使用新进程和既定退避重新初始化 MT5；账户或 Broker 路由不匹配不会进入无效重启循环。Rust 测试会启动真实 Python 子进程并通过受保护命名管道验证快照、报价、品种、K 线和交易回执互操作；Core 独立进程测试覆盖服务器数据请求、SQLite 缓存、交易命令、账本、Dispatcher、Worker 回执、交易 Outbox 与结果 ACK 闭环。
- `scripts/bridge-native/test-mt5-demo.py` 提供显式 `--execute` 的 MT5 demo 验收入口：只允许 demo 账户和无既有仓位的测试品种，所有测试对象使用唯一 comment 并在失败路径自动清理。`--matrix` 会按经纪商最小手数依次完成限价挂单、改单、撤单、开仓、修改 SL/TP、部分平仓和全部平仓；`--faults` 验证本地参数拒绝和真实经纪商 `order_check` 拒绝；只读 `--history-smoke` 验证有界历史批次和游标，`--market-data-smoke` 验证品种解析、100 根 M5 K 线和 UTC 时钟校准，`--observe-recovery-seconds` 用于验收终端关闭后按 supervisor 同款退避重新初始化，这三项均不发送交易。2026-07-29 已在真实 MT5 demo 上完成管理矩阵、`order_volume_below_minimum` / `mt5_check_retcode_10016` 两类拒绝验证、历史同步和市场数据冒烟，以及终端 PID 关闭→会话失效→单次重启→新 PID 恢复在线的闭环；每次交易测试结束后复查测试品种持仓和挂单均为 0。正式 Core 除隔离假 MT5 的端到端命令、历史/品种/K 线请求、SQLite 缓存和 Worker 换进程恢复测试外，还已在真实 `DooTechnology-Demo` 账户 `596520` 完成低于最小手数的安全拒单闭环：服务器命令先进入持久化账本，真实 Worker 返回 `order_volume_below_minimum`，回执获服务器 ACK 后账本落为 `acked`，测试前后终端持仓和挂单票号集合完全一致。正式成功执行链路也已在同一账户完成两类往返：市价开仓结果 ACK 后从持仓增量提取真实 position ticket（不假定 order ticket 等于 position ticket），携带完整目标快照设置按当前报价与 Broker 距离动态生成的 SL/TP 并由 Worker 复查终端事实，随后携带更新后的保护快照平仓；限价挂单价格同样动态生成，挂单 ACK 后从订单增量提取真实 ticket，携带完整 `expected_state` 修改价格并复查，最后再次携带目标快照撤单。六次 MT5 Broker 返回码均为 `10009`，六个账本均为 `acked`，两项测试前后终端活动持仓与挂单票号集合完全一致。
- MT5 正式持仓管理链路已进一步覆盖部分平仓：服务器开仓 `0.02` 手并设置 SL/TP 后先平仓 `0.01` 手，Core 从下一次真实持仓增量校验剩余 `0.01` 手及当前 position ticket，再发送最终平仓。开仓、保护修改、部分平仓和最终平仓四次 Broker 返回码均为 `10009`、四个账本均为 `acked`；与三步挂单管理合计七个正式命令全部 ACK，测试前后终端活动持仓与挂单票号集合完全一致。
- `cargo run -p bridge-mt4 --example mt4_demo_acceptance -- ...` 提供显式 `--execute` 的 MT4 demo 验收入口：Broker 名必须包含 `Demo`，EA 会先返回账户/终端/程序交易权限和品种最小、最大及步进手数，且目标品种必须没有既有持仓或挂单；通过后才按唯一 comment 交易，并按实际票号复查清理结果。`--execute --partial-close` 会开两倍测试手数、部分平仓一半、核对剩余持仓，再全部平仓；`--execute --matrix` 还会执行最小手数以下拒单、限价挂单、错误 Magic 防串号拒绝、改单、撤单、错误 SL 拒绝、有效 SL/TP、部分及全部平仓，任一步失败都会按最新终端事实清理测试品种；`--observe-recovery-seconds` 只读记录在线、断开和恢复状态；`--market-data-smoke` 只读核对实时买卖价、Broker 时区与服务器时间、品种列表，以及严格按时间升序的 100 根 M5 K线和 OHLC 合法性；`--history-smoke` 将终端可见历史按游标全量写入临时 SQLite，关闭并重新打开数据库后逐页核对，无需向服务器发送整包历史。MT4 官方 API 只能读取终端“账户历史”页当前可见范围，因此完整历史要求该页选择“全部历史”，验收报告会明确标记这一边界。2026-07-30 已使用 EA 3.2.7 在 `UltimaMarkets-Demo` 账户 `4250502` 完成全矩阵：无效手数返回原始 MT4 `131`，挂单票号 `103462324`，持仓票号 `103462326`，部分平仓后的剩余票号 `103462327`，最终无持仓或挂单残留。EA 3.2.8 进一步完成连续会话公共重注册和真实 MT4 进程关闭→重启→约 27.3 秒恢复在线的只读闭环，恢复后再次连接成功。EA 3.2.9 为 K线负载补齐 `source=mt4`，并在同一模拟账户真实核对报价 `4075.51/4075.72`、UTC+3 服务器时间、307 个品种和 100 根 `XAUUSD` M5 K线通过。EA 3.2.10 将 13 条终端可见记录单批落入 SQLite，数据库重开后按每页 2 条完整读取 12 笔交易、共 6 页且无重复或遗漏。EA 3.2.11 已通过真实进程级只读验收：模拟账户注册后进入专用管道，Core 状态为 `online/ready`，SQLite 历史归档通过服务器 `data_request(history)` 按 20 条上限返回 `mt4_sqlite` 完整分页响应，且验收服务器未发送任何交易指令；同一真实账户还完成服务器低于最小手数命令的正式拒单闭环，EA 返回原始 `131`，Core 上报 `mt4_error_131`，服务器 ACK 后账本为 `acked`，活动投影不存在测试订单标记。正式成功执行链路也已使用同一 demo 账户完成两次最小手数往返：服务器开仓结果 ACK 后从持仓增量提取真实 ticket 和价格，带完整 `expected_state` 设置相距 20 美元的 SL/TP 并由 EA 复查终端事实，最后携带更新后的保护快照按同一 ticket 平仓；开仓、修改保护与平仓 Broker 返回码均为 `0`，三个账本均为 `acked`，最终活动投影无测试 Magic 或 comment 残留。同一验收服务器还在 `DooTechnology-Demo` 账户 `596520` 完成 MT5 正式进程闭环：首次归档 25,828 笔规范化交易后，服务器按 20 条上限取得 `mt5_sqlite` 完整分页响应，Core/Worker 保持 `online/ready`，全程未发送交易指令。
- MT4 正式挂单管理链路也已在同一 demo 账户通过：Core 先从 EA 的 `symbol_snapshot` 读取实时买价、点值、精度与 Broker 止损/冻结距离，动态生成远离市场的限价及改价价格；服务器依次发送创建、修改、撤销命令，EA 每步复查真实终端订单。三次 Broker 返回码均为 `0`、三个账本均为 `acked`，最终活动投影无测试 Magic 或 comment 残留。
- MT4 正式持仓管理链路已进一步覆盖部分平仓：服务器开仓 `0.02` 手并设置 SL/TP 后先平仓 `0.01` 手，Core 不假定旧票号仍然有效，而是从随后到达的真实持仓增量重新识别剩余 `0.01` 手及当前 ticket，再发送最终平仓。开仓、保护修改、部分平仓和最终平仓四次 Broker 返回码均为 `0`、四个账本均为 `acked`，最终活动投影无测试 Magic 或 comment 残留。
- `bridge-observability` 写入现有内置日志查看器可直接读取的脱敏 JSONL，并持久化 panic 与非正常退出证据。Core 同时为每个 Profile 原子发布有界的 `runtime-status.json`：启动、待授权、连接、在线、降级和停止状态包含服务器、Worker、采集器、最后同步、连续失败及命令核验摘要，状态变化会生成脱敏事件，文件每 5 秒刷新存活时间。该只读投影不包含登录号、Broker Server 或凭据，供后续 Native UI/受限本地 IPC 消费，不能用于控制 Core 或批准交易。
- `bridge-runtime-win` 与 .NET V3 共用锁文件及 `Local\*.activate/.shutdown` 事件，并用 Windows Job Object 监管、清理和退避重启子进程树。
- `bridge-transport` 已完成统一端点解析、rustls HTTP / WebSocket、refresh / ticket、Hello / ACK、心跳包络、严格优先队列、重连状态机和 Outbox 泵基础。服务器地址以管理员数据目录中的 `endpoint-settings.json` 为优先权威源；文件缺失或损坏时退回安装目录随签名包发布的 `server-endpoints.json`。单一 `server_url` 会派生实时地址，公网明文 HTTP 不被接受，本机回环地址仅供开发使用。
- 原生会话编排器现已联动 WebSocket 收发、10 秒心跳、200 ms Outbox 轮询和整组取消；任一循环失败都会关闭本次会话并保留原始稳定错误码。
- 入站路由已安全处理 `data_ack`、gap 全量恢复通知、版本通知、心跳、服务器错误和 `command_result_ack`；ACK 会严格核对持久化回执或待发送结果的账户、终端及 epoch。
- 交易命令准入已冻结过期、动作、账户、终端、epoch、暂停状态和初始全量同步门禁；每次服务器会话建立或重连都会重新请求账户、持仓和挂单全量快照，并只在本次会话收到三类 ACK 后恢复交易。正式 Core 已将入站路由、SQLite 命令账本、`RegistryCommandWorker` 与 MT5 Dispatcher 接通，执行回执与交易 Outbox 同事务保存，服务器 ACK 后账本原子推进为 `acked`。超时、通道代际变化或结果缺失均进入 `uncertain`，不得自动重放；启动及运行期主动事实核对器已经接入。
- 原生连接监督器已保留 V3 的 1/2/4/8/10 秒退避，并在凭据缺失时等待明确的授权变化，不会自行打开浏览器。
- 本地端到端测试会真实执行 refresh → ticket → WebSocket ticket → Hello / ACK → Heartbeat，并验证二进制帧失败关闭。
- Core 级回环测试会启动真实 `liangjian-bridge-core.exe`、隔离 Python 运行入口和假 MT5 Worker，验证 DPAPI、SQLite、命名管道、`data_delta` 转发、初始快照 ACK 门禁、交易命令执行、启动时中断命令只读核对且不重放、`command_result` / ACK 账本闭环、Launcher ready、WebSocket 断线后的降级/重连、Worker 被终止后的失败计数/换进程恢复、状态文件暂时不可替换时 Core 继续运行、单实例退出以及 Python 子进程随 Core 清理。
- `liangjian-bridge-compat-probe` 目前仅作为开发期本地合同探针，不代表 3.0.0 需要接管旧 .NET Bridge 的生产数据。
- `bridge-core` 普通运行会建立日志、单实例、运行标记和 Profile 状态投影，并立即启动与授权无关的本地终端域：默认 Profile 常驻管理唯一的公共 MT4 注册入口，已绑定的 MT5 Worker 与本地采集独立运行；凭据和地址有效时再建立服务器监督器。首次 MT4 注册或账户切换会路由到正确 Profile，主账户与每个观摩 Profile 的会话只监听各自专用重连管道，避免多个 Core 进程争抢注册入口或观摩源串号。MT4 与 MT5 新 Profile 都可由 Native 自主完成发现、安装/探测和首次 SQLite 绑定。两平台共用同一 Command Dispatcher、初始全量快照准入、持久化账本、结果 Outbox、ACK 与只读核对任务；读数据按终端平台路由到 MT4 EA 或 MT5 Worker。服务器失败状态保留稳定错误码直至下次连接迁移；主动退出授权只停止服务器通道，Core 整体退出事件才取消本地终端域；只有服务器已连接且 Launcher 指定的终端全部 Ready 时，才原子写入 ready 信号。

## 本地验证

开发构建和本地验收只使用 `config/development/server-endpoints.json` 中的
`http://127.0.0.1:3000`。统一验证脚本会在 Release 构建完成后把这份配置复制到
Core 旁边。正式服务器地址不写入 Native 源码，只能在用户明确要求最终打包时由发布流程注入。

### UI 黄金状态

Debug 构建提供只读的确定性界面场景，用于和现有 .NET 版在同一状态下截图比对。场景不会轮询 Core，也不会向本地控制管道发送按钮动作；Release 构建不解析这些参数。`--demo` 保留为管理员多账户场景的兼容别名。

```powershell
$ui = ".\bridge\native\target\x86_64-pc-windows-msvc\debug\liangjian-bridge-ui.exe"
& $ui --ui-demo ordinary-mt5
& $ui --ui-demo admin-multi-account
& $ui --ui-demo pairing-required
& $ui --ui-demo server-offline
& $ui --ui-demo update-ready
```

更新条幅还可以使用 `update-downloading`、`update-waiting`、`update-activating`、`update-failed`、`update-rolled-back` 和 `update-healthy`。所有场景固定显示同步时间 `13:19:09`，避免截图因为系统时区或采集时刻发生无关变化。

```powershell
$cargo = "$env:USERPROFILE\.cargo\bin\cargo.exe"
Push-Location .\bridge\native
& $cargo fmt --all --check
& $cargo clippy --locked --workspace --all-targets -- -D warnings
& $cargo test --locked --workspace
Pop-Location
```

在交易、会话恢复、Worker 监管和 ready 信号全部完成真实验收前，不得把 Native Core 打入稳定发布清单。

也可以从仓库根目录执行统一验证入口：

```powershell
.\scripts\bridge-native\test-native.ps1
```

安装入口的 Release 冒烟测试会把 UI/Core 按最终文件名放入隔离的临时
`versions/3.0.0` 目录，验证 Launcher 健康检查转发、最小化 UI 常驻、后台 Core
子进程和本地服务器配置；脚本只按本次启动的精确 PID 清理测试进程：

```powershell
.\scripts\bridge-native\test-ui-host.ps1
```

完整离线安装器的本地发布门会强制使用 HTTP 回环地址，构建测试环境安装器后在
隔离目录完成首次安装、同版本修复、版本指针、原生文件布局、Core 健康检查、包体
上限和正式域名残留扫描。它不会改动当前用户的正式安装目录，也不会接受公网地址：

```powershell
.\scripts\bridge-release\test-local-full-installer.ps1 `
  -ReleaseDirectory '<本地签名发布目录>' `
  -PublicKey '<本地测试公钥 PEM>' `
  -OutputDirectory '<新的隔离输出目录>' `
  -ServerUrl 'http://127.0.0.1:3000' `
  -LauncherVersion '3.0.0'
```

测试结果写入输出目录的 `lifecycle-result.json`。正式服务器地址只有在用户明确要求
最终打包时，才允许通过 production 发布参数注入。

本地客户端更新演练已经由 Rust 原生工具接管。先用两份真实、版本一致的本地发布
目录生成签名测试清单并启动 `local-rehearsal-server.mjs`，再运行
`test-local-client-update.ps1`。客户端只接受 `127.0.0.1` HTTP 服务，第一版必须健康
激活；第二个紧急版本会模拟启动就绪失败，并由正式 Rust Launcher 回滚到上一健康版。
`-Result` 可把最终指针、更新状态和回滚错误码写成独立 JSON 证据。

只读检查现有默认 Profile：

```powershell
.\bridge\native\target\x86_64-pc-windows-msvc\release\liangjian-bridge-compat-probe.exe
```

检查观摩源时传入 V3 根数据目录及 Profile；输出只包含兼容状态，不包含授权令牌、账户快照或历史数据：

```powershell
.\bridge\native\target\x86_64-pc-windows-msvc\release\liangjian-bridge-compat-probe.exe `
  --root-data-dir "$env:APPDATA\AURUM\BridgeV3" `
  --profile source-example
```
