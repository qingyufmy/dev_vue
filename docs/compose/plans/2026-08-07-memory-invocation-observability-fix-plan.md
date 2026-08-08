# AI 记忆调用准确展示与审计链修复方案

> 状态：首批修复已于 2026-08-07 部署；生产复核发现采用语义归因缺口，后续修复已完成本地验证、尚未发布
>
> 审查基线：`dev_codex` @ `5ebd17751bf14cb53ab14ae23e7469b862b233c6`
>
> 日期：2026-08-07
>
> 适用范围：平台策略记忆检索、模型采用记录、AI 分析详情、平台记忆效果评估、自动推理审计关联

## 1. 结论与目标

当前记忆的生成、发布、按上下文检索和模型注入主链路正常。本方案不改变记忆匹配算法、60 分命中阈值、策略绑定、令牌预算、模型提示词内容或交易决策，只修复以下四项可观测性问题：

1. 正式使用模式已经发生检索，但管理页面只显示影子检索数据。
2. 模型通过 `used_ids` 表示采用记忆时，`used_refs` 可能为空，导致前端低报采用数量。
3. 自动推理的记忆日志已绑定信号，但没有直接绑定推理快照。
4. 未命中时日志没有保存候选被淘汰的原因。

最终目标是让“候选了什么、实际注入了什么、模型采用了什么、产生了哪个信号和快照、为什么未命中”能够一致追溯，同时保证记忆筛选和交易结果不因本次修复发生变化。

## 2. 已验证现状

### 2.1 运行数据参考

虚拟机只读核查显示：

- 当前有两个平台策略，每个策略各有一条已发布短期记忆。
- 两个策略的记忆策略均为 `active`，最多选择 5 条，运行预算为 800 tokens。
- 策略 1 发布后 30 次检索全部命中；策略 3 共 31 次检索，命中 30 次、未命中 1 次。
- 最近一次未命中发生在记忆适用环境为 `range/neutral`、实时环境为 `uptrend/up` 时，低于现有匹配阈值，属于正确的按需不注入。
- 最近抽查的四条推理快照中，三条命中记录的最终提示词包含平台记忆标记，一条未命中记录不包含记忆正文，快照证据状态均为 `complete`。
- 两个复盘派生任务均为 `succeeded`；当前没有个人策略，因此没有个人记忆数据属于正常业务现状。

运行数据只作为代码结论的旁证，不作为放宽匹配或强制使用记忆的依据。

### 2.2 代码链路

```text
复盘确认
  -> period_review_derivation_jobs
  -> 生成平台记忆候选
  -> 管理员发布为 active
  -> retrievePlatformExperience() 确定性检索与打分
  -> scheduler/strategy 写入 _platformExperienceContext
  -> llm.js 仅在 platform + active + 命中时加入最终提示词
  -> 保存信号、推理快照和检索日志
```

关键代码：

- `server/routes/ai/period-review.js`
- `server/routes/ai/platform-experience.js`
- `server/routes/ai/scheduler.js`
- `server/routes/ai/strategy.js`
- `server/routes/ai/llm.js`
- `server/routes/ai/signal-presentation.js`
- `public/ai/app.js`

## 3. 必须保持不变的业务约束

实施过程中必须长期满足：

1. 未命中、关闭模式和影子模式不得把记忆正文注入正式模型请求。
2. 平台记忆只能参与绑定的平台策略，不得跨策略、跨作用域调用。
3. 品种、周期、入场方式、适用条件和避免条件继续由现有确定性匹配负责。
4. 不为提高命中率降低阈值，不把一条记忆强制用于所有行情。
5. 记忆只能作为参考，不能覆盖策略、风险控制、仓位边界、权限和输出格式。
6. 本方案不得重新生成、修改、合并、删除或批量回填现有记忆正文。
7. 不新增模型调用，不改变自动分析调度频率，不增加交易路径上的外部依赖。
8. 历史信号必须兼容，不要求对 `decision_json` 做数据库批量回写。

## 4. 问题与修复设计

### 4.1 P1：正式检索被管理页面显示为零

#### 当前行为

