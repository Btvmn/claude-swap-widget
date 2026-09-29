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

- `main.js`: entry only (single-instance lock + userData probe, lifecycle, dev switches,
  `makeContext()`). Modules in `src/main/` each export `attach(ctx)`: `window.js` (popover /
  widget window, all hardening), `placement.js` (pure), `tray.js`, `menu.js`, `ipc.js`
  (`fromUi` sender check), `settings-ipc.js`, `history-hook.js`, `notify.js`,
  `account-menu.js`, `capture.js`. They read `ctx` at call time and talk through `ctx.bus`
  (in-process): `'setting:<key>' (next, prev)`, `'settings' (next, prev)`, `'refresh:manual'`.
- `src/service.js`: state + a queue so cswap calls never overlap (refreshes coalesce).
  `src/cswap.js`: the CLI bridge. `src/settings.js`: `userData/settings.json`, strict
  `sanitize`, `RENDERER_KEYS` (the only keys the renderer may write), `publicSettings`.
  `src/history.js`: usage history as JSONL per UTC day in `userData/history/` (32 days).
- Shared UMD modules (main `require`s them, the renderer loads them with `<script>`):
  `src/shared/usage.js` (`window.Usage`), `i18n.js` (`window.I18n`, en/ru/uk/de),
  `stats.js` (`window.Stats`). `src/tray-model.js` (pure) decides the menu-bar picture;
  `src/renderer/tray-picture.js` paints the Maestro styles on a canvas and sends a PNG back
  (`tray:image` is positional: `(seq, dataUrl, template)`); `src/tray-icon.js` is the
  `classic` style and the fallback when the renderer cannot paint.
- Renderer: classic scripts, each an IIFE exposing one global. CSS in `src/renderer/css/`.
  Chart.js 4.5.1 is vendored in `src/renderer/vendor/` (`npm run vendor`), loaded lazily.
- `npm test` (unit, incl. `renderer-static.test.js` = the CSP rules below, and
  `attribution.test.js`). `npm run e2e [flow…]` drives the real app on the fake cswap
  (`test/e2e/*.flow.js`, markup knowledge only in `test/e2e/ui.js`); it refuses to spawn any
  cswap other than the fake. `CSWAP_PATH="$PWD/test/fixtures/fake-cswap" npm start` runs the UI on
  the fake (`FAKE_CSWAP_SCENARIO=default|empty|root|garbage|slow|schema2|old|flood|crash|stubborn|rolled|drift|nofetchedat|single|noactive`).
  Dev switches (ignored when packaged where noted): `CSW_THEME`, `CSW_LANG`, `CSW_CAPTURE=out.png`
  (screenshot + `out-tray.png`, then quit), `CSW_USER_DATA=<dir>` (packaged: ignored),
  `CSW_VIEW`, `CSW_WINDOW`. Always give captures and e2e a temp `CSW_USER_DATA`.
- `CSWAP_PATH=/nonexistent` does NOT simulate a missing cswap (discovery falls back to
  `~/.local/bin/cswap`, the real one): use the e2e `missing` flow.
- On the user's real accounts only run `list`/`status`; test switching on the fake.

## Renderer rules (enforced by test/renderer-static.test.js)

- The CSP meta in `index.html` never changes. No `style=` / `on…=` attributes in markup, no
  inline `<script>` bodies. Inline styles only through the CSSOM (`el.style.x`,
  `setProperty`); never `setAttribute('style')`, `.cssText`, `insertRule`, `<style>` elements.
- No `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `DOMParser`: cswap
  strings go in through `textContent` / `title` only. No `eval` / `new Function`.
- No remote content, fonts or `@import`; no assets from the Maestro repo (their logo is an
  Anthropic mark).
- Every file with ported Maestro code carries the attribution header (LICENSE "Third-party
  code"); `test/attribution.test.js` checks the list.

## Status

- [x] MVP: cswap bridge, service queue, tray, popover, setup screens, tests, dmg (see git history).
- [x] Three multi-agent reviews of the MVP (2026-09-29), all confirmed findings fixed.
- [x] Tray menu in claude-swap's own style (accounts, Next/Best/Next available, Disable/Enable,
      copyable Add/Remove, Open cswap Log, Settings).
- [x] Maestro UI port (plan: waves A–D), 2026-09-29:
  - [x] A/B: e2e harness (`npm run e2e`), renderer-static + attribution tests, settings keys,
        i18n (en/ru/uk/de), stats + history cores, tray painter/model, CSS tokens, Chart.js vendored,
        main.js split into src/main/*.
  - [x] C: localized menu + settings IPC, tray pictures (Maestro styles, classic fallback),
        history recording, notifications, desktop widget mode.
  - [x] D: renderer shell (screens, i18n, pin-as-widget), hero rings (countdown, pace tick,
        glow, expand rows for models/spend, recharge comet, ring-in-ring style), account bar rows.
  - [ ] D: statistics view (Today/Week/Month, line/bars/summary).
  - [ ] Review of the port; README "What it shows" / screenshots; dmg rebuild.
- [ ] Try it by hand on the Mac: glass/vibrancy, tray pictures on the real menu bar, widget drag,
      notifications permission, Open at Login, all 4 languages.
- [ ] Push to github.com/Btvmn/claude-swap-widget and publish the dmg as a release.
