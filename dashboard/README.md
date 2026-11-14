# SovPin Backend & Developer Console Server (`dashboard/`)

This directory contains the Express API server (`server.js`), SQLite WAL multi-tenant ledger (`src/db.js`), Verus JSON-RPC & VDXF `URLRef` compiler (`src/verus-rpc.js`, `src/verus-storage.js`), Kubo RPC client (`src/kubo-service.js`), and integration test suite (`test/`).

> **Canonical Documentation:** See [`../docs/ARCHITECTURE_AND_API.md`](../docs/ARCHITECTURE_AND_API.md) for the complete REST API specification, SQLite schema, upload modes, and environment variables, and [`../docs/FOUNDATION.md`](../docs/FOUNDATION.md) for the architectural charter.

## Commands

```bash
cd /home/demon/sovpin/dashboard
npm run build:web   # Compile ../web into ../web/dist served at /
npm test            # Run live integration, VDXF, and documentation anti-drift tests
npm start           # Start server directly on http://127.0.0.1:3001
```
