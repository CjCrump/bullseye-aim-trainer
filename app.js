/* ==========================================================
   Bullseye — Aim Trainer (v3) ✅ Timed + Tracking + Shields
   ----------------------------------------------------------
   TIMED MODE:
   - Targets shrink for 3s then expire
   - If 5 targets expire (not clicked) => GAME OVER (no score saved)
   - Spawn curve controlled by slider (difficulty 1..10)

   TRACKING MODE:
   - Targets move (no shrinking)
   - Target HP = 4
   - Center hit = 2 points = 2 damage
   - Outer hit = 1 point = 1 damage
   - Shields optional (toggle):
       Shield HP = 2
       While shieldHp > 0:
         - ANY hit = 1 point
         - Shield takes 1 damage
         - Shield hits count as hits for accuracy
   - Overwhelm rule:
       if targets on screen > 5 => GAME OVER (no score saved)

   HIGH SCORES:
   - Saved ONLY if you finish full 60s without game over
   - Comparison: points > accuracy > center hits

   Assets expected:
   - bullseye.svg
   - shield.svg
   ========================================================== */

/* =========================
   1) DOM
   ========================= */
const stage = document.getElementById("stage");
const overlay = document.getElementById("overlay");

const pointsValue = document.getElementById("pointsValue");
const accuracyValue = document.getElementById("accuracyValue");
const timeValue = document.getElementById("timeValue");
const expiredMissesValue = document.getElementById("expiredMissesValue");

const highTimedValue = document.getElementById("highTimedValue");
const highTrackingValue = document.getElementById("highTrackingValue");

const hitsOuterValue = document.getElementById("hitsOuterValue");
const hitsCenterValue = document.getElementById("hitsCenterValue");
const clickMissesValue = document.getElementById("clickMissesValue");

// You added this span in index.html ✅
const hitsShieldValue = document.getElementById("hitsShieldValue");

const startBtn = document.getElementById("startBtn");
const restartBtn = document.getElementById("restartBtn");

const modeTimed = document.getElementById("modeTimed");
const modeTracking = document.getElementById("modeTracking");
const shieldsToggle = document.getElementById("shieldsToggle");
const trackingOptionsGroup = document.getElementById("trackingOptionsGroup");

const difficultySlider = document.getElementById("difficultySlider");
const difficultyValue = document.getElementById("difficultyValue");
const difficultyHint = document.getElementById("difficultyHint");

/* =========================
   2) Constants
   ========================= */
const GAME_MS = 60_000;

// Timed mode target behavior
const TARGET_LIFETIME_MS = 3_000;
const EXPIRED_LIMIT = 5;

// Bullseye math (locked)
const CENTER_RADIUS_RATIO = 0.4;

// Timed visual sizes
const TARGET_START_SIZE_MIN = 58;
const TARGET_START_SIZE_MAX = 84;
const TARGET_MIN_SIZE = 20;

// Tracking visual sizes
const TRACKING_SIZE_MIN = 58;
const TRACKING_SIZE_MAX = 84;

// Tracking rules
const TRACKING_TARGET_HP = 4;
const TRACKING_SHIELD_HP = 2;
const TRACKING_OVERWHELM_LIMIT = 5; // if > 5 targets on screen => game over

// LocalStorage keys (versioned)
const LS_KEY_TIMED = "bullseye_high_timed_v3";
const LS_KEY_TRACKING = "bullseye_high_tracking_v3";

/*
  Timed spawn curve slider (1..10):
  You picked:
    easy = 2000,550,3
    hard = 1200,350,7.5
*/
const CURVE_EASY = { maxMs: 2000, minMs: 550, rampPerSec: 3 };
const CURVE_HARD = { maxMs: 1200, minMs: 350, rampPerSec: 7.5 };

/* Tracking spawn curve (intentionally slower than timed) */
const TRACK_CURVE_EASY = { maxMs: 2600, minMs: 900, rampPerSec: 2.0 };
const TRACK_CURVE_HARD = { maxMs: 2000, minMs: 650, rampPerSec: 3.6 };

/* =========================
   3) State
   ========================= */
let running = false;
let currentMode = "timed"; // "timed" | "tracking"

let startTimeMs = 0;
let lastTickMs = 0;

let rafId = null;
let spawnTimeoutId = null;

