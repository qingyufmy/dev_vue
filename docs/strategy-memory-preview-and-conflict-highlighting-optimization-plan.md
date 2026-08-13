# 统一策略记忆库 Markdown 预览、冲突定位与高亮提醒详细优化方案

## 1. 方案状态

- 方案类型：正式实施方案，尚未开始功能实现。
- 编制日期：2026-08-13。
- 目标分支：`dev_codex`。
- 代码基线：`0cefe0c08ce75db15a36b13b868cd7ab3033600c`；当前工作树存在其他未提交修改，实施时必须按文件和区块保护。
- 适用范围：用户端“策略记忆库”、统一管理后台“平台记忆”、日复盘、月复盘、统一记忆压缩和策略编辑后的冲突复核。
- 数据边界：本方案不改变“每个策略只有一个完整 Markdown 记忆库”的业务合同，不恢复短期/长期记忆、候选记忆或按需检索。
- 决策边界：系统只定位、累计和提醒冲突，不自动修改策略，不把展示标记写入记忆正文，不因一致性检查失败阻断交易分析或覆盖当前记忆版本。

## 2. 目标与非目标

### 2.1 目标

1. 记忆库默认以安全、可读的 Markdown 预览展示，默认不可编辑。
2. 用户主动切换到“查看原文”后才能编辑 Markdown，保存仍创建可恢复的新版本。
3. 与当前策略存在冲突的记忆逻辑块在预览层得到准确定位：
   - 未达到提醒阈值：橙色背景，显示“观察中 1/3、2/3”；
   - 达到提醒阈值：红色背景，显示“需要人工检查策略”；
   - 不只依赖颜色，同时显示图标、状态文字、次数和可展开证据。
4. 复盘新经验与策略冲突、既有记忆与策略冲突使用同一份冲突台账，但明确区分来源、证据计数和当前定位状态。
5. 人工保存记忆、策略修改、版本恢复、压缩成功和复盘沉淀后，异步重新检查当前策略与当前记忆的一致性。
6. 同一冲突只有来自不同且已确认的复盘证据才增加正式 `evidence_count`；自动一致性检查不得伪造“三次复盘”。
7. 模型返回的冲突原文必须由服务端在冻结策略和冻结记忆中精确验证，服务端生成稳定身份，禁止直接信任模型提供的位置、HTML 或冲突键。
8. 用户无需进入页面深处才知道存在冲突：策略记忆入口和管理端汇总展示待处理数量，但不扩展为邮件、短信或交易阻断。

### 2.2 非目标

- 不在 Markdown 正文中插入 `<mark>`、`<span>`、颜色代码、冲突标签或内部 ID。
- 不把冲突标记传给自动分析、手动分析、复盘或压缩模型；运行时仍只读取原始权威 Markdown。
- 不在原生 `<textarea>` 中实现局部着色。编辑态只显示原文和冲突数量提示，精确高亮只在预览态显示。
- 不使用模糊相似度强行定位已经被大幅改写的段落；无法精确验证时标记为“位置已变化，等待重新验证”。
- 不因一致性检查模型不可用、超时或输出无效而回滚人工保存、压缩结果或已确认复盘。
- 不自动批量扫描全部历史策略，不在数据库迁移中发起模型请求，不自动修复旧冲突数据。
- 不改变策略、独立风控、权限和实时行情高于记忆经验的运行时优先级。

## 3. 当前能力与缺口

### 3.1 可直接复用的现有能力

| 现有能力 | 当前文件/表 | 本方案用途 |
|---|---|---|
| 单策略唯一 Markdown 记忆库及版本历史 | `strategy_memory_libraries`、`strategy_memory_library_revisions` | 原文权威来源、预览版本身份、恢复能力 |
| 冲突累计与人工状态 | `strategy_memory_conflicts`、`strategy_memory_conflict_occurrences` | 保留三次独立复盘阈值、已处理/忽略流程 |
| 稳定 Markdown 逻辑块和 SHA-256 | `strategy-memory-semantics.js` 的 `buildStrategyMemorySourceManifest()` | 生成块 ID、块哈希和预览定位锚点 |
| 压缩语义覆盖映射 | 压缩结果 `coverage_map` 和 semantic manifest | 压缩后辅助迁移冲突绑定，最终仍需重新验证 |
| 复盘冻结策略和冻结记忆 | `period-review.js` | 验证冲突确实来自当时输入，不读取后来的版本 |
| 统一模型任务、租约、超时与恢复 | `ai_model_tasks`、model-task runtime | 一致性检查 worker 的持久任务和恢复能力 |
| 用户端冲突列表和人工操作 | `public/ai/app.js` | 扩展为预览内联高亮和入口计数 |
| 管理端平台记忆页面 | `public/admin/app.js` | 同步实现平台策略预览和冲突证据管理 |

### 3.2 当前缺口

1. 页面只有可编辑 `<textarea>`，没有默认只读的 Markdown 预览。
2. 冲突记录只有策略片段，没有权威的记忆原文、记忆块身份和检测版本，无法安全标红。
3. 当前 `conflict_key` 可由模型提供；同一冲突换一种表述可能被拆为多个 `1/3`。
4. 人工编辑、策略修改和压缩后没有主动一致性检查；冲突只能等待后续复盘偶然发现。
5. 冲突累计次数和“当前是否仍能在记忆中定位”混在一个概念里，旧位置变化后容易继续显示过期提醒。
6. 当前提醒主要在记忆库页面内部，没有入口级待处理数量。
7. 管理端仅显示达到阈值的数量，没有完整展示每个冲突的定位、证据和人工操作。

