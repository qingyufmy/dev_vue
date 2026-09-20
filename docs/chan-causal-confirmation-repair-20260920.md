# 缠论因果确认修复与按请求周期计算

2026-09-20，本地 V4，基线提交 `9da33239`。本轮修复算法确认时间与线段终点稳定性，不调整分析/交易策略，不发送测试订单。

## 修改结果

- 分型确认时间取右侧标准 K 线首次形成的原始 K 线；后续包含合并不刷新同一个分型的确认时间。右侧标准 K 线在与中间标准 K 线发生非包含方向移动时才创建，此时已经具备该侧的严格分型关系，因此不会把确认回填到不满足条件的包含组内部。
- 较早的缺口端点仍等待反向特征分型确认时，`findSegmentEndpoint` 返回未确认，不把后面的端点提前发布为确认。较早端点明确失效后继续搜索；获得确认后才固定该端点。镜像的上涨/下跌路径均验证。
- 窗口版本升级为 `chan_window_v8`。策略分析仍由实际 `plan.timeframes` 驱动计算与归档；仅作为 EMA 数据源的周期不额外计算缠论。首页按当前选择的周期取数、计算与缓存。
- 缠论引擎不再将四个调优周期当作允许名单。其他合法周期使用通用 1800 根目标及 1400/1600/1800 根验证窗口。原四周期的历史深度保持不变，避免将窗口变化混入缺陷修复对照。
- 当前产品可选的 M1/M5/M15/M30/H1/H4/D1 均能计算。引擎识别周期标签不代表终端或接口已经支持所有自定义、周/月周期；终端/接口合同继续决定可选范围。历史不足不伪造成完整结构证据。
- 首页保留已有下拉框、图层和状态栏，仅移除“四周期以外不支持”的过期状态判断，不新增操作步骤或弹框。

## 同输入复查

冻结数据来自只读 MT5 XAUUSD.s 历史，使用同一回放时钟、同一历史窗口，保留旧版数据及结果不覆盖。

| 项目 | 修复前 | 修复后 |
|---|---:|---:|
| 完整逐根计算点 | 1704 | 1704 |
| 同一分型确认时间漂移 | 73 | 0 |
| 同起点确认段终点改写 | 1 | 0 |
| 固定左边界 H4 确认段撤回 | 1 | 0 |

M5/M15/H1/H4 分别为501/501/401/301点。未发现新增的未来分型时间、笔端点价格时间错配、同一中枢核心上下界改写或非末端笔改写。滚动窗口仍有13次历史段显示集合变化，涉及边缘历史及共识取舍；不将它们算成新的确认终点回写，也不声称所有历史图形在窗口滚动时完全不变。

追加真实终端 M1/M30/D1 样本：分别取得2000/2000/1704根。M1、M30按1800根计算；D1历史少于目标，返回历史/结构不足而非“不支持周期”。这是离线受控回放，不能作为对应历史日期在线服务健康或绝对时钟校准证明。

## 验证命令与结果

```powershell
pnpm exec vitest run server/tests/chan-causal-confirmation.test.ts server/tests/chan-requested-timeframes.test.ts server/tests/chan-analysis-source.test.ts server/tests/chan-v8-structure.test.ts server/tests/chan-model-projection.test.ts server/tests/public-chan-chart.test.ts
pnpm exec tsc -p server/tsconfig.build.json
pnpm --filter @aurum/trade typecheck
pnpm run verify:server-boundary-delta
git diff --check
```

6组33项定向测试通过；外部回放的27项边界检查通过；服务端源码及本次测试范围的严格类型检查、交易前端类型检查、服务端边界检查通过。全量 `server/tsconfig.json` 仍在未修改的测试文件报告类型错误，例如 `audit-trade-decision`、`bridge-account-stream`、`public-market-relay`；不表述为全仓类型检查通过。

永久回归样例位于 `server/tests/chan-causal-confirmation.test.ts`，保留真实 H4 价格端点并镜像检查；`chan-requested-timeframes.test.ts` 验证首页七周期、通用策略及仅 EMA 周期的边界。

本机详细证据：`D:/dev_codex/aurum-local-backtest/artifacts/2026-09-20-chan-fix-review/`；前次审计：同级 `2026-09-20-chan-special-audit/`。包括源码冻结编译、`replay-audit.json`、`replay-timeline.json`、`fixed-left-foundation.json`、`boundary-checks.json`、`added-periods-evidence.json`。两个目录共用原冻结历史文件进行前后对照。

## 本地加载与页面验证

完成源码构建后，经 `scripts/local-v4.ps1` 停止并重新启动 `full` 模式。接口、公共行情、AI 分析及网页服务正常启动；桥接网关与风控汇总仍显示重启前已有的业务异常，本次不据此宣称交易执行链路就绪。

在已登录的首页实际切换 M1、M30、D1，再恢复原 M5 和分型显示：M1/M30 分别显示1800根已收盘 K 线，并得到各自的笔、段、中枢；D1显示1704根及相应结构，走势为方向未定。页面未再显示“四周期以外不支持”。此处验证的是休市期间的历史图表计算和周期切换，并非实时报价验收。

## 限制

本次通过的是已发现缺陷及上述样本的回归，不是所有品种、任意周期或全部行情的数学证明。没有调用 AI 重做机会判断，没有更改模型对回收事件的解释规则。

旧分析归档的输出哈希属于旧算法。现有历史图表恢复逻辑遇到新算法重算不匹配时保留冻结 K 线、拒绝伪造原确认结构；本次未改写历史快照。需要严格复现旧图时应使用对应旧版本及冻结输入。
