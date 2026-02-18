chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url) return;

  if (tab.url.startsWith("chrome://")) return;

  chrome.storage.local.get(["session"], (res) => {
    if (!res.session || !res.session.active) return;

    const hostname = new URL(tab.url).hostname;
    const allowed = res.session.allowedSites || [];

    const ok = allowed.some(site => hostname.includes(site));

    if (!ok) {
      chrome.tabs.sendMessage(tabId, {
        action: "block",
        site: hostname
      }).catch(() => {});
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender) => {

  if (msg.action === "closeTab" && sender.tab) {
    chrome.tabs.remove(sender.tab.id);
  }

  if (msg.action === "addAllowed") {
    chrome.storage.local.get(["session"], (res) => {
      const session = res.session || {};
      session.allowedSites = session.allowedSites || [];

      if (!session.allowedSites.includes(msg.site)) {
        session.allowedSites.push(msg.site);
      }

      chrome.storage.local.set({ session });
    });
  }
});
