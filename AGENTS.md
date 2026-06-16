# AGENTS.md

## Project overview

AURUM AI Trading System v1.7.3 — Node.js/Express server + MySQL + WebSocket bridge to MT5. Serves both API (`/api`, `/aurum-api`) and static frontend (`/public`). The `server/` directory is the backend root; `public/` is the SPA frontend.

## Commands

```bash
# Install dependencies (from web/)
npm install

# Start server (port 3000, auto-creates tables + seeds on first run)
node server/index.js

# No lint, typecheck, test, or build steps exist. This project has no CI.
```

## Architecture

- **Entry**: `server/index.js` — Express app, HTTP server, WebSocket init, DB init
- **Database**: `server/db.js` — MySQL connection pool via `mysql2/promise`. `initDB()` auto-creates/alters tables on startup (no separate migration tool).
- **Bridge**: `server/bridge-ws.js` — WebSocket server at `/aurum-api/bridge/ws`. Manages per-user bridge (MT5 terminal) and browser connections. Trade commands route: Browser → Server → Bridge → MT5.
- **AI routes**: `server/routes/ai.js` (1199 lines) — Core trading logic: LLM inference, signal generation, auto-execution, order review scheduler, MT5 bridge commands.
- **Auth**: JWT-based. `server/middleware/auth.js` exports `authMiddleware`, `optionalAuth`, `adminOnly`. JWT secret fallback is `wall-street-skill-secret`.

## Key quirks

- **Auto-migration on startup**: `initDB()` in `db.js` creates tables and alters columns. No separate migration step. If you change schema, add CREATE TABLE/ALTER TABLE statements there.
- **Beijing time (UTC+8)**: Server stores `DATETIME` in Beijing time. `beijingNow()` helper in `db.js`. MT5 broker time is UTC+3 — conversion via `toMt5Time()` / `utcToMt5Time()`.
- **Two API mounts**: Same `aiRoutes` mounted on both `/api` and `/aurum-api` (`index.js:72-73`).
- **No-cache headers**: All API and `/ai` routes get `Cache-Control: no-store` to prevent stale session data.
- **WebSocket upgrade**: Only paths starting with `/aurum-api/bridge/ws` are upgraded; everything else is rejected.
- **.env loading**: Manual parsing in `index.js:29-37` (not `dotenv`). Values set to `process.env` directly.
- **Upload limit**: 10MB (`multer` config in `index.js:43`).
- **Default admin seed**: `admin@wallstreetskill.com` / `admin123` — created on first DB init.

## Database

- MySQL 5.7+, database `huaerjie`. Config via `server/.env`.
- Pool size: 10 connections.
- Tables: `users`, `courses`, `ai_configs`, `ai_signals`, `trade_audit_logs`, `auto_scheduler`, `global_auto_config`, `orders`, `trades`, `posts`, `comments`, `notifications`, `audit_logs`, and more.
- Sensitive: `ai_configs.api_key_encrypted` stores API keys. `global_auto_config.api_key_encrypted` stores shared model key.

## Deployment

Production deploy via 宝塔面板 (BT Panel): Nginx reverse proxy → Node.js 3000. WebSocket requires explicit Nginx upgrade config (see `DEPLOY.md`). Path: `/www1/wwwroot/aurum-ai/server`.
