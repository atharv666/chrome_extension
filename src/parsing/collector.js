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
    mouseDistanceEvents: [],
    mouseActiveEvents: [],
    lastMousePos: null,
    lastMouseTs: null,
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

  function onMouseMove(event) {
    const ts = nowTs();
    markActivity("mousemove");

    const nextPos = { x: event.clientX, y: event.clientY };
    if (behavior.lastMousePos) {
      const dx = nextPos.x - behavior.lastMousePos.x;
      const dy = nextPos.y - behavior.lastMousePos.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > 0) {
        behavior.mouseDistanceEvents.push({ ts, distance });
      }
    }

    if (behavior.lastMouseTs) {
      const delta = ts - behavior.lastMouseTs;
      const activeMs = Math.max(0, Math.min(delta, 1000));
      if (activeMs > 0) {
        behavior.mouseActiveEvents.push({ ts, activeMs });
      }
    }

    behavior.lastMousePos = nextPos;
    behavior.lastMouseTs = ts;
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
    behavior.mouseDistanceEvents = behavior.mouseDistanceEvents.filter((entry) => entry.ts >= threshold);
    behavior.mouseActiveEvents = behavior.mouseActiveEvents.filter((entry) => entry.ts >= threshold);
  }

  function computeBehaviorMetrics() {
    compactBehaviorArrays();
    const now = nowTs();
    const elapsedSec = Math.max(1, Math.floor((now - behavior.scrollWindowStartTs) / 1000));
    const scrollSpeed = Math.round(behavior.scrollDistancePx / elapsedSec);

    behavior.scrollDistancePx = 0;
    behavior.scrollWindowStartTs = now;

    const totalDistancePx = Math.round(
      behavior.mouseDistanceEvents.reduce((sum, entry) => sum + entry.distance, 0)
    );
    const activeMs = behavior.mouseActiveEvents.reduce((sum, entry) => sum + entry.activeMs, 0);
    const activeRatio = Math.max(0, Math.min(activeMs / 60000, 1));

    const distanceNorm = Math.min(totalDistancePx / 5000, 1);
    const frequencyNorm = Math.min(behavior.mouseEvents.length / 150, 1);
    const activeNorm = activeRatio;
    const mouseScore = Number(
      (0.5 * distanceNorm + 0.3 * frequencyNorm + 0.2 * activeNorm).toFixed(3)
    );

    return {
      inactivity_seconds: Math.floor((now - behavior.lastActivityTs) / 1000),
      time_on_page_seconds: Math.floor((now - behavior.pageEnterTs) / 1000),
      mouse_events_per_minute: behavior.mouseEvents.length,
      total_distance_px: totalDistancePx,
      movement_active_ratio: Number(activeRatio.toFixed(3)),
      mouse_score: mouseScore,
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

    const metrics = computeBehaviorMetrics();

    return {
      timestamp: nowTs(),
      study_topic: session?.topic || "",
      mode,
      url: compactUrl(lite.page.url),
      domain: lite.page.domain,
      page_title: lite.page.page_title,
      category,
      is_allowed: isAllowedSite(domain, allowedSites),
      metadata: lite.metadata,
      ...metrics,
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
      url: general.page.url,
      domain: general.page.domain,
      page_title: general.page.page_title,
      category,
      is_allowed: isAllowedSite(domain, allowedSites),
      is_relevant_to_topic: relevance,
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
      `${payload.url}|${payload.content.headings.join("|")}|${payload.content.summary}|${JSON.stringify(payload.incremental)}`
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

    document.addEventListener("mousemove", onMouseMove, true);
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
