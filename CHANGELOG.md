# Changelog

## 0.2.0

- **Linux clients** (beta): the clipboard is read through `wl-paste` on Wayland or `xclip`
  on X11, covering `text/uri-list` plus the GNOME and legacy Nautilus flavors, and PNG
  screenshots. Copy a file in Files or Dolphin and paste it into the terminal exactly as on
  macOS. Unit-tested but not yet exercised against a live Linux desktop — treat it as beta.
- **Password-only hosts now work without any setup.** When ssh rejects the upload for lack
  of credentials, clip2remote asks for the password once and opens a background master
  connection; `ControlPersist` keeps it warm so later pastes reuse it silently. The password
  is never written to disk and never placed in an environment variable — it travels through
  a 0600 FIFO in a 0700 directory, read once by a generated askpass helper, and the whole
  directory is removed immediately. Requires OpenSSH 8.4+ on the client (for
  `SSH_ASKPASS_REQUIRE`). Tunable via `clip2remote.masterPersistSeconds` (default 1 hour).
  Only ssh's own exit code 255 counts as an auth failure, so a remote command printing
  "permission denied" never triggers a prompt.
- **Fix: uploads no longer demand a second authentication on a password-only host.**
  `reuseSshConnection` used to impose its own `ControlPath`, overriding any multiplexing
  the user had configured — so an ssh master already authenticated for the window (the one
  Remote-SSH holds open) was ignored, and the upload tried to open a fresh connection that
  `BatchMode=yes` cannot authenticate. clip2remote now consults `ssh -G <host>` and inherits
  the user's master when there is one. This affects every client platform, not just Linux.
- **Fix: a remote window with no resolvable SSH target no longer inserts client-side
  paths.** Connecting to a host without opening a folder leaves no authority to read, so
  the window looked local and (with `enableInLocalWindows` on) injected the client's own
  paths into a terminal on the remote, where they do not exist. Such a window now reports
  the problem instead. `env.remoteName` decides whether a window is local; the authority
  scan also consults `workspaceFile`, visible editors and open documents. `env.remoteAuthority`
  is deliberately not used: it exists at runtime but is a proposed API, and reading it from a
  published extension raises a user-visible "CANNOT use API proposal" error.
- `Ctrl+Shift+V` also triggers the paste, since that is the conventional terminal paste on Linux.
- A missing `wl-clipboard`/`xclip`, or no graphical session, is reported once per session
  with the install command instead of failing silently on every paste.
- Staged screenshots now live under the OS temp dir rather than a hardcoded `/tmp`.
- Clipboard backends split per platform under `src/services/clipboard/`, dispatched on
  `process.platform`, so adding Windows is a new file and a switch case.
- `npm test` runs the suites from an explicit registry, and fails when a test file in
  `test/` is not registered.

### Tested on

- **macOS client** — macOS 26.5.2 (build 25F84), VS Code 1.131.0, Node 24.11.1. Unit suite
  green, 67/67. Live: a Finder-copied file pasted into a Remote-SSH terminal — uploaded,
  deduplicated on repeat, remote path inserted, terminal injection `OK` — against both a
  Linux and a macOS remote. That live run was recorded against 0.1.x; the paste path is
  unchanged in shape, but the password-auth flow below has not been exercised live.
- **Linux client** (beta) — Ubuntu 24.04.4 LTS, kernel 7.0.0-30, Node 24.11.1, with
  wl-clipboard 2.2.1 and xclip 0.13 present. Unit suite green, 67/67. The clipboard backend
  itself has **not** been run against a live desktop session: no `wl-paste`/`xclip` read of
  a real selection, and no paste from a real file manager. That is what "beta" means here.
- **Remote hosts** — Linux and macOS over SSH. The remote needs only a POSIX shell; the
  platform constraint is on the client.
- **Windows client** — support is planned, but nothing ships in this release: there is no
  Windows clipboard backend yet, so `Ctrl+V` falls through to VS Code's own paste and the
  extension stays out of the way. It is untested for want of a Windows machine to test on,
  and it will not ship until it can be verified on real hardware. Beyond the clipboard
  reader it also needs the scp drive-letter fix (`scp C:\dir\a.zip host:/dest` reads `C:`
  as a hostname) and `reuseSshConnection` forced off, since Win32 OpenSSH has no
  `ControlMaster`. Access to a Windows box, or a tested patch, is welcome.

The unit suite is platform-agnostic — uri-list parsing, shell quoting, control-path
derivation, auth-error classification — so running it on both clients demonstrates
portability, not that a given desktop's clipboard actually reads.

## 0.1.1

- Fix `unix_listener: path ... too long for Unix domain socket` when multiplexing to a target
  whose `user@host:port` is long: the control socket is now a fixed-width hash of the target
  instead of ssh's unbounded `%r@%h:%p`, with a `/tmp` fallback for long temp dirs.

## 0.1.0

- Initial release: paste any clipboard file (zip, video, PDF, ...) into a VS Code terminal.
- Uploads over Remote-SSH via `scp` and inserts the remote path; no size ceiling.
- Multi-file clipboard support, filenames with spaces, and in-memory screenshots (TIFF → PNG).
- Skips re-uploading an unchanged file; optional SSH connection multiplexing.
- Non-file clipboard content falls through to a normal terminal paste.
- Inactive in local (non-SSH) windows unless `clip2remote.enableInLocalWindows` is enabled.
- macOS clients only; other client platforms fall through to a normal paste.
