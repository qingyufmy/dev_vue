# DeepSeek v4 Pro 中英文策略/输出合同历史模拟

这个目录是与网站运行时隔离的只读实验。它从 VM 导出当前最新的 active platform XAUUSD 策略和动态输出格式，从本机 MT5 获取最近 7 个日历日行情及可用的未来 M1，然后用同一冻结市场 JSON 做四个 cell 的 2×2 对照：

| cell | 策略正文与紧凑输入规则 | 输出合同块语言 |
| --- | --- | --- |
| `zh_zh` | 中文 | 中文 |
| `zh_en` | 中文 | 英文 |
| `en_zh` | 英文 | 中文 |
| `en_en` | 英文 | 英文 |

这样可以分别观察策略语言和输出合同块语言的主效应，并保留 ZH-ZH 与 EN-EN 的整体对照。输出合同因子只切换 system 中的合同标题、说明、schema 文本和等义响应语言规则；user task、市场标题、JSON keys、枚举、合同语义及“用户可见自然语言使用简体中文”的目标在四组完全相同。默认 8 个决策点，即 32 次正式模型调用。英文版本由同模型按约 4,000 字符的 Markdown 边界分块翻译，再单独翻译 schema；缓存复用前会逐块核对当前中文 source SHA、英文组装结果和 schema source SHA，不能只靠 token/shape 校验复用旧译文。

## 运行

以下命令均在仓库根目录 `D:\dev_codex\wall-street-skill-local` 执行。先确认 SSH alias、VM 项目目录和本机 MT5 终端均可用。

```powershell
python tests/experiments/deepseek-v4-pro-0813-bilingual-week-backtest/scripts/export_vm_strategy.py
python tests/experiments/deepseek-v4-pro-0813-bilingual-week-backtest/scripts/fetch_mt5_data.py --terminal-path 'D:\Program Files\MetaTrader 5\terminal64.exe'

# 零调用预检：只构建/验证 8 个冻结快照，不需要 API key
python tests/experiments/deepseek-v4-pro-0813-bilingual-week-backtest/scripts/run_experiment.py --samples 8 --dry-run

# 正式批次：首次会先做分块同模型翻译，再做 32 次四格请求
$env:FINPOINTS_API_KEY = '<只在当前 PowerShell 会话设置，不写入文件>'
python tests/experiments/deepseek-v4-pro-0813-bilingual-week-backtest/scripts/run_experiment.py --samples 8 --thinking-mode disabled
python tests/experiments/deepseek-v4-pro-0813-bilingual-week-backtest/scripts/build_report.py
```

不同 `--samples` 会生成不同的均匀决策点集合，所以不要把 `--samples 1` 当作可被 `--samples 8` 复用的 pilot。正式批次中每个成功的 decision_id+cell 都会即时落盘；若进程中断，以相同 `--samples 8` 重跑即可按请求哈希续跑。

如果明确要覆盖某个已成功 cell，才使用 `--force`；这会再次发起该请求。超时、429、5xx 和网络失败才按受限指数退避重试，成功的 HTTP 响应（包括内容格式错误）不会静默重发。主 2×2 为隔离语言因素，固定 `thinking.type=disabled`、temperature `0`、top_p `1`；`max-thinking-pilot/` 另存生产式 `thinking=enabled/reasoning_effort=max` 的尾延迟证据，不混入主效应。默认连接窗口 240 秒、最多一次网络重试，非流式 JSON mode、`max_tokens=8192`，均可由 CLI 调整。

没有环境变量时 runner 只在交互终端通过 `getpass` 读取 key。key 不写入源码、JSON、请求头记录、日志或报告；请求记录只保存不含 Authorization 的请求体、哈希、字节数和脱敏原始响应。

## 数据和时间边界

