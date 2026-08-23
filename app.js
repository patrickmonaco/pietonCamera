// Radar Piéton — prototype de détection de vélo par caméra (COCO-SSD)
//
// Principe : pas de mesure de distance réelle, on estime la proximité à
// partir de la taille de la boîte englobante du vélo dans l'image et de
// sa vitesse de "grossissement" d'une frame à l'autre (comme un vélo qui
// approche occupe une part croissante du champ de la caméra).
// À calibrer sur le terrain — les seuils sont réglables dans les paramètres.

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

  let history = []; // {t, h, cx} du vélo suivi
  let lastSeen = 0;
  let currentLevel = "scan"; // scan | detecte | vigilance | alerte

  let sensitivity = Number(sensSlider.value); // seuil de hauteur % pour "vigilance"
  let minConfidence = Number(confSlider.value) / 100;

  const HISTORY_WINDOW_MS = 1500;
  const LOST_AFTER_MS = 700;
  const ALERT_RATE = 20; // %/s de grossissement -> alerte
  const VIGIL_RATE = 8;  // %/s de grossissement -> vigilance

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
          width: { ideal: 1280 },
          height: { ideal: 720 }
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
  window.addEventListener("resize", resizeOverlay);
  window.addEventListener("orientationchange", () => setTimeout(resizeOverlay, 300));

  // ---------- chargement du modèle ----------
  async function loadModel() {
    statePill.textContent = "CHARGEMENT MODÈLE…";
    model = await cocoSsd.load({ base: "lite_mobilenet_v2" });
  }

  // ---------- boucle de détection ----------
  async function detectLoop() {
    if (!model || video.readyState < 2) return;
    let predictions = [];
    try {
      predictions = await model.detect(video, 10);
    } catch (e) { return; }

    const bikes = predictions.filter(
      (p) => p.class === "bicycle" && p.score >= minConfidence
    );

    drawOverlay(predictions, bikes);

    const now = performance.now();

    if (bikes.length > 0) {
      // on suit le vélo dont la boîte est la plus grande (le plus proche/pertinent)
      const target = bikes.reduce((a, b) => (b.bbox[3] > a.bbox[3] ? b : a));
      const heightPct = (target.bbox[3] / video.videoHeight) * 100;
      const centerXPct = ((target.bbox[0] + target.bbox[2] / 2) / video.videoWidth) * 100;

      history.push({ t: now, h: heightPct, cx: centerXPct });
      history = history.filter((p) => now - p.t <= HISTORY_WINDOW_MS);
      lastSeen = now;

      const growthRate = computeGrowthRate();
      updateHUD(target.class, target.score, heightPct);
      updateMiniRadar(centerXPct, heightPct);
      setLevel(classify(heightPct, growthRate));
    } else if (now - lastSeen > LOST_AFTER_MS) {
      history = [];
      updateHUD(null, null, null);
      updateMiniRadar(null, null);
      setLevel("scan");
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
  function drawOverlay(all, bikes) {
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    const sx = overlay.width / video.videoWidth;
    const sy = overlay.height / video.videoHeight;
    const mirrored = video.classList.contains("rear") === false;

    all.forEach((p) => {
      const isBike = p.class === "bicycle" && p.score >= minConfidence;
      if (!isBike && p.score < 0.5) return;
      let [x, y, w, h] = p.bbox;
      x *= sx; y *= sy; w *= sx; h *= sy;
      if (mirrored) x = overlay.width - x - w;

      ctx.lineWidth = isBike ? 2.5 : 1;
      ctx.strokeStyle = isBike ? levelColor(currentLevel) : "rgba(124,139,154,0.5)";
      ctx.strokeRect(x, y, w, h);

      if (isBike) {
        const label = `VÉLO ${Math.round(p.score * 100)}%`;
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
    metricObject.textContent = cls ? "VÉLO" : "—";
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
      detecte: "VÉLO DÉTECTÉ",
      vigilance: "VIGILANCE",
      alerte: "ALERTE — VÉLO PROCHE"
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

  // ---------- interactions ----------
  startBtn.addEventListener("click", async () => {
    gateError.textContent = "";
    startBtn.disabled = true;
    startBtn.textContent = "Initialisation…";
    try {
      await startCamera();
      if (!model) await loadModel();
      gate.classList.add("hidden");
      statePill.dataset.level = "scan";
      statePill.textContent = "SCAN — RAS";
      detectTimer = setInterval(detectLoop, 180); // ~5-6 détections/s
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

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wakeLock === null && stream) {
      navigator.wakeLock?.request("screen").then((wl) => (wakeLock = wl)).catch(() => {});
    }
  });

  // ---------- enregistrement du service worker ----------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
