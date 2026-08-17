# 手动交易复盘 `history_params_invalid` 修复方案

## 0. 文档信息

- 文档状态：实施前正式修复方案
- 编写日期：2026-08-17
- 适用项目：AURUM / AI 交易实验室
- 适用入口：AI复盘师 → 手动交易复盘
- 故障接口：`POST /api/ai/manual-trade-reviews`
- 公网故障码：`history_params_invalid`
- 变更性质：前后端请求合同修复、服务端输入收敛、回归测试与静态缓存刷新
- 当前授权边界：仅形成方案；不修改业务代码，不提交、不推送、不部署、不重启、不创建或重试复盘任务

本方案是对
`docs/manual-profitable-trade-counterfactual-strategy-review-optimization-plan.md`
中“创建时再次复验订单绑定和完整成交链”要求的定向修复，不改变手动交易复盘的产品目标、证据标准、模型流程或人工确认流程。

## 1. 结论摘要

问题不是 Bridge 离线、账户历史不完整或模型任务失败，而是创建接口的前后端参数合同断裂：

1. 候选交易接口已经返回服务器识别证据所需的 `position_id` / `entry_order_ticket`。
2. 前端创建任务时只提交 `trade_id`、`source_identity_hash`、`trade_source_hash`，丢弃了上述查询引用。
3. 后端 `validateManualTradeSelection()` 原样返回前端对象。
4. `readManualTradeEvidence()` 随后从对象中读取 `position_id` / `entry_order_ticket`，得到两个空数组。
5. Bridge `history_evidence` 按安全合同拒绝零引用请求，返回 `history_params_invalid`。

因此，当前页面中的所有候选交易都会在“创建时二次冻结证据”阶段失败。修复必须补齐调用方参数并加强服务端校验，不能放宽 Bridge 的 fail-closed 规则。

## 2. 已核实证据

### 2.1 公网运行状态

诊断时公网运行信息：

- 运行目录：`/www1/wwwroot/aurum-ai`
- 分支：`main`
- 提交：`ebd34d72cc0514117f36f7a28abfac6cf5c5b685`
- 工作树：干净
- Node 进程用户：`www`
- `/health`：应用、数据库与 Redis 正常
- 管理员账户：MT5 在线，候选交易与平台策略可以正常读取

### 2.2 HTTP 证据

公网访问日志显示：

- `GET /api/ai/manual-trade-reviews/eligible-trades?page_size=20` 返回 200；
- `GET /api/ai/manual-trade-reviews/strategies` 返回 200；
- 2026-08-17 10:30、10:31、10:43 的三次
  `POST /api/ai/manual-trade-reviews` 均返回 400。

故障发生在 case/job 事务写入之前，不会留下已创建 case 或孤立生成任务。

### 2.3 代码证据

前端创建请求当前只发送：

```js
{
  trade_id,
  source_identity_hash,
  trade_source_hash,
}
```

后端二次证据读取却执行：

```js
const positions = selected.map(item => item.position_id).filter(Boolean)
const orders = selected
  .filter(item => !item.position_id)
  .map(item => item.entry_order_ticket)
  .filter(Boolean)
```

最终调用 `history_evidence` 时两个引用数组均为空。Bridge 当前拒绝空引用的行为正确，不能修改。

### 2.4 现有测试缺口

相关 2 个测试文件、79 项测试当前全部通过，但覆盖被拆成了两部分：

- 手动复盘测试覆盖候选交易归一化、证据完整性和输出合同；
- Bridge 测试单独证明零引用必须返回 `history_params_invalid`；
- 缺少“候选响应 → 前端创建 payload → 服务端选择校验 → `history_evidence` 请求”的纵向合同测试。

## 3. 修复目标与非目标

### 3.1 修复目标

1. 创建请求必须携带服务器二次读取证据所需的稳定引用。
2. 服务端必须对白名单字段进行独立归一化，不能原样信任或保存前端对象。
3. 在进入 Bridge 前明确保证至少存在一个有效引用。
4. 创建时继续重新读取账户历史、重新核对系统信号绑定、重新计算交易身份和来源哈希。
5. 参数合同错误必须返回手动复盘领域错误，而不是泄漏底层 `history_params_invalid`。
6. 增加覆盖真实请求形状的回归测试。
7. 刷新 AI 应用自身的静态构建键，确保浏览器加载修复后的 `app.js`。

### 3.2 明确非目标

