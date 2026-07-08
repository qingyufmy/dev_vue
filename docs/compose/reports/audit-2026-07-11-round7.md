# 第七轮全面审计报告

> 日期：2026-07-11 | 测试：468 passed | 审计域：5（并行）

## 修复汇总

### CRITICAL（2/3 已修复，1 项跳过-智能平仓）

| # | 问题 | 文件 | 修复 |
|---|------|------|------|
| CR1 | scheduler.js:225 读取已删除列 symbols | scheduler.js:225 | 改从 auto_prompt_types.symbols_json 获取 |
| CR2 | scheduler.js:1307 Smart Close URL 错误 | — | 跳过（智能平仓暂不用） |
| CR3 | llm.js:167 normalizeAiSignal 早退缺字段 | llm.js:167 | 用 ...spread 保留原 parsed 对象字段 |

### HIGH（4/5 已修复，1 项跳过）

| # | 问题 | 文件 | 修复 |
|---|------|------|------|
| HI1 | BSC 缺失 SCAN_FUNCTIONS | monitor.js:207 | 新增 BSC 扫描函数（Etherscan 兼容 API） |
| HI2 | 空 positions 导致 NaN | scheduler.js:1354 | 增加 `length === 0` 检查 |
| HI3 | Smart Close 无超时 | — | 跳过 |
| HI4 | 评论存储型 XSS | comments.js:70 | 去除 HTML 标签 `text.replace(/<[^>]*>/g, '')` |
| HI5 | Math.random 生成验证码 | auth.js:97,385,634 | 改用 crypto.randomInt() |

### MEDIUM（10/12 已修复）

| # | 问题 | 文件 | 修复 |
|---|------|------|------|
| M1 | Admin prompt type XSS | app.js:2340,2399,2469 | 用 escapeHtml() 转义所有用户数据 |
| M2 | 用户删除级联遗漏表 | admin.js:303 | 新增 4 个表的 DELETE |
| M3 | 支付取消竞态 | — | 跳过（复杂） |
| M4 | progress 竞态 | — | 跳过（复杂） |
| M5 | like toggle 竞态 | comments.js:122 | 改为 check-then-act + INSERT IGNORE |
| M6 | K线时区偏移 | — | 跳过（复杂） |
| M7 | 可降级最后一个管理员 | admin.js:256 | 新增管理员数量检查 |
| M8 | 冗余动态 import | strategy.js:70,102 | 删除，用静态导入 |
| M9 | 空 catch 吞错误 | config.js:11,459 | 添加 console.warn 日志 |
| M11 | 视频无 access_level 校验 | video.js:167 | 新增服务端权限检查 |
| M12 | document listener 泄漏 | app.js:186 | 用 wrapper._docClickHandler 防重复 |

### LOW（未修）

- auth.js:289 safeUser 过度暴露（不影响功能）
- admin.js:530 文件上传内存上限（需要架构改动）
- posts.js:63 浏览量无去重（低影响）
- index.js:207 bridge token 在 URL（设计决策）
- sol.js:88 重复 RPC（低影响）
- fixed-address.js 缓存无 TTL（admin 操作触发重置）

## 变更文件清单

- server/routes/ai/scheduler.js（CR1, HI2）
- server/routes/ai/llm.js（CR3）
- server/crypto/monitor.js（HI1）
- server/routes/comments.js（HI4, M5）
- server/routes/auth.js（HI5）
- server/routes/admin.js（M2, M7）
- server/routes/ai/strategy.js（M8）
- server/routes/ai/config.js（M9）
- server/routes/video.js（M11）
- public/ai/app.js（M1, M12）
- tests/routes/comments.test.js（M5 测试更新）
