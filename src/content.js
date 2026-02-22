import { initParsingCollector } from "./parsing/collector.js";
import { parseGeneralPageContent } from "./parsing/text-parser.js";
import gsap from "gsap";

// ===== Focus Flow - Content Script =====
// Injected into every page. Handles:
// 1. Inactivity detection (only during active sessions on allowed sites)
// 2. Progressive distraction intervention (timer → popup → mascots)

const FF_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const FF_DIALOG_FONT = "'Avenir Next', 'Segoe UI', 'Trebuchet MS', sans-serif";
const FF_BG = "#FFFCF9";
const FF_TEXT = "#2D2D2D";
const FF_TEXT_LIGHT = "#7A7A7A";
const FF_TEXT_MUTED = "#ABABAB";
const FF_PRIMARY = "#F47D5B";
const FF_PRIMARY_HOVER = "#E06A48";
const FF_BORDER = "#F0EDE9";
const FF_SUCCESS = "#6BCF7F";

// Mascot image URLs (resolved from extension root)
const DEVIL_IMG_URL = chrome.runtime.getURL("icons/devil.png");
const ANGEL_IMG_URL = chrome.runtime.getURL("icons/angel.png");

// ===== State =====

let isSessionActive = false;
let sessionTopic = "";
let currentAllowedSites = [];
let isCurrentSiteAllowed = false;

// Inactivity state
let inactivityTimer = null;
let lastActivity = Date.now();
const ALLOWED_SITE_IDLE_LIMIT = 15000; // requested cadence: every 15 seconds when idle
const INACTIVITY_ACTIVITY_EVENTS = [
  "mousemove",
  "keydown",
  "scroll",
  "wheel",
  "click",
  "touchstart",
];
const OFFTOPIC_WARNING_DELAY_MS = 5000;
let inactivityRemainingMs = ALLOWED_SITE_IDLE_LIMIT;

// Distraction state
const DISTRACTION_STAGE = {
  NONE: 0,
  COUNTDOWN_1: 1,
  PROMPT_1: 2,
  COUNTDOWN_2: 3,
  MASCOT: 4,
};

let distractionStage = DISTRACTION_STAGE.NONE;
let distractionCountdown = null;
let distractionSecondsLeft = 0;
let currentDistractedSite = null;
let distractionStartedAt = null; // timestamp when current distraction began
const DISTRACTION_LIMIT = 10; // 10 seconds per stage (for testing)
let distractionRecorded = false;

let pageIsVisible = document.visibilityState === "visible";
let aiInterventionVisible = false;
const offTopicFlow = {
  active: false,
  site: null,
  phase: 0,
  retryCount: 0,
  warningTimer: null,
  mascotTimer: null,
  retryTimer: null,
  pendingIntervention: null,
};

// ===== CSS Animation Injection =====

let animationsInjected = false;

function injectAnimationStyles() {
  if (animationsInjected) return;
  animationsInjected = true;

  const style = document.createElement("style");
  style.id = "focus-flow-styles";
  style.textContent = `
    @keyframes ffFadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes ffScaleIn {
      from { opacity: 0; transform: scale(0.92); }
      to { opacity: 1; transform: scale(1); }
    }
    @keyframes ffSlideUp {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes ffPulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }
    @keyframes ffBubbleIn {
      from { opacity: 0; transform: translateY(8px) scale(0.95); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* Responsive mascot sizing */
    @media (max-width: 600px) {
      .ff-mascot-img {
        width: 240px !important;
        height: 240px !important;
      }
      .ff-speech-bubble {
        max-width: 240px !important;
        font-size: 16px !important;
        padding: 10px 13px !important;
        bottom: 220px !important;
        left: 50% !important;
        right: auto !important;
        transform: translateX(-50%) !important;
      }
      .ff-bubble-angel {
        left: 50% !important;
        right: auto !important;
        transform: translateX(-50%) !important;
      }
      .ff-bubble-devil {
        left: 50% !important;
        right: auto !important;
        transform: translateX(-50%) !important;
      }
      .ff-mascot-devil {
        left: 10px !important;
        bottom: -20px !important;
      }
      .ff-mascot-angel {
        right: 10px !important;
        bottom: -20px !important;
      }
      .ff-choice-prompt {
        font-size: 14px !important;
        top: 40px !important;
      }
      .ff-choice-arrow-left {
        left: 16% !important;
      }
      .ff-choice-arrow-right {
        right: 16% !important;
      }
    }
  `;
  document.documentElement.appendChild(style);
}

// ===== Utility: Remove any Focus Flow overlay =====

function removeOverlay() {
  const el = document.getElementById("ff-overlay");
  if (el) el.remove();
  aiInterventionVisible = false;
}

function removeTimerNotification() {
  const el = document.getElementById("ff-timer-notif");
  if (el) el.remove();
}

function ensureCountdownSeconds() {
  if (!Number.isFinite(distractionSecondsLeft) || distractionSecondsLeft <= 0) {
    distractionSecondsLeft = DISTRACTION_LIMIT;
  }
}

function getCurrentHostname() {
  try {
    return new URL(window.location.href).hostname;
  } catch {
    return "";
  }
}

function normalizeAllowedSite(site) {
  const value = String(site || "").trim().toLowerCase();
  if (!value) return "";

  let normalized = value
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");

  return normalized;
}

function matchesAllowedSite(hostname, allowedSites = []) {
  const normalizedHost = normalizeAllowedSite(hostname);
  return allowedSites.some((site) => {
    const normalizedSite = normalizeAllowedSite(site);
    if (!normalizedSite) return false;
    return normalizedHost === normalizedSite || normalizedHost.endsWith(`.${normalizedSite}`);
  });
}

function syncAllowedSiteState() {
  const hostname = getCurrentHostname();
  isCurrentSiteAllowed = matchesAllowedSite(hostname, currentAllowedSites);
}

function refreshInactivityDetection() {
  if (isCurrentSiteAllowed) {
    clearOffTopicFlow();
  }
  if (!isSessionActive || !isCurrentSiteAllowed || distractionStage !== DISTRACTION_STAGE.NONE) {
    cleanupInactivityDetection();
    return;
  }
  initInactivityDetection();
}

function clearOffTopicFlow() {
  offTopicFlow.active = false;
  offTopicFlow.site = null;
  offTopicFlow.phase = 0;
  offTopicFlow.retryCount = 0;
  offTopicFlow.pendingIntervention = null;
  if (offTopicFlow.warningTimer) {
    clearTimeout(offTopicFlow.warningTimer);
    offTopicFlow.warningTimer = null;
  }
  if (offTopicFlow.mascotTimer) {
    clearTimeout(offTopicFlow.mascotTimer);
    offTopicFlow.mascotTimer = null;
  }
  if (offTopicFlow.retryTimer) {
    clearTimeout(offTopicFlow.retryTimer);
    offTopicFlow.retryTimer = null;
  }
}

function scheduleOffTopicRetry() {
  if (!offTopicFlow.active || offTopicFlow.retryCount >= 1) return;
  offTopicFlow.retryCount += 1;
  offTopicFlow.retryTimer = setTimeout(() => {
    if (!offTopicFlow.active || aiInterventionVisible) return;
    const event = buildAiEventSnapshot({
      trigger_type: "offtopic_site_retry",
      is_allowed: false,
      site: offTopicFlow.site,
    });
    requestAiInterventionNow("offtopic_site", "mascot_chat", event);
  }, 12000);
}

function requestAiInterventionNow(triggerType, preferredIntervention, event = {}) {
  chrome.runtime.sendMessage({
    action: "requestAiInterventionNow",
    payload: {
      triggerType,
      preferredIntervention,
      event,
    },
  });
}