## 4. 最终业务合同

### 4.1 原文和预览的权威关系

1. `strategy_memory_libraries.content_text` 始终是唯一运行时正文。
2. 预览 HTML、块 ID、冲突背景色和展开详情都是派生展示，不构成第二份记忆库。
3. 预览响应必须携带 `version_no + content_hash + render_schema_version`；前端不得把其他版本的高亮覆盖到当前原文。
4. 查看原文模式保存时仍使用现有 `expected_version_no` CAS；保存成功才切换基线并刷新预览。
5. 预览态不能编辑，保存按钮只在查看原文模式出现。

### 4.2 冲突等级

| 展示状态 | 条件 | 预览呈现 | 是否要求人工检查策略 |
|---|---|---|---:|
| `unverified` | 主动一致性检查发现，但没有独立已确认复盘支持 | 中性/橙色提示“检查发现，等待复盘验证” | 否 |
| `observing` | 正式证据 `1..threshold-1` 且当前位置有效 | 橙色背景，显示 `1/3`、`2/3` | 否 |
| `attention_required` | 不同已确认复盘正式证据达到阈值且当前位置有效 | 红色背景和“需要人工检查策略” | 是 |
| `location_stale` | 策略或记忆已变化，旧冲突无法精确重定位 | 不标红正文；在冲突列表显示“位置已变化，待复核” | 否，直到重新确认 |
| `resolved` | 人工确认已处理 | 默认不高亮，保留历史 | 否 |
| `dismissed` | 人工忽略 | 默认不高亮，保留历史 | 否 |

红色只表示“已达到人工检查阈值且当前定位有效”，不能把一次模型检查的结果直接标红。

### 4.3 正式证据计数

- 只有 `period_review_cases.status='approved'`、`current_version_id=approved_version_id` 且策略归属一致的日/月复盘可以新增一次正式证据。
- 唯一性继续以“冲突 + 已批准复盘版本”约束，同一复盘重试、重新派生或重复确认不能重复计数。
- 日复盘一次可贡献一次；月复盘引用多个日复盘时，月复盘自身仍只算一个独立已确认复盘，不能按来源日数膨胀计数。
- 主动一致性检查只更新 `last_detected_at`、当前绑定和 `detection_count`，不更新正式 `evidence_count`。
- `dismissed` 不自动恢复；只有人工“重新打开”或出现服务端认定的新冲突身份时重新进入观察。

### 4.4 运行时优先级

无论冲突状态如何，模型运行时都必须继续遵守：

`当前策略 > 独立风控/权限 > 实时事实 > 策略记忆库经验`

冲突高亮不自动停用策略、不阻断分析、不修改订单动作；如果记忆与策略冲突，分析提示仍要求以当前策略为准。

## 5. Markdown 预览设计

### 5.1 页面结构

记忆库主区域使用熟悉的双模式分段控件：

```text
┌ 选择策略 ─────────────── v8 · 43,200/120,000 字 ─ 一致性已检查 ┐
│ [预览] [查看原文]                         [只看冲突] [重新检查] │
├───────────────────────────────────────────────────────────────┤
│ 预览：格式化 Markdown；冲突逻辑块带状态背景和文字标签         │
│ 原文：等宽 textarea；允许编辑；保存和取消修改仅在此模式出现   │
├───────────────────────────────────────────────────────────────┤
│ 冲突证据列表 / 版本历史 / 压缩状态                            │
└───────────────────────────────────────────────────────────────┘
```

### 5.2 模式规则

- 初次进入、刷新页面和切换策略后默认进入“预览”。
- 点击“查看原文”才加载可编辑控件并把焦点放到编辑区标题，而不是直接把光标放进正文。
- 原文有未保存修改时：
  - 切回预览仍显示已保存版本，并显示“预览显示 vN；你有未保存修改”；
  - 切换策略、恢复版本或离开页面前必须二次确认；
  - 压缩期间沿用现有草稿保护，不覆盖 textarea。
- 查看权限但没有管理权限的账号只显示预览，不显示查看原文和冲突处理操作。
- 空记忆库预览显示说明性空状态：“尚无已沉淀经验；确认日/月复盘后会形成第一版记忆。”

### 5.3 冲突块呈现

- 一个逻辑块有多个冲突时，按最高等级决定背景色，并显示“2 项冲突”等数量。
- 橙色使用警戒色低透明度背景；红色使用系统故障红的低透明度背景，正文对比度保持 WCAG 2.1 AA。
- 每个高亮块带可见状态标签、图标和按钮，不能只靠红/橙颜色。
- 点击“查看原因”在当前块下方内联展开，不使用模态框，内容包括：
  - 冲突摘要；
  - 当前策略原文片段；
  - 对应记忆原文片段；
  - `evidence_count / alert_threshold`；
  - 最近一次来源复盘和时间；
  - 建议核对内容；
  - “已处理”“忽略”操作。
