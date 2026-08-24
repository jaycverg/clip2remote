import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import * as path from 'path';

import { ClipboardContent, STAGING_DIR } from './contract';

/**
 * Clipboard flavors that carry file references, in the order they should be trusted.
 *
 * `text/uri-list` is the cross-desktop standard. The `x-special/*` flavors are what
 * GNOME Files actually publishes: both prepend an operation line (`copy` / `cut`) and
 * the older Nautilus form prepends its own mime name too, which is why the parser
 * keys on the `file://` prefix rather than on line position.
 */
const URI_FLAVORS = ['text/uri-list', 'x-special/gnome-copied-files', 'x-special/nautilus-clipboard'];

/**
 * The only image flavor read directly.
 *
 * Every mainstream Linux screenshot tool (GNOME Screenshot, Spectacle, Flameshot) and
 * browser publishes `image/png`, and decoding BMP/TIFF would mean taking on an image
 * dependency for a case that barely occurs. Anything else falls through to a normal paste.
 */
const IMAGE_FLAVOR = 'image/png';

/** Clipboard images are small; the cap exists to bound a runaway read, not to fit real data. */
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export type Flavor =
  | { kind: 'uris'; type: string }
  | { kind: 'image'; type: string }
  | { kind: 'none' };

/**
 * Picks what to read from the advertised clipboard types.
 *
 * File references win over an image: a file manager copying an image file publishes
 * both, and the real file on disk is strictly better than a re-encoded copy of it.
 */
export function selectFlavor(types: string[]): Flavor {
  const available = new Set(types);

  for (const type of URI_FLAVORS) {
    if (available.has(type)) return { kind: 'uris', type };
  }
  if (available.has(IMAGE_FLAVOR)) return { kind: 'image', type: IMAGE_FLAVOR };

  return { kind: 'none' };
}

/**
 * Absolute paths for every local `file://` entry in a uri-list payload.
 *
 * Non-file entries are skipped rather than failing the read: dragging from a browser
 * puts `http(s)` URLs on the same flavor, and the GNOME variants lead with a bare
 * operation word. Entries are percent-encoded per RFC 3986, so trimming each line
 * cannot eat a filename's own leading or trailing whitespace.
 */
export function parseFileUris(payload: string): string[] {
  const paths: string[] = [];

  for (const rawLine of payload.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.startsWith('file://')) continue;

    try {
      const filePath = fileURLToPath(line);
      if (!paths.includes(filePath)) paths.push(filePath);
    } catch {
      /* a file URL on another host has no local path — nothing we can upload */
    }
  }

  return paths;
}

interface ExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  /** Set when the binary itself could not be started, e.g. it is not installed. */
  missing: boolean;
}

function exec(cmd: string, args: string[], maxBuffer: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 5000, maxBuffer, encoding: 'buffer' },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number'
          ? (err as { code: number }).code
          : err ? 1 : 0;
        resolve({
          code,
          stdout: stdout ?? Buffer.alloc(0),
          stderr: stderr?.toString().trim() ?? '',
          missing: (err as NodeJS.ErrnoException | null)?.code === 'ENOENT',
        });
      }
    );
  });
}

interface Backend {
  session: 'wayland' | 'x11';
  tool: string;
  installHint: string;
  listArgs: string[];
  readArgs: (type: string) => string[];
}

const WAYLAND: Backend = {
  session: 'wayland',
  tool: 'wl-paste',
  installHint: 'sudo apt install wl-clipboard',
  listArgs: ['--list-types'],
  readArgs: (type) => ['--no-newline', '--type', type],
};

/**
 * xclip only, deliberately: xsel cannot enumerate or request arbitrary X selection
 * targets, so it can never see a file copy.
 */
const X11: Backend = {
  session: 'x11',
  tool: 'xclip',
  installHint: 'sudo apt install xclip',
  listArgs: ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
  readArgs: (type) => ['-selection', 'clipboard', '-t', type, '-o'],
};

/**
 * The clipboard backend for the current session, or undefined when there is no
 * graphical session to read from.
 *
 * Wayland wins when both are set: a Wayland session almost always exports `DISPLAY`
 * too for XWayland, but the bridged X selection does not reliably carry the file
 * flavors, so preferring it would silently degrade file pastes to text.
 */
export function detectBackend(env: NodeJS.ProcessEnv = process.env): Backend | undefined {
  if (env.WAYLAND_DISPLAY) return WAYLAND;
  if (env.DISPLAY) return X11;
  return undefined;
}

const NO_SESSION_MESSAGE =
  'no graphical session detected (WAYLAND_DISPLAY and DISPLAY are both unset), ' +
  'so the local clipboard cannot be read';

export async function readLinuxClipboard(): Promise<ClipboardContent> {
  const backend = detectBackend();
  if (!backend) return { kind: 'unavailable', message: NO_SESSION_MESSAGE };

  const listed = await exec(backend.tool, backend.listArgs, 1024 * 1024);
  if (listed.missing) {
    return {
      kind: 'unavailable',
      message: `${backend.tool} is not installed, so the ${backend.session} clipboard cannot be read. Install it with: ${backend.installHint}`,
    };
  }

  // A non-zero exit here is the normal "clipboard is empty" report, not a failure.
  const types = listed.code === 0
    ? listed.stdout.toString('utf8').split('\n').map((t) => t.trim()).filter(Boolean)
    : [];

  const flavor = selectFlavor(types);
  if (flavor.kind === 'none') return { kind: 'other', types };

  const payload = await exec(
    backend.tool,
    backend.readArgs(flavor.type),
    flavor.kind === 'image' ? MAX_IMAGE_BYTES : 1024 * 1024
  );
  if (payload.code !== 0) {
    return {
      kind: 'error',
      message: payload.stderr || `${backend.tool} exited ${payload.code} reading ${flavor.type}`,
    };
  }

  if (flavor.kind === 'uris') {
    const paths = parseFileUris(payload.stdout.toString('utf8'));
    // A uri-list holding only remote URLs is not something we can upload; let the
    // normal paste insert whatever text representation the clipboard also carries.
    return paths.length > 0 ? { kind: 'files', paths } : { kind: 'other', types };
  }

  try {
    return { kind: 'image', paths: [stageImage(payload.stdout)] };
  } catch (e) {
    return { kind: 'error', message: `failed to stage clipboard image: ${String(e)}` };
  }
}

/**
 * Writes clipboard PNG bytes to the staging dir under a content-derived name.
 *
 * Naming by digest rather than by a session counter (the macOS reader's `changeCount`)
 * keeps repeat pastes of one screenshot pointing at a single file, since X11 and
 * Wayland expose no equivalent clipboard generation number.
 */
function stageImage(png: Buffer): string {
  const digest = crypto.createHash('sha256').update(png).digest('hex').slice(0, 12);
  const dest = path.join(STAGING_DIR, `clip2remote-pb-${digest}.png`);

  fs.mkdirSync(STAGING_DIR, { recursive: true });
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, png);

  return dest;
}

export function describeLinuxBackend(): string {
  const backend = detectBackend();
  return backend
    ? `${backend.session} clipboard (${backend.tool})`
    : `unavailable — ${NO_SESSION_MESSAGE}`;
}
