# 阶段 157：配置迁移完整 CLI 命令链验收

已在恢复镜像 dev_vue_m1_source_20260907_02 通过实际子进程依次运行 prepare、check、apply、recover、verify、再次 apply。没有用函数调用结果替代命令行结果。两项七牛旧文本作为镜像来源；历史时间及加密密钥仅为演练用途。

为避免修改现有 .env，两个 CLI 共享 settings-migration-environment.mjs。默认仍读取各工作区 server/.env；Linux root 演练可通过 AURUM_SETTINGS_ENV_FD 读取继承的匿名内存 JSON。仅允许 dev_vue 或严格命名的 dev_vue_m1_source_YYYYMMDD_NN，UUID/58 步结构/目标绑定照常校验；socket 仅支持已有 /tmp/mysql.sock。

Python helper 的配置由 stdin 接收，再写入 mode 0600 的 memfd 传给 CLI。没有落盘数据库密码、运行密钥或修改服务配置。各 CLI 独立获取升级锁；外层演练在调用时释放自身锁，调用后重新获取，再进行原数据核对与清理。依赖引用现有只读 node_modules，未安装或修改依赖。

## 实际结果

prepare=prepared；check=checked 且测试记录计数不变；apply/recover/verify/再次 apply 全部 verified。目标/映射/receipt/source/batch 各 2，checkpoint/run 各 1；重复执行计数不变。独立对账、十五目标列、原八字段恢复与映射/checkpoint 检查通过。

仅删除 runId ffffffff-ffff-4fff-8fff-ffffffffff34 的测试目标和迁移记录，七类最终计数均为 0。删除本次 review、manifest、credential plan，清零内存测试密钥。原始 271,007 行、原表结构及此前新增表数据摘要与演练前一致。dev_vue 当前库未写入。

## 证据与剩余范围

回执 dev-vue-settings-cli-backfill-rehearsal-20260907.json，SHA-256 81215622fe6dbea84d761e9e0c1de0d2ed9e0bddb903f7fa780300147517624e。223 项工具文件摘要在远端执行前与取回后核对一致。远端目录 /www/backup/aurum-v4/m1/20260906-01/settings-cli-backfill-rehearsal-01。

7 项环境作用域/清单定向测试通过，两个 CLI 语法检查通过。新增作用域测试拒绝 production、dev_xin 和非严格镜像名，确认时间/整数文本配置及 socket 限制。

本批没有再次注入提交响应丢失，异常恢复证明沿用阶段 153/155；本批证明实际 CLI 正常链与重复执行。覆盖凭据分支，普通配置分支完整 CLI 尚未做同等实库演练。真实配置时间依据、供应商可用性、全域数据转换和读写切换仍未完成。

第一轮复核：演练配置输入保持独立但与正常 CLI 共用执行代码；不改现有 .env。第二轮复核：升级锁按进程重新获取，目标身份和清单校验保留，配置及原文不进入回执；清理后仍执行原数据与新增目标表校验。下一步推进剩余业务域规范化及实际历史依据处理，不把配置工具链验收当全库升级完成。
