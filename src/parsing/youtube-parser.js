import {
  cleanText,
  getYouTubeSearchQuery,
  getYouTubeVideoId,
} from "./helpers.js";

function queryFirst(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && cleanText(el.textContent)) return cleanText(el.textContent);
  }
  return null;
}

export function parseYouTubeContext() {
  const url = window.location.href;
  const videoId = getYouTubeVideoId(url);
  const query = getYouTubeSearchQuery(url);

  if (videoId) {
    return {
      kind: "video",
      video: {
        id: videoId,
        url,
        title:
          queryFirst([
            "h1.ytd-watch-metadata yt-formatted-string",
            "h1.title",
            "#title h1",
          ]) || cleanText(document.title).replace(/\s*-\s*YouTube$/i, ""),
        description: queryFirst([
          "#description-inline-expander",
          "ytd-text-inline-expander#description-inline-expander",
          "#description ytd-expander",
        ]),
        channel: queryFirst([
          "#channel-name a",
          "ytd-channel-name a",
          "#owner-name a",
        ]),
      },
    };
  }

  if (query) {
    return {
      kind: "search",
      search: {
        query,
      },
    };
  }

  return {
    kind: "feed",
    feed: {
      path: new URL(url).pathname,
    },
  };
}

export function setupYouTubeHoverTracker(onHover, delayMs) {
  let timer = null;

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  document.addEventListener(
    "mouseover",
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const card = target.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer");
      if (!card) return;

      clearTimer();
      timer = setTimeout(() => {
        const link = card.querySelector("a#video-title, a#thumbnail");
        const title = card.querySelector("#video-title");
        if (!link || !link.href) return;
        onHover({
          type: "youtube_hover",
          video: {
            url: link.href,
            id: getYouTubeVideoId(link.href),
            title: cleanText(title?.textContent || "") || null,
          },
        });
      }, delayMs);
    },
    true
  );

  document.addEventListener("mouseout", clearTimer, true);
}
