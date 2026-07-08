# AURUM System Audit Report
Generated: 2026-07-02

## SECTION 1 — DEPENDENCY INVENTORY

All 21 production packages in package.json are actively imported somewhere
in server/*.js. Zero orphaned packages. No require() calls found — project
is pure ESM throughout.

  Package                      Version   Consumers
  ──────────────────────────────────────────────────────
  @alicloud/dysmsapi20170525   ^4.6.0    server/sms.js
  @alicloud/openapi-client     ^0.4.15   server/sms.js
  @ethereumjs/util             ^10.1.2   server/crypto/wallet.js
  @scure/bip32                 ^2.2.0    server/crypto/wallet.js
  @scure/bip39                 ^2.2.0    server/crypto/wallet.js
  @solana/web3.js              ^1.98.4   server/crypto/wallet.js
  bcryptjs                     ^2.4.3    server/db.js, routes/auth.js
  cors                         ^2.8.5    server/index.js
  dotenv                       ^17.4.2   server/config.js
  express                      ^4.21.0   server/index.js, all routes
  express-rate-limit            ^8.5.2    server/index.js
  ioredis                      ^5.11.1   server/redis.js
  jsonwebtoken                 ^9.0.3    middleware/auth.js, bridge-ws.js
  multer                       ^1.4.5    server/index.js, routes/admin.js
  mysql2                       ^3.22.5   server/db.js
  nodemailer                   ^9.0.3    routes/auth.js
  qrcode                       ^1.5.4    crypto/qr.js
  svg-captcha                  ^1.4.0    server/captcha.js
  tronweb                      ^6.4.0    crypto/wallet.js (lazy dynamic import)
  uuid                         ^10.0.0   routes/auth.js
  ws                           ^8.21.0   bridge-ws.js

  Dev: vitest ^3.2.6


## SECTION 2 — ENV VAR AUDIT (.env.example vs code)

Variables defined in .env.example AND consumed in server code (OK):

  MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE,
  MYSQL_POOL_SIZE, JWT_SECRET, JWT_EXPIRY, PORT, MAX_UPLOAD_SIZE,
  JSON_BODY_LIMIT, RATE_LIMIT_WINDOW_MS, API_RATE_LIMIT_MAX,
  AUTH_RATE_LIMIT_MAX, WRITE_RATE_LIMIT_MAX, REDIS_HOST, REDIS_PORT,
  REDIS_PASSWORD, UPLOAD_DIR, CORS_ORIGINS, ADMIN_CACHE_TTL_MS,
  CAPTCHA_TTL_MS, DEFAULT_API_BASE_URL, DEBUG_CHAN, DEBUG_LLM_PAYLOAD,
  HD_WALLET_MNEMONIC, TRONGRID_API_KEY, ETHERSCAN_API_KEY,
  BSCSCAN_API_KEY, SOLANA_RPC_URL

### MISSING from .env.example (2 variables):

  SEED_ADMIN_PASSWORD   server/db.js:654   defaults to "admin123"
  SEED_DEMO_PASSWORD    server/db.js:655   defaults to "demo123"

These control initial seed account passwords. The hardcoded fallbacks are
weak and should be documented in .env.example so operators override them.


## SECTION 3 — HARDCODED URLS, PORTS, ENDPOINTS

### API Base URLs

  Location                           URL                                    Configurable?
  ─────────────────────────────────────────────────────────────────────────────────────────
  config.js:16                       https://api.deepseek.com               Yes (DEFAULT_API_BASE_URL)
  llm.js:75                          https://api.openai.com                 NO — hardcoded GPT fallback
  crypto/sweep.js:5                  https://api.trongrid.io                NO
  crypto/chains/tron.js:14           https://api.trongrid.io                NO (duplicated constant)
  crypto/chains/eth.js:14            https://api.etherscan.io               Default, overridable via env
  crypto/chains/bsc.js:14            https://api.bscscan.com                Default, overridable via env
  crypto/chains/sol.js:14            https://api.mainnet-beta.solana.com    Default, overridable via env
  wallet.js:43                       https://api.mainnet-beta.solana.com    Default, overridable via env
  ai/index.js:28-29                  https://qiniu.acadfx.com/...           NO — CDN URL in code
  routes/auth.js:709                 https://t.me/WallStreetSkillBot        NO — Telegram bot link
  services/sentiment.js:27           https://www.ig.com/en                  NO — scraped source
  utils.js:6                         https://api.bilibili.com/...           NO — third-party API

### Port Defaults

  config.js:19    PORT=3000         Overridden by env (OK)
  db.js:25        MYSQL_PORT=3306   Overridden by env (OK)
  redis.js:21     REDIS_PORT=6379   Overridden by env (OK)

### CORS Defaults (index.js:49)

  The hardcoded fallback list includes private IP 192.168.1.254 and four
  localhost ports (3000, 3001, 3005, 8080). These are development artifacts
  that ship as production defaults. Override via CORS_ORIGINS env var.

### Duplicate TRONGRID Constant

  crypto/sweep.js:5 defines:  const TRONGRID_API = 'https://api.trongrid.io'
  crypto/chains/tron.js:14 returns 'https://api.trongrid.io' as default

  Should be consolidated into crypto/constants.js (which already holds
  USDT_CONTRACTS but lacks the base URL).


## SECTION 4 — DUPLICATE HELPER FUNCTIONS

No duplicate function definitions found across separate files.

  - round2, round3, round5, clamp are defined once in routes/ai/utils.js
    and imported everywhere needed.

  - The only near-duplication is the TRONGRID_API constant (see Section 3).


## SECTION 5 — TEST COVERAGE

27 test files, 468 tests, all passing.

### Well-covered (20+ tests):
  ai/utils.js            28 tests
  ai/chan (market-data)  45 tests
  ai/llm.js              21 tests
  ai/config.js           20 tests
  routes/posts.js       108 tests
  routes/comments.js     20 tests
  crypto/wallet.js       23 tests
  crypto/chains.js       27 tests
  bridge-ws.js           25 tests
  middleware/auth.js      17 tests

### Minimally covered (4 or fewer tests):
  ai/strategy.js          4 tests
  routes/courses.js       3 tests
  routes/user.js          3 tests
  routes/trades.js        4 tests
  routes/config.js        4 tests
  routes/feedback.js      4 tests

### NO tests at all:

  server/index.js           — Express app setup, CSP headers, bilibili
                               proxy, bridge download scripts, health
                               endpoint, presence heartbeat, SPA fallback

  routes/admin.js           — User CRUD, dashboard stats, course/post
                               management, plan editing, resource upload
                               (761 lines, 0 test coverage)

  routes/payment.js         — Order creation, crypto address assignment,
                               payment QR generation, referral commission
                               (446 lines, 0 test coverage)

  routes/sentiment.js       — Sentiment data endpoint, admin refresh

  services/sentiment.js     — IG.com scraping, market data extraction
                               (63 lines, 0 test coverage)

  db.js core                — initDB(), query(), queryOne(), queryAll(),
                               queryRun(), withTransaction(), beijingNow(),
                               parseBeijing() are tested via other test
                               files that import them, but no dedicated
                               test file exists

  migrations.js             — Schema migration logic (0 test coverage)

  sms.js                    — sendSms, sendVerificationSms (only loadSmsConfig
                               tested in sms.test.js; actual send is mocked)


## SECTION 6 — CIRCULAR IMPORT DEPENDENCY ANALYSIS

### Import graph (server-side only):

  index.js ──> config, db, migrations, utils, redis, middleware/auth
              ──> all route modules
              ──> bridge-ws, crypto/monitor, crypto/wallet
              ──> services/sentiment

  bridge-ws.js ──> config, db, redis, routes/ai/utils
                 ──> DYNAMIC import: routes/ai/index.js (in event handlers)
                 ──> DYNAMIC import: routes/ai/scheduler.js (in get_auto_config)

  routes/ai/index.js ──> db, middleware/auth
                      ──> ai/utils, ai/market-data, ai/llm
                      ──> ai/config, ai/strategy, ai/scheduler
                      ──> bridge-ws (getBridgeDiagnostics)

  routes/ai/strategy.js ──> db, bridge-ws, ai/utils, ai/market-data
                         ──> ai/llm, ai/config

  routes/ai/scheduler.js ──> db, config, bridge-ws
                         ──> ai/market-data, ai/llm, ai/config
                         ──> ai/strategy, ai/utils, redis

  routes/ai/market-data.js ──> db, bridge-ws, ai/utils

  routes/ai/config.js ──> db, ai/utils, config, ai/market-data

  routes/ai/llm.js ──> db, config, ai/utils

  routes/ai/utils.js ──> db (parseBeijing only)

### CIRCULAR CHAIN DETECTED:

  bridge-ws.js  --->  routes/ai/index.js  --->  bridge-ws.js
       |                                           |
       |--- (dynamic import) ---> routes/ai/scheduler.js ---> bridge-ws.js

  ai/config.js ---> ai/market-data.js ---> bridge-ws.js
                                          (via sendBridgeCommand)

  ai/scheduler.js ---> ai/strategy.js ---> ai/config.js

  All circular paths are BROKEN by dynamic imports in bridge-ws.js:

    bridge-ws.js lines 239, 313, 505 use:
      const ai = await import('./routes/ai/index.js')

  This prevents ESM from hitting a circular-deadlock at load time.
  However, the coupling is tight — bridge-ws.js (a 2051-line god module)
  directly imports and calls functions from ai/index.js which itself
  re-exports from bridge-ws.js. This architecture is fragile.

### Risk Assessment:

  LOW — dynamic imports prevent runtime crashes. But any refactoring
  that accidentally makes bridge-ws.js statically import routes/ai/index.js
  (or vice versa at the top level) would create a deadlock.


## SECTION 7 — HARDCODED SECRETS AND PASSWORDS

### CRITICAL: Default seed passwords

  server/db.js:654:  process.env.SEED_ADMIN_PASSWORD || 'admin123'
  server/db.js:655:  process.env.SEED_DEMO_PASSWORD  || 'demo123'

  These are used in seedData() which runs on first startup. If the
  environment variables are not set, admin account gets password "admin123".
  The .env.example does NOT document these variables, so operators likely
  never set them.

### No other hardcoded secrets found:

  - JWT_SECRET is validated at startup (process.exit(1) if missing)
  - API keys come from env vars or database (system_config table)
  - HD_WALLET_MNEMONIC is env-only, with explicit error if unset
  - TRONGRID/ETHERSCAN/BSCSCAN keys come from env vars
  - SMS credentials come from database (system_config table)
  - No API keys, tokens, or mnemonics appear as string literals

### Hardcoded referral codes (not secrets, but fixed):

  server/db.js:660:  referral_code = 'ADMIN001'  (admin seed)
  server/db.js:663:  referral_code = 'DEMO001'   (demo seed)

### Hardcoded plan expiry:

  server/db.js:660:  plan_expires_at = '2027-12-31'  (admin seed)


## SECTION 8 — HARDCODED FILE PATHS

### Paths that reference OS-specific locations:

  index.js:247-248 (in generated .bat script):
    C:\Python%%P\python.exe
    %LOCALAPPDATA%\Programs\Python\Python%%P\python.exe

  These are in a template for a Windows batch file served to users.
  They are CORRECTLY platform-specific since the script targets Windows
  clients running the MT5 bridge.

### Production-safe paths:

  All server-side paths use relative joins via __dirname/fileURLToPath:
    join(__dirname, '..', 'public')
    join(__dirname, '..', 'public', 'ai')
    join(__dirname, 'uploads')
    join(__dirname, '..', 'public', 'ai', 'AURUM_Bridge.exe')

  These are portable and work in any deployment directory.

### Hardcoded bridge EXE path:

  index.js:289:  join(__dirname, '..', 'public', 'ai', 'AURUM_Bridge.exe')

  Served via /ai/bridge/exe-file endpoint. Returns 404 with message
  if file does not exist. Graceful handling.


## SECTION 9 — STALE OR WRONG CONFIG VALUES

### Bridge version from file:

  ai/index.js:21:  readFileSync(join(__dirname, '../../../VERSION'), 'utf-8')
  ai/index.js:26:  build_date: '2026-07-08'

  The build_date is hardcoded to a specific date in the source code.
  This will become stale as the software is updated. The version number
  itself comes from a VERSION file (better), but the build_date and
  changelog string are static.

### Hardcoded exchange referral URLs (db.js:749-761):

  Binance, OKX, Bybit, Bitget, BIT, TradingView, CoinAnk, CoinGlass,
  CoinMarketCap — all have hardcoded referral links with codes.

  These change when affiliate programs update. They are stored as seed
  data in initDB() and could become stale.

### Default plan pricing (payment.js:14-19):

  const DEFAULT_PLANS = {
    free: { price: 0, ... },
    plus: { month: 29, year: 290, lifetime: 990 },
    pro:  { month: 100, year: 1000, lifetime: 3900 },
  }

  These are overridden from database (system_config) at runtime.
  The defaults serve as fallbacks only.

### Market status timeout constants (bridge-ws.js:1965-1966):

  MARKET_SAME_TICK_CLOSED_MS = 60_000
  MARKET_TICK_STALE_MS = 120_000

  Magic numbers. Different instruments may need different thresholds.
  Could be made configurable per-symbol.

### Hardcoded LLM provider list (llm.js:73-76):

  Only 'deepseek' and 'gpt' providers are supported. Adding a new
  provider (Anthropic, Google, etc.) requires code changes.


## SECTION 10 — EMPTY CATCH BLOCKS

25 instances of `catch {}` (no error logging) found across:

  bridge-ws.js:           7 instances — most are WebSocket send/destroy
                          operations where errors are expected and harmless.
                          Lines 59, 183, 261, 347, 348, 467, 500.

  routes/ai/scheduler.js: 2 instances — lines 267, 384

  routes/ai/config.js:    2 instances — JSON.parse fallbacks (lines 11, 459)
                          Acceptable pattern for optional field parsing.

  routes/ai/llm.js:       1 instance — line 87 (DB schema load fallback)

  migrations.js:          8 instances — DROP/ALTER operations that may fail
                          on already-applied migrations. Acceptable for
                          idempotent migration scripts.

  routes/admin.js:        1 instance — line 20 (Latin-1 filename fix)

  routes/video.js:        1 instance — file cleanup

  routes/posts.js:        2 instances — file cleanup on error

  The migrations.js and config.js instances are defensible (idempotent
  operations or JSON parsing). The bridge-ws.js instances for WebSocket
  send are acceptable (best-effort notification).

  NO instances of `catch {}` in critical business logic paths (order
  execution, payment processing, authentication).


## SUMMARY OF FINDINGS

### Severity: HIGH

  1. Default admin password "admin123" ships as fallback when
     SEED_ADMIN_PASSWORD is unset, and .env.example does not document
     this variable.

  2. Zero test coverage on routes/admin.js (761 lines) and
     routes/payment.js (446 lines) — the two most security-sensitive
     route modules.

### Severity: MEDIUM

  3. Circular import chain: bridge-ws <-> ai/index. Currently safe via
     dynamic imports but architecturally fragile.

  4. TRONGRID_API constant duplicated in sweep.js and chains/tron.js.

  5. GPT provider base URL (https://api.openai.com) hardcoded in
     llm.js rather than using DEFAULT_API_BASE_URL pattern.

  6. Bridge CDN URL (qiniu.acadfx.com) hardcoded in ai/index.js.

  7. build_date string ('2026-07-08') hardcoded in ai/index.js:26.

  8. CORS fallback includes private IP 192.168.1.254 and dev ports.

  9. No test coverage for db.js core functions, migrations.js,
     routes/sentiment.js, services/sentiment.js, or sms.js send path.

### Severity: LOW

  10. 25 empty catch blocks (most acceptable for WS/migration contexts).

  11. Market tick timeout constants are magic numbers (60s, 120s).

  12. LLM provider list requires code changes to extend.

  13. Exchange referral URLs in seed data may become stale.
