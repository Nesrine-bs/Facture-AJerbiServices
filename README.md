# Factures — A Jerbi Services

Application web de facturation avec impression PDF et historique local. La connexion Supabase est préparée pour une phase ultérieure.

## Fonctionnement local

Double-cliquez sur **Lancer l'application.bat**. Sans configuration Supabase, l’application fonctionne en mode local et les factures restent dans le navigateur utilisé.

## Publier sur GitHub Pages

Le dépôt GitHub doit être **public** pour que votre ami ouvre le site. Le code et les coordonnées de l’entreprise y seront visibles publiquement. Le fichier de signature/cachet est exclu du dépôt et du site publié. Les factures saisies en mode local restent dans le stockage du navigateur de chaque utilisateur.

Le workflow `.github/workflows/pages.yml` publie automatiquement le site à chaque mise à jour de la branche principale. Après création du dépôt, choisissez **Settings → Pages → Source: GitHub Actions**. L’adresse sera du type `https://<nom-utilisateur>.github.io/<nom-du-dépôt>/`.

## Activer les factures partagées plus tard

Il faut un projet Supabase gratuit et un site HTTPS publié sur Netlify (ou un hébergeur équivalent). Le dépôt ne contient aucun secret d’administration.

1. Créez un projet sur [Supabase](https://supabase.com/dashboard). Gardez le projet dans l’offre gratuite.
2. Dans le SQL Editor de Supabase, exécutez une fois le fichier `supabase-schema.sql`.
3. Dans Authentication → Users, créez les comptes du propriétaire et de son ami. Désactivez les inscriptions publiques. Les politiques SQL limitent l’accès aux personnes inscrites dans `app_members`.
4. Dans le SQL Editor, récupérez les identifiants des comptes :

   ```sql
   select id, email from auth.users;
   ```

   Ajoutez uniquement les deux utilisateurs autorisés en remplaçant les adresses :

   ```sql
   insert into public.app_members (user_id, email)
   select id, email from auth.users
   where email in ('proprietaire@exemple.com', 'ami@exemple.com')
   on conflict (user_id) do nothing;
   ```

5. Dans Project Settings → API Keys, copiez le **Project URL** et la clé **publishable** (ou l’ancienne clé `anon`). Collez-les dans `app-config.js`. N’utilisez jamais la clé `service_role` ou une clé secrète dans ce fichier.
6. Publiez le dossier de l’application sur [Netlify Drop](https://app.netlify.com/drop) depuis votre compte Netlify. Choisissez un nom de site disponible, par exemple `ajerbi-factures`. Le lien public sera du type `https://ajerbi-factures.netlify.app`, sans référence à ChatGPT.
7. Connectez-vous au site avec le compte du propriétaire et celui de l’ami. Les factures et paramètres sont partagés ; les créations, modifications et suppressions se répercutent en direct.

Les numéros sont attribués par une fonction SQL atomique, même si les deux utilisateurs créent une facture au même moment. Les suppressions sont partagées. Les modifications mettent à jour l’enregistrement existant.

## Limites de l’offre gratuite

Supabase met en pause les projets gratuits après une semaine d’inactivité. Netlify Free inclut actuellement 300 crédits par mois et suspend les déploiements qui atteignent leur limite. Consultez leurs tarifs avant un usage professionnel régulier : [Supabase](https://supabase.com/pricing), [Netlify](https://www.netlify.com/pricing/).

## Facturation

Le modèle initial indique une TVA de 19 %, un timbre fiscal de 1 DT, l’IU `1922720N`, l’adresse de l’entreprise à La Marsa et le numéro d’exemple 15. La prochaine facture commence au numéro 16. Les montants TTC apparaissent aussi en lettres. Le cachet et la signature sont inclus uniquement si la case correspondante est cochée.
