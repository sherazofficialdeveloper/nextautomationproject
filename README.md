# Railway License Platform

Monorepo for the Railway License Platform.

## Structure

- `backend/`        — Node.js + Express + PostgreSQL (central authority)
- `admin-panel/`    — React.js Admin Panel
- `seller-panel/`   — React.js Seller Panel
- `desktop-app/`    — Electron.js + React.js Desktop Application

## Rule

All panels and the desktop app communicate with the single `backend/`.
Frontend apps are never security authorities.
# nextautomationproject
