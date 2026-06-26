# AGENTS.md — AURUM AI Trading System

## Quick Start

```bash
cd server
cp .env.example .env   # fill MySQL + JWT_SECRET (required)
npm install
npm run dev             # starts with --watch on port 3000
```

## Project Overview

- **Stack**: Node.js (ESM) + Express + MySQL (mysql2/promise) + WebSocket (ws)
- **Frontend**: Vanilla HTML/CSS/JS (no framework, no build step)
- **Bridge**: Separate Python app (`aurum_bridge_gui.py`) — not part of npm; packaged with PyInstaller via `AURUM_Bridge.spec`
- **Entry point**: `server/index.js`
- **Database**: MySQL, auto-migrates on startup via `initDB()` in `server/db.js`

## Architecture

```
Browser <-> Express (port 3000) <-> MySQL
                 |
Browser <-> WebSocket (bridge-ws.js) <-> Python Bridge <-> MT5 Terminal
```

- `server/bridge-ws.js` — WebSocket server: bridges MT5 data to/from browsers. Per-user state in `bridges` and `browsers` Maps.
- `server/db.js` — MySQL pool, query helpers (`query`, `queryOne`, `queryRun`, `queryAll`), auto-migration, Beijing time utils.
- `server/middleware/auth.js` — JWT auth. Exports `authMiddleware` and `optionalAuth`. Auto-downgrades expired plans.
- `server/config.js` — Loads `.env` via dotenv. **Exits if `JWT_SECRET` is missing.**
- `server/routes/ai.js` — AI trading logic + auto-scheduler + signal generation.

## Critical Gotchas

1. **ESM only**: `package.json` has `"type": "module"`. Use `import/export`, not `require`.
2. **JWT_SECRET required**: `server/config.js` calls `process.exit(1)` if unset. Must be in `server/.env`.
3. **No `.env` at root**: Environment variables live in `server/.env`, loaded by `server/config.js`.
4. **Beijing time hardcoded**: `db.js:beijingNow()` returns UTC+8. MT5 broker time is UTC+3 (convert with -5h offset).
5. **No test/lint/CI**: No test framework, ESLint, or GitHub Actions configured. Manual review via `CODE_REVIEW.md`.
6. **Multi-role access**: `admin > pro > plus > free`. Pro needs bridge connected for trading. Plus is read-only (observe mode). Free sees upgrade overlay.
7. **Bridge status matters**: `bridge-ws.js` checks user role AND bridge connection. Many features gate on `bridge` status in user state.
8. **Auto-scheduler dual-table**: Auto-scheduler state stored in both `auto_scheduler` and `user_bridge_settings` tables. Changes must write both.
9. **PyInstaller `.spec`**: Hardcoded paths (`D:\\web\\public\\ai\\...`). Only builds on original dev machine.
10. **No hot reload for frontend**: Static files served from `public/`. Edit HTML/JS directly; browser refresh.
11. **Memory limit**: Deploy with `--max-old-space-size=256`. Without it, PM2 restarts from heap exhaustion.

## Dev Commands

| Command | What it does |
|---------|-------------|
| `cd server && npm run dev` | Dev server with file watch |
| `cd server && npm start` | Production server |

## Key Files

| File | Purpose |
|------|---------|
| `server/index.js` | Express app, middleware, route registration |
| `server/db.js` | MySQL pool, `initDB()` migration, query helpers |
| `server/bridge-ws.js` | WebSocket server for MT5 bridge |
| `server/middleware/auth.js` | JWT authentication |
| `server/config.js` | Env loading, JWT_SECRET validation |
| `server/routes/ai.js` | AI trading, auto-scheduler, signals |
| `server/routes/admin.js` | Admin panel APIs |
| `server/routes/auth.js` | Login/register |
| `public/ai/app.js` | Frontend trading UI logic |
| `AURUM_Bridge.spec` | PyInstaller config for bridge EXE |

## Coding Conventions

- **Language**: Chinese comments and UI text throughout.
- **Error handling**: Never use empty `catch {}` or bare `except`. Log errors per `CODE_REVIEW.md`.
- **DB queries**: Always use parameterized queries (`?` placeholders), never string concatenation.
- **Auth on routes**: Use `authMiddleware` from `middleware/auth.js`, never inline role checks.
- **Timezone**: Store/display Beijing time (UTC+8). MT5 time = Beijing - 5h.
- **Permissions**: Check `req.user.plan` and `req.user.role` against allowed values. Use `PUBLIC_CATEGORIES` for unauthenticated routes.
- **Dual-table sync**: When writing to `auto_scheduler` or `user_bridge_settings`, write both tables.

## Code Review

See `CODE_REVIEW.md` for the full review checklist. Key rules:
- 🔴 SQL injection, XSS, auth bypass, bare exceptions = must fix
- 🟡 Dual-table sync, N+1 queries, resource leaks = should fix
- Every PR self-check against historical bug patterns in CODE_REVIEW.md §5

## Deployment

- Production: `git pull origin main && npm install --production && restart PM2`
- MySQL auto-migrates on startup via `initDB()`
- Bridge EXE: download from server `/ai/bridge/exe-file` endpoint
- See `DEPLOY.md` for full server setup (宝塔 + Nginx reverse proxy + WebSocket upgrade)