function buildAiEventSnapshot(extra = {}) {
  const parsed = parseGeneralPageContent();
  return {
    timestamp: Date.now(),
    url: parsed.page.url,
    domain: parsed.page.domain,
    page_title: parsed.page.page_title,
    is_allowed: isCurrentSiteAllowed,
    inactivity_seconds: Math.floor((Date.now() - lastActivity) / 1000),
    content: {
      headings: parsed.content?.top_headings || [],
      summary: parsed.content?.visible_text_summary || "",
      word_count: parsed.content?.word_count || 0,
    },
    metadata: parsed.metadata || {},
    ...extra,
  };
}

function showOffTopicWarningOverlay(site) {
  if (!offTopicFlow.active || !pageIsVisible) return;
  const overlay = createOverlay(0.5);
  const card = createCard("380px");
  card.appendChild(createIcon("&#9888;", "#FFF4E8"));
  card.appendChild(createHeading("Off-topic site detected"));
  card.appendChild(
    createParagraph(
      `You opened ${site}. If this isn't needed for ${sessionTopic || "your study goal"}, switch back now.`
    )
  );

  const btnRow = document.createElement("div");
  Object.assign(btnRow.style, {
    display: "flex",
    gap: "8px",
    justifyContent: "center",
  });

  const keepBtn = createButton("Keep Being Distracted", false);
  keepBtn.onclick = () => {
    overlay.remove();
    offTopicFlow.phase = 2;
    if (offTopicFlow.mascotTimer) clearTimeout(offTopicFlow.mascotTimer);
    offTopicFlow.mascotTimer = setTimeout(() => {
      if (!offTopicFlow.active || aiInterventionVisible) return;
      const event = buildAiEventSnapshot({
        trigger_type: "offtopic_site",
        is_allowed: false,
        site,
        warning_shown: true,
        user_choice: "keep_distracted",
      });
      requestAiInterventionNow("offtopic_site", "mascot_chat", event);
      scheduleOffTopicRetry();
      if (offTopicFlow.pendingIntervention) {
        showAiMascotConversation(offTopicFlow.pendingIntervention);
        offTopicFlow.pendingIntervention = null;
      }
    }, 5000);
  };

  const backBtn = createButton("Go Back to Study");
  backBtn.onclick = () => {
    clearOffTopicFlow();
    overlay.remove();
    chrome.runtime.sendMessage({ action: "closeTab" });
  };

  btnRow.appendChild(keepBtn);
  btnRow.appendChild(backBtn);
  card.appendChild(btnRow);
  overlay.appendChild(card);
  document.documentElement.appendChild(overlay);
}

function startOffTopicFlow(site) {
  if (!isSessionActive || isCurrentSiteAllowed) return;
  if (offTopicFlow.active && offTopicFlow.site === site) return;

  clearOffTopicFlow();
  offTopicFlow.active = true;
  offTopicFlow.site = site;
  offTopicFlow.phase = 1;

  cleanupDistraction();
  cleanupInactivityDetection(false);

  offTopicFlow.warningTimer = setTimeout(() => {
    if (!offTopicFlow.active || offTopicFlow.site !== site) return;
    showOffTopicWarningOverlay(site);
  }, OFFTOPIC_WARNING_DELAY_MS);

  offTopicFlow.mascotTimer = null;
}

// ===== Utility: Create base overlay =====

function createOverlay(bgOpacity = 0.55) {
  removeOverlay();
  injectAnimationStyles();

  const overlay = document.createElement("div");
  overlay.id = "ff-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    background: `rgba(0, 0, 0, ${bgOpacity})`,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    zIndex: "2147483647",
    fontFamily: FF_FONT,
    animation: "ffFadeIn 0.3s ease",
  });

  return overlay;
}

function createCard(maxWidth = "380px") {
  const card = document.createElement("div");
  Object.assign(card.style, {
    background: FF_BG,
    padding: "36px 32px",
    borderRadius: "16px",
    textAlign: "center",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.25)",
    maxWidth: maxWidth,
    width: "90%",
    animation: "ffScaleIn 0.3s ease",
  });
  return card;
}

function createIcon(emoji, bgColor = "#FFF0EB") {
  const icon = document.createElement("div");
  Object.assign(icon.style, {
    width: "56px",
    height: "56px",
    margin: "0 auto 16px",
    background: bgColor,
    borderRadius: "50%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "24px",
  });
  icon.innerHTML = emoji;
  return icon;
}

function createHeading(text) {
  const h = document.createElement("h2");
  Object.assign(h.style, {
    fontSize: "20px",
    fontWeight: "600",
    color: FF_TEXT,
    margin: "0 0 8px 0",
  });
  h.textContent = text;
  return h;
}

function createParagraph(text, color = FF_TEXT_LIGHT) {
  const p = document.createElement("p");
  Object.assign(p.style, {
    fontSize: "14px",
    color: color,
    margin: "0 0 20px 0",
    lineHeight: "1.5",
  });
  p.textContent = text;
  return p;
}

function createButton(text, isPrimary = true) {
  const btn = document.createElement("button");
  Object.assign(btn.style, {
    padding: "12px 24px",
    fontSize: "14px",
    fontWeight: "600",
    fontFamily: FF_FONT,
    border: isPrimary ? "none" : `1.5px solid ${FF_BORDER}`,
    borderRadius: "10px",
    cursor: "pointer",
    transition: "all 0.25s ease",
    background: isPrimary ? FF_PRIMARY : "transparent",
    color: isPrimary ? "white" : FF_TEXT_LIGHT,
    margin: "4px",
  });

  btn.textContent = text;

  if (isPrimary) {
    btn.onmouseover = () => {
      btn.style.background = FF_PRIMARY_HOVER;
      btn.style.transform = "translateY(-1px)";
    };
    btn.onmouseout = () => {
      btn.style.background = FF_PRIMARY;
      btn.style.transform = "translateY(0)";
    };
  } else {
    btn.onmouseover = () => {
      btn.style.borderColor = FF_TEXT_MUTED;
      btn.style.color = FF_TEXT;
    };
    btn.onmouseout = () => {
      btn.style.borderColor = FF_BORDER;
      btn.style.color = FF_TEXT_LIGHT;
    };
  }

  return btn;
}

function sendInterventionTelemetry(type, meta = {}) {
  chrome.runtime.sendMessage({
    action: "parseBatch",
    payload: {
      type: "ai_intervention_event",
      event_type: type,
      topic: sessionTopic || "",
      page_url: window.location.href,
      page_title: document.title,
      timestamp: Date.now(),
      ...meta,
    },
  });
}

let flashcardAudio = null;
let flashcardAudioPrimed = false;
let flashcardAudioCtx = null;
let flashcardAudioBuffer = null;
let flashcardAudioLoading = false;

function getFlashcardAudio() {
  if (flashcardAudio) return flashcardAudio;
  try {
    const audioUrl = chrome.runtime.getURL("fahhhhh.mp3");
    flashcardAudio = new Audio(audioUrl);
    flashcardAudio.preload = "auto";
    flashcardAudio.volume = 0.9;
  } catch {
    flashcardAudio = null;
  }
  return flashcardAudio;
}

function getFlashcardAudioContext() {
  if (flashcardAudioCtx) return flashcardAudioCtx;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    flashcardAudioCtx = new Ctx();
    return flashcardAudioCtx;
  } catch {
    return null;
  }
}

async function preloadFlashcardAudioBuffer() {
  if (flashcardAudioBuffer || flashcardAudioLoading) return;
  const ctx = getFlashcardAudioContext();
  if (!ctx) return;

  flashcardAudioLoading = true;
  try {
    const audioUrl = chrome.runtime.getURL("fahhhhh.mp3");
    const response = await fetch(audioUrl);
    const arrayBuffer = await response.arrayBuffer();
    flashcardAudioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    flashcardAudioBuffer = null;
  } finally {
    flashcardAudioLoading = false;
  }
}

