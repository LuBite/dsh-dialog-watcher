# dsh-dialog-watcher

> So DSH knows *"the thing you just ran is stuck behind a Windows dialog"*.

[简体中文](README.md) ｜ **English**

A plugin for DSH (DeepSeek Harness). It continuously enumerates blocking dialogs on the desktop (application error boxes, SmartScreen prompts, installers, credential requests, system task dialogs), determines **which session's command** raised each one, and injects an event notice into that session. The model can then decide for itself and click buttons through the `dialog_action` tool — **without stealing focus or activating the window**.

**Current version: 1.1.2**

---

## The problem it solves

You ask the AI to run a command. The command launches a GUI program, the program throws up an error dialog and hangs — but on the AI's side it just looks like "the command has not returned". It has no idea there is a window on screen waiting for a human click. So it waits, or retries forever.

This plugin turns *"something appeared on screen, it belongs to this session, and here are its buttons"* into a structured event delivered to the right session, so the model can act on its own: continue, cancel, or tell you it needs your hands.

---

## How it works

```
[probe subprocess]  PowerShell + Add-Type(C#) — Win32 EnumWindows + UIA
      │  one JSON line each (window / gone / clickResult)
      ▼
[host plugin]  session command ledger → evidence grading (attributor)
      │       prefers the process's own session marker; interceptor dialogs
      │       read the blocked side instead; everything else uses combined clues
      │       strong evidence injects directly; medium goes through a
      │       two-command/two-dialog re-confirmation with 5 exclusivity rules
      ▼
[injector]  agent.steer( createUserMessage({
      │        source: { kind:'plugin:dialog-watcher', form:'notice', summary } }) )
      ▼
[model]     receives the notice → decides → calls dialog_action
```

**Attribution tries clues in order of decreasing certainty** (no window text, no process-snapshot diffing):

| # | Clue | Notes |
|---|---|---|
| 0 | **Manual binding** | Bind a program to a session in the panel; its dialogs are then always treated as strong evidence (highest priority, overrides automatic judgement) |
| 1 | **The dialog process's own session marker** | Reads `DSH_SESSION_ID` from **the dialog process itself**. DSH injects this variable into every session command and the whole process tree inherits it, so a hit identifies the session's process with certainty — **with no dependence on command text**, which means commands inside `run_code` and multi-level descendants also match |
| 2 | **Session marker of the blocked process** | For interceptor dialogs (firewall / UAC / SmartScreen / AV): the window belongs to the **interceptor**, not to the blocked program, so this instead reads `DSH_SESSION_ID` from the environment of the *blocked* process side. A unique session wins |
| 3 | **SmartScreen "App" field** | That field exactly matches a file name in some session's command. SmartScreen's parent chain is inherently broken, so this is the only reliable path for it |
| 4 | **exe hint** | The dialog process's executable name appears in some session's command text (bare command names like `node` / `powershell` included), with a matching time window |
| 5 | **owner chain** | The process owning the dialog's owner window belongs to a program that some session's command started, **and that command's interval covers the dialog** |
| 6 | **Pure time window** | The dialog falls inside a unique session's command interval (both anchors are tried: **process creation time** and **dialog first-seen time**) |
| 7 | Weak evidence | The session was active within 90 seconds before the dialog appeared (no content evidence; goes to the unattributed pool, never injected) |

> Clue 1 reads only **the dialog process's own** environment block (once per dialog, about 0.06 ms). Clue 2 scans "who carries a session marker" only for interceptor dialogs (up to 64 processes). **Any failure in either returns "unknown" and degrades — it never errors out and never misattributes.** The remaining clues do no cross-process memory reads.

**De-duplication**: only per *window*. A dialog attributed to a session is announced every time; there is no "this program was already reported once, stay quiet" rule.

---

### The system consent card (`system-consent`)

The Windows 11 Security Center consent card (firewall allow, app permissions) is not a standard dialog:

- Its top-level window is an **empty shell**: `Shell_SystemDialogProxy`, size `0x0`, no child windows
- The card that actually shows content, `Shell_SystemDialog`, and the full-screen dim overlay, `Shell_SystemDim`, **cannot be enumerated by `EnumWindows` / `EnumThreadWindows`** (enumerating 666 top-level windows still does not surface them)
- UIA reports its bounds as `Infinity`, its elements are absent from the desktop tree, and **the button labels are completely unreachable**

