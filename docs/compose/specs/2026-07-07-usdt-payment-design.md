# USDT 纯链上支付系统设计

## [S1] 问题

当前支付模块架构已完整（orders 表、积分抵扣、推荐返佣、会员升级），但 POST `/api/payment` 返回 503，无真实支付网关集成。用户需要 USDT 加密货币支付功能，要求：
- **零平台费用**（不使用第三方支付网关）
- **全链支持**：TRC-20 (Tron)、ERC-20 (Ethereum)、BEP-20 (BSC)、SPL (Solana)
- **动态地址**：每个订单生成唯一收款地址（HD 钱包派生），自动区分付款
- **实时确认**：Webhook/Event 通知监控到账和确认数

## [S2] 系统架构

```
用户选套餐 → POST /api/payment → 创建订单 + 派生唯一地址
    ↓
返回 QR 码 + 地址 + 金额 + 倒计时
    ↓
用户扫码/转账 USDT
    ↓
区块链 Event 通知 → 后端接收 → 验证金额+确认数
    ↓
确认足够 → 激活会员 + 发通知
```

### 核心组件

1. **HD 钱包管理**：BIP44 派生唯一地址，加密存储主密钥
2. **多链适配器**：统一接口适配 Tron/Ethereum/BSC/Solana
3. **Event 监听器**：各链 WebSocket/Event 订阅
4. **支付状态机**：pending → confirming → confirmed → expired/failed
5. **订单管理**：复用现有 orders 表，新增加密支付字段

## [S3] 数据库设计

### orders 表新增字段

```sql
ALTER TABLE orders ADD COLUMN crypto_chain VARCHAR(10) DEFAULT NULL;
ALTER TABLE orders ADD COLUMN crypto_address VARCHAR(100) DEFAULT NULL;
ALTER TABLE orders ADD COLUMN crypto_amount DECIMAL(20,8) DEFAULT NULL;
ALTER TABLE orders ADD COLUMN crypto_tx_hash VARCHAR(100) DEFAULT NULL;
ALTER TABLE orders ADD COLUMN crypto_confirmations INT DEFAULT 0;
ALTER TABLE orders ADD COLUMN crypto_expires_at DATETIME DEFAULT NULL;
```

### 新表：crypto_watch_list

```sql
CREATE TABLE crypto_watch_list (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(36) NOT NULL,
  user_id INT NOT NULL,
  chain VARCHAR(10) NOT NULL,          -- trc20/erc20/bep20/spl
  address VARCHAR(100) NOT NULL,       -- 收款地址
  expected_amount DECIMAL(20,8) NOT NULL, -- 期望 USDT 金额
  status VARCHAR(20) DEFAULT 'pending', -- pending/received/confirmed/expired
  tx_hash VARCHAR(100) DEFAULT NULL,
  confirmations INT DEFAULT 0,
  required_confirmations INT DEFAULT 19,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  INDEX idx_status (status),
  INDEX idx_address (chain, address),
  INDEX idx_expires (expires_at)
);
```

## [S4] HD 钱包设计

### 密钥管理

