# AGENTS.md — AURUM AI Trading System

## 修改约束（必须遵守）

**每一步修改都要确认影响边界，详细确认修改后造成的后果。不能影响现有的功能。每改一处都要自测，确认功能完好、用户使用正常。**

- 改代码前先读相关文件，理解调用链
- 改完后 `npm run dev` 启动验证，确认无 `[FATAL]` 错误
- 涉及数据库字段变更必须在 `db.js:initDB()` 或 `migrations.js` 中添加
- 涉及双表同步的（`auto_scheduler` + `user_bridge_settings`），两处都要写

## Quick Start

```bash
cp server/.env.example server/.env   # fill MySQL + JWT_SECRET (required)
npm install
npm run dev             # runs: node --watch server/index.js
```

## Project Overview

- **Stack**: Node.js (ESM) + Express + MySQL (mysql2/promise) + WebSocket (ws) + optional Redis
- **Frontend**: Vanilla HTML/CSS/JS (no framework, no build step)
- **Bridge**: Separate Python app (`aurum_bridge_gui.py`) — not part of npm; packaged with Nuitka (onefile mode)
- **Entry point**: `server/index.js`
- **Database**: MySQL, auto-migrates on startup via `initDB()` in `server/db.js` + tracked migrations in `server/migrations.js`

## Architecture

```
Browser <-> Express (port 3000) <-> MySQL
                 |                     ↕ Redis (optional cache)
Browser <-> WebSocket (bridge-ws.js) <-> Python Bridge <-> MT5 Terminal
```

- `server/bridge-ws.js` — WebSocket server: bridges MT5 data to/from browsers. Per-user state in `bridges` and `browsers` Maps.
- `server/db.js` — MySQL pool, query helpers (`query`, `queryOne`, `queryRun`, `queryAll`, `withTransaction`), auto-migration, Beijing time utils.
- `server/migrations.js` — Tracked schema migrations via `schema_migrations` table (newer system, prefer over inline ALTER in `initDB()`).
- `server/redis.js` — Optional Redis caching. No `REDIS_HOST` = no cache, graceful degradation. Exports `cacheGetJSON`, `cacheSetJSON`, `cacheDel`.
- `server/middleware/auth.js` — JWT auth. Exports `authMiddleware` and `optionalAuth`. Auto-downgrades expired plans.
- `server/config.js` — Loads `.env` via dotenv. **Exits if `JWT_SECRET` is missing.**
- `server/routes/ai/index.js` — AI trading entry point + Router. Split into 7 modules: utils/market-data/llm/config/strategy/scheduler/index.

## Dual API Prefix

Both `/api` and `/aurum-api` serve the same routes. `/aurum-api` is used by the bridge WS path:
- Bridge WebSocket: `/aurum-api/bridge/ws?type=bridge&token=...`
- Bridge download: `/ai/bridge/exe` or `/ai/bridge/setup`

## Critical Gotchas

1. **ESM only**: `package.json` has `"type": "module"`. Use `import/export`, not `require`.
2. **JWT_SECRET required**: `server/config.js` calls `process.exit(1)` if unset. Must be in `server/.env`.
3. **`.env` location**: Environment variables live in `server/.env`, loaded by `server/config.js` (dotenv) and `server/index.js` (manual fallback).
4. **Beijing time hardcoded**: `db.js:beijingNow()` returns UTC+8. MT5 broker time is UTC+3 (convert with -5h offset).
5. **Testing**: Vitest with 124 unit tests (`npm test`). No ESLint or CI pipeline. Additional verification: `npm run dev` and check for `[FATAL]` in console.
6. **Multi-role access**: `admin > pro > plus > free`. Pro needs bridge connected for trading. Plus is read-only (observe mode). Free sees upgrade overlay.
7. **Bridge status matters**: `bridge-ws.js` checks user role AND bridge connection. Many features gate on `bridge` status in user state.
8. **Auto-scheduler dual-table**: Auto-scheduler state stored in both `auto_scheduler` and `user_bridge_settings` tables. Changes must write both.
9. **Nuitka packaging**: Bridge uses Nuitka onefile mode. Build: `python public/ai/build_nuitka.py`. Requires MinGW-w64 (`winget install BrechtSanders.WinLibs.POSIX.UCRT`). `resource_path()` supports both PyInstaller (`sys._MEIPASS`) and Nuitka (`os.path.dirname(sys.executable)`). `.spec` files are gitignored.
10. **No hot reload for frontend**: Static files served from `public/`. Edit HTML/JS directly; browser refresh.
11. **Memory limit**: Deploy with `--max-old-space-size=256`. Without it, PM2 restarts from heap exhaustion.
12. **Redis is optional**: If `REDIS_HOST` is not set, all cache calls silently return null. No crash.
13. **Dual `.env` loading**: `config.js` uses dotenv. `index.js` also manually parses `.env` as fallback (line 33-43). If both run, `config.js` wins.
14. **Static file paths**: `public/` → main site, `public/ai/` → mounted at `/ai`. Bridge EXE served from `/ai/bridge/exe`.

