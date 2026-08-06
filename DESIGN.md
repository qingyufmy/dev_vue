---
name: AURUM AI Trading System
description: 面向普通 MT5 用户的可信 AI 交易团队工作台
colors:
  primary: "#d4af37"
  primary-light: "#f0d060"
  background-base: "#080b14"
  background-surface: "#0d1117"
  background-card: "#111827"
  background-input: "#1c2333"
  text-primary: "#e2e8f0"
  text-secondary: "#94a3b8"
  text-muted: "#4a5568"
  border-default: "#1e293b"
  positive: "#ef4444"
  negative: "#10b981"
  system-success: "#2fd6a2"
  system-danger: "#ff6878"
  warning: "#f59e0b"
  information: "#3b82f6"
typography:
  display:
    fontFamily: "Noto Sans SC, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Noto Sans SC, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.35
  title:
    fontFamily: "Noto Sans SC, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "14px"
    fontWeight: 700
    lineHeight: 1.5
  body:
    fontFamily: "Noto Sans SC, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Noto Sans SC, Microsoft YaHei, PingFang SC, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
  numeric:
    fontFamily: "JetBrains Mono, Fira Code, Roboto Mono, Consolas, monospace"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "20px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  2xl: "24px"
  3xl: "32px"
  4xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.background-surface}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  button-secondary:
    backgroundColor: "{colors.background-input}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 16px"
    height: "40px"
  card:
    backgroundColor: "{colors.background-card}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "20px"
  input:
    backgroundColor: "{colors.background-input}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "8px 10px"
    height: "40px"
  chip:
    backgroundColor: "{colors.background-input}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "2px 8px"
    height: "24px"
  navigation-active:
    backgroundColor: "{colors.background-card}"
    textColor: "{colors.primary}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "9px 12px"
    height: "40px"
---

# Design System: AURUM AI Trading System

## 1. Overview

**Creative North Star: "智能交易团队"**

界面应像一支始终在线、分工明确的 AI 交易团队：分析师先给结论和证据，交易员说明执行状态，风控师解释放行或拒绝，策略师管理方法与模型，复盘师沉淀经验。科技感来自实时、精确、可验证的反馈，而不是霓虹装饰。

这是一个适合长时间盯盘的深色桌面工作台。信息密度可以高，但每个页面只能有一个首要答案；次要指标按需展开。布局以固定顶部状态栏、任务型侧边导航和可滚动主工作区为骨架，桌面端优先，并在窄屏下自然折叠为单列。

系统明确拒绝“信息密集却没有优先级”、内部错误码或英文术语直接暴露、卡片层层嵌套、游戏化霓虹、过量渐变、炫光和无意义动画。

**Key Characteristics:**

- 深夜蓝黑工作面与稀缺金色焦点
- 中文结论优先，专业证据渐进披露
- 数字精准、状态可解释、执行结果可核验
- 轻边界与色调分层，阴影只服务于浮层和关键焦点
- 动效短促且有意义，并完整支持减少动态效果

## 2. Colors

配色以冷静的深蓝黑为工作背景，以协作金标记当前任务和关键行动。交易方向红绿与系统运行状态色是两套独立语义，不得互相借用。

### Primary

- **协作金**（#d4af37）：当前导航、主操作、焦点边界和最重要的待处理状态；单屏使用面积必须克制。
- **提示金**（#f0d060）：协作金之上的短暂高亮，不作为大面积背景。

### Secondary

- **上涨红**（#ef4444）：遵循中文交易语境，仅用于做多、上涨和交易收益方向。
- **下跌绿**（#10b981）：遵循中文交易语境，仅用于做空、下跌和交易亏损方向。
- **系统成功青绿**（#2fd6a2）：仅用于连接正常、保存成功、任务完成等非交易状态。
- **系统故障红**（#ff6878）：仅用于系统失败、服务中断、危险操作等非交易状态。

### Tertiary

- **警戒橙**（#f59e0b）：等待、复核、临界风险和可恢复异常。
- **信息蓝**（#3b82f6）：中性说明、私有范围和非交易型信息状态。

### Neutral

- **深夜底**（#080b14）：应用最底层背景。
- **工作面**（#0d1117）：主内容滚动区域。
- **控制台面板**（#111827）：卡片、面板和主要容器。
- **输入层**（#1c2333）：输入框、次级按钮和选中前控件。
- **高亮文字**（#e2e8f0）：标题、结论和关键值。
- **说明文字**（#94a3b8）：正文、说明和非关键元数据。
- **静默文字**（#4a5568）：占位符与最低优先级提示；不得用于重要正文。
- **结构边界**（#1e293b）：面板、输入和导航的默认 1px 边界。

### Named Rules

**The One Gold Voice Rule.** 协作金只属于当前任务、关键行动和焦点状态；不得让多个区域同时争夺金色强调。

**The Semantic Color Rule.** 红、绿、橙、蓝只表达状态，不作装饰；任何颜色状态都必须同时有中文文本或图标。

**The Trading/System Separation Rule.** `positive/negative` 只描述交易方向；系统成功与故障必须使用 `system-success/system-danger`，避免把“上涨”误读为“故障”或把“下跌”误读为“成功”。

## 3. Typography

**Display Font:** Noto Sans SC（后备 Microsoft YaHei、PingFang SC、sans-serif）<br>
**Body Font:** Noto Sans SC（后备 Microsoft YaHei、PingFang SC、sans-serif）<br>
**Label/Mono Font:** JetBrains Mono（后备 Fira Code、Roboto Mono、Consolas、monospace）

