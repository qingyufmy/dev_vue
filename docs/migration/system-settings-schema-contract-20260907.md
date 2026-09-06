# 统一配置结构合同

范围为全局配置；用户级 quote_symbol 及待核实旧键按阶段124另行处置。目标 system_settings 为15列，保留旧ID、namespace/category、setting_key/key、原value_text、label、sort_order、两种UTC时间、revision及导入来源。value_text保留原文本表示，value_type决定解释和校验，避免JSON二次编码改变原字符串或密文。NULL、空串、缺失各自保留；非空旧墙钟必须有依据后转换，不能利用目标可空绕过。

namespace/key采用ASCII精确命名和唯一键；敏感级别public/restricted/secret，credential强制secret。SQL检查基础布尔/整数/JSON数组/凭据信封形态，应用逐键合同负责范围、枚举与业务语义。JSON凭据形态不证明密钥可恢复；应用必须检验字段类型、有效版本和认证解密。迁移绝不自动把明文凭据写成credential。

system_setting_changes以setting_id/revision为主键，request_id/setting_id唯一，绑定真实actor并保存前后完整配置快照的hash和UTC时间。writer须同事务CAS更新与审计，禁止明文值进入审计。此表提供变更追踪和请求重放依据，不保存可恢复旧值；迁移回滚依靠已验证备份及来源归档，运行配置回退需要经授权重新提交所需值，不能把hash当作完整历史快照。

第一轮复核（覆盖/职责）：15列覆盖八字段原事实及规范化元数据，注册表确定逐键类型；单一配置权威表，不为每个类别建表。用户偏好不进入全局表，当前配置不覆盖历史订单地址。

第二轮复核（数据/并发/异常）：机器身份拒绝尾空格/大小写漂移；无级联删除；审计不泄漏值；空值语义由逐键合同审查。native时间必填，legacy来源四项绑定；旧创建/更新时间、凭据恢复及消费者切换仍待完成。DDL先在隔离参考库验证，当前库只有通过版本化协调器才能安装。旧system_config删除门尚未满足。