- “只看冲突”只隐藏无冲突块，不改变原始顺序，不请求第二份正文。
- `resolved/dismissed/location_stale` 默认不染色；可在下方历史冲突列表中查看。

### 5.4 原文模式

- 保留普通 `<textarea>`，避免引入复杂富文本编辑器和 Markdown/HTML 双向转换。
- 顶部显示“当前保存版本有 N 个定位冲突，切换预览查看”。
- 不在 textarea 中模拟局部背景色，也不把块 ID 插入正文。
- 保存前继续执行容量、适用条件残留、版本冲突等现有校验。
- 保存成功后返回预览模式并启动异步一致性检查；如果用户希望连续编辑，可再次进入查看原文。

## 6. 安全 Markdown 渲染

### 6.1 渲染位置

采用服务端派生预览，前端不直接把 Markdown 转为未经审查的 `innerHTML`：

1. 服务端从当前库生成稳定逻辑块 manifest。
2. 每个逻辑块单独渲染 Markdown。
3. 使用项目现有 `sanitize-html` 建立记忆预览专用白名单。
4. 服务端在清洗后的块外包装可信 `data-memory-block-id`，而不是允许正文自行提供该属性。
5. 前端只展示同源 API 返回的已清洗块 HTML，并再次校验版本和内容哈希。

### 6.2 支持和禁止内容

首期支持：标题、段落、无序/有序列表、引用、粗体、斜体、删除线、行内代码、代码块和安全链接。

首期禁止：

- 原始 HTML；
- 图片、视频、音频、iframe、SVG、MathML；
- 表单、按钮、输入框；
- 内联样式、事件属性和任意 `data-*`；
- `javascript:`、`data:`、`file:`、协议相对链接；
- 页面内可伪造操作控件的标签和 class。

链接只允许 `https/http/mailto`，新窗口链接必须附加 `noopener noreferrer`。渲染依赖必须锁定版本并写入 `package-lock.json`，禁止 CDN 动态脚本。若实施时选择通用 Markdown 解析器，最终输出仍必须经过专用服务端 sanitizer；解析器本身不能作为安全边界。

### 6.3 预览响应

```json
{
  "ok": true,
  "library_identity": {
    "strategy_id": 1,
    "strategy_version": 12,
    "version_no": 8,
    "content_hash": "sha256"
  },
  "render_schema_version": 1,
  "blocks": [
    {
      "block_id": "sha256",
      "block_hash": "sha256",
      "html": "<h2>...</h2><ul>...</ul>",
      "conflict_state": "attention_required",
      "conflict_ids": [31]
    }
  ],
  "summary": {
    "attention_required": 1,
    "observing": 2,
    "unverified": 0,
    "location_stale": 1
  },
  "consistency_check": {
    "status": "succeeded",
    "checked_at": "2026-08-13 10:00:00"
  }
}
```

API 不返回模型提示词、模型完整原始输出、密钥、租约令牌或内部堆栈。

## 7. 冲突身份与精确定位

### 7.1 模型输出合同

日/月复盘和主动一致性检查的冲突项统一为：

```json
{
  "conflict_target": "existing_memory|proposed_experience",
  "category": "general|market_regime|entry_setup|chan_structure|risk_execution",
  "summary": "中文冲突摘要",
  "strategy_excerpt": "必须逐字来自冻结策略",
  "memory_excerpt": "必须逐字来自冻结记忆或本次候选经验",
  "suggested_change": "供人工核对的建议",
  "source_refs": ["outcome:101"]
}
```

删除模型可自由决定的 `conflict_key` 作为权威身份；兼容期可以接收但忽略该字段。

### 7.2 服务端验证

1. `strategy_excerpt` 规范化换行和空白后，必须在冻结策略正文中唯一或可确定地精确匹配。
2. `existing_memory` 的 `memory_excerpt` 必须完整落在冻结记忆的某一个逻辑块内。
3. `proposed_experience` 必须精确引用同一次复盘输出中通过验证的记忆更新/候选；复盘确认并确定性合并后再绑定最终块。
4. 来源引用继续执行当前 canonical case/version/source 校验。
5. 任何原文不存在、跨多个块、来源伪造或版本不一致的冲突项都拒绝持久化，不得退化为模糊定位。
6. 服务端计算：

```text
strategy_rule_hash = sha256(normalized_strategy_excerpt)
memory_claim_hash   = sha256(normalized_memory_excerpt)
conflict_identity   = sha256(identity_version + strategy_id + category
                             + strategy_rule_hash + canonical_conflict_lineage)
```

`canonical_conflict_lineage` 首次由已验证块建立；压缩通过 coverage 映射并重新验证后可延续同一 conflict ID。人工大幅改写且无法精确证明同一语义时不强行延续，等待新的已确认复盘重新建立证据。

### 7.3 逻辑块身份

- 复用 `buildStrategyMemorySourceManifest()`，不新建第二套 Markdown 分块规则。
- 需要把当前私有的分块/规范化能力通过稳定公共函数导出，压缩、预览和冲突定位共用同一合同。
- `block_id` 用于当前版本 DOM 定位；`block_hash` 用于跨同正文版本重定位。
- 前端不得根据字符串搜索自行决定高亮范围；所有绑定由后端返回。

### 7.4 压缩和人工编辑后的重定位

