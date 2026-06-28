/* ==========================================================
   Bullseye — Aim Trainer (v4)  ·  ChanceITstudio
   ----------------------------------------------------------
   Vanilla JS. No framework, no build step.

   MODES
   - Timed:    targets shrink over 3s then expire. Lose 1 life per
               expired target; 5 expired = game over (no score saved).
   - Tracking: targets move and have HP. Damage = points. Optional
               shields (always 1pt, absorb 1 hit). More than 5 targets
               on screen = game over (no score saved).

   SCORING:  outer = 1pt, center = 2pt. Center radius = 0.4 of target.
   HIGH SCORES: saved only on finishing a full 60s run.
               ranked by points > accuracy > center hits.

   v4 polish: 3·2·1 countdown, reaction-time tracking, synthesized
   sound + mute, floating impact readouts, pause/resume, persisted
   settings, new-best celebration.
   ========================================================== */

/* =========================
   1) DOM
   ========================= */
const stage = document.getElementById("stage");
const overlay = document.getElementById("overlay");
const countdownEl = document.getElementById("countdown");
const countdownNum = document.getElementById("countdownNum");

const pointsValue = document.getElementById("pointsValue");
const accuracyValue = document.getElementById("accuracyValue");
const reactValue = document.getElementById("reactValue");
const timeValue = document.getElementById("timeValue");
const livesValue = document.getElementById("livesValue");
const livesLabel = livesValue.parentElement.querySelector(".gauge__label");

const highTimedValue = document.getElementById("highTimedValue");
const highTrackingValue = document.getElementById("highTrackingValue");

const telemetryMode = document.getElementById("telemetryMode");
const telemetryStatus = document.getElementById("telemetryStatus");

const startBtn = document.getElementById("startBtn");
const restartBtn = document.getElementById("restartBtn"); // doubles as Pause/Resume
const muteBtn = document.getElementById("muteBtn");

const modeTimed = document.getElementById("modeTimed");
const modeTracking = document.getElementById("modeTracking");
const shieldsToggle = document.getElementById("shieldsToggle");
const trackingOptionsGroup = document.getElementById("trackingOptionsGroup");

const difficultySlider = document.getElementById("difficultySlider");
const difficultyTier = document.getElementById("difficultyTier");

/* =========================
   2) Constants
   ========================= */
const GAME_MS = 60_000;

// Timed mode
const TARGET_LIFETIME_MS = 3_000;
const EXPIRED_LIMIT = 5;

// Bullseye scoring geometry (locked)
const CENTER_RADIUS_RATIO = 0.4;

// Sizes
const TARGET_START_SIZE_MIN = 58;
const TARGET_START_SIZE_MAX = 84;
const TARGET_MIN_SIZE = 20;
const TRACKING_SIZE_MIN = 58;
const TRACKING_SIZE_MAX = 84;

// Tracking rules
const TRACKING_TARGET_HP = 4;
const TRACKING_SHIELD_HP = 2;
const TRACKING_OVERWHELM_LIMIT = 5;

// Reaction grading (ms)
const REACT_FAST = 300;
const REACT_SLOW = 450;

// Spawn curves (slider 1..10 lerps easy -> hard)
const CURVE_EASY = { maxMs: 2000, minMs: 550, rampPerSec: 3 };
const CURVE_HARD = { maxMs: 1200, minMs: 350, rampPerSec: 7.5 };
const TRACK_CURVE_EASY = { maxMs: 2600, minMs: 900, rampPerSec: 2.0 };
const TRACK_CURVE_HARD = { maxMs: 2000, minMs: 650, rampPerSec: 3.6 };

const TIERS = [
  "", "Relaxed", "Relaxed", "Steady", "Steady",
  "Sharp", "Sharp", "Rapid", "Rapid", "Brutal", "Insane",
];

// localStorage keys
const LS_KEY_TIMED = "bullseye_high_timed_v4";
const LS_KEY_TRACKING = "bullseye_high_tracking_v4";
const LS_KEY_SETTINGS = "bullseye_settings_v4";

/* =========================
   3) State
   ========================= */
let running = false;
let paused = false;
let countingDown = false;
let currentMode = "timed";

let startTimeMs = 0;
let lastTickMs = 0;
let pauseStartedMs = 0;

