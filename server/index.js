const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { GoogleGenerativeAI } = require("@google/generative-ai");

dotenv.config({ path: path.join(process.cwd(), "server", ".env") });

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const MODEL = process.env.GEMINI_MODEL || "gemini-1.5-pro";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";

const LOG_DIR = path.join(process.cwd(), "logs");
const JSONL_FILE = path.join(LOG_DIR, "parse-events.jsonl");
const MAX_RECENT_EVENTS = 200;
const MAX_CONTEXT_EVENTS = 15;

const recentEvents = [];
const interventionState = new Map();

fs.mkdirSync(LOG_DIR, { recursive: true });

function appendEvent(event) {
  fs.appendFileSync(JSONL_FILE, `${JSON.stringify(event)}\n`, "utf8");
  recentEvents.unshift(event);
  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.pop();
  }
}

function parseJsonSafely(raw) {
  try {
    return { data: JSON.parse(raw), parseError: null };
  } catch (error) {
    return { data: { raw_body: raw }, parseError: error.message };
  }
}

function summarizeForModel(payload) {
  const events = Array.isArray(payload.events) ? payload.events : [];
  const latest = events[events.length - 1] || {};

  return {
    trigger_type: payload.trigger_type || null,
    requested_intervention: payload.requested_intervention || null,
    study_topic: payload.study_topic || "",
    session_duration: payload.session_duration || 0,
    tab_switches: payload.tab_switches || 0,
    active_tab_time_seconds: payload.active_tab_time_seconds || 0,
    domain: latest.domain || payload.domain || null,
    category: latest.category || payload.category || "unknown",
    page_title: latest.page_title || payload.page_title || "",
    is_allowed: Boolean(latest.is_allowed),
    is_relevant_to_topic:
      latest.is_relevant_to_topic === undefined ? null : Boolean(latest.is_relevant_to_topic),
    inactivity_seconds: latest.inactivity_seconds || 0,
    mouse_score: latest.mouse_score || 0,
    scroll_speed_px_per_sec: latest.scroll_speed_px_per_sec || 0,
    clicks_per_minute: latest.clicks_per_minute || 0,
    content: {
      headings: latest.content?.headings || [],
      summary: latest.content?.summary || "",
      word_count: latest.content?.word_count || 0,
      metadata: latest.metadata || {},
      youtube: latest.youtube || null,
    },
  };
}

function sessionKey(payload) {
  const topic = payload.study_topic || "untitled";
  return `${topic}::${payload.active_tab_id || "na"}`;
}

function getRecentContext(payload) {
  const key = sessionKey(payload);
  const bucket = interventionState.get(key) || { events: [], lastInterventionAt: 0 };
  return bucket;
}

function saveRecentContext(payload) {
  const key = sessionKey(payload);
  const bucket = interventionState.get(key) || { events: [], lastInterventionAt: 0 };
  bucket.events.push(summarizeForModel(payload));
  if (bucket.events.length > MAX_CONTEXT_EVENTS) {
    bucket.events.splice(0, bucket.events.length - MAX_CONTEXT_EVENTS);
  }
  interventionState.set(key, bucket);
}

function markIntervention(payload) {
  const key = sessionKey(payload);
  const bucket = interventionState.get(key) || { events: [], lastInterventionAt: 0 };
  bucket.lastInterventionAt = Date.now();
  interventionState.set(key, bucket);
}

