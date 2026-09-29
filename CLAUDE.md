# claude-swap-widget

A macOS menu-bar / widget app (Electron) that shows usage for every Claude Code
account and switches between them with a click. It is a **UI on top of
[claude-swap](https://github.com/realiti4/claude-swap)** (MIT, Onur Cetinkol).
It is **not** a fork of it.

## Decisions (already made)

- Stack: **Electron** (JS), macOS first (Apple Silicon); keep it cross-platform where it costs nothing.
- claude-swap is a **runtime dependency, not bundled**. The user installs it
  (`uv tool install claude-swap` or `pipx install claude-swap`); the app finds
  `cswap` and shows a setup screen with install instructions when it is missing or too old.
- A **separate repo** of its own, MIT licensed, crediting claude-swap in the README.
- The app **never reads or writes credentials itself**. All account operations
  go through `cswap … --json`. Do not import or port claude-swap code.
  One exception (decided 2026-09-29): `cswap disable|enable <num>` have no `--json` and never
  prompt, so they run plain; success is exit 0, failure is cswap's `Error: …` line on stderr.
- Tray menu mirrors claude-swap's own menu bar app (accounts, Next, Best, Next available,
  Disable/Enable, Settings). Add and Remove are NOT run by us (they can prompt; remove is
  irreversible): we show the `cswap add` / `cswap remove N` command with a Copy button.
  No auto-switch in the widget: claude-swap's own `cswap menubar` / `cswap auto` does that.
  "Open cswap Log" only reveals `~/.claude-swap-backup/claude-swap.log`; we never parse it.
- UI source: TheMaestr-o/claude-usage-widget, branch `maestro-edition` (MIT, © 2024 Slavomir
  Durej; Maestro edition by The Maestro). Decided 2026-09-29: we may take its visual layer
  (glass rings, statistics, menu-bar styles, widget window, i18n) — the author agreed. Keep
  both copyright notices in LICENSE and credit both in README. Take the UI only: its data
  layer (claude.ai login, `sessionKey` cookie, hidden-window fetch) is exactly what this app
  must not do; data still comes from cswap. Amber at 75 %, red at 90 %.

## cswap JSON contract (checked against claude-swap 0.27.0b1 and 0.26.0)

- `cswap list --json` → `{schemaVersion:1, activeAccountNumber, accounts:[row…]}`. An empty install
  (no `cswap add` yet) answers `{activeAccountNumber: null, accounts: []}` with exit 0.
- JSON goes to stdout as `json.dumps(payload, indent=2)`; nothing else is printed there.
- `cswap status --json` → `{schemaVersion:1, active: row|null}`
- `cswap switch <num|email> --json`, `cswap switch --strategy best|next-available --json`,
  bare `cswap switch --json` = rotation to the next account (strategy `"rotation"`), skipping disabled ones
  → `{schemaVersion:1, switched, from, to, strategy, reason, message, warnings[]}`.
  `from`/`to` are `{number, email}`. `reason`: `switched`, `already-active`, `activated`,
  or a no-op reason (`already-best`, `candidates-exhausted`, `no-valid-target`,
  `only-one-account`, `unmanaged-account`, `usage-unavailable`). Show `message` to the user.
- Error: stdout `{schemaVersion:1, error:{type, message}}` with a non-zero exit code.
  `ConfigError` "No accounts are managed yet" comes only from `switch` on an empty install;
  an unknown account is `AccountNotFoundError` ("Account-N does not exist").
- Some early failures print **plain text to stderr, not JSON** (e.g. the root guard).
  Handle non-JSON output.
- Row fields: `number, email, alias?, organizationName, organizationUuid, isOrganization,
  active, disabled?, usageStatus, usage, usageFetchedAt?, usageAgeSeconds?, lastGoodUsage?,
  lastGoodFetchedAt?, lastGoodAgeSeconds?, usageError?, usageRetryAt?, loginExpiresAt?`
  (the last three only from 0.27).
- `usageStatus`: `ok`, `unavailable`, `token_expired` (refresh deferred, retried by itself),
  `relogin_required` (only the user can fix it), `keychain_unavailable`, `foreign_credential`
  (a switch repairs it), `no_credentials`, `api_key` (no subscription quota). Unknown values
  get a neutral badge.
- Non-null `usage` can still be old: cswap serves a trusted measurement for up to 1–2 h
  (`usageAgeSeconds`); past 180 s the UI shows its age.
- `pct` is 0–100. `resetsAt` is ISO 8601 with microseconds and `+00:00`. Windows also carry
  `countdown`/`clock` strings; we compute countdowns from `resetsAt` instead so they tick.
- Personal accounts have `organizationName` = `"<email>'s Organization"`; the UI hides it.
- `usage`: `fiveHour {pct, resetsAt}`, `sevenDay {pct, resetsAt, expectedPct?, aheadOfPace?,
  projectedExhaustionAt?, willLastToReset?}`, `spend {used, limit, pct, currency, resetsAt?}`,
  `scoped [{name, pct, resetsAt, …}]`. Every sub-key is optional.
- When `usage` is null, fall back to `lastGoodUsage` and show it as stale, with its age.
- The contract is additive: ignore unknown fields and events.
- `cswap auto --json` streams one JSON event per line (`poll`, `switch`, `no-switch`,
  `account-quarantined`, `all-exhausted`, `error`). Useful later for live updates.
- `cswap --version` → `cswap 0.27.0b1` (the program name is whatever it was run as, e.g.
  `claude-swap`). Requires Python ≥ 3.12.
- cswap honours `CLAUDE_CONFIG_DIR`; an app launched from Finder does not inherit it from the
  shell (`launchctl setenv CLAUDE_CONFIG_DIR …` does).

