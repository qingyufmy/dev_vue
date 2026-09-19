# 双提示词本地工具

把指定资料整理成规则，经人工审核后生成 `01-analyst-prompt.md` 和 `02-trader-prompt.md`，再检查输出、测试模型和比较版本。对应 [最终方案](../docs/dual-prompt-distillation-final-plan-20260919.md)。

Python 3.11+，核心功能只用标准库。无需安装服务或数据库。项目合同复核额外使用仓库已有 Node.js、Vitest 依赖。

## 先运行演示

在本目录打开 PowerShell：

```powershell
python examples/create_demo.py --output work/demo
$demo = Get-Content work/demo/workspace/builds/*/manifest.json -Raw | ConvertFrom-Json
python promptlab.py --work work/demo/workspace evaluate --build "work/demo/workspace/builds/$($demo.build_id)" --cases work/demo/cases.json --responses work/demo/responses.json
```

演示会生成两份**标明合成测试**的提示词，并让分析师输出进入交易员输入。它验证工具连通，不代表作者策略、实际模型测试或收益。重复运行时换一个空的 `--output` 目录，工具不会覆盖已有材料。

## 接入真实资料

```powershell
python promptlab.py --work work/author init
python promptlab.py --work work/author ingest --source "D:\你的资料目录" --channel author
```

只扫描明确指定的文件或目录，跳过软链接和目录联接，不修改原文件。UTF-8 的 TXT、Markdown、SRT、VTT、CSV、JSON、JSONL 可作为文本证据。字幕保留时间戳；CSV/JSON 保留原文，不自动宣称完成订单生命周期重建。

视频、图片、Excel、PDF 等会登记哈希并报告 `needs_text`，不会伪装成已识别内容。先将可靠字幕、画面说明或表格文本导出，再导入。本版不内置转写、OCR、MT5 历史采集或成交重建。

相同内容在同一来源通道下只保留一份源记录；剪辑或转码的近重复仍需人工识别。修正文本会生成新源记录，旧版保留。`--channel system` 用于系统反馈，其证据不能被当作作者原话或作者行为。

## 配置与提炼

编辑 `work/author/config.json`：

- `title`：方法名称。
- `symbols`、`timeframes`：实际要覆盖的品种和周期。
- `max_analysis_validity_seconds`：分析结果允许的最大有效期；没有策略默认值，必须明确填写。
- `model.endpoint`：完整 HTTPS Chat Completions 地址，例如 `https://api.deepseek.com/chat/completions`。
- `model.name`：自己实际使用的模型标识；工具不固定别名。
- `model.api_key_env`：密钥所在环境变量名，默认 `PROMPTLAB_API_KEY`；只填写变量名。
- `model.options`：需要时设置 `thinking`、`reasoning_effort`、`temperature` 或 `top_p`。具体支持以目标模型为准。

如要用模型提取规则，在当前会话设置对应环境变量后运行：

```powershell
python promptlab.py --work work/author extract --batch 导入返回的batch_id --live
```

`--live` 才会将该批文本发送给配置的模型。无密钥或无模型配置会明确失败。批次超过文本上限时要求拆分，不静默裁掉材料；每次调用有超时和大小限制，不自动重试。请求保留提示词、输入、原始最终返回和模型标识，失败也保留。密钥和 Authorization 请求头不写记录。

调用采用 `system + user`、`response_format=json_object` 和独立 JSON 检查；截断、空内容、工具请求、围栏或重复键均不作成功结果。接口依据：[DeepSeek Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)。本工具未随代码交付声称完成真实 DeepSeek 验证。

也可以直接人工整理 `rules.json`，无需调用模型。模型候选位于 `extractions/*.rules.json`，全部标记 `pending`。审核后把选定规则整理到工作目录的 `rules.json`，不要用新候选整包覆盖旧规则。

每条规则必须具有：

| 字段 | 内容 |
|---|---|
| `id`、`role`、`stage` | 唯一 ID、analyst/trader、方法阶段 |
| `origin` | explicit_statement / observed_behavior / engineered_definition / empirical_optimization |
| `statement` | 可直接写入提示词的完整规则 |
| `conditions`、`invalidation` | 前提、否决或失效条件，字符串数组 |
| `required_inputs` | 实际项目输入字段路径，字符串数组 |
| `evidence` | source_id、逐字 quote、时间点或位置 locator |
| `conflicts` | 未解决冲突；构建时必须为空数组 |
| `review` | status、reviewer、reviewed_at；审核通过用 approved，时间采用 UTC `...Z` |

分析师阶段：`context / structure / opportunity / invalidation / wait`。交易员阶段：`wait / entry / cancel / protection / exit`。没有某动作授权时，可以有证据地写明不使用该动作；不能为了凑齐阶段编造交易规则。

