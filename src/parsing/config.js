export const PARSING_CONFIG = {
  API_ENDPOINT: "http://localhost:3000/api/parse",
  BATCH_INTERVAL_MS: 15000,
  URL_POLL_INTERVAL_MS: 800,
  HOVER_DELAY_MS: 1500,
  MAX_TEXT_CHARS: 4000,
  MAX_HEADINGS: 10,
  MAX_IMAGES: 5,
  MAX_PDFS: 5,
  MAX_KEYWORDS: 8,
  GOOGLE_MAX_RESULTS: 5,
};

export const CATEGORY = {
  EDUCATION: "education",
  ENTERTAINMENT: "entertainment",
  SOCIAL: "social",
  PRODUCTIVITY: "productivity",
  UNKNOWN: "unknown",
};

export const EDUCATION_DOMAINS = [
  "wikipedia.org",
  "geeksforgeeks.org",
  "khanacademy.org",
  "coursera.org",
  "edx.org",
  "stackoverflow.com",
  "developer.mozilla.org",
  "docs.python.org",
  "leetcode.com",
  "hackerrank.com",
  "github.com",
  "arxiv.org",
  "scholar.google.com",
];

export const ENTERTAINMENT_DOMAINS = [
  "youtube.com",
  "netflix.com",
  "primevideo.com",
  "hotstar.com",
  "spotify.com",
  "twitch.tv",
  "reddit.com",
  "9gag.com",
];

export const SOCIAL_DOMAINS = [
  "instagram.com",
  "facebook.com",
  "twitter.com",
  "x.com",
  "snapchat.com",
  "tiktok.com",
  "discord.com",
];
