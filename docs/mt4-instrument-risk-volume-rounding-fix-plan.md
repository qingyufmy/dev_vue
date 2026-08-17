# MT4 品种风险规格与交易手数四舍五入修复方案

## 1. 文档状态

- 文档类型：正式实施方案
- 当前状态：已完成两轮复审，可进入实施
- 方案日期：2026-08-17
- 仓库基线：`dev_codex` / `7883301e9d06ae230a472dcffa4721994a756400`
- 虚拟机运行目录：`/www/wwwroot/aurum-ai`
- 关联事故：信号 `#12937`，MT4 用户的每手止损风险被计算为管理员 MT5 账户的 100 倍
- 本方案只定义后续修复，不授权修改生产数据库、重放信号、补单、重启服务、部署网站或发布 Bridge。

## 2. 总结

本次需要同时修复两个彼此相关、但不能混为一谈的问题：

1. **MT4 品种规格口径不稳定**：风险快照把 `MODE_TICKSIZE` 乘以 `MODE_POINT`，品种列表却直接返回 `MODE_TICKSIZE`；当经纪商实际返回口径与 MQL4 标准定义不一致时，服务器会收到错误的 `tick_size / tick_value` 组合。
2. **交易手数只向下截断**：服务器当前使用 `floorStep` 将理论手数按经纪商步长向下截断。用户要求改为四舍五入，因此需要新增明确的“按步长四舍五入”规则。

修复必须保留风险硬上限。建议的最终流程是：

```text
原始 MT4 品种字段
  -> 多来源 tick size 候选值与来源证据
  -> 服务器一致性校验/失败关闭
  -> 计算理论手数
  -> 按 volume_step 四舍五入
  -> 复算舍入后真实风险
  -> 若向上舍入突破风险额度，则回退一个步长
  -> 经纪商最小/最大/步长最终校验
  -> 下单或给出可审计拒绝原因
```

这意味着“四舍五入”是正常取值规则，但它不能绕过平台和用户设置的最大风险额度。

## 3. 已确认事实与当前实现

### 3.1 信号 12937 的证据

| 项目 | 管理员 MT5 | 用户 28 MT4 |
| --- | ---: | ---: |
| 账户净值 | 约 9,804.94 USD | 9,969.02 USD |
| 本次风险额度 | 49.0247 USD | 49.8451 USD |
| 止损距离 | 7.4 | 7.4 |
| 每手风险 | 740 USD | 74,000 USD |
| 理论手数 | 约 0.066 | 0.00067358 |
| 旧版最终手数 | 0.06 | 0 |

用户 28 的资金和风险额度都略高于管理员；未执行的直接原因是品种规格令每手风险放大了 100 倍，而不是账户资金较少。

### 3.2 MT4 上报口径不一致

当前 EA 的风险快照和品种快照使用：

```mql4
tick_size = MarketInfo(symbol, MODE_TICKSIZE) * point;
```

扩展品种列表却使用：

```mql4
tick_size = MarketInfo(symbol, MODE_TICKSIZE);
```

两条读取链不能同时代表统一的服务器 `tick_size` 契约。服务器当前也没有获得以下证据：

- MT4 原始 `MODE_TICKSIZE`；
- `MODE_POINT`；
- `SYMBOL_TRADE_TICK_SIZE`；
- 最终归一化来源；
- 规格一致性状态及异常原因。

### 3.3 服务器风险计算

`server/routes/ai/risk-policy.js` 当前在没有 MT5 原生 `order_calc_profit` 时使用：

```text
risk_per_lot = abs(entry - stop_loss) / tick_size * tick_value
theoretical_volume = risk_cap / risk_per_lot
approved_volume = floor(theoretical_volume / volume_step) * volume_step
```

MT4 没有当前系统可用的原生 `broker_calculation`，所以完全依赖品种元数据。元数据只要缩小 100 倍，每手风险就会放大 100 倍。

## 4. 修复目标与非目标

### 4.1 修复目标

