# Gladys Huawei SUN2000

Intégration externe **Gladys Assistant** pour les onduleurs solaires **Huawei
SUN2000**, supervisés en local via leur interface **Modbus TCP** (dongle Wi-Fi /
Smart Dongle, port 502).

- Lecture : puissance AC, puissance DC, crête du jour, énergies (jour, totale),
  tensions/courants des strings PV, tensions réseau, courants de phase,
  puissance réactive, facteur de puissance, fréquence, rendement, température
  interne, état de l'onduleur, code d'anomalie.
- Lecture du **compteur Smart Power Sensor** (DTSU666) quand il est installé :
  puissance réseau (soutirée/injectée), énergies soutirée et injectée.
- **Commande marche / arrêt** de l'onduleur (interrupteur `running`) : même
  séquence que l'intégration Home Assistant — heartbeat registre 49999 (valeur
  1) puis commande startup 40200 ou shutdown 40201 (valeur 0). L'état affiché
  est dérivé du registre d'état 32089. ⚠️ Voir l'avertissement dans
  [`docs/fr.md`](docs/fr.md) : sur certains firmwares, l'arrêt à distance peut
  être irréversible sans l'application SUN2000.
- Aucun autre registre de réglage (codes réseau, bridage de puissance) n'est
  écrit — c'est le domaine de l'installateur.
- Aucun cloud Huawei/FusionSolar : tout passe par le réseau local.
- **Trois widgets de tableau de bord** : aperçu temps réel (puissance AC
  vivante, jauge vs nominale, entrée DC, température, 7 derniers jours,
  état + réseau, boutons démarrer/arrêt), production dans un **seul widget
  à onglets** (Jour heure par heure / Mois jour par jour + mois de
  l'année précédente / Année mois par mois + année précédente), et
  **rangées PV** (tuiles vivantes par string + énergie estimée par rangée,
  7 jours).
- **Statistiques jour / mois / année (+ détail horaire)** cumulées
  localement sous `/data` (les jours non observés ne sont pas inventés).

📖 Documentation utilisateur : [`docs/fr.md`](docs/fr.md) (FR) ·
[`docs/en.md`](docs/en.md) (EN)

## Développement

```bash
npm install
npm test        # node --test (aucun accès réseau dans les tests) — 92 tests
```

Architecture :

```
index.js                          câblage du SDK (handlers enregistrés avant connect())
src/config.js                     DEFAULT_CONFIG + normalisation de la config
src/modbus.js                     client Modbus TCP minimal (node:net, zéro dépendance)
src/i18n.js                       chaînes utilisateur (device/mesures stockées en anglais)
src/stats.js                      cumuls jour/mois/année persistés sous /data
src/widgets.js                    les 3 widgets du tableau de bord (aperçu, production, rangées)
src/devices/index.js              registre des appareils + dispatcheur de poll
src/devices/inverter.js           l'appareil onduleur (découverte, lecture des blocs, états, commandes)
gladys-assistant-integration.json manifeste (config, action, widgets, image, version)
test/                             tests node --test
docs/                             documentation utilisateur (hébergée par Gladys)
```

## Installation des utilisateurs

Deux voies : **depuis GitHub** (recommandée, rien à construire) ou **par nom
d'image** (mode développeur classique).

### Option 1 — Installer depuis GitHub (recommandée pour distribuer)

Gladys **lit le manifeste dans le dépôt**, puis télécharge l'image annoncée
par `docker_image` — construite et publiée automatiquement sur **ghcr.io** (le
registre de GitHub, pas Docker Hub) par le workflow `release.yml`, en
multi-architecture (amd64 + arm64 pour les Raspberry Pi).

Prérequis (une fois) : le workflow a tourné sur GitHub, et le package image
est passé en **public** (GitHub → votre profil → Packages → le package →
Package settings → **Change visibility → Public** — par défaut il est privé).

1. Allez dans **Intégrations** → bouton **« Installer une intégration »**.
2. Dépliez **Mode développeur** et choisissez l'onglet **GitHub**.
3. Collez l'URL du dépôt, puis cliquez sur **Installer** : Gladys télécharge
   l'image depuis ghcr.io.
4. Configurez : voir la section « Configurer » de
   [`docs/fr.md`](docs/fr.md).

### Option 2 — Construire l'image sur la machine Gladys (mode développeur, pas de registre)

À la main, sur la machine qui fait tourner Gladys :

```bash
git clone <ce-dépôt> huawei-sun2000 && cd huawei-sun2000
npm run build:image     # docker build + étiquette io.gladysassistant.manifest
# variante : node scripts/build.js <image:tag>
```

> Ce script est nécessaire : Gladys lit le manifeste **dans l'étiquette de
> l'image** lors d'une installation par nom d'image. Un simple `docker build`
> donnerait `MANIFEST_NOT_FOUND`.

Puis dans Gladys : **Intégrations → Installer une intégration → Mode développeur →
image Docker** `huawei-sun2000-gladys:1.8.0`. Détails dans [`docs/fr.md`](docs/fr.md).

## Publier le dépôt GitHub (mainteneur)

L'intégration est conçue pour être publiée comme **dépôt autonome** (le
manifeste doit être à la racine du dépôt par défaut) :

