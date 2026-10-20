# GestionPro RDC — runnable MVP

A locally runnable French-language business management web app for the DRC. This MVP uses a dependency-free Node.js server and a persistent SQLite database, so it can run without a PostgreSQL service.

## Features

- Company sign-up, login, logout and password hashing (`scrypt`).
- Isolated company workspaces.
- Dashboard with finance totals, inventory counts, low-stock alerts and fleet counts.
- Finance ledger for income and expenses in USD or CDF.
- Inventory, warehouses, stock movements, movement history and low-stock alerts.
- Fleet records for vehicles and drivers.
- CSV exports, audit logs and demo simulation.
- Automated API integration test.

## Quick start

Requirements: Node.js 22.5+ (Node 22 LTS recommended). The application uses Node built-ins.

```bash
npm start
```

Open http://localhost:3000.

Demo credentials:
- Email: `demo@gestionpro.cd`
- Password: `GestionPro2026!`

Run the integration test:

```bash
npm test
```

To change port or database file:

```bash
PORT=3001 DB_PATH=./data/my-company.sqlite npm start
```

On Windows PowerShell:

```powershell
$env:PORT="3001"
$env:DB_PATH=".\data\my-company.sqlite"
npm start
```

## Production limitations

This is a local MVP, not a hardened production SaaS. Before public deployment, review and implement PostgreSQL migrations and row-level security, HTTPS and secure cookie configuration, CSRF protection, rate limiting, email verification/password reset, session revocation, backups and monitoring, and comprehensive security/accessibility testing. Several advanced supplier/customer, HR/payroll, tax, purchase approval, GPS and maintenance modules remain future work.

The original SQL and TypeScript source fragments are preserved under `reference/source-fragments/` for future integration; they are not connected to this SQLite MVP yet.

## Structure

- `server.js` — HTTP server, authentication, API routes, database schema and demo seed.
- `public/index.html` — web UI entry point.
- `public/styles.css` — responsive styling.
- `public/app.js` — UI, forms, navigation, exports and simulation.
- `test.js` — API integration simulation.
- `data/` — SQLite database created at runtime.
- `reference/source-fragments/` — original SQL and TypeScript fragments.
