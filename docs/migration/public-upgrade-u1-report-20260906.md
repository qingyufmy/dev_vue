# U1 源表覆盖与身份字段合同实施结果

2026-09-06；对应 [公网升级方案 U1](public-upgrade-execution-plan-20260906.md)。本批源码与离线清单校验完成，所有回填入口保持不可执行。没有数据库连接、DDL/DML、备份导出、服务启动或部署。

## 交付结果

- [新版清单](public-upgrade-u1-review-20260906.json) 登记165张源表及2,598个字段的责任域、旧矩阵候选目标、当前SQL计划中的目标存在性、处置规则和阻断。其来源为既有冻结元数据，不是本轮新快照。源表不存在于旧矩阵、重复主登记或遗漏字段均拒绝生成；`risk_reservations` 按既有决定归执行域，风控域仅交叉引用。
- 身份/账户11表148列逐项保留源类型、NULL、默认值、排序规则、主键、时间语义、变换规格及关系规则。52项旧目标更新到后续已批准合同；81列存在可定位的目标SQL声明，67列仍为历史处置或待定目标。这67列不是可以丢弃的字段，也不都要求新增活动表。
- 当前计划声明中标出35项类型/精度变化、7项可空转必填、23项排序规则变化，分类可重叠。它们是静态差异提示，不等于已有数据损坏，也不代表历史值已通过转换验证。声明附带迁移文件和checksum；实际目标安装状态另验。
- 其余154张表登记了去向与责任域，但逐字段合同仍待后续波次。126张源表至少有一个候选目标未在当前SQL计划中声明；候选来自历史设计，须先核对更名/合并或功能缺口，不能直接理解为缺126张表。

| 首批源表 | 字段 | 可定位目标声明 | 更新映射 |
| --- | ---: | ---: | ---: |
| users | 34 | 25 | 18 |
| verification_codes | 10 | 0 | 0 |
| bridge_device_pairings | 14 | 0 | 0 |
| bridge_refresh_sessions | 10 | 10 | 0 |
| trading_accounts | 15 | 15 | 10 |
| mt5_account_bindings | 10 | 1 | 0 |
| mt5_account_ownership_history | 10 | 5 | 5 |
| bridge_v3_terminal_sessions | 20 | 0 | 0 |
| ai_observer_sources | 10 | 10 | 10 |
| ai_observer_channels | 11 | 11 | 8 |
| ai_observer_channel_assignments | 4 | 4 | 1 |

## 修正与未关闭事项

1. `trading_accounts.user_id` 主处置改到用户账户设置；当前owner权限必须从经核实的绑定/归属区间形成，不能仅凭此字段创建授权。
2. `ai_observer_channels.source_id` 改到 `observer_channels.source_id`，关联 `observer_sources`；不能直接塞进交易账户ID。源/策略/account的ID映射仍须冻结。
3. 用户验证、会员来源/周期、推荐账户字段指向018实际声明；`referred_by` 保持推荐码语义，余额保持精确十进制。Telegram按后续产品决定退役为受控历史，不恢复绑定或通知，也不删除原值。
4. 账户设置/归属区间、观摩源/受众按019/021合同定位。旧ownership的原ID、server/login及来源登记时间仍需要稳定ID map和receipt，不能为了目标有同名created_at就覆盖来源时间。
5. 源 `account_currency VARCHAR(16) NULL` 对应目标 `VARCHAR(12) NOT NULL`，须校验长度和NULL；不能截断或默认USD。用户7项中的6项可空转必填也须以冻结源验证，不能靠目标默认值填平。
6. 旧DATETIME继续 `unknown` + `G-TIME`，不从当下服务器时区推定历史。V3 token/会话、撤销事实、验证码和一次性配对的历史处置仍受原阻断，不能预造V4凭据或恢复线上状态。

旧138列blocked和10列reviewed的清单保持原样。本版给全部148列增加 `G-INSTALL` / `G-TRANSFORM`，表示“当前计划声明存在”仍不等于“目标已安装且有可执行转换/receipt”；不是新发现148项业务缺陷。G-USER/G-MEMBER/G-OWNERSHIP/G-OFFLINE/G-OBSERVER等说明已更新为“源码部分已补、迁移语义和现场验收仍未关闭”，没有整项机械解除。

## 工具与验证

```powershell
node scripts/review-v4-upgrade.mjs
pnpm exec vitest run tests/v4-upgrade-review.test.js tests/v4-field-manifest.test.js tests/v4-field-manifest-artifact.test.js
```

默认命令只读本地文件，重建预期清单并校验已提交产物无漂移；显式 `--write` 仅更新本地JSON。两种模式都不连接数据库、不执行SQL、不加载 `.env`。

复用现有 `validateFieldManifest`；新校验补充165表覆盖、源字段/快照/主键匹配、计划目标存在性和声明checksum、变换规格hash、时间证据和不可执行门。SQL目录读取仅支持本仓库当前CREATE/ADD/MODIFY/DROP COLUMN形式，未知改名/类型失败关闭；它不是完整MySQL解析器，不验证全表约束语义或真实安装。后续真实DDL校验仍走现有runner及information_schema。

定向3个测试文件22项通过，含删除/重复源项、篡改NULL/default/快照、虚构目标、修改目标声明、未知转换/规则hash、伪造UTC、错误就绪标记及计划列增改删。旧冻结清单仍通过原测试；没有改动旧JSON、既有SQL迁移或运行配置。生成产物一致性及 `git diff --check` 通过。

两轮复核：第一轮复用既有清单/矩阵/校验器，区分全源覆盖和首批字段评审；不把表名相同当成语义一致。第二轮校验源快照、目标声明与计划checksum，保留全行关系/时间/历史证据阻断，检查账户授权、观摩source和Telegram处置；负例确保清单无法标记可执行。

## 下一步

U1本批可审查产物已完成，可进入U2的源码设计/实现：持久化run、ID map、checkpoint与receipt，绑定快照和transform版本，支持目标短事务及精确恢复。真实U3回填还不能开始：先完成实际目标安装核对、历史时间/账户关系证据和这67列历史/待定去向，再按明确目标申请数据库写入。其它154表分域接续U4字段合同；公网升级仍须全域对账与功能门通过。