let rafId = null;
let spawnTimeoutId = null;
let countdownTimers = [];

// Stats
let points = 0;
let hitsOuter = 0;
let hitsCenter = 0;
let hitsShield = 0;
let clickMisses = 0;
let expiredMisses = 0;
let reactionSamples = [];

let targets = [];

let timedCurve = { ...CURVE_EASY };
let trackingCurve = { ...TRACK_CURVE_EASY };

let muted = false;

/* =========================
   4) Helpers
   ========================= */
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const lerp = (a, b, t) => a + (b - a) * t;
const formatPercent = (p) => `${(p * 100).toFixed(1)}%`;
const elapsedSeconds = (nowMs) => (nowMs - startTimeMs) / 1000;

function computeAccuracy() {
  const hits = hitsOuter + hitsCenter + hitsShield;
  const attempts = hits + clickMisses;
  return attempts === 0 ? 0 : hits / attempts;
}
function avgReaction() {
  if (reactionSamples.length === 0) return null;
  return Math.round(reactionSamples.reduce((a, b) => a + b, 0) / reactionSamples.length);
}
function bestReaction() {
  return reactionSamples.length ? Math.round(Math.min(...reactionSamples)) : null;
}
function currentTimeLeftMs() {
  if (!running) return GAME_MS;
  return GAME_MS - (performance.now() - startTimeMs);
}

/* =========================
   5) Sound (Web Audio, synthesized — no asset files)
   ========================= */
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      audioCtx = null;
    }
  }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}
function tone({ freq, dur = 0.08, type = "triangle", gain = 0.18, slideTo = null }) {
  if (muted || !audioCtx) return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const amp = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(amp).connect(audioCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}
const sfx = {
  outer: () => tone({ freq: 520, dur: 0.06, type: "square", gain: 0.12 }),
  center: () => tone({ freq: 880, slideTo: 1320, dur: 0.11, type: "triangle", gain: 0.18 }),
  shield: () => tone({ freq: 640, dur: 0.07, type: "sine", gain: 0.14 }),
  miss: () => tone({ freq: 150, dur: 0.09, type: "sine", gain: 0.16 }),
  expire: () => tone({ freq: 400, slideTo: 180, dur: 0.16, type: "sawtooth", gain: 0.12 }),
  over: () => {
    tone({ freq: 220, slideTo: 90, dur: 0.5, type: "sawtooth", gain: 0.16 });
  },
  newbest: () => {
    [660, 880, 1320].forEach((f, i) =>
      setTimeout(() => tone({ freq: f, dur: 0.14, type: "triangle", gain: 0.16 }), i * 110)
    );
  },
  tick: () => tone({ freq: 600, dur: 0.07, type: "square", gain: 0.1 }),
  go: () => tone({ freq: 1000, dur: 0.16, type: "triangle", gain: 0.16 }),
};

/* =========================
   6) Settings persistence
   ========================= */
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY_SETTINGS) || "{}");
    if (s.mode === "tracking") { modeTracking.checked = true; }
    else { modeTimed.checked = true; }
    if (typeof s.difficulty === "number") difficultySlider.value = String(clamp(s.difficulty, 1, 10));
    shieldsToggle.checked = !!s.shields;
    muted = !!s.muted;
  } catch {
    /* defaults already in HTML */
  }
}
function saveSettings() {
  const s = {
    mode: modeTracking.checked ? "tracking" : "timed",
    difficulty: Number(difficultySlider.value),
    shields: shieldsToggle.checked,
    muted,
  };
  try { localStorage.setItem(LS_KEY_SETTINGS, JSON.stringify(s)); } catch {}
}

/* =========================
   7) Difficulty
   ========================= */