function playFlashcardViaAudioBuffer() {
  const ctx = getFlashcardAudioContext();
  if (!ctx || !flashcardAudioBuffer) return;

  const start = () => {
    try {
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      gain.gain.value = 0.9;
      source.buffer = flashcardAudioBuffer;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start(0);
      flashcardAudioPrimed = true;
    } catch (error) {
      console.warn("Focus Flow: flashcard buffer playback failed", error);
    }
  };

  if (ctx.state === "suspended") {
    ctx.resume().then(start).catch(() => {});
  } else {
    start();
  }
}

function warmFlashcardAudioAssets() {
  getFlashcardAudio();
  preloadFlashcardAudioBuffer();
}

function playFlashcardShownSound() {
  const audio = getFlashcardAudio();
  if (!audio) {
    playFlashcardViaAudioBuffer();
    return;
  }

  try {
    audio.pause();
    audio.currentTime = 0;
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.then === "function") {
      playPromise.then(() => {
        flashcardAudioPrimed = true;
      });
    }
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((error) => {
        console.warn("Focus Flow: flashcard audio blocked", error);
        playFlashcardViaAudioBuffer();
      });
    }
  } catch (error) {
    console.warn("Focus Flow: flashcard audio failed", error);
    playFlashcardViaAudioBuffer();
  }
}

function primeFlashcardAudioFromGesture() {
  warmFlashcardAudioAssets();

  const audio = getFlashcardAudio();
  const ctx = getFlashcardAudioContext();

  if (ctx && ctx.state === "suspended") {
    ctx.resume().then(() => {
      flashcardAudioPrimed = true;
    }).catch(() => {});
  }

  if (flashcardAudioPrimed || !audio) return;

  try {
    audio.muted = true;
    const playPromise = audio.play();
    if (playPromise && typeof playPromise.then === "function") {
      playPromise
        .then(() => {
          audio.pause();
          audio.currentTime = 0;
          audio.muted = false;
          flashcardAudioPrimed = true;
        })
        .catch(() => {
          audio.muted = false;
        });
      return;
    }
    audio.pause();
    audio.currentTime = 0;
    audio.muted = false;
    flashcardAudioPrimed = true;
  } catch {
    audio.muted = false;
  }
}

function showAiFlashcard(intervention) {
  if (aiInterventionVisible) return;
  aiInterventionVisible = true;
  removeTimerNotification();

  const flashcard = intervention.flashcard || {};
  const options = Array.isArray(flashcard.options) ? flashcard.options : [];

  const overlay = createOverlay(0.62);
  const card = createCard("480px");

  card.appendChild(createIcon("&#129504;", "#FFF0EB"));
  card.appendChild(createHeading("Quick Focus Flashcard"));
  card.appendChild(
    createParagraph("Answer this quickly to lock back into your study flow.")
  );

  const question = document.createElement("p");
  Object.assign(question.style, {
    fontSize: "16px",
    fontWeight: "600",
    color: FF_TEXT,
    margin: "0 0 16px 0",
    lineHeight: "1.45",
    textAlign: "center",
  });
  question.textContent = flashcard.question || "What is one key idea from this page related to your topic?";
  card.appendChild(question);

  const optionsWrap = document.createElement("div");
  Object.assign(optionsWrap.style, {
    display: "grid",
    gap: "8px",
    marginBottom: "12px",
    justifyItems: "center",
  });

  let selected = "";
  options.forEach((option) => {
    const btn = createButton(option, false);
    btn.style.textAlign = "center";
    btn.style.width = "100%";
    btn.style.maxWidth = "420px";
    btn.onclick = () => {
      selected = option;
      optionsWrap.querySelectorAll("button").forEach((node) => {
        node.style.borderColor = FF_BORDER;
        node.style.color = FF_TEXT_LIGHT;
        node.style.background = "transparent";
      });

      const correctAnswer = String(flashcard.answer || "").trim();
      const isCorrect = String(option).trim() === correctAnswer;
      if (isCorrect) {
        btn.style.borderColor = FF_SUCCESS;
        btn.style.color = FF_TEXT;
        btn.style.background = "rgba(107, 207, 127, 0.12)";
      } else {
        btn.style.borderColor = "#FF6B6B";
        btn.style.color = FF_TEXT;
        btn.style.background = "rgba(255, 107, 107, 0.1)";
        const allButtons = Array.from(optionsWrap.querySelectorAll("button"));
        const correctBtn = allButtons.find((node) => node.textContent?.trim() === correctAnswer);
        if (correctBtn) {
          correctBtn.style.borderColor = FF_SUCCESS;
          correctBtn.style.color = FF_TEXT;
          correctBtn.style.background = "rgba(107, 207, 127, 0.12)";
        }
      }
    };
    optionsWrap.appendChild(btn);
  });
  card.appendChild(optionsWrap);

  const hint = document.createElement("p");
  Object.assign(hint.style, {
    fontSize: "12px",
    color: FF_TEXT_MUTED,
    margin: "0 0 12px 0",
    textAlign: "center",
  });
  hint.textContent = flashcard.hint || "Hint: Look at the top headings and main summary.";
  card.appendChild(hint);

  const answer = document.createElement("p");
  Object.assign(answer.style, {
    fontSize: "12px",
    color: FF_TEXT_LIGHT,
    margin: "0 0 14px 0",
    textAlign: "center",
    display: "none",
  });
  answer.textContent = `Expected answer: ${flashcard.answer || "A concise concept-level answer is acceptable."}`;
  card.appendChild(answer);

  const explanation = document.createElement("p");
  Object.assign(explanation.style, {
    fontSize: "12px",
    color: FF_TEXT_LIGHT,
    margin: "0 0 14px 0",
    textAlign: "center",
    display: "none",
    lineHeight: "1.5",
  });
  explanation.textContent = `Explanation: ${flashcard.explanation || "The correct option best matches the topic and page context."}`;
  card.appendChild(explanation);

  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    justifyContent: "center",
    gap: "8px",
  });

  const revealBtn = createButton("Reveal Answer", false);
  revealBtn.onclick = () => {
    answer.style.display = "block";
    explanation.style.display = "block";
    sendInterventionTelemetry("flashcard_reveal", {
      selected_option: selected || null,
    });
  };

  const continueBtn = createButton("Continue Studying");
  continueBtn.onclick = () => {
    sendInterventionTelemetry("flashcard_continue", {
      selected_option: selected || null,
      answered: Boolean(selected),
    });
    overlay.remove();
    aiInterventionVisible = false;
  };

  row.appendChild(revealBtn);
  row.appendChild(continueBtn);
  card.appendChild(row);

  overlay.appendChild(card);
  document.documentElement.appendChild(overlay);
  playFlashcardShownSound();

  sendInterventionTelemetry("flashcard_shown", {
    reason_codes: intervention.reason_codes || [],
    confidence: intervention.confidence || null,
  });
}

function normalizeMascotTurns(script, topic) {
  const cleaned = Array.isArray(script)
    ? script
        .filter((x) => x && typeof x.text === "string" && x.text.trim())
        .map((x) => ({ speaker: x.speaker === "angel" ? "angel" : "devil", text: x.text.trim() }))
    : [];

  if (cleaned.length < 4) return [];

  const targetOrder = ["devil", "angel", "devil", "angel"];
  const out = [];
  const pool = [...cleaned];
  for (const speaker of targetOrder) {
    const idx = pool.findIndex((x) => x.speaker === speaker);
    if (idx >= 0) {
      out.push(pool[idx]);
      pool.splice(idx, 1);
    } else {
      return [];
    }
  }
  return out;
}

