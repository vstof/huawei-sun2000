# Huawei SUN2000 pour Gladys Assistant

Intégration externe qui supervise un onduleur solaire **Huawei SUN2000**
directement depuis votre réseau local, sans cloud.

## Ce que l'intégration fait

- Lit la **production** : puissance AC, puissance d'entrée DC, crête du jour,
  énergie du jour, énergie totale.
- Lit les **strings PV** (1 à 4) : tension et courant de chaque string.
- Lit le **réseau** : tensions (A-B / B-C / C-A), courants de phase, puissance
  réactive, facteur de puissance, fréquence.
- Lit l'état de l'onduleur : état (veille, démarrage, connecté, arrêté...),
  présence d'un **code d'anomalie**, température interne, rendement.
- Si un **compteur Smart Power Sensor (DTSU666)** est installé : puissance
  échangée avec le réseau (soutirée > 0, injectée < 0), énergies soutirée et
  injectée cumulées.
- **Commande marche / arrêt** de l'onduleur via un interrupteur, avec retour
  d'état dérivé du registre d'état.
- Actualise les valeurs toutes les minutes (intervalle configurable de 60 s à 1 h).

L'intégration est en **lecture seule à une exception près** : l'interrupteur
« Marche / Arrêt de l'onduleur ». Aucun autre réglage (codes réseau, bridage de
puissance, horaires...) n'est modifiable depuis Gladys — c'est volontaire, ces
registres sont du ressort de l'installateur.

### ⚠️ L'arrêt à distance peut être irréversible

L'écriture de la commande d'arrêt (registre 40201) est la même que celle de
l'intégration Home Assistant — mais soyez averti : sur **certains firmwares**
(constaté sur SUN2000-30KTL-M3, discussion wlcrs/huawei_solar #576), l'arrêt à
distance fonctionne mais la **remise en route à distance échoue ensuite**, même
depuis FusionSolar. La seule méthode fiable pour redémarrer est alors
l'application mobile **SUN2000**, connectée au **Wi-Fi direct de l'onduleur**.

En pratique : n'utilisez l'arrêt à distance que si vous savez redémarrer
l'onduleur physiquement à proximité (accès au Wi-Fi direct, compte
installateur). La commande de démarrage, elle, est sans effet sur un onduleur
déjà en service.

## Prérequis

1. **Activer le Modbus TCP** dans l'application FusionSolar (compte installateur
   ou propriétaire) : *Configuration de communication* → *Dongle / Onduleur* →
   activer le protocole **TCP/IP**, port **502**, adresse esclave **0**.
   Selon les versions d'application, ce réglage se trouve dans *Système →
   Paramètres de communication → Configuration réseau*.
2. **Raccorder le dongle à votre Wi-Fi** (le même réseau que Gladys) : dans
   FusionSolar, *Configuration de communication* → *Wi-Fi*, sélectionner votre
   réseau. Le dongle doit avoir une adresse IP fixe ou un bail DHCP stable.
3. **Connaître l'adresse IP** de l'onduleur (voir plus bas).

> Modèles concernés : SUN2000 avec dongle Smart (SDongleA-05) ou SmartLogger.
> Sur les modèles récents (M1, MG2, MAP0...), le port 502 est disponible dès
> que le protocole TCP/IP est activé. Certains firmwares de dongle répondent
> sur l'adresse esclave **1** au lieu de **0** : le champ existe dans la
> configuration pour ça.

### Cas particulier : le Wi-Fi intégré de l'onduleur (sans dongle)

Certains onduleurs plus anciens servent le Modbus TCP **directement**, par leur
module Wi-Fi intégré, sur le **port 6607** (port 502 sur des firmwares plus
anciens) — c'est d'ailleurs ce que l'application FusionSolar utilise. Trois
points dans ce cas :

1. L'accès doit être ouvert : dans FusionSolar (compte **installateur**,
   « Commissionnement de l'appareil »), *Réglages → Paramètres de connexion
   du routeur* → activer **« Local O&M » / « Maintenance locale »** (ce
   réglage est parfois capricieux : réessayez plusieurs fois).