function difficulty01() {
  return (Number(difficultySlider.value) - 1) / 9;
}
function applyDifficultyFromUI() {
  const diff = Number(difficultySlider.value);
  const t = difficulty01();

  timedCurve = {
    maxMs: Math.round(lerp(CURVE_EASY.maxMs, CURVE_HARD.maxMs, t)),
    minMs: Math.round(lerp(CURVE_EASY.minMs, CURVE_HARD.minMs, t)),
    rampPerSec: lerp(CURVE_EASY.rampPerSec, CURVE_HARD.rampPerSec, t),
  };
  trackingCurve = {
    maxMs: Math.round(lerp(TRACK_CURVE_EASY.maxMs, TRACK_CURVE_HARD.maxMs, t)),
    minMs: Math.round(lerp(TRACK_CURVE_EASY.minMs, TRACK_CURVE_HARD.minMs, t)),
    rampPerSec: lerp(TRACK_CURVE_EASY.rampPerSec, TRACK_CURVE_HARD.rampPerSec, t),
  };
  difficultyTier.textContent = TIERS[diff] || "Sharp";
}
function timedSpawnDelayMs(s) {
  return clamp(timedCurve.maxMs - s * timedCurve.rampPerSec, timedCurve.minMs, timedCurve.maxMs);
}
function trackingSpawnDelayMs(s) {
  return clamp(trackingCurve.maxMs - s * trackingCurve.rampPerSec, trackingCurve.minMs, trackingCurve.maxMs);
}

/* =========================
   8) High scores
   ========================= */
function loadRecord(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveRecord(key, record) {
  try { localStorage.setItem(key, JSON.stringify(record)); } catch {}
}
function isBetterScore(c, cur) {
  if (!cur) return true;
  if (c.points !== cur.points) return c.points > cur.points;
  if (c.accuracy !== cur.accuracy) return c.accuracy > cur.accuracy;
  return c.hitsCenter > cur.hitsCenter;
}
function formatDate(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "2-digit" }); }
  catch { return ""; }
}
function recordHTML(r) {
  if (!r) return `<span class="dim">no run yet</span>`;
  const react = r.reactBest ? ` · <span class="dim">${r.reactBest}ms</span>` : "";
  return `${r.points} pts · ${formatPercent(r.accuracy)}${react} <span class="dim">· ${formatDate(r.date)}</span>`;
}
function renderHighScores() {
  highTimedValue.innerHTML = recordHTML(loadRecord(LS_KEY_TIMED));
  highTrackingValue.innerHTML = recordHTML(loadRecord(LS_KEY_TRACKING));
}

/* =========================
   9) Overlay
   ========================= */
function showIntro() {
  const tracking = modeTracking.checked;
  const eyebrow = tracking ? "Tracking mode" : "Timed mode";
  const body = tracking
    ? [
        "Targets drift and carry HP — every hit is damage, every point is progress.",
        "Center hits land 2, outer hits land 1. Shields, if on, soak one hit for a flat point.",
        "Let more than <strong>5 targets</strong> crowd the field and the run ends.",
      ]
    : [
        "Targets shrink and vanish after 3 seconds — drop them before they do.",
        "Center hits score <strong>2</strong>, outer hits score <strong>1</strong>.",
        "Five targets slip away and the run ends. No score saved.",
      ];
  showOverlay({ eyebrow, title: "Bullseye", lines: body, hint: keyHint() });
}
function keyHint() {
  return `<kbd>Space</kbd> start · <kbd>P</kbd> pause · <kbd>Esc</kbd> stop`;
}
function showOverlay({ eyebrow = "", title, lines = [], results = null, hint = "", titleClass = "" }) {
  overlay.style.display = "grid";
  const para = lines.map((t) => `<p class="overlay__text">${t}</p>`).join("");
  const resultsHTML = results
    ? `<div class="results">${results
        .map((c) => `<div class="results__cell"><div class="results__k">${c.k}</div><div class="results__v" style="${c.color ? `color:${c.color}` : ""}">${c.v}</div></div>`)
        .join("")}</div>`
    : "";
  overlay.innerHTML = `
    <div class="overlay__card">
      ${eyebrow ? `<div class="overlay__eyebrow">${eyebrow}</div>` : ""}
      <h1 class="overlay__title ${titleClass}">${title}</h1>
      ${para}
      ${resultsHTML}
      ${hint ? `<p class="overlay__hint">${hint}</p>` : ""}
    </div>`;
}
function hideOverlay() { overlay.style.display = "none"; }

/* =========================
   10) HUD
   ========================= */
