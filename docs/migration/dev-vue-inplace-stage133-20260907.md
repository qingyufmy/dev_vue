# 阶段133：规范配置读取层

新增settings模块及公共readSetting入口，按namespace/key和消费者期望类型读取。缺失返回missing，NULL和空串保留为不同状态；ID/revision及整数值保留字符串精度，JSON正文不重新序列化。无默认值、旧表fallback、隐式类型转换或解密。

SQL使用CASE在数据库内遮蔽sensitivity=secret或value_type=credential的值，通用读取仅返回protected和配置状态。类型/身份不匹配、重复记录、错误标记/布尔/整数/JSON形态均拒绝。此接口是服务端内部读取，不替代HTTP授权、逐键业务语义或公开配置白名单。

四项定向测试、服务端类型检查及V4构建通过。参考库事务内实际验证缺失、NULL、空串、大整数revision/值以及合成密文遮蔽；结果无rawValue字段及密文正文，回滚后表零行。见[真实回执](dev-vue-setting-reader-probe-20260907.json)，绑定七文件。未读取真实密钥、未写当前dev_vue。

新模块尚未接入业务消费者或管理员HTTP。下一步管理服务应使用同事务版本校验及审计，并保持秘密写入独立控制；真实配置回填及旧system_config退出未完成。全库规范化目标仍未完成。
