import * as os from 'os';
import * as path from 'path';

/**
 * What a platform backend reports about the local clipboard.
 *
 * `unavailable` is distinct from `error`: it means the backend could not run at all
 * (no graphical session, missing helper tool) and the user can fix it, so the caller
 * surfaces the message once instead of logging it on every paste.
 */
export type ClipboardContent =
  | { kind: 'files'; paths: string[] }
  | { kind: 'image'; paths: string[] }
  | { kind: 'other'; types: string[] }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string };

/**
 * Where backends stage PNGs materialised from in-memory clipboard images.
 *
 * Rooted at the OS temp dir rather than a literal `/tmp` so the path is valid on
 * every client platform, and so macOS gets its per-user `/var/folders/…` location.
 */
export const STAGING_DIR = path.join(os.tmpdir(), 'clip2remote-staging');