What the plugin does for these windows:

1. **Detect**: anchor on `Shell_SystemDialogProxy` (added to the class-name whitelist, exempt from the minimum-size filter)
2. **Locate**: grid-sample `WindowFromPoint` to find the card's bounding box, then binary-refine all four edges to ±1 px
3. **Buttons**: GDI-capture the card → take the colour of the **card's left/right margins** as the baseline (those columns are always the button-row background and can never be a button) → anything brighter than the baseline by more than `5` counts as a button → **column-project inside the bottom band (80%–96% of the height)** to find button rectangles
   - A whole-card statistic does not work: the card body and the button row use **two different background colours**, and **which one is brighter depends on the theme** (light: body 255 > button 250; dark: body 43 ≈ button 45). Any global threshold breaks
   - A single-line scan does not work either: if the scan line crosses button text it splits one button into two segments (measured: 2 buttons became 4 segments)
   - Only the bottom band may be searched: the card's bottom stroke and the body area above it both pollute band detection
4. **Click**: `SetCursorPos` + `mouse_event` to send a real mouse click at the button centre; before clicking, `WindowFromPoint` re-checks that the point still belongs to this card

All coordinates are **measured at runtime**; there are no hard-coded pixel values, and the probe calls `SetProcessDPIAware()` on startup, so changing resolution or scaling needs no code change.

> Measured on 3840×2160 @150% (a DPI-unaware process sees a virtualized 2560×1440@96 and every coordinate is off by a factor of 1.5 — that was the real cause of early "clicks miss" reports, unrelated to any overlay intercepting the input).

---

## Installation

### Option 0: install straight from GitHub (recommended)

```bash
dsh plugin --profile <profile> add github:LuBite/dsh-dialog-watcher
```

> **DSH Desktop** users should install from **Settings → Plugins** inside the app. The desktop profile is managed exclusively by the application and cannot be changed from the CLI.

---

### Option 1: mount with the profile (local development)

1. Put this directory into the profile's `node_modules`:

```
~/.dsh/profiles/desktop/node_modules/dsh-dialog-watcher/
```

2. Add the dependency and the bundle to the profile's `package.json`:

```json
{
  "dependencies": { "dsh-dialog-watcher": "link:<absolute path to this directory>" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-dialog-watcher" ] } }
}
```

3. Run `pnpm install` once in the profile directory so pnpm creates the directory link
4. Restart DSH

> **It must be a directory link, not a hand-copied real directory.** A `link:` dependency appears in `node_modules` as a link; if you put a real directory there, the next pnpm install tries to move it away and rebuild, which hits `EPERM` while the directory is in use.

### Option 2: temporary mount (when no bundle declaration is available)

Put this into `~/.dsh/cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-dialog-watcher
      name: 'dsh-dialog-watcher'
```

This package already ships a `dsh.bundle` declaration, so **do not use both paths at once** — that reports a duplicate loader entry id.

---

## Usage

### Panel

The plugin mounts a **global floating panel** in the **`shell.overlay`** slot (it is not rebuilt when sessions switch, and it also shows on the session list page):

```
Dialog watcher   [On]  [Off]
Allow clicking   [On]  [Off]
Dialog log       [View]
Dock             [On]  [Off]
```

| Control | Description |
|---|---|
| **Dialog watcher** | Master switch for the probe. Turning it off exits the probe process, leaving zero background footprint |
| **Allow clicking** | Whether the model may click dialog buttons (the `dialog_action` tool this plugin provides). When off, **detection and notices keep working**; only `dialog_action` returns `click-disabled`, and the notice body says so explicitly so the model does not waste a call. **Turning the probe off also turns this off; turning the probe back on does not restore it** (you must re-enable it) |
| **Dialog log** | Expands the log panel: run status / recent events (level, action, evidence) / unattributed pool (one click to assign to a session) / program→session binding table |
| **Dock** | **On** (default): the panel docks right under the "per-turn switches" plugin group and follows the layout; dragging is disabled. With no fixed plugin group it docks at the top-left of the session content area.<br>**Off**: a drag handle (⠿) appears at the top and the panel can be moved freely; the position persists across restarts |

When the host API is unreachable the switches grey out with an orange notice — **they never fail silently**.

