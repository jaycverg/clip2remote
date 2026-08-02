import { execFile } from 'child_process';
import * as path from 'path';

export type ClipboardContent =
  | { kind: 'files'; paths: string[] }
  | { kind: 'image'; paths: string[] }
  | { kind: 'other'; types: string[] }
  | { kind: 'error'; message: string };

/** Where the JXA reader stages PNGs it materialises from in-memory clipboard images. */
export const STAGING_DIR = '/tmp/clip2remote-staging';

/**
 * Reads the local macOS pasteboard via a bundled JXA script.
 *
 * This runs on the user's own machine — the extension declares `extensionKind: ui`
 * precisely so this can reach the real clipboard even when the window is attached
 * to a remote host over SSH.
 */
export function readClipboard(extensionPath: string): Promise<ClipboardContent> {
  const script = path.join(extensionPath, 'media', 'clipboard-read.js');
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', script, STAGING_DIR],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({ kind: 'error', message: stderr?.trim() || err.message });
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()) as ClipboardContent);
        } catch {
          resolve({ kind: 'error', message: `unparseable reader output: ${stdout.slice(0, 200)}` });
        }
      }
    );
  });
}
