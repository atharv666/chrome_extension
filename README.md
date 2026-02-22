# Focus Flow - Chrome Productivity Tracker

Track active tab time and detect distractions automatically with a local machine learning pipeline built for real-time focus monitoring.

[![Build Status](https://img.shields.io/badge/build-passing-brightgreen)](#)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Version](https://img.shields.io/badge/version-1.0.0-orange.svg)](#)
[![Stars](https://img.shields.io/github/stars/atharv666/chrome_extension?style=social)](https://github.com/atharv666/chrome_extension)

---

## Demo

People decide in 5 seconds whether your project is worth trying, so this section should stay visual and quick.

![Demo](docs/demo.gif)

### Screenshots

![Popup](docs/screenshots/popup.png)
![Intervention](docs/screenshots/intervention.png)
![Dashboard](docs/screenshots/dashboard.png)

### Short Video

- Product walkthrough: [Watch here](https://your-demo-link.com)

### GIF Recording Tools

- Linux -> Peek
- Windows -> ScreenToGif
- Mac -> Kap

---

## About

Focus Flow is a Chrome extension that helps users stay productive by tracking active tab behavior, detecting idle time, and triggering distraction interventions when users drift from their study/work context.

### What problem it solves

Most focus tools only run timers or block websites. They do not understand browsing behavior quality, activity patterns, or context switching.

### Why it exists

Deep work is hard in a browser environment. Focus Flow exists to reduce unintentional distraction and make productivity measurable.

### Who it is for

- Students and exam aspirants
- Developers in focused coding sessions
- Online learners and self-study users
- Anyone who wants reliable productivity telemetry

---

## Features

- Tab activity tracking
- Idle detection
- Distraction alerts
- Analytics dashboard
- Topic-aware interventions
- Session history and focus scoring

---

## Tech Stack

- JavaScript
- Chrome Extension API (Manifest V3)
- HTML/CSS
- Node.js + Express (local backend service)
- Firebase (auth/session sync)
- Local machine learning decision pipeline for distraction analysis

---

## Installation

```bash
git clone https://github.com/atharv666/chrome_extension.git
cd chrome_extension
npm install
npm run build
npm run server:start
```

### Load in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer Mode**
3. Click **Load unpacked**
4. Select the project folder

---

## Usage

1. Click the extension icon
2. Start a focus session
3. Continue browsing/studying normally
4. View analytics and interventions
5. Improve focus score over sessions

---

## Project Structure

```text
chrome_extension/
|-- src/
|   |-- background.js
|   |-- popup.js
|   |-- content.js
|   |-- dashboard.js
|   |-- sync.js
|   `-- parsing/
|-- server/
|   |-- index.js
|   `-- .env.example
|-- scripts/
|-- icons/
|-- popup.html
|-- style.css
|-- manifest.json
|-- package.json
`-- README.md
```

---

## Configuration

Create environment file:

```bash
cp server/.env.example server/.env
```

Set values in `server/.env`:

```env
GEMINI_API_KEY=your_key_here
GEMINI_MODEL=gemini-1.5-pro
HOST=127.0.0.1
PORT=3000
```

You can also configure extension endpoints through local storage:

- `parseApiEndpoint` (default: `http://localhost:3000/api/parse`)
- `aiApiEndpoint` (default: `http://localhost:3000/api/ai/analyze`)

---

## Contributing

1. Fork this repository
2. Create a new branch
3. Commit your changes
4. Open a pull request

Example:

```bash
git checkout -b feature/your-feature
git commit -m "Add: your update"
git push origin feature/your-feature
```

---

## Roadmap / Future Improvements

- Better behavioral classification accuracy
- Smarter personalized intervention timing
- Weekly/monthly productivity reports
- Team accountability mode
- Cross-browser support (Edge/Firefox)

---

## License

MIT License

---

## Authors

- Pruthviraj - Backend + Logic
- Aditya - UI