function sanitizeDecision(raw) {
  const statusSet = new Set(["focused", "mild_distraction", "distracted", "severe_distraction"]);
  const interventionSet = new Set(["none", "flashcard", "mascot_chat"]);

  const status = statusSet.has(raw.status) ? raw.status : "focused";
  const confidence = Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0.5;
  const intervention = interventionSet.has(raw.intervention) ? raw.intervention : "none";

  return {
    status,
    confidence,
    intervention,
    cooldown_seconds: Number.isFinite(raw.cooldown_seconds)
      ? Math.max(10, Math.min(180, Math.round(raw.cooldown_seconds)))
      : 15,
    reason_codes: Array.isArray(raw.reason_codes)
      ? raw.reason_codes.slice(0, 5).map((x) => String(x).slice(0, 60))
      : [],
    flashcard: raw.flashcard && typeof raw.flashcard === "object"
      ? {
          question: String(raw.flashcard.question || "").slice(0, 260),
          options: Array.isArray(raw.flashcard.options)
            ? raw.flashcard.options.slice(0, 4).map((x) => String(x).slice(0, 120))
            : [],
          answer: String(raw.flashcard.answer || "").slice(0, 120),
          hint: String(raw.flashcard.hint || "").slice(0, 180),
          explanation: String(raw.flashcard.explanation || "").slice(0, 320),
        }
      : null,
    mascot_script: Array.isArray(raw.mascot_script)
      ? raw.mascot_script
          .slice(0, 8)
          .map((line, idx) => ({
            speaker: idx % 2 === 0 ? "devil" : "angel",
            text: String(line?.text || "").slice(0, 220),
          }))
      : null,
    generation_failed: Boolean(raw.generation_failed),
  };
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "about", "your", "you",
  "are", "was", "were", "have", "has", "had", "will", "would", "could", "should", "can",
  "academy", "welcome", "home", "login", "parent", "teacher", "learner",
]);

const TOPIC_SYNONYMS = {
  coding: [
    "program",
    "programming",
    "code",
    "coding",
    "algorithm",
    "function",
    "loop",
    "array",
    "linked",
    "tree",
    "stack",
    "queue",
    "complexity",
    "javascript",
    "react",
    "hooks",
    "state",
    "component",
    "useeffect",
    "usestate",
  ],
  physics: ["force", "motion", "energy", "velocity", "acceleration", "torque", "momentum", "newton"],
  chemistry: ["atom", "molecule", "reaction", "oxidation", "reduction", "acid", "base", "bond"],
  biology: ["cell", "gene", "enzyme", "organism", "dna", "protein", "evolution"],
  math: ["algebra", "calculus", "equation", "derivative", "integral", "geometry", "probability"],
  history: ["empire", "war", "revolution", "timeline", "civilization", "treaty"],
  economics: ["demand", "supply", "inflation", "gdp", "market", "elasticity"],
};

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function inferTopicFamily(studyTopic) {
  const tokens = tokenize(studyTopic);
  if (!tokens.length) return "general";

  let bestFamily = "general";
  let bestScore = 0;

  for (const [family, synonyms] of Object.entries(TOPIC_SYNONYMS)) {
    const lexicon = new Set([family, ...synonyms]);
    const score = tokens.filter((t) => lexicon.has(t)).length;
    if (score > bestScore) {
      bestScore = score;
      bestFamily = family;
    }
  }

  if (bestScore > 0) return bestFamily;
  return "general";
}

function topicTerms(studyTopic, topicFamily) {
  const base = tokenize(studyTopic).slice(0, 8);
  const familySynonyms = TOPIC_SYNONYMS[topicFamily] || [];
  return [...new Set([...base, ...familySynonyms])];
}

function computeTopicRelevance(modelInput) {
  const topicFamily = inferTopicFamily(modelInput.study_topic);
  const terms = topicTerms(modelInput.study_topic, topicFamily);
  const sourceText = [
    modelInput.page_title || "",
    ...(Array.isArray(modelInput.content?.headings) ? modelInput.content.headings : []),
    modelInput.content?.summary || "",
  ].join(" ");

  const sourceTokens = new Set(tokenize(sourceText));
  const matched = terms.filter((t) => sourceTokens.has(t));
  const score = terms.length ? Math.min(1, matched.length / Math.max(4, terms.length)) : 0;
  const contextQuality = score >= 0.35 ? "good" : score >= 0.15 ? "weak" : "none";
  return {
    topic_family: topicFamily,
    topic_terms: terms,
    matched_terms: matched,
    relevance_score: Number(score.toFixed(2)),
    context_quality: contextQuality,
  };
}

function buildSmartFlashcardFromPayload(payload) {
  const latest = summarizeForModel(payload);
  const topic = latest.study_topic || "your study topic";
  return {
    question: `Which option best explains a beginner concept in ${topic}?`,
    options: [
      `A foundational definition that correctly describes a core ${topic} idea.`,
      "A platform/homepage description unrelated to the concept.",
      "A motivational quote with no technical meaning.",
      "An advanced edge case with no beginner context.",
    ],
    answer: `A foundational definition that correctly describes a core ${topic} idea.`,
    hint: `Focus on core basics of ${topic}, not website/platform details.`,
    explanation: "Beginner flashcards should test a concrete concept definition or usage, not page branding or navigation text.",
  };
}

