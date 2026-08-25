# Radar Piéton

PWA (Progressive Web App) qui détecte, via la caméra d'un smartphone et un modèle de vision embarqué, la présence d'une personne (piéton ou cycliste) approchant par l'arrière, et déclenche une alerte progressive (son, vibration, annonce vocale).

Aucune image n'est envoyée à un serveur : la détection tourne entièrement sur l'appareil.

## Contexte

Le projet visait initialement une détection par capteur radar/ultrason/LiDAR, sur le modèle des radars de recul pour cyclistes (type Garmin Varia). Plusieurs capteurs ont été évalués (HC-SR04, RCWL-0516, HLK-LD2410/LD2450, TF-Luna) sans offrir, à budget raisonnable, la portée et la directionnalité nécessaires. Le projet s'est réorienté vers une approche caméra + intelligence artificielle embarquée, plus accessible avec le matériel disponible (un smartphone).

## Fonctionnement général

1. La caméra (arrière du téléphone, ou externe à terme) filme en continu.
2. Chaque image est réduite puis analysée par [COCO-SSD](https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd) (variante légère `lite_mobilenet_v2`) via TensorFlow.js, qui détecte les silhouettes de la classe `person`.
3. La taille de la boîte englobante détectée, rapportée à la hauteur de l'image, sert de proxy de proximité. Sa variation dans le temps permet d'estimer une vitesse de rapprochement (approximation, pas une mesure réelle — voir [Modèle de distance](#modèle-de-distance-et-de-vitesse)).
4. Selon la proximité et la vitesse de rapprochement, l'application passe par plusieurs niveaux d'alerte : `SCAN` → `VIGILANCE` → `ALERTE`, avec vibration, bip sonore et annonce vocale ("Piéton" / "Vélo").
5. Au-delà d'un seuil de vitesse relative, l'application suppose qu'il s'agit d'un vélo plutôt que d'un piéton (une personne qui marche à la même allure que le porteur du téléphone a une vitesse de rapprochement quasi nulle).

## Fonctionnalités

- Détection de personnes en temps réel (piéton ou cycliste, tous angles), sur l'appareil, sans connexion réseau requise après le premier chargement.
- Estimation de proximité et de vitesse de rapprochement, avec hypothèse piéton/vélo.
- Alertes progressives : vibration, bip sonore, annonce vocale (synthèse vocale du navigateur — passe par la sortie audio active, écouteurs Bluetooth compris).
- Cadence de détection adaptative (ralentie en veille, accélérée dès qu'une personne est suivie) et caméra + détection coupées en arrière-plan, pour limiter l'échauffement et la consommation batterie.
- Mode "écran éteint" : masque l'aperçu caméra et n'affiche qu'un statut texte minimal, pour un usage à l'oreille plutôt qu'à l'œil.
- Réglages persistants (sensibilité, confiance de détection, son, vibration, mode écran éteint, objectif caméra choisi) via `localStorage`.
- Sélection de l'objectif caméra (avant/arrière, ou objectif spécifique si le téléphone en expose plusieurs) et contrôle de zoom expérimental.
- Popups d'aide contextuelle sur les réglages de sensibilité et de confiance.
- Installable comme application (PWA) via "Ajouter à l'écran d'accueil", avec mise à jour automatique (le service worker recharge la page dès qu'une nouvelle version est détectée).

## Stack technique

- HTML / CSS / JavaScript vanilla, aucune étape de build.
- [TensorFlow.js](https://www.tensorflow.org/js) + modèle [COCO-SSD](https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd) (`lite_mobilenet_v2`), chargés depuis un CDN (jsDelivr).
- Service worker pour le fonctionnement hors-ligne de l'interface (l'inférence IA nécessite le premier chargement des modèles CDN).
- `localStorage` pour la persistance des réglages.
- API Web utilisées : `getUserMedia`, `SpeechSynthesis`, `Vibration API`, `Wake Lock API`, `MediaDevices.enumerateDevices`.

## Structure du dépôt

```
index.html       Structure de la page, tiroir de réglages, popups d'aide
style.css         Thème visuel (HUD sombre façon radar)
app.js            Toute la logique : détection, alertes, caméra, réglages
manifest.json     Manifeste PWA (icônes, nom, couleurs)
sw.js             Service worker (cache applicatif, mise à jour automatique)
icons/            Icônes de l'application (192px, 512px)
```

## Déploiement

Le projet est pensé pour être servi statiquement (GitHub Pages, ou tout hébergeur statique HTTPS) :

1. Pousser le contenu du dépôt sur la branche `main`.
2. Activer GitHub Pages (Settings → Pages → branche `main`, dossier `/`).
3. Ouvrir l'URL générée sur un smartphone Android/Chrome.

**HTTPS est obligatoire** — `getUserMedia` (accès caméra) est refusé par le navigateur sur une origine non sécurisée (sauf `localhost` en développement local).

### Développement local

Servir le dossier avec n'importe quel serveur statique, par exemple :

```bash
npx serve .
```

Pour tester l'accès caméra en dehors de `localhost`, un certificat HTTPS (auto-signé ou via un tunnel type ngrok) est nécessaire.

## Réglages disponibles

| Réglage | Rôle | Par défaut |
|---|---|---|
| Seuil de vigilance | Taille (% de la hauteur d'image) qu'une personne doit atteindre pour déclencher la vigilance ; l'alerte se déclenche vers 1,5× ce seuil. Une vitesse de rapprochement élevée peut aussi déclencher ces niveaux plus tôt. | 24% |
| Confiance minimale de détection | Score de confiance minimal du modèle en dessous duquel une détection est ignorée. | 55% |
| Son | Active/désactive les bips et annonces vocales. | Activé |
| Vibration | Active/désactive les vibrations (si supportées par l'appareil). | Activé |
| Mode écran éteint | Masque l'aperçu caméra et les détections, n'affiche qu'un statut texte, pour économiser la batterie en usage audio seul. | Désactivé |
| Objectif de la caméra | Choix de l'objectif si le téléphone en expose plusieurs via `enumerateDevices` (souvent limité à avant/arrière selon les constructeurs). | Arrière |
| Zoom (test objectif ultra grand-angle) | Contrôle expérimental, visible uniquement si l'appareil expose un zoom < 1.0 sur la piste vidéo — permet de tenter d'atteindre un objectif ultra grand-angle physique sur les téléphones à caméras fusionnées. | — |

## Modèle de distance et de vitesse

Aucune mesure de distance réelle n'est effectuée. L'estimation repose sur un modèle sténopé simplifié :

```
distance_m ≈ ASSUMED_HEIGHT_M / (2 × tan(VFOV/2) × (hauteur_boîte / hauteur_image))
```

Avec, dans `app.js` :
- `ASSUMED_PERSON_HEIGHT_M = 1.65` — taille humaine moyenne supposée.
- `VERTICAL_FOV_DEG = 50` — champ de vision vertical supposé de la caméra (calibré pour la caméra arrière d'un smartphone classique).

La vitesse de rapprochement est dérivée de la variation de cette distance estimée sur une fenêtre glissante (~1,2s). Au-delà de `BIKE_SPEED_THRESHOLD_KMH = 5` km/h de rapprochement, l'application suppose un vélo plutôt qu'un piéton.

**⚠️ Cette constante `VERTICAL_FOV_DEG` doit être recalibrée pour toute caméra externe** (le champ de vision d'une caméra USB dédiée diffère de celui d'un smartphone).

### Protocole de calibration

1. Installer la caméra dans sa position/angle définitifs.
2. Mesurer une distance précise (mètre ruban) à laquelle se place une personne, dans l'axe de la caméra.
3. Relever la valeur affichée dans le HUD ("Proxim.", en %).
4. Calculer : `VFOV = 2 × atan( 1.65 / (2 × distance_mesurée_m × hauteur_boîte_%/100) )`
5. Répéter à plusieurs distances pour vérifier la cohérence (une forte divergence entre les valeurs obtenues indique une distorsion optique significative, fréquente en grand angle).

## Limitations connues

- **L'écran doit rester allumé et déverrouillé** pendant l'utilisation : Android (comme iOS) suspend l'exécution JavaScript et coupe l'accès caméra dès que l'écran s'éteint ou que l'application passe réellement en arrière-plan. Le Wake Lock empêche l'extinction automatique par inactivité, mais pas un verrouillage manuel.
- **Chrome pour Android ne supporte pas les webcams USB (UVC) via `getUserMedia`** — contrairement à Chrome desktop. L'utilisation d'une caméra externe nécessitera un passage en application native (ex. via Capacitor) ou un flux réseau (caméra IP / MJPEG).
- Sur certains téléphones (caméras arrière multiples fusionnées en une seule "caméra logique" par le constructeur, ex. Motorola), les objectifs physiques secondaires (ultra grand-angle, téléobjectif) ne sont pas accessibles individuellement depuis le navigateur.
- Les estimations de distance et de vitesse sont des approximations heuristiques, pas des mesures physiques certifiées — à calibrer et à interpréter avec cette réserve.
- La distinction piéton/vélo repose uniquement sur la vitesse de rapprochement relative : un piéton qui marche vers un porteur à l'arrêt peut être classé "vélo ?" à tort.

## Pistes en cours / à venir

- Intégration d'une caméra USB externe (UVC, focale fixe, ~90°) pour déporter la fonction caméra du téléphone.
- Passage à une application native (Capacitor) pour accéder à cette caméra externe, Chrome mobile ne le permettant pas nativement.
- Recalibration du modèle de distance une fois la caméra externe en service.

## Licence

Projet personnel — licence non définie à ce stade.