**Character:** 中文无衬线字体保持亲切、稳定和高可读；等宽字体只负责价格、时间、手数和统计值，让实时变化保持视觉对齐。

### Hierarchy

- **Display**（700，24px，1.25）：页面名称与全屏建议标题；每个视图只出现一次。
- **Headline**（700，17px，1.35）：主要区域标题和模态窗口标题。
- **Title**（700，14px，1.5）：卡片标题、关键结论与列表主信息。
- **Body**（400，14px，1.5）：说明与分析正文，连续文本建议限制在 72ch 以内。
- **Label**（600，12px，1.4）：字段、按钮、状态和辅助元数据；默认不使用全大写或人为拉大字距。
- **Numeric**（600，14px，1.4）：价格、盈亏、时间、百分比和手数，启用等宽数字。

### Named Rules

**The Human First Rule.** 用户可见结论必须用自然中文；等宽字体和内部代码不能替代解释。

**The One Page Title Rule.** 一个页面只保留一个 24px 主标题，后续层级逐级收敛，禁止用多个超大标题制造噪声。

## 4. Elevation

系统以色调分层和 1px 边界建立大部分深度。静态内容保持平稳；卡片阴影只提供轻微环境分离，金色阴影只用于当前焦点，模态窗口使用更深的环境阴影与遮罩建立明确层级。

### Shadow Vocabulary

- **面板环境阴影**（`0 1px 3px rgba(0,0,0,.4), 0 4px 16px rgba(0,0,0,.3)`）：较大卡片与独立面板。
- **金色焦点阴影**（`0 0 0 1px rgba(212,175,55,.4), 0 4px 24px rgba(212,175,55,.1)`）：当前选择或关键结果，禁止批量使用。
- **模态环境阴影**（`0 25px 60px rgba(0,0,0,.7)`）：模态窗口和必须脱离页面流的操作。

### Named Rules

**The Layer Before Shadow Rule.** 先用背景层级和边界表达结构，阴影只用于悬浮、模态或当前焦点。

## 5. Components

组件应像可靠团队成员的工作工具：稳健、直接、反馈明确，不卖弄视觉效果。

### Buttons

- **Shape:** 轻柔圆角（10px），桌面常规高度 40px；触摸环境、主要操作和图标按钮不低于 44px。
- **Primary:** 协作金实色、深色文字、水平内边距 16px；每个操作区域只保留一个主按钮。
- **Hover / Focus:** 150ms 状态过渡；悬停增强亮度，键盘焦点使用清晰金色轮廓，不改变布局。
- **Secondary / Ghost:** 输入层背景或透明背景配 1px 结构边界；危险按钮必须使用中文动词和明确危险色。

### Chips

- **Style:** 24px 高胶囊形标签，用浅色调背景和对应语义文字，不使用强阴影。
- **State:** 选中状态同时改变边界、文字或图标；不得只靠底色区分。

### Cards / Containers

- **Corner Style:** 常规面板 14px，信息密集卡片可收紧至 8–10px。
- **Background:** 控制台面板或输入层，嵌套层级最多两层。
- **Shadow Strategy:** 静态列表优先无阴影，独立面板使用面板环境阴影。
- **Border:** 默认 1px 结构边界；彩色侧边条禁止超过 1px。
- **Internal Padding:** 12–24px，密集列表使用 12–16px，主要工作面板使用 20–24px。

### Inputs / Fields

- **Style:** 输入层背景、1px 结构边界、6px 圆角，桌面常规高度 40px；触摸环境不低于 44px。
- **Focus:** 金色边界加 3px 低透明度焦点环，必须支持 `:focus-visible`。
- **Error / Disabled:** 错误同时显示中文原因；禁用态降低对比度但保持文字可读，并说明不可操作原因。

### Navigation

侧边导航按用户任务分组，默认使用说明文字色；悬停进入控制台面板色，当前项使用低透明度金色背景、金色文字和 1px 边界。移动端压缩为可展开导航，但保持任务名称与待办数量可见。

### Decision Status

推理、风控和执行状态由“图标 + 中文结论 + 简短原因 + 可选详情”组成。必须明确区分 AI 建议、风控裁决和 MT5 实际结果；加载状态提供阶段或进度，失败状态提供下一步。

## 6. Do's and Don'ts

### Do:

- **Do** 先展示方向、执行建议、风控结论和实际状态，再按需展开行情与规则证据。
- **Do** 使用 4/8/12/16/20/24/32/40px 间距尺度和 6/10/14px 常用圆角，保持各页面节奏一致。
- **Do** 让协作金保持稀缺，让红绿橙蓝只承担明确状态语义。
- **Do** 为加载、等待、成交、拒绝和失败提供自然中文原因与下一步。
- **Do** 在 820px 以下将多列工作区收敛为单列，并确保主要操作和表单控件至少 44px 高。

### Don't:

- **Don't** 制造“信息密集却没有优先级”的页面，或让次要统计压过当前结论。
- **Don't** 直接暴露内部错误码或英文术语；技术详情必须翻译并放入渐进披露区域。
- **Don't** 卡片层层嵌套；视觉容器最多两层，第三层改用分隔、留白或列表行。
- **Don't** 使用游戏化霓虹、过量渐变、炫光和无意义动画；科技感必须来自实时反馈和精确数据。
- **Don't** 只靠红绿区分状态，或把语义色用于纯装饰。
- **Don't** 使用超过 1px 的彩色侧边条、渐变文字、巨大标题或无上下文的胶囊标签。