- 不放宽 `history_evidence` 至少一个稳定引用的要求。
- 不把 `source_identity_hash` 或 `trade_source_hash` 当作历史查询条件。
- 不通过无界扫描最近七天历史来寻找所选交易。
- 不修改候选交易业务定义、最近七天范围或游标分页规则。
- 不修改 MT4“终端当前可见历史”边界。
- 不修改单笔选择上限。
- 不修改模型提示、两阶段盲测、策略快照、记忆库或人工确认逻辑。
- 不自动创建、重试、确认、沉淀或删除任何复盘数据。
- 不在本方案阶段部署公网。

## 4. 目标请求合同

### 4.1 创建请求中的交易对象

保持现有扁平结构，只增加查询提示字段，避免无必要的 API 结构迁移：

```json
{
  "trade_id": "<兼容字段>",
  "source_identity_hash": "<64位十六进制身份哈希>",
  "trade_source_hash": "<64位十六进制来源哈希>",
  "position_id": "<1至32位非零数字字符串或null>",
  "entry_order_ticket": "<1至32位非零数字字符串或null>"
}
```

约束：

- `source_identity_hash` 与 `trade_source_hash` 继续作为创建时一致性校验值；
- `position_id` 与 `entry_order_ticket` 仅作为当前账户内二次读取历史证据的查询提示；
- 两个查询提示不能同时为空；
- 有 `position_id` 时优先按 position 查询完整成交链；
- 没有 `position_id` 的订单型记录才使用 `entry_order_ticket`；
- 任何查询结果仍必须重新生成身份、来源哈希并与提交值匹配。

### 4.2 为什么不采用无引用扫描

只凭身份哈希无法让 Bridge 定位券商历史记录。为了从哈希反查交易而重新扫描游标历史，会带来：

- 请求时间和 Bridge 负载不可预测；
- 快照或游标变化导致创建结果不稳定；
- 重新引入已经通过限定游标扫描解决的历史分页风险；
- 容易把“选择校验”变成一个隐式历史导出接口。

因此，使用候选响应中已经存在的 position/order 引用，并由服务端重新核验，是当前架构下最小且可靠的方案。

## 5. 详细实施设计

### 5.1 前端：补齐创建 payload

修改 `public/ai/app.js` 的 `createManualTradeReviewTask()`：

- 在每个 `trades` 项中增加 `position_id` 和 `entry_order_ticket`；
- 不提交成交详情、利润、价格、方向、用户身份或账户参数；
- 保持 `client_request_id` 幂等逻辑不变；
- 保持单笔选择限制不变。

前端只传查询提示，不扩大为“前端冻结交易证据”。最终证据仍由服务器生成。

### 5.2 服务端：白名单归一化选择对象

修改 `validateManualTradeSelection()`：

1. 保留单笔数量校验。
2. 将身份哈希和来源哈希转为规范小写十六进制字符串并检查长度。
3. 将 position/order 引用规范为字符串，禁止浮点数、负数、零、空白、科学计数法和超长值。
4. 引用格式与 Bridge 保持一致：`^(?!0+$)\d{1,32}$`。
5. 至少要求一个有效查询引用。
6. 返回新创建的白名单对象，不再 `return selected`。
7. 丢弃所有未声明字段，避免未来前端状态意外进入证据冻结逻辑。

建议新增领域错误：

```text
manual_trade_review_selection_reference_invalid
```

该错误表达“所选交易缺少可二次验证的订单/持仓引用”，比底层 `history_params_invalid` 更准确。

### 5.3 服务端：Bridge 调用前断言

修改 `readManualTradeEvidence()`：

- 仅使用已经归一化的选择对象生成 refs；
- 在调用 `bridgeHistory(..., { evidence:true })` 之前再次断言 refs 总数大于 0；
- 单笔选择下引用总数最多为 1，远低于 Bridge 上限；
- 如果断言失败，返回领域错误，不调用 Bridge；
- 不捕获并改写真正的 Bridge 证据不可用错误。

这一层是纵深防御：即使未来其他调用方绕过前端，仍不能产生无效 Bridge 请求。

### 5.4 服务端：保留现有防篡改复验

以下逻辑必须原样保留：

- 账户由当前登录身份和当前有效交易账户解析，不接受任意账户覆盖；
- Bridge route 必须唯一匹配当前账户；
- 历史范围必须是服务器重新生成的最近七天范围；
- 历史完整性与终端时钟必须可信；
- 必须重新检查开仓订单没有绑定平台信号；
- 必须重新检查交易已经完全平仓且净利润大于 0；
- 必须重新计算 `source_identity_hash` 和 `trade_source_hash`；
- 任一哈希不一致均返回 `manual_trade_review_source_changed`；
- 所有复验通过后才允许进入 case/job 事务。