function isLowQualityFlashcard(card, studyTopic, profile) {
  if (!card || !card.question) return true;
  if (!Array.isArray(card.options) || card.options.length !== 4) return true;

  const q = String(card.question || "").trim();
  const options = card.options.map((x) => String(x || "").trim()).filter(Boolean);
  const answer = String(card.answer || "").trim();

  if (!q || q.length < 16) return true;
  if (options.length !== 4) return true;
  if (!answer) return true;

  const uniqueOptions = new Set(options.map((o) => o.toLowerCase()));
  if (uniqueOptions.size < 4) return true;
  const answerLower = answer.toLowerCase();
  const hasAnswerMatch = options.some((o) => {
    const opt = o.toLowerCase();
    return opt === answerLower || opt.includes(answerLower) || answerLower.includes(opt);
  });
  if (!hasAnswerMatch) return true;

  const blob = `${q} ${options.join(" ")} ${card.hint || ""} ${card.explanation || ""}`.toLowerCase();
  const banned = [
    "welcome to",
    "this page",
    "homepage",
    "platform description",
    "click here",
    "which option best explains a beginner concept in",
  ];
  if (banned.some((p) => blob.includes(p))) return true;

  const terms = topicTerms(studyTopic, profile.topic_family);
  const topicWords = tokenize(studyTopic).filter((w) => w.length >= 4);
  const hasTopicWord = topicWords.some((w) => blob.includes(w));
  const hasFamilySignal = terms.some((t) => t.length >= 4 && blob.includes(t));
  if (!hasTopicWord && !hasFamilySignal) return true;

  return false;
}

function normalizeFlashcardAnswer(card) {
  const normalized = {
    question: String(card?.question || ""),
    options: Array.isArray(card?.options) ? card.options.map((x) => String(x || "")) : [],
    answer: String(card?.answer || ""),
    hint: String(card?.hint || ""),
    explanation: String(card?.explanation || ""),
  };

  const raw = normalized.answer.trim();
  const m = raw.match(/^([A-D])(?:[\).:\-\s]|$)/i);
  if (m && normalized.options.length >= 4) {
    const idx = m[1].toUpperCase().charCodeAt(0) - 65;
    if (idx >= 0 && idx < normalized.options.length) {
      normalized.answer = normalized.options[idx];
    }
  }

  return normalized;
}

async function runGeminiJsonPrompt(prompt) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: MODEL });
  const result = await model.generateContent(prompt);
  const text = result.response.text().trim();
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```/i, "")
    .replace(/```$/, "")
    .trim();
}

async function runGroqJsonPrompt(prompt) {
  if (!GROQ_API_KEY) {
    throw new Error("groq_missing_api_key");
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Return only valid JSON. No markdown fences. No extra prose.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`groq_http_${response.status}:${errBody.slice(0, 300)}`);
  }

  const data = await response.json();
  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```/i, "")
    .replace(/```$/, "")
    .trim();
}

async function runLlmJsonPrompt(prompt, preferredProvider = "gemini") {
  const errors = [];

  const providers = preferredProvider === "groq" ? ["groq", "gemini"] : ["gemini", "groq"];

  for (const provider of providers) {
    if (provider === "gemini" && GEMINI_API_KEY) {
      try {
        return await runGeminiJsonPrompt(prompt);
      } catch (err) {
        errors.push(`gemini:${err?.message || "unknown"}`);
      }
    }

    if (provider === "groq" && GROQ_API_KEY) {
      try {
        return await runGroqJsonPrompt(prompt);
      } catch (err) {
        errors.push(`groq:${err?.message || "unknown"}`);
      }
    }
  }

  throw new Error(errors.length ? errors.join(" | ") : "no_llm_provider_configured");
}