function updateHUD(timeLeftMs) {
  pointsValue.textContent = String(points);
  accuracyValue.textContent = formatPercent(computeAccuracy());

  const avg = avgReaction();
  reactValue.textContent = avg === null ? "—" : String(avg);

  timeValue.textContent = Math.max(0, (timeLeftMs ?? currentTimeLeftMs()) / 1000).toFixed(1);

  if (currentMode === "timed") {
    livesLabel.textContent = "Lives";
    livesValue.textContent = String(Math.max(0, EXPIRED_LIMIT - expiredMisses));
  } else {
    livesLabel.textContent = "Slots";
    livesValue.textContent = String(Math.max(0, TRACKING_OVERWHELM_LIMIT - targets.length));
  }
}
function pulse(el) {
  el.classList.remove("is-pulse");
  void el.offsetWidth; // restart animation
  el.classList.add("is-pulse");
}
function setStatus(text) { telemetryStatus.textContent = text; }

/* =========================
   11) Impact FX
   ========================= */
function spawnFX(x, y, text, kind) {
  const el = document.createElement("div");
  el.className = `fx fx--${kind}`;
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  stage.appendChild(el);
  setTimeout(() => el.remove(), 650);
}
function stageMissFlash() {
  stage.classList.remove("is-miss");
  void stage.offsetWidth;
  stage.classList.add("is-miss");
}

/* =========================
   12) Targets
   ========================= */
function recordReaction(target, x, y) {
  if (target.firstHitAt != null) return; // only first hit counts
  target.firstHitAt = performance.now();
  const ms = Math.round(target.firstHitAt - target.bornAtMs);
  reactionSamples.push(ms);
  pulse(reactValue);
  const slow = ms >= REACT_SLOW;
  spawnFX(x, y + 18, `${ms}ms`, slow ? "react is-slow" : "react");
}

function makeTargetElement({ id, x, y, size, shieldOn }) {
  const el = document.createElement("div");
  el.className = "target";
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty("--size", `${size}px`);
  el.innerHTML = `<img class="target__bullseye" src="bullseye.svg" alt="" draggable="false" />`;
  if (shieldOn) el.classList.add("has-shield");

  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!running || paused || countingDown) return;

    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
    const isCenterHit = dist <= (rect.width / 2) * CENTER_RADIUS_RATIO;
    const hitPoints = isCenterHit ? 2 : 1;

    // FX position relative to the stage
    const stageRect = stage.getBoundingClientRect();
    const fxX = e.clientX - stageRect.left;
    const fxY = e.clientY - stageRect.top;

    const t = targets.find((tt) => tt.id === id);
    if (!t) return;

    if (currentMode === "timed") {
      if (isCenterHit) { hitsCenter += 1; points += 2; sfx.center(); spawnFX(fxX, fxY, "+2", "center"); }
      else { hitsOuter += 1; points += 1; sfx.outer(); spawnFX(fxX, fxY, "+1", "outer"); }
      recordReaction(t, fxX, fxY);
      pulse(pointsValue);
      removeTargetById(id);
      updateHUD(currentTimeLeftMs());
      return;
    }

    // Tracking
    if (t.shieldHp > 0) {
      hitsShield += 1; points += 1; t.shieldHp -= 1;
      sfx.shield(); spawnFX(fxX, fxY, "SHIELD", "shield");
      recordReaction(t, fxX, fxY);
      if (t.shieldHp === 1) t.el.classList.add("weak");
      if (t.shieldHp <= 0) t.el.classList.remove("has-shield", "weak");
    } else {
      if (isCenterHit) { hitsCenter += 1; sfx.center(); spawnFX(fxX, fxY, "+2", "center"); }
      else { hitsOuter += 1; sfx.outer(); spawnFX(fxX, fxY, "+1", "outer"); }
      points += hitPoints;
      t.hp -= hitPoints;
      recordReaction(t, fxX, fxY);
      if (t.hp <= 0) removeTargetById(id);
    }
    pulse(pointsValue);
    updateHUD(currentTimeLeftMs());
  });

  return el;
}

function removeTargetById(id) {
  const idx = targets.findIndex((t) => t.id === id);
  if (idx === -1) return;
  targets[idx].el.remove();
  targets.splice(idx, 1);
}
function clearAllTargets() {
  for (const t of targets) t.el.remove();
  targets = [];
}

/* =========================
   13) Mode updates
   ========================= */
