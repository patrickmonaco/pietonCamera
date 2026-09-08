// Radar Piéton — prototype de détection de présence humaine par caméra (COCO-SSD)
//
// v4 :
//  - annonce vocale ("Piéton" / "Vélo") via SpeechSynthesis, qui sort par la
//    sortie audio active du téléphone (écouteurs Bluetooth compris), en plus
//    du bip et de la vibration — utile puisque l'écran n'est pas regardé ;
//  - seuils abaissés (taille, vitesse de grossissement, ET vitesse de
//    rapprochement estimée) pour alerter plus tôt ;
//  - démarrage caméra plus robuste (attente des métadonnées vidéo + nouvel
//    essai automatique) pour limiter le bug d'écran noir après une reprise
//    depuis l'arrière-plan ;
//  - icône de statut (pastille à côté du nom de l'appli) non animée quand le
//    scan est en pause, animée quand il tourne.
//
// Rappel : pas de mesure de distance réelle au sens strict — tout est estimé
// à partir de l'image (taille de la personne, vitesse de grossissement). À
// calibrer sur le terrain.

(() => {
  "use strict";

  const APP_VERSION = "2.1";

  // ---------- éléments DOM ----------
  const video = document.getElementById("video");
  const overlay = document.getElementById("overlay");
  const nativePreviewCanvas = document.getElementById("nativePreviewCanvas");
  const nativePreviewCtx = nativePreviewCanvas.getContext("2d");
  const ctx = overlay.getContext("2d");
  const viewport = document.getElementById("viewport");
  const gate = document.getElementById("gate");
  const gateError = document.getElementById("gateError");
  const startBtn = document.getElementById("startBtn");
  const statePill = document.getElementById("statePill");
  const miniBlip = document.getElementById("miniBlip");
  const brandDot = document.getElementById("brandDot");

  const metricObject = document.getElementById("metricObject");
  const metricProx = document.getElementById("metricProx");

  const soundToggle = document.getElementById("soundToggle");
  const vibToggle = document.getElementById("vibToggle");
  const darkModeToggle = document.getElementById("darkModeToggle");
  const mirrorToggle = document.getElementById("mirrorToggle");
  const darkStatus = document.getElementById("darkStatus");
  const cameraSelectRow = document.getElementById("cameraSelectRow");
  const cameraSelect = document.getElementById("cameraSelect");
  const zoomRow = document.getElementById("zoomRow");
  const zoomSlider = document.getElementById("zoomSlider");
  const zoomValue = document.getElementById("zoomValue");
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsDrawer = document.getElementById("settingsDrawer");
  const closeSettings = document.getElementById("closeSettings");
  const appVersionEl = document.getElementById("appVersion");
  appVersionEl.textContent = "v" + APP_VERSION;

  const sensSlider = document.getElementById("sensSlider");
  const sensValue = document.getElementById("sensValue");
  const confSlider = document.getElementById("confSlider");
  const confValue = document.getElementById("confValue");
  const growthSlider = document.getElementById("growthSlider");
  const growthValue = document.getElementById("growthValue");

  const helpOverlay = document.getElementById("helpOverlay");
  const helpTitle = document.getElementById("helpTitle");
  const helpText = document.getElementById("helpText");
  const helpClose = document.getElementById("helpClose");

  // ---------- canvas de détection hors-écran (basse résolution) ----------
  const detectCanvas = document.createElement("canvas");
  const detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });
  const DETECT_MAX_DIM = 300;
  let dW = DETECT_MAX_DIM, dH = DETECT_MAX_DIM;

  // ---------- état ----------
  let model = null;
  let stream = null;
  let currentFacing = "environment";
  let soundOn = true;
  let vibOn = "vibrate" in navigator;
  if (!vibOn) vibToggle.disabled = true;
  let darkMode = true;
  let mirrorEffect = true; // effet miroir "rétroviseur" pour la caméra arrière/externe
  viewport.classList.toggle("dark-active", darkMode); // applique le défaut dès le démarrage
  const LEVEL_RANK = { scan: 0, detecte: 1, vigilance: 2, alerte: 3 };
  let peakLevelThisTrack = "scan"; // le niveau ne redescend plus tant que l'objet ne s'éloigne pas clairement
  let selectedDeviceId = null; // objectif précis choisi (dépasse le simple facingMode)
  const speechEnabled = "speechSynthesis" in window;
  // sur Android natif (Capacitor), la WebView système ne supporte pas
  // fiablement SpeechSynthesis — on utilise le plugin natif TextToSpeech
  // s'il est présent (voir vendor/capacitor-tts.js), sinon l'API navigateur
  // vérifié à chaque appel plutôt qu'une seule fois au chargement : le pont
  // Capacitor peut finir son initialisation après ce point du script
  function getNativeTTS() {
    return window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()
      && window.Capacitor.Plugins && window.Capacitor.Plugins.TextToSpeech;
  }

  let detectTimer = null;
  let alertTimer = null;
  let wakeLock = null;
  let isRunning = false;
  let isPaused = false;

  let history = []; // {t, h, cx, d}
  let lastSeen = 0;
  let currentLevel = "scan"; // scan | detecte | vigilance | alerte
  let currentIntervalMs = 0;

  let lastSpokenLabel = null;
  let lastAnnounceTime = 0;
  const ALERT_REPEAT_MS = 2500; // ré-annonce vocale toutes les 2,5s tant que l'alerte persiste

  let sensitivity = Number(sensSlider.value);
  let minConfidence = Number(confSlider.value) / 100;
  let growthSensitivityLevel = 3; // palier 1-5, voir GROWTH_RATE_TABLE

  // ---------- persistance des réglages (localStorage) ----------
  const SETTINGS_KEY = "radarPieton.settings";

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        sensitivity, minConfidence, growthSensitivityLevel, soundOn, vibOn, darkMode, mirrorEffect, selectedDeviceId
      }));
    } catch (e) { /* stockage indisponible, on ignore */ }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.sensitivity === "number") {
        sensitivity = s.sensitivity;
        sensSlider.value = sensitivity;
        sensValue.textContent = sensitivity + "%";
      }
      if (typeof s.minConfidence === "number") {
        minConfidence = s.minConfidence;
        confSlider.value = Math.round(minConfidence * 100);
        confValue.textContent = confSlider.value + "%";
      }
      if (typeof s.growthSensitivityLevel === "number") {
        growthSensitivityLevel = s.growthSensitivityLevel;
        growthSlider.value = growthSensitivityLevel;
        growthValue.textContent = "Palier " + growthSensitivityLevel;
      }
      if (typeof s.soundOn === "boolean") {
        soundOn = s.soundOn;
        soundToggle.checked = soundOn;
      }
      if (typeof s.vibOn === "boolean" && "vibrate" in navigator) {
        vibOn = s.vibOn;
        vibToggle.checked = vibOn;
      }
      if (typeof s.darkMode === "boolean") {
        darkMode = s.darkMode;
        darkModeToggle.checked = darkMode;
        viewport.classList.toggle("dark-active", darkMode);
      }
      if (typeof s.mirrorEffect === "boolean") {
        mirrorEffect = s.mirrorEffect;
        mirrorToggle.checked = mirrorEffect;
        updateMirrorState();
      }
      if (typeof s.selectedDeviceId === "string") {
        selectedDeviceId = s.selectedDeviceId;
      }
    } catch (e) { /* réglages sauvegardés illisibles, on garde les valeurs par défaut */ }
  }

  loadSettings();

  const HISTORY_WINDOW_MS = 1200;
  const LOST_AFTER_MS = 700;

  // Seuils de grossissement : seul critère désormais, plus de conversion
  // en distance/vitesse réelle — on regarde uniquement si la silhouette
  // occupe une part croissante de l'image, et à quelle vitesse.
  const ALERT_RATE = 14;  // %/s de grossissement -> alerte
  const VIGIL_RATE = 6;   // %/s de grossissement -> vigilance

  const SCAN_INTERVAL_MS = 400;   // priorité batterie (était 250) — la marge de détection reste suffisante
  const ACTIVE_INTERVAL_MS = 200; // priorité batterie (était 135)

  let audioCtx = null;

  // ---------- audio : bip ----------
  function beep(freq, durationMs, volume = 0.2) {
    if (!soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine"; // son plus doux qu'un buzzer carré, plus agréable au casque
      osc.frequency.value = freq;
      gain.gain.value = volume;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
      osc.stop(audioCtx.currentTime + durationMs / 1000);
    } catch (e) { /* audio non disponible, on ignore */ }
  }

  // ---------- audio : annonce vocale ----------
  function speak(text) {
    if (!soundOn) return;
    if (getNativeTTS()) {
      // plugin natif (Android natif via Capacitor) — la WebView système
      // ne supporte pas fiablement l'API SpeechSynthesis du navigateur
      try {
        window.Capacitor.Plugins.TextToSpeech.speak({
          text: text,
          lang: "fr-FR",
          rate: 1.05,
          volume: 1.0
        }).catch((err) => {
          console.error("[TTS] échec de la synthèse vocale native —", err);
        });
      } catch (e) { console.error("[TTS] exception synchrone —", e); }
      return;
    }
    if (!speechEnabled) return;
    try {
      window.speechSynthesis.cancel(); // coupe une annonce précédente pas terminée
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = "fr-FR";
      utter.rate = 1.05;
      utter.volume = 1;
      window.speechSynthesis.speak(utter);
    } catch (e) { /* synthèse vocale indisponible, on ignore */ }
  }

  // annonce "Attention" dès l'entrée en vigilance/alerte, et répète tant
  // que l'alerte persiste (toutes les ALERT_REPEAT_MS) — plus de distinction
  // piéton/vélo, seul le fait qu'une silhouette grossisse compte désormais
  function maybeAnnounce(level) {
    if (level !== "vigilance" && level !== "alerte") {
      lastSpokenLabel = null;
      return;
    }
    const label = "Velo";
    const now = performance.now();
    const shouldRepeat = level === "alerte" && now - lastAnnounceTime > ALERT_REPEAT_MS;
    if (label !== lastSpokenLabel || shouldRepeat) {
      speak(label);
      lastSpokenLabel = label;
      lastAnnounceTime = now;
    }
  }

  // déverrouille l'audio/la synthèse vocale pendant le geste utilisateur
  // (obligatoire sur Android pour garantir la sortie, y compris Bluetooth)
  function unlockAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const buffer = audioCtx.createBuffer(1, 1, 22050);
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(audioCtx.destination);
      src.start(0);
    } catch (e) {}
    if (speechEnabled && !getNativeTTS()) {
      try {
        const warm = new SpeechSynthesisUtterance(" ");
        warm.volume = 0;
        window.speechSynthesis.speak(warm);
      } catch (e) {}
    }
  }

  function vibrate(pattern) {
    if (!vibOn) return;
    try { navigator.vibrate(pattern); } catch (e) {}
  }

  // effet miroir : automatique pour la caméra frontale (convention selfie),
  // optionnel pour la caméra arrière/externe (sensation de rétroviseur) —
  // une seule transformation CSS, quasi gratuite (accélérée matériellement)
  function updateMirrorState() {
    const shouldMirror = currentFacing === "user" || mirrorEffect;
    video.classList.toggle("mirror-on", shouldMirror);
  }

  // ---------- caméra ----------
  async function startCamera() {
    stopCamera();
    const videoConstraints = {
      // diagnostic fait : le recadrage n'était pas en cause (resizeMode
      // "none" confirmé même à basse résolution) — la vraie cause était
      // l'affichage (CSS object-fit, corrigé séparément). On revient à une
      // résolution plus légère, sans bénéfice à décoder du 1080p en continu.
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 15, max: 20 }
    };
    if (selectedDeviceId && !selectedDeviceId.startsWith("native:")) {
      // exigence stricte quand la caméra existe réellement (pas de dérive
      // possible vers une autre caméra si les autres critères — résolution,
      // fréquence — collent moins bien) ; le rattrapage en cas d'identifiant
      // périmé se fait dans le bloc catch ci-dessous, pas ici
      videoConstraints.deviceId = { exact: selectedDeviceId };
    } else {
      videoConstraints.facingMode = { ideal: currentFacing };
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints });
    } catch (err) {
      // filet de sécurité : si même la préférence pose souci (cas rare),
      // on retente une fois avec les réglages par défaut plutôt que de
      // rester bloqué durablement sur un choix de caméra devenu invalide
      if (selectedDeviceId && !selectedDeviceId.startsWith("native:")) {
        try {
          selectedDeviceId = null;
          saveSettings();
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 15, max: 20 }, facingMode: { ideal: currentFacing } }
          });
        } catch (err2) {
          gateError.textContent = "Accès caméra refusé ou indisponible [" + err2.name + "] " + err2.message + ". Vérifiez les permissions et que la page est servie en HTTPS.";
          throw err2;
        }
      } else {
        gateError.textContent = "Accès caméra refusé ou indisponible [" + err.name + "] " + err.message + ". Vérifiez les permissions et que la page est servie en HTTPS.";
        throw err;
      }
    }
    video.srcObject = stream;

    // détermine le sens du miroir à partir de ce que le pilote rapporte
    // réellement (fiable même quand l'objectif est choisi via le menu
    // déroulant, où currentFacing seul ne suffit plus à le savoir)
    const activeTrack = stream.getVideoTracks()[0];
    const trackSettings = activeTrack && activeTrack.getSettings ? activeTrack.getSettings() : {};
    if (trackSettings.facingMode) currentFacing = trackSettings.facingMode;

    updateMirrorState();

    // attendre les métadonnées avant de lire — limite l'écran noir parfois
    // observé après une reprise depuis l'arrière-plan sur Android
    await new Promise((resolve) => {
      if (video.readyState >= 1) return resolve();
      video.onloadedmetadata = () => resolve();
      setTimeout(resolve, 1500); // filet de sécurité si l'événement ne vient pas
    });

    try {
      await video.play();
    } catch (e) {
      await new Promise((r) => setTimeout(r, 250));
      await video.play().catch(() => {});
    }

    // forcer un rafraîchissement d'affichage (contourne un bug connu de
    // rendu figé/noir sur certains Android après redémarrage du flux)
    video.style.display = "none";
    void video.offsetHeight;
    video.style.display = "";

    resizeOverlay();
    resizeDetectCanvas();

    try {
      if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    } catch (e) { /* pas critique */ }
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
  }

  // liste les objectifs disponibles (n'apparaît qu'après la première
  // autorisation caméra, les labels étant vides tant que la permission
  // n'a pas été accordée) + l'objectif ultra grand-angle natif si présent
  async function refreshCameraList() {
    cameraSelect.innerHTML = "";
    let optionCount = 0;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cams = devices.filter((d) => d.kind === "videoinput");
      cams.forEach((d, i) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || `Caméra ${i + 1}`;
        cameraSelect.appendChild(opt);
        optionCount++;
      });
    } catch (e) { /* énumération indisponible, on ignore */ }

    try {
      const nativeWide = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.WideCamera;
      if (nativeWide) {
        const result = await nativeWide.listPhysicalCameras();
        (result.cameras || []).forEach((cam) => {
          if (!cam.isLogicalMultiCamera || !cam.physicalCameras || cam.physicalCameras.length < 2) return;
          // l'objectif à la focale la plus courte = le plus grand angle
          const widest = cam.physicalCameras.reduce((a, b) => (b.focalLengthMm < a.focalLengthMm ? b : a));
          const opt = document.createElement("option");
          opt.value = `native:${cam.logicalId}:${widest.physicalId}`;
          opt.textContent = "Ultra grand-angle (natif)";
          cameraSelect.appendChild(opt);
          optionCount++;
        });
      }
    } catch (e) { /* plugin natif indisponible, on ignore */ }

    if (optionCount <= 1) {
      cameraSelectRow.style.display = "none";
      return;
    }
    if (selectedDeviceId) cameraSelect.value = selectedDeviceId;
    cameraSelectRow.style.display = "";
  }

  // ---------- objectif ultra grand-angle natif (Camera2) ----------
  let nativeWideActive = false;
  let nativeFrameReady = false;
  const nativeImg = new Image();
  let nativeFrameListener = null;

  // dessine une image en préservant ses proportions (équivalent manuel de
  // CSS object-fit:cover) — recadre plutôt que d'étirer, pour éviter que
  // les objets détectés apparaissent écrasés/déformés si le ratio de
  // l'image source ne correspond pas exactement à celui du canvas cible
  function drawImageCover(context, img, dWidth, dHeight) {
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const targetRatio = dWidth / dHeight;
    let sx, sy, sw, sh;
    if (imgRatio > targetRatio) {
      sh = img.naturalHeight;
      sw = sh * targetRatio;
      sx = (img.naturalWidth - sw) / 2;
      sy = 0;
    } else {
      sw = img.naturalWidth;
      sh = sw / targetRatio;
      sx = 0;
      sy = (img.naturalHeight - sh) / 2;
    }
    context.drawImage(img, sx, sy, sw, sh, 0, 0, dWidth, dHeight);
  }

  function handleNativeFrame(data) {
    nativeImg.onload = () => {
      // aperçu visuel : redessiné immédiatement à chaque frame reçue,
      // indépendamment du rythme de la boucle de détection IA — c'est ce
      // découplage qui manquait et causait le saccadé
      drawImageCover(nativePreviewCtx, nativeImg, nativePreviewCanvas.width, nativePreviewCanvas.height);
      // image pour la détection IA : mise à jour au même rythme, consommée
      // seulement quand detectLoop tourne (cadence plus lente, volontaire)
      drawImageCover(detectCtx, nativeImg, dW, dH);
      nativeFrameReady = true;
    };
    nativeImg.src = data.image;
  }

  async function startNativeWideCamera(logicalId, physicalId) {
    stopCamera(); // coupe le flux getUserMedia s'il tournait
    video.style.visibility = "hidden"; // le flux natif est dessiné sur son propre canvas
    dW = 320; dH = 240;
    detectCanvas.width = dW; detectCanvas.height = dH;
    resizeOverlay();
    nativePreviewCanvas.style.display = "block";
    nativeWideActive = true;
    nativeFrameReady = false;

    const plugin = window.Capacitor.Plugins.WideCamera;
    if (!nativeFrameListener) {
      nativeFrameListener = await plugin.addListener("frame", handleNativeFrame);
    }
    const diag = await plugin.startCapture({ logicalId: logicalId, physicalId: physicalId });
    console.error("[WideCamera] résolution de capture réelle :", JSON.stringify(diag));
  }

  async function stopNativeWideCamera() {
    if (!nativeWideActive) return;
    nativeWideActive = false;
    video.style.visibility = "";
    nativePreviewCanvas.style.display = "none";
    try { await window.Capacitor.Plugins.WideCamera.stopCapture(); } catch (e) {}
  }

  function resizeOverlay() {
    const rect = viewport.getBoundingClientRect();
    overlay.width = rect.width;
    overlay.height = rect.height;
    nativePreviewCanvas.width = rect.width;
    nativePreviewCanvas.height = rect.height;
  }

  function resizeDetectCanvas() {
    if (!video.videoWidth) return;
    const scale = DETECT_MAX_DIM / Math.max(video.videoWidth, video.videoHeight);
    dW = Math.round(video.videoWidth * scale);
    dH = Math.round(video.videoHeight * scale);
    detectCanvas.width = dW;
    detectCanvas.height = dH;
  }

  // échantillonnage grossier pour détecter une image restée noire après reprise
  function isFrameBlack() {
    try {
      detectCtx.drawImage(video, 0, 0, dW, dH);
      const data = detectCtx.getImageData(0, 0, dW, dH).data;
      let sum = 0, n = 0;
      for (let i = 0; i < data.length; i += 41) { sum += data[i]; n++; }
      return n > 0 && sum / n < 3;
    } catch (e) { return false; }
  }

  // teste si la piste vidéo expose un zoom sous 1.0 — sur les téléphones à
  // "caméra logique", c'est parfois le seul moyen d'atteindre le capteur
  // ultra grand-angle physique, faute d'exposition séparée dans enumerateDevices()
  function refreshZoomControl() {
    try {
      const track = stream && stream.getVideoTracks()[0];
      if (!track || !track.getCapabilities) { zoomRow.style.display = "none"; return; }
      const caps = track.getCapabilities();
      if (!caps.zoom || caps.zoom.min >= 1) { zoomRow.style.display = "none"; return; }
      zoomSlider.min = caps.zoom.min;
      zoomSlider.max = caps.zoom.max;
      zoomSlider.step = caps.zoom.step || 0.1;
      const settings = track.getSettings ? track.getSettings() : {};
      const current = settings.zoom != null ? settings.zoom : caps.zoom.max;
      zoomSlider.value = current;
      zoomValue.textContent = Number(current).toFixed(2) + "x";
      zoomRow.style.display = "";
    } catch (e) { zoomRow.style.display = "none"; }
  }

  zoomSlider.addEventListener("input", async () => {
    zoomValue.textContent = Number(zoomSlider.value).toFixed(2) + "x";
    try {
      const track = stream && stream.getVideoTracks()[0];
      if (track) await track.applyConstraints({ advanced: [{ zoom: Number(zoomSlider.value) }] });
    } catch (e) { /* contrainte de zoom refusée par le pilote, on ignore */ }
  });
  window.addEventListener("resize", resizeOverlay);
  window.addEventListener("orientationchange", () => {
    resizeOverlay(); // immédiat, au cas où les dimensions sont déjà à jour
    setTimeout(resizeOverlay, 300);
    setTimeout(resizeOverlay, 700); // filet de sécurité si le navigateur met plus de temps à finir la rotation
  });

  // ---------- chargement du modèle ----------
  async function loadModel() {
    statePill.textContent = "CHARGEMENT MODÈLE…";
    model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
  }

  // ---------- cadence adaptative ----------
  function setDetectionInterval(ms) {
    if (ms === currentIntervalMs) return;
    currentIntervalMs = ms;
    clearInterval(detectTimer);
    detectTimer = setInterval(detectLoop, ms);
  }

  // ---------- boucle de détection ----------
  async function detectLoop() {
    if (!model || isPaused) return;

    if (nativeWideActive) {
      if (!nativeFrameReady) return; // pas de nouvelle image reçue depuis la dernière détection
      nativeFrameReady = false;
      // l'image est déjà dessinée sur detectCanvas par handleNativeFrame()
    } else {
      if (video.readyState < 2) return;
      detectCtx.drawImage(video, 0, 0, dW, dH);
    }

    let predictions = [];
    try {
      predictions = await model.detect(detectCanvas, 10);
    } catch (e) { return; }

    const people = predictions.filter(
      (p) => p.class === "person" && p.score >= minConfidence
    );

    const now = performance.now();

    if (people.length > 0) {
      const target = people.reduce((a, b) => (b.bbox[3] > a.bbox[3] ? b : a));
      const heightPct = (target.bbox[3] / dH) * 100;
      const centerXPct = ((target.bbox[0] + target.bbox[2] / 2) / dW) * 100;

      // détection de saut d'identité : avec plusieurs personnes proches en
      // taille (groupe de piétons), la "plus grande boîte" peut basculer
      // d'une personne à une autre d'une image à l'autre — un saut de
      // position ou de taille trop brutal pour être un mouvement réel à
      // cette cadence indique un changement de cible, pas une approche
      const MAX_LATERAL_JUMP_PCT = 15;
      const MAX_HEIGHT_RATIO_JUMP = 1.6;
      if (history.length > 0) {
        const last = history[history.length - 1];
        const lateralJump = Math.abs(centerXPct - last.cx);
        const heightRatio = Math.max(heightPct, last.h) / Math.max(1, Math.min(heightPct, last.h));
        if (lateralJump > MAX_LATERAL_JUMP_PCT || heightRatio > MAX_HEIGHT_RATIO_JUMP) {
          history = []; // on repart d'un suivi neuf plutôt que d'interpréter le saut comme un déplacement
          peakLevelThisTrack = "scan";
          lastSpokenLabel = null;
        }
      }

      history.push({ t: now, h: heightPct, cx: centerXPct });
      history = history.filter((p) => now - p.t <= HISTORY_WINDOW_MS);
      lastSeen = now;

      const growthRate = computeGrowthRate();

      updateHUD(target.class, heightPct);
      updateMiniRadar(centerXPct, heightPct);

      const rawLevel = classify(heightPct, growthRate, history.length);
      // le niveau ne redescend plus sur une simple mesure ponctuelle bruitée
      // — une fois vigilance/alerte atteint, il reste tant que l'objet
      // n'est pas clairement en train de s'éloigner
      const isClearlyReceding = growthRate <= RECEDE_RATE;
      if (isClearlyReceding) {
        peakLevelThisTrack = rawLevel;
      } else if (LEVEL_RANK[rawLevel] > LEVEL_RANK[peakLevelThisTrack]) {
        peakLevelThisTrack = rawLevel;
      }
      const level = peakLevelThisTrack;

      drawOverlay(predictions, target);
      setLevel(level);
      maybeAnnounce(level);
      setDetectionInterval(ACTIVE_INTERVAL_MS);
    } else {
      drawOverlay(predictions, null);
      if (now - lastSeen > LOST_AFTER_MS) {
        history = [];
        lastSpokenLabel = null;
        peakLevelThisTrack = "scan";
        updateHUD(null, null);
        updateMiniRadar(null, null);
        setLevel("scan");
        setDetectionInterval(SCAN_INTERVAL_MS);
      }
    }
  }

  function computeGrowthRate() {
    if (history.length < 2) return 0;
    const first = history[0];
    const last = history[history.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return (last.h - first.h) / dt;
  }

  const RECEDE_RATE = -4; // %/s de rétrécissement : silhouette qui s'éloigne clairement (ex. piéton croisé)
  const MIN_SAMPLES_FOR_TREND = 3; // minimum d'historique avant de se fier à la tendance

  // 5 paliers de vitesse de grossissement minimale (%/s), réglables dans les
  // paramètres — palier 5 = passer de 10% à 30% d'occupation de l'image en
  // 1 seconde. En dessous du palier choisi, une silhouette qui grossit
  // lentement ne déclenche plus rien : la vitesse de grossissement est
  // désormais une condition obligatoire, pas un simple critère parmi d'autres.
  const GROWTH_RATE_TABLE = [4, 8, 12, 16, 20];

  function classify(heightPct, growthRate, sampleCount) {
    const alerteHeight = Math.min(95, sensitivity * 1.5);
    const isReceding = growthRate <= RECEDE_RATE;
    const isEstablished = sampleCount >= MIN_SAMPLES_FOR_TREND;
    const minRate = GROWTH_RATE_TABLE[growthSensitivityLevel - 1];
    if (isReceding || !isEstablished || growthRate < minRate) return "detecte";
    // la croissance est jugée assez rapide : la taille déjà atteinte décide
    // seulement du niveau d'urgence (vigilance ou alerte), plus de son
    // déclenchement propre indépendant de la vitesse
    return heightPct >= alerteHeight ? "alerte" : "vigilance";
  }

  // ---------- rendu ----------
  // calcule la zone réellement occupée par la vidéo à l'écran quand elle
  // est affichée en object-fit:contain (proportions préservées, bandes
  // noires éventuelles) — nécessaire pour positionner les boîtes de
  // détection sur la vidéo elle-même, pas sur tout le canvas qui l'englobe
  function getContainRect(srcW, srcH, boxW, boxH) {
    const srcRatio = srcW / srcH;
    const boxRatio = boxW / boxH;
    if (srcRatio > boxRatio) {
      const dispW = boxW;
      const dispH = boxW / srcRatio;
      return { offX: 0, offY: (boxH - dispH) / 2, dispW, dispH };
    }
    const dispH = boxH;
    const dispW = boxH * srcRatio;
    return { offX: (boxW - dispW) / 2, offY: 0, dispW, dispH };
  }

  function drawOverlay(all, target) {
    if (darkMode) return; // rien à dessiner, l'aperçu est masqué : on économise le CPU/GPU
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    // le fond (flux natif) est désormais géré indépendamment par
    // nativePreviewCanvas, rafraîchi à chaque frame reçue — overlay ne
    // dessine plus que les boîtes de détection, par-dessus
    // en mode natif, nativePreviewCanvas remplit tout l'espace (cover) —
    // pas de bandes noires à compenser. En getUserMedia (vidéo standard),
    // #video est en contain : on calcule sa vraie zone d'affichage.
    let sx, sy, offX = 0, offY = 0, dispW = overlay.width;
    if (nativeWideActive) {
      sx = overlay.width / dW;
      sy = overlay.height / dH;
    } else {
      const rect = getContainRect(dW, dH, overlay.width, overlay.height);
      sx = rect.dispW / dW;
      sy = rect.dispH / dH;
      offX = rect.offX;
      offY = rect.offY;
      dispW = rect.dispW;
    }
    const mirrored = video.classList.contains("mirror-on");

    all.forEach((p) => {
      const isPerson = p.class === "person" && p.score >= minConfidence;
      if (!isPerson && p.score < 0.5) return;
      const isTarget = p === target;

      let [x, y, w, h] = p.bbox;
      x = x * sx + offX; y = y * sy + offY; w *= sx; h *= sy;
      // miroir appliqué à l'intérieur de la seule zone réellement occupée
      // par la vidéo (dispW), pas sur tout le canvas qui l'englobe
      if (mirrored) x = offX + dispW - (x - offX) - w;

      ctx.lineWidth = isPerson ? (isTarget ? 2.5 : 1.5) : 1;
      ctx.strokeStyle = isPerson
        ? (isTarget ? levelColor(currentLevel) : "rgba(52,211,153,0.5)")
        : "rgba(124,139,154,0.5)";
      ctx.strokeRect(x, y, w, h);

      if (isPerson) {
        const label = "PERSONNE";
        ctx.font = "600 12px 'Space Mono', monospace";
        const textW = ctx.measureText(label).width + 10;
        ctx.fillStyle = isTarget ? levelColor(currentLevel) : "rgba(52,211,153,0.5)";
        ctx.fillRect(x, Math.max(0, y - 20), textW, 18);
        ctx.fillStyle = "#06251C";
        ctx.fillText(label, x + 5, Math.max(14, y - 6));
      }
    });
  }

  function levelColor(level) {
    if (level === "alerte") return "#EF4444";
    if (level === "vigilance") return "#F59E0B";
    return "#34D399";
  }

  function updateHUD(cls, heightPct) {
    metricObject.textContent = cls ? "PERSONNE" : "—";
    metricProx.textContent = heightPct ? Math.round(heightPct) + "%" : "—";
  }

  function updateMiniRadar(centerXPct, heightPct) {
    if (centerXPct == null) {
      miniBlip.setAttribute("opacity", "0");
      return;
    }
    const angleDeg = (centerXPct / 100 - 0.5) * 100;
    const angleRad = (angleDeg - 90) * (Math.PI / 180);
    const proximity = Math.min(1, heightPct / 90);
    const radius = 44 - proximity * 34;
    const cx = 52 + radius * Math.cos(angleRad);
    const cy = 52 + radius * Math.sin(angleRad);
    miniBlip.setAttribute("cx", cx.toFixed(1));
    miniBlip.setAttribute("cy", cy.toFixed(1));
    miniBlip.setAttribute("fill", levelColor(currentLevel));
    miniBlip.setAttribute("opacity", "1");
  }

  // ---------- gestion des niveaux d'alerte ----------
  function setLevel(level) {
    if (level === currentLevel) return;
    currentLevel = level;

    statePill.dataset.level = level;
    statePill.textContent = {
      scan: "SCAN — RAS",
      detecte: "PERSONNE DÉTECTÉE",
      vigilance: "VIGILANCE",
      alerte: "ALERTE — PERSONNE PROCHE"
    }[level];
    darkStatus.textContent = statePill.textContent;
    darkStatus.style.color = levelColor(level);

    viewport.classList.remove("level-vigilance", "level-alerte");
    if (level === "vigilance") viewport.classList.add("level-vigilance");
    if (level === "alerte") viewport.classList.add("level-alerte");

    clearInterval(alertTimer);
    if (level === "vigilance") {
      vibrate([60]);
      alertTimer = setInterval(() => beep(760, 110), 600);
    } else if (level === "alerte") {
      vibrate([90, 50, 90, 50, 90]);
      alertTimer = setInterval(() => {
        beep(1150, 70);
        setTimeout(() => beep(850, 70), 100);
        vibrate(70);
      }, 260);
    }
  }

  // ---------- pause / reprise en arrière-plan ----------
  function setScanIcon(active) {
    brandDot.classList.toggle("paused", !active);
  }

  async function pauseAll() {
    if (isPaused) return;
    isPaused = true;
    setScanIcon(false);
    clearInterval(detectTimer);
    clearInterval(alertTimer);
    currentIntervalMs = 0;
    // les deux sources de caméra doivent être coupées explicitement — se
    // fier uniquement au cycle de vie natif (handleOnStop) pour l'objectif
    // grand-angle créait une fenêtre de conflit avec getUserMedia au réveil
    if (nativeWideActive) { try { await stopNativeWideCamera(); } catch (e) {} }
    stopCamera();
    if (wakeLock) { try { await wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  async function resumeAll() {
    if (!isRunning || !isPaused) return;
    isPaused = false;
    try {
      // reprendre exactement le même mode qu'avant la mise en pause,
      // plutôt que de toujours rebasculer sur getUserMedia
      if (selectedDeviceId && selectedDeviceId.startsWith("native:")) {
        const [, logicalId, physicalId] = selectedDeviceId.split(":");
        await startNativeWideCamera(logicalId, physicalId);
      } else {
        await startCamera();
      }
      setDetectionInterval(SCAN_INTERVAL_MS);
      setScanIcon(true);
      refreshCameraList();
      refreshZoomControl();
      // filet de sécurité : si l'image revient noire malgré tout, on
      // retente une fois automatiquement (uniquement pertinent en mode
      // getUserMedia classique, la capture native gère son propre flux)
      setTimeout(async () => {
        if (!isPaused && !nativeWideActive && isFrameBlack()) {
          try { await startCamera(); } catch (e) {}
        }
      }, 700);
    } catch (e) {
      isPaused = true;
      setScanIcon(false);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      pauseAll();
    } else if (isRunning) {
      resumeAll();
    }
  });

  // ---------- interactions ----------
  startBtn.addEventListener("click", async () => {
    gateError.textContent = "";
    startBtn.disabled = true;
    startBtn.textContent = "Initialisation…";
    unlockAudio(); // dans le geste utilisateur, pour garantir le son (Bluetooth compris)
    try {
      await startCamera();
      if (!model) await loadModel();
      gate.classList.add("hidden");
      isRunning = true;
      setScanIcon(true);
      statePill.dataset.level = "scan";
      statePill.textContent = "SCAN — RAS";
      setDetectionInterval(SCAN_INTERVAL_MS);
      await refreshCameraList();
      refreshZoomControl();
      // reprend le mode natif si c'était le dernier objectif choisi
      if (selectedDeviceId && selectedDeviceId.startsWith("native:")) {
        const [, logicalId, physicalId] = selectedDeviceId.split(":");
        try { await startNativeWideCamera(logicalId, physicalId); } catch (e) {}
      }
    } catch (e) {
      startBtn.disabled = false;
      startBtn.textContent = "Démarrer la caméra";
    }
  });

  soundToggle.addEventListener("change", () => {
    soundOn = soundToggle.checked;
    saveSettings();
  });

  vibToggle.addEventListener("change", () => {
    if (!("vibrate" in navigator)) return;
    vibOn = vibToggle.checked;
    saveSettings();
  });

  darkModeToggle.addEventListener("change", () => {
    darkMode = darkModeToggle.checked;
    viewport.classList.toggle("dark-active", darkMode);
    if (!darkMode) ctx.clearRect(0, 0, overlay.width, overlay.height);
    saveSettings();
  });

  mirrorToggle.addEventListener("change", () => {
    mirrorEffect = mirrorToggle.checked;
    updateMirrorState();
    saveSettings();
  });

  cameraSelect.addEventListener("change", async () => {
    selectedDeviceId = cameraSelect.value || null;
    saveSettings();
    try {
      if (selectedDeviceId && selectedDeviceId.startsWith("native:")) {
        const [, logicalId, physicalId] = selectedDeviceId.split(":");
        await startNativeWideCamera(logicalId, physicalId);
      } else {
        await stopNativeWideCamera();
        await startCamera();
        refreshZoomControl();
      }
    } catch (e) {}
  });

  settingsBtn.addEventListener("click", () => settingsDrawer.classList.add("open"));
  closeSettings.addEventListener("click", () => settingsDrawer.classList.remove("open"));

  // ---------- popups d'aide sur les réglages ----------
  const HELP_CONTENT = {
    sens: {
      title: "Seuil de vigilance",
      text: "Ce curseur fixe la taille que doit atteindre une personne à l'écran (en % de la hauteur de l'image) pour que l'appli passe en VIGILANCE — c'est-à-dire qu'elle occupe une part croissante du champ de la caméra, donc qu'elle se rapproche. Le niveau ALERTE se déclenche ensuite vers 1,5 fois ce seuil. Un grossissement rapide de la silhouette peut aussi déclencher ces niveaux plus tôt, même si la taille n'a pas encore atteint le seuil. Seuil plus bas → alertes plus précoces mais potentiellement plus fréquentes ; seuil plus haut → alertes plus tardives mais plus sûres."
    },
    conf: {
      title: "Confiance minimale de détection",
      text: "Ce réglage fixe le seuil en dessous duquel une détection est ignorée. À chaque image, le modèle attribue à chaque silhouette repérée un score de probabilité qu'il s'agisse bien d'une personne (ex. 90% = quasi certain, 35% = incertain). Toute détection sous ce seuil est écartée : elle n'apparaît pas dans le suivi, ne déclenche pas d'alerte. Seuil plus bas → détection plus tôt/plus loin, mais plus de fausses détections (ombres, buissons, poteaux). Seuil plus haut → moins de faux positifs, mais détection plus tardive."
    },
    growth: {
      title: "Rapidité de grossissement minimum",
      text: "Une silhouette qui grossit lentement dans l'image ne déclenche plus d'alerte : il faut désormais qu'elle grossisse assez vite, condition obligatoire (plus un simple critère parmi d'autres). Le palier choisi fixe cette vitesse minimale : Palier 1 = 4% d'occupation d'image gagnés par seconde (le plus sensible), jusqu'au Palier 5 = 20%/s (par exemple, passer de 10% à 30% d'occupation de l'image en 1 seconde — le plus exigeant). Palier bas → alertes plus fréquentes, y compris sur des approches lentes. Palier haut → seules les approches rapides déclenchent quelque chose."
    }
  };

  document.querySelectorAll(".help-icon").forEach((btn) => {
    btn.addEventListener("click", () => {
      const content = HELP_CONTENT[btn.dataset.help];
      if (!content) return;
      helpTitle.textContent = content.title;
      helpText.textContent = content.text;
      helpOverlay.classList.add("open");
    });
  });
  helpClose.addEventListener("click", () => helpOverlay.classList.remove("open"));
  helpOverlay.addEventListener("click", (e) => {
    if (e.target === helpOverlay) helpOverlay.classList.remove("open");
  });

  sensSlider.addEventListener("input", () => {
    sensitivity = Number(sensSlider.value);
    sensValue.textContent = sensitivity + "%";
    saveSettings();
  });
  confSlider.addEventListener("input", () => {
    minConfidence = Number(confSlider.value) / 100;
    confValue.textContent = confSlider.value + "%";
    saveSettings();
  });
  growthSlider.addEventListener("input", () => {
    growthSensitivityLevel = Number(growthSlider.value);
    growthValue.textContent = "Palier " + growthSensitivityLevel;
    saveSettings();
  });

  // ---------- enregistrement du service worker ----------
  // inutile (et contre-productif) dans l'appli native : les mises à jour se
  // gèrent déjà par recompilation/réinstallation de l'APK, et un service
  // worker actif dans la WebView peut continuer à servir une version
  // périmée d'app.js malgré une recompilation, ce qui gêne le débogage.
  if ("serviceWorker" in navigator && !(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js")
        .then((reg) => reg.update().catch(() => {})) // vérifie une mise à jour à chaque chargement
        .catch(() => {});
    });

    // dès qu'une nouvelle version prend le contrôle de la page, on recharge
    // une seule fois pour afficher les fichiers fraîchement mis en cache
    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloadedForUpdate) return;
      reloadedForUpdate = true;
      window.location.reload();
    });
  } else if ("serviceWorker" in navigator) {
    // sur natif : on désenregistre un éventuel service worker déjà présent
    // (installé lors d'un test précédent) pour repartir propre
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((reg) => reg.unregister());
    }).catch(() => {});
  }
})();
