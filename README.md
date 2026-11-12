# IDEDITOR 📝

A powerful, fully browser-based, serverless code editor. Write HTML, CSS, and
JavaScript, preview your code live, manage GitHub repositories, and run a
multi-agent AI assistant — all directly from your browser without any backend.

![Version](https://img.shields.io/badge/Version-2.1.0-blue.svg)
![License](https://img.shields.io/badge/License-MIT-green.svg)
![Serverless](https://img.shields.io/badge/Backend-Serverless-brightgreen.svg)
![PWA](https://img.shields.io/badge/PWA-Installable-purple.svg)

---

## 🚀 Features

### 🤖 Multi-Agent AI Assistant
- **10 providers, all first-class:** OpenAI, Groq, Google Gemini, Together,
  OpenRouter, Fireworks, Mistral, Ollama (local), Custom, and Mock (for
  testing without any key)
- **Multiple named agents** — each with its own provider, model, system
  prompt, temperature, and pipeline role
- **3 orchestration modes:**
  - **Single** — one agent answers
  - **Parallel** — up to 4 agents answer the same prompt simultaneously
  - **Pipeline** — agents run in sequence, each receiving the previous
    step's output as context
- **Apply / Keep / Discard** for AI code blocks (Copilot-style) — apply
  writes the code (undoable), Keep confirms, Discard reverts with a
  confirmation dialog if you've edited since
- **Context-aware** — the active file is automatically injected into every
  prompt
- **Test connection** button per agent — verifies the config with a 1-token
  request before saving

### 📂 Multi-Project Workspace
- Create, clone-from-GitHub, switch, and delete projects
- Per-project file sets, persisted locally
- Projects dashboard with cards, dates, file counts
- Large workspaces lazy-load Monaco models as files are opened, preserving unopened files in the project snapshot

### ✍️ Monaco Editor
- Same engine as VS Code — syntax highlighting, auto-complete, minimap
- Files & folders tree with rename, delete, filter
- Folder contents render on expansion, file search is debounced, and dirty indicators use cached element references instead of full DOM scans
- Find & Replace with case sensitivity and multi-line search
- Auto-format via Prettier
- Font-size controls, theme selector, minimap toggle

### 👁️ Live Preview & Console
- Instant run with optional debounced auto-run
- **Desktop / Mobile layout toggle** — mobile mode constrains the iframe to
  a phone-shaped device frame (375px)
- Built-in console capturing `console.*` and uncaught errors, with
  click-to-jump-to-line
- Fullscreen preview, download-preview HTML, close
- Embedded preview runs in a sandboxed iframe without same-origin access.
- Local linked CSS, classic JavaScript, images, and other text-backed resources are embedded from the active project where supported.
- Preview Content Security Policy blocks outbound network connections, external frames, forms, and remote assets. Projects that require API calls, external CDNs, remote fonts, or network services will not work in the preview.
- ES-module import graphs, server-side routes, and binary workspace assets are not currently served by a virtual filesystem. Use the preview for self-contained client-side projects.

### 🐙 GitHub Integration (REST API)
- Clone public and private repos via Personal Access Token
- **Commit Changes** stages a local snapshot in the current browser project; **Push** publishes that staged snapshot to GitHub.
- Each project stores its own repository URL, branch, and synchronization baseline. New projects can still inherit the saved default repository URL until a project is configured separately.
- **Pull** uses a three-way merge against the last cloned/pulled snapshot. Non-overlapping local and remote changes are preserved; conflicting files stop the pull without changing the workspace.
- Branch switching requires confirmation and uses the same safe synchronization path.
- Clone supports regular UTF-8 text blobs up to 5 MB per file. Binary files, symlinks, submodules, and non-standard file modes are rejected before workspace replacement rather than being corrupted or silently downgraded.
- Commit graph viewer

### ☁️ Firebase Cloud Sync
- Login with Google
- Save and load projects to Firestore
- Repository URL preferences can sync; GitHub tokens remain in tab memory only and must be re-entered after refresh

### 🎨 Themes
Dark (default), Light, Dracula, Monokai, GitHub Dark — Monokai and
Dracula are custom-registered Monaco themes, so syntax highlighting
matches the chrome

### 💻 Built-in Terminal
Simulated shell with commands: `help`, `ls`, `cat`, `touch`, `mkdir`,
`run`, `format`, `theme`, `git`, `firebase`

### 📦 Import / Export
- **Import** — drag or select files (`.html .css .js .ts .json .md .svg`)
- **Export** — download the project as a ZIP
- **Share** — generate a compressed URL of the entire project (LZ-String)

### 📱 PWA
- Installable on supported desktop and mobile browsers with a scalable SVG app icon.
- Responsive mobile layout with a touch-friendly action bar.
- Offline application-shell caching; previously loaded version-pinned Monaco, syntax-highlighting, Firebase, and worker resources are cached opportunistically after first use. First-time offline use still requires an initial online load.
- Project files and Git tracking data are stored as individual IndexedDB project records; autosave updates only the active project instead of serializing the entire workspace into localStorage. Theme and editor preferences remain in localStorage.
- On first launch after this update, existing `idEditor.projectsData` content is merged into IndexedDB in a transaction. Newer legacy project versions and missing projects are recovered; existing newer IndexedDB records are retained. The legacy backup is removed only after the database transaction succeeds. If IndexedDB is unavailable and a valid legacy backup exists, IDEDITOR falls back to localStorage and records deletion tombstones. If IndexedDB becomes unavailable after a successful migration with no remaining legacy backup, startup stops with a recovery warning rather than creating an empty workspace; do not clear the site's browser data.

---

## 🔐 Security & Credential Handling

- Project previews run in a sandboxed iframe with scripts enabled but same-origin access, popups, and top-level navigation disabled.
- Preview console messages are accepted only from the actual preview frame and are type-checked and length-limited.
- AI Markdown is sanitized against an HTML allowlist before it is inserted into the chat.
- GitHub Personal Access Tokens and AI provider API keys are memory-only. They are not persisted to local storage or Firebase.
- Older locally stored credential values are removed during app startup. Sign in to Firebase once after updating so IDEDITOR can remove a legacy Git token field from your cloud settings.
- Legacy project data is migrated to IndexedDB before the old localStorage copy is removed; the migration is transactional and retains the legacy copy if it fails.
- Pending autosaves are flushed on tab hide, `pagehide`, and `beforeunload`; IndexedDB writes are asynchronous, so press Ctrl/Cmd+S and wait for the save confirmation before force-closing the browser during heavy editing.
- Project switching normalizes older string-only file records into `{ lang, content }` entries to preserve saved contents.
- GitHub Pull uses a three-way merge; overlapping changes stop the operation without modifying the workspace.
- Cloud imports preserve any project with a staged commit and protect the active project when it has unsaved editor changes. Other safe-to-replace cloud projects can still load, and imported project records retain local Git tracking metadata.

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Vanilla HTML, CSS, JavaScript (100% client-side) |
| **Editor** | [Monaco Editor](https://microsoft.github.io/monaco-editor/) |
| **Auth & Database** | [Firebase](https://firebase.google.com/) — Auth + Firestore |
| **Git Operations** | [GitHub REST API](https://docs.github.com/en/rest) |
| **AI Providers** | OpenAI · Groq · Google Gemini · Together · OpenRouter · Fireworks · Mistral · Ollama · Custom |
| **Utilities** | Prettier (formatting), JSZip (export), LZ-String (share URLs) |

---

## 💻 Getting Started

IDEDITOR is 100% client-side — no backend, no build step, no `npm install`.

### 1. Clone the repository

```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
cd YOUR_REPO_NAME