function updateTargetsTimed(nowMs) {
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];
    const progress = clamp((nowMs - t.bornAtMs) / TARGET_LIFETIME_MS, 0, 1);
    const size = t.startSize + (TARGET_MIN_SIZE - t.startSize) * progress;
    t.el.style.setProperty("--size", `${size}px`);

    if (nowMs >= t.expiresAtMs) {
      expiredMisses += 1;
      sfx.expire();
      t.el.remove();
      targets.splice(i, 1);
      if (expiredMisses >= EXPIRED_LIMIT) { endGame("overwhelmed"); return; }
    }
  }
}
function updateTargetsTracking(dtSec) {
  const rect = stage.getBoundingClientRect();
  for (const t of targets) {
    t.x += t.vx * dtSec;
    t.y += t.vy * dtSec;
    const r = t.size / 2;
    if (t.x < r) { t.x = r; t.vx *= -1; }
    else if (t.x > rect.width - r) { t.x = rect.width - r; t.vx *= -1; }
    if (t.y < r) { t.y = r; t.vy *= -1; }
    else if (t.y > rect.height - r) { t.y = rect.height - r; t.vy *= -1; }
    t.el.style.left = `${t.x}px`;
    t.el.style.top = `${t.y}px`;
  }
}

/* =========================
   14) Spawning
   ========================= */
function spawnTargetTimed() {
  if (!running || paused) return;
  const rect = stage.getBoundingClientRect();
  const startSize = randInt(TARGET_START_SIZE_MIN, TARGET_START_SIZE_MAX);
  const pad = startSize / 2 + 6;
  const x = randInt(Math.floor(pad), Math.floor(rect.width - pad));
  const y = randInt(Math.floor(pad), Math.floor(rect.height - pad));
  const id = crypto.randomUUID?.() ?? String(Date.now() + Math.random());
  const now = performance.now();
  const el = makeTargetElement({ id, x, y, size: startSize, shieldOn: false });
  stage.appendChild(el);
  targets.push({ id, el, bornAtMs: now, expiresAtMs: now + TARGET_LIFETIME_MS, startSize, firstHitAt: null });
}
function scheduleNextSpawnTimed() {
  if (!running || paused) return;
  spawnTimeoutId = setTimeout(() => {
    spawnTargetTimed();
    scheduleNextSpawnTimed();
  }, timedSpawnDelayMs(elapsedSeconds(performance.now())));
}
function spawnTargetTracking() {
  if (!running || paused) return;
  const rect = stage.getBoundingClientRect();
  const size = randInt(TRACKING_SIZE_MIN, TRACKING_SIZE_MAX);
  const pad = size / 2 + 6;
  const x = randInt(Math.floor(pad), Math.floor(rect.width - pad));
  const y = randInt(Math.floor(pad), Math.floor(rect.height - pad));
  const speed = randInt(80, 150);
  const angle = Math.random() * Math.PI * 2;
  const id = crypto.randomUUID?.() ?? String(Date.now() + Math.random());
  const shieldOn = !!shieldsToggle.checked;
  const el = makeTargetElement({ id, x, y, size, shieldOn });
  stage.appendChild(el);
  targets.push({
    id, el, x, y,
    vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    size, hp: TRACKING_TARGET_HP, shieldHp: shieldOn ? TRACKING_SHIELD_HP : 0,
    bornAtMs: performance.now(), firstHitAt: null,
  });
  updateHUD(currentTimeLeftMs());
  if (targets.length > TRACKING_OVERWHELM_LIMIT) endGame("overwhelmed");
}
function scheduleNextSpawnTracking() {
  if (!running || paused) return;
  spawnTimeoutId = setTimeout(() => {
    spawnTargetTracking();
    scheduleNextSpawnTracking();
  }, trackingSpawnDelayMs(elapsedSeconds(performance.now())));
}

/* =========================
   15) Start / countdown / end
   ========================= */
function resetStats() {
  points = 0; hitsOuter = 0; hitsCenter = 0; hitsShield = 0;
  clickMisses = 0; expiredMisses = 0; reactionSamples = [];
}

