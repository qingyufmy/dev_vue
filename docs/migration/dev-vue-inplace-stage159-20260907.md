# 阶段 159：课程核心字段合同与追加结构

追加候选 SQL 为 server/db/migrations/inplace/022_learning_core.sql，包含 learning_courses、learning_lessons、learning_media_references、learning_progress 四张新表。概念矩阵中的 courses/course_lessons/course_progress 在当前同库路径采用 learning_ 域前缀，避免与旧物理表冲突。旧表保留，当前 58 步升级协调器尚未加入这四表。

## 来源覆盖与目标反向依据

机器合同 v4-learning-field-contract.mjs 覆盖 courses 26 字段及 progress 8 字段，共 34 项，每项恰有一个主处置；与真实库存列集合对比通过。其它七张课程/文件来源表不在本批已转换范围。

每个旧 courses 行映射一个 course 和一个 lesson，分别保留原 courses.id；公开 episode_id 存为课时的唯一公共标识。不能按分类、标题或相邻编号合并。lesson.course_id 精确指向同源 course；lesson.title 从同源标题初始化，lesson.sort_order 为单课时课程的确定值 0，lesson 创建/更新时间在同一已审核时间依据下初始化。以后两实体可独立编辑，不声称这些生成值是来源额外事实。

课程标题、描述、分类、封面定位符、渐变标记、权限、状态和排序保持原语义。课时保留内容类型、展示编号、精确整数毫秒时长。来源 NULL 不自动变为空字符串、公开权限、草稿或零时长；native 行要求必要时间/状态/权限，旧导入允许明确的来源 NULL，运行时仍须失败关闭未知权限。

六种非空旧媒体引用按 lesson + source_kind 独立保存，保持原字符串，唯一键防止同来源字段重复。NULL/空引用不创建媒体行，其区别保留在完整来源存证。媒体行 id 由数据库分配，并通过 legacy map 绑定旧课程 ID + 字段种类。该表只证明引用，不证明文件存在、可访问或可播放。

has_stream_video 和四项旧资源计数保存在来源存证，作为旧投影证据；未来从已迁移资源及媒体事实重建。资源/测验尚未承接前不能用零替代这些计数并宣称课程功能完成。唯一旧附件仍在下一批独立资源/文件路径范围内。

进度保留原 id/user_id；episode_id 必须通过唯一公共标识映射 lesson，不直接当作内部 lesson id。观看与上报总时长分别精确转毫秒；允许超过总时长；completed/quiz_passed 独立、可 NULL。用户和课时 FK 不允许虚构父行或级联抹除历史。

四表共同使用 revision、native/legacy_import、run FK、原行摘要与导入时间；导入器必须保存原行及映射，媒体派生行同样绑定原课程摘要。所有新业务时间为 DATETIME(3)，禁止以当前 UTC+3 解释历史。

## 两轮复审

第一轮检查覆盖和复杂度：明确 34 字段主处置及所有生成字段依据；避免把旧一行按猜测拆成多门课程。媒体定位与文件权威分离，不凭空生成 stored_files。四表只建立核心关系，不顺带把空测验、评论或文件表删除。

第二轮检查兼容、数据和恢复：保留旧 ID 与公开 ID 两层语义；不加 watched<=duration；枚举用 BINARY 精确比对，不接受大小写或尾空白变体；原始时间/NULL 不填默认；导入来源字段齐备才接受 legacy_import。FK 无级联删除，清理与切换仍需后续映射、对账和恢复证据。CHECK 不引用 AUTO_INCREMENT 列，正 ID 由迁移合同和写入口验证。

## 验证与下一步

六项字段覆盖、追加结构边界和精确时长测试通过。这里只是解析/合同测试，尚未在 MySQL 执行，不能据此宣称 CHECK/FK 真实语义已验证。下一步在参考库验证 DDL、正反例和元数据，冻结 SQL 后扩展 58 步协调器并演练中断恢复。

本批无 DDL/DML、真实回填或消费者切换。全域自动升级和旧结构清理未完成。
