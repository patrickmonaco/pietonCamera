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

  // ---------- éléments DOM ----------
  const video = document.getElementById("video");
  const overlay = document.getElementById("overlay");
  const ctx = overlay.getContext("2d");
  const viewport = document.getElementById("viewport");
  const gate = document.getElementById("gate");
  const gateError = document.getElementById("gateError");
  const startBtn = document.getElementById("startBtn");
  const statePill = document.getElementById("statePill");
  const miniBlip = document.getElementById("miniBlip");
  const brandDot = document.getElementById("brandDot");

  const metricObject = document.getElementById("metricObject");
  const metricSpeed = document.getElementById("metricSpeed");
  const metricProx = document.getElementById("metricProx");

  const soundToggle = document.getElementById("soundToggle");
  const vibToggle = document.getElementById("vibToggle");
  const flipBtn = document.getElementById("flipBtn");
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsDrawer = document.getElementById("settingsDrawer");
  const closeSettings = document.getElementById("closeSettings");

  const sensSlider = document.getElementById("sensSlider");
  const sensValue = document.getElementById("sensValue");
  const confSlider = document.getElementById("confSlider");
  const confValue = document.getElementById("confValue");

  const helpOverlay = document.getElementById("helpOverlay");
  const helpTitle = document.getElementById("helpTitle");
  const helpText = document.getElementById("helpText");
  const helpClose = document.getElementById("helpClose");

  // ---------- canvas de détection hors-écran (basse résolution) ----------
  const detectCanvas = document.createElement("canvas");
  const detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });
  const DETECT_MAX_DIM = 300;
  let dW = DETECT_MAX_DIM, dH = DETECT_MAX_DIM;

  // ---------- estimation de distance / vitesse ----------
  const ASSUMED_PERSON_HEIGHT_M = 1.65;
  const VERTICAL_FOV_DEG = 50;
  const DISTANCE_K = ASSUMED_PERSON_HEIGHT_M / (2 * Math.tan((VERTICAL_FOV_DEG * Math.PI / 180) / 2));

  const BIKE_SPEED_THRESHOLD_KMH = 5; // au-delà, on suppose un vélo plutôt qu'un piéton
  const MIN_SAMPLES_FOR_SPEED = 3;
  const MIN_DT_FOR_SPEED_S = 0.3;

  function estimateDistanceM(heightPct) {
    if (!heightPct || heightPct <= 0) return null;
    return (DISTANCE_K * 100) / heightPct;
  }

  // ---------- état ----------
  let model = null;
  let stream = null;
  let currentFacing = "environment";
  let soundOn = true;
  let vibOn = "vibrate" in navigator;
  if (!vibOn) vibToggle.disabled = true;
  const speechEnabled = "speechSynthesis" in window;

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

  // ---------- persistance des réglages (localStorage) ----------
  const SETTINGS_KEY = "radarPieton.settings";

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ sensitivity, minConfidence, soundOn, vibOn }));
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
      if (typeof s.soundOn === "boolean") {
        soundOn = s.soundOn;
        soundToggle.checked = soundOn;
      }
      if (typeof s.vibOn === "boolean" && "vibrate" in navigator) {
        vibOn = s.vibOn;
        vibToggle.checked = vibOn;
      }
    } catch (e) { /* réglages sauvegardés illisibles, on garde les valeurs par défaut */ }
  }

  loadSettings();

  const HISTORY_WINDOW_MS = 1200;
  const LOST_AFTER_MS = 700;

  // Seuils abaissés par rapport à la v3 pour alerter plus tôt, et vitesse de
  // rapprochement ajoutée comme déclencheur indépendant de la taille de boîte.
  const ALERT_RATE = 14;       // %/s de grossissement -> alerte (était 20)
  const VIGIL_RATE = 6;        // %/s de grossissement -> vigilance (était 8)
  const ALERT_SPEED_KMH = 14;  // rapprochement rapide -> alerte, même si encore loin
  const VIGIL_SPEED_KMH = 6;   // rapprochement notable -> vigilance, même si encore loin

  const SCAN_INTERVAL_MS = 550;
  const ACTIVE_INTERVAL_MS = 150;

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
    if (!soundOn || !speechEnabled) return;
    try {
      window.speechSynthesis.cancel(); // coupe une annonce précédente pas terminée
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = "fr-FR";
      utter.rate = 1.05;
      utter.volume = 1;
      window.speechSynthesis.speak(utter);
    } catch (e) { /* synthèse vocale indisponible, on ignore */ }
  }

  // annonce "Piéton" / "Vélo" dès l'entrée en vigilance/alerte, et répète
  // tant que l'alerte persiste (toutes les ALERT_REPEAT_MS)
  function maybeAnnounce(level, likelyBike) {
    if (level !== "vigilance" && level !== "alerte") {
      lastSpokenLabel = null;
      return;
    }
    const label = likelyBike ? "Vélo" : "Piéton";
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
    if (speechEnabled) {
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

  // ---------- caméra ----------
  async function startCamera() {
    stopCamera();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: currentFacing },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 15, max: 20 }
        }
      });
    } catch (err) {
      gateError.textContent = "Accès caméra refusé ou indisponible (" + err.message + "). Vérifiez les permissions et que la page est servie en HTTPS.";
      throw err;
    }
    video.srcObject = stream;
    video.classList.toggle("rear", currentFacing === "environment");

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

  function resizeOverlay() {
    const rect = viewport.getBoundingClientRect();
    overlay.width = rect.width;
    overlay.height = rect.height;
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

  window.addEventListener("resize", resizeOverlay);
  window.addEventListener("orientationchange", () => setTimeout(resizeOverlay, 300));

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
    if (!model || video.readyState < 2 || isPaused) return;

    detectCtx.drawImage(video, 0, 0, dW, dH);

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
      const distanceM = estimateDistanceM(heightPct);

      history.push({ t: now, h: heightPct, cx: centerXPct, d: distanceM });
      history = history.filter((p) => now - p.t <= HISTORY_WINDOW_MS);
      lastSeen = now;

      const growthRate = computeGrowthRate();
      const closingSpeedKmh = computeClosingSpeedKmh();
      const likelyBike = closingSpeedKmh != null && closingSpeedKmh > BIKE_SPEED_THRESHOLD_KMH;

      updateHUD(target.class, heightPct, closingSpeedKmh, likelyBike);
      updateMiniRadar(centerXPct, heightPct);
      drawOverlay(predictions, target, likelyBike, closingSpeedKmh);

      const level = classify(heightPct, growthRate, closingSpeedKmh);
      setLevel(level);
      maybeAnnounce(level, likelyBike);
      setDetectionInterval(ACTIVE_INTERVAL_MS);
    } else {
      drawOverlay(predictions, null, false, null);
      if (now - lastSeen > LOST_AFTER_MS) {
        history = [];
        lastSpokenLabel = null;
        updateHUD(null, null, null, false);
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

  function computeClosingSpeedKmh() {
    if (history.length < MIN_SAMPLES_FOR_SPEED) return null;
    const first = history[0];
    const last = history[history.length - 1];
    if (first.d == null || last.d == null) return null;
    const dt = (last.t - first.t) / 1000;
    if (dt < MIN_DT_FOR_SPEED_S) return null;
    const closingM = first.d - last.d;
    return (closingM / dt) * 3.6;
  }

  function classify(heightPct, growthRate, closingSpeedKmh) {
    const alerteHeight = Math.min(95, sensitivity * 1.5); // était *1.7
    const vigilHeight = sensitivity;
    const fastClosing = closingSpeedKmh != null && closingSpeedKmh >= ALERT_SPEED_KMH;
    const closing = closingSpeedKmh != null && closingSpeedKmh >= VIGIL_SPEED_KMH;
    if (heightPct >= alerteHeight || growthRate >= ALERT_RATE || fastClosing) return "alerte";
    if (heightPct >= vigilHeight || growthRate >= VIGIL_RATE || closing) return "vigilance";
    return "detecte";
  }

  // ---------- rendu ----------
  function drawOverlay(all, target, likelyBike, closingSpeedKmh) {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const sx = overlay.width / dW;
    const sy = overlay.height / dH;
    const mirrored = video.classList.contains("rear") === false;

    all.forEach((p) => {
      const isPerson = p.class === "person" && p.score >= minConfidence;
      if (!isPerson && p.score < 0.5) return;
      const isTarget = p === target;

      let [x, y, w, h] = p.bbox;
      x *= sx; y *= sy; w *= sx; h *= sy;
      if (mirrored) x = overlay.width - x - w;

      ctx.lineWidth = isPerson ? (isTarget ? 2.5 : 1.5) : 1;
      ctx.strokeStyle = isPerson
        ? (isTarget ? levelColor(currentLevel) : "rgba(52,211,153,0.5)")
        : "rgba(124,139,154,0.5)";
      ctx.strokeRect(x, y, w, h);

      if (isPerson) {
        let label = "PERSONNE";
        if (isTarget) {
          label = likelyBike ? `VÉLO ? ~${Math.round(closingSpeedKmh)} KM/H` : "PIÉTON";
        }
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

  function updateHUD(cls, heightPct, closingSpeedKmh, likelyBike) {
    metricObject.textContent = cls ? (likelyBike ? "VÉLO ?" : "PIÉTON") : "—";
    metricSpeed.textContent = closingSpeedKmh != null ? Math.round(closingSpeedKmh) + " km/h" : "—";
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
    stopCamera();
    if (wakeLock) { try { await wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  async function resumeAll() {
    if (!isRunning || !isPaused) return;
    isPaused = false;
    try {
      await startCamera();
      setDetectionInterval(SCAN_INTERVAL_MS);
      setScanIcon(true);
      // filet de sécurité : si l'image revient noire malgré tout, on
      // retente une fois automatiquement
      setTimeout(async () => {
        if (!isPaused && isFrameBlack()) {
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

  flipBtn.addEventListener("click", async () => {
    currentFacing = currentFacing === "environment" ? "user" : "environment";
    await startCamera();
  });

  settingsBtn.addEventListener("click", () => settingsDrawer.classList.add("open"));
  closeSettings.addEventListener("click", () => settingsDrawer.classList.remove("open"));

  // ---------- popups d'aide sur les réglages ----------
  const HELP_CONTENT = {
    sens: {
      title: "Seuil de vigilance",
      text: "Ce curseur fixe la taille que doit atteindre une personne à l'écran (en % de la hauteur de l'image) pour que l'appli passe en VIGILANCE — c'est-à-dire qu'elle occupe une part croissante du champ de la caméra, donc qu'elle se rapproche. Le niveau ALERTE se déclenche ensuite vers 1,5 fois ce seuil. Une vitesse de rapprochement élevée ou un grossissement rapide de la silhouette peuvent aussi déclencher ces niveaux plus tôt, même si la taille n'a pas encore atteint le seuil. Seuil plus bas → alertes plus précoces mais potentiellement plus fréquentes ; seuil plus haut → alertes plus tardives mais plus sûres."
    },
    conf: {
      title: "Confiance minimale de détection",
      text: "Ce réglage fixe le seuil en dessous duquel une détection est ignorée. À chaque image, le modèle attribue à chaque silhouette repérée un score de probabilité qu'il s'agisse bien d'une personne (ex. 90% = quasi certain, 35% = incertain). Toute détection sous ce seuil est écartée : elle n'apparaît pas dans le suivi, ne déclenche pas d'alerte, ne compte pas dans le calcul de la vitesse de rapprochement. Seuil plus bas → détection plus tôt/plus loin, mais plus de fausses détections (ombres, buissons, poteaux). Seuil plus haut → moins de faux positifs, mais détection plus tardive."
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

  // ---------- enregistrement du service worker ----------
  if ("serviceWorker" in navigator) {
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
  }
})();