async function generateFlashcardWithGemini(payload, profile, mode = "context_aligned") {
  if (!GEMINI_API_KEY && !GROQ_API_KEY) {
    return { card: null, generation_mode: "llm_unavailable", quality_reject_reason: "missing_api_key" };
  }

  const latest = summarizeForModel(payload);
  const context = {
    study_topic: latest.study_topic,
    difficulty: "beginner",
    topic_family: profile.topic_family,
    matched_terms: profile.matched_terms,
    page_title: latest.page_title,
    headings: (latest.content?.headings || []).slice(0, 5),
    summary: String(latest.content?.summary || "").slice(0, 1200),
    domain: latest.domain,
    mode,
  };

  const prompt = `Generate one beginner-level MCQ flashcard as strict JSON:
{
  "question":"...",
  "options":["...","...","...","..."],
  "answer":"...",
  "hint":"...",
  "explanation":"..."
}

Rules:
- The question must be subject-specific to study_topic.
- If mode=context_aligned, use headings/summary concepts when relevant.
- If mode=topic_only, ignore generic page text and ask a valid topic question.
- Never mention platform/homepage text (e.g., welcome pages).
- Options must be plausible and only one correct.
- Explanation should be 2 concise beginner-friendly sentences.
- Do NOT use generic template phrasing like "Which option best explains a beginner concept in ...".
- Ask one concrete concept check from the topic (definition, mechanism, comparison, formula use, or interpretation).

Context:
${JSON.stringify(context, null, 2)}
`;

  try {
    const raw = await runLlmJsonPrompt(prompt, "groq");
    const parsed = JSON.parse(raw);
    const card = normalizeFlashcardAnswer({
      question: String(parsed.question || "").slice(0, 260),
      options: Array.isArray(parsed.options) ? parsed.options.slice(0, 4).map((x) => String(x).slice(0, 140)) : [],
      answer: String(parsed.answer || "").slice(0, 180),
      hint: String(parsed.hint || "").slice(0, 220),
      explanation: String(parsed.explanation || "").slice(0, 360),
    });
    if (isLowQualityFlashcard(card, latest.study_topic, profile)) {
      return { card, generation_mode: mode, quality_reject_reason: "generic_flashcard_relaxed_accept" };
    }
    return { card, generation_mode: mode };
  } catch {
    return { card: null, generation_mode: mode, quality_reject_reason: "generation_error" };
  }
}

async function generateFlashcardWithRetries(payload, profile) {
  const modes = [profile.context_quality === "good" ? "context_aligned" : "topic_only", "topic_only"];
  let last = { card: null, generation_mode: "none", quality_reject_reason: "not_attempted" };
  for (const mode of modes) {
    last = await generateFlashcardWithGemini(payload, profile, mode);
    if (last.card) return { ...last, attempts: modes.indexOf(mode) + 1 };
  }

  try {
    const latest = summarizeForModel(payload);
    const rescuePrompt = `Return strict JSON only for one beginner MCQ on this study topic.
{
  "question":"...",
  "options":["...","...","...","..."],
  "answer":"...",
  "hint":"...",
  "explanation":"..."
}

Topic: ${latest.study_topic || "general studies"}
Domain context: ${latest.domain || "unknown"}

Rules:
- Exactly 4 options.
- Exactly one correct option.
- Keep it specific to the study topic, not platform text.
- Beginner-friendly and concise.
`;
    const raw = await runLlmJsonPrompt(rescuePrompt, "groq");
    const parsed = JSON.parse(raw);
    const card = normalizeFlashcardAnswer({
      question: String(parsed.question || "").slice(0, 260),
      options: Array.isArray(parsed.options) ? parsed.options.slice(0, 4).map((x) => String(x).slice(0, 140)) : [],
      answer: String(parsed.answer || "").slice(0, 180),
      hint: String(parsed.hint || "").slice(0, 220),
      explanation: String(parsed.explanation || "").slice(0, 360),
    });
    if (!isLowQualityFlashcard(card, latest.study_topic, profile)) {
      return {
        card,
        generation_mode: "topic_only_rescue",
        quality_reject_reason: null,
        attempts: 3,
      };
    }
    return {
      card,
      generation_mode: "topic_only_rescue",
      quality_reject_reason: "generic_flashcard_relaxed_accept",
      attempts: 3,
    };
  } catch {
    // Keep Gemini-only behavior; caller handles null generation.
  }

  return { ...last, attempts: 3 };
}

