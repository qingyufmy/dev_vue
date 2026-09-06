# 同库升级第二十五批：旧策略和订阅来源核对

新增只读策略来源检查，覆盖auto_prompt_types的25列及strategy_subscriptions的19列。通过.env连接当前dev_vue，核对实际字段顺序和实例身份，在一致性只读事务读取全部3条策略、5条订阅以及用户/账户ID。原始提示词和配置不输出，仅保存逐行摘要、提示词原始UTF-8 SHA-256、长度、配置键和状态摘要。没有转换或写入业务行。

## 已确认的转换语义

- 旧策略创建/更新路径使用scope=platform/private，平台owner为0，私有owner为真实用户；检查不把平台0视为需要新建的用户。当前3条均为平台策略，创建者引用存在。
- 2条策略当前active，另1条archived且已删除。当前版本号为44、1、11，不能创建不存在证据的1至44历史版本，也不能把当前正文当全部历史版本的正文。
- inference_mode当前均为platform_model，这是模型绑定方式，不能自动作为V4 analysis/trader分类。两个V4输出合同不同，尚需明确旧提示词和输出的承接方式。
- `strategy-ownership.js` 的effectiveSymbols明确：订阅symbols_json为NULL时继承策略品种；显式[]保持空。真实5条订阅中3条继承、2条显式选择，来源数组共5个品种出现项。此计数未做经纪商品种标准化、账户合并或授权过滤，不是已迁移的5条V4订阅。
- 首轮检查将NULL误报为非法JSON，核对旧管理/调度/分发代码后纠正。损坏JSON仍报告异常，不用继承掩盖；旧调度/分发还会规范化并限制所选品种，下一步转换必须覆盖这些规则，不能只展开数组。

## 验证与输出

[来源报告](dev-vue-strategy-source-review-20260906.json)逐一登记8个来源摘要及44个字段名。当前未发现来源JSON形状、父ID存在性、创建者、基础布尔值或description目标长度冲突；这不是权限、历史时间、完整版本或目标合同已兼容的证明。

5项定向测试通过：NULL继承/显式空/显式选择、损坏JSON、原始提示词字节与高版本号保留、孤儿/长文本报告、缺列与重复ID拒绝。真实 `--write` 后再次 `--verify` 读取，除观测时间外结果一致。

```powershell
node scripts/review-dev-vue-strategy-source.mjs --verify
pnpm exec vitest run tests/v4-strategy-source-review.test.js
```

当前报告executable=false，保留五项业务条件：analysis/trader和输出合同映射、配置逐字段转换、历史时间依据、账户/品种/执行权限、历史版本证据。下一步形成可执行的当前版本与订阅转换，并从历史冻结快照核实版本来源；不能自动发布策略、启用交易，不能把模型绑定方式当策略种类。原库维持182表/26步的上一批结构，本批无DDL/DML或部署。
