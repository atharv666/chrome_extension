const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const LOG_DIR = path.join(process.cwd(), "logs");
const JSONL_FILE = path.join(LOG_DIR, "parse-events.jsonl");
const MAX_IN_MEMORY_EVENTS = 50;

const recentEvents = [];

fs.mkdirSync(LOG_DIR, { recursive: true });

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data, null, 2));
}

function appendEvent(event) {
  fs.appendFileSync(JSONL_FILE, `${JSON.stringify(event)}\n`, "utf8");
  recentEvents.unshift(event);
  if (recentEvents.length > MAX_IN_MEMORY_EVENTS) {
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

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      listener: "focusflow-parse-listener",
      port: PORT,
      log_file: JSONL_FILE,
    });
    return;
  }

  if (req.method === "GET" && req.url === "/events") {
    sendJson(res, 200, {
      ok: true,
      count: recentEvents.length,
      events: recentEvents,
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/parse") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      const { data, parseError } = parseJsonSafely(body);

      const event = {
        received_at: new Date().toISOString(),
        method: req.method,
        path: req.url,
        user_agent: req.headers["user-agent"] || null,
        parse_error: parseError,
        payload: data,
      };

      appendEvent(event);

      console.log("\n=== Focus Flow Parse Event ===");
      console.log(JSON.stringify(event, null, 2));
      console.log("=== End Event ===\n");

      sendJson(res, 200, {
        ok: true,
        message: "Payload received",
        received_at: event.received_at,
      });
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`Focus Flow parse listener running at http://${HOST}:${PORT}`);
  console.log(`POST endpoint: http://${HOST}:${PORT}/api/parse`);
  console.log(`Recent events: http://${HOST}:${PORT}/events`);
  console.log(`Health check: http://${HOST}:${PORT}/health`);
  console.log(`Logging JSONL to: ${JSONL_FILE}`);
});