function showAiUnavailableNotice(kind) {
  const overlay = createOverlay(0.55);
  aiInterventionVisible = true;
  const card = createCard("420px");
  card.appendChild(createIcon("&#9888;", "#FFF4E8"));
  card.appendChild(createHeading("AI response unavailable"));
  card.appendChild(
    createParagraph(
      kind === "flashcard"
        ? "Could not generate a personalized flashcard right now. Please wait a few seconds and continue."
        : "Could not generate a personalized mascot conversation right now. Please wait a few seconds and continue."
    )
  );
  const btn = createButton("Continue Studying");
  btn.onclick = () => {
    overlay.remove();
    aiInterventionVisible = false;
    clearOffTopicFlow();
    cleanupDistraction();
    refreshInactivityDetection();
  };
  card.appendChild(btn);
  overlay.appendChild(card);
  document.documentElement.appendChild(overlay);
}

function showAiMascotConversation(intervention) {
  if (aiInterventionVisible) return;
  aiInterventionVisible = true;
  removeTimerNotification();
  distractionStage = DISTRACTION_STAGE.MASCOT;
  if (offTopicFlow.site) {
    currentDistractedSite = offTopicFlow.site;
  }

  const script = Array.isArray(intervention.mascot_script) ? intervention.mascot_script : [];
  const turns = normalizeMascotTurns(script, sessionTopic);
  if (!turns.length) {
    clearOffTopicFlow();
    cleanupDistraction();
    showAiUnavailableNotice("mascot");
    return;
  }

  const overlay = createOverlay(0.75);
  overlay.style.display = "block";

  const devilImg = createMascotImage(DEVIL_IMG_URL, "devil");
  const angelImg = createMascotImage(ANGEL_IMG_URL, "angel");
  overlay.appendChild(devilImg);
  overlay.appendChild(angelImg);
  document.documentElement.appendChild(overlay);

  gsap.to(devilImg, { y: 0, opacity: 1, duration: 0.7, ease: "back.out(1.4)" });
  gsap.to(angelImg, { y: 0, opacity: 1, duration: 0.7, ease: "back.out(1.4)", delay: 0.1 });

  let idx = 0;
  let activeBubble = null;

  function step() {
    if (activeBubble) {
      gsap.to(activeBubble, {
        opacity: 0,
        duration: 0.2,
        onComplete: () => activeBubble.remove(),
      });
      activeBubble = null;
    }

    if (idx >= turns.length) {
      setTimeout(() => {
        enableMascotChoice(overlay, devilImg, angelImg);
      }, 900);
      return;
    }

    const turn = turns[idx];
    activeBubble = createBubble(turn.speaker, turn.text);
    overlay.appendChild(activeBubble);
    gsap.fromTo(
      activeBubble,
      { opacity: 0, scale: 0.82, y: 24 },
      { opacity: 1, scale: 1, y: 0, duration: 0.45, ease: "back.out(1.7)" }
    );
    idx += 1;
    setTimeout(() => {
      if (activeBubble) {
        gsap.to(activeBubble, { opacity: 0, duration: 0.2, onComplete: () => activeBubble?.remove() });
        activeBubble = null;
      }
      setTimeout(step, 1000);
    }, 3000);
  }

  setTimeout(step, 500);

  sendInterventionTelemetry("mascot_shown", {
    reason_codes: intervention.reason_codes || [],
    confidence: intervention.confidence || null,
  });
}

function handleAiIntervention(intervention) {
  if (!intervention || !isSessionActive) return;
  if (aiInterventionVisible) return;

  if (
    distractionStage === DISTRACTION_STAGE.MASCOT &&
    !document.getElementById("ff-overlay")
  ) {
    cleanupDistraction();
  }

  if (distractionStage !== DISTRACTION_STAGE.NONE) return;

  const triggerType = intervention.triggerType;
  const preferred = intervention.requestedIntervention;
  const hasFlashcardPayload = Boolean(intervention.flashcard?.question);
  const hasMascotPayload = Array.isArray(intervention.mascot_script)
    && intervention.mascot_script.some((line) => String(line?.text || "").trim().length > 0);

  if (intervention.generation_failed && !hasFlashcardPayload && !hasMascotPayload) {
    showAiUnavailableNotice(intervention.requestedIntervention === "flashcard" ? "flashcard" : "mascot");
    return;
  }

  if (triggerType === "offtopic_site" || preferred === "mascot_chat") {
    if (offTopicFlow.active && offTopicFlow.phase < 2) {
      offTopicFlow.pendingIntervention = intervention;
      return;
    }
    clearOffTopicFlow();
    showAiMascotConversation(intervention);
    return;
  }

  const isIdleFlashcardTrigger =
    triggerType === "idle_allowed_site" || triggerType === "idle_allowed_site_retry";

  if (isIdleFlashcardTrigger && intervention.intervention === "flashcard") {
    if (!hasFlashcardPayload) {
      showAiUnavailableNotice("flashcard");
      return;
    }
    showAiFlashcard(intervention);
    return;
  }

  if (intervention.intervention === "mascot_chat") {
    showAiMascotConversation(intervention);
  }
}

// ===== Distraction Stats Helpers =====

// Records the start of a distraction event in session storage
function recordDistractionStart(site) {
  distractionStartedAt = Date.now();
  chrome.storage.local.get(["session"], (res) => {
    const session = res.session;
    if (!session) return;

    if (!session.distractionStats) {
      session.distractionStats = {
        count: 0,
        totalTime: 0,
        sites: {},
        choices: { angel: 0, devil: 0 },
      };
    }

    session.distractionStats.count++;
    session.distractionStats.sites[site] =
      (session.distractionStats.sites[site] || 0) + 1;

    chrome.storage.local.set({ session });
  });
}

// Records the end of a distraction event (choice made or navigated away)
function recordDistractionEnd(choice) {
  const elapsed = distractionStartedAt ? Date.now() - distractionStartedAt : 0;
  distractionStartedAt = null;

  chrome.storage.local.get(["session"], (res) => {
    const session = res.session;
    if (!session || !session.distractionStats) return;

    session.distractionStats.totalTime += elapsed;

    if (choice === "angel" || choice === "devil") {
      session.distractionStats.choices[choice]++;
    }

    chrome.storage.local.set({ session });
  });
}

// ================================================================
// SECTION 1: INITIALIZATION
// ================================================================

chrome.storage.local.get(["session"], (res) => {
  if (res.session && res.session.active) {
    isSessionActive = true;
    warmFlashcardAudioAssets();
    sessionTopic = res.session.topic || "";
    currentAllowedSites = res.session.allowedSites || [];
    syncAllowedSiteState();
    refreshInactivityDetection();
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.session) {
    const s = changes.session.newValue;
    if (s && s.active) {
      isSessionActive = true;
      warmFlashcardAudioAssets();
      sessionTopic = s.topic || "";
      currentAllowedSites = s.allowedSites || [];
      syncAllowedSiteState();
      refreshInactivityDetection();
    } else {
      isSessionActive = false;
      sessionTopic = "";
      currentAllowedSites = [];
      isCurrentSiteAllowed = false;
      clearOffTopicFlow();
      cleanupInactivityDetection();
      cleanupDistraction();
    }
  }
});

// ================================================================
// SECTION 2: INACTIVITY DETECTION (for allowed sites)
// ================================================================

function initInactivityDetection() {
  cleanupInactivityDetection(false);
  lastActivity = Date.now();
  inactivityRemainingMs = ALLOWED_SITE_IDLE_LIMIT;

  INACTIVITY_ACTIVITY_EVENTS.forEach((ev) => {
    document.addEventListener(ev, handleActivity, true);
  });

  resumeInactivityTimer();
}

