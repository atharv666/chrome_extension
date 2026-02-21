import { cleanText } from "./helpers.js";

export function createIncrementalTracker() {
  const seen = new WeakSet();
  let observer = null;
  let mutationObserver = null;
  const buffer = {
    headings: [],
    paragraphs: [],
    images: [],
  };

  function addHeading(node) {
    const text = cleanText(node.textContent);
    if (text) buffer.headings.push(text);
  }

  function addParagraph(node) {
    const text = cleanText(node.textContent);
    if (text && text.length > 30) buffer.paragraphs.push(text);
  }

  function addImage(node) {
    if (!node.src || node.src.startsWith("data:")) return;
    buffer.images.push({
      src: node.src,
      alt: cleanText(node.alt) || null,
    });
  }

  function onSeen(node) {
    if (seen.has(node)) return;
    seen.add(node);

    const tag = node.tagName.toLowerCase();
    if (tag === "img") addImage(node);
    if (/^h[1-6]$/.test(tag)) addHeading(node);
    if (tag === "p") addParagraph(node);
  }

  function watchNode(node) {
    if (!(node instanceof Element)) return;
    if (node.matches("h1, h2, h3, h4, h5, h6, p, img")) {
      observer.observe(node);
    }
    node.querySelectorAll("h1, h2, h3, h4, h5, h6, p, img").forEach((n) => {
      observer.observe(n);
    });
  }

  function start() {
    observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) onSeen(entry.target);
        });
      },
      { threshold: 0.2 }
    );

    watchNode(document.body);

    mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => watchNode(node));
      });
    });

    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stop() {
    if (observer) observer.disconnect();
    if (mutationObserver) mutationObserver.disconnect();
  }

  function flush() {
    const data = {
      headings: buffer.headings.splice(0, buffer.headings.length),
      paragraphs: buffer.paragraphs.splice(0, buffer.paragraphs.length),
      images: buffer.images.splice(0, buffer.images.length),
    };
    return data;
  }

  return { start, stop, flush };
}