## Gotchas

- Apps launched from Finder on macOS get a minimal PATH. Search `~/.local/bin`,
  `/opt/homebrew/bin` and `/usr/local/bin`, allow an override (setting or `CSWAP_PATH` env var),
  and use `execFile`, never a shell string.
- Switching never needs `/logout`; claude-swap warns that logout can revoke refresh tokens.
- Don't poll too often: `list` hits the usage API, though cswap caches it. Refresh every 60 s by default.
- Never kill cswap early: `list`/`status` may rotate a refresh token and `switch` rewrites credentials
  under locks. Timeouts are last-resort caps (15 s version, 120 s read, 180 s switch): SIGINT to
  cswap's process group (so its `finally` blocks release their locks), SIGKILL 10 s later.
  `runProcess` uses `spawn` with its own timer; execFile would wait forever for a child that
  survives the signal, and every later call queues behind it.
- Switch by identity, not by slot: the renderer sends `{email, organizationUuid}` and the service
  looks up the current slot number in a fresh `list` right before `switch` (`cswap move` can
  renumber slots under the popover).
- The popover must never be destroyed: `close` (Cmd+W) hides it unless the app is quitting.
- Keep the renderer sandboxed: `contextIsolation: true`, `nodeIntegration: false`,
  and expose only a small API through preload.
- `window.api` from contextBridge is a non-configurable global: a top-level `const api`
  in a classic script is a SyntaxError. The renderer aliases it as `ipc`.
- A sandboxed preload has no `clipboard`; copying goes through main (`app:copy`).
- VS Code (and Claude Code inside it) leaks `ELECTRON_RUN_AS_NODE=1` into child
  processes, which makes Electron run as plain Node (`app` is undefined).
  `npm start` goes through `scripts/start.js`, which clears it.
- claude-swap ships its own `cswap menubar` (rumps). We keep going anyway: our value is
  the rings, cards and popover.

## Packaging

- `package.json` `build`: appId `io.github.btvmn.claude-swap-widget`, productName
  "Claude Swap Widget" (also the userData folder name, in dev too), `mac.identity: "-"`
  (ad-hoc; no Developer ID) with `hardenedRuntime: false`, `extendInfo.LSUIElement: true`
  (menu-bar only), arm64 dmg only. `build/icon.png` is generated by `npm run icon`
  (scripts/make-icon.js); electron-builder makes the .icns from it.
- Users must bypass Gatekeeper once (System Settings → Privacy & Security → Open Anyway, or
  `xattr -dr com.apple.quarantine`); the README explains it.

## Layout and dev loop

- `main.js`: tray, popover, IPC, timer. `src/service.js`: state + a queue so cswap calls
  never overlap (refreshes coalesce). `src/shared/usage.js`: pure helpers, loaded by both
  main (`require`) and the renderer (`<script>`, `window.Usage`). `src/tray-icon.js`: the
  menu-bar ring, drawn as a raw bitmap (template image below 75 %, amber/red above).
  `src/settings.js`: `userData/settings.json` (`cswapPath`, `theme`, `refreshSeconds`).
- `npm test`. `CSWAP_PATH="$PWD/test/fixtures/fake-cswap" npm start` runs the UI on the
  fake (`FAKE_CSWAP_SCENARIO=default|empty|root|garbage|slow|schema2|old|flood|crash|stubborn|rolled`).
  `CSW_THEME=light|dark` forces the theme; `CSW_CAPTURE=out.png` saves a screenshot of the
  popover (plus `out-tray.png`) and quits.
- On the user's real accounts only run `list`/`status`; test switching on the fake.

## Status

- [x] `src/cswap.js`: binary discovery, version check (min 0.20.0), JSON parsing
      and error handling, `list` / `status` / `switchTo(num|email|{strategy})`.
- [x] Unit tests (`node --test`, 100, pass on Node 25 and Electron's Node 24) for cswap.js, the
      service, shared helpers, settings, tray icon; fake `cswap` in `test/fixtures`
      (20 / 80 / 95 %, `token_expired`, `disabled`, a 9-min-old measurement).
- [x] `main.js`: tray with the active account's 5h % and ring, frameless vibrancy popover,
      IPC (`accounts:get|refresh|switch`, `app:*`), 60 s timer, refresh on wake and on open.
- [x] `preload.js`: contextBridge `window.api`.
- [x] Renderer: cards with 5h/7d rings, per-model (scoped) and extra-usage lines, badges,
      Switch, "Switch to best account", setup / too-old / no-accounts / error screens,
      error banner over stale data, toast, light/dark.
- [x] Checked with the fake cswap (screenshots of every screen, switch clicks end to end)
      and read-only with the real cswap 0.26.0 (Electron 44.4.5).
- [x] Multi-agent review (2026-09-29), three rounds: 20 + 24 + 10 confirmed findings fixed (Cmd+W
      destroying the popover, empty-install contract, kill timeouts and SIGKILL escalation, cache
      age, tray showing outdated %, list rebuilds and focus, reopen via 'activate', stale override
      screen, default app menu, renderer crash recovery, popover taller than the screen, …).
- [x] README (install claude-swap first, credits), MIT LICENSE, electron-builder dmg
      (`npm run dist` → `dist/Claude Swap Widget-<version>-arm64.dmg`, ad-hoc signed,
      `LSUIElement`; the packaged .app was launched once in capture mode and works).
- [ ] Try it by hand on the Mac: tray click / blur / positioning, vibrancy, Open at Login,
      Gatekeeper "Open Anyway" flow from the dmg, `activate` on reopen from Spotlight.
- [ ] Push to github.com/Btvmn/claude-swap-widget and publish the dmg as a release.
