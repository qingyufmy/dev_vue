# Mimo Task 09：个人经验记忆、检索注入与压缩

## 前置

- Task 08 已审查通过。
- 分支：`dev_codex`；必读总设计第 17.8–17.15。

## 目标

把用户确认的复盘版本转为可撤销、可检索、可压缩、可追溯的个人经验，并安全注入适用推理。

## 必须实现

1. 新增 `experience_memory_items`、`experience_memory_summaries`、`memory_compression_jobs`、`memory_injection_logs`。
2. 只有 approved review version 可以创建经验；保存 review/version、scope、条件、lesson、anti-pattern、证据、Token、状态。
3. 用户编辑内容按不可信数据处理：长度限制、控制字符清理、分隔符转义、结构化渲染，不获得系统指令优先级。
4. 保存 `ancestor_memory_ids`、内容 hash；与祖先高度重复时标 duplicate candidate，不自动活动。
5. 检索按 user、strategy、symbol、timeframe、direction、entry method、market regime、最近性和可信度排序。
6. 默认运行时预算 800 tokens；每次保存实际/影子选中的 item、summary、Token 和检索原因。
7. 只在手动推理、私有自动推理或明确 `memory_mode=personal` 的逐用户推理注入个人记忆。
8. 平台 shared 推理禁止个人记忆；`platform_only` 保持共享。切 personal 必须转逐用户推理。
9. 固定 `<user_confirmed_experience>` 数据区明确不得覆盖策略、风控、权限和工具规则。
10. 压缩触发默认：同作用域 >20 条或 >4000 tokens；摘要 <=1200 tokens。
11. 压缩只读 active confirmed 来源，输出 source ids；不删除原始复盘/经验。
12. 压缩使用 source-set hash；来源变化则结果 stale 不激活。
13. 撤销来源经验立即使引用摘要失效，检索回退原子经验并排队重压缩。
14. 摘要版本可回滚；冲突经验保留适用条件。
15. 区分 retrieval shadow 和显式付费 paired inference experiment。
16. 使用 `resolveAiTaskModel` 的 memory_compression usage；DB job lease，失败不影响推理基础路径。
17. 用户可全局关闭个人记忆或撤销单项；历史 inference snapshot 不改写。
18. 增加跨用户隔离、共享信号隔离、预算、重复、撤销传播、stale 压缩、提示注入和回滚测试。

## 非目标

- 不自动调整置信度权重。
- 不自动提高 AI 建议手数或风险上限。
- 不把用户经验自动升级为平台公共经验。
- 不做前端。

## 验证

```powershell
npm test -- tests/ai/llm.test.js tests/ai/manual-prompt.test.js tests/ai/scheduler.test.js tests/ai/config-entitlement.test.js
npm test
```

## 交付

- 结果：`docs/agent-results/20260715-mimo-09-memory-system-result.md`
- 提交并推送 `origin/dev_codex`。
- 结果列出检索排序、Token 计算、失效传播和共享隔离证明。
- 完成后停止。