function startGame() {
  ensureAudio();
  stopEverything();            // clean any prior run/countdown
  currentMode = modeTracking.checked ? "tracking" : "timed";
  applyDifficultyFromUI();
  resetStats();
  clearAllTargets();
  hideOverlay();

  telemetryMode.textContent = currentMode.toUpperCase();
  updateHUD(GAME_MS);

  startBtn.disabled = true;
  startBtn.textContent = "Restart";
  restartBtn.disabled = true;
  paused = false;

  runCountdown(() => {
    running = true;
    startBtn.disabled = false; // allow Restart during run
    restartBtn.disabled = false;
    restartBtn.textContent = "Pause";
    setStatus("LIVE");
    startTimeMs = performance.now();
    lastTickMs = startTimeMs;
    if (currentMode === "timed") scheduleNextSpawnTimed();
    else scheduleNextSpawnTracking();
    rafId = requestAnimationFrame(tick);
  });
}

function runCountdown(onDone) {
  countingDown = true;
  setStatus("GET READY");
  countdownEl.classList.remove("is-hidden");
  const steps = ["3", "2", "1"];
  steps.forEach((n, i) => {
    countdownTimers.push(setTimeout(() => {
      countdownNum.textContent = n;
      countdownNum.style.animation = "none";
      void countdownNum.offsetWidth;
      countdownNum.style.animation = "";
      sfx.tick();
    }, i * 700));
  });
  countdownTimers.push(setTimeout(() => {
    countingDown = false;
    countdownEl.classList.add("is-hidden");
    sfx.go();
    onDone();
  }, steps.length * 700));
}

function endGame(reason) {
  if (!running) return;
  running = false;
  paused = false;
  clearTimers();
  clearAllTargets();

  startBtn.disabled = false;
  startBtn.textContent = "Start";
  restartBtn.disabled = true;
  restartBtn.textContent = "Pause";
  setStatus("STANDBY");

  const acc = computeAccuracy();
  const record = {
    points, accuracy: acc, hitsCenter,
    reactBest: bestReaction(), date: new Date().toISOString(),
  };
  const modeLabel = currentMode === "timed" ? "Timed" : "Tracking";

  if (reason === "finished") {
    const key = currentMode === "timed" ? LS_KEY_TIMED : LS_KEY_TRACKING;
    const prev = loadRecord(key);
    const isNewBest = isBetterScore(record, prev);
    if (isNewBest) { saveRecord(key, record); sfx.newbest(); }
    else { sfx.over(); }
    renderHighScores();

    // Report the completed run up to the games hub (no-op when not embedded).
    window.HubBridge?.score({ mode: currentMode, points, accuracy: acc, reactBest: bestReaction() });
    window.HubBridge?.event("run_finished", { mode: currentMode });

    const results = [
      { k: "Points", v: points, color: "var(--signal)" },
      { k: "Accuracy", v: formatPercent(acc) },
      { k: "Avg react", v: avgReaction() === null ? "—" : `${avgReaction()}ms`, color: "var(--lock)" },
      { k: "Best react", v: bestReaction() === null ? "—" : `${bestReaction()}ms` },
      { k: "Center", v: hitsCenter },
      currentMode === "tracking"
        ? { k: "Shield hits", v: hitsShield }
        : { k: "Expired", v: expiredMisses },
    ];

    showOverlay({
      eyebrow: `${modeLabel} · complete`,
      title: isNewBest ? "New best!" : "Time!",
      titleClass: isNewBest ? "is-best" : "",
      results,
      hint: keyHint(),
    });
  } else if (reason === "overwhelmed") {
    sfx.over();
    showOverlay({
      eyebrow: `${modeLabel} · run ended`,
      title: "Game over",
      titleClass: "is-over",
      lines: [
        currentMode === "timed"
          ? `You let <strong>${EXPIRED_LIMIT}</strong> targets expire.`
          : `More than <strong>${TRACKING_OVERWHELM_LIMIT}</strong> targets crowded the field.`,
        "Scores only save when you finish all 60 seconds.",
      ],
      hint: keyHint(),
    });
  } else {
    showIntro();
  }
  updateHUD(0);
}

/* =========================
   16) Pause / stop plumbing
   ========================= */
