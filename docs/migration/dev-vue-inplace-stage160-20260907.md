# 阶段 160：课程核心 MySQL 约束验证与 62 步协调器

在参考库 dev_vue_m1_a 实际执行 022_learning_core.sql，创建四张 learning_ 核心表。SQL 现已执行，SHA-256 4e0079c0f7ee867f68a19a5c7cda16875dafee6566de3571fb40db92b519029d，后续不得修改该文件，只能追加纠正迁移。

## 实际验证

四张表各写入一项事务内测试行，并创建事务内测试用户。精确保留超 JS 安全整数 revision、BIGINT 最大毫秒值、DATETIME(3) 小数秒，以及 2049 秒观看/599 秒总时长和独立完成/测验标志。

18 项反例按实际 MySQL errno 验证：权限大小写/尾空格、状态尾换行、native 缺时间、revision=0、缺少导入来源证据、课时缺父课程、公开 episode 重复、负时长、类型尾空格、用户课时进度重复、缺用户/课时、错误完成标志、负观看时长、重复媒体引用、空定位符及媒体种类尾换行。

全部测试 DML 回滚；四张表为空，测试用户不存在。四张参考表保留作真实元数据依据，不将 DDL 表述为可回滚事务。当前 dev_vue 未执行这批 DDL/DML。

回执 dev-vue-learning-schema-probe-20260907.json，SHA-256 3ca71758e47e6dfc44991b8013f862741017d66be1694051a09df66c08e5578d。远端目录 /www/backup/aurum-v4/m1/20260906-01/learning-schema-probe-01。五项工具摘要在远端与取回后核对通过。

## 升级协调器

追加 inplace-learning-core-schema.mjs，从参考回执、原 SQL 摘要和实际 SHOW CREATE TABLE 构造四个顺序步骤，完整保留前 58 步。新四步为 inplace_019_01_learning_courses、02_learning_lessons、03_learning_media_references、04_learning_progress，总计 62 步。已存在视图或挂载触发器会拒绝接管。

八项协调器/字段覆盖/时长测试通过，包括前 58 步对象逐项一致和视图/触发器拒绝。该协调器尚未提升到当前库升级命令；下一步先在恢复镜像演练四项 DDL 中断后的结构识别与恢复，再加入当前库显式升级入口。

定向复核：数据反例使用真实服务器约束，不以正则解析代替 MySQL；原 SQL 与参考定义双重绑定。参考表 AUTO_INCREMENT 可因事务内插入推进，测试回滚证明数据清理，不宣称计数器回滚。未做学习数据回填、媒体可用性验证或前端切换。全库自动升级及旧结构清理仍未完成。
