# 量见智桥 3.0.0 Windows 安装失败修复与同版本重打包方案

> 状态：待实施；方案已完成两轮复审
> 日期：2026-08-08
> 目标版本：`3.0.0`
> 适用代码库：`wall-street-skill-local`
> 当前边界：只确定修复与验收方案；不修改代码、不构建、不上传、不部署、不切换公网下载入口

## 1. 结论

本次不回退到 2.3.9 的 Python/Nuitka + Inno 安装模型，也不另建一套安装器。

继续保留 3.0.0 的完整离线 Inno 外壳、Rust Installer Backend、签名 Manifest、模块完整性校验、版本目录、Launcher 健康检查、回滚和后续模块自动更新。修复重点是 3.0 当前共用的“已验证版本目录发布”过程：

1. Windows 目录重命名遇到杀毒软件扫描、索引器或短暂文件占用时，进行有边界的重试。
2. 快速原子重命名持续失败时，允许进入“逐文件验证复制 + 发布标记最后提交”的安全降级路径。
3. 安装器和自动更新器共用同一个发布实现，避免只修首次安装、以后自动更新再次失败。
4. 保留稳定的外部错误码，同时把阶段、Windows 原始错误号、错误类别和重试次数写入本地诊断日志。
5. 修复完成后仍以 `3.0.0` 重新构建完整安装包，但必须使用新的 `ReleaseId`、新的内容寻址对象和新的安装器对象，禁止覆盖已发布文件。
6. 恢复标准 Inno 安装目录页，首次安装允许用户自主选择本地安装路径。
7. 新安装默认目录改为 `C:\Program Files\AURUM\LiangjianBridge`；实现时使用 Inno `{autopf}\AURUM\LiangjianBridge`，以适配系统实际 Program Files 位置。

重新打包的 3.0.0 适用于：

- 新用户首次安装；
- 安装失败用户重新运行安装包；
- 已安装 3.0.0 用户人工执行同版本修复。

它不等于给现有 3.0.0 客户端自动下发同版本更新。当前更新协调器明确忽略 `target <= current`，因此已经安装的 3.0.0 不会因新的 `ReleaseId` 自动替换本机 3.0.0。若以后需要对全部已安装 3.0.0 自动修复，必须采用更高版本号，或另行设计并审计“同版本 ReleaseId 更新”协议；不纳入本次方案。

## 2. 已确认事实与证据边界

### 2.1 故障机证据

故障机当前证据为：

| 项目 | 结果 |
|---|---|
| Windows | Windows 10 Enterprise LTSC，`10.0.19044` |
| 当前用户 | `geery.lee` |
| 安装根目录 | `%LOCALAPPDATA%\AURUM\LiangjianBridge` |
| 安装根目录 | 已创建 |
| `versions` 目录 | 已创建但为空 |
| `versions\3.0.0` | 不存在 |
| `AURUMBridge.Launcher.exe` | 不存在 |
| `current.json` | 不存在 |
| Bridge 相关进程 | 未发现 |
| C 盘剩余空间 | 约 55 GB |
| 安装错误码 | `bootstrap_io_failed` |

这说明安装已进入本地落盘阶段，但没有完成版本目录发布。现有证据可以排除“磁盘空间明显不足”和“已运行 Bridge 进程未退出”，但还不能直接证明具体 Windows 错误号，也不能在没有新日志前把杀毒软件判定为唯一根因。

### 2.2 代码证据

当前首次安装在 `bridge/native/apps/bridge-installer/src/lib.rs` 的 `install_version()` 中：

- 创建 `versions`；
- 首次安装使用 `fs::rename(source, destination)` 发布 `versions\3.0.0`；
- 同版本修复先把旧目录重命名为 `.repair-backup-*`，再把新目录重命名到正式位置；
- 相关 I/O 错误统一压缩成 `bootstrap_io_failed`，原始 Windows 错误被丢弃。

当前自动更新在 `bridge/native/crates/bridge-update/src/coordinator.rs` 的 `stage_manifest()` 中，也通过一次 `fs::rename(temporary_directory, final_directory)` 发布版本目录，失败统一返回 `update_version_publish_failed`。

因此，本次不能只改 Inno 脚本或错误提示。Inno 已经成功启动 Rust 安装后端，真正需要修复的是 Rust 版本目录发布能力；同一能力还影响将来的模块自动更新。

### 2.3 尚未证明的部分

以下是高概率推断，不作为已证实根因：

- Windows Defender、第三方杀毒软件、EDR、索引器或备份软件短暂打开了解压后的 EXE/DLL；
- 目录重命名返回 `ERROR_ACCESS_DENIED (5)`、`ERROR_SHARING_VIOLATION (32)` 或 `ERROR_LOCK_VIOLATION (33)`；
- 目标机本地安全策略允许创建文件，却对包含新可执行文件的目录移动实施额外检查。

修复后必须依靠增强日志和目标机复测确认具体错误号。

### 2.4 当前安装路径限制

当前完整安装器不是只在界面上隐藏了目录选择，而是整条安装链都固定为 `%LOCALAPPDATA%\AURUM\LiangjianBridge`：

