import { PARSING_CONFIG } from "./config.js";
import { cleanText, compactUrl, parseDomain, trimText } from "./helpers.js";

function readMeta(name, attr = "name") {
  const el = document.querySelector(`meta[${attr}='${name}']`);
  return el ? cleanText(el.getAttribute("content")) : null;
}

function selectMainContainer() {
  return (
    document.querySelector("main") ||
    document.querySelector("article") ||
    document.querySelector("#content") ||
    document.body
  );
}

function collectHeadings(container) {
  const list = [];
  container.querySelectorAll("h1, h2, h3").forEach((node) => {
    const text = cleanText(node.textContent);
    if (text && text.length <= 220) list.push(text);
  });
  return list.slice(0, PARSING_CONFIG.MAX_HEADINGS);
}

function isUsefulImage(img, rect) {
  if (!img.src || img.src.startsWith("data:")) return false;
  if (rect.width < 80 || rect.height < 80) return false;
  const src = img.src.toLowerCase();
  if (
    src.includes("favicon") ||
    src.includes("sprite") ||
    src.includes("logo") ||
    src.includes("gstatic.com/images/icons")
  ) {
    return false;
  }
  return true;
}

function collectImages(container) {
  const images = [];
  container.querySelectorAll("img").forEach((img) => {
    const rect = img.getBoundingClientRect();
    if (!isUsefulImage(img, rect)) return;
    images.push({
      src: compactUrl(img.src),
      alt: cleanText(img.alt) || null,
      width: Math.round(rect.width || 0),
      height: Math.round(rect.height || 0),
      visible:
        rect.bottom >= 0 &&
        rect.right >= 0 &&
        rect.top <= window.innerHeight &&
        rect.left <= window.innerWidth,
    });
  });
  return images.slice(0, PARSING_CONFIG.MAX_IMAGES);
}

function collectPdfRefs(container) {
  const refs = new Set();
  if (/\.pdf([?#].*)?$/i.test(window.location.href)) {
    refs.add(compactUrl(window.location.href));
  }
  container.querySelectorAll("a[href], iframe[src], embed[src]").forEach((el) => {
    const candidate = el.href || el.src;
    if (candidate && /\.pdf([?#].*)?$/i.test(candidate)) refs.add(compactUrl(candidate));
  });
  return Array.from(refs).slice(0, PARSING_CONFIG.MAX_PDFS);
}

function collectDomFeatures(container) {
  return {
    image_count: container.querySelectorAll("img").length,
    video_count: container.querySelectorAll("video").length,
    iframe_count: container.querySelectorAll("iframe").length,
    input_fields: container.querySelectorAll("input, textarea").length,
  };
}

export function parseGoogleSearchContent() {
  const url = window.location.href;
  const domain = parseDomain(url);
  const urlObj = new URL(url);
  const query = cleanText(urlObj.searchParams.get("q") || "");

  const results = [];
  document.querySelectorAll("#search div.g").forEach((card) => {
    if (results.length >= PARSING_CONFIG.GOOGLE_MAX_RESULTS) return;
    const link = card.querySelector("a[href]");
    const title = card.querySelector("h3");
    const snippet = card.querySelector(".VwiC3b, .yXK7lf, .st");
    if (!link || !title) return;
    results.push({
      title: cleanText(title.textContent),
      link: compactUrl(link.href),
      snippet: cleanText(snippet?.textContent || "") || null,
    });
  });

  return {
    page: {
      url: compactUrl(url),
      domain,
      page_title: cleanText(document.title),
    },
    metadata: {
      description: null,
      keywords: [],
      og_title: null,
      og_description: null,
      author: null,
    },
    content: {
      top_headings: query ? [`Search: ${query}`] : [],
      visible_text_summary: query,
      word_count: query ? query.split(/\s+/).length : 0,
      search_results: results,
    },
    media: {
      images: [],
      pdf_refs: [],
    },
    dom_features: {
      image_count: 0,
      video_count: 0,
      iframe_count: 0,
      input_fields: document.querySelectorAll("input, textarea").length,
    },
  };
}

export function parsePageLite() {
  const url = compactUrl(window.location.href);
  return {
    page: {
      url,
      domain: parseDomain(url),
      page_title: cleanText(document.title),
    },
    metadata: {
      description: readMeta("description"),
      keywords: (readMeta("keywords") || "")
        .split(",")
        .map((k) => cleanText(k))
        .filter(Boolean)
        .slice(0, PARSING_CONFIG.MAX_KEYWORDS),
      og_title: readMeta("og:title", "property"),
      og_description: readMeta("og:description", "property"),
      author: readMeta("author"),
    },
  };
}

export function parseGeneralPageContent() {
  const url = compactUrl(window.location.href);
  const domain = parseDomain(url);

  if (domain === "google.com" && new URL(window.location.href).pathname === "/search") {
    return parseGoogleSearchContent();
  }

  const container = selectMainContainer();
  const bodyText = trimText(
    cleanText(container?.innerText || container?.textContent || ""),
    PARSING_CONFIG.MAX_TEXT_CHARS
  );
  const topHeadings = collectHeadings(container);

  return {
    page: {
      url,
      domain,
      page_title: cleanText(document.title),
    },
    metadata: {
      description: readMeta("description"),
      keywords: (readMeta("keywords") || "")
        .split(",")
        .map((k) => cleanText(k))
        .filter(Boolean)
        .slice(0, PARSING_CONFIG.MAX_KEYWORDS),
      og_title: readMeta("og:title", "property"),
      og_description: readMeta("og:description", "property"),
      author: readMeta("author"),
    },
    content: {
      top_headings: topHeadings,
      visible_text_summary: bodyText,
      word_count: bodyText ? bodyText.split(/\s+/).length : 0,
    },
    media: {
      images: collectImages(container),
      pdf_refs: collectPdfRefs(container),
    },
    dom_features: collectDomFeatures(container),
  };
}