function cleanupInactivityDetection(removeListeners = true) {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
  if (removeListeners) {
    INACTIVITY_ACTIVITY_EVENTS.forEach((ev) => {
      document.removeEventListener(ev, handleActivity, true);
    });
  }
}

function pauseInactivityTimer() {
  if (!inactivityTimer) return;
  clearTimeout(inactivityTimer);
  inactivityTimer = null;
  const elapsed = Date.now() - lastActivity;
  inactivityRemainingMs = Math.max(0, ALLOWED_SITE_IDLE_LIMIT - elapsed);
}

function resumeInactivityTimer() {
  if (!isSessionActive || !pageIsVisible || !isCurrentSiteAllowed) return;
  if (distractionStage !== DISTRACTION_STAGE.NONE) return;

  if (inactivityTimer) clearTimeout(inactivityTimer);
  const delay = Math.max(1, inactivityRemainingMs);
  inactivityTimer = setTimeout(showInactivityOverlay, delay);
}

function handleActivity() {
  primeFlashcardAudioFromGesture();

  if (!pageIsVisible || !isCurrentSiteAllowed) return;

  const now = Date.now();
  if (now - lastActivity < 1000) return;
  lastActivity = now;
  inactivityRemainingMs = ALLOWED_SITE_IDLE_LIMIT;

  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(showInactivityOverlay, inactivityRemainingMs);
}

function showInactivityOverlay() {
  if (!isSessionActive) return;
  if (!pageIsVisible) return;
  if (!isCurrentSiteAllowed) return;
  if (distractionStage !== DISTRACTION_STAGE.NONE) return;
  if (aiInterventionVisible) return;

  const event = buildAiEventSnapshot({
    trigger_type: "idle_allowed_site",
    inactivity_seconds: Math.floor((Date.now() - lastActivity) / 1000),
  });
  requestAiInterventionNow("idle_allowed_site", "flashcard", event);

  lastActivity = Date.now();
  inactivityRemainingMs = ALLOWED_SITE_IDLE_LIMIT;
  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(showInactivityOverlay, inactivityRemainingMs);
}

// ================================================================
// SECTION 3: DISTRACTION TIMER SYSTEM
// ================================================================

// Called by background.js message when user visits a non-allowed site
function startDistraction(site) {
  // If already tracking distraction on this page, don't restart
  if (distractionStage !== DISTRACTION_STAGE.NONE && currentDistractedSite === site) return;

  cleanupDistraction();
  currentDistractedSite = site;
  distractionStage = DISTRACTION_STAGE.COUNTDOWN_1;
  distractionRecorded = false;

  // Pause inactivity detection while on distraction site
  cleanupInactivityDetection(false);

  if (pageIsVisible) {
    startDistractionCountdown();
  }
}

function cleanupDistraction() {
  distractionStage = DISTRACTION_STAGE.NONE;
  currentDistractedSite = null;
  distractionSecondsLeft = 0;
  distractionRecorded = false;

  if (distractionCountdown) {
    clearInterval(distractionCountdown);
    distractionCountdown = null;
  }

  removeTimerNotification();
  removeOverlay();
}

function startDistractionCountdown() {
  if (!pageIsVisible) return;

  if (distractionCountdown) {
    clearInterval(distractionCountdown);
    distractionCountdown = null;
  }

  if (!distractionRecorded && currentDistractedSite) {
    recordDistractionStart(currentDistractedSite);
    distractionRecorded = true;
  }

  ensureCountdownSeconds();
  showTimerNotification();

  distractionCountdown = setInterval(() => {
    distractionSecondsLeft = Math.max(0, distractionSecondsLeft - 1);
    updateTimerNotification();

    if (distractionSecondsLeft <= 0) {
      clearInterval(distractionCountdown);
      distractionCountdown = null;
      removeTimerNotification();
      onDistractionTimerEnd();
    }
  }, 1000);
}

function pauseDistractionCountdown() {
  if (!distractionCountdown) return;
  clearInterval(distractionCountdown);
  distractionCountdown = null;
}

function resumeDistractionCountdown() {
  if (!isSessionActive || !pageIsVisible) return;
  if (
    !currentDistractedSite ||
    ![
      DISTRACTION_STAGE.COUNTDOWN_1,
      DISTRACTION_STAGE.COUNTDOWN_2,
    ].includes(distractionStage)
  ) {
    return;
  }
  if (distractionCountdown) return;

  ensureCountdownSeconds();
  showTimerNotification();
  distractionCountdown = setInterval(() => {
    distractionSecondsLeft = Math.max(0, distractionSecondsLeft - 1);
    updateTimerNotification();

    if (distractionSecondsLeft <= 0) {
      clearInterval(distractionCountdown);
      distractionCountdown = null;
      removeTimerNotification();
      onDistractionTimerEnd();
    }
  }, 1000);
}

function onDistractionTimerEnd() {
  if (distractionStage === DISTRACTION_STAGE.COUNTDOWN_1) {
    showStage1Overlay();
  } else if (distractionStage === DISTRACTION_STAGE.COUNTDOWN_2) {
    showMascotOverlay();
  }
}

// ===== Corner Timer Notification =====

function showTimerNotification() {
  removeTimerNotification();
  injectAnimationStyles();

  const notif = document.createElement("div");
  notif.id = "ff-timer-notif";
  Object.assign(notif.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "2147483646",
    fontFamily: FF_FONT,
    background: "rgba(244, 125, 91, 0.95)",
    backdropFilter: "blur(8px)",
    color: "white",
    borderRadius: "14px",
    padding: "12px 18px",
    boxShadow: "0 4px 20px rgba(244, 125, 91, 0.4)",
    animation: "ffSlideUp 0.3s ease",
    display: "flex",
    alignItems: "center",
    gap: "10px",
    minWidth: "140px",
  });

  notif.innerHTML = `
    <span style="font-size:20px;">&#9203;</span>
    <div>
      <div id="ff-timer-seconds" style="font-size:18px;font-weight:700;line-height:1;">${distractionSecondsLeft}s</div>
      <div style="font-size:10px;opacity:0.85;text-transform:uppercase;letter-spacing:0.5px;margin-top:2px;">Distracted</div>
    </div>
  `;

  document.documentElement.appendChild(notif);
}

function updateTimerNotification() {
  const el = document.getElementById("ff-timer-seconds");
  if (el) {
    el.textContent = `${Math.max(0, distractionSecondsLeft)}s`;
    // Pulse effect on last 3 seconds
    if (distractionSecondsLeft <= 3) {
      const notif = document.getElementById("ff-timer-notif");
      if (notif) notif.style.animation = "ffPulse 0.5s ease";
      setTimeout(() => {
        if (notif) notif.style.animation = "";
      }, 500);
    }
  }
}

// ===== Stage 1: "Are you still active?" Popup =====

function showStage1Overlay() {
  distractionStage = DISTRACTION_STAGE.PROMPT_1;
  removeTimerNotification();

  const overlay = createOverlay();
  const card = createCard("380px");

  card.appendChild(createIcon("&#129300;", "#FFF0EB")); // 🤔 thinking face
  card.appendChild(createHeading("Are you sure you want to waste more study time?"));

  const desc = createParagraph(
    `You've already spent ${DISTRACTION_LIMIT} seconds on ${currentDistractedSite}. Keep going, or get back to ${sessionTopic || "your studies"}?`
  );
  card.appendChild(desc);

  const btnRow = document.createElement("div");
  Object.assign(btnRow.style, {
    display: "flex",
    gap: "8px",
    justifyContent: "center",
  });

  const stayBtn = createButton("Stay here", false);
  stayBtn.onclick = () => {
    // User chose to stay distracted → start Stage 2 timer
    overlay.remove();
    distractionStage = DISTRACTION_STAGE.COUNTDOWN_2;
    distractionSecondsLeft = DISTRACTION_LIMIT;
    startDistractionCountdown();
  };

  const closeBtn = createButton("Close tab");
  closeBtn.onclick = () => {
    recordDistractionEnd("angel");
    chrome.runtime.sendMessage({ action: "closeTab" });
  };

  btnRow.appendChild(stayBtn);
  btnRow.appendChild(closeBtn);
  card.appendChild(btnRow);

  overlay.appendChild(card);
  document.documentElement.appendChild(overlay);
}

