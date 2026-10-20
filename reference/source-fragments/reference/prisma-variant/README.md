# GestionPro RDC — Phase 1 (fondation)

## Contenu
- `prisma/schema.prisma` : entreprises (multi-tenant), utilisateurs, appartenances + rôles, invitations,
  taux de change historisés, journal d'audit, clés d'idempotence.
- `prisma/rls.sql` : Row-Level Security PostgreSQL (isolation des locataires, journal d'audit en ajout seul).
- `src/lib/permissions.ts` : matrice rôles × modules × actions (10 rôles).
- `src/lib/tenant.ts` : `authorize()` côté serveur, `withTenant()`, `audit()`, plafonds d'approbation, `once()` anti-doublon.
- `src/lib/money.ts` : montants en bigint (centimes), conversion USD/CDF uniquement avec un taux explicite.
- `src/i18n/fr.json` : libellés français (architecture prête pour d'autres langues).

## Démarrage
```
npx create-next-app@latest . --ts --tailwind --app
npm i prisma @prisma/client && npx prisma migrate dev --name init
psql $DATABASE_URL -f prisma/rls.sql   # puis utiliser un rôle SQL non-superutilisateur
```
## Notes
- Toute route/action serveur commence par `authorize(session.userId, companyId, module, action)`.
- Aucune conformité fiscale/paie RDC (CNSS, IPR…) n'est revendiquée : paramètres configurables à faire valider.
