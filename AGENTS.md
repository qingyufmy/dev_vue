# Repository Guidelines

## 项目结构与模块划分

- `server/` 是 Node.js ESM 后端；HTTP 路由位于 `server/routes/`，AI 推理、策略、风控、复盘、记忆和模型对比集中在 `server/routes/ai/`。
- `public/` 存放静态前端资源。AI 交易实验室主要由 `public/ai/index.html`、`app.js` 和 `styles.css` 构成，无单独前端构建步骤。
- `public/ai/aurum_bridge_gui.py` 是服务器与 MT5 之间的 Python 桥接程序。
- `tests/` 按后端模块组织；AI、路由和加密货币相关测试分别位于 `tests/ai/`、`tests/routes/` 和 `tests/crypto/`。
- 数据库变更统一写入 `server/migrations.js`；方案、实现记录和运维文档放在 `docs/`。

## 安装、测试与本地运行

```powershell
npm install          # 安装依赖
npm run dev          # 监听文件变化并启动 3000 端口服务
npm start            # 以常规模式启动服务
npm test             # 运行全部 Vitest 测试
npm run test:watch   # 持续运行受影响的测试
```

定向测试示例：`npx vitest run tests/ai/strategy.test.js`。构建 Windows 桥接软件使用 `python public/ai/build_nuitka.py`。启动或重启项目时必须使用可见的 PowerShell 控制台，便于观察运行日志和异常。

## 编码与命名规范

JavaScript 使用两空格缩进、无分号风格和 ESM `import`/`export`。函数与变量使用 `camelCase`，类使用 `PascalCase`，模块文件使用 kebab-case。项目未配置统一格式化或 lint 工具，修改后应匹配相邻代码，并对 JavaScript 执行 `node --check`。前端文案使用中文，内部错误码保持稳定。SQL 必须使用参数占位符，禁止拼接用户输入。

## 测试要求

测试框架为 Vitest，JavaScript 测试命名为 `*.test.js`，Python 探针可使用 `test_*.py`。修复问题时必须增加回归测试，重点覆盖权限、迁移、调度状态、MT5 时间、订单执行和缓存边界。先运行定向测试，再运行 `npm test`；涉及运行链路时还需启动项目并检查 `/health`。

## 提交与合并要求

提交信息采用 Conventional Commit 风格，例如 `fix(ai): preserve pinned inference selection`。提交应保持单一职责。PR 需要说明行为变化、迁移或配置影响、测试结果和回滚风险；UI 修改需附截图，并关联对应任务。

## 安全与 Agent 专用约定

从 `server/.env.example` 创建本地配置，禁止提交凭据。保持 `/api` 与 `/aurum-api` 兼容。工作区中已有的未提交文件属于用户，不得顺带修改或提交。修改前检查完整调用链，修改后执行回归验证。每次完成代码修改后推送到 Gitee 的 `dev_codex` 分支。

后续发现的项目级注意事项、固定运行方式、架构约束、重要需求决策和长期维护规则，应及时补充到本文件；不要把临时调试结论或一次性任务记录写入这里。

MT5 账户归属以“经纪商服务器 + 登录账号”为唯一身份。具备账户交易权限的最新 Bridge 连接可自动接管归属；旧用户的相关订阅、自动推理与交易发送必须立即停用，并通过审计记录和实时前端事件保留完整切换链路。只读 MT5 登录不得接管账户。
