# 阶段 12M：AI 交易员账户工作区验收记录

> 日期：2026-09-04
>
> 范围：AI 交易员当前账户、持仓、挂单、账户级 AI 决定、完整决定详情、浏览器实时恢复与响应式资源详情
> 边界：仅完成源码和离线验证；未启动服务、未读取真实 `.env`、未执行迁移、未连接真实 MySQL/Redis/Bridge/MT，也未下单、改单、平仓、撤单或分发

## 1. 结果

`/trader` 已从占位页替换为真实账户工作区。页面按普通外汇交易者的任务顺序组织：

1. 先确认当前 MT4/MT5 账户、经纪商服务器、智桥状态、交易权限、实时状态和账户指标；
2. 再查看完整持仓和挂单；
3. 选择资源后通过右侧 Sheet 查看订单号、方向或挂单类型、手数、价格、止损、止盈、盈亏、来源、时间和 revision；
4. 最后查看当前账户的 AI 交易员决定历史、动作参数、执行前预期状态与完整推理。

列表在桌面使用 shadcn-vue Table，小屏改用可点击卡片并打开同一详情 Sheet。止损、止盈、到期时间等空值统一显示 `--`。外汇价格不再强制两位小数，而是保留服务端合同中的实际小数精度；交易资源和账户级决定时间按当前终端校准时区显示。

## 2. HTTP 与 WebSocket 分工

HTTP 仍是权威读取：

- `GET /api/v4/trading-context`
- `GET /api/v4/trading-accounts`
- `GET /api/v4/trading-accounts/{accountId}/snapshot`
- `GET /api/v4/strategies?kind=trader`
- `GET /api/v4/trade-decisions?account_id=...`
- `GET /api/v4/trade-decisions/{decisionId}`

WebSocket 只订阅当前账户的小型变化事件：

- `runtime.bridge.changed`
- `account.metrics.changed`
- `positions.changed`
- `pending_orders.changed`
- `trade_decision.created`
- `operation.changed`

账户指标直接合并事件载荷，不按秒重复请求 HTTP；持仓与挂单使用完整集合事件替换当前投影；新决定只失效并重拉当前账户决定列表；operation 变化后重拉账户资源和决定状态。断线、sequence 缺口或服务端要求 resync 时，先恢复 HTTP 权威快照，再携最新 revision 重连。

观摩模式只订阅观摩源账户的运行、指标、持仓和挂单，不订阅所有者专属的交易员决定或 operation。所有事件必须同时匹配当前会话用户、交易账户和观摩频道作用域。

## 3. 快速切换与模块边界

用户可以连续切换本人账户。客户端采用串行 latest-wins 队列：同一时间只发送一个 context revision 写请求，期间新的选择覆盖等待目标；每轮响应仍以服务端返回 revision 为下一轮依据。旧账户的延迟 HTTP 响应和 WebSocket 控制器由 generation 隔离，不能覆盖新账户页面。

本阶段新增 `features/trader` 独立业务模块，API 适配、工作区编排、实时连接、展示格式和 UI 组件分别维护。它只复用合同包、传输包、共享 shadcn-vue 组件和已有会话/账户运行态，不导入其它应用或复制第二套控件。

## 4. 写操作能力门

需求中的手动下单、修改止盈止损、平仓、撤单、修改挂单、向策略订阅者分发手动单和分发平仓，本阶段没有伪装成可用按钮。

审计确认当前 V4 服务端只具备：

- 由已通过服务端风控的 `trade_decision` 生成 execution operation；
- 查询单个 operation；
- Bridge 确定性命令、结果 ACK、`uncertain` 与精确对账。

当前缺少用户手动命令与批量分发的公共 V4 command intake、请求合同、权限、幂等、父子 operation、精确目标冻结和配套迁移。直接从前端调用 Bridge、复用旧接口，或把用户操作伪装成 AI 风控决定都会破坏统一 execution 边界。因此下一子阶段必须先扩展服务端统一执行域和只追加迁移，再接入危险操作确认、进行中状态与最终结果；Bridge 无需增加策略或风控逻辑。

## 5. 组件与 Astra 可替换边界