- Inno 使用 `DefaultDirName={localappdata}\AURUM\LiangjianBridge`、`DisableDirPage=yes` 和 `PrivilegesRequired=lowest`；
- 桌面快捷方式、开始菜单快捷方式和安装后启动路径都硬编码为 `{localappdata}`；
- 正式 Installer Backend 不接收 `--install-root`，只调用 `default_install_root()`；
- `register_installation()` 会拒绝非默认路径；
- Launcher 卸载布局 `InstallationLayout::current()` 和卸载边界也固定为 LocalAppData；
- 失败日志固定写入默认 LocalAppData 安装根。

自动更新协调器本身从正在运行的 `versions\<version>` 反推 `install_root`，核心路径解析基本可以适配任意本地安装根；但它需要对版本目录、缓存、状态指针和稳定 Launcher 保持写权限。默认改到 Program Files 后，如果只改 Inno 的 `DefaultDirName`，首次安装也许可以通过管理员权限完成，之后普通用户运行的自动更新和卸载仍会失败。

## 3. 范围与非目标

### 3.1 本次负责

- 修复首次安装发布 `versions\3.0.0` 的瞬时 I/O 失败。
- 修复自动更新暂存版本发布时的同类问题。
- 保证同版本修复失败时旧版本可恢复。
- 增强安装失败诊断信息和用户提示。
- 扩充 Rust 测试、完整安装器首次安装/同版本修复测试和 Windows 目标机验收。
- 在验证通过后，以新的发布身份重新构建 `3.0.0` 完整安装包。

### 3.2 本次不负责

- 不恢复 2.3.9 的 Nuitka onefile 安装和整包自更新方式。
- 不移除 3.0 的签名 Manifest、包签名、SHA-256、版本指针、健康检查或回滚机制。
- 不修改交易、账户绑定、命令执行、幂等、MT4/MT5 终端生命周期和服务器业务协议。
- 不让安装器关闭 MT4/MT5；只处理量见智桥自身进程。
- 不允许 HTTP/WSS 静默降级。
- 不借同版本重打包绕过自动更新的版本比较规则。
- 不把已有安装从 `%LOCALAPPDATA%` 静默迁移到 Program Files；已有完整安装的修复必须沿用登记路径。
- 不允许把文件直接安装到 `C:\Program Files` 根目录、磁盘根目录、Windows 系统目录、临时目录、UNC 或网络共享。
- 本方案不授权上传七牛、修改生产下载元数据、部署网站或激活发布指针。

## 4. 修复设计

### 4.1 建立共用的安全目录发布模块

在 `bridge/native/crates/bridge-update/src/` 增加独立的版本目录发布模块，例如 `release_publish.rs`，由安装器和自动更新协调器共同调用。

该模块只负责把一个已经验签、已解压并已完成布局校验的临时目录发布到同一 `versions` 根目录下，不负责网络下载、版本选择、Launcher 激活或业务进程控制。

输入至少包括：

- 受信任的 `versions` 根目录；
- 源临时目录；
- 目标版本目录；
- 已验证的 Release Manifest；
- 发布模式：首次发布或同版本修复；
- 受保护版本集合：当前 active、last-known-good 和 pending。

输出应区分：

- 原子重命名成功；
- 经重试后重命名成功；
- 经验证复制降级后成功；
- 失败阶段和稳定错误码；
- Windows `raw_os_error`、`ErrorKind`、尝试次数和总耗时，仅供本地诊断。

### 4.2 Windows 快速路径：有边界重试

目录发布仍优先使用同卷原子重命名，不改变正常机器的快速路径。

仅对明确可重试的 Windows 错误执行退避重试：

- `5`：Access denied；
- `32`：Sharing violation；
- `33`：Lock violation。

建议重试间隔为 `100 ms、250 ms、500 ms、1 s、2 s、4 s`，总等待不超过约 8 秒。每次重试前重新确认：

- 源目录仍位于受信任临时目录边界内；
- 目标路径仍是 `versions\<合法数字版本>`；
- 源和目标不是符号链接或 reparse point；
- 目标没有在并发操作中变成 active、last-known-good 或 pending 版本。

路径不存在、磁盘已满、路径非法、跨卷、非目录、边界异常等非瞬时错误不得盲目重试。

### 4.3 安全降级路径：验证复制，提交标记最后写入

如果新版本目标目录不存在、该目标没有被 `current.json` 的 active/last-known-good/pending 引用，且所有重命名重试仍因可重试错误失败，才可进入逐文件复制降级路径。该路径主要服务首次安装和高于当前版本的自动更新暂存，必须满足以下提交协议：

1. 使用 `create_new` 语义创建目标目录和文件，禁止覆盖并发产生的目标。
2. 拒绝源目录内的符号链接、junction 和其他 reparse point。
3. 复制 `.aurum-release.json` 以外的所有文件，逐项限制相对路径，禁止路径穿越。
4. 对源和目标递归清单进行一致性校验：相对路径、文件类型、长度和 SHA-256 必须一致。
5. 重新执行 `validate_native_release_layout()`。
6. 将已经验签的 `.aurum-release.json` 作为最后一个提交标记写入，并执行写穿透/同步。
7. 只有提交标记存在且完整校验通过，调用方才可以写 `current.json` 或进入激活流程。
8. 成功后清理源临时目录；清理失败只记录可诊断警告并交给受边界保护的后续清理，不把已成功发布误报为安装失败。

