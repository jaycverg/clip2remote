# Changelog

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