1. MT4 的 symbol snapshot、risk snapshot、symbols 三条链统一使用同一个规格构造函数。
2. 同时保留原始值、候选值、最终值和选择来源，历史风险决策能够解释计算依据。
3. 对明显不一致或无法唯一解释的品种规格失败关闭，不允许猜测后下单。
4. 理论手数按经纪商 `volume_step` 执行十进制四舍五入，而不是一律向下截断。
5. 四舍五入后重新计算真实风险；任何交易都不得超过既有 `risk_cap`。
6. MT4 与 MT5 共享同一套最终手数取整、风险复核和审计字段。
7. 保持信号、止损、止盈、订阅关系、账户映射、Magic、幂等键和 Bridge 交易命令契约不变。

### 4.2 明确非目标

- 不回写信号 12937 或其他历史风险决策；
- 不自动补发被拒绝的订单；
- 不因为账户资金较多就放宽风险百分比；
- 不允许通过四舍五入突破用户或平台风险上限；
- 不在不知道原始 MT4 规格时为某个账号硬编码 `XAUUSD` 参数；
- 不把经纪商名称、账号或特定服务器写死在通用风控代码中；
- 不在本批次修改策略仓位档位和 `position_size_factor`。

## 5. 阶段 A：统一 MT4 品种规格契约

### 5.1 EA 内建立唯一规格构造函数

在 `bridge/adapters/mt4-ea/AURUMBridgeEA.mq4` 新增单一构造路径，例如：

```text
ReadRawInstrumentSpec(symbol)
  -> NormalizeTickSize(raw_spec)
  -> BuildInstrumentJson(normalized_spec)
```

以下出口必须调用同一构造函数：

- `SendSymbolSnapshot`
- `RiskInstrumentJson` / `SendRiskSnapshot`
- `BuildSymbolsPayload`
- diagnostics 中的品种规格部分

禁止各出口分别拼接 `MODE_TICKSIZE`。

### 5.2 同时采集原始值和候选值

建议新增可选证据字段：

```json
{
  "point": 0.01,
  "tick_size": 0.01,
  "tick_value": 1,
  "contract_size": 100,
  "tick_size_raw_marketinfo": 0.01,
  "tick_size_marketinfo_price_candidate": 0.0001,
  "tick_size_symbolinfo_candidate": 0.01,
  "tick_size_source": "symbol_info_trade_tick_size",
  "instrument_validation_status": "valid",
  "instrument_validation_reasons": []
}
```

字段含义：

- `tick_size_raw_marketinfo`：原始 `MODE_TICKSIZE`；
- `tick_size_marketinfo_price_candidate`：按 MQL4 标准“points”解释后的 `raw × point`；
- `tick_size_symbolinfo_candidate`：`SYMBOL_TRADE_TICK_SIZE` 返回的最小价格变化；
- `tick_size`：最终进入服务器风险公式的价格单位值；
- `tick_size_source`：最终值的确定来源；
- `instrument_validation_*`：选择是否唯一可信。

协议的 `payload` 当前允许扩展对象字段，但 Bridge JavaScript、Rust 合同、EA 静态合同测试都必须同步验证新增字段，不能只改 EA 文本。

### 5.3 归一化优先级

建议使用以下确定性顺序：

1. `SYMBOL_TRADE_TICK_SIZE > 0` 且能与 `digits / point` 对齐时，按其“最小价格变化”的契约优先作为价格单位 tick size；
2. SymbolInfo 不可用时，使用 MQL4 标准 points 解释的 `MODE_TICKSIZE × MODE_POINT`；
3. 两个候选都有效且近似相等时标记 `consistent`；
4. SymbolInfo 候选有效但与 MarketInfo points 候选相差一个或多个 10 倍数量级时，使用 SymbolInfo 值，同时记录 `marketinfo_semantic_mismatch` 告警和全部原始证据；
5. SymbolInfo 不可用，且原始 MarketInfo 值同时存在“points”与“价格单位”两种合理解释时标记 `ambiguous`，不得猜测后用于真实下单；
6. 只有一个解释有效时可使用，但必须记录 `fallback` 来源；
7. 全部无效时返回 `instrument_data_incomplete`。