// Stats
let points = 0;
let hitsOuter = 0;
let hitsCenter = 0;
let hitsShield = 0; // ✅ shield hits count as hits
let clickMisses = 0;
let expiredMisses = 0;

// Targets (one array used for both modes)
// Timed target fields: { id, el, bornAtMs, expiresAtMs, startSize }
// Tracking target fields: { id, el, x, y, vx, vy, size, hp, shieldHp }
let targets = [];

// Current curves (computed from slider)
let timedCurve = { ...CURVE_EASY };
let trackingCurve = { ...TRACK_CURVE_EASY };

/* =========================
   4) Helpers
   ========================= */
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function formatPercent(p) {
  return `${(p * 100).toFixed(1)}%`;
}

function elapsedSeconds(nowMs) {
  return (nowMs - startTimeMs) / 1000;
}

function computeAccuracy() {
  const hitsTotal = hitsOuter + hitsCenter + hitsShield;
  const attempts = hitsTotal + clickMisses;
  if (attempts === 0) return 0;
  return hitsTotal / attempts;
}

function currentTimeLeftMs() {
  if (!running) return GAME_MS;
  const now = performance.now();
  return GAME_MS - (now - startTimeMs);
}

/* =========================
   5) Difficulty slider -> curves
   ========================= */
function difficulty01() {
  // slider 1..10 -> t 0..1
  const diff = Number(difficultySlider.value);
  return (diff - 1) / 9;
}

function applyDifficultyFromUI() {
  const diff = Number(difficultySlider.value);
  const t = difficulty01();

  timedCurve = {
    maxMs: Math.round(lerp(CURVE_EASY.maxMs, CURVE_HARD.maxMs, t)),
    minMs: Math.round(lerp(CURVE_EASY.minMs, CURVE_HARD.minMs, t)),
    rampPerSec: lerp(CURVE_EASY.rampPerSec, CURVE_HARD.rampPerSec, t),
  };

  // Tracking also scales with the same slider, but stays slower overall
  trackingCurve = {
    maxMs: Math.round(lerp(TRACK_CURVE_EASY.maxMs, TRACK_CURVE_HARD.maxMs, t)),
    minMs: Math.round(lerp(TRACK_CURVE_EASY.minMs, TRACK_CURVE_HARD.minMs, t)),
    rampPerSec: lerp(TRACK_CURVE_EASY.rampPerSec, TRACK_CURVE_HARD.rampPerSec, t),
  };

  difficultyValue.textContent = String(diff);

  // Show exact numbers so tuning is transparent
  difficultyHint.textContent =
    `Timed: start ${timedCurve.maxMs}ms • min ${timedCurve.minMs}ms • ramp ${timedCurve.rampPerSec.toFixed(1)}ms/s` +
    ` | Tracking: start ${trackingCurve.maxMs}ms • min ${trackingCurve.minMs}ms • ramp ${trackingCurve.rampPerSec.toFixed(1)}ms/s`;
}

function timedSpawnDelayMs(elapsedSec) {
  const delay = timedCurve.maxMs - elapsedSec * timedCurve.rampPerSec;
  return clamp(delay, timedCurve.minMs, timedCurve.maxMs);
}

function trackingSpawnDelayMs(elapsedSec) {
  const delay = trackingCurve.maxMs - elapsedSec * trackingCurve.rampPerSec;
  return clamp(delay, trackingCurve.minMs, trackingCurve.maxMs);
}

/* =========================
   6) High score helpers
   ========================= */
function loadRecord(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveRecord(key, record) {
  localStorage.setItem(key, JSON.stringify(record));
}

// Compare: points > accuracy > center hits
function isBetterScore(candidate, current) {
  if (!current) return true;
  if (candidate.points !== current.points) return candidate.points > current.points;
  if (candidate.accuracy !== current.accuracy) return candidate.accuracy > current.accuracy;
  return candidate.hitsCenter > current.hitsCenter;
}

function formatDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
  } catch {
    return "";
  }
}

