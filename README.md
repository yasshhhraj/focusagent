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

## What works

- Declared plans become up to three local tasks; the first becomes active.
- Ollama uses the first installed Gemma model with schema-constrained JSON and temperature zero.
- Ambiguous activity is sent to Gemma only after five minutes, using an allowlisted context with no window titles, URLs, or document contents.
- Model output is validated and policy-checked; Gemma selects a low/medium/high confidence band that the deterministic policy maps to 40/70/90%, and only high-confidence distraction can recommend an intervention.
- A deterministic parser keeps planning usable when Ollama or Gemma is unavailable.
- KWin window changes become local SQLite sessions, with titles discarded by default.
- Raj can correct an activity as related, switch priorities, confirm completion, pause monitoring, or take a timed break.
- Corrections are remembered per task and application; possible drift appears after ten minutes in an unrecognised app.
- Unanswered drift checks escalate from a quiet desktop notification to a full-window intervention after five ignored prompts.
- Monitoring can be paused for 15 or 30 minutes, 1, 2, or 4 hours, or indefinitely until Raj resumes it.

To enable Gemma, start Ollama and install any Gemma-family model, for example `gemma3:1b`. The app discovers it automatically at `127.0.0.1:11434`.

## Development

```bash
npm install
npm test
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