```bash
cd huawei-sun2000
git init && git add -A && git commit -m "Huawei SUN2000 integration 1.8.0"
git remote add origin git@github.com:<votre-compte>/gladys-huawei-sun2000.git
git push -u origin main        # ou master, selon la branche créée
```

Puis sur GitHub : **Settings → General → Topics** → ajouter
`gladys-assistant-integration` (c'est ainsi que le dépôt est reconnu comme
intégration). Vérifier enfin que le validateur du store passe :

```bash
npx --allow-git=all github:GladysAssistant/integration-store --skip-image-check .
```

### Publier l'image sur ghcr.io (nécessaire pour l'installation par URL GitHub)

L'installation par URL GitHub ne lit que le **manifeste** dans le dépôt :
l'image annoncée par `docker_image` doit être **pullable anonymement**. Le
workflow `release.yml` construit l'image (amd64 + arm64) et la publie
automatiquement sur ghcr.io à chaque push :

1. Après le premier push, vérifier l'onglet **Actions** : le workflow
   « Release image » doit être vert.
2. Rendre l'image **publique** : GitHub → profil → **Packages** → le package
   → **Package settings** → **Change visibility → Public** (privé par défaut,
   et une image privée est refusée au pull anonyme).
3. Mettre à jour `docker_image` dans `gladys-assistant-integration.json` :
   ```json
   "docker_image": "ghcr.io/<votre-compte>/gladys-huawei-sun2000:1.8.0"
   ```
   puis commit + push (les tests vérifient la cohérence version/manifeste, le
   workflow republie l'image au même tag).

À chaque nouvelle version : bump de `package.json` + `docker_image` dans le
manifeste, commit, push — le workflow republie l'image, et les utilisateurs
installant par URL GitHub la récupèrent.

## Registres utilisés

D'après les « Solar Inverter Modbus Interface Definitions » de Huawei (dongle
Smart / SmartLogger, registres de maintien, FC 03) :

| Bloc | Registres | Contenu |
|---|---|---|
| identité | 30000..30074 | modèle, numéro de série, puissance nominale |
| strings | 32016..32023 | tensions / courants PV 1-4 |
| puissance | 32064..32090 | puissance DC, tensions réseau, courants, puissance AC, réactive, FP, fréquence, rendement, température, état, défaut |
| énergie | 32106..32115 | énergie totale (32106), énergie du jour (32114) |
| compteur | 37100..37125 | puissance réseau signée, énergies injectée / soutirée |
| commandes | 40200, 40201 | startup / shutdown (écriture seule, valeur 0), FC 06 |
| heartbeat | 49999 | registre « magique » écrit (valeur 1) avant chaque commande, il renouvelle la session d'écriture |

Les blocs sont lus indépendamment : un bloc refusé par le firmware (modèle
monophasé, pas de compteur, registres absents) ne publie simplement pas ses
valeurs. Les blocs « identité » et « puissance » doivent tous deux répondre :
c'est eux qui qualifient l'onduleur comme joignable ou non.

## Licence

Apache-2.0. Gladys Assistant est également sous licence Apache-2.0.

## Validation du manifeste

Le contrôleur officiel du store Gladys vérifie le manifeste :

```bash
npx github:GladysAssistant/integration-store --skip-image-check .
```

`--skip-image-check` est attendu ici : il ne s'agit **pas** d'une intégration
publiée sur le store, l'image est construite localement et installée par son
nom (c'est le mode « développeur » de Gladys). Sans ce drapeau, le contrôle
d'accessibilité publique de l'image est le seul échec signalé.