1. 压缩成功后，先用已验证 `coverage_map` 形成候选映射，再对新版本块和策略原文执行精确复核。
2. 人工保存或恢复版本后，仅按完全相同块哈希或唯一规范化原文匹配；不使用未审计的模糊相似度。
3. 无法定位时写 `location_stale`，不在相似段落上标红。
4. 新一致性检查确认冲突仍存在后，创建新 binding 并恢复相应高亮。
5. 策略版本变化时，即使记忆未变也必须重新验证策略片段；旧 binding 不可直接沿用。

## 8. 数据模型与迁移

### 8.1 迁移原则

- 新增幂等迁移 `183_strategy_memory_conflict_bindings_and_checks`。
- 不修改已经执行的迁移 181 和 182。
- 迁移只建表、加列和索引，不调用模型、不扫描全文、不批量改变现有冲突状态。
- 旧冲突继续显示在列表中；没有记忆定位证据的旧记录初始为 `location_stale`，不凭摘要猜测标红位置。

### 8.2 扩展 `strategy_memory_conflicts`

建议新增：

- `identity_version SMALLINT NOT NULL DEFAULT 1`；
- `conflict_kind VARCHAR(32)`：`review_experience_vs_strategy | existing_memory_vs_strategy`；
- `strategy_rule_hash CHAR(64)`；
- `canonical_lineage_key CHAR(64)`；
- `detection_count INT NOT NULL DEFAULT 0`；
- `verification_status VARCHAR(24)`：`unverified | matched | location_stale | superseded`；
- `last_detected_at DATETIME`；
- `last_validated_at DATETIME`。

工作流状态 `observing/attention_required/resolved/dismissed` 继续保留，不与定位状态混用。

### 8.3 新增 `strategy_memory_conflict_bindings`

每条记录表示“某个冲突在某个策略版本和记忆版本中的精确位置”：

- `id BIGINT UNSIGNED`；
- `conflict_id`、`strategy_id`；
- `strategy_version`；
- `library_version_no`、`library_content_hash`；
- `memory_block_id`、`memory_block_hash`；
- `memory_excerpt`、`memory_claim_hash`；
- `strategy_excerpt`、`strategy_rule_hash`；
- `location_status`：`matched | pending_merge | location_stale | not_found`；
- `detector_contract_version`；
- `consistency_job_id`；
- `created_at`、`validated_at`、`superseded_at`。

唯一约束至少覆盖：

```text
(conflict_id, strategy_version, library_version_no, memory_block_id)
```

查询索引至少覆盖：

```text
(strategy_id, strategy_version, library_version_no, location_status)
```

### 8.4 扩展 `strategy_memory_conflict_occurrences`

新增或在 `evidence_json` 外独立保存以下可查询字段：

- `binding_id`；
- `strategy_version`；
- `library_version_no`、`library_content_hash`；
- `memory_block_id`、`memory_block_hash`；
- `memory_excerpt`；
- `conflict_kind`。

现有唯一键 `(conflict_id, period_review_version_id)` 保留，防止重复计数。

### 8.5 新增 `strategy_memory_consistency_jobs`

建议字段：

- 业务身份：`strategy_id`、`strategy_version`、`library_version_no`、`library_content_hash`；
- 触发来源：`trigger_type`（manual_save、strategy_save、restore、review_merge、compression、manual_check、backfill）；
- 幂等键：`input_set_hash`；
- 状态：`queued | leased | succeeded | succeeded_noop | failed | stale | status_unknown`；
- 重试：`attempt_count`、`max_attempts`、`next_attempt_at`；
- 租约：`lease_token`、`lease_expires_at`；
- 模型任务：`model_task_id`；
- 结果摘要：`conflict_count`、`matched_count`、`stale_count`、`result_hash`；
- 错误：`last_error_code`；
- 时间：`created_at`、`updated_at`、`completed_at`。

唯一键：

```text
(strategy_id, strategy_version, library_version_no, input_set_hash)
```

同一输入只能有一个业务任务；重复触发返回现有真实状态，不能把终态任务重置为 queued。

## 9. 主动一致性检查 worker

### 9.1 触发时机

- 人工保存记忆库成功后；
- 恢复历史记忆版本成功后；
- 策略正文或策略版本保存成功后；
- 日/月复盘记忆确定性合并成功后；
- 记忆压缩成功或 `succeeded_noop` 后；
- 用户点击“重新检查”后；
- 灰度阶段对旧数据执行受控、限速的后台补检。

保存和压缩接口只负责创建/复用任务并立即返回，不能等待模型检查。

### 9.2 冻结输入

worker 在任务创建时冻结：

- 策略 ID、版本和完整策略正文哈希；
- 记忆库版本、内容哈希和完整正文；
- 逻辑块 manifest；
- 检测合同版本；
- 模型身份、物理输入/输出能力和任务预算。

检查请求必须传入完整策略和完整记忆库，不静默截断；超过模型物理输入限制时任务安全失败并在页面显示“当前模型容量不足，未完成一致性检查”。不得重新加入任务级输出 Token 硬上限，仍使用已确认的模型物理能力和统一任务预算。

### 9.3 模型职责与服务端职责

模型只负责提出候选冲突，不负责：

- 决定正式计数；
- 决定数据库 ID；
- 决定 HTML 或颜色；
- 决定是否自动修改策略；
- 生成可信来源或版本。

