# Focus Flow - Chrome Productivity Tracker

![Focus Flow Banner](docs/images/banner.png)

Track active tab time, detect distractions in real time, and guide users back to deep work using a local machine learning model trained on behavioral signals.

[![Build Status](https://img.shields.io/badge/build-stable-brightgreen)](#installation)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Version](https://img.shields.io/badge/version-1.0.0-orange.svg)](#)
[![Stars](https://img.shields.io/github/stars/atharv666/chrome_extension?style=social)](https://github.com/atharv666/chrome_extension)

## Demo

![Focus Flow Demo](docs/demo.gif)

### Screenshots

![Extension Popup](docs/images/popup-home.png)
![Active Session](docs/images/session-active.png)
![Intervention Overlay](docs/images/intervention-overlay.png)
![Flashcard Intervention](docs/images/intervention-flashcard.png)
![Analytics Dashboard](docs/images/analytics-dashboard.png)
![Session Summary](docs/images/session-summary.png)

### Product Video

- Walkthrough: [Watch the product demo](https://example.com/focus-flow-demo)

### GIF Recording Tools

- Linux -> Peek
- Windows -> ScreenToGif
- Mac -> Kap

## About

Focus Flow is a productivity-first Chrome extension for students, developers, and deep-work users who want measurable focus, not just a timer. It tracks browsing behavior, parses activity context, and runs a local ML decision engine to identify distraction patterns and trigger context-aware interventions.

### What problem it solves

- Standard timer apps cannot detect meaningful context switching.
- Website blockers are rigid and often fail when distraction is subtle.
- Users need visibility into focus quality, not only total study time.

### Why it exists

Focus breaks gradually: idle drift, rapid tab hopping, and off-topic browsing. Focus Flow was built to detect these behaviors early and push users back into the right task flow before momentum is lost.

### Who it is for

- Students preparing for exams
- Developers in long coding sessions
- Online learners and researchers
- Anyone optimizing daily productivity habits

## Core Features

- **Tab activity tracking** - measures active time per tab and switching frequency.
- **Idle detection** - catches inactivity and low-engagement browsing windows.
- **Distraction alerts** - flags off-topic behavior during active sessions.
- **ML-powered intervention engine** - local model scores focus vs distraction from parsed events.
- **Actionable nudges** - flashcards and conversation-style prompts to re-engage users.
- **Analytics dashboard** - session metrics, focus score, distraction trends, and history.
- **Cross-device session sync** - resume and monitor sessions consistently.

## How It Works

```text
Browser Activity -> Parse Layer -> Feature Signals -> Local ML Model -> Intervention Decision -> User Feedback Loop
```

1. Focus Flow collects session-safe browsing events (tab changes, page context, idle windows).
2. The parser converts raw activity into structured behavioral signals.
3. A local machine learning model classifies attention state.
4. The extension applies intervention policy (none / flashcard / prompt).
5. Outcomes are reflected in dashboard analytics and next-session behavior.

## Tech Stack

### Extension Layer

- JavaScript (ES Modules)
- Chrome Extension API (Manifest V3)
- Service Worker + Content Scripts
- HTML/CSS UI components

### Intelligence Layer

- Local machine learning model for distraction classification
- Signal engineering from parsed user activity
- Rule-assisted intervention policy and cooldown handling

### Backend and Data Layer

- Node.js + Express local service
- Firebase Authentication and session sync
- JSONL event logging for model and parser observability

### Analytics Layer

- Session scoring and trend metrics
- Dashboard visualizations
- Focus/distraction history snapshots

## Installation

```bash
git clone https://github.com/atharv666/chrome_extension.git
cd chrome_extension
npm install
npm run build
npm run server:start
```

### Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable **Developer Mode**
3. Click **Load unpacked**
4. Select the project folder

## Usage

1. Open Focus Flow from the extension toolbar.
2. Start a session by setting your topic and allowed study sites.
3. Work normally while activity is tracked in the background.
4. Respond to interventions when distractions are detected.
5. Review performance in the dashboard and improve over time.

## Configuration

Create local environment file:

```bash
cp server/.env.example server/.env
```

Set network/runtime values in `server/.env`:

```env
HOST=127.0.0.1
PORT=3000
```

Optional local overrides (stored by the extension):

- `parseApiEndpoint` (default: `http://localhost:3000/api/parse`)
- `modelApiEndpoint` (default: local model analysis route on your backend)

## Project Structure

```text
chrome_extension/
|-- src/
|   |-- background.js
|   |-- popup.js
|   |-- content.js
|   |-- dashboard.js
|   |-- auth.js
|   |-- sync.js
|   |-- firebase.js
|   `-- parsing/
|-- server/
|   |-- index.js
|   `-- .env.example
|-- scripts/
|-- icons/
|-- docs/
|   |-- demo.gif
|   `-- images/
|-- popup.html
|-- style.css
|-- manifest.json
|-- package.json
`-- README.md
```

## Contributing

1. Fork the repository
2. Create your feature branch
3. Add meaningful commits
4. Open a pull request with clear testing notes

```bash
git checkout -b feature/your-feature
git commit -m "feat: implement your feature"
git push origin feature/your-feature
```

## Roadmap

- Better distraction classification precision with richer behavioral features
- Personalized intervention strategy per user profile
- Weekly and monthly focus reports
- Goal-based focus plans and streak tracking
- Multi-browser support (Edge / Firefox)

## License

MIT License

## Authors

- Pruthviraj - Backend + Logic
- Aditya - UI
