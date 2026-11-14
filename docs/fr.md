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
- Actualise les valeurs toutes les minutes (intervalle configurable de 60 s à 1 h).

L'intégration est en **lecture seule** : aucun réglage de l'onduleur (codes
réseau, bridage de puissance, redémarrage) n'est modifiable depuis Gladys —
c'est volontaire, ces registres sont du ressort de l'installateur.

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

### Trouver l'adresse IP de l'onduleur

- Dans l'application **FusionSolar** : *Maintenance* → *Informations
  d'appareil* / *Journal de communication*, l'IP du dongle y figure.
- Dans l'interface de votre box/routeur : onglet appareils DHCP (cherchez un
  appareil « Huawei », « SUN2000 » ou sans nom connu).
- Par un scan du réseau : `nmap -sn 192.168.1.0/24`, puis `nmap -p 502` sur les
  suspects — l'onduleur est celui qui a le port 502 ouvert.

## Installation

L'intégration est un **conteneur Docker** installé par Gladys lui-même.

### 1. Construire l'image (sur la machine qui fait tourner Gladys)

```bash
git clone <ce-dépôt> huawei-sun2000 && cd huawei-sun2000
npm run build:image     # = docker build, avec le manifeste gravé dans l'image
```

> Le script `build:image` ajoute l'étiquette `io.gladysassistant.manifest` :
> c'est là que Gladys lit le manifeste pour une installation par nom d'image.
> Sans elle, l'installation échoue avec `MANIFEST_NOT_FOUND`.

### 2. L'installer dans Gladys

1. Allez dans **Intégrations** → bouton **« Installer une intégration »** (GitHub).
2. Dépliez le lien **Mode développeur**.
3. Collez le nom d'image : `huawei-sun2000-gladys:1.0.0`
   (le manifeste est lu automatiquement dans les étiquettes de l'image).
4. Cliquez sur **Installer**.

> Gladys doit avoir accès au socket Docker (`/var/run/docker.sock`), c'est le cas
> avec le `docker-compose.yml` officiel.

### 3. Configurer

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
| « Tester la connexion » échoue en timeout | Protocole TCP/IP non activé dans FusionSolar, ou mauvaise IP |
| « Tester la connexion » échoue en connection refused | Le port 502 n'est pas ouvert : vérifiez l'activation du protocole |
| Connexion OK mais valeurs absentes | Mauvaise adresse esclave : essayez `1` dans la configuration |
| Le compteur réseau ne publie rien | Aucun Smart Power Sensor installé, ou son statut n'est pas « normal » |
| Les strings 3-4 n'apparaissent jamais | Votre modèle n'a que 2 entrées PV : normal |
| « Tester la connexion » ne répond plus le soir | L'onduleur est en veille sans irradiation : les registres restent lisibles, vérifiez plutôt le Wi-Fi du dongle |
| Plusieurs intégrations se disputent le port 502 | Le dongle ne sert qu'**un seul maître Modbus** : ne lisez pas les registres depuis deux outils à la fois |

## Notes

- Le dongle est un petit serveur embarqué : un intervalle de rafraîchissement
  **inférieur à la minute n'apporte rien** et fatigue la communication. Le
  défaut (60 s) convient à la grande majorité des usages.
- Les énergies Huawei sont des compteurs en kWh (gain 100) : la production du
  jour repart à zéro à minuit heure locale de l'onduleur.
- La puissance réseau du compteur suit la convention Gladys
  (*soutiré > 0, injecté < 0*) : la valeur brute Huawei, de signe inverse, est
  inversée par l'intégration.
- L'état de l'onduleur est une **énumération** (Veille, Démarrage, Connecté au
  réseau, Puissance limitée, Hors réseau, Arrêté, Diagnostic...) : c'est ce que
  publie le registre 32089, il n'y a pas de valeur plus fine localement.