function looksGenericMascotScript(script, studyTopic, domain, profile) {
  if (!Array.isArray(script) || script.length < 4) return true;
  const blob = script.map((x) => x?.text || "").join(" ").toLowerCase();
  const genericSignals = ["come back", "stay focused", "one more minute", "back to work", "stay here"];
  const genericCount = genericSignals.filter((s) => blob.includes(s)).length;
  const terms = topicTerms(studyTopic, profile.topic_family);
  const hasTopic = terms.length ? terms.some((t) => blob.includes(t)) : false;
  const hasDomain = domain ? blob.includes(String(domain).toLowerCase()) : false;
  return genericCount >= 2 || (!hasTopic && !hasDomain);
}

async function generateMascotScriptWithGemini(payload, profile) {
  if (!GEMINI_API_KEY && !GROQ_API_KEY) return null;
  const latest = summarizeForModel(payload);

  const topicHint = profile.matched_terms.length
    ? `Focus on these matched terms: ${profile.matched_terms.join(", ")}.`
    : "No strong page-topic match found. Keep advice topic-specific and redirect to a relevant learning action.";

  const prompt = `Write a 4-turn angel/devil script for a distraction intervention.
Return strict JSON only:
{
  "mascot_script": [
    {"speaker":"devil","text":"..."},
    {"speaker":"angel","text":"..."},
    {"speaker":"devil","text":"..."},
    {"speaker":"angel","text":"..."}
  ]
Rules:
- Turn order must be devil, angel, devil, angel.
- Every line must explicitly mention the study topic (or a direct topic term), and may also reference domain/page context.
- Avoid generic motivational lines. Make the lines specific.
- Devil lines must tempt distraction, justify procrastination, or induce short-term guilt/avoidance.
- Devil must NOT praise studying or suggest productive actions.
- Angel should suggest a concrete action tied to the topic (not generic "go study").
- Use beginner-friendly tone and mention topic terms when possible.
- Keep each line 1-2 sentences, concrete and pointed.
- Devil should tempt using current distracting context; angel should counter with a concrete topic action.
- Keep each line unique. Do not repeat phrases.

Context:
${JSON.stringify(
    {
      study_topic: latest.study_topic,
      topic_family: profile.topic_family,
      matched_terms: profile.matched_terms,
      domain: latest.domain,
      page_title: latest.page_title,
      headings: (latest.content?.headings || []).slice(0, 3),
      summary: String(latest.content?.summary || "").slice(0, 700),
    },
    null,
    2
  )}

${topicHint}
`;

  try {
    const extracted = await runLlmJsonPrompt(prompt, "groq");
    const parsed = JSON.parse(extracted);
    const script = Array.isArray(parsed.mascot_script)
      ? parsed.mascot_script.slice(0, 4).map((x, i) => ({
          speaker: i % 2 === 0 ? "devil" : "angel",
          text: String(x?.text || "").slice(0, 240),
        }))
      : null;
    return script;
  } catch {
    return null;
  }
}

async function generateMascotScriptWithRetries(payload, profile, domain) {
  const studyTopic = summarizeForModel(payload).study_topic;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const script = await generateMascotScriptWithGemini(payload, profile);
    if (hasUsableMascotScript(script)) {
      return {
        script: script.slice(0, 4).map((line, i) => ({
          speaker: i % 2 === 0 ? "devil" : "angel",
          text: String(line?.text || "").slice(0, 240),
        })),
        attempts: attempt,
        quality_reject_reason: validateMascotScriptStrict(script, profile, domain, studyTopic)
          ? null
          : "mascot_script_relaxed_accept",
      };
    }
    if (validateMascotScriptStrict(script, profile, domain, studyTopic)) {
      return { script, attempts: attempt, quality_reject_reason: null };
    }
  }

  try {
    const latest = summarizeForModel(payload);
    const rescuePrompt = `Return strict JSON only.
{
  "mascot_script": [
    {"speaker":"devil","text":"..."},
    {"speaker":"angel","text":"..."},
    {"speaker":"devil","text":"..."},
    {"speaker":"angel","text":"..."}
  ]
}

Topic: ${latest.study_topic || "current study topic"}
Current domain: ${latest.domain || "current site"}
Page title: ${latest.page_title || ""}

Rules:
- 4 lines exactly.
- speaker order: devil, angel, devil, angel.
- Mention topic or domain context in every line.
- Be specific and concrete.
`;
    const raw = await runLlmJsonPrompt(rescuePrompt, "groq");
    const parsed = JSON.parse(raw);
    const script = Array.isArray(parsed.mascot_script)
      ? parsed.mascot_script.slice(0, 4).map((x, i) => ({
          speaker: i % 2 === 0 ? "devil" : "angel",
          text: String(x?.text || "").slice(0, 240),
        }))
      : null;
    if (hasUsableMascotScript(script)) {
      return {
        script,
        attempts: 3,
        quality_reject_reason: validateMascotScriptStrict(script, profile, domain, studyTopic)
          ? null
          : "mascot_script_relaxed_accept",
      };
    }
    if (validateMascotScriptStrict(script, profile, domain, studyTopic)) {
      return { script, attempts: 3, quality_reject_reason: null };
    }
  } catch {
    // Keep Gemini-only behavior; caller handles null generation.
  }

  return { script: null, attempts: 3, quality_reject_reason: "mascot_script_validation_failed" };
}

