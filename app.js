// Radar Piéton — prototype de détection de présence humaine par caméra (COCO-SSD)
//
// v2 : on suit la classe "person" plutôt que "bicycle". Un vélo vu de face ou
// de trois-quarts n'est presque jamais reconnu comme "bicycle" par COCO-SSD
// (la forme du vélo n'est visible que de profil), alors que le cycliste
// lui-même reste détectable comme "person" sous quasiment tous les angles.
// Ça couvre aussi les piétons — l'objectif est de détecter le plus tôt
// possible toute présence humaine dans le dos, à pied ou à vélo.
//
// Optimisations batterie/chaleur :
//  - la détection tourne sur une image réduite (petit canvas hors-écran),
//    pas sur la vidéo pleine résolution ;
//  - la cadence de détection est adaptative : lente en veille (rien détecté),
//    rapide dès qu'une personne est suivie ;
//  - tout s'arrête (caméra + boucle de détection) quand l'onglet/l'appli
//    passe en arrière-plan, et reprend au retour.
//
// Comme avant : pas de mesure de distance réelle, juste un proxy à partir de
// la taille de la boîte englobante et de sa vitesse de "grossissement".
// À calibrer sur le terrain — seuils réglables dans les paramètres.

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

  const metricObject = document.getElementById("metricObject");
  const metricConf = document.getElementById("metricConf");
  const metricProx = document.getElementById("metricProx");

  const soundBtn = document.getElementById("soundBtn");
  const vibBtn = document.getElementById("vibBtn");
  const flipBtn = document.getElementById("flipBtn");
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsDrawer = document.getElementById("settingsDrawer");
  const closeSettings = document.getElementById("closeSettings");

  const sensSlider = document.getElementById("sensSlider");
  const sensValue = document.getElementById("sensValue");
  const confSlider = document.getElementById("confSlider");
  const confValue = document.getElementById("confValue");

  // ---------- canvas de détection hors-écran (basse résolution) ----------
  // On ne fait jamais tourner le modèle sur la vidéo pleine résolution :
  // on la redessine réduite ici, ce qui limite le travail de lecture/
  // redimensionnement de pixels à chaque détection.
  const detectCanvas = document.createElement("canvas");
  const detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });
  const DETECT_MAX_DIM = 300; // suffisant pour lite_mobilenet_v2 (entrée 300x300)
  let dW = DETECT_MAX_DIM, dH = DETECT_MAX_DIM;

  // ---------- état ----------
  let model = null;
  let stream = null;
  let currentFacing = "environment"; // caméra arrière par défaut (portée dans le dos)
  let soundOn = true;
  let vibOn = "vibrate" in navigator;
  if (!vibOn) vibBtn.classList.add("muted");

  let detectTimer = null;
  let alertTimer = null;
  let wakeLock = null;
  let isRunning = false;   // l'utilisateur a démarré la détection
  let isPaused = false;    // mis en pause car l'app est en arrière-plan

  let history = []; // {t, h, cx} de la personne suivie
  let lastSeen = 0;
  let currentLevel = "scan"; // scan | detecte | vigilance | alerte
  let currentIntervalMs = 0;

  let sensitivity = Number(sensSlider.value); // seuil de hauteur % pour "vigilance"
  let minConfidence = Number(confSlider.value) / 100;

  const HISTORY_WINDOW_MS = 1500;
  const LOST_AFTER_MS = 700;
  const ALERT_RATE = 20; // %/s de grossissement -> alerte
  const VIGIL_RATE = 8;  // %/s de grossissement -> vigilance

  const SCAN_INTERVAL_MS = 550;   // cadence lente : rien à surveiller
  const ACTIVE_INTERVAL_MS = 150; // cadence rapide : une personne est suivie

  let audioCtx = null;

  // ---------- audio ----------
  function beep(freq, durationMs, volume = 0.18) {
    if (!soundOn) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.value = volume;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
      osc.stop(audioCtx.currentTime + durationMs / 1000);
    } catch (e) { /* audio non disponible, on ignore */ }
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
          // résolution modeste : moins de pixels à faire transiter dans le
          // pipeline caméra -> moins de charge CPU/GPU et de chaleur.
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
    await video.play();
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

    // image réduite pour la détection (voir détectCanvas plus haut)
    detectCtx.drawImage(video, 0, 0, dW, dH);

    let predictions = [];
    try {
      predictions = await model.detect(detectCanvas, 10);
    } catch (e) { return; }

    const people = predictions.filter(
      (p) => p.class === "person" && p.score >= minConfidence
    );

    drawOverlay(predictions);

    const now = performance.now();

    if (people.length > 0) {
      // on suit la personne dont la boîte est la plus grande (la plus proche/pertinente)
      const target = people.reduce((a, b) => (b.bbox[3] > a.bbox[3] ? b : a));
      const heightPct = (target.bbox[3] / dH) * 100;
      const centerXPct = ((target.bbox[0] + target.bbox[2] / 2) / dW) * 100;

      history.push({ t: now, h: heightPct, cx: centerXPct });
      history = history.filter((p) => now - p.t <= HISTORY_WINDOW_MS);
      lastSeen = now;

      const growthRate = computeGrowthRate();
      updateHUD(target.class, target.score, heightPct);
      updateMiniRadar(centerXPct, heightPct);
      const level = classify(heightPct, growthRate);
      setLevel(level);
      setDetectionInterval(ACTIVE_INTERVAL_MS);
    } else if (now - lastSeen > LOST_AFTER_MS) {
      history = [];
      updateHUD(null, null, null);
      updateMiniRadar(null, null);
      setLevel("scan");
      setDetectionInterval(SCAN_INTERVAL_MS);
    }
  }

  function computeGrowthRate() {
    if (history.length < 2) return 0;
    const first = history[0];
    const last = history[history.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return (last.h - first.h) / dt; // %/s
  }

  function classify(heightPct, growthRate) {
    const alerteHeight = Math.min(95, sensitivity * 1.7);
    const vigilHeight = sensitivity;
    if (heightPct >= alerteHeight || growthRate >= ALERT_RATE) return "alerte";
    if (heightPct >= vigilHeight || growthRate >= VIGIL_RATE) return "vigilance";
    return "detecte";
  }

  // ---------- rendu ----------
  function drawOverlay(all) {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const sx = overlay.width / dW;
    const sy = overlay.height / dH;
    const mirrored = video.classList.contains("rear") === false;

    all.forEach((p) => {
      const isPerson = p.class === "person" && p.score >= minConfidence;
      if (!isPerson && p.score < 0.5) return;
      let [x, y, w, h] = p.bbox;
      x *= sx; y *= sy; w *= sx; h *= sy;
      if (mirrored) x = overlay.width - x - w;

      ctx.lineWidth = isPerson ? 2.5 : 1;
      ctx.strokeStyle = isPerson ? levelColor(currentLevel) : "rgba(124,139,154,0.5)";
      ctx.strokeRect(x, y, w, h);

      if (isPerson) {
        const label = `PERSONNE ${Math.round(p.score * 100)}%`;
        ctx.font = "600 12px 'Space Mono', monospace";
        const textW = ctx.measureText(label).width + 10;
        ctx.fillStyle = levelColor(currentLevel);
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

  function updateHUD(cls, score, heightPct) {
    metricObject.textContent = cls ? "PERSONNE" : "—";
    metricConf.textContent = score ? Math.round(score * 100) + "%" : "—";
    metricProx.textContent = heightPct ? Math.round(heightPct) + "%" : "—";
  }

  function updateMiniRadar(centerXPct, heightPct) {
    if (centerXPct == null) {
      miniBlip.setAttribute("opacity", "0");
      return;
    }
    // position angulaire selon la position horizontale dans l'image (-50°..50°)
    const angleDeg = (centerXPct / 100 - 0.5) * 100;
    const angleRad = (angleDeg - 90) * (Math.PI / 180);
    // rayon inversement proportionnel à la proximité (plus gros = plus proche = plus près du centre)
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
      alertTimer = setInterval(() => beep(760, 90), 600);
    } else if (level === "alerte") {
      vibrate([90, 50, 90, 50, 90]);
      alertTimer = setInterval(() => { beep(1050, 90); vibrate(70); }, 220);
    }
  }

  // ---------- pause / reprise en arrière-plan ----------
  async function pauseAll() {
    if (isPaused) return;
    isPaused = true;
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
    } catch (e) { /* l'utilisateur devra relancer manuellement si ça échoue */ }
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
    try {
      await startCamera();
      if (!model) await loadModel();
      gate.classList.add("hidden");
      isRunning = true;
      statePill.dataset.level = "scan";
      statePill.textContent = "SCAN — RAS";
      setDetectionInterval(SCAN_INTERVAL_MS);
    } catch (e) {
      startBtn.disabled = false;
      startBtn.textContent = "Démarrer la caméra";
    }
  });

  soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    soundBtn.classList.toggle("active", soundOn);
  });

  vibBtn.addEventListener("click", () => {
    if (!("vibrate" in navigator)) return;
    vibOn = !vibOn;
    vibBtn.classList.toggle("active", vibOn);
  });

  flipBtn.addEventListener("click", async () => {
    currentFacing = currentFacing === "environment" ? "user" : "environment";
    await startCamera();
  });

  settingsBtn.addEventListener("click", () => settingsDrawer.classList.add("open"));
  closeSettings.addEventListener("click", () => settingsDrawer.classList.remove("open"));

  sensSlider.addEventListener("input", () => {
    sensitivity = Number(sensSlider.value);
    sensValue.textContent = sensitivity + "%";
  });
  confSlider.addEventListener("input", () => {
    minConfidence = Number(confSlider.value) / 100;
    confValue.textContent = confSlider.value + "%";
  });

  // ---------- enregistrement du service worker ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