### 5.5 前端错误文案

在 `localizeReason()` 的领域错误映射中增加：

```text
manual_trade_review_selection_reference_invalid
→ 所选交易缺少可验证的订单或持仓引用，请刷新交易记录后重新选择
```

不把它翻译成“历史参数错误”，避免要求用户理解 Bridge 内部合同。

### 5.6 静态缓存

本次只修改 AI 应用 `app.js`，不应变更全站共享 `v=20260814ema34toggle1`。

在 `public/ai/index.html` 的 AI app `build=` 中追加独立功能键，例如：

```text
manual-review-create-ref1
```

这样可以刷新 AI app，而不会让主站、账户中心和管理后台的全部静态资源共同失效。

## 6. 需要修改的文件

计划内文件：

1. `public/ai/app.js`
   - 创建 payload 增加 position/order 查询引用；
   - 增加领域错误中文文案。
2. `server/routes/ai/manual-trade-review.js`
   - 严格归一化创建选择对象；
   - 禁止缺少历史查询引用的选择。
3. `server/routes/ai/manual-trade-evidence.js`
   - Bridge 调用前增加非空引用断言；
   - 保持二次复验与冻结流程。
4. `public/ai/index.html`
   - 追加 AI app `build=` 缓存键。
5. `tests/ai/manual-trade-review-frontend.test.js`
   - 固定前端创建 payload 合同和缓存键。
6. `tests/ai/manual-trade-review-output.test.js`
   - 覆盖选择对象归一化和无效引用。
7. `tests/ai/manual-trade-review-history.test.js`
   - 覆盖 position 路径、order-only 路径和 Bridge 前非空断言。
8. 视测试组织需要新增一个创建链路合同测试文件；优先复用现有文件，避免重复 mock 基础设施。

明确不修改：

- `server/bridge-v3/business-adapter.js`；
- Bridge Worker / native store；
- migrations 与任何数据库结构；
- 手动复盘模型输出合同；
- 策略记忆、周期复盘和交易执行代码。

## 7. 测试方案

### 7.1 前端合同测试

断言 `createManualTradeReviewTask()` 的每个交易对象包含：

- `source_identity_hash`；
- `trade_source_hash`；
- `position_id`；
- `entry_order_ticket`。

同时断言不提交利润、价格、完整成交、账户 ID 或策略正文。

### 7.2 服务端选择校验测试

至少覆盖：

1. position 交易通过，并返回白名单规范对象；
2. order-only 交易通过；
3. position 与 order 同时缺失时失败；
4. 引用为零、负数、小数、科学计数法、非数字或超过 32 位时失败；
5. 身份/来源哈希缺失或格式错误时失败；
6. 多笔选择继续失败；
7. 未声明字段被丢弃。

### 7.3 证据链路测试

模拟真实前端 payload，拦截服务端发送给 Bridge 的请求，断言：

- position 交易调用 `history_evidence` 时包含对应 `evidence_position_ids`；
- order-only 交易包含对应 `evidence_order_tickets`；
- 从不发送两个空数组；
- 账户 route、最近七天精确范围和 `noFallback:true` 保持不变；
- Bridge 返回的身份/来源哈希不匹配时仍 fail closed；
- 无引用请求在 Bridge 之前即返回领域错误。

### 7.4 创建事务测试

增加一条纵向测试，至少覆盖：

```text
候选交易形状
→ 前端创建请求形状
→ validateManualTradeSelection
→ readManualTradeEvidence
→ 成功取得冻结证据
→ 才进入 case/job 事务
```

测试不得通过直接注入 `options.evidence` 绕过本次故障路径。

### 7.5 回归命令

实施后运行：

```powershell
npm test -- tests/ai/manual-trade-review-frontend.test.js `
  tests/ai/manual-trade-review-output.test.js `
  tests/ai/manual-trade-review-history.test.js `
  tests/ai/manual-trade-review.test.js `
  tests/ai/manual-trade-review-static.test.js `
  tests/bridge-v3-business-adapter.test.js `
  tests/frontend-static-cache-version.test.js
```

随后运行：

```powershell
npm test
git diff --check
```

## 8. 验收标准

代码验收必须同时满足：

1. 前端创建 payload 包含稳定查询引用。
2. 服务端不再原样返回选择对象。
3. 任意进入 `history_evidence` 的创建请求至少包含一个有效引用。
4. Bridge 对零引用请求的拒绝规则保持不变。
5. 创建时仍执行账户、历史完整性、时钟、信号绑定、完整平仓、盈利和哈希复验。
6. 参数合同错误返回手动复盘领域错误。
7. 聚焦测试和全量测试通过。
8. AI app build 缓存键已更新，共享 `v=` 未改变。

