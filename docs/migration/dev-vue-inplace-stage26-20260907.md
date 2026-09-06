# 同库升级第二十六批：订阅品种转换

新增可复用纯转换器v4-subscription-symbol-conversion.mjs，并接入原有策略来源读取入口。转换绑定原始JSON摘要，区分NULL继承和显式选择；显式[]保持空集合，非法JSON/非字符串/空字符串形成阻断，不默认扩展到所有品种。

核对旧运行代码发现两条规则：config.resolveEffectiveSymbols按大写/去空白后取交集；admin-strategy-trades.resolveEffectiveSymbolsForDispatch还会去经纪商后缀。转换分别计算两路结果，保留它们用于独立对账，再比较规范化后的集合。若调度没有选中某品种而分发会选中，报告legacy_symbol_paths_disagree，不擅自采用范围更大的集合。标准化沿用旧的已知后缀和长品种专有后缀规则，BRK.B等短股票标识保持不同。

真实读取的源摘要与第二十五批一致。5条订阅均可转换品种部分，结果各含XAUUSD，两路无分歧；3条继承、2条显式选择的来源模式分别保留。结果见[品种转换回执](dev-vue-subscription-symbol-review-20260907.json)。symbolConversionReady仅代表这一字段组可转换，整体executable仍为false；没有宣称5条订阅已经写入或可执行。

10项新增转换测试与5项来源回归通过，覆盖NULL/空集合、交集、去重、大小写/后缀、股票标识、两路分歧、非法JSON及原始摘要不同。真实write-symbols后独立verify-symbols一致，原--verify来源检查仍通过。本批无DDL/DML、调度、交易或部署。

```powershell
node scripts/review-dev-vue-strategy-source.mjs --verify-symbols
pnpm exec vitest run tests/v4-subscription-symbol-conversion.test.js tests/v4-strategy-source-review.test.js
```

下一步将账户稳定映射、策略角色/版本映射与逐品种候选组合，验证合并后的唯一键及执行许可；同时处理时段、风险和记忆配置。原始NULL继承模式的历史证据必须继续保留，不能把一次冻结展开误称为保留未来动态继承。历史时间和版本证据、真实业务回填、最终全域升级及旧结构清理仍未完成。
