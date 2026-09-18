# Radar Piéton

PWA (Progressive Web App) qui détecte, via la caméra d'un smartphone (ou d'une caméra USB externe), la présence d'une personne approchant par l'arrière, et déclenche une alerte progressive (son, vibration, annonce vocale).

Aucune image n'est envoyée à un serveur ni enregistrée : la détection tourne entièrement sur l'appareil, en temps réel, et chaque image est jetée aussitôt analysée.

## Contexte

Le projet visait initialement une détection par capteur radar/ultrason/LiDAR, sur le modèle des radars de recul pour cyclistes (type Garmin Varia). Plusieurs capteurs ont été évalués (RCWL-0516, HLK-LD2410/LD2450) sans offrir, à budget raisonnable, la portée et la directionnalité nécessaires. Le projet s'est réorienté vers une approche caméra + intelligence artificielle embarquée, plus accessible avec le matériel disponible.

## Principe de fonctionnement

### 1. Détection

Chaque image de la caméra est réduite (~300px) puis analysée par [COCO-SSD](https://github.com/tensorflow/tfjs-models/tree/master/coco-ssd) (variante légère `lite_mobilenet_v2`) via TensorFlow.js, qui repère toutes les silhouettes de la classe `person` avec un score de confiance. Le modèle ne fait aucune distinction piéton/cycliste — une personne à pied et une personne à vélo sont détectées de la même façon (le vélo lui-même, vu de face ou de trois-quarts, n'est presque jamais reconnu comme tel par le modèle — c'est la personne qui compte).

### 2. Suivi (volontairement simple)

Le modèle ne fournit aucune notion d'identité d'une image à l'autre — c'est notre code qui reconstitue un suivi minimal :
- À chaque image, la **plus grande boîte détectée** est choisie comme cible suivie.
- Un **garde-fou anti-saut d'identité** compare la nouvelle position/taille à la précédente : si l'écart est trop brutal pour être un mouvement réel à cette cadence (ex. la cible suivie bascule d'une personne à une autre dans un groupe), le suivi redémarre à zéro plutôt que d'interpréter ce saut comme un déplacement.

Ce n'est pas un vrai traqueur multi-objets (type SORT/DeepSORT) — une seule personne est suivie à la fois, les autres restent affichées mais ignorées pour le calcul d'alerte.

### 3. Logique de déclenchement

Le principe central : **une silhouette doit grossir suffisamment vite dans l'image pour déclencher quoi que ce soit** — sa taille seule ne suffit pas.

- La hauteur de la boîte, en % de la hauteur de l'image, est mesurée à chaque image (`Proxim.`).
- Sa variation dans le temps donne une **vitesse de grossissement** (%/seconde).
- Cette vitesse doit dépasser un seuil minimal réglable (voir "Rapidité de grossissement minimum" plus bas) **avant** qu'un niveau d'alerte puisse se déclencher — en dessous, même une silhouette de grande taille reste ignorée.
- Une fois ce seuil de vitesse franchi, la taille déjà atteinte décide seulement du niveau d'urgence : `VIGILANCE` ou `ALERTE`.
- Le niveau atteint ne redescend plus tant que la personne ne s'éloigne pas clairement (rétrécissement net de sa boîte) ou ne disparaît pas du champ — pour éviter les coupures de signal en plein milieu d'une approche rapide.
- Une personne déjà proche mais qui s'éloigne (ex. un piéton croisé) ne déclenche jamais rien sur ce seul critère de taille.

### 4. Un mot sur la courbe de grossissement

La taille apparente d'une personne suit une relation en **1/distance** (projection sténopé classique), pas linéaire. Pour une vitesse de rapprochement réelle constante, la **vitesse de grossissement apparente croît avec le carré de la proximité** — elle reste faible tant que la personne est loin, puis s'accélère brusquement dans les derniers mètres. C'est pour cette raison que le système réagit plus tard, en distance parcourue, face à un vélo rapide que face à un piéton lent, à réglage de sensibilité égal.

### 5. Alertes

- **Vibration + bip sonore** dès le niveau `VIGILANCE`, plus rapprochés et plus insistants en `ALERTE`.
- **Annonce vocale** ("Attention", via la synthèse vocale du navigateur) à l'entrée en vigilance/alerte, répétée toutes les 2,5s tant que l'alerte persiste. Le son sort par la sortie audio active du téléphone — écouteurs Bluetooth compris.
- **Signal de simple présence** (optionnel, voir réglages) : un carillon doux, une seule fois par personne détectée, même sans approche — pensé pour un usage en environnement peu fréquenté.

### 6. Compensation automatique pour objectif grand-angle

Un objectif grand-angle fait paraître une personne plus petite, à distance égale, qu'un objectif standard — donc grossir plus lentement en apparence. L'appli détecte automatiquement un objectif grand-angle (via des mots-clés dans son nom système, ex. `external`, `wide`) et réduit en conséquence le seuil de vitesse de grossissement appliqué, pour déclencher les alertes à une distance réelle cohérente quel que soit l'objectif utilisé.

## Matériel recommandé

**L'usage d'une caméra USB externe est fortement recommandé** par rapport à la caméra intégrée du téléphone, pour plusieurs raisons validées en test :

- **Portage plus pratique** : la caméra peut être fixée sur une pochette dorsale, orientée précisément vers l'arrière, indépendamment de la position du téléphone lui-même (qui peut rester en poche, à plat, sans contrainte d'angle).
- **Champ de vision généralement plus large** (~90° sur les modèles courants), pour une détection plus précoce sur les côtés — avec compensation automatique du seuil de grossissement (voir plus haut).
- **Consommation comparable, parfois inférieure** à celle de la caméra intégrée du téléphone, d'après des tests comparatifs sur une heure d'usage continu (caméra externe UVC bon marché : ~90mA, part mineure de la consommation totale de l'application).
- **Fonctionne nativement** avec cette PWA, sans code ni configuration particulière : une caméra USB UVC reconnue par Android (branchée via un adaptateur OTG USB-C) apparaît directement dans le sélecteur d'objectif du navigateur.

**Recommandations pour le choix du module** : focale fixe (pas de zoom variable), connecteur UVC standard, champ de vision autour de 90° (au-delà, la distorsion optique en périphérie de cadre dégrade la fiabilité de détection sur les bords), résolution modeste suffisante (1280×720 est largement assez, l'image est de toute façon réduite avant analyse).

## Installation

1. Servir le contenu du dépôt en HTTPS (GitHub Pages, ou tout hébergeur statique) — **obligatoire**, `getUserMedia` (accès caméra) est refusé par le navigateur sur une origine non sécurisée.
2. Ouvrir l'URL sur un smartphone Android/Chrome.
3. "Ajouter à l'écran d'accueil" pour une installation façon application (icône dédiée, plein écran).
4. Brancher la caméra externe (adaptateur OTG) avant de démarrer, si utilisée.

## Utilisation et réglages

Au premier lancement, appuyer sur **"Démarrer la caméra"** et accorder la permission demandée. Le bandeau du bas affiche en direct l'objet détecté et sa proximité estimée ; la pastille en haut indique l'état global (`SCAN — RAS` / `PERSONNE DÉTECTÉE` / `VIGILANCE` / `ALERTE`).

Tous les réglages sont accessibles via l'icône ⚙, et sont sauvegardés automatiquement d'une session à l'autre :

| Réglage | Rôle | Par défaut |
|---|---|---|
| **Son** | Active/désactive les bips et annonces vocales. | Activé |
| **Vibration** | Active/désactive les vibrations (si le téléphone le permet). | Activé |
| **Mode écran éteint** | Masque l'aperçu caméra et les détections à l'écran, pour économiser la batterie (utile en usage à l'oreille). L'écran doit tout de même rester déverrouillé — voir limitations. | Activé |
| **Effet miroir** | Inverse l'affichage horizontalement, façon rétroviseur. N'affecte que l'aperçu visuel, jamais la détection. | Activé |
| **Notifier toute présence** | Ajoute un signal doux, une fois par personne détectée, même sans approche — pour un usage en environnement peu fréquenté. | Désactivé |
| **Seuil de vigilance** | Taille (% de la hauteur d'image) qu'une personne doit atteindre, une fois le seuil de vitesse franchi, pour passer en `ALERTE` plutôt qu'en simple `VIGILANCE`. | 24% |
| **Confiance minimale de détection** | Score de confiance minimal du modèle en dessous duquel une détection est ignorée (filtre les faux positifs de type ombres, buissons). | 55% |
| **Rapidité de grossissement minimum** | Curseur à 5 paliers (1 = 4%/s à 5 = 20%/s) : vitesse de grossissement minimale exigée avant toute notification. Palier bas → alertes plus fréquentes, y compris sur des approches lentes ; palier haut → seules les approches franches déclenchent quelque chose. | Palier 3 (12%/s) |
| **Objectif de la caméra** | Apparaît automatiquement si plusieurs caméras sont détectées (avant/arrière/externe) — choix explicite de la source vidéo. | Caméra arrière |

Chaque réglage numérique dispose d'un petit bouton d'aide (ⓘ) rappelant son fonctionnement exact directement dans l'appli.

## Limitations connues

- **L'écran doit rester allumé et déverrouillé** pendant l'utilisation : Android (comme iOS) suspend l'exécution JavaScript et coupe l'accès caméra dès que l'écran s'éteint ou que l'application passe réellement en arrière-plan. Un dispositif anti-veille (Wake Lock) empêche l'extinction automatique par inactivité, mais pas un verrouillage manuel.
- Le suivi reste basique (une seule cible à la fois, pas de vrai traqueur multi-objets) — dans un environnement à plusieurs personnes de taille comparable, le garde-fou anti-saut limite les faux positifs sans garantir un suivi individuel parfait.
- Les estimations de proximité restent relatives (% de l'image), pas une mesure de distance physique — le projet a volontairement abandonné la conversion en distance/vitesse réelle (trop dépendante d'hypothèses de calibration fragiles) au profit d'un critère plus robuste : la vitesse de grossissement seule.
- La distinction piéton/vélo a été retirée : l'appli signale toute personne qui approche suffisamment vite, sans tenter de deviner son mode de déplacement.

## Cadre d'usage

L'application n'enregistre ni ne transmet aucune image — chaque frame est traitée en mémoire puis immédiatement jetée. Pour un usage strictement personnel (pas de diffusion, pas de finalité commerciale), ce type de traitement relève de l'exception domestique du RGPD (article 2.2.c), sur le même principe que les dashcams de véhicule. Cette note est informative, pas une consultation juridique.

## Structure du dépôt

```
index.html       Structure de la page, tiroir de réglages, popups d'aide
style.css         Thème visuel (HUD sombre façon radar)
app.js            Toute la logique : détection, suivi, alertes, caméra, réglages
manifest.json     Manifeste PWA (icônes, nom, couleurs)
sw.js             Service worker (fonctionnement hors-ligne, mise à jour automatique)
icons/            Icônes de l'application (192px, 512px)
```

## Licence

Projet personnel — licence non définie à ce stade.