2. Essayez l'**adresse esclave 0 puis 1** dans la configuration : selon le
   firmware, l'un ou l'autre répond.
3. L'onduleur n'accepte **qu'une seule connexion Modbus à la fois** :
   l'intégration garde une connexion persistante (comme l'intégration Home
   Assistant), mais débranchez tout autre outil qui lirait l'onduleur.

### Trouver l'adresse IP de l'onduleur

- Dans l'application **FusionSolar** : *Maintenance* → *Informations
  d'appareil* / *Journal de communication*, l'IP du dongle y figure.
- Dans l'interface de votre box/routeur : onglet appareils DHCP (cherchez un
  appareil « Huawei », « SUN2000 » ou sans nom connu).
- Par un scan du réseau : `nmap -sn 192.168.1.0/24`, puis `nmap -p 502` sur les
  suspects — l'onduleur est celui qui a le port 502 ouvert.

## Installation

L'intégration est un **conteneur Docker** installé par Gladys lui-même.

### Option 1 — Installer depuis GitHub (recommandée pour distribuer)

Gladys **lit le manifeste dans le dépôt**, puis télécharge l'image annoncée
par `docker_image` — construite et publiée automatiquement sur **ghcr.io** (le
registre de GitHub, pas Docker Hub) par le workflow `release.yml`, en
multi-architecture (amd64 + arm64 pour les Raspberry Pi).

Prérequis (une fois) : le workflow a tourné sur GitHub, et le package image
est passé en **public** (GitHub → votre profil → Packages → le package →
Package settings → **Change visibility → Public** — privé par défaut).

1. Allez dans **Intégrations** → bouton **« Installer une intégration »**.
2. Dépliez **Mode développeur** et choisissez l'onglet **GitHub**.
3. Collez l'URL du dépôt, puis cliquez sur **Installer** : Gladys télécharge
   l'image depuis ghcr.io.
4. Passez à l'étape « Configurer » plus bas.

### Option 2 — Construire l'image sur la machine Gladys (mode développeur, pas de registre)

Avec Node sur la machine :

```bash
git clone <ce-dépôt> huawei-sun2000 && cd huawei-sun2000
npm run build:image     # = docker build, avec le manifeste gravé dans l'image
```

Sans Node (Raspberry Pi par exemple), avec `jq` (`sudo apt install jq`) :

```bash
git clone <ce-dépôt> huawei-sun2000 && cd huawei-sun2000
docker build --label "io.gladysassistant.manifest=$(jq -c . gladys-assistant-integration.json)" \
  -t huawei-sun2000-gladys:1.3.0 .
```

> Le script `build:image` ajoute l'étiquette `io.gladysassistant.manifest` :
> c'est là que Gladys lit le manifeste pour une installation par nom d'image.
> Sans elle, l'installation échoue avec `MANIFEST_NOT_FOUND`.

### 2bis. Installer l'image construite dans Gladys

