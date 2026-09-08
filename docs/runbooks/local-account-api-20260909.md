# 本地账户 API 联调环境

范围：本地 API、Redis 与现有 dev_vue MySQL；仅启用 api-v4，没有启动 Bridge、调度器或交易 Worker。当前完成健康检查与认证基础链路，成功登录、浏览器及账户/观摩命令仍待验收。

## 运行配置

- API：127.0.0.1:3010，启动源码为`scripts/run-local-account-api.mjs`，运行已构建的api-v4入口。
- Redis：127.0.0.1:16379，Redis 8.2.6，使用密码，128 MB、noeviction，不启用磁盘持久化；仅存本地联调短期状态。
- MySQL：读取server/.env，保留192.168.31.254/dev_vue及原应用账号。没有将Redis继续指向旧VM网段，也没有修改server/.env。
- Origin：www localhost:3100、trade localhost:4174、admin localhost:4175、auth localhost:4176。HTTP开发Cookie关闭Secure；正式环境不能复用此配置。
- 私有配置：`D:/dev_codex/.local-runtime/dev-vue/account-api.env`；包含新生成的本地Redis密码、CSRF/BFF密钥、ES256 PKCS8私钥，不入库、不写入聊天。目录ACL只授予当前Windows账号和SYSTEM。

Redis采用[redis-windows社区8.2.6发布](https://github.com/redis-windows/redis-windows/releases/tag/8.2.6)的MSYS2便携包，不是Redis官方Windows二进制。文件名Redis-8.2.6-Windows-x64-msys2.zip，大小12328034字节，SHA-256为`c7f5a518d300e1019675ca32ab39c8e7e5b9677d3f9840514a8144236689a69b`，与发布页及GitHub资产摘要核对一致。解压前核对路径均位于专属目录内；未安装Windows服务或修改防火墙。二进制位于`D:/dev_codex/.local-runtime/dev-vue/redis-8.2.6/Redis-8.2.6-Windows-x64-msys2/redis-server.exe`。

## 启停与复验

先核对目标端口和既有进程；已有健康进程时复用，不因观察超时重复启动。当前两个可见PowerShell控制台分别由私有目录的start-redis.ps1、start-api.ps1承载；控制台启动时间及PID需在每次操作前实查。Redis配置路径及dir参数在该构建中使用`/cygdrive/d/...`，不能直接使用D:/格式。初次错误路径导致Redis退出、API连接失败；修正后原失败进程已终止，当前实例健康。

1. Redis启动后使用私有配置中的密码验证PING及INFO版本，再启动API。
2. API启动前运行`pnpm run build:server:v4`。从项目根目录执行`node scripts/run-local-account-api.mjs D:/dev_codex/.local-runtime/dev-vue/account-api.env`。该入口只允许本地覆盖键，拒绝覆盖MySQL目标及非回环地址。
3. 运行`node scripts/verify-local-account-api.mjs D:/dev_codex/.local-runtime/dev-vue/account-api.env <新绝对路径回执.json>`。回执路径必须未存在。
4. 停止时只操作核实属于本次控制台的进程。正常关闭API控制台后核对3010释放；Redis用带认证的SHUTDOWN NOSAVE后核对16379释放。不得按进程名称批量结束其它开发服务。

## 已验证事实

[2026-09-09回执](../architecture/local-account-api-smoke-20260909.json)包含8项真实HTTP检查：live/ready均200、auth发现与ES256公钥200且无私钥字段、错误auth Host为404、匿名trade会话401、登录开始302并确实写入本地Redis事务、不存在凭据401且不创建会话Cookie。脚本清理它自己生成的登录事务，不清空Redis。探针使用node:http保留Host，初次使用fetch时Host被改回连接地址，导致预期之外的404，未修改服务的域隔离规则。

本地环境覆盖8项单元测试通过。首次自动探针错误读取嵌套error.code而失败，实际认证合同为顶层code；失败回执保留在[2026-09-08记录](../architecture/local-account-api-smoke-20260908.json)，修正探针后通过。该故障不代表服务认证失败。

下一步使用独立、可清理的本地联调数据验证成功SSO与账户命令，保留真实旧用户/账户数据；补齐trade开发代理并进行浏览器会话、切换、权限拒绝与未知结果恢复。成功登录、正向观摩、真实终端、交易及公网均未由本记录证明。
# 成功 SSO 追加验证（2026-09-09）

在现有本地 API/Redis 及 auth 4176、trade 4174 Vite 进程运行时执行：

```powershell
node scripts/verify-local-account-sso.mjs D:/dev_codex/.local-runtime/dev-vue/account-fixture.json D:/dev_codex/dev_vue/docs/architecture/local-account-sso-20260909.json
```

输出文件必须不存在；重复验证使用新的回执文件名。夹具文件必须是预先独立创建的 `local-account-fixture/v1` 开发用户，包含随机 example.invalid 邮箱、密码、用户 ID 和 dev_vue 身份信息；不得替换为现有真实用户。本脚本不创建用户、不运行 SQL、不打印凭据，只访问固定回环 Vite 端口。当前夹具保存在仓库外受限目录，不能提交。

成功路径验证登录、代码交换、会话和三种空列表，最后通过各自 logout 接口撤销本次持有的两个会话，再发送旧 Cookie 验证拒绝。保留夹具用户、已撤销会话及审计历史，不能将其称为数据库零写入或夹具全清理；先前探针产生的会话不属于本次撤销范围。失败阶段与撤销失败分别记录，失败时应先核对回执再重试；未消费的登录事务由既有 Redis TTL 过期。

本次回执 8 项通过；代理网络测试、trade 类型和前端边界检查通过。验证不包含正向账户授权、观摩、上下文写入、浏览器交互或终端交易。
