# 阶段 158：课程、学习进度与文件来源核对

从配置工具链转向课程领域。新增只读库存脚本 review-dev-vue-learning-inventory.mjs，核对当前 58 步结构/备份 UUID，冻结九表 111 列的定义、索引和逐行摘要。实际 18 行：courses 12、course_resources 1、progress 5，其余六表为空。两次只读采集结果一致；没有读取附件内容或输出课程正文/文件地址。

## 会影响迁移设计的事实

- courses 的 12 个 episode_id 均唯一且非空，当前全部 video/published/logged_in。来源 id 与公开 episode_id 必须分别保留；不能通过标题/分类猜测合并课程。
- duration 为 varchar(20)，当前十二项均为整数秒文本。progress 的 watched_seconds/total_duration 为 DOUBLE，当前五项通过 SQL CAST 得到的值均为整数文本。
- 两条已完成进度的观看值超过总时长，分别 1112/960、2049/599。不能加 watched<=duration 约束，也不能截断或据比例重算 completed。另有一条 681/853 已完成，进一步说明完成标志不是由简单时长比例重建的事实。
- progress 无缺失用户/episode，无 user+episode 重复。当前 quiz_passed 全为 0；完成与测验分别保留。
- 唯一附件无 stored_file_id，但有旧 URL。stored_files 空不代表附件可以删除；须单独验证旧路径、对象/文件内容和访问权限后才能承接。
- courses 的 created_at/updated_at、progress 的 updated_at 全非空。历史时间仍需逐字段依据。

## 首项转换实现

新增 v4-learning-duration.mjs，输入冻结的 SQL 十进制文本，以 BigInt 转整数毫秒。保留 NULL；拒绝数字隐式转换、显示时长字符串、科学计数法、超过毫秒的非零精度和 BIGINT 溢出，不四舍五入。这里只覆盖已证明单位为秒的字段，不自动推断其它旧展示格式。

convertLearningProgressValues 保留独立完成/测验标志，并把“超过时长”作为客观信息；不裁剪原值。实际库存十二项课程时长与五项进度均可精确转换，两项超时长事实保留。当前 DOUBLE 文本转换通过不证明所有未来 DOUBLE 值可无损转换，未满足格式的值仍拒绝。

四项测试通过，覆盖边界、超 JS 安全整数、NULL、格式/精度/溢出拒绝、超过总时长及独立状态。SQL 库存脚本两次真实验证通过；没有 DDL/DML 或真实回填。

## 下一批结构方向与复核

按原方案分离课程、课时、资源和用户进度，先做完整字段转换合同和追加目标结构。首批旧行保持一对一可追溯，保留公开 episode 标识；不猜课程分组。文件实体与旧 URL 的承接必须有独立来源证明。

第一轮检查功能与字段：现有 V4 migrations/runtime 中未发现该课程域对应实现，本批只补来源证据和时长转换，未宣称课程功能已迁移。第二轮检查数据语义：修正不得假设观看时长上限或完成比例，空文件表不作为删除依据；保留历史时间和文件验证待决项。九表列/索引核验不是视图、触发器、外部对象等全部依赖审计。

证据为 dev-vue-learning-inventory-20260907.json。全域规范化、自动升级及旧结构清理继续保持未完成。
