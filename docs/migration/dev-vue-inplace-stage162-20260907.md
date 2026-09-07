# 阶段 162：学习进度完整行转换与封闭写入器

新增 v4-learning-progress-rows.mjs，覆盖 progress 原八字段到 learning_progress 十三字段。输入整数/DOUBLE 值使用冻结 SQL 文本，完成/测验标志精确接受 NULL、字符串 0/1。原始八字段、映射与逐行时间依据完整进入 provenance，原行摘要保存到目标 source_sha256。

转换依据 learning-progress-import/v1 绑定来源集合摘要、sourceSnapshotId、课时映射集合摘要及每行 updatedAt 规则。已登记用户必须存在；公开 episodeId 与内部 lessonId 明确区分，课时映射同时绑定已导入课时的来源摘要。重复进度 ID、重复 user+episode、重复公共/内部课时映射均拒绝，不合并或猜测。

时间只接受已登记证据和明确偏移，来源 NULL 则保持 NULL。观看/总时长按精确整数毫秒转换，完成与测验不重算，超过总时长不裁剪。

mysql-learning-progress-writer.mjs 在调用者事务内按 user、lesson、原 progress、目标 progress 顺序锁定。再次确认真实用户及课时公共 ID/来源摘要，并比较原始八字段。目标不存在时插入并回读全部十三字段；目标已有时只有完全相同才返回 applied=false。任何目标冲突不覆盖，verify-only 不补写，插入响应未知不自动重放。

## 验证与边界

11 项行转换/writer/精确时长定向测试通过。覆盖公开 episode=100 映射内部 lesson=12、超总时长保留、时间证据缺失、用户/映射缺失或变化、原行变化、重复进度、十三字段冲突、verify-only 与插入响应丢失不重试。

测试为纯转换及 Mock SQL，尚未运行真实学习进度 INSERT。调用者仍负责 migration run、事务提交结果、映射/receipt/checkpoint、来源存证及独立对账；本模块不会自己创建这些控制记录。

定向复核：目标 FK 不能代替来源归属检查，writer 额外核对公开课时标识与来源摘要；原文和时间不在转换前规范化覆盖，provenance 保留原值。课时源摘要非空要求意味着必须先完成课程/课时导入，不能把进度塞给无依据的 native 课时。

下一步补课程主行/课时/媒体引用转换，形成可执行父子顺序，再完成进度批次与独立对账。当前四张学习表仍为空，本批未写库。全域自动升级和旧结构清理未完成。