任何中途失败都必须把“没有有效发布标记的目标目录”视为未提交版本。后续恢复只能在确认该目录不是 active、last-known-good 或 pending 后删除或隔离；调用方必须保证在提交标记完成前不创建或切换指向该目录的版本指针。

降级路径不用于覆盖现有正式版本目录，也不用于同版本修复。因为同版本修复期间现有 `current.json` 仍引用 `versions\3.0.0`，把旧目录移到备份后再逐文件复制到该路径，会让并发启动的 Launcher 看到半成品。该场景只能使用带重试的原子目录换位；仍失败时立即恢复备份并保持原指针。

### 4.4 同版本修复与恢复

同版本修复采用以下顺序：

1. 停止并确认量见智桥自身进程已退出；不关闭 MT4/MT5。
2. 完整验证新的离线包并生成新版本候选目录。
3. 校验现有 `versions\3.0.0` 不是符号链接/reparse point，且属于当前合法安装根。
4. 使用同一套可重试移动逻辑，把旧目录移动到唯一 `.repair-backup-3.0.0-*`。
5. 使用带重试的原子目录移动，将新候选目录发布为 `versions\3.0.0`；禁止在同版本修复中逐文件复制到该路径。
6. 重新校验新目录、Release Manifest、Launcher 和必要文件后，更新健康指针及安装注册信息。
7. 只有新版本安装结果持久化成功后才删除备份。

如果第 5 至第 6 步失败：

- 删除或隔离未提交的新目录；
- 使用带重试的恢复操作把备份还原为 `versions\3.0.0`；
- 不修改原 `current.json`；
- 如果自动恢复仍失败，保留备份，返回独立错误 `bootstrap_repair_restore_failed`，日志必须记录备份的安装根相对路径，便于管理员恢复；
- 不静默删除唯一可用的旧版本。

首次安装不存在旧目录时不产生修复备份。

### 4.5 自动更新协调器同步修复

将 `stage_manifest()` 当前的一次性目录 `rename` 替换为共用发布模块，但保持以下更新契约不变：

- 只接受签名有效且 `target > current` 的 Manifest；
- 包大小、SHA-256、包签名和兼容性校验保持不变；
- 下载完成只代表 staged，不自动绕过维护租约和安全窗口；
- `current.json` 仍由 Launcher 原子切换；
- 新版本健康检查失败仍回滚到 last-known-good；
- 清理任务不得删除 active、last-known-good、pending 或正在恢复的目录。

更新器遇到无有效 `.aurum-release.json` 的残留目标目录时，先执行边界和保护版本检查，再做隔离/清理；若目标存在有效标记但 Manifest 与当前待发布 Release 不同，必须失败关闭，不能覆盖。

### 4.6 错误日志与用户提示

保留现有稳定错误码供 Inno 和脚本判断，同时增强 `%LOCALAPPDATA%\AURUM\LiangjianBridge\logs\installer-last-error.log`。建议记录：

- UTC 毫秒时间；
- 外部错误码；
- 阶段，例如 `create_versions`、`publish_rename`、`publish_copy`、`repair_backup`、`repair_restore`；
- `ErrorKind`；
- Windows `raw_os_error`；
- 重试次数和耗时；
- 只含安装根相对位置的源/目标标识，不写服务器密钥、Token、完整 Manifest 或用户隐私数据。

安装结果 JSON 可以增加可选诊断字段，但不能删除或改变现有 `ok`、`operation`、`version`、`install_root`、`error` 字段语义。

用户提示至少区分：

| 情况 | 建议提示 |
|---|---|
| 文件被占用/拒绝访问 | “安装文件暂时被安全软件或其他程序占用。安装程序已重试仍未完成，请稍后重试；如持续失败，请将错误日志交给管理员。” |
| 旧版本无法退出 | 引导用户从托盘退出量见智桥后重试 |
| 磁盘空间不足 | 明确提示释放系统盘空间 |
| 签名或完整性失败 | 明确提示安全校验失败并停止安装，不建议关闭安全软件 |
| 修复恢复失败 | 明确提示不要手工删除安装目录，并联系管理员使用保留备份恢复 |

不应把所有本地 I/O 失败继续描述为“检查网络”。

### 4.7 可自主选择安装路径

正式完整安装器恢复标准目录选择页：

- `DefaultDirName={autopf}\AURUM\LiangjianBridge`；在当前目标服务器上显示为 `C:\Program Files\AURUM\LiangjianBridge`；
- `DisableDirPage=no`；
- `PrivilegesRequired=admin`，安装开始前由 Windows 正常显示一次 UAC；
- `[Run]`、`[Icons]`、工作目录和所有后端参数统一使用 `{app}`，不再硬编码 `{localappdata}`；
- Inno 把规范化后的 `{app}` 通过 `--install-root` 明确传给 Rust Installer Backend；
- Rust 后端不信任 Inno 传入值，仍独立执行绝对路径、卷类型、reparse point、目录边界和可写性校验；
- 路径中包含空格、中文和较长目录名必须正常工作，参数传递不能依赖字符串拼接后的模糊解析。

