# 双提示词本地工具

- 目标是生成可独立使用的分析师和交易员提示词，按父项目 `docs/dual-prompt-distillation-final-plan-20260919.md` 执行。
- 原始材料只读。真实资料、模型输入输出和密钥不能进入 Git；默认工作目录为已忽略的 `work/`。
- 缺少资料或审核时拒绝构建，不虚构作者规则。合成示例必须保持 `synthetic`，不能作为真实策略或模型兼容证明。
- 只生成本地候选和评测记录，不接入交易终端、不写运行数据库、不自动发布或修改策略。
- Python 工具使用标准库；项目合同只在构建时读取，公开推理断言经独立 Vitest 测试调用，不跨入业务私有实现。
- 检查：本目录运行 `python -m unittest discover -s tests -v`；仓库根运行 `node node_modules/vitest/vitest.mjs run --config dual-prompt-lab/vitest.config.ts`。