服务端负责精确原文匹配、来源验证、冲突身份、绑定、幂等、状态转换和前端展示数据。

### 9.4 并发与恢复

- 每个任务使用统一 model-task tracker、租约心跳、deadline 和 provider callback。
- 新策略/记忆版本产生后，旧任务完成时必须 CAS 检查版本和哈希；不匹配则标记 `stale`，不应用结果。
- worker 崩溃或租约过期按现有恢复框架检查 provider/model task 终态；`succeeded_noop` 视为成功。
- `provider_status_unknown` 不自动重发同一模型请求；页面显示状态未知，允许人工重新检查产生新任务。
- 同一策略连续短时间保存时按最新输入合并排队，旧 queued 任务标记 stale，避免模型请求风暴。
- 一致性检查失败不改变当前库 `compression_status`，不覆盖冲突历史，不影响分析运行时。

## 10. 复盘冲突链路调整

### 10.1 日复盘

- `strategy_conflicts` 增加 `conflict_target` 和 `memory_excerpt`。
- `existing_memory` 必须引用冻结记忆块；`proposed_experience` 必须引用同一响应中已验证的 `memory_updates`。
- 生成草稿时只验证并展示候选，不写正式 occurrence。
- 人工确认后，派生任务重新验证 canonical case/version，写正式 occurrence。
- 如果是待沉淀经验，先写 `pending_merge` binding；记忆更新形成真实修订后再绑定最终块。

### 10.2 月复盘

- 分块模型输出中的冲突必须带本分块合法的 `period_review_case:<id>` 来源。
- 汇总模型不能删除分块已经验证的冲突，也不能用无来源的新描述覆盖原冲突。
- 月度新记忆候选仍要求至少两个不同已确认日复盘支持；这与策略冲突的“三次才提醒”是两套独立阈值，不能混淆。
- 月复盘确认后，一个月复盘版本最多为同一 conflict ID 增加一次正式 occurrence。

### 10.3 复盘界面反馈

- 复盘详情显示“本次发现 N 项策略冲突候选”；明确说明只有确认后才计入观察次数。
- 确认成功后显示：
  - “记忆沉淀已排队/已完成”；
  - “冲突证据已记录，当前 2/3”或“已达到人工检查阈值”；
  - 不把压缩成功误当作冲突检查成功。

## 11. API 设计

### 11.1 读取预览

```http
GET /api/ai/strategy-memories/:strategyId/preview
```

可选参数：`version_no`；默认当前版本。服务端校验权限、版本和内容哈希后返回第 6.3 节结构。

### 11.2 创建或复用一致性检查

```http
POST /api/ai/strategy-memories/:strategyId/consistency-checks
```

请求可带当前 `expected_version_no`；响应使用 HTTP 202，返回非敏感任务摘要和是否复用：

```json
{
  "ok": true,
  "created": true,
  "replayed": false,
  "job": { "id": 18, "status": "queued" }
}
```

### 11.3 查询检查状态

```http
GET /api/ai/strategy-memories/:strategyId/consistency-checks/latest
GET /api/ai/strategy-memories/:strategyId/consistency-checks/:jobId
```

轮询遵循现有压缩任务的 2 秒、页面隐藏暂停、generation 隔离和终态停止规则，不新增 WebSocket 复杂度。

### 11.4 冲突处理

保留：

```http
POST /api/ai/strategy-memory-conflicts/:id/resolve
POST /api/ai/strategy-memory-conflicts/:id/dismiss
POST /api/ai/strategy-memory-conflicts/:id/reopen
```

扩展请求携带 `expected_updated_at` 或显式 revision，防止两个页面同时处理导致静默覆盖。操作后刷新预览和汇总数量。

### 11.5 列表汇总

策略记忆列表增加：

- `attention_required_count`；
- `observing_count`；
- `unverified_count`；
- `location_stale_count`；
- `consistency_check_status`、`last_consistency_checked_at`。

入口角标只显示 `attention_required_count`，观察项在进入页面后展示，避免制造持续告警噪声。

## 12. 前端状态与交互实现

### 12.1 用户端状态

在现有 state 基础上增加：

- `strategyMemoryViewMode: 'preview' | 'source'`，默认 `preview`；
- `strategyMemoryPreview`、`strategyMemoryPreviewIdentity`；
- `strategyMemoryConflictFilter`；
- `strategyMemoryExpandedConflictIds`；
- `strategyMemoryConsistencyJob` 和独立 polling generation；
- 当前策略对应的原文草稿和 dirty 状态。

策略切换、压缩轮询和一致性检查轮询必须按 `strategy_id + version_no + content_hash + generation` 隔离，旧响应不能覆盖新策略。

### 12.2 加载顺序

1. 加载策略列表和当前库详情。
2. 默认并行加载当前预览和最新一致性任务。
3. 先显示骨架结构，不在内容中心放一个无限 spinner。
4. 预览失败时保留“查看原文”入口，显示自然中文错误和“重试预览”；不得把原文隐藏。
5. 检查任务运行时显示“正在核对策略一致性”，不禁用查看和编辑；只有保存/压缩本身的并发规则继续生效。

### 12.3 轮询和即时刷新