允许的自定义路径必须是本机固定磁盘上的应用专用目录，例如 `D:\AURUM\LiangjianBridge`。必须拒绝：

- `C:\`、`D:\` 等磁盘根目录；
- `C:\Program Files` 本身，只允许其下的应用专用子目录；
- Windows、System32、Temp 等系统或临时目录；
- UNC、网络映射、可移动介质和设备路径；
- 安装目录自身或任一父级是符号链接、junction/reparse point；
- 已包含无关文件且不是已登记量见智桥安装的目录。

目录选择语义为：

1. 没有登记安装时，显示 Program Files 默认值，用户可以修改。
2. 已有完整安装时，从卸载注册的 `InstallLocation` 读取真实路径并用于同版本修复；目录页显示该路径但禁止在修复过程中改到另一个位置。
3. 已有 LocalAppData 版 3.0.0 不自动搬迁到 Program Files，避免丢失 `installation-id`、版本指针、更新状态和自定义服务器设置。
4. 用户确实要移动已有安装时，先通过受控卸载保留业务数据，再重新安装到新目录；跨目录迁移不与本次 I/O 修复混在一起。
5. 原故障机只有空 `versions` 和日志、且不存在有效 Launcher、`current.json` 和安装登记时，按未完成安装处理，可以直接选择新的 Program Files 默认目录。

### 4.8 Program Files 权限与自动更新

量见智桥仍按单个 Windows 用户运行。Program Files 安装不能简单地把整个 `C:\Program Files` 或 `AURUM` 父目录开放写权限，也不能要求每次自动更新都等待人工确认 UAC。

本次采用“管理员安装 + 应用目录内最小可写面”的方式兼容现有自动更新：

- 安装器以管理员权限创建应用目录，但只为实际运行量见智桥的目标用户设置必要 ACL；
- `versions`、`cache`、`logs`、`quarantine` 以及更新状态/指针所需文件允许该用户修改；
- 稳定 Launcher 只对其自身原子升级所需的受控文件开放替换权限；
- 固定发布公钥、安装注册边界和其他不参与更新的根文件保持只读；
- 不给 `Everyone`、`Users` 或其他本机账户授予整个安装目录的写权限；
- 如果 UAC 使用的管理员账户与实际运行 Bridge 的目标账户不是同一 SID，安装器必须停止并给出明确提示，不能把写权限误授给另一个账户；第一阶段不支持“管理员替其他普通用户安装”。

自动更新仍由普通用户进程执行，但只能写上述已授权范围，签名 Manifest、包签名、SHA-256、版本兼容、发布标记、健康检查和回滚要求保持不变。安装完成后必须用非提升状态运行一次真实递增版本更新，证明不是“管理员安装成功、普通用户更新失败”。

卸载入口也必须改为位置无关：Launcher 从自身绝对路径和登记的 `InstallLocation` 建立边界，不再假定 LocalAppData。删除 Program Files 安装时，卸载 Worker 使用 Windows `runas` 请求一次 UAC，只允许删除已登记且布局、Launcher、指针均验证通过的专用安装根；保留/删除用户数据的现有选择继续保留。

管理员权限只用于安装、同版本修复和卸载受保护文件，不得让 Bridge UI、Core、MT4/MT5 Worker 或日常交易通信长期以管理员身份运行。

## 5. 预计代码与测试改动范围

| 文件/模块 | 计划改动 |
|---|---|
| `bridge/native/crates/bridge-update/src/release_publish.rs` | 新增共用目录发布、重试、复制提交、边界校验和结构化诊断 |
| `bridge/native/crates/bridge-update/src/lib.rs` | 导出最小必要接口，不扩大业务职责 |
| `bridge/native/crates/bridge-update/src/coordinator.rs` | 用共用发布器替代一次性 `fs::rename`，保护残留目录恢复 |
| `bridge/native/apps/bridge-installer/src/lib.rs` | 首次安装和同版本修复接入共用发布器；支持合法自定义根、Program Files ACL、位置无关登记和增强错误描述 |
| `bridge/native/apps/bridge-installer/src/main.rs` | 正式模式安全接收 `--install-root`，把选定路径用于日志和结果；不破坏现有字段 |
| `bridge/native/apps/bridge-launcher/src/uninstall.rs` | 从自身路径和登记位置解析安装根；Program Files 卸载 Worker 受控提权 |
| `scripts/bridge-release/build-full-installer.ps1` | 启用目录页、默认 `{autopf}`、请求管理员权限，并把运行/快捷方式/后端路径统一改为 `{app}` |
| `scripts/bridge-release/test-local-full-installer.ps1` | 覆盖默认 Program Files 等价布局、自定义路径、首次安装、同版本修复、ACL、无残留、日志和失败恢复 |
| Rust 单元/集成测试 | 用注入式文件系统故障模拟重命名连续失败，不在生产二进制暴露测试开关 |
| 发布记录/安装器元数据 | 记录新 ReleaseId、Commit、哈希、签名状态、目标机验收和回滚对象 |
| `server/bridge-installer-release.js` 或等价生产环境变量 | 仅在远端安装器验收后更新公网下载描述；不属于代码修复阶段 |

实现时若发现无需修改 `main.rs` 即可安全保存诊断字段，可缩小该文件改动；不得为了日志方便扩大命令行参数或接受任意安装路径。

## 6. 验证方案

### 6.1 Rust 自动测试

新增并验证以下场景：

1. 首次原子重命名成功，不进入降级复制。
2. 前 N 次返回错误 5/32/33，随后重命名成功。
3. 可重试错误持续存在，进入验证复制并成功提交标记。
4. 非可重试错误立即失败，不做无意义重试。
5. 复制中断时目标没有有效发布标记，不能被描述为 staged，也不能生成指向它的版本指针。
6. 复制目标的路径、长度或 SHA-256 不一致时失败并清理。
7. 符号链接、junction/reparse point、路径穿越和越界目录被拒绝。
8. 并发生成目标目录时失败关闭，不覆盖已有内容。
9. 同版本修复新版本失败后旧目录和原指针恢复。
10. 恢复失败时保留唯一备份并返回独立错误。
11. active、last-known-good、pending 目录永不被残留清理逻辑删除。
12. 日志保留原始 Windows 错误号，但不泄露敏感值。

### 6.2 仓库验证命令

实施完成后至少运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bridge-release/test-release.ps1
```

