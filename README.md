# claude-swap-widget

A macOS menu-bar widget that shows the usage of every Claude Code account you
manage with [claude-swap](https://github.com/realiti4/claude-swap), and
switches between them with one click.

<p>
  <img src="docs/screenshot-dark.png" width="340" alt="The popover in dark mode: one card per account, each with a 5-hour and a 7-day usage ring and a Switch button">
  <img src="docs/screenshot-light.png" width="340" alt="The popover in light mode">
</p>

It is a small UI **on top of** claude-swap, not a fork of it: every account
operation goes through the `cswap` command line tool, and the widget never
reads or writes your credentials itself.

## What it shows

- **Menu bar:** a ring and the 5-hour usage of the active account. The ring
  turns amber at 75 % and red at 90 %. A `?` after the number means the data
  could not be refreshed. A `–` means the 5-hour window has just reset and
  new data has not arrived yet.
- **Popover** (click the menu-bar icon): one card per account with
  - two rings: the 5-hour and the 7-day window, each with the time left until
    it resets;
  - per-model weekly limits and extra-usage spend, when your plan has them;
  - badges: **Active**, **Disabled** (held out of auto-rotation),
    **Token expired**, **Re-login**, **Stale** (only the last good measurement
    is available), and **9m ago** when claude-swap's measurement is several
    minutes old;
  - a **Switch** button, and **Switch to best account** at the bottom, which
    picks the account with the most headroom
    (`cswap switch --strategy best`).
- **Right-click menu:** Refresh Now, Appearance (System / Light / Dark),
  Open at Login, Choose cswap Binary…, Quit.

Press <kbd>Esc</kbd> to close the popover, <kbd>⌘R</kbd> to refresh.

## Requirements

- macOS on Apple Silicon. Other platforms may work but are not tested.
- [claude-swap](https://github.com/realiti4/claude-swap) **0.20 or newer**
  (tested with 0.26.0 and 0.27.0b1), which needs Python 3.12 or newer.
- At least one Claude Code account added to claude-swap.

## Install

### 1. Install claude-swap and add your accounts

```sh
uv tool install claude-swap      # or: pipx install claude-swap
```

Then, for each account: log in to Claude Code with it, and run

```sh
cswap add
```

`cswap list` should now show all of them. See the
[claude-swap README](https://github.com/realiti4/claude-swap) for details.

### 2. Install the widget

Download the `.dmg` from
[Releases](https://github.com/Btvmn/claude-swap-widget/releases), open it and
drag **Claude Swap Widget** to Applications.

The app is not notarized by Apple, so macOS blocks it the first time. To open it:

1. Open the app once. macOS says it cannot be opened. Click **Done**.
2. Open **System Settings → Privacy & Security**, scroll down, and click
   **Open Anyway** next to "Claude Swap Widget was blocked".
3. Confirm with **Open**.

Or remove the quarantine flag in Terminal instead:

```sh
xattr -dr com.apple.quarantine "/Applications/Claude Swap Widget.app"
```

The app has no Dock icon. Look for the ring in the menu bar. To start it with
your Mac, use **Open at Login** in its right-click menu.

## How it works

The widget runs `cswap list --json` every 60 seconds (and when you open the
popover), and `cswap switch … --json` when you click Switch. That is all it
does. claude-swap does the real work: it reads usage, caches it, refreshes
tokens and swaps credentials. It also holds the locks that keep Claude Code
safe while it does.

- The widget itself makes no network requests and stores no credentials.
- Switching never logs you out. Claude Code picks up the new account on its
  next request.
- The widget never cuts claude-swap off in the middle of a switch or a token
  refresh. Its timeouts are only there for a process that hangs.

## Settings and troubleshooting

**"Install claude-swap"**: the widget did not find `cswap`. Apps started from
Finder do not see your shell's `PATH`, so the widget looks in `PATH`,
`~/.local/bin`, `/opt/homebrew/bin` and `/usr/local/bin`. If yours is
elsewhere, use **Choose binary…**. You can also set the `CSWAP_PATH`
environment variable.

**"Update claude-swap"**: run `uv tool upgrade claude-swap` or
`pipx upgrade claude-swap`.

**"No accounts yet"**: add an account with `cswap add` (see above), then
click **Check again**.

**`CLAUDE_CONFIG_DIR`**: if you point Claude Code at a non-default config
directory in your shell profile, an app started from Finder does not see that
variable, so claude-swap uses `~/.claude`. Make the variable visible to GUI
apps as well, then restart the widget:

```sh
launchctl setenv CLAUDE_CONFIG_DIR "$HOME/path/to/your/config"
```

Settings live in
`~/Library/Application Support/Claude Swap Widget/settings.json`:

```json
{
  "cswapPath": null,
  "theme": "system",
  "refreshSeconds": 60
}
```

`refreshSeconds` is clamped to between 30 seconds and one day.

## Development

```sh
npm install
npm test                 # unit tests (node --test)
npm start                # runs against your real cswap
```

To work on the UI without touching your real accounts, use the fake `cswap`
in `test/fixtures`. It speaks the same JSON and keeps its "active account" in
a temp file:

```sh
CSWAP_PATH="$PWD/test/fixtures/fake-cswap" npm start
FAKE_CSWAP_SCENARIO=empty CSWAP_PATH="$PWD/test/fixtures/fake-cswap" npm start
```

Scenarios: `default`, `empty`, `root`, `garbage`, `slow`, `stubborn`,
`schema2`, `old`, `flood`, `crash`, `rolled`. `CSW_THEME=light|dark` forces
the theme. `CSW_CAPTURE=out.png` saves a screenshot of the popover and quits.

Build the `.dmg` (Apple Silicon, ad-hoc signed):

```sh
npm run dist             # → dist/Claude Swap Widget-<version>-arm64.dmg
```

`npm run icon` redraws `build/icon.png`.

## Credits

- [claude-swap](https://github.com/realiti4/claude-swap) by Onur Cetinkol
  (MIT) does all the account work. This widget is only a front end for it.
- The glass-ring look was inspired by
  [TheMaestr-o/claude-usage-widget](https://github.com/TheMaestr-o/claude-usage-widget)
  (MIT). The rings here are drawn from scratch; no code or assets were copied.

Not affiliated with or endorsed by Anthropic. Claude and Claude Code are
trademarks of Anthropic.

## License

[MIT](LICENSE)