function renderHighScores() {
  const timed = loadRecord(LS_KEY_TIMED);
  const tracking = loadRecord(LS_KEY_TRACKING);

  highTimedValue.textContent = timed
    ? `${timed.points} pts • ${formatPercent(timed.accuracy)} • C:${timed.hitsCenter} • ${formatDate(timed.date)}`
    : "—";

  highTrackingValue.textContent = tracking
    ? `${tracking.points} pts • ${formatPercent(tracking.accuracy)} • C:${tracking.hitsCenter} • ${formatDate(tracking.date)}`
    : "—";
}

/* =========================
   7) Overlay
   ========================= */
function showOverlay(title, lines = []) {
  overlay.style.display = "grid";

  const paragraphs = lines.map((t) => `<p class="overlay__text">${t}</p>`).join("");

  overlay.innerHTML = `
    <div class="overlay__card">
      <h1 class="overlay__title">${title}</h1>
      ${paragraphs}
      <p class="overlay__hint">Press <strong>Start</strong> to play.</p>
    </div>
  `;
}

function hideOverlay() {
  overlay.style.display = "none";
}

/* =========================
   8) HUD
   ========================= */
function updateHUD(timeLeftMs) {
  pointsValue.textContent = String(points);
  accuracyValue.textContent = formatPercent(computeAccuracy());
  expiredMissesValue.textContent = String(expiredMisses);

  hitsOuterValue.textContent = String(hitsOuter);
  hitsCenterValue.textContent = String(hitsCenter);
  clickMissesValue.textContent = String(clickMisses);

  if (hitsShieldValue) hitsShieldValue.textContent = String(hitsShield);

  const secs = Math.max(0, timeLeftMs / 1000);
  timeValue.textContent = secs.toFixed(1);
}

/* =========================
   9) Target DOM creation
   ========================= */
function makeTargetElement({ id, x, y, size, shieldOn }) {
  const el = document.createElement("div");
  el.className = "target";

  // Hide shield layer via class unless shield is active
  if (!shieldOn) el.classList.add("is-shield-off");

  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.setProperty("--size", `${size}px`);

  el.innerHTML = `
    <img class="target__bullseye" src="bullseye.svg" alt="" draggable="false" />
  `;
  if (shieldOn) el.classList.add("has-shield");

  // Use pointerdown everywhere to keep accuracy correct
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (!running) return;

    // Determine hit region by distance from center
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const dx = e.clientX - cx;
    const dy = e.clientY - cy;

    const dist = Math.sqrt(dx * dx + dy * dy);
    const outerRadius = rect.width / 2;
    const centerRadius = outerRadius * CENTER_RADIUS_RATIO;

    const isCenterHit = dist <= centerRadius;
    const hitPoints = isCenterHit ? 2 : 1;

    if (currentMode === "timed") {
      // Timed scoring: normal points and delete immediately
      if (isCenterHit) {
        hitsCenter += 1;
        points += 2;
      } else {
        hitsOuter += 1;
        points += 1;
      }

      removeTargetById(id);
      updateHUD(currentTimeLeftMs());
      return;
    }

    // TRACKING MODE: points = damage (with shield rule)
    const t = targets.find((x) => x.id === id);
    if (!t) return;

    if (t.shieldHp > 0) {
      // Shield absorbs: ALWAYS 1 point, counts as a hit for accuracy
      hitsShield += 1;
      points += 1;
      t.shieldHp -= 1;

      // If shield breaks, hide overlay
      if (t.shieldHp <= 0) {
          t.el.classList.remove("has-shield");
        }

    } else {
      // No shield: points = damage
      if (isCenterHit) hitsCenter += 1;
      else hitsOuter += 1;

      points += hitPoints;
      t.hp -= hitPoints;

      if (t.shieldHp === 1) {
          t.el.classList.add("weak");
        }


      if (t.hp <= 0) {
        removeTargetById(id);
      }
    }

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
   10) Timed mode update
   ========================= */
function updateTargetsTimed(nowMs) {
  for (let i = targets.length - 1; i >= 0; i--) {
    const t = targets[i];

    const age = nowMs - t.bornAtMs;
    const progress = clamp(age / TARGET_LIFETIME_MS, 0, 1);

    const size = t.startSize + (TARGET_MIN_SIZE - t.startSize) * progress;
    t.el.style.setProperty("--size", `${size}px`);

    if (nowMs >= t.expiresAtMs) {
      expiredMisses += 1;
      t.el.remove();
      targets.splice(i, 1);

      if (expiredMisses >= EXPIRED_LIMIT) {
        endGame("overwhelmed");
        return;
      }
    }
  }
}

