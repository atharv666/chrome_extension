# Focus Flow AI Setup

## 1) Install dependencies

```bash
npm install
```

## 2) Configure Gemini key

```bash
cp server/.env.example server/.env
```

Open `server/.env` and set:

```env
GEMINI_API_KEY=YOUR_REAL_KEY
GEMINI_MODEL=gemini-1.5-pro
HOST=127.0.0.1
PORT=3000
```

## 3) Build extension

```bash
npm run build
```

## 4) Start AI backend

```bash
npm run server:start
```

## 5) Load extension in Chrome

- Go to `chrome://extensions`
- Enable **Developer mode**
- Click **Load unpacked**
- Select this project folder

## 6) Verify

- Health check: `http://127.0.0.1:3000/health`
- Start a focus session from popup
- Browse off-topic sites to trigger AI intervention

## Endpoints

- `POST /api/parse` - receives parsed session events
- `POST /api/ai/analyze` - returns intervention decisions
- `GET /events` - recent event buffer
- `GET /health` - server health and model config
