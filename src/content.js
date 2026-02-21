import { initParsingCollector } from "./parsing/collector.js";
import gsap from "gsap";

// ===== Focus Flow - Content Script =====
// Injected into every page. Handles:
// 1. Inactivity detection (only during active sessions on allowed sites)
// 2. Progressive distraction intervention (timer → popup → mascots)

const FF_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
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

// Inactivity state
let inactivityTimer = null;
let lastActivity = Date.now();
const INACTIVITY_LIMIT = 60000; // 60 seconds

// Distraction state
let distractionStage = 0; // 0=none, 1=first timer, 2=second timer, 3=mascot shown
let distractionCountdown = null;
let distractionSecondsLeft = 0;
let currentDistractedSite = null;
let distractionStartedAt = null; // timestamp when current distraction began
const DISTRACTION_LIMIT = 10; // 10 seconds per stage (for testing)

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
        width: 180px !important;
        height: 180px !important;
      }
      .ff-speech-bubble {
        max-width: 180px !important;
        font-size: 11px !important;
        padding: 9px 11px !important;
        bottom: 180px !important;
        left: 8% !important;
        right: 8% !important;
      }
      .ff-mascot-devil {
        left: 10px !important;
        bottom: 0 !important;
      }
      .ff-mascot-angel {
        right: 10px !important;
        bottom: 0 !important;
      }
      .ff-choice-prompt {
        font-size: 14px !important;
        top: 40px !important;
      }
    }
  `;
  document.documentElement.appendChild(style);
}

// ===== Utility: Remove any Focus Flow overlay =====

function removeOverlay() {
  const el = document.getElementById("ff-overlay");
  if (el) el.remove();
}

function removeTimerNotification() {
  const el = document.getElementById("ff-timer-notif");
  if (el) el.remove();
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
    sessionTopic = res.session.topic || "";
    // Inactivity detection starts only on allowed sites; distraction
    // handling is triggered by background "block" messages.
    initInactivityDetection();
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.session) {
    const s = changes.session.newValue;
    if (s && s.active) {
      isSessionActive = true;
      sessionTopic = s.topic || "";
      initInactivityDetection();
    } else {
      isSessionActive = false;
      sessionTopic = "";
      cleanupInactivityDetection();
      cleanupDistraction();
    }
  }
});

// ================================================================
// SECTION 2: INACTIVITY DETECTION (for allowed sites)
// ================================================================

function initInactivityDetection() {
  cleanupInactivityDetection();
  lastActivity = Date.now();

  ["click", "keydown", "scroll", "touchstart", "mousemove"].forEach((ev) => {
    document.addEventListener(ev, handleActivity, true);
  });

  inactivityTimer = setTimeout(showInactivityOverlay, INACTIVITY_LIMIT);
}

function cleanupInactivityDetection() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
  ["click", "keydown", "scroll", "touchstart", "mousemove"].forEach((ev) => {
    document.removeEventListener(ev, handleActivity, true);
  });
}

function handleActivity() {
  const now = Date.now();
  if (now - lastActivity < 1000) return;
  lastActivity = now;

  if (inactivityTimer) clearTimeout(inactivityTimer);
  inactivityTimer = setTimeout(showInactivityOverlay, INACTIVITY_LIMIT);
}

function showInactivityOverlay() {
  if (!isSessionActive) return;
  if (document.getElementById("ff-overlay")) return;

  const overlay = createOverlay();
  const card = createCard("360px");

  card.appendChild(createIcon("&#9200;", "#FFF0EB"));
  card.appendChild(createHeading("Still there?"));
  card.appendChild(createParagraph("It looks like you've been inactive. Are you still focused?"));

  const btn = createButton("Yes, I'm here");
  btn.onclick = () => {
    overlay.remove();
    lastActivity = Date.now();
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(showInactivityOverlay, INACTIVITY_LIMIT);
  };
  card.appendChild(btn);

  overlay.appendChild(card);
  document.documentElement.appendChild(overlay);
}

// ================================================================
// SECTION 3: DISTRACTION TIMER SYSTEM
// ================================================================

// Called by background.js message when user visits a non-allowed site
function startDistraction(site) {
  // If already tracking distraction on this page, don't restart
  if (distractionStage > 0 && currentDistractedSite === site) return;

  cleanupDistraction();
  currentDistractedSite = site;
  distractionStage = 1;

  // Record this distraction event
  recordDistractionStart(site);

  // Pause inactivity detection while on distraction site
  cleanupInactivityDetection();

  startDistractionCountdown();
}

function cleanupDistraction() {
  distractionStage = 0;
  currentDistractedSite = null;
  distractionSecondsLeft = 0;

  if (distractionCountdown) {
    clearInterval(distractionCountdown);
    distractionCountdown = null;
  }

  removeTimerNotification();
  removeOverlay();
}

function startDistractionCountdown() {
  distractionSecondsLeft = DISTRACTION_LIMIT;
  showTimerNotification();

  distractionCountdown = setInterval(() => {
    distractionSecondsLeft--;
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
  if (distractionStage === 1) {
    showStage1Overlay();
  } else if (distractionStage === 2) {
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
    el.textContent = `${distractionSecondsLeft}s`;
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
  const overlay = createOverlay();
  const card = createCard("380px");

  card.appendChild(createIcon("&#128564;", "#FFF0EB")); // 💤 sleeping face
  card.appendChild(createHeading("Still active?"));

  const desc = createParagraph(
    `You've been on ${currentDistractedSite} for ${DISTRACTION_LIMIT} seconds. Getting sidetracked?`
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
    distractionStage = 2;
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
    bottom: "0",
    [side === "devil" ? "left" : "right"]: "40px",
    width: "340px",
    height: "340px",
    objectFit: "cover",
    objectPosition: "center bottom",
    zIndex: "2",
    userSelect: "none",
    pointerEvents: "none",
    // Start hidden below viewport for GSAP entrance
    opacity: "0",
    transform: "translateY(400px)",
  });
  return img;
}