/* =========================
   11) Tracking mode update (movement)
   ========================= */
function updateTargetsTracking(dtSec) {
  const rect = stage.getBoundingClientRect();

  for (const t of targets) {
    t.x += t.vx * dtSec;
    t.y += t.vy * dtSec;

    // Bounce off walls with padding based on radius
    const r = t.size / 2;

    if (t.x < r) {
      t.x = r;
      t.vx *= -1;
    } else if (t.x > rect.width - r) {
      t.x = rect.width - r;
      t.vx *= -1;
    }

    if (t.y < r) {
      t.y = r;
      t.vy *= -1;
    } else if (t.y > rect.height - r) {
      t.y = rect.height - r;
      t.vy *= -1;
    }

    t.el.style.left = `${t.x}px`;
    t.el.style.top = `${t.y}px`;
  }
}

/* =========================
   12) Spawning
   ========================= */
function spawnTargetTimed() {
  if (!running) return;

  const rect = stage.getBoundingClientRect();
  const startSize = randInt(TARGET_START_SIZE_MIN, TARGET_START_SIZE_MAX);

  const pad = startSize / 2 + 4;
  const x = randInt(Math.floor(pad), Math.floor(rect.width - pad));
  const y = randInt(Math.floor(pad), Math.floor(rect.height - pad));

  const id = crypto.randomUUID?.() ?? String(Date.now() + Math.random());
  const now = performance.now();

  const el = makeTargetElement({
    id,
    x,
    y,
    size: startSize,
    shieldOn: false,
  });

  stage.appendChild(el);

  targets.push({
    id,
    el,
    bornAtMs: now,
    expiresAtMs: now + TARGET_LIFETIME_MS,
    startSize,
  });
}

function scheduleNextSpawnTimed() {
  if (!running) return;

  const delay = timedSpawnDelayMs(elapsedSeconds(performance.now()));

  spawnTimeoutId = setTimeout(() => {
    spawnTargetTimed();
    scheduleNextSpawnTimed();
  }, delay);
}

function spawnTargetTracking() {
  if (!running) return;

  const rect = stage.getBoundingClientRect();
  const size = randInt(TRACKING_SIZE_MIN, TRACKING_SIZE_MAX);

  const pad = size / 2 + 4;
  const x = randInt(Math.floor(pad), Math.floor(rect.width - pad));
  const y = randInt(Math.floor(pad), Math.floor(rect.height - pad));

  // Velocity in px/sec (feel free to tune)
  const speed = randInt(80, 150);
  const angle = Math.random() * Math.PI * 2;
  const vx = Math.cos(angle) * speed;
  const vy = Math.sin(angle) * speed;

  const id = crypto.randomUUID?.() ?? String(Date.now() + Math.random());

  const shieldOn = !!shieldsToggle.checked;

  const el = makeTargetElement({
    id,
    x,
    y,
    size,
    shieldOn,
  });

  stage.appendChild(el);

  targets.push({
    id,
    el,
    x,
    y,
    vx,
    vy,
    size,
    hp: TRACKING_TARGET_HP,
    shieldHp: shieldOn ? TRACKING_SHIELD_HP : 0,
  });

  // Overwhelm rule for tracking
  if (targets.length > TRACKING_OVERWHELM_LIMIT) {
    endGame("overwhelmed");
  }
}

function scheduleNextSpawnTracking() {
  if (!running) return;

  const delay = trackingSpawnDelayMs(elapsedSeconds(performance.now()));

  spawnTimeoutId = setTimeout(() => {
    spawnTargetTracking();
    scheduleNextSpawnTracking();
  }, delay);
}

/* =========================
   13) Start / End
   ========================= */
function resetStats() {
  points = 0;
  hitsOuter = 0;
  hitsCenter = 0;
  hitsShield = 0;
  clickMisses = 0;
  expiredMisses = 0;
}

function startGame() {
  currentMode = modeTimed.checked ? "timed" : "tracking";
  applyDifficultyFromUI();

  running = true;
  resetStats();
  clearAllTargets();

  startBtn.disabled = true;
  restartBtn.disabled = false;

  hideOverlay();

  startTimeMs = performance.now();
  lastTickMs = startTimeMs;

  if (currentMode === "timed") {
    scheduleNextSpawnTimed();
  } else {
    scheduleNextSpawnTracking();
  }

  rafId = requestAnimationFrame(tick);
}