function hasTopicContextInLine(text, profile, domain) {
  const lower = String(text || "").toLowerCase();
  if (!lower) return false;
  if (domain && lower.includes(String(domain).toLowerCase())) return true;
  const terms = [...profile.topic_terms, ...profile.matched_terms];
  return terms.some((t) => t.length >= 4 && lower.includes(t));
}

function hasExplicitStudyTopicMention(text, studyTopic) {
  const lower = String(text || "").toLowerCase();
  const topicWords = tokenize(studyTopic).filter((w) => w.length >= 4);
  if (!topicWords.length) return false;
  return topicWords.some((w) => lower.includes(w));
}

function isDevilLineWeak(text) {
  const lower = String(text || "").toLowerCase();
  const lureSignals = [
    "just one more",
    "take a break",
    "later",
    "scroll",
    "reel",
    "feed",
    "ignore",
    "skip",
    "procrast",
    "you deserve",
    "not now",
    "waste",
    "avoid",
  ];
  const positiveStudySignals = [
    "great job",
    "keep studying",
    "you are doing great",
    "focus now",
    "good work",
    "you got this",
    "well done",
  ];
  const hasLure = lureSignals.some((s) => lower.includes(s));
  const hasPositiveStudy = positiveStudySignals.some((s) => lower.includes(s));
  return hasPositiveStudy && !hasLure;
}

function hasUsableFlashcard(card) {
  if (!card || typeof card !== "object") return false;
  const question = String(card.question || "").trim();
  const options = Array.isArray(card.options) ? card.options.filter((x) => String(x || "").trim()) : [];
  return question.length >= 10 && options.length >= 2;
}

function hasUsableMascotScript(script) {
  if (!Array.isArray(script) || script.length < 4) return false;
  const lines = script.slice(0, 4).map((x) => String(x?.text || "").trim());
  return lines.every((text) => text.length >= 8);
}

function validateMascotScriptStrict(script, profile, domain, studyTopic) {
  if (!Array.isArray(script) || script.length < 4) return false;

  const order = ["devil", "angel", "devil", "angel"];
  const normalized = script.slice(0, 4).map((line, i) => ({
    speaker: order[i],
    text: String(line?.text || "").trim(),
  }));

  if (!normalized.every((line) => line.text.length >= 8)) return false;

  let weakDevilCount = 0;
  for (let i = 0; i < 4; i += 1) {
    const line = normalized[i];
    if (!line || line.speaker !== order[i]) return false;
    if (line.speaker === "devil" && isDevilLineWeak(line.text)) weakDevilCount += 1;
  }
  if (weakDevilCount >= 2) return false;

  const hasAnyTopicContext = normalized.some(
    (line) => hasTopicContextInLine(line.text, profile, domain) || hasExplicitStudyTopicMention(line.text, studyTopic)
  );
  if (!hasAnyTopicContext) return false;

  if (looksGenericMascotScript(normalized, studyTopic, domain, profile)) {
    const hasTopicMention = normalized.some((line) => hasExplicitStudyTopicMention(line.text, studyTopic));
    if (!hasTopicMention) return false;
  }

  const blob = normalized.map((x) => x.text.toLowerCase()).join(" ");
  if (["stay focused", "one more minute", "come back"].filter((p) => blob.includes(p)).length >= 3) {
    return false;
  }

  return true;
}

