# GestionPro RDC — runnable MVP

A locally runnable French-language business management web app for the DRC. This is a practical first release based on the supplied source fragments, with a dependency-free Node.js server and a persistent SQLite database so you can run it immediately without a PostgreSQL service.

## What works in this MVP

- Company sign-up, login, logout, password hashing (`scrypt`) and session cookies.
- Separate company workspaces: every API query is scoped to the signed-in company.
- Dashboard with finance totals, inventory counts, low-stock alerts and fleet counts.
- Finance ledger: create income/expense entries in USD or CDF; currencies are never added together automatically.
- Inventory: create products and warehouses, record receipts/issues/adjustments, validate quantities, prevent negative stock, see movement history.
- Fleet: create vehicles and assign drivers/status.
- CSV exports for finance, inventory, fleet and dashboard summary.
- Audit log for important actions.
- Seeded demo company and end-to-end simulation button.
- Automated API integration test.

## Quick start

Requirements: Node.js 22.5+ (Node 22 LTS recommended). No npm install is needed; the app uses Node built-ins.

```bash
npm start
```

Then open http://localhost:3000.

Demo credentials:
- Email: `demo@gestionpro.cd`
- Password: `GestionPro2026!`

To run automated integration tests in a separate temporary database:

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

## Try the simulation

1. Log in with the demo account.
2. On the dashboard, click **Lancer la simulation** (or open **Rapports & activité**).
3. The app writes test records to the database: a demo product, 20 units received, 3 units issued, a $1,250 income, a 450,000 CDF expense, and a test vehicle.
4. Open Stocks, Finances, Flotte, and Rapports to verify the records.

The simulation uses the same API/database as the rest of this MVP. It is not a visual-only animation. Each run adds new simulation records.

## Important production limitations

This is a runnable local MVP, not yet a hardened production SaaS. Before public deployment:

- Move to PostgreSQL and apply reviewed migrations, row-level security and least-privilege roles.
- Use HTTPS, secure cookie settings, CSRF protection, rate limiting, password reset and email verification.
- Add production session rotation/revocation, account lockout policy and stronger audit review.
- Configure backups, restore drills, monitoring, logs and secret management.
- Add permissions enforcement for every module/action, invitations and multi-user administration.
- Implement the unfinished supplier/customer, HR/payroll, tax, purchase approval, GPS, maintenance, and advanced reporting modules.
- Add automated accessibility, browser, load and security tests.
- Replace the illustrative dashboard chart with real date-bucketed financial aggregates.

The earlier PostgreSQL/SQL source fragments supplied by you are preserved under `reference/source-fragments/` for future integration. They are not connected to this SQLite MVP yet.

## Folder structure

- `server.js` — HTTP server, auth, API routes, database schema and demo seed.
- `public/index.html` — UI structure.
- `public/styles.css` — responsive styling.
- `public/app.js` — UI, forms, navigation, exports and simulation.
- `test.js` — API integration simulation.
- `data/` — local SQLite database created at runtime.
- `reference/source-fragments/` — original supplied SQL and TypeScript fragments.
