<div align="center">

# 🎧 N96_freq

### *Your Quiet Room*

A production-grade, offline-first music player PWA — local files, YouTube, Spotify, ambient sounds, and focus timers in one serene interface.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js ≥16](https://img.shields.io/badge/Node.js-%E2%89%A516-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PWA Ready](https://img.shields.io/badge/PWA-Ready-A1286A?logo=pwa&logoColor=white)](https://web.dev/progressive-web-apps/)

</div>

---

## ✨ Features

### 🎵 Music Sources

| Source | Details |
|--------|---------|
| **Local Files** | Browse your music library with folder organization. Supports MP3, FLAC, OGG, WAV, AAC, M4A, WMA, AIFF. Auto-watches for new files. |
| **YouTube** | Search & stream any video. Save favorites as "mixes" for one-click replay. |
| **YouTube Playlists** | Paste a playlist URL → fetch all videos → play sequentially or shuffled with auto-advance. |
| **Spotify** | PKCE OAuth flow (no password sharing). Play any public playlist, routed through YouTube for audio. Auto-reconnects on token refresh. |

### 🧠 Advanced Features

- **⚙️ Setup Wizard** — First-run guided configuration. No `.env` editing required. Auto-detects music folders, validates Spotify credentials, and tests your setup end-to-end.
- **⚡ Performance Mode** — Disables Aurora canvas, spectrum analyzer, and ambient sounds. Pauses animations when paused or tab is hidden. Saves CPU and battery.
- **🔋 Ultra Mode (Audio Only)** — Maximum resource optimization. Forces Performance Mode, shrinks video to 1×1px, kills all CSS animations, slows UI polling. Perfect for long listening sessions.
- **🔀 Shuffle & Repeat** — Full shuffle, repeat-one, repeat-all for all sources.
- **⏮ Auto-Resume** — Remembers last track, position, volume, and playlist state across sessions via `localStorage`.
- **📊 Listening Stats** — Tracks total listening time, tracks played, most-played songs, and daily sessions.
- **🎧 Media Session API** — Lock-screen & notification controls on supported browsers.

### 🌿 Ambient Sounds & Timers

| Feature | Details |
|---------|---------|
| **Ambient Sounds** | Rain, Wind, Static, Pink Noise, Brown Noise, Thunder — mix and layer freely with independent volume. |
| **😴 Sleep Timer** | Fade out and auto-pause after a set duration. Presets (15 / 30 / 60 min) or custom. |
| **🍅 Pomodoro Timer** | Configurable focus/rest sessions with procedural audio cues. Auto-pauses music when all sessions complete. |

### 🎨 Themes

Three built-in color themes — **Twilight** (teal), **Dark** (purple), **Light** (sky blue) — with smooth transitions and a one-click toggle.

---

## 📦 Installation

### Prerequisites

- **[Node.js](https://nodejs.org/)** v16 or later
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp#installation)** — required for YouTube features
  ```bash
  # macOS / Linux
  pip install yt-dlp

  # Windows (winget)
  winget install yt-dlp

  # Or download directly from https://github.com/yt-dlp/yt-dlp/releases
  ```

### Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/your-username/n96-freq.git
cd n96-freq

# 2. Install dependencies
npm install

# 3. Start the server
npm start
```

Open **http://localhost:3001** — the ⚙️ Setup Wizard will appear on first launch to guide you through configuration. No manual file editing needed!

### Manual Configuration (Optional)

If you prefer to configure via `.env`, create one in the project root:

```env
PORT=3001
MUSIC_DIR=/path/to/your/music
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
```

<details>
<summary>📁 Music directory examples</summary>

```env
# Windows
MUSIC_DIR=C:/Users/YourName/Music

# macOS
MUSIC_DIR=/Users/YourName/Music

# Linux
MUSIC_DIR=/home/yourname/Music
```
</details>

---

## 🟢 Spotify Setup

Spotify integration is **optional** but unlocks playlist search and playback.

1. Go to the **[Spotify Developer Dashboard](https://developer.spotify.com/dashboard)**
2. Click **"Create App"**
   - Name: `N96_freq` (or anything you like)
   - Description: `Local music player`
   - Redirect URI: `http://127.0.0.1:3001/api/spotify/callback`
3. Copy the **Client ID** and **Client Secret**
4. Enter them in the ⚙️ Setup Wizard, or add to `.env`

> **Note:** Spotify playback works by matching tracks on YouTube for audio streaming. This is a local-only tool for personal use.

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|:---:|--------|
| `Space` | Play / Pause |
| `←` / `→` | Seek ±10 seconds |
| `↑` / `↓` | Volume ±5% |
| `S` | Toggle Shuffle |
| `R` | Toggle Repeat |
| `M` | Mute / Unmute Ambient |
| `F` | Toggle Fullscreen |
| `T` | Open Sleep Timer |
| `P` | Open Pomodoro Timer |
| `/` | Focus Search |
| `Esc` | Close All Overlays |

> Shortcuts are disabled when typing in input fields.

---

## 🛡️ Security

N96_freq is designed to run locally and takes security seriously:

| Protection | Details |
|------------|---------|
| **Path Traversal** | Real-path resolution with strict prefix matching. Symlinks are resolved and validated. Double-encoding attacks are blocked. |
| **CORS** | Restricted to `localhost` / `127.0.0.1` origins only. |
| **Rate Limiting** | YouTube: 20 req/min · Spotify: 60 req/min · Spotify batch: 10 req/min |
| **Static File Lockdown** | Only whitelisted paths are served (`index.html`, `assets/`, `manifest.json`, `sw.js`, `icons/`). Server source and `.env` are never exposed. |
| **Security Headers** | `X-Content-Type-Options: nosniff` · `X-Frame-Options: SAMEORIGIN` |
| **Spotify PKCE** | OAuth flow uses PKCE (Proof Key for Code Exchange) — no client secret is ever sent to the browser. |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Vanilla JavaScript, Web Audio API, YouTube IFrame API, Media Session API |
| **Backend** | Node.js, Express.js |
| **YouTube** | yt-dlp (streaming + search), yt-search (fallback) |
| **Spotify** | PKCE OAuth, Web API |
| **File Watching** | Chokidar |
| **PWA** | Service Worker, Web App Manifest |

### Project Structure

```
n96-freq/
├── server.js              # Express backend (API, audio streaming, security)
├── index.html             # Single-page app shell
├── sw.js                  # Service Worker for offline caching
├── manifest.json          # PWA manifest
├── package.json           # Dependencies & scripts
├── .gitignore
├── assets/
│   ├── css/
│   │   └── style.css      # Design system, themes, all styles
│   └── js/
│       └── app.js         # Frontend application logic
└── music/                 # Default music directory (user-configured)
```

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

<div align="center">

*Built with 🎵 for people who just want to listen.*

</div>