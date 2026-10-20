# GestionPro RDC: Phase 1 (fondation vérifiée)

Stack : TypeScript, PostgreSQL 16, Drizzle ORM (schéma typé) + migrations SQL, Vitest. Next.js à venir (phase suivante).

## Démarrage
1. `psql -U postgres -f scripts/setup-roles.sql` (changez les mots de passe)
2. `cp .env.example .env` puis adaptez les URLs
3. `npm install && npm run db:migrate`
4. `npm test` (30 tests : isolation des entreprises, droits, devises, anti-doublons)

## Sécurité en place (vérifiée par les tests)
- Isolation par entreprise : `authorize()` côté serveur + Row-Level Security PostgreSQL (FORCE), rôle applicatif non propriétaire.
- Historique des taux de change : le rôle applicatif ne peut ni modifier ni supprimer.
- Journal d'audit : ajout seul, y compris pour le propriétaire de la table (trigger).
- Création d'entreprise atomique via `create_company_with_owner()` (entreprise + propriétaire + audit).
- Montants en entiers (centimes) ; USD et CDF jamais mélangés sans taux explicite ; taux invalides refusés.
- `once()` : une même opération rejouée ou envoyée en double s'exécute une seule fois.

## Limites connues
- La table `users` n'est pas isolée par RLS (la connexion doit pouvoir chercher par e-mail) : n'exposez jamais de requête libre dessus.
- Pas encore d'authentification, d'interface, ni de modules métier. Conformité fiscale/paie RDC non revendiquée.
