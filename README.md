# Clip2Remote

> **macOS and Linux clients.** The machine running VS Code needs a clipboard backend:
> JXA/AppKit on macOS, `wl-paste` or `xclip` on Linux. On Windows the extension
> deliberately does nothing and `Ctrl+V` behaves as stock VS Code — see
> [Portability](#portability).
>
> The *remote* host can be anything with a POSIX shell; the constraint is on the client.
> macOS is verified live; the Linux backend is unit-tested but **not yet verified on a
> live Linux client** — see [Verified](#verified).

Paste **any file** — zip, video, PDF, anything — from your local clipboard into a VS Code
terminal. When the window is attached to a remote host over SSH, the file is uploaded and
the **remote** path is typed into the terminal, so a terminal agent like Claude Code can
read it immediately.

Copy a `.mov` in Finder (or Files, or Dolphin) → focus the terminal → `Cmd+V`/`Ctrl+V` →
the agent gets
`/tmp/clip2remote/a1b2c3d4e5f6/screen recording.mov`.

## Why this exists

The existing paste extensions are all **image-only**, and they all run *on the remote host*,
reaching your local clipboard through a webview and shipping the bytes back as base64 over the
extension-host RPC channel. That works for a screenshot and falls apart for a 200 MB video —
hence their ~10 MB caps. Worse, `navigator.clipboard.read()` **cannot see file-manager-copied
files at all**: the async clipboard API only exposes text, HTML and image flavors.

Clip2Remote inverts the arrangement. It declares `"extensionKind": ["ui"]`, so the extension
host runs **on your own machine**, where it can read the real clipboard natively and stream
the file with `scp`. No base64, no webview, no size ceiling.

## Scope: SSH windows only, by default

In a **local** (non-SSH) window the extension does nothing at all — `Cmd+V`/`Ctrl+V` returns
immediately to VS Code's own paste before the clipboard is even probed, so there is no
added latency and no behaviour change. It activates only when the window is attached to an
SSH host, which is the case it exists for.

Set `clip2remote.enableInLocalWindows` to `true` if you also want Finder-copied files to
insert their local path in local windows (no upload involved).

## How it works

1. `Cmd+V` (or `Ctrl+V` / `Ctrl+Shift+V` on Linux) in an SSH window's terminal invokes
   `clip2remote.paste`.
2. The backend for the client platform reads the local clipboard — a bundled JXA script on
   macOS (~60 ms), `wl-paste` or `xclip` on Linux — and reports one of:
   - **files** — one or more file-manager-copied paths, any type;
   - **image** — an in-memory screenshot, materialised as PNG;
   - **other** — text or anything else, in which case the keystroke is handed straight
     back to VS Code and behaves as a completely normal paste;
   - **unavailable** — no backend could run at all (missing `wl-clipboard`/`xclip`, or no
     graphical session). Reported once per session with the command that fixes it; the
     paste falls through as normal.
3. The SSH target is derived from the window's remote authority (`ssh-remote+devbox`),
   including the hex-encoded-JSON form Remote-SSH uses for richer connection configs.
4. One `ssh` round trip creates the destination directory and checks whether the file is
   already there; an unchanged file is **never re-uploaded**.
5. `scp` streams the file, and the remote path is typed into the terminal.

If step 4 is rejected for lack of credentials, clip2remote asks for the password once,
opens a background master connection and retries — see [Requirements](#requirements).

Files land at `<remoteDir>/<fingerprint>/<original filename>` — the per-fingerprint directory
means `report.zip` keeps its real name for the agent to read while distinct files can never
collide. The fingerprint is `size:mtime:name`, not a content hash, so pasting a large video
does not spend seconds hashing it.

### Design notes

- **Terminal injection uses `workbench.action.terminal.sendSequence`**, not the
  `Terminal.sendText` API. The extension runs locally while the terminal lives on the remote
  host; `sendSequence` is a core command handled renderer-side and is indifferent to which
  extension host issued it. A clipboard + `terminal.paste` fallback covers the case where it
  is unavailable. (Measured on a live Remote-SSH window, `window.activeTerminal` *is* visible
  to the local host — but the API contract does not promise that, and the core command is
  free.)
- **Screenshots are converted TIFF → PNG when needed.** An image on the macOS pasteboard
  frequently carries *only* `public.tiff`, so relying on AppleScript's `«class PNGf»`
  coercion is not sufficient. On Linux only `image/png` is read directly — every mainstream
  screenshot tool publishes it, so decoding other formats would mean an image dependency for
  a case that barely occurs.
- **File references beat an image of the same thing.** A file manager copying an image file
  publishes both flavors; the real file on disk is strictly better than a re-encoded copy.
- **A password never touches disk or the environment.** It travels through a 0600 FIFO in a
  0700 directory, read once by a generated askpass helper (generated, not bundled — a VSIX
  is a zip and does not reliably carry the executable bit), and the directory is removed
  immediately. Nothing lands in `/proc/<pid>/environ` for a same-user process to read.
- **Only ssh's own exit code 255 counts as an auth failure.** A remote command can print
  "permission denied" for its own reasons — `mkdir` into a read-only directory does — and
  prompting there would teach the user to enter credentials at unrelated errors.
- **The control socket is a hash of the target**, not ssh's `%r@%h:%p`: a long
  `user@host:port` overruns the 104-byte `sun_path` limit on a Unix domain socket.
- **Only regular files are intercepted.** Directories and stale paths fall through to a
  normal paste.

## Commands

| Command | Purpose |
| --- | --- |
| `Clip2Remote: Paste Clipboard File into Terminal` | Bound to `Cmd+V` (macOS) and `Ctrl+V` / `Ctrl+Shift+V` (Linux) when the terminal has focus |
| `Clip2Remote: Diagnose Environment` | Reports client platform, clipboard backend, resolved SSH target, clipboard state, and whether terminal injection works |
| `Clip2Remote: Clean Up Uploaded Files` | Removes uploaded files older than `ttlSeconds` |

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `clip2remote.remoteDir` | `/tmp/clip2remote` | Upload destination on the remote host |
| `clip2remote.host` | `""` | Override the SSH host instead of deriving it from the window |
| `clip2remote.warnAboveBytes` | `104857600` | Confirm before uploading anything larger (0 disables) |
| `clip2remote.ttlSeconds` | `86400` | Age at which cleanup removes uploads (0 = remove all) |
| `clip2remote.reuseSshConnection` | `true` | Multiplex over a shared control connection — measured 397 ms → 38 ms per round trip |
| `clip2remote.masterPersistSeconds` | `3600` | How long a password-authenticated master stays open before ssh closes it on idle |
| `clip2remote.trailingSpace` | `true` | Append a space so you can keep typing your prompt |
| `clip2remote.enableInLocalWindows` | `false` | Also intercept paste in local windows (inserts the local path, no upload) |

## Requirements

- **macOS or Linux on the VS Code client.** On macOS the pasteboard reader is JXA/AppKit and
  needs nothing installed. On Linux it shells out to `wl-paste` (Wayland, from
  `wl-clipboard`) or `xclip` (X11) — whichever matches the session; if the tool is missing
  the extension says so once and leaves paste alone. On Windows `paste()` returns to
  VS Code's own paste immediately.
- **SSH auth: keys, an existing master, or a one-time password prompt.** Uploads run with
  `BatchMode=yes` and never prompt mid-paste. Keys just work. Failing that, clip2remote asks
  for the password once and opens a background master connection that later pastes reuse —
  no configuration needed. That path needs **OpenSSH 8.4+ on the client**, for
  `SSH_ASKPASS_REQUIRE`. To skip even the first prompt, give the host its own multiplexing
  so the connection Remote-SSH already opened becomes the master:

  ```
  ControlMaster auto
  ControlPath ~/.ssh/sockets/%r@%h-%p
  ControlPersist 600
  ```

  The connection Remote-SSH opens for the window then becomes the master — you authenticate
  once, when the window opens, and the upload reuses it. clip2remote detects a ControlPath
  you configured (via `ssh -G`) and will not override it. `clip2remote.masterPersistSeconds`
  sets how long a master clip2remote opened itself stays warm.
- `ssh` and `scp` on the client's `PATH`.
- A local (non-remote) window is untouched unless `enableInLocalWindows` is turned on.

### Verified

| | |
| --- | --- |
| Client — macOS | macOS 26.5.2 (build 25F84), VS Code 1.131.0, Node 24.11.1. Unit suite 67/67 |
| Client — Linux | Ubuntu 24.04.4 LTS, kernel 7.0.0-30, Node 24.11.1, wl-clipboard 2.2.1 and xclip 0.13 present. Unit suite 67/67; **no live clipboard read** |
| Remote | Linux **and** macOS hosts over SSH — the remote needs only a POSIX shell |
| Covered | multi-file clipboard, filenames containing spaces, in-memory screenshots (TIFF → PNG), upload integrity (MD5 match), repeat-paste deduplication, cleanup, uri-list parsing, shell quoting, control-path derivation, auth-error classification |
| Live | `Cmd+V` of a Finder-copied file in a Remote-SSH window: uploaded, deduplicated on repeat, path inserted. Extension host confirmed local (`platform: darwin`), authority resolved from the real window, and terminal injection reported `OK` on both remotes |

Source: `npm test` — the registry plus the three suites, 67 tests. The macOS figure is from a
run on 2026-08-24; the Linux figure is the 0.2.0 release run on the Ubuntu client. The Live
row was recorded on a macOS client against 0.1.x: the paste path is unchanged in shape since,
but **the password-auth flow has not been exercised live.**

**Linux clients are implemented but not yet verified live.** The uri-list parsing, flavor
selection and session detection are covered by `test/clipboard.test.js`; what has *not* been
exercised is a real `wl-paste`/`xclip` against a real desktop clipboard, in a real Remote-SSH
window. Treat the Linux path as beta until that line appears in this table. The unit suite is
platform-agnostic, so running it on both clients demonstrates portability — not that a given
desktop's clipboard actually reads.

**Windows clients are unimplemented.** Beyond the clipboard reader it also needs the scp
drive-letter fix (`scp C:\dir\a.zip host:/dest` reads `C:` as a hostname) and
`reuseSshConnection` forced off, since Win32 OpenSSH has no `ControlMaster`. Support is
planned but will not ship until it can be verified on real hardware — access to a Windows
box, or a tested patch, is welcome.

## Portability

`remote.ts` shells out to `ssh`/`scp` and `terminal.ts` uses a core VS Code command, so the
only platform-specific part is reading the clipboard. Each backend lives in
`src/services/clipboard/` and answers with the same `ClipboardContent` shape:

```ts
{ kind: 'files',       paths: string[] }    // file manager copy, any file type
{ kind: 'image',       paths: [string] }    // in-memory screenshot, staged as PNG
{ kind: 'other',       types: string[] }    // text or anything else — normal paste
{ kind: 'unavailable', message: string }    // no backend here; the user can fix it
{ kind: 'error',       message: string }
```

`index.ts` dispatches on `process.platform`. Adding Windows means adding `windows.ts` (a
PowerShell script over `System.Windows.Forms.Clipboard`, or a bundled native helper if the
PowerShell cold start proves too slow) and a case in the switch.

`unavailable` exists for the Linux case specifically: a missing `wl-clipboard`/`xclip` is
something the user can install, so it is reported once with the install command rather than
logged silently on every paste.

## Development

```sh
npm install
npm run compile
npm test                 # compiles, then runs the registered suites
npm run package          # produces clip2remote-<version>.vsix
```

## Credit

Descended from a `clip2remote` zsh script that did the same job for iTerm, and informed by
the webview approach in [claude-paste](https://github.com/humanrace-ai/claude-paste) (MIT).

## License

MIT