首次整理核对全部拟采用规则，后续只改受影响规则并重新审核。程序检查引文确实存在、来源通道和审核记录，但**不自动证明规则的解释忠实于作者**，这一点仍需阅读材料的人确认。

## 生成两份提示词

```powershell
python promptlab.py --work work/author build
```

输出保存在 `work/author/builds/<build_id>/`。提示词包含完整方法、输入说明、当前项目通用输出合同和无动作格式示例，不依赖外部文件。源材料引文和规则快照另存，供复查；原始本地路径和模型密钥不拼入提示词。

每次构建固定方法范围、已审核规则、来源记录和合同哈希；相同输入得到相同版本，新版不覆盖旧版。候选始终标记 `candidate / not_tested`，不会自行变成“已验证策略”。合成工作区只有显式 `--allow-synthetic` 才能构建，产物保持测试标识。

项目当前从策略正文之外追加通用合同，本工具把它内联到成品中；两者相同可兼容。合同变更后必须重新构建和评测。生成工具需要当前仓库源文件，**生成后的提示词正文不需要仓库**。

## 检查与模型测试

测试文件格式参考演示的 `cases.json`。每个案例需要 `id`、`role`、`scenario`、完整 `input`、`expect`。`expect` 是输出字段到预期值的映射，例如 `{"action":"hold","actions":[]}`，嵌套字段可用点路径。

`mode` 必须与工作区一致，`split` 使用 development 或 holdout。修改案例名称、预期值或批次划分不会清除同一输入的本地曝光记录；该记录只能识别本工具已看过的输入，不能证明外部从未曝光、交易过程独立或没有隐蔽未来数据。

```powershell
# 检查已保存的单次输入与原始 JSON 输出
python promptlab.py check --build work/author/builds/版本ID --role analyst --input 输入.json --output 输出.json

# 用预存返回验证流程，不计为真实模型测试
python promptlab.py --work work/author evaluate --build work/author/builds/版本ID --cases 案例.json --responses 返回.json

# 真实模型调用；可选 1–5 次重复
python promptlab.py --work work/author evaluate --build work/author/builds/版本ID --cases 案例.json --live --repeats 3

# 把评测结果交给当前项目公开推理断言再检查
python promptlab.py --work work/author project-check --report work/author/evaluations/运行ID/report.json
```

预存返回格式为 `{"案例ID":"模型原始JSON文本"}`。不要预先去围栏、修复字段或删掉失败结果。

交易员案例可以声明 `analysis_case_id`，引用同批前面一个通过的分析师案例。配对结果替换该案例的分析内容，原输入和有效输入分别留存，标为反事实配对测试；不会推进真实账户状态。原有入场事件若绑定了旧分析，工具拒绝直接拼接，必须重建一致的测试快照。

报告记录每次原始输出、错误、预期值检查、独立输入、版本和重复调用差异。协议检查通过不等于方法还原正确。至少人工复核明确机会、等待、已有持仓／挂单、失效、风险不足和数据缺失等代表案例，不能只测试两个等待样例。

本地检查覆盖字段、类型、动作格式、状态版本、目标归属、部分平仓互斥和显式入场事件等约束。`project-check` 调用当前公开推理断言，范围仍不包括完整风控、保证金、组合预算、终端执行和收益验证。报告中的 `execution_authorized` 永远为 false。

## 后续迭代

导入新增作者资料或系统反馈 → 提出具体修改 → 审核受影响规则 → 再构建 → 原案例回归与新案例验证 → 人工决定是否替换使用。

```powershell
python promptlab.py diff --before work/author/builds/旧版 --after work/author/builds/新版
python promptlab.py verify --build work/author/builds/新版
```

比较会列出新增、删除、修改的规则及提示词／范围／合同变化。它不自动宣称新版更好，不修改项目中的活动策略。

## 验证与代码职责

```powershell
# 本目录
python -m unittest discover -s tests -v

# 仓库根目录
node node_modules/vitest/vitest.mjs run --config dual-prompt-lab/vitest.config.ts
```

`lab/materials.py` 管资料；`rules.py` 管证据与审核；`compiler.py` 生成和比较候选；`validation.py` 做本地输出检查；`model.py` 调用配置的模型；`extraction.py` 提炼候选；`evaluation.py` 留存测试；`project_check.py` 复用项目断言；`cli.py` 只组装命令。

所有资料、演示和模型记录默认写入已忽略的 `work/`。若指定其他工作目录，应自行放在 Git 管理范围外。代码不写运行数据库、不调用 MT5、不发布策略、不自动调度。
