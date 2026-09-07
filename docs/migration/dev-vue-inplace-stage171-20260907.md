# 阶段 171：学习域显式命令入口

新增 scripts/migrate-dev-vue-learning.mjs：

```powershell
node scripts/migrate-dev-vue-learning.mjs --check <course-manifest.json> <progress-manifest.json> <reviewed-evidence.json>
node scripts/migrate-dev-vue-learning.mjs --verify <course-manifest.json> <progress-manifest.json> <reviewed-evidence.json>
node scripts/migrate-dev-vue-learning.mjs --recover <course-manifest.json> <progress-manifest.json> <reviewed-evidence.json>
```

环境读取复用已有受限 loader：server/.env 或既有 Linux 私有 FD，数据库限定 dev_vue/规定恢复副本。独立 reviewed-evidence.json 为 [evidenceId,sha256] 二元组数组，不从清单自身推定外部审查通过。命令开始先检查清单摘要，不输出源业务内容、定位符或凭据。

runLearningCommand 在同连接持有现有升级锁，核对两个目标身份与备份 UUID；来源和当前用户集合在显式 READ ONLY 快照中读取并回滚。随后重新解析两份清单并检查同环境、不同 run、同来源快照及完整课时映射。--check 结束于这些校验，不登记 run 或调用业务 writer；其它模式接入已有执行器，unknown/not_committed 的进程退出码为 2。

--apply 目前只允许规定恢复副本。当前 dev_vue 的真实课程/进度回填在恢复副本演练通过前失败关闭；后续须凭实际演练证据完成提升，不能把这个临时限制作为最终升级交付。入口不会启动服务、自动改连接或修复数据库。

## 验证与剩余工作

5 项命令编排测试通过，涵盖只读 check、dev_vue 写入门、恢复副本 apply 衔接、身份漂移和读失败清理。实际执行 --help 成功，验证模块加载与参数帮助路径；未读取 env 或连接数据库。

本轮未执行真实 MySQL 命令、回填、DDL、服务恢复或部署。显式命令的真实连接、锁、SQL 和故障恢复须在 MySQL 修复后演练。清单生成 CLI、真实演练与当前库提升仍待完成；全库其它域和部署自动升级目标继续保持未完成。
