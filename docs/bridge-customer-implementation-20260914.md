# 桥接客户接入实现记录

日期：2026-09-14。对应已确认方案 `bridge-customer-authorization-and-terminal-selection-20260914.md`。

## 已实现的客户路径

1. 软件点击“连接账号”，打开交易前端 `/bridge/authorize?request=…`。网页展示设备、当前用户、有效期，由用户明确同意或拒绝。链接不携带凭据。
2. 安装实例授权持久保存于当前 Windows 用户的 DPAPI 加密文件。新增终端各自登记独立档案凭据；软件重启、请求丢响应和重复点击均可恢复。10 分钟只限制待审批请求，已批准授权的迟到轮询仍返回批准状态。
3. 软件显示账号、基础额度、增购额度、总量、已用与可用。数字来自服务端现有用户全局额度与租约快照；查询失败显示待核实，不显示虚假的零占用。退出账号撤销安装及其子档案凭据，保留历史与本地账本。
4. MT4 增加“安装 MT4 EA”：用户在目标 MT4 中打开数据文件夹，再在软件选中该目录。仅写所选 `MQL4/Experts`；不同内容覆盖需确认并保留备份，也可导出 EA。用户仍须在 MT4 刷新导航器、加载 EA 并允许所需 DLL。
5. MT5 支持运行中终端列表、手填路径、文件选择、拖入程序/文件夹/桌面 `.lnk`。快捷方式只解析目标及 `/portable`，不执行任意参数或脚本。未运行的终端提示用户先自行打开。
6. MT5 识别校验实际程序目录和实际数据目录，并将 portable/data path 带入连接与查询 Worker；修改路径或模式后要求重新识别。自动发现不是全部环境下的完美保证。
7. 私有运行时固定官方 Python 3.8.10 x64、MetaTrader5 5.0.5735 cp38、NumPy 1.24.4，构建验证上游 SHA256、Python 签名及实际模块导入，包含 Worker 伴随模块。客户无需填写 Python/Worker 路径。MT5 路径要求 64 位系统，不能把 x86 Bridge 主程序兼容性等同于 MT5 Worker 支持 32 位系统。

原配对码路径保留为次级入口。配置中的 API 与网站可使用明确的不同子域，API 与 Bridge 网关保持同主机；本地可使用不同端口。所有服务地址由构建配置提供。

## 修复与复核

- 允许合同定义的 nullable 预期状态；缺字段及不允许的 null 仍拒绝。
- uncertain 命令跨多轮查询和重启保留对账上下文，不重发实际交易动作。
- 编辑连接参数必须先停止旧运行实例，停止失败不保存新配置。
- 同 Windows 用户、同配置目录只允许一个软件实例。
- 网页按请求及用户作用域丢弃迟到响应，使用服务端时间判断期限；写入具备 CSRF、幂等键、版本及当前主体校验。
- 新授权凭据与旧 V4 档案凭据保持隔离；服务端撤销覆盖换票与网关复验路径。

后端两轮复核及迁移限制见 `bridge-installation-backend-implementation-20260914.md`。

## 构建与验证

独立产物目录：`bridge/prototypes/net48-win7/artifacts-review/`。本次没有关闭或替换 `artifacts/` 中正在运行的旧程序。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File bridge/prototypes/net48-win7/build.ps1 -BuildDirectoryName artifacts-review -ClientConfigPath bridge/prototypes/net48-win7/bridge-client.local.json.example
powershell -NoProfile -ExecutionPolicy Bypass -File bridge/prototypes/net48-win7/test.ps1 -BuildDirectoryName artifacts-review
```

本地 example 只用于开发，软件 API 和网页均访问 trade 4174（代理到内部 API 3010并保留 trade Host），Bridge gateway 为 3012。正式安装包必须显式提供非 loopback HTTPS 配置；缺配置不能发布。源码离线构建可不带配置，但界面会提示配置缺失。

已通过：前端授权/配对 8 项、API 客户端 4 项、trade 构建、contracts/api-client/trade 类型检查、HTTP 合同及类型/运行 Schema 生成一致性、前端边界；后端新授权及相关凭据 34 项、迁移来源/冻结前缀 4 项。服务端完整类型检查及相关旧配对/运行时测试也已通过。MT5 Python 81 项通过。当前 MT4 EA 使用真实 MetaQuotes 签名 MetaEditor 从源码编译，0 errors、0 warnings，源与产物哈希清单已校验。

浏览器检查了真实本地 trade 引导页的桌面和 390px 手机布局、无请求参数的授权页错误提示。尚未在浏览器点击真实授权或调用真实终端识别，不能将 Mock/离线结果称作完整联调。

最终统一验证：全部修改停止后，Windows PowerShell 5 重新完整构建 `artifacts-review` 成功；该产物全部 .NET smoke 通过，包含安装授权、API/网关分端口、单实例、MT4 手动安装、快捷方式和 portable/data path 子进程传参回归。服务端完整类型检查再次通过。

## 尚待完成的运行验收

2026-09-14 获得用户单独授权后，028/080 已在独立参考库通过真实 MySQL 验证，三份参考库均已删除。随后完成业务库新备份及独立恢复，执行 080 并追加一条默认排序规则纠正日志，最终 272 条 completed、318 张表；314 张原业务表数据摘要和原计划 checksum 不变，完整重跑无 DDL。新 API 与 gateway 已启动，真实依赖健康及 HTTP 拒绝路径验证通过，详见 `bridge-installation-current-migration-20260914.md`。旧桌面窗口尚待用户保存/关闭，review 产物未替换旧运行进程。

仍需真实 SSO → 软件批准 → 新档案 → HTTP 换票 → WS → MT4/MT5 识别及撤销链路验收；Win7 实机兼容性没有本次证据。没有执行真实交易、部署、安装器发布或上传。

仓库存在大量此前未提交改动，包含共享 API 合同、生成物及后端迁移链依赖。本次文件保留在工作区；在不能安全拆分这些依赖前，不进行混合提交或推送。

## 临时目录清理例外

以下两个隔离测试目录的删除请求被自动审批策略拒绝。工具未给出更具体原因，未绕过限制：

- `D:\dev_codex\.local-runtime\bridge-command-audit-test`
- `C:\Users\Administrator\AppData\Local\Temp\bridge-instance-test-2d27fcefc4624b9681967475612f8d18`

`artifacts-review` 为本次可审查构建产物，`.packages` 为已校验运行时依赖缓存，均保留且不纳入源码提交。