实现前使用官方 shadcn-vue CLI 读取当前工程信息和组件文档，并结合 `ui-ux-pro-max` 对外汇交易工作区、移动表格、危险操作、实时状态和加载反馈进行了检索。本页使用 Card、Select、Badge、Button、Tabs、Table、Sheet、ScrollArea、Progress、Alert、Empty、Skeleton 与 Separator；没有加入第二套 UI 库、原生 `<select>`/`<table>`、`v-html`、固定主题颜色或页面级 z-index。

当前只冻结信息架构、交互状态、组件 API 和语义令牌。未来 Astra 视觉方向可以通过设计令牌和这些展示组件替换，不必修改账户隔离、HTTP 路径、WebSocket 目标或交易状态机。

## 6. 第一轮复审：需求覆盖、真实能力与最小改动

第一轮按“账户确认、资源查看、AI 决定、交易操作”核对。账户、持仓、挂单与决定均已有真实 V4 读取能力，因此直接复用；写操作只有设计合同或部分 OpenAPI 骨架，没有完整应用服务和持久化闭环，已从本阶段可执行范围移除，避免出现假成功或绕过风控。

复审发现原草案会让每个 `account.metrics.changed` 都重拉完整账户快照，实时指标按秒更新时会放大为高频 HTTP；已改为校验并直接合并小事件。原草案还会在快速切换时并发提交相同 context revision，已改成串行 latest-wins 队列。决定读取失败也不再连带清空成功返回的持仓和挂单，两个区域独立显示错误。

## 7. 第二轮复审：时间、精度、权限、恢复与连带 Bug

第二轮逐项检查账户串号、时区、小数精度、断线恢复、观摩权限与来源追溯。交易价格由固定两位改为保留原始 decimal 精度，避免 EURUSD 等多位报价被错误展示；账户、持仓、挂单与决定时间统一使用当前账户的 `timezone_offset_minutes`，时钟状态转换为自然中文。

来源资源的 `signal_id` 没有合同证据证明等于 `market_analysis.analysis_id`，因此详情页禁止猜测并跳转；只有拿到显式关联决定时，才使用其中的 `analysis_id` 打开 AI 分析师。页面也明确区分“AI 决定”“风控通过”和“终端成交”，不会根据 WebSocket 在线、超时或 accepted 回执自行推断交易完成。

复审确认观摩模式不请求所有者决定，不订阅 owner-only signals/operations；完整推理只通过授权 HTTP 获取并用 Vue 文本插值呈现。断线先 HTTP 恢复，失败继续有界退避，不把旧快照标成实时。

## 8. 离线验证

- `pnpm --filter @aurum/contracts test`：1 file / 6 tests passed
- `pnpm --filter @aurum/api-client test`：1 file / 7 tests passed
- `pnpm --filter @aurum/trade test`：6 files / 22 tests passed
- `pnpm run test:frontend`：全部前端工作区测试通过
- `pnpm run typecheck:frontend`：全部前端工作区通过
- `pnpm run build:frontend`：前端边界检查和全部应用构建通过
- Trade 单应用生产构建：`trader` 懒加载 chunk 14.62 KiB gzip
- 根 `pnpm test`：234 / 235 files、3534 / 3536 tests passed；仅 `tests/bridge-release-tool.test.js` 两项既有失败，原因仍是子 PowerShell 进程无法识别 `Get-FileHash`，与本阶段前端改动无关
- 禁用样式/原生控件扫描与 `git diff --check`：通过

因此，本阶段可以认定为“AI 交易员真实只读账户工作区已完成源码实现并通过离线验证”。不能据此宣称手动交易、策略分发、真实浏览器、数据库、Bridge 或 MT 端到端已经验收。

## 9. 下一阶段

下一阶段应先实现统一 execution 域的用户命令入口，最小覆盖：

1. 手动市价单与挂单；
2. 修改持仓止损止盈、平仓；
3. 修改挂单、撤单；
4. 按策略冻结订阅目标并为每个账户建立独立子 operation；
5. 只按原 distribution/outcome/ticket 精确分发平仓；
6. CSRF、`Idempotency-Key`、权限、预期 revision、服务端风控、审计、部分成功、`uncertain` 和精确对账；
7. 只追加数据库迁移及旁路验证，不在本阶段执行迁移。

该服务端闭环完成后，再用官方 shadcn-vue Dialog/AlertDialog、Field、Select 和 Sonner 把对应操作接入本页，危险动作必须显示账户、票号、数量和不可逆影响并等待明确确认。
