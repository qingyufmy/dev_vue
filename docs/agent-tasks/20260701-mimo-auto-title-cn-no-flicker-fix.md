# Mimo Code 任务：自动推理开关 title 全中文，并修复 hover 闪烁

## 分支要求

- 只在 `dev_codex` 分支开发。
- 不要合并 `main`。
- 完成后提交并推送到 `dev_codex`。
- 结果文件写入：

`docs/agent-results/20260701-mimo-auto-title-cn-no-flicker-fix-result.md`

## 背景

上一轮已经实现了自动推理开关按钮：

```html
id="autoAnalyzeMode"
```

的状态显示规则：

- 正文不显示策略名称。
- 策略名称放到鼠标移入时的 title 里。
- 开启后正文一直显示开启状态。
- 只有休市才显示暂停。
- 增加了倒计时和推理中状态。

但现在发现两个前端问题：

1. 鼠标移入后的 title 信息里仍然存在英文。
2. 鼠标移入后 title 提示一直闪烁，疑似状态刷新时不断重写 `title` 或重绘 badge 导致。

## 当前重点代码位置

文件：

- `public/ai/app.js`

重点函数：

```js
setBadge(id, text, type, withDot = true)
AUTO_REASON_LABELS
isMarketClosedReason(reason)
renderAutoAnalyzeBadge(s)
startUiTimer()
loadStatus()
auto_progress / new_signal WebSocket 消息处理
```

当前 `renderAutoAnalyzeBadge()` 会每秒被 UI timer 调用，用来更新倒计时：

```js
if (state.autoRuntime && state.autoRuntime.enabled) {
  renderAutoAnalyzeBadge(state.autoRuntime);
}
```

而 `renderAutoAnalyzeBadge()` 内部每次都会调用：

```js
setBadge('autoAnalyzeMode', label, type);
const el = $('autoAnalyzeMode');
if (el) el.title = title;
```

`setBadge()` 又会每次重写：

```js
el.className = ...
el.innerHTML = ...
```

这会导致鼠标 hover 时浏览器原生 title 反复刷新、消失、重新出现，从视觉上表现为闪烁。

## 问题 A：title 必须全中文

### 当前 title 中可能出现英文的来源

当前代码中 title 可能包含以下英文或英文式内部值：

- `market_open`
- `market_closed`
- `market_stale_tick`
- `market_unknown_no_tick`
- `admin_bridge_offline`
- `user_bridge_offline`
- `no_api_key`
- `redis_unavailable`
- `redis_lock_failed`
- `rates_failed`
- `rates_empty`
- `Tick 延迟`
- `MT5 时间`
- `API Key`
- `Redis`

用户要求：title 中不要出现英文。

### 要求

新增或完善本地化函数，例如：

```js
function autoReasonText(reason) {}
function autoMarketText(marketState) {}
function autoStageText(stage, stageLabel) {}
```

所有展示到 title 的内容必须走中文映射。

不要直接把后端原始 reason 写入 title：

```js
// 不允许
title += `\n市场：${s.market_state.reason || ''}`;
title += `\n内部状态：${s.paused_reason}`;
```

应改为：

```js
title += `\n市场状态：${autoReasonText(s.market_state.reason)}`;
title += `\n内部状态：${autoReasonText(s.paused_reason)}`;
```

### 中文映射建议

```js
const AUTO_REASON_LABELS = {
  admin_bridge_offline: '管理员桥接离线',
  user_bridge_offline: '用户桥接离线',
  bridge_offline: '桥接离线',
  market_open: '市场开放',
  market_closed: '休市',
  market_unknown: '市场状态未知',
  market_unknown_no_tick: '等待行情数据',
  market_stale_tick: '行情停滞',
  redis_unavailable: '缓存服务未连接',
  redis_lock_failed: '调度锁获取失败',
  redis_cooldown_active: '等待下一轮调度',
  no_api_key: '未配置接口密钥',
  strategy_disabled: '策略已停用',
  symbol_not_supported: '品种不支持',
  no_runtime_scheduler: '调度器未运行',
  no_online_subscribers: '无在线订阅用户',
  no_strategy: '未选择策略',
  no_symbols: '未选择品种',
  rates_failed: '行情获取失败',
  rates_empty: '行情为空',
  exception: '运行异常',
  disabled: '已关闭',
  unknown: '未知',
}
```

注意：

- `API Key` 改成 `接口密钥`。
- `Redis` 改成 `缓存服务`。
- `Tick 延迟` 改成 `行情延迟`。
- `MT5 时间` 如果用户要求严格全中文，可以改成 `桥接行情时间`。不要在 title 里出现 `MT5`。
- `market_open` 不能原样显示，要显示 `市场开放`。

## 问题 B：title hover 时闪烁

### 当前疑似原因

`renderAutoAnalyzeBadge()` 每秒执行一次。

每次执行都会：

1. 调用 `setBadge()`。
2. 重写 `autoAnalyzeMode` 的 `className`。
3. 重写 `autoAnalyzeMode` 的 `innerHTML`。
4. 重写 `autoAnalyzeMode.title`。

当鼠标停在按钮上时，浏览器原生 title 会因为属性被持续更新而闪烁。

### 修复要求

必须避免 hover 期间反复重写 title 或整个 badge DOM。

建议实现以下机制：

#### 1. 给 autoAnalyzeMode 增加渲染缓存

实现一个专门函数，例如：