function showMascotOverlay() {
  distractionStage = 3;

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
  polygon.setAttribute("fill", isDevil ? "#FFF0F0" : "#EEFBF1");
  svg.appendChild(polygon);

  return svg;
}

function createBubble(speaker, text) {
  const isDevil = speaker === "devil";

  const wrapper = document.createElement("div");
  wrapper.className = `ff-speech-bubble ff-bubble-${speaker}`;
  Object.assign(wrapper.style, {
    position: "absolute",
    bottom: "340px",
    [isDevil ? "left" : "right"]: "15%",
    maxWidth: "300px",
    zIndex: "3",
    fontFamily: FF_FONT,
    // Start hidden for GSAP animation
    opacity: "0",
    transform: "scale(0) translateY(20px)",
    transformOrigin: isDevil ? "bottom left" : "bottom right",
  });

  const bubble = document.createElement("div");
  Object.assign(bubble.style, {
    position: "relative",
    background: isDevil ? "#FFF0F0" : "#EEFBF1",
    color: FF_TEXT,
    padding: "14px 18px",
    borderRadius: "14px",
    fontSize: "14px",
    lineHeight: "1.5",
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

  // Base heavenly glow — radial gradient from bottom-right
  const baseGlow = document.createElement("div");
  Object.assign(baseGlow.style, {
    position: "absolute",
    right: "-20%",
    bottom: "-10%",
    width: "120%",
    height: "80%",
    background:
      "radial-gradient(ellipse at 70% 90%, rgba(255, 255, 255, 0.5) 0%, rgba(173, 216, 230, 0.35) 20%, rgba(255, 215, 0, 0.2) 40%, transparent 60%)",
    filter: "blur(35px)",
  });
  container.appendChild(baseGlow);

  // Golden shimmer layer
  const shimmerLayer = document.createElement("div");
  Object.assign(shimmerLayer.style, {
    position: "absolute",
    right: "0",
    bottom: "0",
    width: "100%",
    height: "70%",
    background:
      "radial-gradient(ellipse at 60% 100%, rgba(255, 223, 100, 0.3) 0%, rgba(200, 230, 255, 0.2) 30%, transparent 55%)",
    filter: "blur(30px)",
  });
  container.appendChild(shimmerLayer);

  // Soft white light rays
  const lightRays = document.createElement("div");
  Object.assign(lightRays.style, {
    position: "absolute",
    right: "10%",
    bottom: "10%",
    width: "80%",
    height: "60%",
    background:
      "radial-gradient(ellipse at 65% 85%, rgba(255, 255, 255, 0.35) 0%, rgba(200, 220, 255, 0.15) 30%, transparent 55%)",
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

// ===== Mascot Choice Mode =====

function enableMascotChoice(overlay, devilMascot, angelMascot) {
  // Show "choose your side" prompt at the top center
  const prompt = document.createElement("div");
  prompt.className = "ff-choice-prompt";
  Object.assign(prompt.style, {
    position: "absolute",
    top: "60px",
    left: "50%",
    transform: "translateX(-50%)",
    color: "#FFFFFF",
    fontFamily: FF_FONT,
    fontSize: "18px",
    fontWeight: "600",
    textAlign: "center",
    letterSpacing: "0.5px",
    textShadow: "0 2px 8px rgba(0, 0, 0, 0.5)",
    zIndex: "3",
    pointerEvents: "none",
    opacity: "0",
  });
  prompt.textContent = "Choose your side";
  overlay.appendChild(prompt);

  // GSAP fade-in for prompt
  gsap.to(prompt, {
    opacity: 0.9,
    y: 0,
    duration: 0.5,
    ease: "power2.out",
  });

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
      filter: "drop-shadow(0 0 28px rgba(46, 204, 113, 0.8))",
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
    // Re-init inactivity detection now that user is on a (newly) allowed site
    if (isSessionActive) {
      initInactivityDetection();
    }
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
    // Background says this site is not allowed → start distraction timer
    startDistraction(msg.site);
  }
});

// ================================================================
// SECTION 5: PARSING COLLECTOR
// ================================================================

const parsingCollector = initParsingCollector();
parsingCollector.start();