该脚本应继续覆盖 Rust `fmt`、Clippy、Cargo workspace tests 和 Node 发布测试。不得以单个 crate 测试替代工作区验证。

随后使用测试签名材料运行完整安装器演练：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bridge-release/test-local-full-installer.ps1 `
  -ReleaseDirectory <test-release-directory> `
  -PublicKey <test-public-key> `
  -OutputDirectory <new-empty-output-directory>
```

必须通过首次安装和同版本修复，并确认：

- `versions\3.0.0` 完整；
- `.aurum-release.json` 有效且最后提交；
- `current.json` 为 healthy；
- Launcher 能启动并通过健康检查；
- `.bootstrap-*`、未提交版本目录和 `.repair-backup-*` 没有异常残留；
- 产品版本、安装器元数据和模块版本均为 `3.0.0`。

目录与权限演练还必须覆盖：

- 全新安装默认值解析为系统 Program Files 下的 `AURUM\LiangjianBridge`；
- 安装到另一个本地固定磁盘路径；
- 路径包含空格和中文；
- 拒绝磁盘根、Program Files 根、系统目录、临时目录、UNC、网络盘和 reparse point；
- 已登记安装的同版本修复沿用原 `InstallLocation`，不能在修复时产生第二套安装；
- 实际运行用户可以写更新所需目录和文件，但不能修改发布公钥，也不能写 Program Files/AURUM 父目录的无关位置；
- 普通非提升 Bridge 进程可以完成一次真实递增版本暂存、发布、激活和回滚；
- 卸载只在受保护文件删除阶段请求 UAC，并继续正确处理“保留数据/删除数据”。

自动更新链路继续用两个递增的测试版本演练：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bridge-release/prepare-local-update-rehearsal.ps1 <required-parameters>
powershell -ExecutionPolicy Bypass -File scripts/bridge-release/test-local-client-update.ps1 <required-parameters>
```

两个版本必须满足 `SecondVersion > FirstVersion`，用于证明修复后的目录发布不会破坏正常自动更新、重启恢复、地址保留和回滚。不能用两个相同的 3.0.0 假装验证自动更新。

### 6.3 故障机验收

在 Windows 10 Enterprise LTSC 19044 的原故障账户上使用最终候选安装包：

1. 保留现有 `logs` 作为证据，确认没有 Bridge 进程。
2. 直接重新运行候选 3.0.0 安装包，确认目录页默认显示 `C:\Program Files\AURUM\LiangjianBridge`，并正常完成一次安装 UAC；不要求用户关闭或卸载安全软件。
3. 验证安装结果的 `install_root`、卸载登记、快捷方式和 Launcher/UI/Core 全部指向实际选择目录，服务地址正确、健康状态正常。
4. 验证 MT4/MT5 发现和连接，不关闭终端、不改变账户绑定。
5. 再运行同一安装包执行同版本修复，确认配置、安装身份和服务器覆盖设置保持不变。
6. 收集成功日志中的发布路径、重试次数和原始错误号；若走了降级复制，明确记录。
7. 重启 Windows 后再次验证 Launcher、Bridge 和更新检查。
8. 以普通非提升状态完成一次测试渠道的递增版本更新，确认 Program Files 权限没有破坏自动更新。

原故障机首次安装和同版本修复均通过，才可认为本故障已闭环。开发机测试通过不能替代该项。

## 7. 仍以 3.0.0 重新打包的发布规则

### 7.1 版本与发布身份

用户可见版本仍为 `3.0.0`，以下字段必须一致：

- Release Manifest `release_version` 和全部 package `version`；
- Rust workspace/package 版本；
- Native UI、Core、Launcher 的 PE ProductVersion；
- MT5 Worker `WORKER_VERSION`；
- MT4 EA `#property version`；
- Rust MT4 adapter 当前版本常量；
- Inno `AppVersion`、安装器文件版本和 `bootstrapper-metadata.json`；
- 官网下载说明中的版本。

