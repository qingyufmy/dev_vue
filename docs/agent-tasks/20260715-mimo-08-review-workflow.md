# Mimo Task 08：AI 复盘、用户编辑与确认工作流

## 前置

- Task 01、06、07 已审查通过。
- 分支：`dev_codex`。

## 目标

为完整平仓且证据可靠的 AI 订单生成复盘初稿，支持用户版本化编辑和明确确认；本阶段不注入经验。

## 必须实现

1. 新增 `trade_review_cases`、`trade_review_versions`、`trade_review_jobs` 和 attempt/lease 字段。
2. 任务状态覆盖 evidence pending/incomplete、ready、generating、draft、edited、needs revision、approved、failed。
3. 复盘证据包包含 outcome/deals、原始信号、inference snapshot、风控调整、批准订单、实际执行和可选事后 K 线；推理时数据与事后数据分区。
4. 缺历史真实提示词、归因歧义或关键证据时标记 evidence incomplete，不用当前提示词替代。
5. 使用 `resolveAiTaskModel(...usage=review)`；用户模型失败不静默使用平台额度。
6. AI 输出严格复盘 Schema，区分决策质量与结果；亏损不等于错误，盈利不等于正确；结论引用 evidence refs。
7. AI 初稿和每次用户编辑都创建不可变版本，不覆盖历史。
8. 分离 `trade_process_issue_status` 与 `review_content_status`。
9. 用户操作为“内容准确并确认”“内容有问题继续修改”“暂不处理”；确认绑定具体 version id。
10. 个人复盘默认仅本人可见；管理员默认只看任务健康和成本，不看正文。
11. Review worker 使用 DB lease、幂等键和最大重试；失败不能影响交易/风控。
12. 实现列表、详情、编辑、确认、重试和权限 API。
13. 添加证据缺失、版本并发、越权、重复任务、模型失败和确认版本一致性测试。

## 非目标

- 不创建经验记忆、不注入提示词、不压缩。
- 不做前端页面。
- 不复盘无法关联信号的外部订单。

## 验证

```powershell
npm test -- tests/ai/scheduler.test.js tests/ai/config-entitlement.test.js tests/ai/manual-prompt.test.js
npm test
```

## 交付

- 结果：`docs/agent-results/20260715-mimo-08-review-workflow-result.md`
- 提交并推送 `origin/dev_codex`。
- 附 API、状态机、隐私边界和模型成本说明。
- 完成后停止。
