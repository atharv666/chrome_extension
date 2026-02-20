// ===== Focus Flow - Background Service Worker =====

// ===== Badge Management =====

const BADGE_ALARM_NAME = "focusflow-badge-update";

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

// Start a periodic alarm for badge updates (survives service worker restarts)
async function startBadgeAlarm() {
  await chrome.alarms.create(BADGE_ALARM_NAME, { periodInMinutes: 0.5 }); // every 30 seconds
}

async function stopBadgeAlarm() {
  await chrome.alarms.clear(BADGE_ALARM_NAME);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BADGE_ALARM_NAME) {
    updateBadge();
  }
});

// On startup, check if a session is active and start/stop alarm accordingly
chrome.storage.local.get(["session"], (res) => {
  if (res.session && res.session.active) {
    updateBadge();
    startBadgeAlarm();
  }
});

// ===== Tab Monitoring (Distraction Blocking) =====

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  // Ignore internal chrome pages and extension pages
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

    // Check if the hostname matches any allowed site
    // Supports subdomain matching (e.g., "en.wikipedia.org" matches "wikipedia.org")
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
          // Content script might not be loaded yet, retry once after a short delay
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
  // Close the sender's tab
  if (msg.action === "closeTab" && sender.tab) {
    chrome.tabs.remove(sender.tab.id).catch(() => {});
  }

  // Dynamically add a site to the allowed list
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

  // Session started - update badge immediately and start alarm
  if (msg.action === "sessionStarted") {
    updateBadge();
    startBadgeAlarm();
  }

  // Session ended - clear badge and stop alarm
  if (msg.action === "sessionEnded") {
    chrome.action.setBadgeText({ text: "" });
    stopBadgeAlarm();
  }
});

// ===== Storage Change Listener =====

chrome.storage.onChanged.addListener((changes) => {
  if (changes.session) {
    const s = changes.session.newValue;
    if (s && s.active) {
      updateBadge();
      startBadgeAlarm();
    } else {
      chrome.action.setBadgeText({ text: "" });
      stopBadgeAlarm();
    }
  }
});
