# 终端时间链路实施与验收

2026-09-06，用户确认进入本阶段。目标：AI实验室按当前账户的MT5交易服务器时间显示；UTC为存储与排序基准，终端偏移只用于显示和已声明的终端业务日边界。

## 实施前两轮复审

第一轮：复用现有`terminal.clock`查询/流、账户快照、MySQL仓储和浏览器实时协议，不增加时区服务、不每秒广播、不按用户共享账户时区。MySQL保存权威校准记录，Redis仅作可失效投影；新增表前先核查已有快照字段和历史证据列。账户/终端/epoch切换必须失效旧校准；历史记录使用当时证据，不用今天偏移重写旧日期。

第二轮：Python行情时间戳语义不能默认等于交易服务器墙钟；休市旧tick、主机时钟漂移、请求耗时和夏令时变化均可能使简单相减失真。现有Worker以tick推进估算偏移，不能直接用其verified标志证明终端显示时区。先通过独立查询输出原始tick与主机UTC采样窗口，不修改旧BrokerClock、历史换算或执行逻辑；未验证语义的样本不得形成calibrated偏移。真实显示时间获取路径须现场确认；不得悄悄恢复已退役MT5 EA。

## 当前发现与顺序

- MT5 `terminal.clock`适配器原来固定返回unavailable；Python没有对应独立数据查询。
- 既有服务端`BridgeTradeProjectionDecoder`只处理positions/pending_orders；时钟流到MySQL及浏览器的完整接线尚缺，存在字段不等于链路可用。
- 部分前端在偏移缺失时回退浏览器时区；后续须改成明确标记的UTC或待校准状态，不能伪装终端时间。
- 本批先实现有界只读时钟证据查询，保留terminal/account route校验；随后根据可信采样来源补校准、MySQL/Redis投影、变更通知及前端显示。未完成后续项目时不得标记整阶段完成。

采样合同：`source_kind=mt5_tick_time_unverified`；`server_time_utc_msc=null`、`timezone_offset_minutes=null`、`clock_status=unavailable`。`sampled_at_utc_msc`为主机UTC采样窗口结束；`sampling_started_at_utc_msc`为开始；`raw_tick_time_msc`和`symbol`只作同一次调用的原始证据。扫描返回列表前32个品种，仅查询其中已可见品种，不添加品种、不启动或切换终端、不交易；无tick则保留NULL，主机时间倒退或采样窗口超过5秒标记样本不可用。5秒是结果有效性门，不是底层Python扩展调用的硬中断超时。该查询不更新或复用旧时区缓存，不从单个原始tick计算可信偏移。

## 验收边界

源码/离线：Worker参数、路由、无行情、UTC tick、主机跳时、.NET字段保留及不可用状态不升级。运行代码与合同变化定向验证；真实依赖与终端样本、UI多宽度、时区变化和历史显示分开记录。

后续真实只读验收需要同时记录MT5所显示的交易服务器时间与UTC，核实官方Python返回字段在当前终端组合上的语义。只读样本不批准订单、服务部署或数据库迁移。

## 本批实现与实际结果

Python Worker通过已有IPC `data`新增`terminal_clock`动作，仅接受空参数，采样前后复核账户身份。.NET `terminal.clock`从固定占位值改为调用此动作，保留样本，校验来源/动作/时间范围/空偏移；拒绝将unverified来源伪装成calibrated。兼容的V4查询响应信封未改变；新动作仅用于.NET→Python内部IPC，不扩展旧V3公网动作枚举。没有新增Worker依赖或安装器文件。

验证：Python 70项通过，包含IPC动作往返、不复用缓存、UTC tick不冒充终端时区、无行情、32品种预算、主机倒退和慢样本。.NET x86构建及整套离线烟雾通过，包含查询消费和伪造calibrated拒绝。没有修改旧BrokerClock及其历史换算/执行逻辑，旧quote路径verified映射仍须后续单独治理；本批不能宣称已全面修复旧时区推算行为。

沿用用户已确认的本地只读联调范围，使用本机已经运行的`D:\Program Files\MetaTrader 5\terminal64.exe`采两次新查询函数证据，采样后关闭Python API连接，未关闭终端、登录/换号、安装EA、交易或写DB。终端Build 6180，当前本地Python包5.0.6147；不是Win7冻结运行时验证，也不是完整.NET/WSS/MySQL/前端实机联调。

[现场样本](terminal-clock-live-observation-20260906.json)：两个UTC采样窗口分别为4ms和2ms，相隔约0.5秒，AUDCAD.s的原始tick时间均为1788566099721，没有推进。原始时间与当前UTC的差值远超正常时区范围，不能从该旧样本校准时区；没有将所有品种都不更新或市场整体状态作为本次测量结论。`calibrated=false`；没有自行猜测UTC+2/+3或将Windows本地时区当作经纪商时区。

官方[Python API目录](https://www.mql5.com/en/docs/python_metatrader5)未提供与MQL5 `TimeCurrent`同名的直接调用；[TimeCurrent](https://www.mql5.com/en/docs/dateandtime/timecurrent)代表市场报价窗口最后已知服务器报价时间，可能停滞；[TimeGMT](https://www.mql5.com/en/docs/dateandtime/timegmt)依赖电脑时钟计算，并非独立网络授时。需要独立终端显示证据和新鲜样本后，才能确定可自动采集的可信偏移来源。

当前阶段保持进行中：原始采样与查询适配已完成，可信时区校准、校准变化落库/缓存、浏览器刷新及历史偏移显示尚未贯通。采样证据不能作为运行时账户timezone_offset_minutes写入；不能因为需要端到端演示就把unavailable改成calibrated。
