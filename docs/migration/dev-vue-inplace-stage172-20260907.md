# 阶段 172：学习域双清单生成命令及统一预检

新增显式只读生成入口：

```powershell
node scripts/prepare-dev-vue-learning.mjs --write <reviewed-basis.json> <reviewed-evidence.json> <course-manifest.json> <progress-manifest.json>
```

reviewed-basis.json 使用 learning-reviewed-basis/v1，包含 logicalSourceId、mirrorDatabase、admission、courses（run/basis）、progress（run/basis/lessonMappings）及两个批大小。独立证据目录格式与执行命令一致。生成器不填写历史偏移、不重算或替换已审查映射，不放行未完成 admission。

在升级锁内使用同一 READ ONLY 事务读取两个目标身份、原课程/进度及当前用户集合。两个目标 UUID 必须与既有备份目标一致。读取完成回滚事务；两份清单先一起通过业务转换和跨域关系校验，再顺序独占落盘。输入输出路径必须各不相同，Windows 路径比较不区分大小写；已有文件仍由 exclusive-create/readback 合同保护，不覆盖。

从 migrateLearningCore 抽出纯 prepareLearningCore，供清单对生成、--check 及实际执行共用。它不获取数据库连接或写入；统一检查两个 run、来源/转换摘要、同环境和快照、完整课程到进度映射。移除命令入口原有重复跨域判断，避免校验规则漂移。

## 验证与限制

15 项定向测试通过：双清单 3 项、父子执行 5 项、清单执行适配 2 项、命令 5 项。覆盖合法双清单、不相关映射、不同服务器/快照、run 重用，以及原执行顺序和连接前拒绝行为。实际 --help 运行成功。

这仍是纯转换和 Mock 证据；没有执行真实数据库读取、恢复、迁移或生成真实业务清单。MySQL 启动故障的恢复背景仍待用户补充。下一步须在服务恢复后运行真实只读探针与恢复副本端到端演练，才能提升当前 dev_vue 的回填入口。全库其它领域、最终自动升级和旧结构删除未完成。