```js
function applyAutoAnalyzeBadge(label, type, title) {
  const el = $('autoAnalyzeMode');
  if (!el) return;

  if (el.dataset.autoLabel !== label || el.dataset.autoType !== type) {
    // 只在正文或状态类型变化时更新 DOM
  }

  if (el.dataset.autoTitle !== title && !state.autoBadgeHovering) {
    el.title = title;
    el.dataset.autoTitle = title;
  } else if (el.dataset.autoTitle !== title) {
    // hover 中不要更新 title，先缓存
    el.dataset.pendingAutoTitle = title;
  }
}
```

#### 2. hover 期间不要更新 title

在初始化时绑定：

```js
const autoMode = $('autoAnalyzeMode');
autoMode.addEventListener('mouseenter', () => {
  state.autoBadgeHovering = true;
});
autoMode.addEventListener('mouseleave', () => {
  state.autoBadgeHovering = false;
  if (autoMode.dataset.pendingAutoTitle) {
    autoMode.title = autoMode.dataset.pendingAutoTitle;
    autoMode.dataset.autoTitle = autoMode.dataset.pendingAutoTitle;
    delete autoMode.dataset.pendingAutoTitle;
  }
});
```

注意：

- 不要重复绑定事件。
- 可以在已有初始化事件处绑定，例如统一初始化 `autoAnalyzeMode` click 的位置。

#### 3. 倒计时每秒只更新正文，不重写 title

倒计时变化时，按钮正文可以每秒更新：

```text
自动推理开启 · 下次 02:34
```

但 title 不应该包含每秒变化的倒计时，或者 hover 时不更新 title。

建议 title 中不要放具体秒级倒计时，只放：

```text
状态：开启
下次运行：等待倒计时结束
```

如果必须显示倒计时，也只能在非 hover 状态更新。

#### 4. 不要每秒重建 innerHTML

当前 `setBadge()` 每次会重建：

```html
<span class="badge-dot"></span>文本
```

建议针对 `autoAnalyzeMode` 用专用更新函数：

```js
function setAutoBadgeText(el, label) {
  let textNode = el.querySelector('.badge-text');
  if (!textNode) {
    el.innerHTML = '<span class="badge-dot"></span><span class="badge-text"></span>';
    textNode = el.querySelector('.badge-text');
  }
  if (textNode.textContent !== label) textNode.textContent = label;
}
```

这样倒计时变化时只更新 `.badge-text`，不会替换整个 badge。

## 正文显示规则必须保持不变

按钮正文只能出现以下几类：

```text
自动推理关闭
自动推理开启
自动推理开启 · 下次 02:35
自动推理中
自动推理暂停 · 休市
```

不要在正文显示：

- 策略名称
- 品种
- 接口密钥
- 缓存服务
- 管理员桥接离线
- 用户桥接离线
- 调度器未运行
- 行情获取失败

这些都放到 title。

## title 内容建议

关闭：

```text
状态：自动推理关闭
```

开启：

```text
策略：趋势突破策略
品种：XAUUSD、NAS100
状态：自动推理开启
内部状态：未配置接口密钥
市场状态：市场开放
```

正在推理：

```text
策略：趋势突破策略
品种：XAUUSD
状态：正在推理
阶段：模型推理中
```

休市：

```text
策略：趋势突破策略
品种：XAUUSD
状态：休市暂停
市场状态：行情停滞
行情延迟：130000毫秒
桥接行情时间：2026.07.01 16:59:00
```

## 验收标准

### 场景 1：title 全中文

鼠标移入 `autoAnalyzeMode`，title 中不应出现：

- `market_open`
- `market_closed`
- `market_stale_tick`
- `market_unknown_no_tick`
- `admin_bridge_offline`
- `user_bridge_offline`
- `no_api_key`
- `redis_unavailable`
- `rates_failed`
- `rates_empty`
- `Tick`
- `API Key`
- `Redis`
- `MT5`

### 场景 2：hover 时不闪烁

鼠标持续停留在 `autoAnalyzeMode` 上 10 秒：

- title 不应每秒消失/重新出现。
- 倒计时正文可以每秒变化。
- class 不应每秒无意义重写。
- `innerHTML` 不应每秒整体替换。

### 场景 3：倒计时仍正常

按钮正文仍能从：

```text
自动推理开启 · 下次 02:35
```

递减到：

```text
自动推理开启 · 下次 02:34
```

但 title 不闪。

### 场景 4：休市正文仍符合规则

休市或行情停滞时正文显示：

```text
自动推理暂停 · 休市
```

title 显示中文诊断。

### 场景 5：内部阻塞原因不出现在正文

例如未配置接口密钥时：

正文：

```text
自动推理开启
```

title：

```text
内部状态：未配置接口密钥
```

## 推荐检查命令

```powershell
node --check public/ai/app.js
node --check server/routes/ai/scheduler.js
npm test
```

如果能手工验证，请补充：

- 打开页面。
- 开启自动推理。
- 鼠标停留在 `autoAnalyzeMode` 10 秒。
- 记录 title 是否闪烁。
- 检查 title 是否全中文。

## 结果文件要求

完成后请写：

`docs/agent-results/20260701-mimo-auto-title-cn-no-flicker-fix-result.md`

结果文件必须包含：

- 修改文件列表。
- title 中文化规则。
- hover 不闪烁的实现方式。
- 验证命令。
- 是否做了手工验证。
- commit id。
- 仍未解决的风险。
