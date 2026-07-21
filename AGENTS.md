# Repository Guidelines

## Project Structure & Module Organization

- `server/` contains the Node.js ESM backend. HTTP routes live in `server/routes/`; AI inference, strategies, risk, reviews, and model comparison are under `server/routes/ai/`.
- `public/` contains static site assets. The trading application is implemented in `public/ai/index.html`, `app.js`, and `styles.css`; there is no frontend build step.
- `public/ai/aurum_bridge_gui.py` is the Python bridge between the server and MT5.
- `tests/` mirrors backend concerns, with focused suites in `tests/ai/`, `tests/routes/`, and `tests/crypto/`.
- Database changes belong in `server/migrations.js`. Operational and implementation notes belong in `docs/`.

## Build, Test, and Development Commands

```powershell
npm install          # install Node dependencies
npm run dev          # watch-mode server on port 3000
npm start            # production-style server
npm test             # run the full Vitest suite once
npm run test:watch   # rerun affected tests during development
```

Run focused tests with `npx vitest run tests/ai/strategy.test.js`. Build the Windows bridge with `python public/ai/build_nuitka.py`. Start or restart the development server in a visible PowerShell console so runtime failures remain observable.

## Coding Style & Naming Conventions

Use two-space indentation, semicolon-free JavaScript, and ESM `import`/`export`. Follow existing names: `camelCase` for functions and variables, `PascalCase` for classes, and kebab-case module filenames. No repository-wide formatter or linter is configured, so match nearby code and run `node --check` on edited JavaScript. Keep UI copy in Chinese and internal error codes stable. Use parameterized SQL placeholders; never concatenate user input.

## Testing Guidelines

Vitest is the primary framework. Name JavaScript tests `*.test.js`; Python integration probes may use `test_*.py`. Add regression tests for bug fixes, especially authorization, migrations, scheduler state, MT5 timestamps, order execution, and cache boundaries. Run the focused suite first, then `npm test`. Also start the application and confirm `/health` reports connected dependencies when relevant.

## Commit & Pull Request Guidelines

Recent commits use Conventional Commit-style subjects such as `fix(ai): preserve pinned inference selection` and `feat: add reproducible market benchmarks`. Keep commits scoped and imperative. Pull requests should describe behavior changes, migration or configuration impact, tests run, and rollback concerns. Include screenshots for UI changes and link the related issue or task.

## Security & Agent-Specific Notes

Copy `server/.env.example` to `server/.env`; never commit credentials. Preserve both `/api` and `/aurum-api` compatibility. Treat existing uncommitted files as user-owned. Inspect the full call chain before editing, preserve unrelated behavior, and verify every change before handoff.