// ===== Stage 3: Mascot Intervention =====

function createMascotImage(src, side) {
  const img = document.createElement("img");
  img.src = src;
  img.className = `ff-mascot-img ff-mascot-${side}`;
  img.draggable = false;
  Object.assign(img.style, {
    position: "absolute",
    bottom: "-40px",
    [side === "devil" ? "left" : "right"]: "40px",
    width: "450px",
    height: "450px",
    objectFit: "cover",
    objectPosition: "center bottom",
    zIndex: "2",
    userSelect: "none",
    pointerEvents: "none",
    // Start hidden below viewport for GSAP entrance
    opacity: "0",
    transform: "translateY(500px)",
  });
  return img;
}

function showMascotOverlay() {
  distractionStage = DISTRACTION_STAGE.MASCOT;

  const overlay = createOverlay(0.75);
  // Remove flex centering — mascots are absolutely positioned
  overlay.style.display = "block";

  // Devil mascot — bottom left
  const devilImg = createMascotImage(DEVIL_IMG_URL, "devil");
  overlay.appendChild(devilImg);

  // Angel mascot — bottom right
  const angelImg = createMascotImage(ANGEL_IMG_URL, "angel");
  overlay.appendChild(angelImg);

  document.documentElement.appendChild(overlay);

  // GSAP entrance animation — dramatic slide up with back-ease overshoot
  const entranceTL = gsap.timeline({
    onComplete: () => {
      // Start idle breathing after entrance completes
      startBreathing(devilImg);
      startBreathing(angelImg, 1.5); // Offset angel breathing by 1.5s
      animateConversation(overlay, devilImg, angelImg);
    },
  });

  entranceTL.to(devilImg, {
    y: 0,
    opacity: 1,
    duration: 0.8,
    ease: "back.out(1.4)",
  });

  entranceTL.to(
    angelImg,
    {
      y: 0,
      opacity: 1,
      duration: 0.8,
      ease: "back.out(1.4)",
    },
    0.1 // Slight stagger — angel starts 0.1s after devil
  );
}

// ===== GSAP Breathing Animation =====

function startBreathing(mascot, delay = 0) {
  // Kill any existing tweens on this mascot before starting breathing
  gsap.killTweensOf(mascot);
  mascot._breathingTween = gsap.to(mascot, {
    scale: 1.02,
    duration: 1.5,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
    delay: delay,
  });
}

function stopBreathing(mascot) {
  if (mascot._breathingTween) {
    mascot._breathingTween.kill();
    mascot._breathingTween = null;
  }
}

// ===== Mascot Conversation Animation =====

function createBubbleTailSVG(isDevil) {
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", "20");
  svg.setAttribute("height", "10");
  svg.setAttribute("viewBox", "0 0 20 10");
  Object.assign(svg.style, {
    position: "absolute",
    bottom: "-9px",
    [isDevil ? "left" : "right"]: "40px",
    display: "block",
  });

  const polygon = document.createElementNS(svgNS, "polygon");
  polygon.setAttribute("points", isDevil ? "0,0 20,0 4,10" : "0,0 20,0 16,10");
  polygon.setAttribute("fill", isDevil ? "#FFF0F0" : "#FFF8E7");
  svg.appendChild(polygon);

  return svg;
}

function createBubble(speaker, text) {
  const isDevil = speaker === "devil";

  const wrapper = document.createElement("div");
  wrapper.className = `ff-speech-bubble ff-bubble-${speaker}`;
  Object.assign(wrapper.style, {
    position: "absolute",
    bottom: "410px",
    [isDevil ? "left" : "right"]: "50%",
    maxWidth: "380px",
    zIndex: "3",
    fontFamily: FF_FONT,
    // Start hidden for GSAP animation
    opacity: "0",
    transform: "scale(0) translateY(20px)",
    transformOrigin: isDevil ? "bottom left" : "bottom right",
  });

  if (isDevil) {
    wrapper.style.marginLeft = "-380px";
  } else {
    wrapper.style.marginRight = "-380px";
  }

  const bubble = document.createElement("div");
  Object.assign(bubble.style, {
    position: "relative",
    background: isDevil ? "#FFF0F0" : "#FFF8E7",
    color: FF_TEXT,
    padding: "18px 24px",
    borderRadius: "16px",
    fontFamily: FF_DIALOG_FONT,
    fontSize: "22px",
    fontWeight: "600",
    lineHeight: "1.45",
    letterSpacing: "0.15px",
    textAlign: "left",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.12)",
  });
  bubble.textContent = text;

  // SVG tail pointing down to mascot
  bubble.appendChild(createBubbleTailSVG(isDevil));

  wrapper.appendChild(bubble);
  return wrapper;
}

function animateConversation(overlay, devilMascot, angelMascot) {
  const topicDisplay = sessionTopic || "your studies";

  const script = [
    {
      speaker: "devil",
      text: `${DISTRACTION_LIMIT * 2} seconds of glorious procrastination! How does it feel?`,
    },
    {
      speaker: "angel",
      text: `You know you're supposed to be working on ${topicDisplay}, right?`,
    },
    {
      speaker: "devil",
      text: `Oh please, a little break never hurt anyone!`,
    },
    {
      speaker: "angel",
      text: `That's literally what you said ${DISTRACTION_LIMIT} seconds ago...`,
    },
  ];

  let currentBubble = null;
  let i = 0;

  function showNextMessage() {
    // Remove previous bubble with fade-out
    if (currentBubble) {
      const oldBubble = currentBubble;
      gsap.to(oldBubble, {
        opacity: 0,
        scale: 0.8,
        duration: 0.2,
        ease: "power2.in",
        onComplete: () => oldBubble.remove(),
      });
      currentBubble = null;
    }

    // Reset both mascots — resume breathing
    startBreathing(devilMascot);
    startBreathing(angelMascot, 1.5);

    if (i >= script.length) {
      // Conversation finished — enable mascot choice
      setTimeout(() => {
        enableMascotChoice(overlay, devilMascot, angelMascot);
      }, 400);
      return;
    }

    const msg = script[i];
    const isDevil = msg.speaker === "devil";
    const activeMascot = isDevil ? devilMascot : angelMascot;

    // Stop breathing on active mascot so pop takes effect
    stopBreathing(activeMascot);

    // Pop active mascot up with elastic bounce
    gsap.to(activeMascot, {
      y: -30,
      scale: 1,
      duration: 0.6,
      ease: "elastic.out(1, 0.5)",
    });

    // Show speech bubble with spring pop-in
    currentBubble = createBubble(msg.speaker, msg.text);
    overlay.appendChild(currentBubble);

    gsap.to(currentBubble, {
      opacity: 1,
      scale: 1,
      y: 0,
      duration: 0.5,
      ease: "back.out(2)",
      delay: 0.15, // Slight delay after mascot pop
    });

    i++;

    // Schedule next message
    setTimeout(showNextMessage, 2500);
  }

  showNextMessage();
}

// ===== Background Effects =====

