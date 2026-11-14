# Changelog

Every change to MattStream is recorded here, newest first. Each build is published to the
[`mattstream-latest`](https://github.com/matthewisley16-maker/MattStream/releases/tag/mattstream-latest)
release page; the version number only moves when the app changes in a way worth naming.

This file covers **MattStream only**. Nothing about AnyStreamSite belongs in this repository.

## 2026-11-14

### Added

- **Player controls** - playback speed (0.5× to 2×), a quality picker (Auto, 1080p, 720p, 480p -
  the server really re-encodes at that height, never upscaling), and a Cast button in the player itself.
  Closing the window now pauses whatever is playing instead of leaving the sound running in the tray.

- **Cast to another screen** - a film or show can be sent to any other screen with MattStream open (the
  Android TV app, a phone, another PC). *Cast to a screen* lists the screens that are connected and
  *Play there* opens the same video on it; playback streams from the one server, nothing is copied.
  It runs over the tunnel too, so it needs no firewall change.

- **The public link keeps itself alive** - the watchdog also restarts the tunnel if it stops, writes the current
  address to `.tools/public-url.txt` and updates a `MattStream on my phone.url` shortcut on the Desktop.

- **MattStream stays running** - closing the window now hides it to the tray instead of stopping the
  server, so the library keeps serving phones and TVs. The tray has *Open MattStream*, *Copy network
  address*, *Start with Windows* and *Restart it if it ever stops*; *Quit* stops it on purpose. The
  restart watchdog runs from the Startup folder as a hidden PowerShell loop and relaunches the app
  within about ten seconds if it goes away.

- **Cover art that already exists in the file or its `.nfo` is used** - a cover stored inside an
  MKV/MP4 is extracted as the poster, and a Kodi-style `<thumb>`/`<fanart>` URL is fetched and saved
  next to the library. A frame cut from the video is only used when neither exists.

- **Your own library is the default** - `config/defaults.json` names this installation's library
  (`My Home Library` at `http://192.168.25.146:8096/`). The Windows app, the phone app and the TV app
  open on it and stream from it; anyone else edits or removes that file and points at their own server.
- **Multi-library, with a real connection chip** - the header shows the library you are on with
  `Online`, `Connecting` or `Offline` and the real error when it cannot be reached. Servers offers
  Test, Connect, Edit, Remove and **Set as default**, and one library is never merged into another.
- **First-run setup** - a device with nothing to play is asked to *Connect to my library* (name,
  address, admin key, Test connection, save as default) or *Create my library* (add the folders on the
  computer that holds the files).
- **Real metadata matching** - *Match metadata* looks the file up by name, lists the possible films or
  shows with their own posters, and saves the one you pick as that item's title, year, plot and
  artwork. Applying it to a show covers every episode of that show. The TMDB key is entered once and
  kept on the server.

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

- **A phone or TV can no longer be pointed at 127.0.0.1** - on another device that address means that
  device, so the app now refuses it there and names the computer's LAN address instead. The Servers
  panel lists those addresses with a Copy button.

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