- 检查任务 `queued/running/validating/applying` 时每 2 秒轮询。
- `document.hidden` 时暂停，重新可见后立即检查一次。
- 终态后重新加载详情和预览。
- 如果原文有未保存修改，终态刷新不得覆盖 textarea，只更新预览缓存并提示“检查已完成；预览仍基于已保存版本”。
- 所有动画支持 `prefers-reduced-motion`；状态变化只使用 150–250ms 淡入/颜色过渡，不闪烁。

### 12.4 管理端一致性

统一管理后台的平台记忆页实现相同的预览/原文模式、冲突块、重新检查和人工处理能力。权限仍由平台内容管理能力控制，不在前端复制授权规则。

## 13. 文件级实施范围

预计修改：

### 后端

- `server/migrations.js`：迁移 183。
- `server/routes/ai/strategy-memory-semantics.js`：导出统一逻辑块公共合同。
- 新增 `server/routes/ai/strategy-memory-markdown.js`：Markdown 渲染和专用清洗。
- `server/routes/ai/strategy-memory-library.js`：预览聚合、binding、稳定冲突身份和人工处理 CAS。
- 新增 `server/routes/ai/strategy-memory-consistency.js`：任务服务和 worker。
- `server/routes/ai/period-review.js`：冲突输出、原文匹配和确认后 occurrence。
- `server/routes/ai/strategy-memory-compression.js`：压缩成功后的重定位/检查入队。
- `server/routes/ai/strategy.js` 或策略保存服务：策略版本变化后入队检查。
- `server/routes/ai/index.js`：新增预览和检查路由。
- `server/index.js`：启动、唤醒、恢复和优雅停止一致性 worker。

### 用户端

- `public/ai/app.js`：模式、预览、高亮、过滤、轮询、草稿保护和冲突操作。
- `public/ai/styles.css`：预览排版、橙/红状态、焦点、响应式和 reduced-motion。
- `public/ai/index.html`：静态资源 cache key 更新。

### 管理端

- `public/admin/app.js`：平台记忆预览和一致性任务。
- `public/admin/styles.css` 或现有管理端样式文件：相同状态语言。
- `public/admin/index.html`：静态资源 cache key 更新。

### 测试

- `tests/ai/strategy-memory-semantics.test.js`；
- `tests/ai/strategy-memory-library.test.js`；
- 新增 `tests/ai/strategy-memory-markdown.test.js`；
- 新增 `tests/ai/strategy-memory-consistency.test.js`；
- `tests/ai/period-review.test.js`；
- `tests/ai/strategy-memory-compression.test.js`；
- `tests/ai/frontend-governance.test.js`；
- 必要时增加迁移合同测试和浏览器行为测试。

实施前必须重新检查共享工作树，以上同名文件已有其他修改时按逻辑合并，禁止覆盖。

## 14. 分阶段实施顺序

### 阶段 A：冻结合同和迁移

1. 写迁移 183 和迁移幂等测试。
2. 导出统一逻辑块函数，确保压缩现有语义测试不变。
3. 定义冲突身份、binding、job 状态和稳定错误码。

验收：不改现有运行时正文；旧 API 和旧冲突列表继续可用。

### 阶段 B：安全预览

1. 实现服务端 Markdown 分块渲染和清洗。
2. 实现 preview API 和缓存身份。
3. 用户端、管理端增加默认预览/查看原文模式；先不接主动模型检查。

验收：恶意 Markdown 无法执行脚本；保存/恢复/压缩草稿保护无回归。

### 阶段 C：复盘精确冲突证据

1. 修改日/月复盘输出合同。
2. 验证 strategy/memory excerpt 和 canonical source。
3. 服务端生成冲突身份、正式 occurrence 和最终块 binding。

验收：同一批准复盘不重复计数；三次不同批准复盘才变红。

### 阶段 D：主动一致性检查

1. 实现任务、worker、模型任务跟踪和恢复。
2. 接入保存、恢复、策略修改、复盘合并、压缩完成触发点。
3. 实现状态 API、轮询和“重新检查”。

验收：检查失败不影响保存/分析；旧结果不能覆盖新版本；自动检查不增加正式 evidence_count。

### 阶段 E：高亮、入口提醒和管理端完善

1. 预览块按 binding 展示橙/红背景。
2. 内联证据、只看冲突、入口数量和人工操作。
3. 管理端补齐与用户端相同的证据详情。

验收：颜色不是唯一状态信号；键盘、窄屏、减少动画均可用。

### 阶段 F：受控补检与灰度

1. 新策略/新版本先启用自动检查。
2. 旧策略只在打开页面、人工点击或限速后台批次中检查。
3. 记录模型调用量、失败率、平均耗时、冲突命中/拒绝率和 stale 比例。
4. 稳定后再扩大旧数据补检；禁止在迁移或启动时全量突发请求。

## 15. 测试与验收矩阵

### 15.1 单元测试

- Markdown 块 ID、块哈希在相同正文下稳定。
- 标题、列表、空行的分块和压缩 manifest 完全一致。
- Markdown 原始 HTML、脚本、事件属性、危险 URL、SVG、表单和伪造 data 属性被移除或转义。
- 模型 excerpt 不存在、跨块、重复歧义、来源伪造时失败关闭。
- 服务端忽略模型 `conflict_key`，相同有效原文生成相同身份。
- 主动检查不增加 `evidence_count`。
- 不同已确认复盘达到 1/3、2/3、3/3；同一版本重试仍只算一次。
- dismissed 不自动恢复，reopen 根据阈值恢复正确状态。