- `export_vm_strategy.py` 通过 `ssh aurum-vm` 将 Node 程序从 stdin 传给远端；只读执行 `SHOW COLUMNS`、筛选最新 active platform XAUUSD、读取策略字段，并复用 VM 的 `parseStrategyPolicy`、`buildStrategyOutputFormat` 和 Chan 窗口策略。不会导出用户、账户、持仓或余额数据。
- `fetch_mt5_data.py` 只使用 Python `MetaTrader5` 的行情读取接口，显式初始化指定终端，最后始终 shutdown。它不执行任何交易动作。
- MT5 rate/tick 的 `time` 在本终端是 broker server epoch，不可直接当 UTC。脚本要求 tick 时间推进，按 15 分钟步长校准 broker offset（当前终端观测为 UTC+3，即 +10800 秒），保留 raw `time_server_msc` 和校准证据；tick 陈旧、不推进或残差过大时 fail closed。`copy_rates_range` 的请求边界先加 offset，返回后再减 offset。
- K 线按转换后的 UTC 排序、去重、校验 OHLC，并过滤尚未收盘的 bar；缺口不填补。每个周期按 VM data plan、Chan 固定窗口和声明指标分别拉取 warm-up，不把最长周期的 warm-up 错用于所有周期。
- 决策点只把截至该点收盘的 visible K 线放入 prompt。Node helper 复用 VM 同 commit 的 `calculateMarketData`、`getChanWindowPolicy`、`prepareStrategyDataRuntime`，按生产路径应用 `projectStrategyContextChanForModel` 和 `compactInferenceMarketPayload`；system prompt 同时带上生产 `COMPACT_MARKET_INPUT_RULE`（英文策略 cell 使用等义英文翻译）。Chan 的完整内部结果不直接暴露给模型。默认要求 VM commit 与本地 HEAD 一致；若主工作树已前进，只有 `--reuse-verified-snapshots` 能复用由 clean detached worktree 在 VM commit 上精确重建、且文件哈希相同的快照，并保留独立验证 sidecar。
- 空仓历史模拟不含持仓管理 schema。未来 M1 仅用于独立回放，不进入 prompt；12 小时窗口任何一分钟缺口都会将交易标记为不可评估。结构合同无效、未知方向和不支持的 stop-limit 不进入成交/胜率/收益分母。

## 生成物

`artifacts/source/` 保存 VM 策略正文、中文动态 schema、英文翻译及运行时元数据和哈希；`artifacts/data/` 保存行情、MT5 时钟/版本/数据计划元数据和冻结 strategy snapshots；`artifacts/results/` 保存逐 cell 请求/响应、`experiment.json`、`summary.json`、`pairwise.csv` 与 `report.md`。原始响应的 `reasoning_content` 可审计和计量，但最终 JSON 只严格解析整个 `message.content`，不会剥离 Markdown fence 或截取前后文字中的对象。逐条叙述审计必须记录当前 32 条 request/response 哈希集合的 canonical SHA，否则报告与验证器拒绝加载。

`rejected-preexperiment-missing-compact-market-rule/` 完整保留首批 32 条诊断记录；该批缺少线上紧凑 K 线规则，明确排除于最终统计。其他 `rejected-preexperiment-*` 目录同样只作追溯证据。

回放规则固定为：市价信号按首根未来 M1 开盘价，limit/stop 按触发价；同一根 bar 同时触发止损和止盈时止损优先；stop-limit 无可靠的成交语义时明确标记 unsupported。报告同时列出 HTTP/JSON/合同合规、hold/buy/sell、入场方式、简体中文响应遵从率（四组目标一致；仅语言代理，不等于幻觉判定）、延迟/Token/字节、方向收益、成交、TP/SL/timeout、MFE/MAE 和 4h/12h 指标。实验没有提供历史记忆，因此 `experience_usage` 的六个引用数组及 `influence` 必须为空；把 schema 中的说明句原样抄入 `influence` 会被计为语义合同失败，而不是事实幻觉。成交回放只由机械/结构合同决定资格；这种单纯说明句回声不改变 signal、entry、价格或保护字段，因此不会单独剥夺回放资格。

## 离线验证

```powershell
python -m unittest discover -s tests/experiments/deepseek-v4-pro-0813-bilingual-week-backtest/tests -v
python tests/experiments/deepseek-v4-pro-0813-bilingual-week-backtest/scripts/verify_artifacts.py
Get-ChildItem tests/experiments/deepseek-v4-pro-0813-bilingual-week-backtest/scripts -Filter '*.py' | ForEach-Object { python -m py_compile $_.FullName }
node --check tests/experiments/deepseek-v4-pro-0813-bilingual-week-backtest/scripts/build_market_context.mjs
rg -n "sk-|Authorization: Bearer|order_send" tests/experiments/deepseek-v4-pro-0813-bilingual-week-backtest
```

最后一条允许 README 中的安全边界说明；其他源码和生成请求记录不得出现 key、Authorization 或交易调用名称。

## 解释边界

这是有限决策点、固定数据快照上的历史模型行为比较，不是交易建议、收益承诺或未来预测。报告只描述本样本事实，不宣称统计显著；JSON 合同通过也不代表市场事实正确，语言偏离只是可测的幻觉/遵从代理。英文策略/schema 由同一模型翻译，虽然 key、枚举、周期、数字、路径和残留中文均通过机器校验，但没有独立人工逐句认证语义完全等价。成交回放未模拟真实滑点、成交队列、点差变化、拒单、手续费、资金费、网络延迟、经纪商规则和账户风控；模型服务端版本与本机 MT5 包版本也可能变化，必须结合报告中的 commit、版本、窗口、payload/request/response 哈希审阅。
