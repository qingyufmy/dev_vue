# 阶段 12O：AI 交易员写操作工作区验收记录

> 日期：2026-09-04
>
> 范围：AI 交易员账户写操作、管理员策略分发、危险确认、操作状态恢复、只读辅助端点与公共 V4 合同
>
> 边界：仅完成源码和离线验证；未执行 011 迁移，未启动业务服务，未连接真实 MySQL、Redis、Bridge、MT4/MT5，也未发送任何交易命令

## 1. 结果

阶段 12O 把阶段 12M 的只读 AI 交易员工作区接到阶段 12N 的真实执行边界。账户所有者可以从当前账户发起：

1. 手动市价单和挂单；
2. 修改持仓止损、止盈；
3. 精确 ticket 全量平仓；
4. 修改挂单价格、Stop-Limit、止损、止盈和到期时间；
5. 精确 ticket 撤单。

管理员还可以选择已发布的交易策略，预览当前订阅目标，确认后分发一笔手动市价单或挂单；分发完成后只能从原 distribution 的精确 outcome/ticket 入口创建分发平仓，不提供按品种、相似订单或自由 ticket 的模糊平仓。

## 2. 提交前权威上下文

新增 `GET /api/v4/trading-accounts/{account_id}/execution-context`。页面在打开交易表单或资源操作前，从服务端读取当前账户、持仓集合、挂单集合、报价、合约和风控六类 revision；改单、平仓和撤单还读取目标 ticket 的资源 revision。响应只暴露提交合同必需的 revision、报价、合约交易约束、只读和交易权限，不返回平台/账户风控策略正文、风险内部评估或其它用户数据。

前端不从旧页面缓存拼接 revision，也不使用零值或资源列表最大版本冒充目标版本。品种快速切换使用 latest-wins generation，迟到的上下文或分发预览不会覆盖当前选择；账户切换会立即关闭旧账户交易界面并清空已准备上下文。命令构造器单独模块化，按指令类型白名单拣选参数，并用公共 Zod 合同验证账户命令和分发命令。报价或合约约束不完整时只读端点返回 `null`，不向公共合同输出半有效对象。

## 3. shadcn-vue 交互边界

写操作统一组合现有 `@aurum/ui` 的 shadcn-vue/Reka 组件：

- `Sheet + Field + Input + Select + Tabs + Checkbox`：市价单、挂单和资源编辑；
- `AlertDialog`：下单、改单、平仓、撤单、策略分发和分发平仓的二次确认；
- `Table + Card + Badge + Alert + Empty + Skeleton`：桌面/移动端持仓挂单与操作状态；
- 所有主要按钮维持至少 44 px 触控高度，不引入原生 `<button>`、`<select>` 或独立组件体系。

确认窗口明确显示账户、指令、品种、ticket、手数、价格、SL、TP 和影响范围。观摩模式、只读上下文或普通账户缺少交易权限时禁用账户写操作。管理员策略分发与当前参考账户的交易权限解耦，但仍要求非观摩身份、有效交易策略、参考报价和分发目标预览。

## 4. 策略分发预览和状态

新增管理员只读端点：

- `GET /api/v4/execution-distributions/preview`：显示当前目标、交易权限和缺失资源；不加写锁、不承诺最终名单；
- `GET /api/v4/execution-distributions/{distribution_id}`：读取父 operation、冻结目标、子 operation、归因 ticket 和结果摘要。

真正提交时仍由阶段 12N 的短事务重新校验策略版本和订阅资格，并冻结目标。预览中的策略或品种改变后，旧预览立即失效；没有与当前表单匹配的预览时不能进入最终确认。

分发父 operation 没有单个交易账户，因此浏览器实时协议增加受控的用户级 `operations` 目标：`trading_account_id=null`、`observer_channel_id=null`。服务端仍按活动系统用户匹配，观摩会话不能订阅；账户命令继续使用账户级 operation 目标。WebSocket 只作为失效提示，收到事件后再用 operation/distribution HTTP 读取权威状态。