## Dev Commands

| Command | What it does |
|---------|-------------|
| `npm run dev` | Dev server with file watch (`node --watch server/index.js`) |
| `npm start` | Production server (`node server/index.js`) |
| `npm test` | Run all unit tests (`vitest run`) |
| `npm run test:watch` | Run tests in watch mode |

## Key Files

| File | Purpose |
|------|---------|
| `server/index.js` | Express app, middleware, route registration, static serving |
| `server/db.js` | MySQL pool, `initDB()` migration, query helpers, Beijing time |
| `server/migrations.js` | Tracked schema migrations via `schema_migrations` table |
| `server/redis.js` | Optional Redis caching (graceful degradation) |
| `server/bridge-ws.js` | WebSocket server for MT5 bridge |
| `server/config.js` | Env loading, JWT_SECRET validation |
| `server/middleware/auth.js` | JWT authentication |
| `server/routes/ai/index.js` | AI trading entry point + Router |
| `server/routes/ai/utils.js` | Pure function utilities |
| `server/routes/ai/market-data.js` | Market calculation + bridge |
| `server/routes/ai/llm.js` | AI inference + signal normalization |
| `server/routes/ai/config.js` | Config management + risk + audit |
| `server/routes/ai/strategy.js` | Strategy context + execution |
| `server/routes/ai/scheduler.js` | Auto scheduler + smart close |
| `server/routes/admin.js` | Admin panel APIs |
| `server/routes/auth.js` | Login/register |
| `public/ai/app.js` | Frontend trading UI logic (4100+ lines) |
| `public/ai/index.html` | AURUM AI trading page |

## Coding Conventions

- **Language**: Chinese comments and UI text throughout.
- **Error handling**: Never use empty `catch {}` or bare `except`. Log errors with `[Module]` prefix.
- **DB queries**: Always use parameterized queries (`?` placeholders), never string concatenation.
- **Auth on routes**: Use `authMiddleware` from `middleware/auth.js`, never inline role checks.
- **Timezone**: Use `beijingNow()` from `db.js` for all timestamps. MT5 time = Beijing - 5h.
- **Permissions**: Check `req.user.plan` and `req.user.role` against allowed values. Use `PUBLIC_CATEGORIES` for unauthenticated routes.
- **Dual-table sync**: When writing to `auto_scheduler` or `user_bridge_settings`, write both tables.
- **Redis caching**: Use `cacheGetJSON`/`cacheSetJSON` for frequently accessed data (admin stats, system_config). Invalidate on write.
- **No comments**: Don't add code comments unless explicitly asked.

## Code Review

See `CODE_REVIEW.md` for the full review checklist. Key rules:
- SQL injection, XSS, auth bypass, bare exceptions = must fix
- Dual-table sync, N+1 queries, resource leaks = should fix
- Every PR self-check against historical bug patterns in CODE_REVIEW.md

## Recent Improvements (2026-07-04)

### Performance Indexes
Added to `migrations.js`:
- `users(last_seen_at)`, `ai_signals(user_id, created_at)`, `orders(user_id, status)`
- `auto_scheduler(enabled)`, `audit_logs(user_id, action)`, `notifications(user_id, is_read)`, `trades(user_id)`

### Code Quality
- Fixed empty catch blocks in `admin.js` and `ai.js` — now log errors with `[Admin]`/`[AI]` prefix
- Unified time functions: `bridge-ws.js` and `ai.js` now use `beijingNow()` from `db.js`

### Bug Fixes
- `upsertAutoConfig()` now syncs to `user_bridge_settings` (dual-table consistency)
- `comments.js` batch loads likes (eliminated N+1 query)
- `admin.js` deletes `user_bridge_settings` when deleting user
- `payment.js` wraps order creation in transaction

### Performance
- `admin.js` dashboard stats cached 60s via Redis
- `config.js` public configs cached 300s via Redis
- Cache invalidated on write/update/delete

### Architecture
- `ai.js` split into 7 modules: utils/market-data/llm/config/strategy/scheduler/index
- Bridge packaging switched from PyInstaller to Nuitka (lower AV false positives, 58.9MB vs 64.2MB)
- `resource_path()` supports both PyInstaller and Nuitka runtimes

### Testing
- Vitest framework with 124 unit tests
- Coverage: ai/utils.js (28), ai/llm.js (17), ai/config.js (14), ai/market-data.js (14), ai/chan.js (45), ai/strategy.js (4), ai/scheduler.js (2)
- Run: `npm test`

### Frontend Performance
- Timer pause on page visibility change (reduces CPU/network when tab hidden)
- K-line volume refresh reduced from 1s to 5s (80% less overhead)
- MutationObserver/ResizeObserver lifecycle management (prevents memory leaks)

## Deployment

- Production: `git pull origin main && npm install --production && restart PM2`
- MySQL auto-migrates on startup via `initDB()` + `runMigrations()`
- Bridge EXE: download from server `/ai/bridge/exe-file` endpoint
- See `DEPLOY.md` for full server setup (宝塔 + Nginx reverse proxy + WebSocket upgrade)