1. Allez dans **Intégrations** → bouton **« Installer une intégration »** (GitHub).
2. Dépliez le lien **Mode développeur**.
3. Collez le nom d'image : `huawei-sun2000-gladys:1.3.0`
   (le manifeste est lu automatiquement dans les étiquettes de l'image).
4. Cliquez sur **Installer**.

> Gladys doit avoir accès au socket Docker (`/var/run/docker.sock`), c'est le cas
> avec le `docker-compose.yml` officiel.

### Configurer

1. Saisissez l'**adresse IP** de l'onduleur. Port **502**, esclave **0** :
   les valeurs standard, à ne changer que sur instruction de votre installateur.
2. Cliquez sur **« Tester la connexion »** : le modèle, le numéro de série et
   la puissance nominale s'affichent si tout est correct.
3. Allez dans **Découverte**, créez l'appareil **« Onduleur Huawei SUN2000 »**,
   puis placez-le dans une pièce.

Les fonctionnalités absentes de votre installation (strings 3-4 sur un modèle
deux entrées, compteur réseau sans Smart Power Sensor, tensions B-C et C-A sur
un modèle monophasé) restent silencieuses : aucune valeur n'est fabriquée.

## Le tableau de bord énergie

Les fonctionnalités « Production du jour » et « Production totale » utilisent
la catégorie *capteur de production d'énergie* de Gladys : elles alimentent le
tableau de bord **Énergie → Production**. Les fonctionnalités du compteur
(énergie soutirée / injectée) utilisent la catégorie *capteur de réseau* :
elles alimentent le suivi **réseau** du même tableau de bord.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| « Tester la connexion » échoue en timeout | Protocole TCP/IP non activé dans FusionSolar, ou mauvaise IP. Wi-Fi intégré (sans dongle) : « Local O&M » pas activé, ou mauvaise adresse esclave (essayez 0 puis 1) |
| « Tester la connexion » échoue en connection refused | Le port 502 n'est pas ouvert : vérifiez l'activation du protocole |
| Connexion OK mais valeurs absentes | Mauvaise adresse esclave : essayez `1` dans la configuration |
| Le compteur réseau ne publie rien | Aucun Smart Power Sensor installé, ou son statut n'est pas « normal » |
| Les strings 3-4 n'apparaissent jamais | Votre modèle n'a que 2 entrées PV : normal |
| La commande marche/arrêt échoue : « l'onduleur a refusé la commande » | La plupart des firmwares récents exigent des **droits installateur** pour ces écritures (exception Modbus « illegal data address ») : passez par FusionSolar avec le compte installateur, ou activez la configuration « autoriser les commandes à distance » côté installateur |
| « Tester la connexion » ne répond plus le soir | L'onduleur est en veille sans irradiation : les registres restent lisibles, vérifiez plutôt le Wi-Fi du dongle |
| Plusieurs intégrations se disputent le port 502 | Le dongle ne sert qu'**un seul maître Modbus** : ne lisez pas les registres depuis deux outils à la fois |
## Notes

- Le dongle est un petit serveur embarqué : un intervalle de rafraîchissement
  **inférieur à la minute n'apporte rien** et fatigue la communication. Le
  défaut (60 s) convient à la grande majorité des usages.
- La connexion Modbus est **persistante** : une seule connexion TCP ouverte à
  la première lecture, conservée entre les cycles (fermée après 30 s
  d'inactivité, rétablie automatiquement). Certains firmwares — notamment le
  Wi-Fi intégré des onduleurs anciens (port 6607) — n'acceptent qu'une seule
  connexion et ignorent les clients qui se reconnectent à chaque trame.
  Après chaque connexion, le client **attend 1 seconde** avant la première
  trame : les modules Huawei avalent souvent la requête envoyée juste après
  le handshake TCP.
- Les énergies Huawei sont des compteurs en kWh (gain 100) : la production du
  jour repart à zéro à minuit heure locale de l'onduleur.
- La puissance réseau du compteur suit la convention Gladys
  (*soutiré > 0, injecté < 0*) : la valeur brute Huawei, de signe inverse, est
  inversée par l'intégration.
- L'état de l'onduleur est une **énumération** (Veille, Démarrage, Connecté au
  réseau, Puissance limitée, Hors réseau, Arrêté, Diagnostic...) : c'est ce que
  publie le registre 32089, il n'y a pas de valeur plus fine localement.
- L'interrupteur marche/arrêt suit le même schéma que l'intégration Home
  Assistant (wlcrs/huawei_solar) : heartbeat registre 49999 (valeur 1), puis
  valeur 0 écrite dans 40200 (startup) ou 40201 (shutdown) — les définitions
  Huawei précisent que la valeur des deux commandes est 0. L'état affiché est
  dérivé du registre 32089 : codes « Arrêté » → OFF, codes « Démarrage /
  Connecté » → ON ; en veille sans irradiation, rien n'est publié (l'état
  affiché ne change pas).
