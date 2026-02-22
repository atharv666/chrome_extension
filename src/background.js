// ===== Focus Flow - Background Service Worker =====

import { auth } from "./firebase.js";
import { onAuthStateChanged } from "firebase/auth";
import {
  getCurrentSessionId,
  loadActiveSession,
  clearStaleSession,
  updateActiveSession,
  isSessionStale,
} from "./sync.js";

// ===== Badge + Parse Pipeline + Session Sync Alarms =====

const BADGE_ALARM_NAME = "focusflow-badge-update";
const PARSE_FLUSH_ALARM_NAME = "focusflow-parse-flush";
const SESSION_SYNC_ALARM_NAME = "focusflow-session-sync";
const SESSION_REMOTE_CHECK_ALARM_NAME = "focusflow-session-remote-check";
const SESSION_DISCOVERY_ALARM_NAME = "focusflow-session-discovery";

const PARSE_API_ENDPOINT_KEY = "parseApiEndpoint";
const DEFAULT_PARSE_API_ENDPOINT = "http://localhost:3000/api/parse";
const AI_API_ENDPOINT_KEY = "aiApiEndpoint";
const DEFAULT_AI_API_ENDPOINT = "http://localhost:3000/api/ai/analyze";
const parseBatchQueue = [];
let isFlushingParseQueue = false;
const aiInterventionState = {
  lastAt: 0,
  cooldownMs: 15000,
};

const tabTracking = {
  activeTabId: null,
  activeSince: null,
  tabSwitchCount: 0,
  perTabMs: {},
  tabMeta: {},
};

function normalizeDomainLike(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";

  return raw
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
}

function isDomainAllowed(hostname, allowedSites = []) {
  const normalizedHost = normalizeDomainLike(hostname);
  if (!normalizedHost) return false;

  return allowedSites.some((site) => {
    const normalizedSite = normalizeDomainLike(site);
    if (!normalizedSite) return false;
    return normalizedHost === normalizedSite || normalizedHost.endsWith(`.${normalizedSite}`);
  });
}

function bootstrapTabState() {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (tab.id && tab.url) {
        setTabMeta(tab.id, tab.url, tab.title || "");
      }
    });

    const activeTab = tabs.find((tab) => tab.active);
    if (activeTab && activeTab.id) {
      tabTracking.activeTabId = activeTab.id;
      tabTracking.activeSince = Date.now();
    }
  });
}

