# U2 时间、用户生命周期与归属核验

第一轮复审：继续已批准身份迁移范围。时间处理保留原值，明确分开epoch毫秒与未知DATETIME；用户状态按旧写入与V4读取共同约束；归属关系核验不产生授权，不从账户设置的user_id推导owner，也不自动合并相似服务器/账号。无写入入口。

第二轮复审：时间严格校验真实日历、范围和精度，拒绝Date自动纠正无效日期；未知历史时区不转换UTC。删除状态、deleted_at、token_version共同核验，NULL和未知状态不默认active。归属图校验缺父记录、同ID冲突、账户精确身份、多个open区间及binding不一致；时间未证实不能宣称历史区间无重叠。测试只证明离线算法，现场快照与历史writer覆盖仍独立阻断。

已核对的源码证据：`server/admin/user-deletion.js`把用户置为anonymized、设置deleted_at、递增token_version并撤销旧Bridge会话；`server/src/modules/auth/infrastructure/mysql-auth-repository.ts`仅在active且deleted_at为NULL时认为用户活跃；`server/admin/user-profile.js`允许free/plus/pro。旧迁移及绑定使用大小写归一身份，但既有B2报告明确归一join不能授权实体合并。当前源码只证明当前规则，不能代替所有历史writer版本。

## 已实现并验证

- `v4-identity-time.mjs`严格检查1000–9999年的DATETIME日历和毫秒可表示性，拒绝零日期、无效闰日、溢出时分秒和非零微秒损失。未知墙钟值保留原文，不转UTC；epoch毫秒仅接收规范非负整数字符串，范围检查后转UTC，毫秒精度不会经过不安全整数。
- `v4-identity-lifecycle.mjs`检查role、plan、deletion_status、deleted_at与token_version。已注销身份保持不可登录，未知/NULL状态、注销后仍有管理员/付费状态及删除时间矛盾均阻断；不创建会话或授权。原值不重置，`sourceLoginEligible`只描述源状态。
- `v4-identity-ownership-audit.mjs`对用户/账户/归属区间/当前binding进行有界精确关系核验：缺父项、重复ID、未明确合并的重复身份、多个open owner、binding与区间不一致都会报告。历史owner可以不同于当前账户设置用户。服务器名和登录账号按字节语义保留，大小写差异保持未解决；没有生成目标ID或授予owner。未知时间基础使`temporalOrderVerified=false`，不能凭语法合法就宣称无区间重叠。
- `v4-identity-source-audit.mjs`将上述模块接入读取器完整hex行：使用经过U1校验的合同，检查11表键集合、每行字段/PK/hash及重复源行；每表最多10,000行、输入最多32MiB，超过则拒绝，不能截取子集伪装全量。输出仅摘要、计数、机器码及定位hash，不输出密码、token、身份原文。输入摘要与行顺序无关；`completeSourceVerified=false`和`readyForBackfill=false`固定保留。调用者仍须独立证明完整冻结源。

`pnpm exec vitest run tests/v4-`：33文件257项通过，本批新增13项，覆盖日历/epoch边界、状态矛盾、历史owner、缺父项/多open owner、完整源信封接入、脱敏、重复行、篡改hash和输入顺序。源审计连接使用合成行输入，未将新模块在真实库逐行运行；现场证据为下面独立的只读SQL聚合，不冒充真实端到端回填。

## 2026-09-06 现场只读结果

[机器证据及查询文本](public-upgrade-u2-live-observation-20260906.json)记录两次相邻只读观测。SSH目标为`aurum-vm`（192.168.1.254），主机debian，MySQL 8.4.8、UUID `ac423207-6ef3-11f1-b302-000c29fda104`；应用目录`/www/wwwroot/aurum-ai`，分支dev_codex，commit `61610c3c3dc055974d1da90700ecf5336f19434c`。这些是虚拟机证据，不是公网主机验收。

冻结镜像`dev_vue_m1_source_20260905_01`当前165表，25用户、4账户、274条归属区间。用户生命周期/role/plan异常、归属缺父项、多个open owner和binding/open区间不一致的选定聚合均为0。未核对全部业务字段、内容hash或备份恢复，不能据此将源内容标为已冻结验证。

274条归属身份字节差异全部是服务器名大小写差异：ASCII范围，无需去空白，login字节差异为0。另有1个按旧版归一规则重复的账户组，涉及不同用户。这是需要建立明确多源ID映射、保留逐用户设置和历史归属的候选组，不是可以丢弃的重复垃圾。平台仍须关联终端证据，不得因表名mt5或当前在线状态推定；大小写相近本身不构成合并批准。

A/B当前各102表、18条已完成迁移记录（bootstrap及001–017）；已登记checksum与当前计划相符。018–025共8份计划迁移两边都未安装。该查询是journal核对，未替代实际DDL指纹/约束校验；未执行这些迁移、回填、部署、服务重启或业务调用。

## 接续执行点

继续建立账户身份候选映射的可审查证据：逐源账户关联平台/币种/用户设置，核验旧归一规则下的重复组和历史区间；所有原ID及服务器原文保留在source hash/ID map/受控历史证据中。历史DATETIME需要覆盖实际写入时期的证据，当前`server/db.js`的+08设置只能作为候选依据。然后补受控writer和真实目标回读，准备018–025的明确安装范围；历史内容目标、冻结内容与写入授权尚未齐备，不进入U3真实回填。

后续更新：018–025已在明确授权后安装到既有A/B目标库，见[安装报告](public-upgrade-u2-ab-install-report-20260906.md)。本报告中的102表和未安装状态为安装前只读观测，原证据保留；业务回填和上述语义门仍未通过。