兼容握手版本如果本来就不是产品版本，只按既有协议验证，不能为追求表面一致而擅自修改。

`bootstrapper-metadata.json` 还应增加不影响现有读取方的可选审计字段，例如 `default_install_root_kind: "program_files"`、`directory_selection_enabled: true` 和 `requires_admin: true`；正式验证脚本必须确认这三项与实际 Inno 配置一致。

同版本重打包必须创建唯一的新 `ReleaseId`，例如由脚本生成 `bridge-3.0.0-<UTC timestamp>`。新 core 包内容变化后会得到新的 SHA-256 和内容寻址路径 `bridge/releases/3.0.0/<sha256>/<module>.zip`；任何已存在的七牛对象都不得覆盖。完整安装器必须继续使用脚本规定的 `bridge/bootstrapper/<installer-sha256>/LiangjianBridgeSetup.exe`，由新安装器哈希保证对象唯一，不能人为改成固定的 3.0.0 文件名并覆盖旧包。

新完整安装器的 `bootstrapper-metadata.json.release_id`、内嵌 Manifest 的 `release_id` 和准备提升的 bootstrap Manifest 必须一致；版本均为 `3.0.0`。上传后先运行远端安装器校验并重新下载核对字节，再更新 `server/bridge-installer-release.js` 或等价生产环境变量中的 URL、大小、SHA-256 和构建日期，最后才允许切换公网下载入口。

### 7.2 同版本发布范围

本次 3.0.0 发布只把修复送入：

- 新的完整离线安装器；
- 供新安装/人工修复使用的新 bootstrap 发布材料；
- 官网下载描述在全部远端验证通过后的新安装器指针。

日常 `current` 自动更新指针默认保持不变。原因是当前客户端对 `target <= current` 返回“不更新”，切换到新的 3.0.0 ReleaseId 既不能自动修复现有客户端，还会制造运维认知混乱。

未来发布高于 3.0.0 的正常版本时，修复后的更新器能力会随新 core 一并覆盖现有客户端。若业务要求在不提升版本号的情况下自动替换所有现有 3.0.0，需另立方案，至少补充 ReleaseId 单调性、防重复更新、防回滚循环、staged 状态恢复和 Launcher 激活协议测试。

### 7.3 分阶段授权边界

实施和发布分为以下独立阶段，上一阶段完成不自动授权下一阶段：

| 阶段 | 内容 | 完成证据 |
|---|---|---|
| A. 代码修复 | 只修改本方案列出的发布、安装和测试代码 | 范围清晰的 diff 与代码复审 |
| B. 本地验证 | Rust/Node 全套测试、安装器演练、两版本更新演练 | 命令、退出码、结果 JSON、日志 |
| C. 目标机候选验收 | 在 LTSC 19044 验证 Program Files 默认安装、自定义路径、同版本修复和非提升自动更新 | 安装目录、ACL、注册、进程、更新、健康和日志证据 |
| D. 正式构建与签名 | 从确认的干净提交构建新的 3.0.0 ReleaseId | Commit、ReleaseId、Manifest、包哈希、签名报告 |
| E. 上传不可变对象 | 上传模块和完整安装器，不覆盖旧对象 | 远端 key、大小、重新下载 SHA-256 |
| F. 源码/网站部署 | 部署下载元数据所需代码或静态描述 | 远端 commit、进程和公开接口健康 |
| G. 下载/bootstrap 切换 | 切换新用户和人工修复入口 | 公网 API、CDN 下载、签名、哈希、安装复测 |
| H. 日常更新激活 | 本次默认不切换同版本 `current` | 如需变更，另行授权和记录 |

如果没有 Authenticode 证书，正式发布前必须单独记录“未签名安装器”的风险接受。不能把关闭杀毒软件作为安装说明或验收条件。

## 8. 回滚方案

发布前保留当前公网安装器描述、旧 bootstrap 指针和所有不可变对象。

如果新安装器出现问题：

1. 停止扩大下载入口；
2. 把官网安装器描述恢复到上一份已验证对象；
3. 使用既有 bootstrap 回滚流程恢复上一稳定 bootstrap 指针；
4. 不删除新旧七牛对象，保留审计和复盘证据；
5. 日常 `current` 未在本次同版本发布中切换，因此不需要回滚自动更新指针；
6. 对已运行失败候选安装器的机器，优先使用其 `.repair-backup-*` 和原 `current.json` 恢复，不直接删除整个安装根。

## 9. 验收标准

以下条件全部满足才算修复完成：