不能仅凭 `XAUUSD`、`contract_size=100` 或历史管理员账户结果自动修正，因为账户币种换算、CFD 计算模式和经纪商合约都可能不同。

### 5.4 服务器二次校验

新增集中式规格校验模块，建议位置：

- `server/routes/ai/instrument-risk-metadata.js`

职责：

- 将所有数值转为有限正数；
- 验证 `tick_size >= 10^-digits` 的合理关系，允许经纪商 tick 大于 point；
- 验证 `volume_min / volume_max / volume_step` 且最小手数能按步长表达；
- 拒绝 `instrument_validation_status=ambiguous/invalid`；
- 把原始证据带入风险决策详情；
- 兼容旧 Bridge 时不自动猜值：无法证明口径时返回新的失败关闭代码。

建议新增拒绝代码：

- `R1_INSTRUMENT_DATA_INCONSISTENT`

详情至少包含：

- `platform`
- `tick_size`
- `tick_value`
- `point`
- `contract_size`
- `tick_size_source`
- `validation_reasons`
- Bridge/EA 版本

## 6. 阶段 B：理论手数按步长四舍五入

### 6.1 明确取整语义

新增十进制安全函数，不直接使用二进制浮点的裸 `Math.round(value / step)`：

```text
roundStepHalfUp(value, step)
```

规则：

1. 以 `volume_step` 为单位四舍五入；
2. 恰好半步时向上取一个步长（half-up）；
3. 最终小数位由 `volume_step` 推导，最多保留 8 位；
4. 取整网格以 `volume_min` 为原点，即 `volume_min + n × volume_step`；当 `volume_min` 本身是步长整数倍时，结果与以 0 为原点一致；
5. 结果必须再次通过 `volume_min / volume_max / volume_step` 校验。

示例：

| 理论手数 | 步长 | 四舍五入候选 |
| ---: | ---: | ---: |
| 0.064 | 0.01 | 0.06 |
| 0.065 | 0.01 | 0.07 |
| 0.066 | 0.01 | 0.07 |
| 0.125 | 0.05 | 0.15 |
| 0.0249 | 0.001 | 0.025 |

### 6.2 风险硬上限复核

四舍五入可能向上增加手数，因此必须在取整后执行：

```text
rounded_risk = rounded_volume * risk_per_lot
```

若 `rounded_risk <= risk_cap + money_epsilon`，接受四舍五入结果。

若向上舍入导致 `rounded_risk > risk_cap`：

1. 回退一个 `volume_step`；
2. 重新验证风险和最小手数；
3. 记录 `rounding_guard_applied=true`；
4. 若回退后低于 `volume_min`，维持 `R1.9_BELOW_MINIMUM_AFTER_RISK` 拒绝。

这里的 `money_epsilon` 只用于浮点误差，例如 `1e-8`，不得设置为风险比例容差。

以修正后的信号 12937 数据为例：

```text
risk_cap          = 49.8451
risk_per_lot      = 740
theoretical       = 0.06735824...
nearest_step      = 0.07
rounded_risk      = 51.80  > 49.8451
final_volume      = 0.06
final_risk        = 44.40
```

因此，该信号会正确使用四舍五入流程，但由于 0.07 手会超过已有风险上限，最终安全手数仍为 0.06。若用户希望允许 0.07 手，需要另行明确修改最大风险规则，不能隐藏在取整实现中。

### 6.3 审计字段

在 `R1.10_REAL_RISK` 和 `R1.9_BELOW_MINIMUM_AFTER_RISK` 详情中新增：

- `theoretical_volume`
- `capped_volume_before_rounding`
- `rounded_volume_candidate`
- `approved_volume`
- `rounding_mode: half_up`
- `rounding_step`
- `rounding_guard_applied`
- `rounded_risk_amount`
- `risk_cap`
- `calculation_source`
- `instrument_validation_status`
- `tick_size_source`

前端原因文本默认只展示最终结论，展开后显示上述计算过程，避免用户只看到“低于最小手数”而看不到异常规格。

## 7. 代码影响范围

