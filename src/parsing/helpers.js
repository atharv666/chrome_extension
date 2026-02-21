import {
  CATEGORY,
  EDUCATION_DOMAINS,
  ENTERTAINMENT_DOMAINS,
  SOCIAL_DOMAINS,
} from "./config.js";

export function parseDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function compactUrl(url) {
  try {
    const u = new URL(url);
    const keepParams = ["q", "search_query", "v"];
    const next = new URL(`${u.origin}${u.pathname}`);
    keepParams.forEach((key) => {
      const value = u.searchParams.get(key);
      if (value) next.searchParams.set(key, value);
    });
    return next.toString();
  } catch {
    return url;
  }
}

function matchesDomain(domain, patterns) {
  return patterns.some(
    (item) => domain === item || domain.endsWith(`.${item}`)
  );
}

export function categorizeDomain(domain) {
  if (!domain) return CATEGORY.UNKNOWN;
  if (matchesDomain(domain, EDUCATION_DOMAINS)) return CATEGORY.EDUCATION;
  if (matchesDomain(domain, ENTERTAINMENT_DOMAINS)) return CATEGORY.ENTERTAINMENT;
  if (matchesDomain(domain, SOCIAL_DOMAINS)) return CATEGORY.SOCIAL;
  if (
    domain.includes("notion") ||
    domain.includes("docs.google") ||
    domain.includes("chat.openai") ||
    domain.includes("calendar")
  ) {
    return CATEGORY.PRODUCTIVITY;
  }
  return CATEGORY.UNKNOWN;
}

export function isAllowedSite(domain, allowedSites = []) {
  return allowedSites.some(
    (site) => domain === site || domain.endsWith(`.${site}`)
  );
}

export function estimateRelevance(studyTopic, title, text) {
  if (!studyTopic) return true;
  const topicWords = studyTopic
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 3);
  if (!topicWords.length) return true;

  const haystack = `${title || ""} ${text || ""}`.toLowerCase();
  const matches = topicWords.filter((word) => haystack.includes(word)).length;
  return matches >= Math.max(1, Math.ceil(topicWords.length * 0.3));
}

export function isYouTubeUrl(url) {
  return /(^https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\//i.test(url);
}

export function getYouTubeVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.replace("/", "") || null;
    }
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

export function getYouTubeSearchQuery(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("search_query");
  } catch {
    return null;
  }
}

export function trimText(value, max = 120000) {
  if (!value) return "";
  return value.length > max ? value.slice(0, max) : value;
}

export function cleanText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

export function nowTs() {
  return Date.now();
}

export function simpleHash(input) {
  const text = String(input || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return String(hash >>> 0);
}
