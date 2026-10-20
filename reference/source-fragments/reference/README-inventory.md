# GestionPro RDC

Application web de gestion d'entreprise (multi-entreprises) : Next.js 15, TypeScript, PostgreSQL 16.

## Fonctionnalités réelles (testées)
- Inscription d'une entreprise, connexion, sessions sécurisées (cookie httpOnly, mot de passe scrypt, révocation à la déconnexion)
- Isolation stricte entre entreprises (vérification serveur + Row-Level Security PostgreSQL)
- 10 rôles avec droits par module ; l'interface masque ce que le rôle ne peut pas faire, le serveur le refuse
- Finances : transactions USD/CDF, approbation avec plafond par rôle et par devise, pas d'auto-approbation, journal d'audit
- Stocks : produits, entrepôts, mouvements (réception, sortie, perte, endommagé, périmé, ajustement justifié), transferts atomiques entre entrepôts, stock jamais négatif même en cas de requêtes simultanées, historique non modifiable, alerte de stock bas, protection contre la double soumission
- Données conservées dans PostgreSQL (rien n'est perdu à l'actualisation ni au redémarrage)
- 55 tests automatisés + test de bout en bout du serveur

## Mise en route
```
psql -U postgres -f scripts/setup-roles.sql      # changez les mots de passe d'abord
cp .env.example .env                              # adaptez les URLs
npm install
npm run db:migrate
npm test
npm run dev                                       # http://localhost:3000
```
Production : `npm run build && npm start`, derrière HTTPS. Utilisez une base gérée avec sauvegardes automatiques (Neon, Supabase, Railway, etc.).

## Pas encore fait (à ne pas présenter comme prêt)
Valorisation du stock (coût), bons de commande et réceptions, demandes de matériel, quantités décimales, flotte, RH/paie, clients/fournisseurs, rapports PDF/Excel, notifications, saisie hors ligne, invitation d'employés et gestion des rôles dans l'interface, récupération de mot de passe, limitation des tentatives de connexion, surveillance des erreurs, sauvegardes et test de restauration. Taxes et paie RDC : à faire valider par un professionnel local avant toute affirmation de conformité.