- 原故障机首次安装新的 3.0.0 成功。
- 原故障机再次运行同一安装包完成同版本修复。
- 正常路径仍优先使用原子重命名；瞬时 5/32/33 错误可重试恢复。
- 重命名持续失败时，验证复制路径不会暴露带有效标记的半成品。
- 任意失败都不损坏 active、last-known-good、pending 和同版本修复备份。
- 安装器日志可以定位到失败阶段和 Windows 原始错误号。
- 自动更新的递增版本演练、健康检查、地址保留和回滚通过。
- `test-release.ps1`、完整安装器演练和相关新增测试全部通过。
- 全新安装默认目录为 `C:\Program Files\AURUM\LiangjianBridge`，且用户可以在目录页选择其他合法本地固定磁盘目录。
- 已登记安装的修复沿用原路径，不产生两套 Launcher、两份卸载登记或两个 installation-id。
- Program Files 安装完成后，Bridge 日常运行不提权，普通用户自动更新演练通过；ACL 不扩大到 Program Files/AURUM 父目录或其他本机用户。
- 自定义路径下的快捷方式、安装注册、日志、自动更新、回滚和卸载全部使用实际 `InstallLocation`。
- 正式包所有用户可见版本保持 `3.0.0`，使用唯一新 ReleaseId。
- 上传后重新下载的远端安装器和模块大小、SHA-256 与本地记录一致。
- 公网下载入口只有在安装器远端复测通过后才切换。

## 10. 第一轮复审：正确性与数据安全

复审重点：是否只用重试掩盖问题、降级复制是否破坏原子性、同版本修复是否可能丢失旧版本、诊断日志是否泄露敏感数据，以及 Program Files 自定义路径是否破坏安装边界和权限模型。

发现的问题：

1. 仅增加重试仍可能在长期扫描或企业 EDR 环境失败。
2. 直接复制到正式目录会让 Launcher 看见半成品。
3. 同版本修复即使先备份旧目录，若再逐文件复制到仍被 `current.json` 引用的同名路径，Launcher 也可能看到半成品。
4. 记录完整路径和 Manifest 可能泄露用户名、服务器信息或签名材料。
5. 只修改 Inno 目录页无效：正式后端、登记、快捷方式、日志和卸载仍固定 LocalAppData。
6. 直接让整个 Program Files/AURUM 或所有本机用户可写，会扩大本机篡改面。
7. 同版本修复时允许随意改目录，会留下两套版本指针、两个 installation-id 或无法卸载的旧目录。

据此已调整方案：

- 保留原子重命名快速路径，同时增加严格的验证复制降级路径。
- 明确 `.aurum-release.json` 最后提交；无标记目录永不允许激活。
- 复制降级只允许用于未被任何版本指针引用的新目标；同版本修复必须使用带重试的原子换目录。
- 同版本修复必须先创建唯一备份，失败时恢复；恢复失败也不得删除备份。
- 清理逻辑必须保护 active、last-known-good、pending 和修复备份。
- 日志只记录安装根相对路径、稳定错误码和 Windows 错误号，不记录密钥、Token 或完整 Manifest。
- 路径支持必须贯穿 Inno、Rust 后端、注册、快捷方式、日志、Launcher 和卸载，统一以已验证的实际 `InstallLocation` 为准。
- Program Files 只给目标用户开放更新所需的最小可写面，不开放父目录、不授权其他用户，日常 Bridge 进程不提权。
- 已登记安装的修复锁定原路径；移动安装必须通过卸载后重装的独立流程。

第一轮结论：调整后可以进入实施，但必须通过注入式故障测试证明所有失败分支。

## 11. 第二轮复审：发布与运维可执行性

复审重点：同版本重打包是否会误触发自动更新、版本和对象是否可审计、目标机是否真正覆盖、Program Files 下普通用户更新是否可执行，以及失败后能否快速撤回。

发现的问题：

1. 新 ReleaseId 不会改变当前更新器的 `target <= current` 判断，同版本不能自动覆盖现有 3.0.0。
2. 若覆盖旧 CDN 对象，缓存和回滚将不可控。
3. 只在开发机验证无法证明 Windows 10 LTSC 19044 的问题已解决。
4. 把构建、上传、网站部署和指针切换连在一起，会扩大一次授权的风险。
5. 如果安装器元数据、内嵌 Manifest 与 bootstrap 指针使用不同 ReleaseId，后续审计无法准确确认新安装入口使用了哪组包。
6. Program Files 首次安装通过不能证明自动更新可用；管理员令牌可能掩盖普通用户写权限问题。
7. 如果提权账户与实际运行 Bridge 的账户不同，ACL、HKCU 登记和快捷方式可能归属错误用户。

据此已调整方案：

- 明确本次新 3.0.0 仅服务首次安装和人工同版本修复，`current` 默认不切换。
- 强制使用唯一 ReleaseId、内容寻址模块对象和唯一安装器对象，禁止覆盖。
- 明确安装器对象键使用现有 SHA-256 路径，并要求安装器元数据、内嵌 Manifest 和 bootstrap 指针的 ReleaseId 对齐。
- 把原故障机首次安装、再次修复和重启后验证设为发布前停止线。
- 把代码、本地验证、目标机验收、正式构建、上传、部署、下载/bootstrap 切换和日常更新激活拆成独立授权阶段。
- 增加 Program Files 默认路径、自定义固定磁盘路径、空格/中文、非法路径、登记路径修复和卸载测试。
- 把“普通非提升状态完成一次递增版本更新”设为 Program Files 安装验收停止线。
- 第一阶段拒绝管理员替另一个普通用户安装，避免 SID、ACL 与 HKCU 归属不一致。