### 7.1 Bridge / MT4

- `bridge/adapters/mt4-ea/AURUMBridgeEA.mq4`
- `bridge/native/crates/bridge-mt4/src/read_api.rs`（如严格 DTO 需要扩展）
- `bridge/native/crates/bridge-contract/src/lib.rs`
- 对应协议 fixtures 和兼容性测试

### 7.2 服务器

- 新增 `server/routes/ai/instrument-risk-metadata.js`
- `server/routes/ai/config.js`
- `server/routes/ai/risk-policy.js`
- `server/audit-localization.js`
- 风险详情前端渲染位置

### 7.3 测试

- `tests/bridge-mt4-ea-contract.test.js`
- `tests/ai/risk-policy.test.js`
- `tests/ai/config-risk-snapshot.test.js`
- `tests/audit-localization.test.js`
- Bridge Rust 合同及 read API 测试

## 8. 测试与验收矩阵

### 8.1 规格归一化单元测试

至少覆盖：

1. `MODE_TICKSIZE=1, point=0.01, SYMBOL_TRADE_TICK_SIZE=0.01`，最终 `tick_size=0.01`；
2. `MODE_TICKSIZE=0.01, point=0.01, SYMBOL_TRADE_TICK_SIZE=0.01`，识别两个解释相差 100 倍，采用经过验证的 SymbolInfo 值并记录口径告警；
3. SymbolInfo 不可用，标准 MarketInfo points 路径正常回退；
4. 两个候选冲突且无法证明时失败关闭；
5. `tick_value<=0`、`point<=0`、非法手数范围时拒绝；
6. symbol snapshot、risk snapshot、symbols 对同一品种输出相同最终规格。

### 8.2 手数四舍五入单元测试

至少覆盖：

1. 小于半步向下；
2. 等于半步向上；
3. 大于半步向上；
4. `volume_step` 为 `0.1 / 0.01 / 0.001 / 0.05`；
5. 向上舍入未突破风险额度时接受；
6. 向上舍入突破风险额度时回退一个步长；
7. 回退后低于最小手数时拒绝；
8. 非档位 AI 信号不得超过原始请求手数；
9. 档位仓位仍受 `max_position_size` 和 `volume_max` 限制；
10. MT5 原生 `order_calc_profit` 与 MT4 元数据路径使用相同取整规则。

### 8.3 回归测试命令

实施阶段至少运行：

```powershell
npm test -- --run tests/ai/risk-policy.test.js
npm test -- --run tests/ai/config-risk-snapshot.test.js
npm test -- --run tests/bridge-mt4-ea-contract.test.js
npm test -- --run tests/audit-localization.test.js
cargo test --manifest-path bridge/native/Cargo.toml -p bridge-contract
cargo test --manifest-path bridge/native/Cargo.toml -p bridge-mt4
```

还需运行仓库现有完整 JavaScript 测试集和 Bridge 格式检查；若完整 Rust 工作区耗时过长，至少记录未运行范围，不能把局部测试表述为全量通过。

### 8.4 真实 MT4 只读验收

发布前先使用已授权的模拟账户执行只读 `symbol_snapshot` 与 `risk_snapshot`：

- 比较原始/候选/最终 tick size；
- 比较 `tick_value`、`contract_size`、最小手数和步长；
- 用固定入场价/止损价离线复算每手风险；
- 与终端盈亏变化或已知模拟成交结果对照；
- 全程不发送 place/cancel/close 指令。

只有只读规格验证通过后，才进入另行授权的模拟账户最小手数交易矩阵。

## 9. 发布顺序与兼容策略

1. 先合并服务器对新字段的兼容读取、审计字段和失败关闭逻辑；
2. 在不启用强制校验的审计模式下观察 MT4 原始规格；
3. 构建、签名并发布新版 Bridge/MT4 EA；
4. 确认目标用户已升级，且风险快照包含来源证据；
5. 再启用 MT4 规格一致性强制校验；
6. 最后启用新的手数四舍五入规则；
7. 观察拒绝率、`rounding_guard_applied` 和规格异常分布。

