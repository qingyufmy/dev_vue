---
target: AI交易实验室
total_score: 23
p0_count: 0
p1_count: 3
timestamp: 2026-07-22T02-58-05Z
slug: public-ai-index-html
---
Method: dual-agent (A: /root/critique_design · B: /root/critique_evidence)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|------:|-----------|
| 1 | Visibility of System Status | 3/4 | MT5、自动分析、交易发送和建议有效期清晰，但风控裁决与 MT5 最终结果未独立呈现。 |
| 2 | Match System / Real World | 3/4 | 团队角色与中文表达自然；`XAUUSD.s`、`H1`、点差和置信度仍缺少小白解释。 |
| 3 | User Control and Freedom | 2/4 | 导航与刷新明确，但真实交易发送一击即开，且关键开关不是可键盘操作的控件。 |
| 4 | Consistency and Standards | 3/4 | 深色、金色和组件语言基本一致；状态与操作混用 badge，红色同时承担方向和危险语义。 |
| 5 | Error Prevention | 1/4 | 关闭操作有说明，但开启真实发送缺少二次确认和完整执行前置条件。 |
| 6 | Recognition Rather Than Recall | 3/4 | 当前建议与主要入口可见；确认真实成交安全性仍需跨分析师、风控师和交易员页面拼接。 |
| 7 | Flexibility and Efficiency | 1/4 | 有快捷入口和全屏监看，但缺少键盘快捷路径与高频操作加速。 |
| 8 | Aesthetic and Minimalist Design | 3/4 | 构图稳定且结论突出；六项账户指标、七周期和多个状态同时出现，首屏偏挤。 |
| 9 | Error Recovery | 2/4 | 有中文提示和部分恢复入口；部分错误仍直接拼接底层信息，恢复动作不总在问题附近。 |
| 10 | Help and Documentation | 2/4 | 有使用手册，但真实交易、置信度和风控状态缺少上下文帮助。 |
| **Total** | | **23/40** | **Acceptable：基础扎实，真实交易安全体验仍需显著加强。** |

## Anti-Patterns Verdict

**LLM assessment:** 基本通过 AI slop 检查。行情图、MT5 状态、建议有效期、持仓和角色导航都来自真实业务，不是通用 SaaS 拼装。仍有 10px 等宽 eyebrow、统一入场动画、渐变金色按钮、glow 与带边框卡片密集重复等生成式模板痕迹。最大问题不是“像 AI”，而是交易开关伪装成状态徽章，安全链路没有拆清。

**Deterministic scan:** CLI 共发现 4 项：1 warning、3 advisory。`public/ai/index.html:1016` 的 `#22c55e` 和 `:1126` 的 `#1a1a2e` 是真实设计令牌漂移；`:1121` 的字号层级告警仅针对更新日志模态，问题被放大；无准确行号的 numbered-section-markers 高概率误报，因为模型对比中的数字属于真实有序步骤。

浏览器 overlay 成功注入并观察到 161 个标记：99 个 `ai color palette` 和 16 个暗色发光告警主要命中了既定深夜蓝黑与金色品牌体系，属于高噪声；44 个“细边框 + 宽阴影”有组件族级真实风险，但部分命中隐藏或零尺寸元素；13 个 tiny body text、2 个布局属性动画较可信；1 个 overflow 裁剪需交互复现。评审结束后 overlay 已清除。

## Overall Impression

这是一个已经形成产品身份的专业交易工作台，不需要推倒重来。最大的机会是把首页从“很多数据都实时”提升为“用户在两秒内知道账户是否安全、AI 建议到了哪一步、现在是否需要行动”。

## What's Working

- 首页遵循“账户 → 行情 → 最新建议 → 当前持仓”的真实盯盘顺序。
- 最新建议先给方向与“是否执行”，再补充原因、有效期、置信度和关键价格，符合结论优先。
- “智能交易团队”的角色导航清晰，深蓝黑与稀缺金色总体克制，中文文案比典型量化后台亲切。

## Priority Issues

### P1 — 真实交易发送是一击即开的伪按钮

