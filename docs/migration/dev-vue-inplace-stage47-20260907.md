# 同库升级第四十七批：策略基础字段转换

新增convertStrategyMetadata，覆盖id/title/description/system_prompt/scope/owner_user_id/created_by/is_active/visibility_status/version/created_at/updated_at/deleted_at。输出部分目标候选：来源ID、原名称/描述、归属、生命周期、当前版本和创建人。提示词只输出原始UTF8摘要及字节数，不trim或改换行，不导出正文；时间仅记录源摘要，尚未生成UTC时间。

平台owner=0/null转目标null；私人归属必须匹配存在的用户。目标名称191字符、描述2000字符、版本INT UNSIGNED、用户INT和来源ID上界分别检查，不截断、不经Number舍入。删除/归档映射retired；活动与草稿要求对应有效flag，矛盾状态阻断，不默认激活。保留当前版本号，不编造1到当前版本的历史记录。kind、输出合同、配置和历史时间仍是显式阻断项；候选executable=false，不能直接写入目标作为可运行策略。

原只读源采集器增加--write-metadata/--verify-metadata，仍校验数据库UUID、完整源形状和第二十五批源摘要；报告wx创建。真实3条转换均无基础字段异常：道诚实战精选策略版本44/active，ATR策略版本11/active，测试策略版本1/retired，均平台归属。再次独立读取验证报告一致，见 [dev-vue-strategy-metadata-review-20260907.json](dev-vue-strategy-metadata-review-20260907.json)。

11项定向测试通过：本批6项、源检查5项，覆盖原提示词字节、状态不复活、用户归属、Unicode字符长度、大整数/版本越界和时间不猜测。普通转换复核确认未忽略其余配置字段：本模块只负责基础字段，剩余字段由后续合同继续登记，不以“converted”状态代表整条策略迁移完成。

本批无数据库写入。策略角色拆分、市场数据计划/策略规则等配置的V4承接、模型绑定及历史时间仍未完成，随后才能写策略版本并回填订阅。源库继续保留原数据；全量自动升级和清理目标未完成。