`public/ai/app.js` 的平台效果评估固定读取：

- `shadow_total`
- `shadow_hits`
- `shadow_hit_rate`
- 每个策略的 `shadow_hits / shadow_retrievals`

当策略处于 `active` 时，后端已经返回 `total`、`hits`、`hit_rate`、`active_total` 和 `active_hits`，但前端没有展示这些字段。

#### 修改方案

只调整 `renderPlatformExperience()`：

1. 主指标显示全部有效检索：`retrieval.total`、`retrieval.hits`、`retrieval.hit_rate`。
2. 增加一组简洁的模式拆分：正式使用 `active_hits / active_total`，影子评估 `shadow_hits / shadow_total`。
3. 策略列表主值使用 `hits / retrievals`，并在存在影子记录时补充影子数据，不再始终显示影子分母。
4. 保留“命中率只代表上下文匹配，不代表收益提升”的现有提示。
5. 空数据明确显示“尚无发布后的可评估检索”，不把 0 次检索描述为 0% 效果。

#### 文件

- `public/ai/app.js`
- `tests/ai/frontend-governance.test.js`

#### 验收

- active 模式有检索时，页面展示的检索次数和后端 `retrieval.total` 一致。
- shadow 模式数据仍然可见，但不再覆盖 active 数据。
- 不修改平台记忆策略的 mode、max_items 或 token budget。

### 4.2 P1：`used_ids` 与 `used_refs` 不一致导致采用数量低报

#### 当前行为

模型可能正确返回 `used_ids:[9]`，服务端也保存 `considered_refs:["platform:9"]`，但 `used_refs` 仍为空。前端只要发现 `considered_refs`，就完全按照 `used_refs` 计算采用数量，因此可能显示“系统候选 1、模型采用 0”，同时正文又说明采用了记忆。

#### 修改方案

采用“未来写入规范化 + 历史读取兼容”两层最小修复：

1. 在 `llm.js` 规范化模型结果时，对每个合法 `used_id` 查找可用引用中编号相同的引用。
2. 仅当编号唯一对应一个引用时自动补齐。例如平台 `9 -> platform:9`；若个人记忆同时存在 `short:7` 和 `long:7`，不得猜测。
3. `rejected_ids` 使用相同的唯一映射规则补齐 `rejected_refs`，并保证已采用引用不会同时进入 rejected。
4. 在 `signal-presentation.js` 或前端展示层增加同样的只读兼容逻辑，用于历史信号；不批量回写历史 `decision_json`。
5. 明确引用优先级：模型返回且通过白名单校验的 `used_refs` 优先；唯一 ID 映射只用于补缺，不覆盖显式引用。

#### 文件

- `server/routes/ai/llm.js`
- `server/routes/ai/signal-presentation.js`
- `public/ai/app.js`（仅在需要历史展示兜底时修改）
- `tests/ai/llm.test.js`
- `tests/ai/signal-presentation.test.js`
- `tests/ai/frontend-governance.test.js`

#### 验收

- 平台候选 `platform:9` 且模型返回 `used_ids:[9]` 时，最终同时保存 `used_ids:[9]` 和 `used_refs:["platform:9"]`。
- 多个引用共享同一数字 ID 时不进行模糊映射。
- 非候选 ID 和引用继续被丢弃。
- 历史 ID-only 平台信号展示的采用数量正确，无需数据库回填。
- 未提供记忆时，模型不得通过自由文本伪造采用记录。

### 4.3 P2：自动推理记忆日志缺少快照直接关联

#### 当前行为

自动推理事务调用 `persistInferenceSnapshotTx()` 后忽略返回的快照 ID，随后只执行：

```js
attachPlatformExperienceSignal(memory.logId, signalId)
```

因此日志可通过 signal 间接找到快照，但 `inference_snapshot_id` 始终为空。手动分析路径已经同时保存 signal ID 和 snapshot ID。

#### 修改方案

