# 阶段132：配置真实批次恢复演练

恢复副本dev_vue_m1_source_20260907_02从system_config读取auth_toggle的email_enabled/phone_enabled两条非敏感原记录，在57步结构上完成真实批次演练。时间和语义依据仅为合成夹具，不用于当前库实际回填；原配置没有修改。

两个单行批次分别提交目标、映射、回执、来源归档和进度。首批实际commit后断连接并抛出异常，恢复查到committed，没有重发writer；第二批归档阶段注入错误，整批组件回滚，显式重新执行成功。重复执行后计数不变，最终checkpoint、映射、回执hash及来源payload一致。

独立对账实际回读15列目标和完整八字段来源，零差异；verifyOnly再次核验目标。按本次run精确清理目标及迁移记录后全部计数零，原271007行与冻结基线一致，已有新增表数据hash未变。

[完整回执](dev-vue-settings-backfill-rehearsal-20260907.json)绑定196文件，远端目录/www/backup/aurum-v4/m1/20260906-01/settings-backfill-rehearsal-01。23项相关离线测试通过。真实外部服务、凭据解密、历史时区及业务消费者均未在本轮验证；当前dev_vue没有DML。

下一步完成规范配置读取和管理服务，并继续取得真实转换依据。配置57步结构已具备，实际59项候选回填与消费者切换未完成，旧system_config全部保留。全库规范化及旧结构清理仍未完成。