### Model-side tool `dialog_action`

**This is a tool the plugin registers itself** (not a general capability, and it depends on no other plugin). It appears in the session tool table once the plugin loads; with "Allow clicking" off or the probe off, calls return `click-disabled` / `probe-disabled`.

After receiving a notice the model may call it:

| Parameter | Description |
|---|---|
| `window_id` | The window handle given in the notice, e.g. `0x2A15B6` |
| `action` | `invoke` (press a button) \| `close` (send WM_CLOSE) \| `wait` (do nothing) |
| `intent` | `invoke` only: `ok` / `cancel` / `run` / `dontrun` |
| `button_text` | `invoke` only: exact button name (alternate to `intent`, takes precedence) |

**Safety guard**: only windows the probe has reported can be operated on; any other handle returns `unknown-window`. Clicking goes through UIA Invoke, falling back to Win32 `BM_CLICK`; it never moves the mouse and never activates the window.

---

## Configuration

Config file `~/.dsh/dialog-watcher/config.json` (created the first time you change a switch from the panel):

| Key | Default | Meaning |
|---|---|---|
| `probeOn` | `true` | Master probe switch |
| `clickOn` | `true` | Allow clicking |
| `busyMs` / `idleMs` | 1500 / 5000 | Scan interval when a session is running / when everything is idle (ms) |
| `ledgerRetentionMs` | 600000 | How long a finished command stays in the ledger |
| `mediumTimeoutMs` | 600000 | How long medium evidence waits before moving to the unattributed pool |
| `timeWindowBeforeMs` / `timeWindowAfterMs` | 2000 / 10000 | Strong-evidence time window (how far the command interval is extended outward, ms) |
| `weakWindowMs` | 90000 | Threshold for weak "recently active" evidence |
| `throttleWindowMs` / `throttleMax` | 60000 / 3 | Per-session injection throttling |
| `goneNotify` | `true` | Send a "blockage cleared" notice when an announced dialog disappears |
| `debug` | `false` | Also log windows that had no attribution |
| `whitelist` | `[]` | Extra exe names that are never reported (layered on top of the built-in list) |
| `muteUntilMs` | `0` | Temporary mute deadline (memory only, not persisted) |

Changing `busyMs` / `idleMs` restarts the probe immediately; other keys take effect at the next decision.

---

## Event log

Every detection / attribution / injection / click writes one JSON line:

```
~/.dsh/dialog-watcher/events/YYYYMMDD.jsonl
```

| Field | Meaning | Normal value |
|---|---|---|
| `ev` | Event type | `window` / `inject` / `gone` / `api-registered` |
| `decision.action` | Final action | `inject-strong` / `inject-medium` / `pending` / `pool` / `ignore` |
| `decision.level` | Evidence level | `strong` / `medium` / `weak` / `none` |
| `decision.sessionId` | Which session it was attributed to | Should be the session that issued the command |
| `decision.diag` | Diagnostics (medium only) | exe hints hit / covered, explaining "why not strong" |
| `ok` | Whether injection succeeded | `true` |
| `ev:"handler-error"` | Internal exception | **Should always be zero lines** |

---

## Runtime behaviour

- **The probe is a resident subprocess** started by the host (never through a session shell). If it exits unexpectedly it **restarts automatically after 2 seconds**; after 5 consecutive failures it falls back to a slow retry **once every 60 seconds** until it succeeds or the probe is turned off.
- **Adaptive scan interval**: `busyMs` (default 1.5 s) while any session is running, `idleMs` (default 5 s) when everything is idle.
- **The probe works in `%TEMP%\dsh-dialog-watcher\`**, not in the installation directory — so it never locks the install dir while running, and uninstall / upgrade / package-manager dependency shuffling never hits `EPERM`. That directory is normally empty and safe to clean with system temp files; scripts and C# are referenced by absolute path only.
- **Turning the probe off means the probe process exits**, leaving nothing behind; turning it back on starts it again.

---

## Self-test

```powershell
# one-shot self test (really pops a test dialog on the desktop and clicks it away within seconds)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\run-tests.ps1

