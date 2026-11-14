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

📖 Documentation utilisateur : [`docs/fr.md`](docs/fr.md) (FR)

## Développement

```bash
npm install
npm test        # node --test (aucun accès réseau dans les tests)
```

Architecture :

```
index.js                          câblage du SDK (handlers enregistrés avant connect())
src/config.js                     DEFAULT_CONFIG + normalisation de la config
src/modbus.js                     client Modbus TCP minimal (node:net, zéro dépendance)
src/devices/index.js              registre des appareils + dispatcheur de poll
src/devices/inverter.js           l'appareil onduleur (découverte, lecture des blocs, états, commandes)
gladys-assistant-integration.json manifeste (config, action, image, version)
test/                             tests node --test
docs/                             documentation utilisateur (hébergée par Gladys)
```

## Construire et installer

```bash
npm run build:image     # docker build + étiquette io.gladysassistant.manifest
# variante : node scripts/build.js <image:tag>
```

> Ce script est nécessaire : Gladys lit le manifeste **dans l'étiquette de
> l'image** lors d'une installation par nom d'image. Un simple `docker build`
> donnerait `MANIFEST_NOT_FOUND`.

Puis dans Gladys : **Intégrations → Installer une intégration → Mode développeur →
image Docker** `huawei-sun2000-gladys:1.1.0`. Détails dans [`docs/fr.md`](docs/fr.md).

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
