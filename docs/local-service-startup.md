# 本地服务启动复用流程

用户于 2026-09-16 要求：以后类似本地启动操作复用本次成功方式，并保留显式控制台。

统一入口现为 `scripts/local-v4.ps1`，使用方法及外部实例处理见 [V4 本地统一启停](local-v4-runtime.md)。以下保留单服务启动成功记录，供诊断与应急使用。

## Bridge 网关：已验证命令

工作目录：`D:/dev_codex/dev_vue`。
先读取既有脚本并检查 3012 是否监听；已有健康实例则复用，不重复启动。需要重启时核对进程身份，只停止明确属于目标服务的进程。

```powershell
Get-Content D:/dev_codex/.local-runtime/dev-vue/start-bridge-gateway.ps1
Get-NetTCPConnection -LocalPort 3012 -State Listen -ErrorAction SilentlyContinue

Start-Process -FilePath 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe' `
  -ArgumentList @('-NoProfile','-NoExit','-File','D:/dev_codex/.local-runtime/dev-vue/start-bridge-gateway.ps1') `
  -WorkingDirectory 'D:/dev_codex/dev_vue' -WindowStyle Normal -PassThru
```

既有脚本设置网关监听 `127.0.0.1:3012`、启用 V4 运行时，执行 `server/dist-v4/entrypoints/bridge-gateway.js`，并通过 Tee-Object 将输出写入 `.local-runtime/dev-vue/bridge-gateway.log`。脚本属于本机运行配置；其他机器必须重新核对路径与配置，不直接照搬。

启动与验收使用独立工具调用：

```powershell
Invoke-RestMethod http://127.0.0.1:3012/health/ready
Invoke-RestMethod http://127.0.0.1:3012/health/live
```

## 本次证据与边界

- 2026-09-16 11:15（Asia/Shanghai）上述 Start-Process 调用成功，控制台宿主 PID 为 83724；PID 不可作为未来操作目标复用。
- 网关返回 `ready=true`、`accepting=true`、`dependencies_ready=true`、`connections=1`、`lastErrorCode=null`。
- 启动明确指定 Normal 和 NoExit；进程查询返回 MainWindowHandle=0，未通过窗口截图确认显示状态，不能将该字段作为启动失败依据。
- 以上证明网关健康并已有一个连接，不等于行情、账户同步、分析、交易执行全链路验收。

## 审批和复用

### Windows PowerShell 的 stderr 处理（2026-09-16 补充）

`ErrorActionPreference='Stop'` 下，把原生 Node 输出用 `2>&1` 接入管道，会把普通 stderr 输出提升为 `NativeCommandError` 并中断管道。已用只输出数字、没有网络或文件副作用的 Node 程序复现。服务控制台可能还在而 Node 已退出，不能仅检查 PowerShell PID。

对长期运行的 Node 调用，在完成启动前置检查后将该段 `ErrorActionPreference` 设为 `Continue`，保留 stderr 和日志显示。不要把非零退出码当成功；健康端点和进程必须单独核对。本机 start-bridge-gateway.ps1 与 start-public-market.ps1 已修正此输出处理；后者改为直接运行 Node 并 Tee-Object，而非隐藏子进程。

11:23 重启网关后，首页实际显示“连接正常”“交易中”“公共行情实时更新”，并出现新报价与浮动盈亏。此前 Node 退出的完整终止异常未留存，因此 stderr 机制已复现，但不能将它描述为该次退出的唯一已证实原因。自动分析仍显示等待调度，本轮没有恢复分析或交易执行 Worker。

- 本次在 workspace-write 沙箱下，读取受限的既有脚本、启动本机网关及访问健康端点，分别通过工具的 `sandbox_permissions=require_escalated` 自动审批成功。
- 以后先遵守当次工具权限；确有沙箱限制且允许提升时，使用正式审批并说明用户授权、目标服务和范围。不得在禁止提升的会话中添加该参数。
- 不重复请求已有范围内的口头授权。若自动审批仍拒绝，记录具体理由并停止受阻动作，不换工具或变形命令规避。
- 本次成功不证明之前失败由隐藏窗口、日志目录或合并命令造成；当时只返回 blocked by policy，根因未知。
- 类似本地服务复用方式，替换为该服务已有启动脚本、端口和健康端点。保留可见控制台供用户查看输出；关闭该控制台可能终止服务。