# state-machine unit tests (no DSH needed, run standalone)
node test\cases.js
```

Covered by the unit tests: direct process session marker, strong-evidence direct injection, basename hit, single medium evidence does not inject, two-command/two-dialog deferred injection, each of the 5 exclusivity rules refusing once, throttle merging, dropping evidence-less candidates, SmartScreen app field, owner chain, gone clearance, ledger intervals and retry chains, exe hint extraction, wording levels, and degradation when the Injector service is missing.

---

## Known limitations

1. **Orphan processes are missed**: a dialog raised more than `ledgerRetentionMs` (default 10 minutes) after its command ended finds the command interval already expired, so it can at best reach medium evidence or the pool. This is a deliberate "rather miss than misattribute" trade-off.
2. **Medium evidence needs a second dialog**: a single medium-evidence dialog is not injected; the same program must raise another dialog in the same session. Pending beyond `mediumTimeoutMs` (default 10 minutes) moves it to the unattributed pool.
3. **Retry-chain recognition is approximate**: DSH does not expose an explicit job↔tool-call link, so the plugin approximates it with "the most recent tool call within 5 seconds". If a retry uses a new callId, that exclusivity rule degrades to not firing (behaviour falls back to the base two-command rule).
4. **A program grabbing the foreground when its dialog appears is its own behaviour**: the plugin neither can nor should prevent that. What the plugin guarantees is that **its own clicks do not steal focus** (three foreground samples are compared around each click).
5. **Only the current interactive desktop is covered**: under multi-user / remote-desktop setups, dialogs in other logon sessions are invisible.
6. **Subagents are not injected**: to avoid pouring noise into temporary sub-agents.
7. **Recognition scope**: Win32 standard dialogs (`#32770`), credential prompts, TaskDialog, UWP shells recognised as SmartScreen, and the Windows Security Center consent card (`Shell_SystemDialog*`). Fully custom-drawn windows outside this scope are not recognised.
8. **The consent card's buttons have no text**: their labels are drawn by XAML and are not exposed to Win32/UIA, so they can only be identified by position — **leftmost is affirmative/allow, rightmost is negative/cancel**. This layout is uniform across Windows language versions, but the plugin cannot verify character by character what you are looking at.
9. **Handling the consent card has persistent consequences**: clicking Allow writes a permanent inbound allow rule for that program, clicking Cancel writes a permanent block rule, and the same path **is only asked once**. The plugin cannot roll this back; changing it later requires editing the firewall settings manually.
10. **Third-party AV custom-drawn interceptor windows may go undetected**: the probe only recognises 6 standard window class names; custom-drawn windows such as Huorong / 360 that fall outside that list are simply missed (**not currently supported**).
11. **Interceptor attribution is only theoretical for third-party AV**: only the Windows firewall prompt (`PickerHost.exe`) has been verified in practice; Huorong and similar go through the same code path (they are in the interceptor signature table) but are **not empirically tested**.
12. **The session marker can be stale**: a process may hold the `DSH_SESSION_ID` of a session that has since been deleted; the plugin uses that id as-is, and if the session no longer exists the injection fails and is recorded in the event log.
13. **Degradation when the session marker is unreadable**: 32-bit target processes, and processes with a higher integrity level (for example a program you started elevated), cannot be read, so the plugin automatically falls back to time-based clues. That is a permission limit, not a miss; `decision.diag` in the log shows which clue was used.

---

## What it does not do

- No hooking (no `SetWindowsHookEx`). Process environment blocks are read for exactly two attribution clues (**only `DSH_SESSION_ID`, and any failure degrades**): the **dialog process itself**, and **processes carrying a session marker during an interceptor dialog**. Nothing else reads or writes process memory
- Never calls `SetForegroundWindow` / `ShowWindow` to grab focus
- Never clicks a window that **the probe has not reported**
- No rule-based clicking: whether and what to click is always the model's judgement; the safety level only changes the suggested wording

---

## Requirements

- Windows (relies on Win32 `EnumWindows` + UIA)
- DSH (DeepSeek Harness) 0.2.x
- The probe uses the built-in PowerShell + .NET Framework (nothing extra to install)
- Reading process environments for attribution works with ordinary user rights for same-user processes; processes with insufficient rights degrade automatically instead of erroring

---

## Related documents

- **Notice content and type reference** (`docs/注入内容与类型对照表.md`) — the full text actually sent to a session for each level/type, the conditions behind each level, and the dialog types that can be detected along with their identifying features (Chinese)

---

## License

MIT
