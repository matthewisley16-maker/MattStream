# Changelog

Every change to MattStream is recorded here, newest first. Each build is published to the
[`mattstream-latest`](https://github.com/matthewisley16-maker/MattStream/releases/tag/mattstream-latest)
release page; the version number only moves when the app changes in a way worth naming.

This file covers **MattStream only**. Nothing about AnyStreamSite belongs in this repository.

## 2026-11-14

### Added

- **Windows installer** - `MattStream-Windows-Setup.exe` is built and published with the phone and TV
  APKs. It installs per-user (no admin prompt), adds desktop and Start-menu shortcuts, and keeps the
  library in `%APPDATA%\MattStream\data`.
- **Artwork generated from the video** - when a file has no poster, backdrop or `.nfo` art anywhere,
  the bundled FFmpeg cuts a poster and a backdrop from the film itself and caches them in `data/art`.
  Real artwork on disk always wins over a generated frame.
- **Watchlist** - films and shows offer *Add to watchlist* in their details panel, saved per viewer,
  with a *Your watchlist* shelf on Home.
- **Public sharing without admin rights** - `share.bat` starts the server and opens a Cloudflare
  tunnel, so the library can be watched from anywhere with no firewall rule or router change.
- **Native file picker** - folders and multiple video files are chosen in the real operating-system
  dialog through `electron/preload.js` instead of browsing inside the app.
- **One-click play from posters**, with the chosen file's subtitles and artwork intact.

### Changed

- **Documentation** - README now covers the Servers page and admin key, media management, uploads,
  sharing, and the `metadata.json` / `art/` data files.
- **Management table** falls back to an episode's still when it has no poster, and no longer reports
  a still as "no poster".
- **Packaged desktop app** keeps its data under the user's AppData folder, because an installed copy
  cannot write beside the executable in Program Files.

### Fixed

- **A panel could close the instant it opened** - a history pop queued by the previous overlay was
  handed to the new one, which shut it before it could be read. Pops older than the panel are now
  ignored.
- **Empty artwork slots** - a library with no `poster.jpg` anywhere showed generated gradient tiles;
  frames are now extracted from the files themselves.

### Security

- **A tunneled request is no longer treated as the local owner.** Because a tunnel reaches the server
  from `127.0.0.1`, every visitor used to look like the administrator and was handed the admin key.
  Requests carrying proxy headers, or arriving for a host other than localhost, must now present the
  admin key like any other device.

### Repository

- MattStream moved out of the AnyStreamSite repository into this one, with its own copy of the
  server, web UI, Electron shell and Android phone/TV apps.
- `.tools/` (the tunnel binary) is ignored, like `data/`, `node_modules/`, `dist/` and `bin/ffmpeg.exe`.

---

## How to add an entry

1. Add your change under the current date, in the right group: **Added**, **Changed**, **Fixed**,
   **Security** or **Repository**.
2. Say what changed for the person using the app, not which file you touched.
3. If it changes how someone watches, downloads or shares, say so plainly - those are the entries
   people actually read.
