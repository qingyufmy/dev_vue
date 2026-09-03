# 阶段 9：三前端工程与设计系统骨架验收记录

> 状态：已完成
>
> 日期：2026-09-03
>
> 范围：`www` 主站、`trade` AI 交易实验室、`admin` 管理后台及其共享前端基础包

## 1. 本阶段结果

- 删除版本树中旧 `public/` 手写 HTML、CSS、JavaScript、内置 vendor 和旧字体，共 156 个旧路径；不保留兼容页面、双路由或旧运行时代码。
- 建立 `frontend/apps/www` Nuxt 4 主站、`frontend/apps/trade` Vue/Vite 交易实验室、`frontend/apps/admin` Vue/Vite 管理后台，三个应用具备独立入口、路由、壳层、测试和构建产物。
- 建立唯一 `frontend/packages/ui/components.json` 和 shadcn-vue `reka-nova` 组件源；三个应用共享基础组件与令牌，不共享整页业务组件。
- 建立 `design-tokens`、`contracts`、`api-client` 基础包，统一语义颜色、响应式、V4 返回合同、Cookie 会话请求和 CSRF 写请求边界。
- 选定 Lightweight Charts 5.2.1 作为后续专业 K 线依赖；本阶段只冻结依赖，不制造假行情或提前实现业务图表。
- 建立 pnpm workspace 单锁文件，以及跨应用源码导入、第二 UI 库、应用直连 `fetch`/`WebSocket` 和多 `components.json` 的静态边界检查。

## 2. 删除与保留边界

旧代码删除只覆盖旧前端运行时代码及 34 个只验证旧 DOM、旧样式或旧脚本字面量的测试。混合测试经过逐文件复核；配置、安全头、Bridge 发布、AI 模型比较、观摩权限、调度、平台内容权限、Position Guard 和信号呈现中的后端合同测试已保留，仅移除其旧 `public/` 断言。

九个可能继续使用的二进制品牌、课程和报告资产迁到 `frontend/apps/www/public/migrated-assets`，并记录原路径与 SHA-256。它们只是待审资产，不等于已获准在新页面展示。

以下内容未删除：

- 数据库迁移、legacy ID map、回填 checkpoint、对账和回滚文件。
- 后端旧 API 与 Bridge 旧客户端切换逻辑；它们只能在阶段 17 经用户逐项确认后清理。
- `D:\dev_codex\wall-street-skill-local` 参考仓库中的旧实现。
- 工作区中属于阶段 1–8 的数据库、服务端和 Bridge 未提交改动。

旧前端和旧测试的本机恢复副本暂存于被 Git 忽略的 `bridge/.test-artifacts/legacy-public-stage9-20260903` 与 `bridge/.test-artifacts/legacy-frontend-tests-stage9-20260903`。该副本只用于当前重构核对，不是发布资产。

## 3. 第一轮实施复核

复核维度：需求覆盖、业务边界、现有能力复用、最少代码和是否过度设计。

发现与调整：

- 初次清理把所有读取 `public/` 的测试视为旧前端测试，误包含若干后端合同；已逐文件恢复后端部分，只删除旧 UI 字面量断言。
- 不为未来页面预建完整业务组件树；非首页路由使用明确的“待真实迁移”空状态，避免假数据和重复实现。
- 主站按企业展示和课程内容站建立宽松浅色骨架；交易实验室与后台使用各自独立的高交互壳层，不复制工作台到主站。
- 组件只在共享基础层复用，应用业务路由和页面不互相导入；避免为了复用重新制造通用巨型页面。

第一轮结论：三应用、唯一组件源、设计令牌和传输合同均覆盖阶段目标；旧前端清理没有继续牵连后端业务实现。

## 4. 第二轮实施复核

复核维度：兼容性、数据与迁移、并发与幂等、异常恢复、时间、安全、测试、回滚和连带 Bug。

发现与调整：

- `api-client` 不再把内部 `csrfToken` 扩散进原生 `fetch` 参数；应用请求固定为同源 `credentials: same-origin`，非安全方法缺少 CSRF 时在发出请求前失败。
- 应用源码禁止直接建立 WebSocket 或散落 `fetch`，为下一阶段单次票据、单连接和重连恢复保留唯一接入点。
- 旧数据库迁移和 Bridge 更新链不在本阶段删除范围，避免把前端重建误变成数据或客户端切换。
- 保留旧前端的本机可恢复副本和二进制资产哈希；Git 版本树仍保持干净的新架构，不把旧源码重新作为依赖。
- 官方生成的 Reka 包装层存在 TypeScript 可选属性兼容例外，已限制在前端编译边界；严格模式、Zod 合同和业务类型规则继续有效。

第二轮结论：阶段 9 可以关闭。真实 SSO、实时行情、K 线、交易与管理功能均未在空骨架中伪造，必须按路线图后续阶段逐条接入和验收。

## 5. 剩余风险

- 当前只完成工程与设计系统骨架，不代表业务页面、真实登录或实时链路已经完成。
- shadcn-vue 源码组件会随仓库维护；后续升级必须继续从唯一 Registry 入口进行，并复测三个应用。
- 真机浏览器、普通交易者可用性、真实 MT4/MT5 与生产子域尚不属于本阶段证据。
- 被 Git 忽略的本机恢复副本不能替代正式版本历史，确认不再需要后应在阶段 17 一并复核处理。

## 6. 验收命令

验收结果：前端边界检查通过；共享包和三个应用共 7 项前端测试通过；7 个前端工作区类型检查通过；Nuxt 主站、trade 和 admin 生产构建通过；保留的 10 个混合后端合同文件共 188 项测试通过；根 Vitest 共 214 个文件、3389 项测试全部通过；`git diff --check` 和禁用视觉样式扫描通过。

当前 Codex 父进程的 `PSModulePath` 同时包含 PowerShell 7 与 Windows PowerShell 5.1 模块，直接运行根测试会让两个安装器测试中的 Windows PowerShell 5.1 误报 `Get-FileHash` 不存在。使用系统 Windows PowerShell 5.1 的标准模块路径复跑相同完整测试后为 3389/3389 通过；该项属于本机测试进程环境，不是产品代码兼容或发布证据。

```powershell
pnpm run verify:frontend-boundaries
pnpm run test:frontend
pnpm run typecheck:frontend
pnpm run build:frontend
pnpm test
git diff --check
```
