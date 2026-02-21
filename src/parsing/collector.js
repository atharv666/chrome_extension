import { PARSING_CONFIG } from "./config.js";
import {
  categorizeDomain,
  compactUrl,
  estimateRelevance,
  isAllowedSite,
  isYouTubeUrl,
  nowTs,
  parseDomain,
  simpleHash,
} from "./helpers.js";
import { createIncrementalTracker } from "./incremental-tracker.js";
import { parseGeneralPageContent, parsePageLite } from "./text-parser.js";
import { parseYouTubeContext, setupYouTubeHoverTracker } from "./youtube-parser.js";

function withSessionContext(cb) {
  chrome.storage.local.get(["session"], (res) => cb(res.session || null));
}

function isCurrentTabActive() {
  return document.visibilityState === "visible" && document.hasFocus();
}

export function initParsingCollector() {
  const tracker = createIncrementalTracker();

  const behavior = {
    lastActivityTs: nowTs(),
    mouseEvents: [],
    clickEvents: [],
    scrollDistancePx: 0,
    scrollWindowStartTs: nowTs(),
    lastScrollY: window.scrollY,
    pageEnterTs: nowTs(),
  };

  let lastUrl = window.location.href;
  let batchTimer = null;
  let urlTimer = null;
  let lastSentHash = "";

  function markActivity(type) {
    const ts = nowTs();
    behavior.lastActivityTs = ts;
    if (type === "mousemove") behavior.mouseEvents.push(ts);
    if (type === "click") behavior.clickEvents.push(ts);
  }

  function onScroll() {
    markActivity("scroll");
    const currentY = window.scrollY;
    behavior.scrollDistancePx += Math.abs(currentY - behavior.lastScrollY);
    behavior.lastScrollY = currentY;
  }

  function compactBehaviorArrays() {
    const threshold = nowTs() - 60000;
    behavior.mouseEvents = behavior.mouseEvents.filter((t) => t >= threshold);
    behavior.clickEvents = behavior.clickEvents.filter((t) => t >= threshold);
  }

  function computeBehaviorMetrics() {
    compactBehaviorArrays();
    const now = nowTs();
    const elapsedSec = Math.max(1, Math.floor((now - behavior.scrollWindowStartTs) / 1000));
    const scrollSpeed = Math.round(behavior.scrollDistancePx / elapsedSec);

    behavior.scrollDistancePx = 0;
    behavior.scrollWindowStartTs = now;

    return {
      inactivity_seconds: Math.floor((now - behavior.lastActivityTs) / 1000),
      time_on_page_seconds: Math.floor((now - behavior.pageEnterTs) / 1000),
      mouse_events_per_minute: behavior.mouseEvents.length,
      clicks_per_minute: behavior.clickEvents.length,
      scroll_speed_px_per_sec: scrollSpeed,
    };
  }

  function sendMessage(payload) {
    try {
      chrome.runtime.sendMessage(payload);
    } catch {
      // ignore transient runtime send errors
    }
  }

  function buildLitePayload(session, mode) {
    const lite = parsePageLite();
    const domain = parseDomain(window.location.href);
    const category = categorizeDomain(domain);
    const allowedSites = session?.allowedSites || [];

    return {
      timestamp: nowTs(),
      study_topic: session?.topic || "",
      mode,
      website: {
        url: compactUrl(lite.page.url),
        domain: lite.page.domain,
        title: lite.page.page_title,
        category,
        is_allowed: isAllowedSite(domain, allowedSites),
      },
      metadata: lite.metadata,
      behavior: computeBehaviorMetrics(),
    };
  }

  function buildFullPayload(session) {
    const general = parseGeneralPageContent();
    const domain = parseDomain(window.location.href);
    const category = categorizeDomain(domain);
    const allowedSites = session?.allowedSites || [];
    const studyTopic = session?.topic || "";
    const relevance = estimateRelevance(
      studyTopic,
      general.page.page_title,
      general.content.visible_text_summary
    );

    const youtube = isYouTubeUrl(window.location.href) ? parseYouTubeContext() : null;
    const incrementalRaw = tracker.flush();
    const incremental = {
      headings: incrementalRaw.headings.slice(0, 5),
      paragraphs: incrementalRaw.paragraphs.slice(0, 2).map((p) => p.slice(0, 400)),
      images: incrementalRaw.images.slice(0, 3),
    };

    const payload = {
      ...buildLitePayload(session, "batch"),
      website: {
        ...general.page,
        category,
        is_allowed: isAllowedSite(domain, allowedSites),
        is_relevant_to_topic: relevance,
      },
      metadata: general.metadata,
      content: {
        headings: general.content.top_headings,
        summary: general.content.visible_text_summary,
        word_count: general.content.word_count,
        search_results: general.content.search_results || [],
      },
      media: general.media,
      dom_features: general.dom_features,
      youtube,
      incremental,
    };

    payload.content_hash = simpleHash(
      `${payload.website.url}|${payload.content.headings.join("|")}|${payload.content.summary}|${JSON.stringify(payload.incremental)}`
    );
    return payload;
  }

  function sendImmediate() {
    if (!isCurrentTabActive()) return;

    withSessionContext((session) => {
      if (!session?.active) return;
      sendMessage({
        action: "parseImmediate",
        payload: buildLitePayload(session, "immediate"),
      });
    });
  }

  function sendBatch() {
    if (!isCurrentTabActive()) return;

    withSessionContext((session) => {
      if (!session?.active) return;
      const full = buildFullPayload(session);

      const hasIncremental =
        full.incremental.headings.length > 0 ||
        full.incremental.paragraphs.length > 0 ||
        full.incremental.images.length > 0;

      if (!hasIncremental && full.content_hash === lastSentHash) {
        return;
      }

      lastSentHash = full.content_hash;

      sendMessage({
        action: "parseBatch",
        payload: full,
      });
    });
  }

  function handleUrlChange() {
    const next = window.location.href;
    if (next === lastUrl) return;

    lastUrl = next;
    behavior.pageEnterTs = nowTs();
    behavior.lastScrollY = window.scrollY;
    lastSentHash = "";
    sendImmediate();
  }

  function start() {
    tracker.start();
    sendImmediate();

    document.addEventListener("mousemove", () => markActivity("mousemove"), true);
    document.addEventListener("click", () => markActivity("click"), true);
    document.addEventListener("keydown", () => markActivity("keydown"), true);
    document.addEventListener("touchstart", () => markActivity("touchstart"), true);
    window.addEventListener("scroll", onScroll, { passive: true });

    urlTimer = setInterval(handleUrlChange, PARSING_CONFIG.URL_POLL_INTERVAL_MS);
    batchTimer = setInterval(sendBatch, PARSING_CONFIG.BATCH_INTERVAL_MS);

    setupYouTubeHoverTracker(
      (hover) => {
        if (!isCurrentTabActive()) return;

        withSessionContext((session) => {
          if (!session?.active) return;
          sendMessage({
            action: "parseBatch",
            payload: {
              ...buildLitePayload(session, "interaction"),
              interaction: hover,
            },
          });
        });
      },
      PARSING_CONFIG.HOVER_DELAY_MS
    );
  }

  function stop() {
    tracker.stop();
    if (urlTimer) clearInterval(urlTimer);
    if (batchTimer) clearInterval(batchTimer);
  }

  return { start, stop, sendImmediate, sendBatch };
}