function fallbackDecision(payload) {
  const latest = summarizeForModel(payload);
  const isDistractedHeuristic =
    latest.inactivity_seconds > 40 ||
    latest.is_relevant_to_topic === false ||
    (latest.is_allowed === false && latest.mouse_score < 0.25);

  if (!isDistractedHeuristic) {
    return {
      status: "focused",
      confidence: 0.62,
      intervention: "none",
      cooldown_seconds: 90,
      reason_codes: ["fallback_focused", "ai_provider_unavailable"],
      flashcard: null,
      mascot_script: null,
      generation_failed: true,
    };
  }

  return {
    status: "distracted",
    confidence: 0.66,
    intervention: "none",
    cooldown_seconds: 90,
    reason_codes: ["fallback_distraction_detected", "ai_provider_unavailable"],
    flashcard: null,
    mascot_script: null,
    generation_failed: true,
  };
}

async function callGeminiAnalyze(payload, contextBucket) {
  if (!GEMINI_API_KEY && !GROQ_API_KEY) {
    return fallbackDecision(payload);
  }

  const latest = summarizeForModel(payload);
  const recentContext = contextBucket.events || [];

  const prompt = `You are a focus coach AI for a browser extension.
Assess if user is distracted from study topic and return strict JSON only.

Rules:
- Balanced intervention policy.
- Honor requested_intervention when sensible.
- If trigger_type is idle_allowed_site, prefer flashcard intervention.
- If trigger_type is offtopic_site, prefer mascot_chat intervention.
- If mild uncertainty, avoid intervention.
- If clearly distracted: prefer flashcard.
- If severe distraction pattern (repeated off-topic, low relevance, high tab switching): mascot_chat.
- flashcard must be beginner-level and topic-specific. Avoid platform/homepage text.
- mascot_script should be 4-6 short turns, alternating angel/devil, with topic/context references.

Output JSON schema:
{
  "status": "focused|mild_distraction|distracted|severe_distraction",
  "confidence": 0.0,
  "intervention": "none|flashcard|mascot_chat",
  "cooldown_seconds": 90,
  "reason_codes": ["..."],
  "flashcard": {
    "question": "...",
    "options": ["..."],
    "answer": "...",
    "hint": "..."
  },
  "mascot_script": [
    {"speaker":"angel","text":"..."},
    {"speaker":"devil","text":"..."}
  ]
}

Current event summary:
${JSON.stringify(latest, null, 2)}

Recent context window:
${JSON.stringify(recentContext, null, 2)}
`;

  const extracted = await runLlmJsonPrompt(prompt);

  const parsed = JSON.parse(extracted);
  return sanitizeDecision(parsed);
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "focus-flow-ai-backend",
    model: MODEL,
    hasGeminiKey: Boolean(GEMINI_API_KEY),
    hasGroqKey: Boolean(GROQ_API_KEY),
    groqModel: GROQ_MODEL,
    logFile: JSONL_FILE,
  });
});

app.get("/events", (_req, res) => {
  res.json({ ok: true, count: recentEvents.length, events: recentEvents.slice(0, 50) });
});

app.post("/api/parse", (req, res) => {
  const payload = req.body || {};
  const event = {
    received_at: new Date().toISOString(),
    payload,
  };
  appendEvent(event);
  saveRecentContext(payload);

  res.json({ ok: true, message: "Payload received", received_at: event.received_at });
});