- **主密钥**：存储在 `.env` 文件（`HD_WALLET_MNEMONIC` 或 `HD_WALLET_PRIVATE_KEY`）
- **加密**：应用层 AES-256-GCM 加密后存 DB（`wallet_keys` 表）
- **派生路径**：
  - Ethereum/BSC: `m/44'/60'/0'/0/{index}`
  - Tron: `m/44'/195'/0'/0/{index}` (TRON 用 195')
  - Solana: `m/44'/501'/0'/{index}'` (Ed25519)

### 地址派生流程

```
1. 新订单 → 从 auto_increment_index 获取下一个 index
2. 按 chain 派生路径派生子密钥
3. 导出公钥 → 地址
4. 存储 {index, address, chain} 到 wallet_keys 表
5. 订单绑定该地址
```

### 依赖库

- `@scure/bip32` / `@scure/bip39`：BIP44 HD 钱包（纯 JS，无 native 依赖）
- `@ethereumjs/util`：ETH 地址派生
- `tronweb`：TRON 地址派生
- `@solana/web3.js`：SOL 地址派生

## [S5] 多链适配器

### 统一接口

```javascript
class ChainAdapter {
  name: string
  chainId: string

  // 派生地址
  deriveAddress(index: number): { address: string, publicKey: string }

  // 检查交易
  getTransaction(txHash: string): Promise<TxInfo>

  // 获取确认数
  getConfirmations(txHash: string): Promise<number>

  // 监听事件（WebSocket）
  onTransfer(callback: (event: TransferEvent) => void): void

  // 启动/停止监听
  start(): void
  stop(): void
}
```

### 各链实现

| 链 | Event API | 确认数要求 | Gas 特点 |
|----|-----------|-----------|----------|
| TRC-20 | TronGrid WebSocket | 19 确认 | ~1 USDT |
| ERC-20 | Etherscan WebSocket | 12 确认 | 5-50 USDT (gas 波动大) |
| BEP-20 | BSCScan WebSocket | 15 确认 | ~0.3 USDT |
| SPL | Solana WebSocket | 32 确认 | ~0.001 USDT |

### Event 监听策略

```javascript
// TronGrid: 订阅合约 Transfer 事件
tronWeb.event.subscribe({
  contractAddress: USDT_TRC20_CONTRACT,
  eventName: 'Transfer',
  from: startBlock,
  filters: { to: watchedAddresses }
})

// Etherscan/BSCScan: WebSocket 订阅
const ws = new WebSocket(`wss://${chain}.etherscan.io/wss?...`)
ws.send({ action: 'event', contract: USDT_CONTRACT, topic: 'Transfer' })

// Solana: subscription
connection.onLogs(USDT_MINT, (logs) => { ... })
```

## [S6] 订单流程

### 创建订单 (POST /api/payment)

```javascript
// 1. 验证输入
const { plan, period, crypto_chain } = req.body

// 2. 计算金额（USDT = USD 价格 / 实时汇率）
const usdAmount = PLANS[plan][period] / 100
const cryptoAmount = usdAmount  // USDT ≈ 1 USD

// 3. 派生唯一地址
const adapter = adapters[crypto_chain]
const index = await getNextWalletIndex(crypto_chain)
const { address } = adapter.deriveAddress(index)

// 4. 创建订单
const orderId = uuidv4()
const orderNo = `WSS${Date.now()}${random}`
const expiresAt = new Date(Date.now() + 30 * 60 * 1000)  // 30 分钟

await withTransaction(async (run) => {
  await run(`INSERT INTO orders (...)`, [..., 'pending', '待支付'])
  await run(`INSERT INTO crypto_watch_list (...)`, [...])
})

// 5. 返回支付信息
res.json({
  ok: true,
  orderId,
  chain: crypto_chain,
  address,
  amount: cryptoAmount,
  qrCode: generateQRCode(`tronext:${address}?amount=${cryptoAmount}`),
  expiresAt,
  requiredConfirmations: REQUIRED_CONFIRMATIONS[crypto_chain]
})
```

### Event 接收处理

```javascript
// 收到转账事件
function handleTransfer(event) {
  const { txHash, from, to, amount, chain } = event

  // 1. 查找匹配的 watch_list 记录
  const watch = await queryOne(
    `SELECT * FROM crypto_watch_list WHERE address = ? AND chain = ? AND status = 'pending'`,
    [to, chain]
  )
  if (!watch) return  // 未知地址，忽略

  // 2. 验证金额（允许 ±1% 容差）
  if (Math.abs(amount - watch.expected_amount) / watch.expected_amount > 0.01) {
    console.warn(`[USDT] Amount mismatch: expected ${watch.expected_amount}, got ${amount}`)
    return
  }

  // 3. 更新状态
  await queryRun(
    `UPDATE crypto_watch_list SET status = 'confirming', tx_hash = ? WHERE id = ?`,
    [txHash, watch.id]
  )

  // 4. 启动确认数监控
  startConfirmationMonitor(watch, txHash)
}
```

### 确认数监控

```javascript
async function startConfirmationMonitor(watch, txHash) {
  const adapter = adapters[watch.chain]
  const required = watch.required_confirmations

  const check = async () => {
    const confs = await adapter.getConfirmations(txHash)
    await queryRun(
      `UPDATE crypto_watch_list SET confirmations = ? WHERE id = ?`,
      [confs, watch.id]
    )

    if (confs >= required) {
      // 确认足够，激活会员
      await confirmPayment(watch)
    } else {
      // 继续监控
      setTimeout(check, getIntervalForChain(watch.chain))
    }
  }

  setTimeout(check, 5000)  // 首次检查延迟 5 秒
}
```

### 激活会员

```javascript
async function confirmPayment(watch) {
  const order = await queryOne(`SELECT * FROM orders WHERE id = ?`, [watch.order_id])

  await withTransaction(async (run) => {
    // 更新订单状态
    await run(`UPDATE orders SET status = 'paid', status_label = '已完成', paid_at = NOW() WHERE id = ?`, [watch.order_id])

    // 更新 watch_list
    await run(`UPDATE crypto_watch_list SET status = 'confirmed' WHERE id = ?`, [watch.id])

    // 激活会员
    const expiresAt = calculateExpiry(order.period)
    await run(`UPDATE users SET plan = ?, plan_period = ?, plan_expires_at = ?, updated_at = NOW() WHERE id = ?`,
      [order.plan, order.period, expiresAt, order.user_id])

    // 处理推荐返佣
    await processReferralCommission(run, order)
  })

  // 发送通知
  await sendPaymentNotification(order.user_id, order)
}
```

## [S7] 前端支付页面

### 支付流程 UI

1. **套餐选择页**（现有 membership 页面）
   - 显示 USDT 支付选项
   - 选择链（TRC-20/ERC-20/BEP-20/SOL）
   - 点击"USDT 支付"

2. **支付详情页**（新增）
   - QR 码（扫码支付）
   - 收款地址（可复制）
   - 支付金额（USDT）
   - 30 分钟倒计时
   - 确认数状态（实时更新）
   - "已完成支付" 按钮

3. **支付成功页**（复用现有 `/?payment=success`）

### 前端 WebSocket 订阅

```javascript
// 连接后端 WS，订阅订单状态
ws.send(JSON.stringify({
  type: 'subscribe_order',
  orderId: order.id
}))

// 接收状态更新
ws.onmessage = (event) => {
  const { type, confirmations, status } = JSON.parse(event.data)
  if (type === 'order_update') {
    updateUI(confirmations, status)
  }
}
```

## [S8] 安全设计

1. **地址验证**：派生地址后验证格式，防止错误派生
2. **金额验证**：±1% 容差，防止小额/大额攻击
3. **重复支付**：同一地址同一订单只处理一次（tx_hash 唯一约束）
4. **过期处理**：30 分钟未支付自动过期，释放地址
5. **密钥安全**：主密钥 AES-256-GCM 加密存储，内存中仅持有解密后的临时密钥
6. **回调验证**：Event 数据签名验证（各链 API 自带）
7. **限流**：创建订单限流（60s/5次/IP）

## [S9] 依赖项

### npm 包

```json
{
  "@scure/bip32": "^1.3.0",
  "@scure/bip39": "^1.2.0",
  "@ethereumjs/util": "^9.0.0",
  "tronweb": "^5.0.0",
  "@solana/web3.js": "^1.87.0",
  "qrcode": "^1.5.3"
}
```

### 外部 API（免费额度）

| 服务 | 用途 | 免费额度 |
|------|------|----------|
| TronGrid | TRC-20 Event 监听 | 100k req/day |
| Etherscan | ERC-20 Event 监听 | 5 req/sec |
| BSCScan | BEP-20 Event 监听 | 5 req/sec |
| Solana RPC | SPL Event 监听 | 100k req/day |

### 环境变量

```bash
# .env
HD_WALLET_MNEMONIC=your twelve word mnemonic phrase here
# 或
HD_WALLET_PRIVATE_KEY=0x...

# 各链 API Keys
TRONGRID_API_KEY=...
ETHERSCAN_API_KEY=...
BSCSCAN_API_KEY=...
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# USDT 合约地址
USDT_TRC20_CONTRACT=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
USDT ERC20_CONTRACT=0xdAC17F958D2ee523a2206206994597C13D831ec7
USDT_BEP20_CONTRACT=0x55d398326f99059fF775485246999027B3197955
USDT SPL_MINT=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
```

## [S10] 实现步骤

### Phase 1: 基础设施（1-2 天）

1. 安装依赖包
2. 创建 `server/crypto/` 目录
3. 实现 HD 钱包管理模块 (`wallet.js`)
4. 实现各链适配器 (`chains/tron.js`, `chains/eth.js`, `chains/bsc.js`, `chains/sol.js`)
5. 数据库迁移（orders 新增字段 + crypto_watch_list 表）

### Phase 2: 后端核心（2-3 天）

1. 修改 `payment.js` POST handler（移除 503，实现订单创建）
2. 实现 Event 监听器管理器
3. 实现确认数监控逻辑
4. 实现支付确认 + 会员激活
5. WebSocket 订单状态推送

### Phase 3: 前端 UI（1-2 天）

1. 修改 membership 页面（USDT 支付选项）
2. 新增支付详情页（QR 码、地址、倒计时）
3. WebSocket 实时状态更新
4. 支付成功/失败处理

### Phase 4: 测试 + 部署（1 天）

1. 单元测试（钱包派生、地址验证、金额验证）
2. 集成测试（完整支付流程）
3. 测试网部署验证
4. 生产环境部署

## [S11] 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 主密钥泄露 | 所有收款地址被盗 | AES 加密存储，内存中最小化持有时间 |
| Event 丢失 | 支付未确认 | 轮询兜底（每 5 分钟检查一次 pending 订单） |
| Gas 费波动 | ERC-20 用户支付额外 gas | 前端显示预估 gas，推荐 TRC-20 |
| 链 API 限流 | 监听延迟 | 多 API Key 轮询，本地缓存 |
| 用户付错链 | 资金丢失 | 前端明确提示链类型，地址格式验证 |

---

**Status**: Draft
**Created**: 2026-07-07
**Author**: MiMoCode
