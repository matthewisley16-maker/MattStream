# MattStream

MattStream is this repository and nothing else. It is a completely separate project from
AnyStreamSite: never copy AnyStreamSite code, assets, branding, icons or features in here, and never
push MattStream work to the AnyStreamSite repository.

## What it is

A self-hosted media platform. The server scans folders of any video format, builds a library with real
artwork and metadata, and streams it with FFmpeg transcoding. Ships as a desktop app (Electron), an
Android phone app and an Android TV app, all clients of the same server.

## Working rules

- Keep every change inside this repository; it must build and run on its own.
- After any change, commit and push to `main` here. Do not leave work uncommitted.
- Keep `CHANGELOG.md` current. Every change gets an entry under today's date, in plain language,
  before the task counts as finished.
- Never commit `data/`, `node_modules/`, `dist/` or `bin/ffmpeg.exe` (they are ignored on purpose).
- No fake data anywhere: no placeholder movies, invented metadata, or a connection status the server
  did not actually report.

## Builds

- `node scripts/package-windows.mjs` builds the portable Windows app into `dist/`.
- `.github/workflows/mattstream-builds.yml` builds both APKs and that zip on every push and refreshes
  the `mattstream-latest` release page.
- Android: `cd android && gradle assembleRelease` (needs JDK 17 + the Android SDK).