app.post("/api/ai/analyze", async (req, res) => {
  const payload = req.body || {};
  const contextBucket = getRecentContext(payload);
  const modelInput = summarizeForModel(payload);
  const profile = computeTopicRelevance(modelInput);
  let generationMeta = {
    generation_mode: "none",
    relevance_score: profile.relevance_score,
    matched_terms: profile.matched_terms,
    topic_family: profile.topic_family,
    difficulty_level: "beginner",
    quality_reject_reason: null,
  };

  try {
    let decision = await callGeminiAnalyze(payload, contextBucket);

    if (
      payload.requested_intervention === "flashcard" &&
      ["idle_allowed_site", "idle_allowed_site_retry"].includes(payload.trigger_type)
    ) {
      decision = {
        ...decision,
        intervention: "flashcard",
        status: decision.status === "focused" ? "mild_distraction" : decision.status,
        confidence: Math.max(decision.confidence || 0, 0.72),
        cooldown_seconds: 15,
      };
    }

    if (
      payload.requested_intervention === "mascot_chat" &&
      ["offtopic_site", "offtopic_site_retry"].includes(payload.trigger_type)
    ) {
      decision = {
        ...decision,
        intervention: "mascot_chat",
        status: decision.status === "focused" ? "distracted" : decision.status,
        confidence: Math.max(decision.confidence || 0, 0.75),
        cooldown_seconds: 15,
      };
    }

    if (decision.intervention === "flashcard") {
      const generated = await generateFlashcardWithRetries(payload, profile);
      generationMeta = {
        ...generationMeta,
        generation_mode: generated.generation_mode,
        quality_reject_reason: generated.quality_reject_reason || null,
        generation_attempts: generated.attempts,
      };
      if (generated.card) {
        decision = {
          ...decision,
          flashcard: generated.card,
          generation_failed: false,
        };
      } else if (hasUsableFlashcard(decision.flashcard)) {
        decision = {
          ...decision,
          generation_failed: false,
        };
      } else {
        decision = {
          ...decision,
          generation_failed: true,
          flashcard: null,
        };
      }
    }

    if (decision.intervention === "mascot_chat") {
      const domain = modelInput.domain;
      const generated = await generateMascotScriptWithRetries(payload, profile, domain);
      generationMeta = {
        ...generationMeta,
        generation_attempts: generated.attempts,
        quality_reject_reason: generated.quality_reject_reason || generationMeta.quality_reject_reason,
      };
      if (generated.script) {
        decision = {
          ...decision,
          mascot_script: generated.script,
          generation_failed: false,
        };
      } else if (hasUsableMascotScript(decision.mascot_script)) {
        decision = {
          ...decision,
          generation_failed: false,
        };
      } else {
        decision = {
          ...decision,
          generation_failed: true,
          mascot_script: null,
        };
      }
    }

    const now = Date.now();
    const sinceLast = now - (contextBucket.lastInterventionAt || 0);
    const cooldownMs = (decision.cooldown_seconds || 90) * 1000;
    const isIdleFlashcardTrigger =
      payload.trigger_type === "idle_allowed_site" || payload.trigger_type === "idle_allowed_site_retry";

    if (decision.intervention !== "none" && !isIdleFlashcardTrigger && sinceLast < cooldownMs) {
      decision = {
        ...decision,
        intervention: "none",
        reason_codes: [...decision.reason_codes, "cooldown_active"],
      };
    }

    if (
      (!isIdleFlashcardTrigger && decision.intervention === "flashcard" && decision.confidence < 0.5) ||
      (decision.intervention === "mascot_chat" && decision.confidence < 0.6)
    ) {
      decision = {
        ...decision,
        intervention: "none",
        reason_codes: [...decision.reason_codes, "confidence_below_threshold"],
      };
    }

    if (decision.intervention !== "none") {
      markIntervention(payload);
    }

    saveRecentContext(payload);

    res.json({
      ok: true,
      timestamp: Date.now(),
      decision,
      debug: generationMeta,
    });
  } catch (error) {
    const fallback = fallbackDecision(payload);
    res.status(200).json({
      ok: true,
      timestamp: Date.now(),
      decision: fallback,
      warning: "ai_failed_fallback_used",
      error: error?.message || "unknown",
    });
  }
});

app.post("/api/raw", express.text({ type: "*/*" }), (req, res) => {
  const { data, parseError } = parseJsonSafely(req.body || "");
  const event = {
    received_at: new Date().toISOString(),
    parse_error: parseError,
    payload: data,
  };
  appendEvent(event);
  res.json({ ok: true });
});

app.listen(PORT, HOST, () => {
  console.log(`Focus Flow AI backend running at http://${HOST}:${PORT}`);
  console.log(`Health: http://${HOST}:${PORT}/health`);
  console.log(`Parse endpoint: http://${HOST}:${PORT}/api/parse`);
  console.log(`Analyze endpoint: http://${HOST}:${PORT}/api/ai/analyze`);
  console.log(`Logs: ${JSONL_FILE}`);
});