function createFireEffect() {
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "absolute",
    left: "0",
    bottom: "0",
    width: "50%",
    height: "100%",
    zIndex: "1",
    pointerEvents: "none",
    opacity: "0",
    overflow: "hidden",
  });

  // Base fire glow — radial gradient from bottom-left
  const baseGlow = document.createElement("div");
  Object.assign(baseGlow.style, {
    position: "absolute",
    left: "-20%",
    bottom: "-10%",
    width: "120%",
    height: "80%",
    background:
      "radial-gradient(ellipse at 30% 90%, rgba(255, 69, 0, 0.55) 0%, rgba(255, 140, 0, 0.35) 25%, rgba(255, 60, 0, 0.2) 45%, transparent 65%)",
    filter: "blur(30px)",
  });
  container.appendChild(baseGlow);

  // Secondary ember glow — higher, more diffuse
  const emberGlow = document.createElement("div");
  Object.assign(emberGlow.style, {
    position: "absolute",
    left: "0",
    bottom: "0",
    width: "100%",
    height: "60%",
    background:
      "radial-gradient(ellipse at 40% 100%, rgba(255, 100, 0, 0.3) 0%, rgba(255, 50, 0, 0.15) 30%, transparent 55%)",
    filter: "blur(40px)",
  });
  container.appendChild(emberGlow);

  // Flicker layer — animated opacity for flame-like movement
  const flickerLayer = document.createElement("div");
  Object.assign(flickerLayer.style, {
    position: "absolute",
    left: "-10%",
    bottom: "-5%",
    width: "110%",
    height: "70%",
    background:
      "radial-gradient(ellipse at 25% 95%, rgba(255, 200, 0, 0.4) 0%, rgba(255, 80, 0, 0.25) 20%, transparent 50%)",
    filter: "blur(25px)",
  });
  container.appendChild(flickerLayer);

  // Animate the flicker layer for fire-like movement
  gsap.to(flickerLayer, {
    opacity: 0.4,
    y: -20,
    scale: 1.08,
    duration: 0.6,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
  });

  // Animate base glow with subtle pulse
  gsap.to(baseGlow, {
    opacity: 0.7,
    scale: 1.04,
    duration: 1.2,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
  });

  // Ember glow drifts upward slowly
  gsap.to(emberGlow, {
    y: -15,
    opacity: 0.6,
    duration: 2,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
  });

  return container;
}

function createHeavenEffect() {
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "absolute",
    right: "0",
    bottom: "0",
    width: "50%",
    height: "100%",
    zIndex: "1",
    pointerEvents: "none",
    opacity: "0",
    overflow: "hidden",
  });

  // Base heavenly glow — warm golden radial gradient from bottom-right
  const baseGlow = document.createElement("div");
  Object.assign(baseGlow.style, {
    position: "absolute",
    right: "-20%",
    bottom: "-10%",
    width: "120%",
    height: "80%",
    background:
      "radial-gradient(ellipse at 70% 90%, rgba(255, 255, 255, 0.5) 0%, rgba(255, 223, 150, 0.45) 20%, rgba(255, 200, 80, 0.35) 40%, transparent 60%)",
    filter: "blur(35px)",
  });
  container.appendChild(baseGlow);

  // Rich golden shimmer layer
  const shimmerLayer = document.createElement("div");
  Object.assign(shimmerLayer.style, {
    position: "absolute",
    right: "0",
    bottom: "0",
    width: "100%",
    height: "70%",
    background:
      "radial-gradient(ellipse at 60% 100%, rgba(255, 215, 100, 0.4) 0%, rgba(255, 180, 60, 0.25) 30%, transparent 55%)",
    filter: "blur(30px)",
  });
  container.appendChild(shimmerLayer);

  // Soft white-gold light rays
  const lightRays = document.createElement("div");
  Object.assign(lightRays.style, {
    position: "absolute",
    right: "10%",
    bottom: "10%",
    width: "80%",
    height: "60%",
    background:
      "radial-gradient(ellipse at 65% 85%, rgba(255, 255, 255, 0.4) 0%, rgba(255, 220, 140, 0.2) 30%, transparent 55%)",
    filter: "blur(20px)",
  });
  container.appendChild(lightRays);

  // Animate base glow with soft pulse
  gsap.to(baseGlow, {
    opacity: 0.85,
    scale: 1.06,
    duration: 2.5,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
  });

  // Shimmer layer gentle drift
  gsap.to(shimmerLayer, {
    opacity: 0.7,
    y: -10,
    duration: 3,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
  });

  // Light rays soft pulse
  gsap.to(lightRays, {
    opacity: 0.5,
    scale: 1.1,
    duration: 2,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
    delay: 0.5,
  });

  return container;
}

// ===== Choice Visual Indicators =====

function createChoiceArrow(side) {
  const isDevil = side === "devil";

  const wrapper = document.createElement("div");
  Object.assign(wrapper.style, {
    position: "absolute",
    [isDevil ? "left" : "right"]: "11%",
    top: "11%",
    zIndex: "3",
    pointerEvents: "none",
    opacity: "0",
  });
  wrapper.className = isDevil ? "ff-choice-arrow-left" : "ff-choice-arrow-right";

  // SVG downward arrow — clean geometric shape
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", "48");
  svg.setAttribute("height", "64");
  svg.setAttribute("viewBox", "0 0 48 64");

  const arrow = document.createElementNS(svgNS, "path");
  // Chevron-style downward arrow
  arrow.setAttribute("d", "M8 8 L24 28 L40 8 M8 28 L24 48 L40 28");
  arrow.setAttribute("fill", "none");
  arrow.setAttribute(
    "stroke",
    isDevil ? "rgba(255, 120, 60, 0.9)" : "rgba(255, 215, 100, 0.9)"
  );
  arrow.setAttribute("stroke-width", "4");
  arrow.setAttribute("stroke-linecap", "round");
  arrow.setAttribute("stroke-linejoin", "round");
  svg.appendChild(arrow);

  wrapper.appendChild(svg);

  // Label below arrow
  const label = document.createElement("div");
  Object.assign(label.style, {
    fontFamily: FF_FONT,
    fontSize: "13px",
    fontWeight: "600",
    color: isDevil
      ? "rgba(255, 120, 60, 0.85)"
      : "rgba(255, 215, 100, 0.85)",
    textAlign: "center",
    marginTop: "6px",
    letterSpacing: "0.5px",
    textShadow: "0 1px 6px rgba(0, 0, 0, 0.5)",
  });
  label.textContent = isDevil ? "Stay here" : "Get back to work";
  wrapper.appendChild(label);

  return wrapper;
}

function createChoiceArrows(overlay) {
  const leftArrow = createChoiceArrow("devil");
  const rightArrow = createChoiceArrow("angel");

  overlay.appendChild(leftArrow);
  overlay.appendChild(rightArrow);

  // Staggered fade-in
  gsap.to(leftArrow, {
    opacity: 1,
    duration: 0.6,
    ease: "power2.out",
    delay: 0.2,
  });
  gsap.to(rightArrow, {
    opacity: 1,
    duration: 0.6,
    ease: "power2.out",
    delay: 0.4,
  });

  // Pulsing bounce animation — arrows bob up and down
  gsap.to(leftArrow, {
    y: 12,
    duration: 0.8,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
    delay: 0.2,
  });

  gsap.to(rightArrow, {
    y: 12,
    duration: 0.8,
    ease: "sine.inOut",
    yoyo: true,
    repeat: -1,
    delay: 0.6, // Offset for alternating feel
  });

  return { leftArrow, rightArrow };
}

// ===== Mascot Choice Mode =====