“执行操作中心”只展示本次页面会话提交的操作，并完整区分 `accepted/queued/running/succeeded/partially_succeeded/rejected/failed/uncertain/cancelled/expired`。`accepted` 不显示为成交；`uncertain` 明确说明不会自动重发，必须等待精确对账。若终态实时事件早于 HTTP 受理响应到达，前端会暂存该事件标识，并在拿到 operation 后立刻回读权威状态，避免快速完成的操作停留在“已受理”。

## 5. 第一轮复审：需求覆盖与安全边界

第一轮复审发现，直接把阶段 12M 的账户/持仓/挂单 revision 接到写请求并不完整：报价、合约和风控 revision 不在前端工作区内，强行提交只能伪造零值或使用不同时间点的资源。已增加最小只读 execution-context 端点，由同一个执行仓储读取服务端当前上下文；页面只负责回传完整 expected state，持久化事务仍会再次锁内复核。

复审还发现策略分发缺少可解释的目标预览和父 operation 的实时订阅。已增加无写入的预览端点与用户级 operation 目标，同时保留“预览不是冻结名单”和“HTTP 接受不是终端成交”两条明确提示。分发没有复制账户执行、风控或 Bridge 逻辑，Bridge 仍只接收服务端已经持久化的确定性命令。

第一轮结论：页面已覆盖要求的六类账户命令、管理员手动单分发和精确分发平仓，没有绕过阶段 12N 的权限、幂等、风控、风险预留和异步执行状态机。

## 6. 第二轮复审：并发、权限语义与连带风险

第二轮复审重点检查快速切换、只读语义、分发资格和错误状态。上下文与预览请求加入 generation fencing；策略或品种改变会清除旧预览。`blocked`、缺失 trading context 和 `read_only` 均按不可写处理，不再只识别 observer。账户写操作要求当前账户交易权限；管理员分发只把当前账户作为报价参考，不错误要求该账户必须是分发目标或具有交易权限。

资源编辑和危险操作每次打开前都会按 ticket 重读 target revision；资源消失或版本缺失时失败关闭。表单构造结果通过严格 discriminated union 合同测试；服务端仍会在短事务内按固定锁序再次核验，不在事务中调用 Redis、Bridge、MT 或模型。

剩余风险：本轮没有执行 011 迁移，也没有用真实 MySQL/Redis 验证锁等待与队列重投，没有连接 Bridge/MT 验证终端返回和资源吸收，没有做登录后的真实浏览器多宽度交互验收。操作中心目前只保留本次页面会话提交记录；跨刷新历史应由后续账户 operation 列表或系统审计页提供，不能把内存列表当作永久审计。共享 `AlertDialog` 已通过三应用类型检查和构建，但正式视觉仍需在后续浏览器验收中复核。

## 7. 离线验证

- Trade 前端：8 files / 30 tests passed；
- Contracts：15 tests passed；API client：9 tests passed；
- execution/read-model/realtime 定向服务端回归：通过；
- 全部前端工作区 boundary、tests、typecheck 和 build：通过；
- Server TypeScript typecheck 与 V4 build：通过；
- OpenAPI JSON 与 570 个 `$ref`：通过；
- 根测试：239 / 241 files、3565 / 3571 tests passed。Bridge 发布工具 2 项因子进程 PowerShell 缺少 `Get-FileHash` 失败；未改动的 `platform-market-data` 有 4 项仅在完整并发套件中失败，单文件 62 tests 全部通过，属于现有测试隔离问题，均与本阶段 execution/frontend 文件无交集；
- `git diff --check`：通过。

## 8. 下一步

在执行数据库迁移或真实交易前，下一阶段应先补齐 AI 风控师前端竖切；到阶段 15～16 再由用户明确授权：

1. 备份并演练 011 旁路迁移，核对旧数据与 V4 新表；
2. 启动真实 MySQL、Redis、API、Realtime、Outbox、Execution Worker 和 Bridge Gateway；
3. 使用只读 MT5 账户验证报价、合约、持仓/挂单与 revision；
4. 待有交易权限的测试账户可用后，逐笔验收下单、改单、平仓、撤单、分发和精确分发平仓；
5. 对 `uncertain`、断线、快速账户切换、刷新恢复和 320/390/768/1024/1280/1440 px 宽度完成浏览器证据。