### 15.2 数据库与并发

- 迁移 183 在空库、已有 181/182、重复执行模拟下均幂等。
- 同一 input set 并发入队只创建一个检查任务。
- 终态任务复用不重置 queued。
- 人工保存发生在检查运行期间，旧结果变 stale 且不写 binding。
- 压缩和检查并发时只应用匹配当前版本/哈希的结果。
- occurrence 唯一键阻止重复计数。
- 人工处理冲突的 CAS 拒绝过期页面覆盖。

### 15.3 调用链

- 日复盘 existing/proposed 两种冲突正确验证。
- 月复盘分块冲突不会被 merge 模型静默丢弃。
- 复盘未确认不计数；确认后派生失败可重试且不重复。
- 没有记忆更新但有现有记忆冲突时仍能记录正式证据。
- 压缩 succeeded、succeeded_noop、failed、stale、status_unknown 各自触发正确后续状态。
- 策略修改后旧 binding 立即不再标红，重新检查成功后才恢复。

### 15.4 前端行为

- 初次进入默认预览且不可修改。
- 查看原文后才能编辑和保存。
- dirty 草稿切换预览、策略、压缩完成、检查完成时不丢失。
- 红色只用于 attention_required + matched；观察项橙色；stale 不误标相似段落。
- 一个块多个冲突取最高级并可逐项展开。
- “只看冲突”保持原顺序。
- 用户端和管理端权限、文案和处理操作一致。
- 2 秒轮询、隐藏页暂停、可见恢复、generation 隔离、终态停止。
- 820px 以下单列、键盘焦点、屏幕阅读器状态和 reduced-motion 合格。

### 15.5 安全与性能

- 预览 XSS 攻击集合全部失败。
- 预览 API 不泄露模型原始输出、密钥、租约和完整内部审计 JSON。
- 超长 Markdown 渲染有字符/块数量边界，不造成事件循环长时间阻塞。
- 一致性检查遵守模型物理输入输出限制、统一超时、并发容量和速率限制。
- 预览以 `strategy_id + version_no + content_hash + render_schema_version` 缓存，正文未变化不重复渲染。
- 全量 Vitest 通过；受影响 JavaScript `node --check` 通过；`git diff --check` 通过。

### 15.6 浏览器验收

本地服务按仓库规则在可见 PowerShell 控制台重启并验证 `/health` 后，使用 Codex 内置浏览器检查：

1. 默认预览、查看原文和保存新版本；
2. 观察中/需处理/位置变化三种视觉状态；
3. 展开证据、只看冲突、已处理、忽略、重新打开；
4. 检查排队、运行、成功、失败、状态未知；
5. 压缩与检查同时发生时的状态；
6. 未保存草稿保护；
7. 窄屏、键盘和减少动画；
8. 控制台无错误、网络请求无旧响应覆盖。

UI 修改验收需要保存截图，但不得为了造数据修改真实策略或真实记忆；使用测试夹具或专用本地策略。

## 16. 可观测性与审计

### 16.1 指标

- 一致性任务 queued/running/succeeded/noop/failed/stale/status_unknown 数量；
- 排队耗时、模型耗时、总耗时；
- 模型候选数、服务端接受数、原文验证拒绝数；
- matched/location_stale 比例；
- observing 升级 attention_required 数量；
- 人工 resolved/dismissed/reopen 数量；
- 每策略检查频率和模型使用量。

### 16.2 审计事件

- `strategy_memory_consistency_check_queued/completed/failed`；
- `strategy_memory_conflict_bound/location_stale`；
- `strategy_memory_conflict_resolved/dismissed/reopened`；
- 审计只保存必要身份、哈希、状态和数量，不保存密钥或完整模型提示词。

日志中的错误码保持稳定，用户界面映射为中文；不得直接显示 provider 堆栈或 SQL。

## 17. 灰度、兼容与回滚

### 17.1 功能开关

建议复用 rollout governance 增加两个独立开关：

- `strategy_memory_markdown_preview_enabled`：只控制预览/原文 UI 和 preview API；
- `strategy_memory_consistency_checks_enabled`：控制模型检查 worker 和自动触发。

冲突正式计数和原有列表保持工作，不依赖预览开关。

### 17.2 兼容

- 原 `GET /strategy-memories/:id`、保存、恢复、压缩和冲突 action API 保持兼容。
- 旧冲突没有 memory binding 时仍出现在列表，但不标红正文。
- 旧客户端继续看到 textarea 和冲突列表；新字段均为新增响应字段。
- 平台与私有策略继续使用现有授权服务。

### 17.3 回滚

- 关闭 preview 开关后恢复当前 textarea 展示，原文和版本不变。
- 关闭 checks 开关后停止领取新任务，已运行任务安全结束或恢复；现有冲突数据保留。
- 数据库新增表和列不在应用回滚时删除，避免审计丢失；旧代码忽略新结构。
- 不通过回滚改写记忆正文或策略正文。

## 18. 已知风险和控制