function clearTimers() {
  if (spawnTimeoutId) { clearTimeout(spawnTimeoutId); spawnTimeoutId = null; }
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}
function clearCountdown() {
  countdownTimers.forEach(clearTimeout);
  countdownTimers = [];
  countingDown = false;
  countdownEl.classList.add("is-hidden");
}
function stopEverything() {
  clearTimers();
  clearCountdown();
}

function togglePause() {
  if (!running) return;
  if (!paused) {
    paused = true;
    pauseStartedMs = performance.now();
    clearTimers();
    restartBtn.textContent = "Resume";
    setStatus("PAUSED");
    showOverlay({
      eyebrow: "Paused",
      title: "Paused",
      lines: ["Run is frozen — the clock waits for you."],
      hint: `<kbd>P</kbd> resume · <kbd>Esc</kbd> stop`,
    });
  } else {
    paused = false;
    hideOverlay();
    // shift the clock forward by the paused duration so time-left is fair
    const pausedFor = performance.now() - pauseStartedMs;
    startTimeMs += pausedFor;
    lastTickMs = performance.now();
    restartBtn.textContent = "Pause";
    setStatus("LIVE");
    if (currentMode === "timed") scheduleNextSpawnTimed();
    else scheduleNextSpawnTracking();
    rafId = requestAnimationFrame(tick);
  }
}

function stopRun() {
  if (!running && !countingDown) return;
  if (countingDown) { stopEverything(); }
  running = false;
  paused = false;
  stopEverything();
  clearAllTargets();
  startBtn.disabled = false;
  startBtn.textContent = "Start";
  restartBtn.disabled = true;
  restartBtn.textContent = "Pause";
  setStatus("STANDBY");
  showIntro();
  updateHUD(GAME_MS);
}

/* =========================
   17) Main tick
   ========================= */
function tick(nowMs) {
  if (!running || paused) return;
  const timeLeft = GAME_MS - (nowMs - startTimeMs);
  if (timeLeft <= 0) { updateHUD(0); endGame("finished"); return; }

  const dtSec = (nowMs - lastTickMs) / 1000;
  lastTickMs = nowMs;

  if (currentMode === "timed") updateTargetsTimed(nowMs);
  else updateTargetsTracking(dtSec);

  updateHUD(timeLeft);
  rafId = requestAnimationFrame(tick);
}

/* =========================
   18) Events
   ========================= */
stage.addEventListener("pointerdown", () => {
  if (!running || paused || countingDown) return;
  clickMisses += 1;
  sfx.miss();
  stageMissFlash();
  updateHUD(currentTimeLeftMs());
});

startBtn.addEventListener("click", startGame);

restartBtn.addEventListener("click", () => {
  if (running) togglePause();
});

muteBtn.addEventListener("click", () => {
  ensureAudio();
  muted = !muted;
  muteBtn.classList.toggle("is-muted", muted);
  muteBtn.setAttribute("aria-label", muted ? "Sound off" : "Sound on");
  if (!muted) sfx.tick();
  saveSettings();
});

difficultySlider.addEventListener("input", () => { applyDifficultyFromUI(); saveSettings(); });

function syncControls() {
  const tracking = modeTracking.checked;
  trackingOptionsGroup.classList.toggle("is-hidden", !tracking);
  telemetryMode.textContent = tracking ? "TRACKING" : "TIMED";
  if (!running && !countingDown) showIntro();
  saveSettings();
}
modeTimed.addEventListener("change", syncControls);
modeTracking.addEventListener("change", syncControls);
shieldsToggle.addEventListener("change", saveSettings);

// Keyboard: Space/Enter start, P pause, Esc stop
window.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA"].includes(e.target.tagName);
  if (e.code === "Space" || e.code === "Enter") {
    if (typing || e.target.tagName === "BUTTON") return; // let buttons handle their own
    if (!running && !countingDown) { e.preventDefault(); startGame(); }
  } else if (e.key.toLowerCase() === "p") {
    if (running) { e.preventDefault(); togglePause(); }
  } else if (e.key === "Escape") {
    if (running || countingDown) { e.preventDefault(); stopRun(); }
  }
});

/* =========================
   19) Boot
   ========================= */
loadSettings();
applyDifficultyFromUI();
renderHighScores();
muteBtn.classList.toggle("is-muted", muted);
syncControls();
updateHUD(GAME_MS);