旧 Bridge 缺少来源字段时：

- 过渡期允许维持旧行为但产生高优先级审计告警；
- 强制阶段必须失败关闭并提示升级 Bridge；
- 不得在服务器根据账号或经纪商名称静默套用修正倍率。

Bridge 发布必须继续使用独立 P-256 清单/包签名，不使用 Authenticode；网站部署、Bridge 发布和生产启用分别授权、分别验收。

## 10. 监控与回滚

### 10.1 监控指标

- `instrument_metadata_inconsistent_total{platform,symbol}`
- `instrument_tick_size_source_total{source}`
- `risk_volume_round_up_total`
- `risk_volume_rounding_guard_total`
- `risk_below_minimum_total{platform,symbol}`
- MT4 与 MT5 同品种 `risk_per_lot` 的数量级分布

日志不得包含完整交易账号、手机号或未经脱敏的用户身份。

### 10.2 回滚原则

- 服务器取整规则可通过版本化配置回退为 `floor`，默认仍须失败关闭异常规格；
- EA 回滚必须通过正式签名版本，不直接替换生产用户文件；
- 不回滚已生成的风险决策记录；
- 不因回滚自动重放、补发或取消任何订单。

## 11. 两轮复审记录

### 11.1 第一轮：交易安全与业务语义复审

发现并调整：

1. 初稿若直接把 `floorStep` 改为 `roundStep`，会让向上舍入后的真实风险超过 `risk_cap`。
2. 已补充“先四舍五入、后复算、超限回退一个步长”的硬门禁。
3. 明确 12937 在正确规格下仍应为 0.06 手，而不是为了显示四舍五入强行放到 0.07 手。
4. 明确不能按账号或 `XAUUSD` 写死 100 倍修正。

复审结论：在不改变最大风险政策的前提下，方案满足四舍五入需求并保持失败关闭。

### 11.2 第二轮：跨平台契约、兼容与可观测性复审

发现并调整：

1. 只修 `RiskInstrumentJson` 会留下 symbol snapshot 和 symbols 的口径分叉。
2. 已改为所有 MT4 品种出口复用单一构造函数。
3. 只保存最终 `tick_size` 无法事后解释经纪商兼容问题，已补充原始值、候选值、来源和验证状态。
4. 直接强制新字段会让旧 Bridge 全部不可交易，已增加服务器先行、审计观察、Bridge 升级、最后强制的分阶段顺序。
5. 已把真实 MT4 验收拆为只读规格验证和另行授权的交易矩阵。

复审结论：方案覆盖 EA、协议、服务器、审计、测试、发布与回滚闭环，可进入分阶段实施。

## 12. 剩余风险与实施前确认项

1. 需要在用户 28 当前经纪商 MT4 上读取真实的 `MODE_TICKSIZE`、`SYMBOL_TRADE_TICK_SIZE`、`MODE_TICKVALUE` 和 `MODE_POINT`，历史信号没有保存这些原始值。
2. 部分旧 MT4 build 可能不完整支持 `SYMBOL_TRADE_TICK_SIZE`，必须验证 fallback。
3. 非 USD 账户和利润币种转换不能仅靠 `contract_size × tick_size` 判断合理性。
4. 四舍五入会改变部分历史上本可执行订单的手数；上线前应使用脱敏冻结样本做差异报告，但不得重跑生产订单。
5. 若产品最终要求“即使超过风险额度也必须向上四舍五入”，这属于风险政策变更，需要单独批准，不能作为本缺陷修复的隐含行为。

## 13. 实施完成定义

只有同时满足以下条件才算完成：

- 三条 MT4 品种数据出口使用同一规格构造函数；
- 风险决策可追溯原始、候选、最终规格和来源；
- 异常或歧义规格失败关闭；
- 理论手数按步长 half-up 四舍五入，并通过舍入后风险硬校验；
- 单元、协议、回归和只读真实 MT4 验收通过；
- Bridge 与服务器按兼容顺序发布并确认目标用户升级；
- 未发生历史回写、补单或未授权生产交易。
