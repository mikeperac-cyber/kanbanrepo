# Kanban Repo Cards

A local Windows desktop board for organizing repositories across four GitHub accounts. Every account gets a column; every repo is a compact row with an always-visible one-line note that expands in place to reveal a checklist and full notes.

## Features

- Four account columns: `michaeldaniel`, `mikeperac`, `michaeld`, and `mikelb`
- A left account sidebar that works as a dashboard: repo counts, pinned counts, and overdue counts per account; click an account to open it as a full-width board, or **All accounts** to see every column side by side
- Compact repo rows with a one-line note field on every row; a row expands in place for its checklist and full notes, one open per column
- Search across repo names, URLs, tags, notes, and checklist items
- Sort pinned repos first, by recent update, by creation date, or by name
- Add and edit repository labels, tags, colors, priority, and due dates
- Pin important repos, then filter the board to pinned repos only from the header
- Keep a checklist for each repo, then archive work without deleting it
- Drag a repo between columns or drop a web link onto a column
- Import public repos from GitHub on demand; existing local repos and notes are preserved
- Dark and light themes, keyboard shortcuts, and local-only board storage

## Requirements

- Windows 10 version 1809 (build 17763) or newer, x64
- Node.js 20+ and npm for development and packaging

## Run it

```powershell
npm install
npm start
```

## Build installers

| Command | Output |
| --- | --- |
| `npm run dist:exe` | `dist/Kanban-Repo-Cards-Setup-1.4.0.exe` — Windows installer |
| `npm run dist:store` | `dist/Kanban-Repo-Cards-1.4.0-x64.appx` — Store package |
| `npm run dist` | both packages |
| `npm run icons` | regenerates the Windows and in-app icons |
| `npm run smoke` | runs the development UI smoke check |

Builds are unsigned unless a certificate is supplied. For local signing, create a development certificate once and build with the signing wrappers:

```powershell
npm run cert:dev
powershell -ExecutionPolicy Bypass -File tools/build-installer.ps1
powershell -ExecutionPolicy Bypass -File tools/build-store.ps1
```

For a real Store submission, use the Partner Center identity and signing certificate described in [STORE_READINESS.md](STORE_READINESS.md).

## Using the app

| Action | How |
| --- | --- |
| Add a repo | Paste a URL into the add field at the top of a column and press Enter or Add |
| Open a repo | Click its title; it opens in your default browser |
| Expand a repo | Click the chevron on the row to reveal its checklist and full notes in place |
| Edit details | Click the pencil to change label, tags, priority, due date, or color |
| Take repo notes | Type in the one-line note field on the row; longer notes live in the expanded row |
| Add checklist items | Expand a repo, then type a task under **Checklist** and press Enter or Add |
| Pin a repo | Click the star; pinned repos sort to the top by default |
| Show pinned repos only | Click **Pinned only** in the header |
| Archive a repo | Click the archive control; use **Show archived** to find it later |
| Search | Use the top search field, or press **Ctrl+F**; **Esc** clears an active search |
| Filter by tag | Click a tag chip; **Clear filter** restores the full board |
| Open one account | Click the account in the left sidebar; its column takes over the whole board area |
| Show all accounts | Click **All accounts** in the left sidebar to bring back the four-column board |
| Import GitHub repos | Click **Import** on a column; only missing public repos are added |
| Change a column color | Click the palette button in that column's header |
| Move a repo | Drag its handle onto another column; its notes and checklist move with it |
| Add a quick link | Drop an `http(s)` link from a browser onto a column |
| Write an account note | Use the account note area at the bottom of its column |
| Change theme | Click the sun/moon button; the default follows Windows |
| Jump to an add field | Press **Ctrl+N** |

## Data and privacy

Board data is stored locally in Electron's per-user profile under `%APPDATA%\Kanban Repo Cards`. The current state key is v3; the app migrates v2, v1, and the original prototype data on first launch. Notes are plain text and remain attached to their repository. The NSIS installer is configured not to remove app data when the app is uninstalled.

The app does not send board data or make automatic network requests. Clicking **Import** sends the selected public GitHub username to GitHub's API and imports public repository links. Clicking a repo opens that link in the system browser.

## Security

- `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`
- A strict Content Security Policy; the renderer has no direct network access
- External links open only in the system browser and only for `http` or `https`
- Device permission requests are denied
- No analytics or telemetry

## License

MIT © 2026 Michael Daniel
