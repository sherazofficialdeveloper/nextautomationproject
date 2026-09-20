# NETX — Desktop Software (User-Facing)

Electron.js + React.js + Vite (JavaScript only, no TypeScript).
The desktop application is the customer-facing client. It is **not** a security
authority: authentication, license validity, expiry, and permissions are
decided by the NETX backend.

## Architecture

- `electron/main.js` — main process (window lifecycle, IPC handlers)
- `electron/preload.js` — secure context-isolated bridge (`window.netx`)
- `src/` — React renderer (login screen today; workspace modules later)
- `src/services/` — API/authentication service (real backend calls only)

Security defaults: `contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`, strict production CSP, no application menu, no arbitrary
navigation, no Node APIs exposed to the renderer, no secrets in the app.

## Scripts

```bash
npm install          # install dependencies (includes Electron binary)
npm run build        # production renderer build -> dist/
npm start            # build + run the desktop app
npm run lint         # eslint
npm run smoke        # build + automated startup verification (then quit)

# Development with HMR (two terminals):
npm run dev:renderer # Vite dev server on http://localhost:5173
npm run dev:electron # Electron loading the dev server
```

## Backend configuration (renderer, build-time)

Copy `.env.example` to `.env.local` and set `VITE_API_BASE_URL` (for example
`http://localhost:3000/api`). With no URL configured, the login screen shows a
clear "Backend API is not configured." error — no fake authentication exists.

## Current module

Login screen only (username, password, login). The post-login workspace is the
next module and will follow the provided reference image with **text-only**
navigation (no icons).