function enableMascotChoice(overlay, devilMascot, angelMascot) {
  // Show "choose your side" prompt at the top center
  const prompt = document.createElement("div");
  prompt.className = "ff-choice-prompt";
  Object.assign(prompt.style, {
    position: "absolute",
    top: "60px",
    left: "50%",
    color: "#FFFFFF",
    fontFamily: FF_FONT,
    fontSize: "22px",
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: "0.5px",
    textShadow: "0 2px 8px rgba(0, 0, 0, 0.5)",
    zIndex: "3",
    pointerEvents: "none",
    opacity: "0",
  });
  prompt.textContent = "Choose your side";
  overlay.appendChild(prompt);

  // GSAP fade-in for prompt — use xPercent for centering so GSAP doesn't clobber it
  gsap.set(prompt, { xPercent: -50 });
  gsap.to(prompt, {
    opacity: 0.9,
    duration: 0.5,
    ease: "power2.out",
  });

  // Animated arrows pointing at each mascot
  const arrows = createChoiceArrows(overlay);

  // Stop breathing animation — GSAP handles everything in choice mode
  stopBreathing(devilMascot);
  stopBreathing(angelMascot);

  // Reset mascots to neutral state
  gsap.to([devilMascot, angelMascot], {
    scale: 1,
    y: 0,
    filter: "none",
    duration: 0.3,
    ease: "power2.out",
  });

  // Background effect containers (positioned behind mascots)
  const fireEffect = createFireEffect();
  const heavenEffect = createHeavenEffect();
  overlay.appendChild(fireEffect);
  overlay.appendChild(heavenEffect);

  // Create two invisible half-screen zones for hover detection & click
  const leftZone = document.createElement("div");
  Object.assign(leftZone.style, {
    position: "absolute",
    top: "0",
    left: "0",
    width: "50%",
    height: "100%",
    cursor: "pointer",
    zIndex: "4",
  });

  const rightZone = document.createElement("div");
  Object.assign(rightZone.style, {
    position: "absolute",
    top: "0",
    right: "0",
    width: "50%",
    height: "100%",
    cursor: "pointer",
    zIndex: "4",
  });

  // Left half = devil
  leftZone.onmouseenter = () => {
    gsap.to(devilMascot, {
      scale: 1.12,
      filter: "drop-shadow(0 0 28px rgba(238, 90, 36, 0.8))",
      duration: 0.45,
      ease: "power2.out",
    });
    gsap.to(angelMascot, {
      scale: 0.9,
      filter: "brightness(0.65)",
      duration: 0.45,
      ease: "power2.out",
    });
    gsap.to(fireEffect, { opacity: 1, duration: 0.4, ease: "power2.out" });
    gsap.to(heavenEffect, { opacity: 0, duration: 0.3, ease: "power2.in" });
  };
  leftZone.onmouseleave = () => {
    gsap.to(devilMascot, {
      scale: 1,
      filter: "none",
      duration: 0.35,
      ease: "power2.inOut",
    });
    gsap.to(angelMascot, {
      scale: 1,
      filter: "none",
      duration: 0.35,
      ease: "power2.inOut",
    });
    gsap.to(fireEffect, { opacity: 0, duration: 0.3, ease: "power2.in" });
  };
  leftZone.onclick = () => handleMascotChoice("devil");

  // Right half = angel
  rightZone.onmouseenter = () => {
    gsap.to(angelMascot, {
      scale: 1.12,
      filter: "drop-shadow(0 0 28px rgba(255, 200, 60, 0.8))",
      duration: 0.45,
      ease: "power2.out",
    });
    gsap.to(devilMascot, {
      scale: 0.9,
      filter: "brightness(0.65)",
      duration: 0.45,
      ease: "power2.out",
    });
    gsap.to(heavenEffect, { opacity: 1, duration: 0.4, ease: "power2.out" });
    gsap.to(fireEffect, { opacity: 0, duration: 0.3, ease: "power2.in" });
  };
  rightZone.onmouseleave = () => {
    gsap.to(angelMascot, {
      scale: 1,
      filter: "none",
      duration: 0.35,
      ease: "power2.inOut",
    });
    gsap.to(devilMascot, {
      scale: 1,
      filter: "none",
      duration: 0.35,
      ease: "power2.inOut",
    });
    gsap.to(heavenEffect, { opacity: 0, duration: 0.3, ease: "power2.in" });
  };
  rightZone.onclick = () => handleMascotChoice("angel");

  overlay.appendChild(leftZone);
  overlay.appendChild(rightZone);
}

// ===== Mascot Choice Handlers =====

function handleMascotChoice(choice) {
  // Record the user's choice and distraction duration
  recordDistractionEnd(choice);
  clearOffTopicFlow();

  if (choice === "angel") {
    // Close the current tab
    cleanupDistraction();
    chrome.runtime.sendMessage({ action: "closeTab" });
  } else {
    // Show shame screen, then allow the site
    showShameScreen();
  }
}

// ===== Shame Screen =====

function showShameScreen() {
  removeOverlay();

  const overlay = createOverlay(0.65);

  const card = createCard("360px");

  // Grimacing emoji icon
  card.appendChild(createIcon("&#128556;", "#FFF0EB")); // 😬

  const heading = createHeading("Alright, alright...");
  card.appendChild(heading);

  const line1 = document.createElement("p");
  Object.assign(line1.style, {
    fontSize: "14px",
    color: FF_TEXT_LIGHT,
    margin: "0 0 6px 0",
    lineHeight: "1.5",
  });
  line1.textContent = "Just this once.";
  card.appendChild(line1);

  const line2 = document.createElement("p");
  Object.assign(line2.style, {
    fontSize: "13px",
    color: FF_TEXT_MUTED,
    margin: "0 0 24px 0",
    lineHeight: "1.5",
    fontStyle: "italic",
  });
  line2.textContent = "But we both know you'll regret this later.";
  card.appendChild(line2);

  // Continue button - hidden for 2 seconds
  const btn = createButton("Continue anyway");
  btn.style.opacity = "0";
  btn.style.transition = "opacity 0.4s ease";
  btn.style.pointerEvents = "none";

  btn.onclick = () => {
    // Add site to allowed list and clean up
    if (currentDistractedSite) {
      chrome.runtime.sendMessage({
        action: "addAllowed",
        site: currentDistractedSite,
      });
    }
    cleanupDistraction();
    // storage.onChanged will re-evaluate allowed-site status and start idle timer.
  };

  card.appendChild(btn);
  overlay.appendChild(card);
  document.documentElement.appendChild(overlay);

  // Show button after 2 seconds
  setTimeout(() => {
    btn.style.opacity = "1";
    btn.style.pointerEvents = "auto";
  }, 2000);
}

// ================================================================
// SECTION 4: MESSAGE HANDLER FROM BACKGROUND
// ================================================================

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "block") {
    // AI-first off-topic flow with grace + warning
    startOffTopicFlow(msg.site);
    return;
  }

  if (msg.action === "aiIntervention" && msg.payload) {
    handleAiIntervention(msg.payload);
  }
});

document.addEventListener("visibilitychange", () => {
  pageIsVisible = document.visibilityState === "visible";

  if (!isSessionActive) return;

  if (pageIsVisible) {
    if (distractionStage === DISTRACTION_STAGE.PROMPT_1 && currentDistractedSite) {
      showStage1Overlay();
    } else if (distractionStage !== DISTRACTION_STAGE.NONE && currentDistractedSite) {
      resumeDistractionCountdown();
    } else {
      resumeInactivityTimer();
    }
  } else {
    pauseInactivityTimer();
    pauseDistractionCountdown();
    removeOverlay();
    removeTimerNotification();
  }
});

// ================================================================
// SECTION 5: PARSING COLLECTOR
// ================================================================

const parsingCollector = initParsingCollector();
parsingCollector.start();