function formatBadgeTime(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0) return `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "<1m";
}

async function updateBadge() {
  const { session } = await chrome.storage.local.get(["session"]);

  if (session && session.active && session.startTime) {
    const elapsed = Date.now() - session.startTime;
    const text = formatBadgeTime(elapsed);

    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color: "#F47D5B" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

async function startBadgeAlarm() {
  await chrome.alarms.create(BADGE_ALARM_NAME, { periodInMinutes: 0.5 });
}

async function stopBadgeAlarm() {
  await chrome.alarms.clear(BADGE_ALARM_NAME);
}

async function startParseFlushAlarm() {
  await chrome.alarms.create(PARSE_FLUSH_ALARM_NAME, { periodInMinutes: 0.25 });
}

async function stopParseFlushAlarm() {
  await chrome.alarms.clear(PARSE_FLUSH_ALARM_NAME);
}

// ===== Session Sync Alarm (every 2 minutes) =====

async function startSessionSyncAlarm() {
  await chrome.alarms.create(SESSION_SYNC_ALARM_NAME, { periodInMinutes: 2 });
}

async function stopSessionSyncAlarm() {
  await chrome.alarms.clear(SESSION_SYNC_ALARM_NAME);
}

// ===== Remote Session Check Alarm (every 30 seconds) =====

async function startSessionRemoteCheckAlarm() {
  await chrome.alarms.create(SESSION_REMOTE_CHECK_ALARM_NAME, {
    periodInMinutes: 0.5, // 30 seconds
  });
}

async function stopSessionRemoteCheckAlarm() {
  await chrome.alarms.clear(SESSION_REMOTE_CHECK_ALARM_NAME);
}

// ===== Session Discovery Alarm (every 2 minutes, runs when no local session) =====

async function startSessionDiscoveryAlarm() {
  await chrome.alarms.create(SESSION_DISCOVERY_ALARM_NAME, {
    periodInMinutes: 0.167, // ~10 seconds (for development)
  });
}

async function stopSessionDiscoveryAlarm() {
  await chrome.alarms.clear(SESSION_DISCOVERY_ALARM_NAME);
}

// In-memory dedup: track last notified session ID to avoid repeat notifications
let lastNotifiedDiscoverySessionId = null;

// Track whether Firebase Auth is ready (currentUser available)
let isAuthReady = false;

function computeFocusScoreBg(totalElapsed, distractionTime) {
  if (totalElapsed <= 0) return 100;
  const focused = Math.max(0, totalElapsed - (distractionTime || 0));
  return Math.round((focused / totalElapsed) * 100);
}

async function syncSessionToFirestore() {
  const { session } = await chrome.storage.local.get(["session"]);

  if (!session || !session.active || !session.firestoreSessionId) return;

  const elapsed = Date.now() - (session.startTime || Date.now());
  const stats = session.distractionStats || {};

  try {
    await updateActiveSession(session.firestoreSessionId, {
      duration: elapsed,
      distractions: stats.count || 0,
      distractionTime: stats.totalTime || 0,
      distractingSites: stats.sites || {},
      choices: stats.choices || { angel: 0, devil: 0 },
      focusScore: computeFocusScoreBg(elapsed, stats.totalTime || 0),
    });
  } catch (e) {
    console.warn("Focus Flow: periodic session sync failed", e);
  }
}

// ===== Remote Session End Detection =====

/**
 * Check if the remote session has been ended (e.g., phone removed currentSessionId).
 * If so, auto-end the local session and notify the user.
 */
async function checkRemoteSessionState() {
  // Wait for Firebase Auth to be ready before checking Firestore
  if (!isAuthReady) return;

  const { session } = await chrome.storage.local.get(["session"]);

  // Only check if we have an active local session with a Firestore ID
  if (!session || !session.active || !session.firestoreSessionId) return;

  try {
    const remoteSessionId = await getCurrentSessionId();

    // If currentSessionId is absent or doesn't match our local session,
    // the session was ended remotely (e.g., from the phone app)
    if (!remoteSessionId || remoteSessionId !== session.firestoreSessionId) {
      await handleRemoteSessionEnd(session);
    }
  } catch (e) {
    console.warn("Focus Flow: remote session check failed", e);
  }
}

/**
 * Handle the case where a session was ended remotely.
 * Loads final stats from Firestore, saves to local history, clears local session,
 * stops all alarms, shows a browser notification, and notifies popup if open.
 */
async function handleRemoteSessionEnd(localSession) {
  // Try to load final stats from Firestore
  let finalStats = null;
  try {
    finalStats = await loadActiveSession(localSession.firestoreSessionId);
  } catch (e) {
    console.warn("Focus Flow: could not load final session stats from cloud", e);
  }

  const elapsed = Date.now() - (localSession.startTime || Date.now());
  const stats = localSession.distractionStats || {};

  // Build session record using cloud data if available, falling back to local
  const sessionRecord = {
    topic: localSession.topic,
    startTime: localSession.startTime,
    endTime: finalStats?.endTime || Date.now(),
    duration: finalStats?.duration || elapsed,
    focusScore: finalStats?.focusScore ?? computeFocusScoreBg(elapsed, stats.totalTime || 0),
    distractions: finalStats?.distractions ?? (stats.count || 0),
    distractionTime: finalStats?.distractionTime ?? (stats.totalTime || 0),
    distractingSites: finalStats?.distractingSites || stats.sites || {},
    choices: finalStats?.choices || stats.choices || { angel: 0, devil: 0 },
  };

  // Save to local history
  await saveSessionHistoryLocalBg(sessionRecord);

  // Clear local session
  await chrome.storage.local.remove("session");

  // Stop all session-related alarms
  stopBadgeAlarm();
  stopParseFlushAlarm();
  stopSessionSyncAlarm();
  stopSessionRemoteCheckAlarm();
  startSessionDiscoveryAlarm();
  chrome.action.setBadgeText({ text: "" });

  // Show browser notification
  try {
    chrome.notifications.create("focusflow-remote-end", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Session Ended",
      message: `Your "${localSession.topic}" session was ended on another device.`,
    });
  } catch (e) {
    console.warn("Focus Flow: notification failed", e);
  }

  // Notify popup if it's open (silently fails if popup is closed)
  chrome.runtime.sendMessage({
    action: "sessionEndedRemotely",
    sessionRecord,
  }).catch(() => {});
}

/**
 * Save a session record to local history (background.js version).
 * Same logic as popup's saveSessionHistoryLocal but callable from background.
 */
async function saveSessionHistoryLocalBg(record) {
  const { sessionHistory = [] } = await chrome.storage.local.get(["sessionHistory"]);

  sessionHistory.push(record);

  // Keep last 50 sessions
  if (sessionHistory.length > 50) {
    sessionHistory.splice(0, sessionHistory.length - 50);
  }

  await chrome.storage.local.set({ sessionHistory });
}

// ===== Session Discovery (detect sessions started on other devices) =====

/**
 * Periodically check Firestore for a new session started on another device.
 * Only runs when there is NO active local session.
 * Shows a browser notification when a new session is discovered.
 */
async function checkForNewCloudSession() {
  // Wait for Firebase Auth to be ready before checking Firestore
  if (!isAuthReady) return;

  const { session } = await chrome.storage.local.get(["session"]);

  // If there's already an active local session, nothing to discover
  if (session && session.active) return;

  try {
    const cloudSessionId = await getCurrentSessionId();

    // No active session in the cloud either
    if (!cloudSessionId) {
      lastNotifiedDiscoverySessionId = null;
      return;
    }

    // Already notified for this session — don't spam
    if (cloudSessionId === lastNotifiedDiscoverySessionId) return;

    const cloudSession = await loadActiveSession(cloudSessionId);
    if (!cloudSession) {
      // Session ID set but document missing — clear it
      await clearStaleSession(cloudSessionId);
      return;
    }

    // Stale session — auto-clear
    if (isSessionStale(cloudSession.startTime)) {
      await clearStaleSession(cloudSessionId);
      return;
    }

    // Valid active session found on another device — notify the user
    lastNotifiedDiscoverySessionId = cloudSessionId;

    try {
      chrome.notifications.create("focusflow-session-discovered", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Focus Session Active",
        message: `A "${cloudSession.topic || "Untitled"}" session is running on another device. Open Focus Flow to resume.`,
      });
    } catch (e) {
      console.warn("Focus Flow: discovery notification failed", e);
    }
  } catch (e) {
    console.warn("Focus Flow: session discovery check failed", e);
  }
}

function setTabMeta(tabId, url, title = "") {
  if (!tabId || !url) return;
  let domain = "";
  try {
    domain = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    domain = "";
  }

  tabTracking.tabMeta[tabId] = {
    url,
    title,
    domain,
  };
}

function checkpointActiveTabDuration() {
  if (!tabTracking.activeTabId || !tabTracking.activeSince) return;
  const elapsed = Date.now() - tabTracking.activeSince;
  if (elapsed <= 0) return;

  tabTracking.perTabMs[tabTracking.activeTabId] =
    (tabTracking.perTabMs[tabTracking.activeTabId] || 0) + elapsed;
  tabTracking.activeSince = Date.now();
}

function buildOpenTabsSnapshot() {
  function compactUrl(url) {
    try {
      const u = new URL(url);
      const keep = ["q", "search_query", "v"];
      const next = new URL(`${u.origin}${u.pathname}`);
      keep.forEach((key) => {
        const value = u.searchParams.get(key);
        if (value) next.searchParams.set(key, value);
      });
      return next.toString();
    } catch {
      return url;
    }
  }

  return Object.entries(tabTracking.tabMeta).map(([tabId, value]) => ({
    tab_id: Number(tabId),
    url: value.url ? compactUrl(value.url) : null,
    domain: value.domain || null,
  }));
}

async function getParseEndpoint() {
  const res = await chrome.storage.local.get([PARSE_API_ENDPOINT_KEY]);
  return res[PARSE_API_ENDPOINT_KEY] || DEFAULT_PARSE_API_ENDPOINT;
}

async function getAiEndpoint() {
  const res = await chrome.storage.local.get([AI_API_ENDPOINT_KEY]);
  return res[AI_API_ENDPOINT_KEY] || DEFAULT_AI_API_ENDPOINT;
}

async function postParsedData(payload) {
  const endpoint = await getParseEndpoint();

  try {
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn("Focus Flow: parse post failed", error);
  }
}

async function requestAiDecision(payload) {
  const endpoint = await getAiEndpoint();

  async function fetchDecision(url) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) return null;
    const data = await response.json();
    return data?.decision || null;
  }

  try {
    return await fetchDecision(endpoint);
  } catch (error) {
    console.warn("Focus Flow: ai analyze failed on configured endpoint", endpoint, error);

    if (endpoint !== DEFAULT_AI_API_ENDPOINT) {
      try {
        const decision = await fetchDecision(DEFAULT_AI_API_ENDPOINT);
        await chrome.storage.local.set({ [AI_API_ENDPOINT_KEY]: DEFAULT_AI_API_ENDPOINT });
        console.warn("Focus Flow: reverted ai endpoint to default", DEFAULT_AI_API_ENDPOINT);
        return decision;
      } catch (fallbackError) {
        console.warn("Focus Flow: ai analyze fallback failed", fallbackError);
      }
    }

    return null;
  }
}

function shouldTriggerIntervention(decision, payload = null) {
  if (!decision || decision.intervention === "none") return false;

  const triggerType = payload?.trigger_type || null;
  if (triggerType === "idle_allowed_site" || triggerType === "idle_allowed_site_retry") {
    aiInterventionState.lastAt = Date.now();
    return true;
  }

  const now = Date.now();
  if (now - aiInterventionState.lastAt < aiInterventionState.cooldownMs) {
    return false;
  }
  aiInterventionState.cooldownMs = Math.max(
    10000,
    Math.min(30000, Number(decision.cooldown_seconds || 90) * 1000)
  );
  aiInterventionState.lastAt = now;
  return true;
}

async function dispatchAiIntervention(decision, payload, targetTabId = null) {
  if (!shouldTriggerIntervention(decision, payload)) return;

  const tabId = targetTabId || tabTracking.activeTabId;
  if (!tabId) return;

  try {
    await chrome.tabs.sendMessage(tabId, {
      action: "aiIntervention",
      payload: {
        ...decision,
        sessionTopic: payload.study_topic || "",
        triggerType: payload.trigger_type || null,
        requestedIntervention: payload.requested_intervention || null,
      },
    });
  } catch {
    // ignore send failures for tabs without ready content scripts
  }
}

async function requestImmediateAiIntervention(triggerPayload, sender) {
  checkpointActiveTabDuration();
  const { session } = await chrome.storage.local.get(["session"]);
  if (!session || !session.active) return;

  const tabId = sender?.tab?.id;
  if (tabId && sender.tab?.url) {
    setTabMeta(tabId, sender.tab.url, sender.tab.title || "");
  }

  const payload = {
    type: "immediate",
    trigger_type: triggerPayload.triggerType || "manual",
    requested_intervention: triggerPayload.preferredIntervention || "none",
    timestamp: Date.now(),
    study_topic: session.topic || "",
    session_duration: session.startTime
      ? Math.floor((Date.now() - session.startTime) / 1000)
      : 0,
    tab_switches: tabTracking.tabSwitchCount,
    active_tab_id: tabTracking.activeTabId,
    active_tab_time_seconds: tabTracking.activeTabId
      ? Math.floor((tabTracking.perTabMs[tabTracking.activeTabId] || 0) / 1000)
      : 0,
    open_tabs: buildOpenTabsSnapshot(),
    events: [
      {
        ...(triggerPayload.event || {}),
        tab_id: tabId || null,
      },
    ],
  };

  await postParsedData(payload);
  let decision = await requestAiDecision(payload);

  const isIdleFlashcardTrigger =
    payload.trigger_type === "idle_allowed_site" || payload.trigger_type === "idle_allowed_site_retry";

  if (
    isIdleFlashcardTrigger &&
    decision &&
    decision.intervention === "none" &&
    decision.flashcard &&
    decision.flashcard.question
  ) {
    decision = {
      ...decision,
      intervention: "flashcard",
      status: decision.status === "focused" ? "mild_distraction" : decision.status,
      confidence: Math.max(Number(decision.confidence || 0), 0.7),
      reason_codes: [...(Array.isArray(decision.reason_codes) ? decision.reason_codes : []), "idle_force_flashcard"],
    };
  }

  await dispatchAiIntervention(decision, payload, tabId || null);
}

async function flushParseQueue() {
  if (isFlushingParseQueue || !parseBatchQueue.length) return;
  isFlushingParseQueue = true;

  try {
    checkpointActiveTabDuration();
    const { session } = await chrome.storage.local.get(["session"]);

    if (!session || !session.active) {
      parseBatchQueue.splice(0, parseBatchQueue.length);
      return;
    }

    const items = parseBatchQueue.splice(0, parseBatchQueue.length);
    if (!items.length) return;

    const payload = {
      type: "batch",
      timestamp: Date.now(),
      study_topic: session.topic || "",
      session_duration: session.startTime
        ? Math.floor((Date.now() - session.startTime) / 1000)
        : 0,
      tab_switches: tabTracking.tabSwitchCount,
      active_tab_id: tabTracking.activeTabId,
      active_tab_time_seconds: tabTracking.activeTabId
        ? Math.floor((tabTracking.perTabMs[tabTracking.activeTabId] || 0) / 1000)
        : 0,
      open_tabs: buildOpenTabsSnapshot(),
      per_tab_seconds: Object.fromEntries(
        Object.entries(tabTracking.perTabMs).map(([tabId, ms]) => [
          tabId,
          Math.floor(ms / 1000),
        ])
      ),
      events: items,
    };

    await postParsedData(payload);
    const decision = await requestAiDecision(payload);
    await dispatchAiIntervention(decision, payload);
  } finally {
    isFlushingParseQueue = false;
  }
}

function queueParsePayload(payload, sender) {
  const tabId = sender?.tab?.id;
  if (tabId && sender.tab?.url) {
    setTabMeta(tabId, sender.tab.url, sender.tab.title || "");
  }

  parseBatchQueue.push({
    ...payload,
    tab_id: tabId || null,
  });
}

async function handleParseImmediate(payload, sender) {
  checkpointActiveTabDuration();

  const tabId = sender?.tab?.id;
  if (tabId && sender.tab?.url) {
    setTabMeta(tabId, sender.tab.url, sender.tab.title || "");
  }

  const { session } = await chrome.storage.local.get(["session"]);
  if (!session || !session.active) return;

  const immediatePayload = {
    type: "immediate",
    timestamp: Date.now(),
    study_topic: session.topic || "",
    session_duration: session.startTime
      ? Math.floor((Date.now() - session.startTime) / 1000)
      : 0,
    tab_switches: tabTracking.tabSwitchCount,
    active_tab_id: tabTracking.activeTabId,
    active_tab_time_seconds: tabTracking.activeTabId
      ? Math.floor((tabTracking.perTabMs[tabTracking.activeTabId] || 0) / 1000)
      : 0,
    open_tabs: buildOpenTabsSnapshot(),
    events: [
      {
        ...payload,
        tab_id: tabId || null,
      },
    ],
  };

  await postParsedData(immediatePayload);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM_NAME) {
    updateBadge();
    return;
  }

  if (alarm.name === PARSE_FLUSH_ALARM_NAME) {
    flushParseQueue();
    return;
  }

  if (alarm.name === SESSION_SYNC_ALARM_NAME) {
    syncSessionToFirestore();
    return;
  }

  if (alarm.name === SESSION_REMOTE_CHECK_ALARM_NAME) {
    checkRemoteSessionState();
    return;
  }

  if (alarm.name === SESSION_DISCOVERY_ALARM_NAME) {
    checkForNewCloudSession();
    return;
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  checkpointActiveTabDuration();
  tabTracking.tabSwitchCount += 1;
  tabTracking.activeTabId = activeInfo.tabId;
  tabTracking.activeSince = Date.now();

  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (!tab?.url) return;

    if (
      tab.url.startsWith("chrome://") ||
      tab.url.startsWith("chrome-extension://") ||
      tab.url.startsWith("about:")
    ) {
      return;
    }

    chrome.storage.local.get(["session"], (res) => {
      if (!res.session || !res.session.active) return;

      let hostname;
      try {
        hostname = new URL(tab.url).hostname;
      } catch {
        return;
      }

      const allowed = res.session.allowedSites || [];
      const isAllowed = isDomainAllowed(hostname, allowed);

      if (!isAllowed) {
        chrome.tabs
          .sendMessage(activeInfo.tabId, {
            action: "block",
            site: hostname,
          })
          .catch(() => {});
      }
    });
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabTracking.perTabMs[tabId];
  delete tabTracking.tabMeta[tabId];

  if (tabTracking.activeTabId === tabId) {
    tabTracking.activeTabId = null;
    tabTracking.activeSince = null;
  }
});

// On startup, check if a session is active and start/stop alarms accordingly
chrome.storage.local.get(["session"], (res) => {
  bootstrapTabState();

  if (res.session && res.session.active) {
    updateBadge();
    startBadgeAlarm();
    startParseFlushAlarm();
    startSessionSyncAlarm();
    startSessionRemoteCheckAlarm();
    stopSessionDiscoveryAlarm();
  } else {
    startSessionDiscoveryAlarm();
  }
});

// ===== Cloud Session Resume on Startup =====
// Wait for Firebase Auth to be ready, then check Firestore for active session
onAuthStateChanged(auth, async (user) => {
  if (!user) {
    isAuthReady = false;
    return;
  }

  isAuthReady = true;

  const { session: localSession } = await chrome.storage.local.get(["session"]);

  // If there's already an active local session, skip cloud resume
  if (localSession && localSession.active) return;

  // Auth is ready and no local session — run immediate discovery check
  // so we don't have to wait for the next alarm tick
  checkForNewCloudSession();

  try {
    const currentSessionId = await getCurrentSessionId();
    if (!currentSessionId) return;

    const cloudSession = await loadActiveSession(currentSessionId);
    if (!cloudSession) {
      await clearStaleSession(currentSessionId);
      return;
    }

    // Check if session is stale (>24 hours)
    if (isSessionStale(cloudSession.startTime)) {
      await clearStaleSession(currentSessionId);
      return;
    }

    // Resume session locally — the popup will show it when opened
    const resumedSession = {
      active: true,
      topic: cloudSession.topic,
      allowedSites: cloudSession.allowedSites || [],
      startTime: cloudSession.startTime,
      firestoreSessionId: currentSessionId,
      distractionStats: {
        count: cloudSession.distractions || 0,
        totalTime: cloudSession.distractionTime || 0,
        sites: cloudSession.distractingSites || {},
        choices: cloudSession.choices || { angel: 0, devil: 0 },
      },
    };

    await chrome.storage.local.set({ session: resumedSession });
    // Alarms will start via the storage change listener
  } catch (e) {
    console.warn("Focus Flow: cloud session resume failed on startup", e);
  }
});

// ===== Tab Monitoring (Distraction Blocking) =====

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab?.url) {
    setTabMeta(tabId, tab.url, tab.title || "");
  }

  if (changeInfo.status !== "complete" || !tab.url) return;

  if (
    tab.url.startsWith("chrome://") ||
    tab.url.startsWith("chrome-extension://") ||
    tab.url.startsWith("about:")
  ) {
    return;
  }

  chrome.storage.local.get(["session"], (res) => {
    if (!res.session || !res.session.active) return;

    let hostname;
    try {
      hostname = new URL(tab.url).hostname;
    } catch {
      return;
    }

    const allowed = res.session.allowedSites || [];

    const isAllowed = isDomainAllowed(hostname, allowed);

    if (!isAllowed) {
      chrome.tabs
        .sendMessage(tabId, {
          action: "block",
          site: hostname,
        })
        .catch(() => {
          setTimeout(() => {
            chrome.tabs
              .sendMessage(tabId, {
                action: "block",
                site: hostname,
              })
              .catch(() => {});
          }, 500);
        });
    }
  });
});

// ===== Message Handler =====

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.action === "parseImmediate" && msg.payload) {
    handleParseImmediate(msg.payload, sender);
    return;
  }

  if (msg.action === "requestAiInterventionNow" && msg.payload) {
    requestImmediateAiIntervention(msg.payload, sender);
    return;
  }

  if (msg.action === "parseBatch" && msg.payload) {
    queueParsePayload(msg.payload, sender);
    return;
  }

  if (msg.action === "setParseEndpoint" && typeof msg.endpoint === "string") {
    chrome.storage.local.set({ [PARSE_API_ENDPOINT_KEY]: msg.endpoint.trim() });
    return;
  }

  if (msg.action === "setAiEndpoint" && typeof msg.endpoint === "string") {
    chrome.storage.local.set({ [AI_API_ENDPOINT_KEY]: msg.endpoint.trim() });
    return;
  }

  if (msg.action === "closeTab" && sender.tab) {
    chrome.tabs.remove(sender.tab.id).catch(() => {});
  }

  if (msg.action === "addAllowed") {
    chrome.storage.local.get(["session"], (res) => {
      const session = res.session;
      if (!session) return;

      session.allowedSites = session.allowedSites || [];

      if (!session.allowedSites.includes(msg.site)) {
        session.allowedSites.push(msg.site);
      }

      chrome.storage.local.set({ session });
    });
  }

  if (msg.action === "sessionStarted") {
    updateBadge();
    startBadgeAlarm();
    startParseFlushAlarm();
    startSessionSyncAlarm();
    startSessionRemoteCheckAlarm();
    stopSessionDiscoveryAlarm();
  }

  if (msg.action === "sessionEnded") {
    chrome.action.setBadgeText({ text: "" });
    stopBadgeAlarm();
    flushParseQueue();
    stopParseFlushAlarm();
    stopSessionSyncAlarm();
    stopSessionRemoteCheckAlarm();
    startSessionDiscoveryAlarm();
  }
});

// ===== Storage Change Listener =====

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.session) return;

  const next = changes.session.newValue;
  if (next && next.active) {
    updateBadge();
    startBadgeAlarm();
    startParseFlushAlarm();
    startSessionSyncAlarm();
    startSessionRemoteCheckAlarm();
    stopSessionDiscoveryAlarm();
    return;
  }

  chrome.action.setBadgeText({ text: "" });
  stopBadgeAlarm();
  flushParseQueue();
  stopParseFlushAlarm();
  stopSessionSyncAlarm();
  stopSessionRemoteCheckAlarm();
  startSessionDiscoveryAlarm();
});