1. 自动推理事务返回 `{ signalId, snapshotId }`，不再只返回 signal ID。
2. 将 `persistInferenceSnapshotTx()` 的返回值保存为 `snapshotId`。
3. 平台记忆调用改为 `attachPlatformExperienceSignal(memory.logId, signalId, snapshotId)`。
4. 个人记忆自动分析路径同步传入 snapshot ID，保持两种作用域一致。
5. 关联失败继续只记录审计错误，不回滚已经成功生成的信号；记忆归因不是交易结果的提交条件。

#### 文件

- `server/routes/ai/scheduler.js`
- `tests/ai/platform-experience.test.js` 或新增 scheduler 归因测试
- `tests/ai/memory-system.test.js`

#### 验收

- 新的自动分析检索日志同时具有正确的 `signal_id` 和 `inference_snapshot_id`。
- 两个 ID 所指记录属于同一策略、同一信号。
- 手动分析现有行为不退化。
- 记忆归因写入失败时不会重复创建信号或触发第二次模型调用。

### 4.4 P2：未命中日志缺少候选淘汰原因

#### 当前行为

`retrievePlatformExperience()` 先过滤 `eligible=false` 的候选，再构造 `selectionDetails`。当唯一记忆被淘汰时，日志只显示空选择，无法直接区分：

- 品种或周期不匹配；
- 入场方式不允许；
- 行情综合得分不足；
- avoid 条件命中；
- token 预算不足；
- 已达到最多选择数量。

#### 修改方案

1. 保留现有最终选择算法，先生成完整的确定性评估结果，再从中选取合格项。
2. 日志增加紧凑的候选评估记录：`id`、`eligible`、`selected`、`score`、`reasons`、`exclusion_reason`。
3. 记录上限固定为前 20 个候选，避免活跃策略长期增加日志体积。
4. 对预算、最大数量和通用记忆数量限制分别记录标准化原因。
5. 不保存记忆正文，不新增数据库字段，继续复用现有 `selection_details_json`。

建议标准化原因：

- `context_not_eligible`
- `token_budget_exceeded`
- `max_items_reached`
- `universal_item_limit`
- `selected`

#### 文件

- `server/routes/ai/platform-experience.js`
- `tests/ai/platform-experience.test.js`

#### 验收

- 未命中日志至少能说明候选的 score 和确定性淘汰原因。
- 最终 `selected_item_ids_json` 与修改前相同输入下的结果完全一致。
- `selection_details_json` 不包含记忆正文、账户数据或提示词。
- 单次日志候选详情不超过 20 条。

## 5. 实施顺序

### 阶段一：修正用户可见事实

1. 修复 active/shadow 评估数据显示。
2. 修复 ID 与引用的规范化和历史展示兼容。
3. 补齐前端缓存键。
4. 完成静态与单元测试。

阶段一验收后，页面必须准确回答：“检索了多少次、命中了多少次、模型实际采用了哪些记忆”。

### 阶段二：补齐后台审计链

1. 保存自动推理 snapshot ID 并写入记忆日志。
2. 记录未命中候选的标准化淘汰原因。
3. 验证信号、快照、记忆日志三方关联。

阶段二不得改变模型输入和信号内容；同一冻结输入下的记忆选择结果必须与修改前一致。

### 阶段三：完整验证与部署

1. 定向测试通过后运行完整 `npm test`。
2. 执行 `git diff --check` 和语法检查。
3. 审查完整 diff，确认没有迁移、提示词正文和匹配阈值变化。
4. 提交并推送前确认工作区仅包含本方案文件范围内的改动。
5. 部署虚拟机后核对提交、进程、数据库、Redis、静态缓存键和启动日志。
6. 等待每个策略至少产生一次新推理，验证命中与未命中两类记录。

## 6. 测试方案

### 6.1 单元与静态测试

至少覆盖：

- `tests/ai/platform-experience.test.js`
- `tests/ai/llm.test.js`
- `tests/ai/signal-presentation.test.js`
- `tests/ai/frontend-governance.test.js`
- `tests/ai/memory-system.test.js`
- 自动推理信号与快照持久化相关测试

新增用例：

