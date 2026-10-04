# Focus Agent

A local-first execution companion built for **Raj** (a privacy-preserving pseudonym for a real friend). It compares declared priorities with on-device activity evidence and offers a gentle intervention when attention drifts.

Built for the **Hacktoberfest Weekend Challenge: Build for a Friend**.

## Prototype target

- KDE Plasma 6 on Wayland
- Electron + React + TypeScript
- JavaScript runtime + Node's built-in SQLite
- KWin activity bridge
- Gemma through a local Ollama runtime

Window titles are not stored by default. Activity data stays on the device.

## Development

```bash
npm install
npm run dev
```

The project intentionally omits optional npm dependencies. Its required Linux Rollup and esbuild binaries are direct development dependencies so builds remain reproducible without installing `dbus-next`'s unused native socket helper.

Install the KWin bridge after the desktop app is running:

```bash
kpackagetool6 --type=KWin/Script -i ./kwin/focus-agent
kwriteconfig6 --file kwinrc --group Plugins --key focus-agent-activityEnabled true
qdbus6 org.kde.KWin /KWin reconfigure
```

The extension reports only the application identifier and PID. Captions are sent to the runtime but discarded unless the user explicitly enables title capture.

## Why open-weight AI

The activity stream is deeply personal. Gemma can interpret ambiguous task context without uploading a behavioral profile to a server. The runtime remains useful when the model is unavailable: collection, tasks, breaks, and deterministic intervention policies continue locally.
