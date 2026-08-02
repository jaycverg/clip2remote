# Clip2Remote

> **macOS clients only, for now.** The clipboard reader is JXA/AppKit, so the machine
> running VS Code must be a Mac. On any other client platform the extension deliberately
> does nothing and `Cmd+V`/`Ctrl+V` behaves as stock VS Code. Windows and Linux clients
> would each need their own clipboard reader — see [Portability](#portability).
>
> Verified on macOS 26.5.2 against a Linux host over Remote-SSH. The *remote* host can be
> anything with a POSIX shell; it is only the client that must be a Mac.

Paste **any file** — zip, video, PDF, anything — from your Mac clipboard into a VS Code
terminal. When the window is attached to a remote host over SSH, the file is uploaded and
the **remote** path is typed into the terminal, so a terminal agent like Claude Code can
read it immediately.

Copy a `.mov` in Finder → focus the terminal → `Cmd+V` → the agent gets
`/tmp/clip2remote/a1b2c3d4e5f6/screen recording.mov`.

## Why this exists

The existing paste extensions are all **image-only**, and they all run *on the remote host*,
reaching your Mac clipboard through a webview and shipping the bytes back as base64 over the
extension-host RPC channel. That works for a screenshot and falls apart for a 200 MB video —
hence their ~10 MB caps. Worse, `navigator.clipboard.read()` **cannot see Finder-copied files
at all**: the async clipboard API only exposes text, HTML and image flavors.

Clip2Remote inverts the arrangement. It declares `"extensionKind": ["ui"]`, so the extension
host runs **on your Mac**, where it can read the real pasteboard natively and stream the file
with `scp`. No base64, no webview, no size ceiling.

## Scope: SSH windows only, by default

In a **local** (non-SSH) window the extension does nothing at all — `Cmd+V` returns
immediately to VS Code's own paste before the clipboard is even probed, so there is no
added latency and no behaviour change. It activates only when the window is attached to an
SSH host, which is the case it exists for.

Set `clip2remote.enableInLocalWindows` to `true` if you also want Finder-copied files to
insert their local path in local windows (no upload involved).

## How it works

1. `Cmd+V` in an SSH window's terminal invokes `clip2remote.paste`.
2. A bundled JXA script reads the local pasteboard (~60 ms) and reports one of:
   - **files** — one or more Finder-copied paths, any type;
   - **image** — an in-memory screenshot, materialised as PNG;
   - **other** — text or anything else, in which case the keystroke is handed straight
     back to VS Code and behaves as a completely normal paste.
3. The SSH target is derived from the window's remote authority (`ssh-remote+devbox`),
   including the hex-encoded-JSON form Remote-SSH uses for richer connection configs.
4. One `ssh` round trip creates the destination directory and checks whether the file is
   already there; an unchanged file is **never re-uploaded**.
5. `scp` streams the file, and the remote path is typed into the terminal.

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
  coercion is not sufficient.
- **Only regular files are intercepted.** Directories and stale paths fall through to a
  normal paste.

## Commands

| Command | Purpose |
| --- | --- |
| `Clip2Remote: Paste Clipboard File into Terminal` | Bound to `Cmd+V` when the terminal has focus |
| `Clip2Remote: Diagnose Environment` | Reports host platform, resolved SSH target, clipboard state, and whether terminal injection works |
| `Clip2Remote: Clean Up Uploaded Files` | Removes uploaded files older than `ttlSeconds` |

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `clip2remote.remoteDir` | `/tmp/clip2remote` | Upload destination on the remote host |
| `clip2remote.host` | `""` | Override the SSH host instead of deriving it from the window |
| `clip2remote.warnAboveBytes` | `104857600` | Confirm before uploading anything larger (0 disables) |
| `clip2remote.ttlSeconds` | `86400` | Age at which cleanup removes uploads (0 = remove all) |
| `clip2remote.reuseSshConnection` | `true` | Multiplex over a shared control connection — measured 397 ms → 38 ms per round trip |
| `clip2remote.trailingSpace` | `true` | Append a space so you can keep typing your prompt |
| `clip2remote.enableInLocalWindows` | `false` | Also intercept paste in local windows (inserts the local path, no upload) |

## Requirements

- **macOS on the VS Code client.** The pasteboard reader is JXA/AppKit. On a non-Mac client
  `paste()` returns to VS Code's own paste immediately.
- Key-based SSH: uploads run with `BatchMode=yes` and will not prompt for a password.
- `ssh` and `scp` on the client's `PATH`.
- A local (non-remote) window is untouched unless `enableInLocalWindows` is turned on.

### Verified

| | |
| --- | --- |
| Client | macOS 26.5.2, VS Code with Remote-SSH |
| Remote | Linux **and** macOS hosts over SSH |
| Covered | multi-file clipboard, filenames containing spaces, in-memory screenshots (TIFF → PNG), upload integrity (MD5 match), repeat-paste deduplication, cleanup |
| Live | `Cmd+V` of a Finder-copied file in a Remote-SSH window: uploaded, deduplicated on repeat, path inserted. Extension host confirmed local (`platform: darwin`), authority resolved from the real window, and terminal injection reported `OK` on both remotes |

Windows and Linux clients are **untested and unimplemented** — not merely unverified.

## Portability

Everything except one file is platform-agnostic: `remote.ts` shells out to `ssh`/`scp`, and
`terminal.ts` uses a core VS Code command. Supporting another client platform means writing
a replacement for `media/clipboard-read.js` that emits the same JSON contract:

```json
{ "kind": "files", "paths": ["/abs/path/one", "/abs/path/two"] }
{ "kind": "image", "paths": ["/abs/path/staged.png"] }
{ "kind": "other", "types": ["public.utf8-plain-text"] }
{ "kind": "error", "message": "..." }
```

and dispatching to it by `process.platform` in `services/clipboard.ts`. On Windows that
would be PowerShell (`Get-Clipboard -Format FileDropList`); on Linux, `wl-paste`/`xclip`.

## Development

```sh
npm install
npm run compile
node --test test/remote.test.js
npm run package          # produces clip2remote-<version>.vsix
```

## Credit

Descended from a `clip2remote` zsh script that did the same job for iTerm, and informed by
the webview approach in [claude-paste](https://github.com/humanrace-ai/claude-paste) (MIT).

## License

MIT