1. active 统计不再被 shadow 字段替代。
2. 唯一平台 ID 可以补齐引用。
3. 重复数字 ID 不做模糊引用映射。
4. 非候选 ID、引用被过滤。
5. 历史 ID-only 信号仍能显示正确采用数量。
6. 未命中候选记录具体原因。
7. 预算淘汰和上下文淘汰可区分。
8. 自动分析日志写入正确 snapshot ID。
9. 归因失败不影响信号事务和交易流程。

### 6.2 生产只读验证

部署后只读检查：

1. 两个策略的 policy mode 仍为预期值。
2. 新检索日志的 `selected_item_ids_json` 与冻结行情上下文匹配。
3. 命中快照包含平台记忆标记，未命中快照不包含。
4. 新日志同时具有 signal ID 和 snapshot ID。
5. 信号 `considered_refs`、`used_refs`、`considered_ids`、`used_ids` 一致。
6. 页面总检索、命中和策略拆分与数据库聚合一致。
7. 未命中记录能够直接解释原因。

不通过真实交易订单验证本修复，因为这些改动不应改变交易决策或执行路径。

## 7. 发布与回滚

### 7.1 发布条件

- 定向测试和完整测试全部通过。
- 无数据库迁移。
- 同一输入下的记忆选择 ID 与修改前一致。
- 前端缓存键已更新且 HTML、CSS、JS 版本一致。
- 本地、Gitee 和虚拟机提交一致。

### 7.2 回滚条件

出现以下任一情况立即回滚本批提交：

- 命中记录未将记忆加入最终提示词。
- 未命中或 off/shadow 模式错误注入记忆。
- 信号保存、快照保存或自动调度出现新异常。
- 页面采用数量与保存的规范化结果仍不一致。
- 记忆日志关联错误的信号或快照。

回滚只需要回退本批代码提交并重新部署；本方案不修改表结构和现有记忆数据，不需要数据库回滚。

## 8. 过度设计复审

本方案明确不采用以下做法：

- 不新增记忆表、审计表或后台 worker。
- 不引入新的模型调用来判断记忆是否匹配。
- 不使用向量数据库或语义搜索替代当前确定性匹配。
- 不批量重写历史信号和历史记忆。
- 不提高最大命中数和 token budget。
- 不调整现有匹配权重、阈值或记忆有效期。
- 不为了“每次都命中”创建通用兜底记忆。
- 不把记忆是否采用与交易执行强绑定。

复审结论：四项修复均可在现有字段和调用链上完成。阶段一解决用户可见的错误信息，阶段二补齐审计证据；没有必要扩展为记忆系统重构。

## 9. 最终验收标准

本方案完成的定义是：

1. 页面展示的检索、命中和采用数量与数据库及信号内容一致。
2. 每条新检索日志可直接关联其信号和推理快照。
3. 未命中可以从日志直接得到确定性原因。
4. 命中与未命中时的最终模型提示词保持正确边界。
5. 记忆选择结果、模型信号和交易执行行为没有因可观测性修复而改变。
6. 完整测试通过，虚拟机运行健康，无新增启动错误。

## 10. 本地实施结果

截至 2026-08-07，阶段一和阶段二首批代码已提交为 `1d68307b2a67b8092d90dd88ef50d690c993fd90` 并部署到虚拟机。部署后健康检查、数据库、Redis、远端提交和静态缓存键均通过验证；两个策略随后产生的新推理也完成了第 6.2 节要求的只读复核。

生产复核确认，11 次新检索的信号、推理快照和记忆日志关联全部正确；命中时记忆只在 active 模式下注入，未命中时没有误注入。复核同时发现新的窄缺口：部分模型在 `influence` 中明确说明采用记忆，却没有同步填写 `used_ids`/`used_refs`，甚至与 `rejected` 字段冲突，导致页面继续低报采用数量。

针对该缺口的后续修复采用共享的确定性归因规范化：只有明确指向记忆或经验的强肯定表达，并且候选编号或引用能够唯一映射时，才补齐采用字段；否定表达、多候选和同编号跨作用域场景继续失败关闭。该规则同时用于新推理写入和历史信号只读展示，不回写数据库、不新增模型调用，也不改变记忆检索或交易决策。后续修复已通过本地完整测试，但尚未提交、推送或部署。