- **Why it matters:** 顶部 `#tradeMode` 是可点击 `<span>`，开启真实发送时不二次确认；鼠标误点即可改变高风险权限，键盘和读屏又无法识别其为控件。
- **Fix:** 拆分状态与操作，改为语义化 button/switch；开启和关闭都显示明确确认，列出账户、策略、风控边界与真实下单后果。
- **Suggested command:** `$impeccable harden 顶部真实交易控制`

### P1 — AI 建议、服务器风控与 MT5 结果没有持续拆成三层

- **Why it matters:** 小白可能把“AI 建议”误认成已通过风控或已经成交，尤其在顶部显示“交易发送开启”时。
- **Fix:** 在最新建议和全面监看中增加三阶段状态轨：`AI 建议 → 服务器风控 → MT5 结果`，每层显示状态、中文原因、时间以及“尚未发生”的明确文案。
- **Suggested command:** `$impeccable clarify 最新建议安全状态链`

### P1 — 关键文字和控件未达到 WCAG 2.1 AA

- **Why it matters:** `#gatewayMode`、`#tradeMode` 缺少 role/tabindex；多个 10–11px 标签使用低对比 `#4a5568`。浏览器检查中部分标签约 2.36–2.79:1，长时间盯盘和键盘操作都会受影响。
- **Fix:** 可点击 badge 改原生控件；补齐 `:focus-visible`、`aria-current` 和合适的 live region；关键标签提升到实测至少 4.5:1，并控制倒计时播报频率。
- **Suggested command:** `$impeccable audit AI交易实验室无障碍`

### P2 — 首屏监控信息超过小白的可处理范围

- **Why it matters:** 六账户指标、七周期、行情图、完整建议、持仓和顶部状态同时出现；认知负荷清单失败 5/8。
- **Fix:** 默认保留净值、浮盈、保证金风险三项，其余进入“账户详情”；周期保留 3–4 个常用项；首页唯一金色焦点指向当前需要处理的安全状态。
- **Suggested command:** `$impeccable distill AI交易实验室首页`

### P2 — 高风险区域的颜色语义冲突

- **Why it matters:** 红色既表示上涨/做多，又表示“交易发送开启”的危险权限；多处金色边框同时竞争焦点。
- **Fix:** 交易权限使用中性锁/解锁图标和明确文字；橙色只表示等待复核；红绿只表达交易方向/盈亏；金色只留给唯一当前行动。
- **Suggested command:** `$impeccable colorize AI交易实验室状态语义`

## Persona Red Flags

**Alex（高效专家）:** 没有首页快捷键或命令入口；关键交易权限不能键盘切换；确认一次执行链路需要跨多个角色页面。全屏监看和直接导航是现有优势。

**Sam（键盘与读屏用户）:** 两个顶部关键控件不在 Tab 顺序；低对比小字广泛存在；当前导航缺少 `aria-current`；整块建议区域可能因倒计时触发重复读屏播报。

**林先生（刚接触量化的 MT5 小白）:** 不清楚 `XAUUSD.s`、`H1`、点差和 64% 置信度如何影响行动；看到“交易发送开启”却无法立刻确认风控是否健康、是否存在待发送或已发送订单。

## Minor Observations

- “观望”在同一区域重复展示，信息增量低。
- “查看 AI 分析”在页头与建议卡重复。
- `page-eyebrow` 是典型 tiny tracked eyebrow，应逐步换成自然中文状态摘要。
- “全屏监看”的视觉权重高于其任务价值。
- 卡片统一 `fadeInUp` 对高频工具帮助有限，减少动态效果覆盖仍不完整。
- `public/ai/index.html:1016` 与 `:1126` 的硬编码颜色应归并到 DESIGN.md 令牌。

## Questions to Consider

- 如果服务器突然禁止交易，用户能否在两秒内说清：是 AI 没建议、风控拒绝，还是 MT5 发送失败？
- “交易发送开启”应该只是状态、直接操作，还是需要专门安全区承载的账户级权限？
- 首页唯一问题应是“市场在做什么”，还是“我的账户是否安全且现在需要我行动”？
- 置信度若不能直接指导小白行动，是否应让位给触发条件、失效条件和风控裁决？
