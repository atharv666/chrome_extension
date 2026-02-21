// ===== Focus Flow - Background Service Worker =====

// ===== Badge + Parse Pipeline Alarms =====

const BADGE_ALARM_NAME = "focusflow-badge-update";
const PARSE_FLUSH_ALARM_NAME = "focusflow-parse-flush";

const PARSE_API_ENDPOINT_KEY = "parseApiEndpoint";
const DEFAULT_PARSE_API_ENDPOINT = "http://localhost:3000/api/parse";
const parseBatchQueue = [];
let isFlushingParseQueue = false;

const tabTracking = {
  activeTabId: null,
  activeSince: null,
  tabSwitchCount: 0,
  perTabMs: {},
  tabMeta: {},
};

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
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  checkpointActiveTabDuration();
  tabTracking.tabSwitchCount += 1;
  tabTracking.activeTabId = activeInfo.tabId;
  tabTracking.activeSince = Date.now();
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

    const isAllowed = allowed.some((site) => {
      return hostname === site || hostname.endsWith("." + site);
    });

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

  if (msg.action === "parseBatch" && msg.payload) {
    queueParsePayload(msg.payload, sender);
    return;
  }

  if (msg.action === "setParseEndpoint" && typeof msg.endpoint === "string") {
    chrome.storage.local.set({ [PARSE_API_ENDPOINT_KEY]: msg.endpoint.trim() });
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
  }

  if (msg.action === "sessionEnded") {
    chrome.action.setBadgeText({ text: "" });
    stopBadgeAlarm();
    flushParseQueue();
    stopParseFlushAlarm();
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
    return;
  }

  chrome.action.setBadgeText({ text: "" });
  stopBadgeAlarm();
  flushParseQueue();
  stopParseFlushAlarm();
});