function endGame(reason) {
  if (!running) return;

  running = false;

  if (spawnTimeoutId) {
    clearTimeout(spawnTimeoutId);
    spawnTimeoutId = null;
  }
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  startBtn.disabled = false;
  restartBtn.disabled = false;

  clearAllTargets();

  const acc = computeAccuracy();
  const record = {
    points,
    accuracy: acc,
    hitsCenter,
    date: new Date().toISOString(),
  };

  const modeLabel = currentMode === "timed" ? "Timed" : "Tracking";

  if (reason === "finished") {
    const key = currentMode === "timed" ? LS_KEY_TIMED : LS_KEY_TRACKING;
    const currentHigh = loadRecord(key);

    if (isBetterScore(record, currentHigh)) {
      saveRecord(key, record);
    }

    renderHighScores();

    showOverlay(`${modeLabel} — Time!`, [
      `Points: <strong>${points}</strong>`,
      `Accuracy: <strong>${formatPercent(acc)}</strong>`,
      `Center hits: <strong>${hitsCenter}</strong>`,
      currentMode === "tracking"
        ? `Shield hits: <strong>${hitsShield}</strong>`
        : `Expired targets: <strong>${expiredMisses}</strong>`,
      "Score saved only if it beat your high score.",
    ]);
  } else if (reason === "overwhelmed") {
    showOverlay(`${modeLabel} — GAME OVER`, [
      currentMode === "timed"
        ? `You let <strong>${EXPIRED_LIMIT}</strong> targets expire.`
        : `You exceeded <strong>${TRACKING_OVERWHELM_LIMIT}</strong> targets on screen.`,
      "Scores are <strong>not recorded</strong> unless you finish all 60 seconds.",
    ]);
  } else {
    showOverlay(`${modeLabel} — Run Ended`, ["Run ended early."]);
  }

  updateHUD(0);
}

/* =========================
   14) Main Tick
   ========================= */
function tick(nowMs) {
  if (!running) return;

  const elapsed = nowMs - startTimeMs;
  const timeLeft = GAME_MS - elapsed;

  if (timeLeft <= 0) {
    updateHUD(0);
    endGame("finished");
    return;
  }

  const dtSec = (nowMs - lastTickMs) / 1000;
  lastTickMs = nowMs;

  if (currentMode === "timed") {
    updateTargetsTimed(nowMs);
  } else {
    updateTargetsTracking(dtSec);
  }

  updateHUD(timeLeft);
  rafId = requestAnimationFrame(tick);
}

/* =========================
   15) Events
   ========================= */

// Stage miss clicks (counts toward accuracy as misses)
stage.addEventListener("pointerdown", () => {
  if (!running) return;
  clickMisses += 1;
  updateHUD(currentTimeLeftMs());
});

startBtn.addEventListener("click", startGame);

restartBtn.addEventListener("click", () => {
  if (running) endGame("restart");
  startGame();
});

difficultySlider.addEventListener("input", applyDifficultyFromUI);

function syncControls() {
  const trackingSelected = modeTracking.checked;

  // Show tracking options only if tracking is selected
  trackingOptionsGroup.classList.toggle("is-hidden", !trackingSelected);

  // Overlay message when not running
  if (!running) {
    if (trackingSelected) {
      showOverlay("Bullseye — Tracking Mode", [
        "Targets move and have HP.",
        "Points = damage.",
        "Optional shields: shield hits are always 1 point.",
        "Lose if more than 5 targets are on screen.",
      ]);
    } else {
      showOverlay("Bullseye — Timed Mode", [
        "Targets shrink and expire after 3 seconds.",
        "If 5 targets expire, it’s game over (no score saved).",
        "Scoring: Outer = 1, Center = 2.",
      ]);
    }
  }
}

modeTimed.addEventListener("change", syncControls);
modeTracking.addEventListener("change", syncControls);

/* =========================
   16) Boot
   ========================= */
applyDifficultyFromUI();
renderHighScores();
syncControls();
updateHUD(GAME_MS);