| 风险 | 影响 | 控制 |
|---|---|---|
| 模型对同一冲突表述变化 | 证据被拆分或误合并 | 强制精确 excerpt；服务端身份；不信任模型 key |
| 压缩重写段落 | 块 ID/哈希变化 | coverage 候选映射 + 新版本精确复核；失败则 stale |
| 人工大幅改写 | 无法证明同一冲突 | 不做模糊标红；等待重新检查/复盘 |
| 主动检查成本增加 | 模型费用和排队压力 | 幂等、合并、限速、灰度、手动补检 |
| Markdown XSS | 账号与业务安全 | 服务端解析、专用 sanitizer、禁止原始 HTML/媒体/表单 |
| 红色告警过多 | 用户疲劳 | 红色仅 3 次正式证据；一次扫描为橙/中性 |
| 检查失败被误解为保存失败 | 操作困惑 | 保存与检查状态分离；保存成功立即反馈 |
| 旧数据无定位 | 历史提醒不能立即标红 | 保留列表，标位置待验证；受控补检 |
| 并发旧结果覆盖 | 错误高亮或状态 | 版本/hash CAS、任务 stale、前端 generation 隔离 |
| 管理端与用户端行为分叉 | 维护成本和误操作 | 共享 API/状态映射/测试合同，权限仍后端权威 |

仍无法完全消除的风险：冲突判断本质上包含模型语义判断。即使精确定位和三次来源阈值成立，也只能提示人工核对，不能把结果当成自动修改策略的确定事实。

## 19. 两轮方案复审

### 19.1 第一轮复审：需求覆盖、边界、复用和最小改动

检查结论：

1. 已覆盖“默认预览不可修改、查看原文可编辑、冲突原文标红”的直接需求。
2. 初稿若只用现有 `strategy_excerpt` 做前端字符串搜索，会把策略片段误当记忆片段；已改为必须保存并验证 `memory_excerpt + block identity`。
3. 初稿若把全部一次检测结果标红，会破坏项目既定“三次独立已确认复盘后才提醒修改策略”；已区分 unverified、observing 和 attention_required，红色只给达到阈值的有效定位。
4. 初稿考虑在 textarea 中局部着色，会引入复杂叠层编辑器和光标同步问题；已收缩为预览精确高亮、原文纯 textarea。
5. 已复用现有语义 manifest、压缩 coverage、冲突台账、model-task runtime 和轮询模式，没有设计第二套记忆库或第二套分块器。
6. 为解决“既有记忆与策略冲突不能主动发现”，新增一致性 worker 是必要扩展；通过异步、幂等和功能开关控制成本，没有让保存等待模型。
7. 预览服务端渲染而非前端直接解析，减少静态前端引入不受控 HTML 的风险。

第一轮调整后结论：范围满足需求，新增结构均服务于精确定位、主动检查或安全预览，不包含自动改策略、富文本编辑器和全量历史重算等过度设计。

### 19.2 第二轮复审：兼容、迁移、并发、恢复、安全、测试和回滚

检查结论：

1. 迁移必须使用新编号 183，不能修改已执行 181/182；已明确为只建结构、不执行模型和数据改写。
2. `evidence_count` 与主动扫描次数原本容易混淆；已新增 `detection_count/verification_status`，主动检查不伪造复盘次数。
3. 工作流状态与位置状态原本可能互相覆盖；已拆为 conflict status、binding location status 两个维度。
4. 检查运行时人工保存可能让旧结果覆盖新版本；已要求冻结身份、终态 CAS、stale 结果不应用。
5. 重复入队和终态复用可能重现压缩任务曾出现的“终态被重置 queued”；已要求唯一 input set、返回真实状态、终态不重置。
6. `succeeded_noop`、provider status unknown、租约恢复和页面隐藏轮询均已纳入状态机。
7. Markdown 解析器不是安全边界；已增加专用 sanitizer、危险标签/协议白名单和块外可信属性。
8. 旧冲突无法定位时不能猜测；已规定列表保留、正文不标红、受控补检。
9. 功能回滚不能删除新增审计表或改写正文；已拆分预览和检查开关，并保持旧 API 兼容。
10. 测试矩阵已覆盖 XSS、三次阈值、幂等、CAS、压缩重定位、草稿保护、可访问性和浏览器行为。

第二轮调整后结论：方案可实施。剩余实质风险只有模型语义判断的不确定性和主动检查带来的成本；两者已通过人工最终裁决、精确原文验证、阈值、幂等、灰度和指标控制，不构成自动交易或数据覆盖风险。

## 20. 最终实施验收门槛

以下条件全部满足，才能视为完成：

1. 用户端和管理端默认安全预览，查看原文才可编辑。
2. Markdown 正文、模型输入和版本历史中不存在任何展示高亮标记。
3. 红色块均可追溯到当前策略版本、当前记忆版本、精确块、至少三次不同已确认复盘。
4. 一次主动扫描结果不会显示为“需要修改策略”。
5. 策略或记忆变化后旧高亮不会继续附着到相似但未经验证的文本。
6. 保存、恢复、压缩、复盘沉淀和分析运行时没有回归。
7. 定向与全量测试、语法、迁移幂等、浏览器安全/交互验收全部通过。
8. 两个 rollout 开关可独立关闭，回滚不丢原文、版本和冲突审计。
