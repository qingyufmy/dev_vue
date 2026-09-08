# 模块化 P0 第一批进度

2026-09-08，按[全栈模块化方案](full-stack-modularization-plan-20260908.md)持续实施。P0 尚未完成，P1–P7 保持原范围。

## 已实现

- 收窄认证测试辅助函数的 payload 为对象记录类型，保留额外非法字段的拒绝测试；完整 `typecheck:server` 通过。
- 新增 TypeScript AST 依赖解析器，支持静态导入、类型导入、转导出、字面量动态导入、require、别名和 Vue script；计算型动态导入显式列为未解析。
- 新增 `inspect:server-boundaries` 与 `inspect:frontend-boundaries`，以非零退出状态报告现有问题；没有自动生成或接受豁免。
- 后端检测跨域内部引用、公开入口经 barrel 暴露 infrastructure/transport、domain 与 application 反向依赖、受限组装入口和源文件依赖环。
- 前端检测显式源码导入的跨应用、feature 内部引用、共享包反向导入应用和依赖环，保留原有前端检查不变。

## 当前证据

| 范围 | 扫描结果 |
| --- | --- |
| 后端 | 232 个源码文件，60 条跨域内部引用、77 条公开实现导出、11 条 domain 依赖候选、1 个源文件循环分量 |
| 前端 | 322 个源码文件，25 条 feature 内部引用、9 个源文件循环分量；配置解析错误 0 |

明细：[后端](migration/server-module-boundaries-20260908.json)、[前端](migration/frontend-module-boundaries-20260908.json)。各规则结果可重叠，不能相加解释为独立故障数。类型依赖也参与检查；循环分量不是运行时循环故障的直接证明。

`pnpm run typecheck:server` 通过；解析器 9 项正反例及认证 10 项行为测试通过；`git diff --check` 通过。两个 inspect 命令发现真实存量差异，预期退出 1，不能表述成架构验收已通过。

## 仍需继续

1. 复核导入及转导出来源，区分具体实现与允许的公开契约；完善模块层之外的共享/组装依赖判定，增加模块级依赖环与运行/type-only 区分。
2. 检测器当前扫描 Vue script，不分析 template 自动组件和 Nuxt 自动导入所有权；补齐这些入口后才能作为完整前端模块门禁。
3. 对已复核债务建立精确例外清单，记录 source/target/rule、模块、理由与消除阶段，拒绝新增和陈旧例外；不能只用总数防回归。
4. 建立模块/表写入所有权清单，确认合同编译方案；接入方案要求的 verify 命令，而非把 inspect 改名后直接宣称完成。
5. 完成 P0 后进入账户业务样板，数据库、API 与前端同步推进。

本批未启动服务、连接真实依赖或执行数据库迁移。此前方案及审查文件保留为设计历史，其中“类型检查失败”描述的是实施前基线，以本记录为修复后的状态。

## 第二批：依赖图精度与 Nuxt 自动导入

已区分 type-only、混合和运行导入；支持 import-equals，解析失败直接报错。新增模块级强连通分量检查：即使不同文件之间没有闭环，跨模块依赖环也会报告完整来源证据。

[后端 v2 扫描](migration/server-module-boundaries-20260908-v2.json)显示 bridge/execution/inference/risk/trading 形成模块级循环分量，其中存在运行导入边；risk 两个领域文件的源文件循环仅包含类型反向边，不再把它描述为运行循环。这里的 runtime 指静态运行导入图，不代表已经启动或观察到实际运行故障。

新增 Nuxt app 自动依赖检查：读取重新 prepare 后的 imports/components 声明，解析 Vue 模板编译结果和脚本作用域，显式导入、参数遮蔽和属性名不会被错误算作自动导入；局部声明缺失或目标不存在直接失败。复用了已安装 Vue 的 compiler-sfc，没有新增依赖或修改 UI。

本轮 `pnpm --filter @aurum/www exec nuxt prepare` 成功；15 项检测器测试与语法检查通过。[前端 v2 扫描](migration/frontend-module-boundaries-20260908-v2.json)仍为25条内部路径引用和9个源文件循环分量；自动边为0，经核实主站 learning composable 使用显式导入。该结果不表示没有其它架构债务。

剩余：Nuxt server 自动导入、动态组件表达式、声明新鲜度的自动保证仍需补齐；当前人工先 prepare 再 inspect。精确例外与完整模块/表写入所有权清单尚未创建，verify 门禁和 API 合同编译方案尚未收口，P0 保持进行中。

## 第三批：会话模块实际封装

为 trade/admin auth 模块定义公开入口和职责说明。消费者改用公开能力，session ref、嵌套身份对象和 load 返回值均为只读；加载与退出仍由模块拥有。登录页通过公开的动态加载函数提供，不因公开入口而提前打包进主入口。

实时消费者改用 `TradeSessionSnapshot` 只读合同，Bridge 配对接收只读 Ref。没有通过断言把只读状态伪装成可写状态，也没有将整个内部实现转导出到入口。其它模块不能再直接修改共享会话事实。

两端类型检查、构建和原有127项测试通过；新增2项公开会话行为测试通过，验证跨消费者无法改写 ref/用户ID、加载返回值只读、正常退出可清空状态及 admin 权限筛选保持。[前端 v3 扫描](migration/frontend-module-boundaries-20260908-v3.json)显示 feature 内部路径引用从25条降到8条，auth 相关为0；共享 UI 的9个循环分量尚未处理。未进行浏览器视觉或真实 SSO 验收。

剩余8处涉及 home 的共享交易状态和路由私有页面入口，其中状态所有权应按账户流程拆分，不能简单转导出可写 ref。P0 的其它工作及 P1–P7 仍保持原范围。

## 第四批：账户目录与交易上下文所有权

核实 home-runtime 只是通用 lib/trading-runtime 的转导出后，将账户目录、交易上下文、观摩频道目录移到独立 `trade/features/trading-context` 模块。内部 ref 不导出；模块公开只读投影及应用服务端响应的操作，写入时复制 DTO，阻止调用方通过原对象引用改写内部事实。home、risk、trader、应用壳层和时间读取已接入公开入口。

保留消费者已有请求代次、用户和账户作用域检查；没有把本地 apply 操作当作服务端授权。该阶段只收口投影所有权，未替代账户切换 HTTP 用例和全部缓存清理协调。行情、账户快照、持仓及实时 revision 仍待迁入对应模块，避免把整个通用状态对象改名后算完成。

同时为 home/shell/overview/settings 提供页面按需加载入口，路由不再直接导入私有 Vue 文件。现有页面与占位功能覆盖不变，公开 loader 不代表占位功能已实现。

验证：trade 原有114项测试通过；新增2项所有权测试及观摩/迟到响应/时间共19项定向测试通过；两端4项路由测试通过；trade/admin 类型检查与构建通过。最终[前端 v4 扫描](migration/frontend-module-boundaries-20260908-v4.json)剩2处 feature 内部路径引用、9个 UI 源文件循环分量，没有新增模块循环。未运行真实服务或数据库迁移。

下一步继续快照/持仓/行情的写入能力分离，以及 P0 精确债务、数据表所有权和 API 合同检查；不会以当前扫描数量降低替代整个方案验收。

复核还发现 risk 的 selectAccount 响应应用发生在 generation 检查前，这是原有顺序，应在接续账户请求协调时补迟到响应回归并修复；本批不宣称所有调用方的异步保护已正确。