第二轮结论：方案可实施；在目标机验收通过前，不应替换公网下载入口。

## 12. 剩余风险

- 当前尚未取得故障机的 Windows 原始错误号，杀毒/EDR 占用仍是推断；增强日志后的第一次复测才能确认。
- 企业安全软件也可能持续阻止逐文件写入，此时安全降级仍会失败，但会给出可定位证据，不能通过关闭安全校验来规避。
- 未做 Authenticode 签名的安装器仍可能触发 SmartScreen 或企业策略；目录发布修复不能解决代码签名信誉问题。
- 已安装的旧 3.0.0 不会自动获得同版本修复；本次只能通过人工运行新安装器修复，或等待未来更高版本更新。
- “提交标记最后写入”不能代替版本指针隔离；实施时必须证明复制目标在提交完成前不被 active/last-known-good/pending 引用，不能只测试复制函数。
- 同版本修复期间如果操作系统崩溃，仍可能留下备份或无标记目录；启动恢复和下一次安装必须验证其可安全识别和处理。
- Program Files 下的最小可写 ACL 比现有 LocalAppData 模型更复杂，任何漏项都可能表现为安装成功但更新、Launcher 提升或卸载失败，必须做真实非提升测试。
- 企业 Windows 可能通过组策略禁止修改 Program Files 子目录 ACL，遇到此类环境应明确报出权限策略错误，不能回退为给 `Users`/`Everyone` 整目录写权限。
- 第一阶段不支持管理员替其他 Windows 普通用户安装；如果后续有多用户/域账号部署需求，需要单独设计机器级安装、账户选择和服务化更新模型。

## 13. 2026-08-08 实施记录

本轮已完成代码和本地验证，正式版本仍保持 `3.0.0`，尚未执行生产签名、上传、网站部署或公网入口切换。

已完成：

- `bridge-update` 新增统一发布事务：原子重命名快速路径、Windows 5/32/33 有界退避、仅对未被版本指针保护的新版本启用校验复制降级、提交标记最后写入，以及同版本修复备份/回滚。
- 安装器把版本目录、稳定 Launcher、版本指针、公钥、渠道、注册表和 ACL 纳入失败恢复；日志保留阶段、Windows 原始错误号和尝试次数，不记录敏感完整路径或 Manifest。
- 生产安装器默认目录改为 `{autopf}\AURUM\LiangjianBridge`，开启目录选择并要求管理员权限；已登记安装锁定原 `InstallLocation`，新目录必须是合法本地固定磁盘专用目录。
- 安装根按当前 Windows 会话用户 SID 设置最小权限；稳定 Launcher、更新状态和必要工作目录可更新，公钥与独立卸载 Helper 保持受保护。
- 卸载改为由稳定 Launcher、HKCU `InstallLocation` 和受保护 Helper 交叉校验真实安装根；拒绝 UNC、磁盘根、系统/临时目录、reparse 路径和跨根删除。
- Inno 快捷方式改为当前用户桌面和开始菜单；正式后端显式接收 `{app}` 作为安装根。
- 修正本地原生测试脚本，显式准备 Debug Core 所需的回环端点和 MT5 文件，避免测试依赖旧构建残留；更新发布工具对新卸载契约的静态断言。

已验证：

- `cargo fmt --all -- --check` 通过。
- `cargo clippy --locked --workspace --all-targets -- -D warnings` 通过。
- `cargo test --locked --workspace` 通过；涉及发布事务、安装、修复、ACL、注册和卸载边界的新增测试均通过。
- `scripts/bridge-release/test-release.ps1` 通过：57 个 Python 测试和 2526 个 Node 测试通过，Rust workspace 全部非忽略测试通过。
- 正式配置 DryRun 通过，确认默认 Program Files、目录页开启、管理员安装和当前用户快捷方式元数据。
- Inno 6.7.3 已实际编译隔离测试安装器；使用现有生产签名 3.0.0 离线包完成临时目录首次安装和同版本修复，修复哨兵被替换、无残留 repair backup、`current.json` 保持 healthy，Core 三项健康检查通过。

尚未验证、不得据此切换公网入口：

- 当前仓库只有生产端点签名包，完整的回环生命周期脚本按设计在端点隔离断言处停止；需要重新生成匹配回环端点的测试签名包后，才能把该脚本记为完整通过。
- 尚未在 Windows 10 Enterprise LTSC 19044 原故障机上完成 Program Files 首次安装、再次同版本修复、重启验证和原始错误号采集。
- 尚未以普通非提升用户在真实 Program Files ACL 下完成一次更高版本自动更新、Launcher 原子替换、回滚和卸载。
- 尚未完成正式 Authenticode 签名、唯一 ReleaseId 重打包、远端上传/回读校验、bootstrap 切换和公网下载复测；这些仍是独立授权阶段。
