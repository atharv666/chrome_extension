// ===== Focus Flow - Popup Logic =====

const app = document.getElementById("app");

// Preset educational sites for quick-add
const PRESETS = [
  { label: "Wikipedia", domain: "wikipedia.org" },
  { label: "Khan Academy", domain: "khanacademy.org" },
  { label: "YouTube", domain: "youtube.com" },
  { label: "Stack Overflow", domain: "stackoverflow.com" },
  { label: "GitHub", domain: "github.com" },
  { label: "Coursera", domain: "coursera.org" },
];

// State for session setup
let allowedSites = [];
let timerInterval = null;

// ===== Utilities =====

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function cleanDomain(input) {
  let domain = input.trim().toLowerCase();
  // Remove protocol
  domain = domain.replace(/^https?:\/\//, "");
  // Remove www.
  domain = domain.replace(/^www\./, "");
  // Remove trailing slash and path
  domain = domain.replace(/\/.*$/, "");
  // Remove port
  domain = domain.replace(/:\d+$/, "");
  return domain;
}

function isValidDomain(domain) {
  if (!domain || domain.length < 3) return false;
  // Basic domain validation: at least one dot, no spaces, valid chars
  const pattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
  return pattern.test(domain);
}

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function formatTimeLarge(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const pad = (n) => String(n).padStart(2, "0");

  if (hours > 0) {
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(minutes)}:${pad(seconds)}`;
}

function computeFocusScore(totalElapsed, distractionTime) {
  if (totalElapsed <= 0) return 100;
  const focused = Math.max(0, totalElapsed - distractionTime);
  return Math.round((focused / totalElapsed) * 100);
}

// ===== Entry Point =====

async function init() {
  const { user, session } = await chrome.storage.local.get(["user", "session"]);

  if (!user) {
    showOnboarding();
  } else if (session && session.active) {
    showActiveSession(session, user);
  } else {
    showMain(user);
  }
}

// ===== Screen: Onboarding =====

function showOnboarding() {
  app.innerHTML = `
    <div class="screen">
      <div class="header">
        <div class="brand">Focus Flow</div>
        <h1>Welcome</h1>
        <p class="subtitle">Let's get you set up for focused study sessions.</p>
      </div>

      <div class="form-group">
        <label>Name</label>
        <input type="text" id="name" placeholder="Your name">
      </div>
      <div class="form-group">
        <label>College</label>
        <input type="text" id="college" placeholder="Your college or university">
      </div>
      <div class="form-group">
        <label>Course</label>
        <input type="text" id="course" placeholder="Your course or major">
      </div>
      <div class="form-group">
        <label>Year</label>
        <input type="text" id="year" placeholder="e.g., 2nd Year">
      </div>

      <div id="onboard-error" class="validation-msg error" style="display:none; margin-bottom:10px;"></div>

      <button class="btn btn-primary" id="save">Get Started</button>
    </div>
  `;

  document.getElementById("save").onclick = () => {
    const name = document.getElementById("name").value.trim();
    const college = document.getElementById("college").value.trim();
    const course = document.getElementById("course").value.trim();
    const year = document.getElementById("year").value.trim();

    const errorEl = document.getElementById("onboard-error");

    if (!name) {
      errorEl.textContent = "Please enter your name to continue.";
      errorEl.style.display = "block";
      document.getElementById("name").focus();
      return;
    }

    const data = { name, college, course, year };
    chrome.storage.local.set({ user: data }, () => showMain(data));
  };
}

// ===== Screen: Main Menu =====

function showMain(user) {
  app.innerHTML = `
    <div class="screen">
      <div class="header">
        <div class="brand">Focus Flow</div>
        <h1>Hi, ${escapeHtml(user.name)}</h1>
        <p class="subtitle">Ready to focus on what matters?</p>
      </div>

      <button class="btn btn-primary" id="start-btn">Start Focus Session</button>
      <button class="btn btn-ghost" id="close-btn">Not right now</button>
    </div>
  `;

  document.getElementById("start-btn").onclick = showSessionSetup;
  document.getElementById("close-btn").onclick = () => window.close();
}

// ===== Screen: Session Setup =====

function showSessionSetup() {
  allowedSites = [];

  app.innerHTML = `
    <div class="screen">
      <div class="header">
        <div class="brand">Focus Flow</div>
        <h1>Set Up Session</h1>
        <p class="subtitle">Choose your topic and the sites you'll need.</p>
      </div>

      <div class="form-group">
        <label>What are you studying?</label>
        <input type="text" id="topic" placeholder="e.g., Linear Algebra, React Hooks...">
      </div>

      <div class="divider"></div>

      <div class="section-label">Quick Add</div>
      <div class="preset-chips" id="presets"></div>

      <div class="section-label">Add Custom Site</div>
      <div class="input-group">
        <input type="text" id="site-input" placeholder="e.g., docs.python.org">
        <button class="btn-add" id="add-site-btn">+ Add</button>
      </div>
      <div id="site-error" class="validation-msg error" style="display:none;"></div>

      <div class="site-list" id="site-list"></div>

      <div id="start-error" class="validation-msg error" style="display:none; margin-bottom:10px;"></div>

      <button class="btn btn-primary" id="start-session-btn">Start Session</button>
      <button class="btn btn-ghost" id="back-btn">Back</button>
    </div>
  `;

  renderPresets();
  renderSiteList();

  // Add site via button click
  document.getElementById("add-site-btn").onclick = addSiteFromInput;

  // Add site via Enter key
  document.getElementById("site-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addSiteFromInput();
  });

  // Clear error on input
  document.getElementById("site-input").addEventListener("input", () => {
    document.getElementById("site-error").style.display = "none";
  });

  // Start session
  document.getElementById("start-session-btn").onclick = handleStartSession;

  // Back button
  document.getElementById("back-btn").onclick = async () => {
    const { user } = await chrome.storage.local.get(["user"]);
    showMain(user);
  };
}

function renderPresets() {
  const container = document.getElementById("presets");
  if (!container) return;

  container.innerHTML = PRESETS.map((p) => {
    const isAdded = allowedSites.includes(p.domain);
    return `<button class="preset-chip ${isAdded ? "added" : ""}" 
              data-domain="${p.domain}" 
              ${isAdded ? "disabled" : ""}>
              ${isAdded ? "&#10003; " : "+ "}${p.label}
            </button>`;
  }).join("");

  container.querySelectorAll(".preset-chip:not(.added)").forEach((chip) => {
    chip.onclick = () => {
      const domain = chip.dataset.domain;
      if (!allowedSites.includes(domain)) {
        allowedSites.push(domain);
        renderPresets();
        renderSiteList();
        clearStartError();
      }
    };
  });
}

function renderSiteList() {
  const container = document.getElementById("site-list");
  if (!container) return;

  if (allowedSites.length === 0) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = allowedSites
    .map(
      (site, i) => `
      <div class="site-item">
        <span class="site-name">${escapeHtml(site)}</span>
        <button class="site-remove" data-index="${i}" title="Remove">&times;</button>
      </div>
    `
    )
    .join("");

  container.querySelectorAll(".site-remove").forEach((btn) => {
    btn.onclick = () => {
      const index = parseInt(btn.dataset.index);
      allowedSites.splice(index, 1);
      renderPresets();
      renderSiteList();
    };
  });
}

function addSiteFromInput() {
  const input = document.getElementById("site-input");
  const errorEl = document.getElementById("site-error");
  const raw = input.value.trim();

  if (!raw) {
    errorEl.textContent = "Please enter a website domain.";
    errorEl.style.display = "block";
    input.focus();
    return;
  }

  const domain = cleanDomain(raw);

  if (!isValidDomain(domain)) {
    errorEl.textContent = "That doesn't look like a valid domain. Try something like: example.com";
    errorEl.style.display = "block";
    input.focus();
    return;
  }

  if (allowedSites.includes(domain)) {
    errorEl.textContent = "This site is already in your list.";
    errorEl.style.display = "block";
    input.focus();
    return;
  }

  allowedSites.push(domain);
  input.value = "";
  errorEl.style.display = "none";
  renderPresets();
  renderSiteList();
  clearStartError();
  input.focus();
}

function clearStartError() {
  const el = document.getElementById("start-error");
  if (el) el.style.display = "none";
}

async function handleStartSession() {
  const topic = document.getElementById("topic").value.trim();
  const errorEl = document.getElementById("start-error");

  if (!topic) {
    errorEl.textContent = "Please enter what you're studying.";
    errorEl.style.display = "block";
    document.getElementById("topic").focus();
    return;
  }

  if (allowedSites.length === 0) {
    errorEl.textContent = "Add at least one allowed website before starting.";
    errorEl.style.display = "block";
    return;
  }

  const session = {
    active: true,
    topic: topic,
    allowedSites: [...allowedSites],
    startTime: Date.now(),
  };

  await chrome.storage.local.set({ session });

  // Tell background to update badge
  chrome.runtime.sendMessage({ action: "sessionStarted" });

  showSuccessScreen(session);
}

// ===== Screen: Success (Session Started) =====

function showSuccessScreen(session) {
  app.innerHTML = `
    <div class="screen" style="text-align:center;">
      <div class="success-icon">&#10003;</div>

      <h2>Session Active</h2>
      <p style="margin-bottom:16px;">Your focus session has started. Stay on track!</p>

      <div class="success-details">
        <div class="success-detail-row">
          <span class="label">Topic</span>
           <span class="value">${escapeHtml(session.topic)}</span>
        </div>
        <div class="success-detail-row">
          <span class="label">Allowed Sites</span>
          <span class="value">${session.allowedSites.length} site${session.allowedSites.length !== 1 ? "s" : ""}</span>
        </div>
      </div>

      <button class="btn btn-primary" id="got-it-btn">Got it</button>
    </div>
  `;

  document.getElementById("got-it-btn").onclick = () => window.close();
}

// ===== Screen: Active Session Dashboard =====

function showActiveSession(session, user) {
  const elapsed = Date.now() - (session.startTime || Date.now());
  const stats = session.distractionStats || { count: 0, totalTime: 0, choices: { angel: 0, devil: 0 } };

  app.innerHTML = `
    <div class="screen">
      <div class="session-status">
        <div class="status-dot"></div>
        <span class="status-text">Session Active</span>
      </div>

      <div class="session-timer">
        <div class="time" id="timer-display">${formatTimeLarge(elapsed)}</div>
        <div class="time-label">Focus Time</div>
      </div>

      <div class="session-stats" id="session-stats">
        <div class="stat-item">
          <div class="stat-value" id="stat-distractions">${stats.count}</div>
          <div class="stat-label">Distractions</div>
        </div>
        <div class="stat-item">
          <div class="stat-value" id="stat-distraction-time">${formatTime(stats.totalTime)}</div>
          <div class="stat-label">Time Lost</div>
        </div>
        <div class="stat-item">
          <div class="stat-value" id="stat-focus-score">${computeFocusScore(elapsed, stats.totalTime)}%</div>
          <div class="stat-label">Focus Score</div>
        </div>
      </div>

      <div class="session-topic">
        <div class="topic-label">Studying</div>
        <div class="topic-value">${escapeHtml(session.topic)}</div>
      </div>

      <div class="session-sites-header">
        <h3>Allowed Sites</h3>
        <button class="add-more-btn" id="toggle-add-site">+ Add more</button>
      </div>

      <div id="add-site-area"></div>

      <div class="session-sites-list" id="active-site-list">
        ${(session.allowedSites || [])
          .map((s) => `<div class="session-site-item">${escapeHtml(s)}</div>`)
          .join("")}
      </div>

      <button class="btn btn-danger" id="end-session-btn">End Session</button>
    </div>
  `;

  // Live timer + stats update
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(async () => {
    const el = document.getElementById("timer-display");
    if (!el) {
      clearInterval(timerInterval);
      return;
    }
    const now = Date.now() - (session.startTime || Date.now());
    el.textContent = formatTimeLarge(now);

    // Refresh distraction stats from storage
    const { session: freshSession } = await chrome.storage.local.get(["session"]);
    if (freshSession && freshSession.distractionStats) {
      const s = freshSession.distractionStats;
      const dEl = document.getElementById("stat-distractions");
      const tEl = document.getElementById("stat-distraction-time");
      const fEl = document.getElementById("stat-focus-score");
      if (dEl) dEl.textContent = s.count;
      if (tEl) tEl.textContent = formatTime(s.totalTime);
      if (fEl) fEl.textContent = computeFocusScore(now, s.totalTime) + "%";
    }
  }, 1000);

  // Add more sites toggle
  document.getElementById("toggle-add-site").onclick = () => {
    const area = document.getElementById("add-site-area");
    if (area.innerHTML) {
      area.innerHTML = "";
      return;
    }
    area.innerHTML = `
      <div class="add-site-inline">
        <div class="input-group">
          <input type="text" id="active-site-input" placeholder="e.g., docs.python.org">
          <button class="btn-add" id="active-add-btn">+ Add</button>
        </div>
        <div id="active-site-error" class="validation-msg error" style="display:none;"></div>
      </div>
    `;

    const addFn = () => addSiteToActiveSession(session);
    document.getElementById("active-add-btn").onclick = addFn;
    document.getElementById("active-site-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addFn();
    });
    document.getElementById("active-site-input").focus();
  };

  // End session
  document.getElementById("end-session-btn").onclick = () => endSession(session, user);
}

async function addSiteToActiveSession(session) {
  const input = document.getElementById("active-site-input");
  const errorEl = document.getElementById("active-site-error");
  const raw = input.value.trim();

  if (!raw) {
    errorEl.textContent = "Please enter a website domain.";
    errorEl.style.display = "block";
    return;
  }

  const domain = cleanDomain(raw);

  if (!isValidDomain(domain)) {
    errorEl.textContent = "Invalid domain format. Try: example.com";
    errorEl.style.display = "block";
    return;
  }

  if (session.allowedSites.includes(domain)) {
    errorEl.textContent = "Already in your allowed list.";
    errorEl.style.display = "block";
    return;
  }

  session.allowedSites.push(domain);
  await chrome.storage.local.set({ session });

  // Re-render site list
  const list = document.getElementById("active-site-list");
  list.innerHTML = session.allowedSites
    .map((s) => `<div class="session-site-item">${escapeHtml(s)}</div>`)
    .join("");

  input.value = "";
  errorEl.style.display = "none";
  input.focus();
}

async function endSession(session, user) {
  const elapsed = Date.now() - (session.startTime || Date.now());

  // Fetch fresh session data (content.js may have updated distractionStats)
  const { session: freshSession } = await chrome.storage.local.get(["session"]);
  const stats = (freshSession && freshSession.distractionStats) || session.distractionStats || null;

  // Save to session history before removing
  await saveSessionHistory(session.topic, elapsed, session.startTime, stats);

  await chrome.storage.local.remove("session");

  // Tell background to clear badge
  chrome.runtime.sendMessage({ action: "sessionEnded" });

  if (timerInterval) clearInterval(timerInterval);

  showSessionSummary(elapsed, session.topic, user, stats);
}

// ===== Screen: Session Summary =====

function showSessionSummary(duration, topic, user, stats) {
  const focusScore = stats ? computeFocusScore(duration, stats.totalTime) : 100;
  const distractionCount = stats ? stats.count : 0;
  const distractionTime = stats ? stats.totalTime : 0;

  app.innerHTML = `
    <div class="screen" style="text-align:center;">
      <div class="success-icon" style="background:#FFF0EB;">&#127942;</div>

      <h2>Great work!</h2>
      <p style="margin-bottom:16px;">Here's how your session went.</p>

      <div class="success-details">
        <div class="success-detail-row">
          <span class="label">Topic</span>
          <span class="value">${escapeHtml(topic)}</span>
        </div>
        <div class="success-detail-row">
          <span class="label">Total Time</span>
          <span class="value">${formatTime(duration)}</span>
        </div>
        <div class="success-detail-row">
          <span class="label">Focus Score</span>
          <span class="value">${focusScore}%</span>
        </div>
        <div class="success-detail-row">
          <span class="label">Distractions</span>
          <span class="value">${distractionCount}</span>
        </div>
        ${distractionTime > 0 ? `
        <div class="success-detail-row">
          <span class="label">Time Lost</span>
          <span class="value">${formatTime(distractionTime)}</span>
        </div>
        ` : ""}
      </div>

      <button class="btn btn-primary" id="new-session-btn">Start Another Session</button>
      <button class="btn btn-ghost" id="done-btn">Done</button>
    </div>
  `;

  document.getElementById("new-session-btn").onclick = showSessionSetup;
  document.getElementById("done-btn").onclick = () => window.close();
}

// ===== Session History =====

async function saveSessionHistory(topic, duration, startTime, stats) {
  const { sessionHistory = [] } = await chrome.storage.local.get(["sessionHistory"]);

  sessionHistory.push({
    topic,
    duration,
    startTime,
    endTime: Date.now(),
    focusScore: stats ? computeFocusScore(duration, stats.totalTime) : 100,
    distractions: stats ? stats.count : 0,
    distractionTime: stats ? stats.totalTime : 0,
  });

  // Keep last 50 sessions to avoid storage bloat
  if (sessionHistory.length > 50) {
    sessionHistory.splice(0, sessionHistory.length - 50);
  }

  await chrome.storage.local.set({ sessionHistory });
}

// ===== Initialize =====

init();