部署后验收需另行授权，并至少核对：

1. 公网 branch/commit 与目标发布提交一致且工作树干净；
2. `/health` 的应用、数据库与 Redis 正常；
3. `/ai/` 实际引用新的 `manual-review-create-ref1` build 键；
4. 管理员页面候选与策略接口继续返回 200；
5. 经用户明确授权后，选择一笔测试交易创建一次复盘；
6. POST 返回 202，生成一个 case 和一个 job；
7. 任务状态能够从 queued 进入后续阶段；
8. 日/月复盘、策略记忆和交易执行页面无回归。

生产验收中的第 5–7 项会写入复盘业务数据，不能因部署授权自动推定，必须单独取得创建测试任务的明确授权。

## 9. 发布与回滚边界

### 9.1 发布前

- 保持修复提交只包含上述代码、测试、文档和 AI app build 键；
- 不混入当前工作区其他变更；
- 提交、推送、合并 `main` 和公网部署分别取得授权；
- 公网部署必须使用 `deploy-aurum-public` 的受控流程；
- 禁止手工 SQL、迁移重跑或数据库修复。

### 9.2 回滚

本修复不涉及数据库结构或持久化合同迁移，回滚范围为代码与静态 build 键。回滚时仍需：

- 明确目标提交；
- 验证公网工作树与进程；
- 验证 `/health`；
- 不删除已经成功创建的复盘业务记录。

## 10. 第一轮方案审查：合同与安全

### 10.1 审查发现

初步最小方案只有“前端多提交两个字段”。该方案能够消除当前空数组，但不足以形成安全边界：

- 后端仍会原样信任前端对象；
- 未来调用方可能提交格式异常或额外字段；
- 缺少 Bridge 调用前的领域断言；
- 底层错误会继续泄漏到 UI。

### 10.2 已作调整

正式方案增加：

- 服务端白名单重建选择对象；
- 与 Bridge 一致的数字引用格式校验；
- 至少一个引用的双层断言；
- 创建时继续重算身份和来源哈希；
- 明确的手动复盘领域错误。

审查结论：修复调用方，不削弱 Bridge；前端字段只是查询提示，服务器仍是证据权威。

## 11. 第二轮方案审查：回归、缓存与运维

### 11.1 审查发现

只增加单元测试仍可能再次遗漏真实纵向链路；只改 `app.js` 而不刷新 build 键，则公网浏览器可能继续运行旧创建代码。直接修改全站共享 `v=` 又会造成不必要的全站缓存失效。

### 11.2 已作调整

正式方案增加：

- 真实前端 payload 到 `history_evidence` 请求的纵向合同测试；
- 明确禁止测试通过 `options.evidence` 绕过故障路径；
- position 与 order-only 两条分支测试；
- AI app 独立 `build=` 功能键；
- 保持全站共享 `v=` 不变；
- 将生产创建测试任务列为需要单独授权的业务写操作。

审查结论：方案能够覆盖代码、浏览器缓存和部署后验证，同时不扩大当前修复授权。

## 12. 剩余风险

1. **旧页面缓存。** 部署瞬间仍在运行旧 JavaScript 的已打开页面会继续缺少引用；领域错误应提示刷新，新的 build 键负责后续加载。
2. **候选已变化。** 候选展示后交易历史、账户绑定或系统信号关联可能变化；创建时应继续返回 `manual_trade_review_source_changed`，不能强行创建。
3. **Bridge 证据暂时不可用。** 修复参数后仍可能遇到历史准备、时钟或完整性错误；这些属于真实证据门槛，不能与本缺陷混为一谈。
4. **order-only 兼容。** 当前公网主要是 MT5 position 交易，但仍必须保留并测试没有 position 的订单引用路径。
5. **生产端到端验证需要写数据。** 没有单独授权时，只能确认参数与接口合同，不能宣称生产复盘生成已经完成验证。

## 13. 推荐实施顺序

1. 先补失败回归测试，稳定复现“前端形状导致空 evidence refs”。
2. 实现服务端选择对象白名单归一化与领域错误。
3. 实现 `readManualTradeEvidence()` 调用前断言。
4. 前端补齐 position/order 引用。
5. 更新领域错误文案和 AI app build 键。
6. 运行聚焦测试、全量测试和 `git diff --check`。
7. 由主代理审查 diff、测试证据和业务合同。
8. 经明确授权后再提交、推送、合并与部署。
