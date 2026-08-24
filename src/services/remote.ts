import { execFile, ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RemoteTarget {
  /** Host as ssh/scp understand it — an ssh_config alias or user@hostname. */
  host: string;
  port?: number;
}

/**
 * Derives the ssh target from the window's remote authority.
 *
 * Remote-SSH writes the authority either as a plain alias (`ssh-remote+devbox`)
 * or, when the connection carries a full config object, as hex-encoded JSON
 * (`ssh-remote+7b22686f73744e616d65...`). Both shapes are handled; anything else
 * (containers, WSL, codespaces, or a local window) yields undefined.
 */
export function resolveRemoteTarget(authority: string | undefined): RemoteTarget | undefined {
  if (!authority || !authority.startsWith('ssh-remote+')) return undefined;

  const raw = authority.slice('ssh-remote+'.length);
  if (!raw) return undefined;

  if (/^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0 && raw.length > 16) {
    try {
      const decoded = JSON.parse(Buffer.from(raw, 'hex').toString('utf8'));
      const host = decoded.hostName ?? decoded.host;
      if (typeof host === 'string' && host) {
        return {
          host: decoded.user ? `${decoded.user}@${host}` : host,
          port: typeof decoded.port === 'number' ? decoded.port : undefined,
        };
      }
    } catch {
      /* not hex-encoded JSON after all — fall through to the literal form */
    }
  }

  return { host: raw };
}

/**
 * What a paste should do in the current window.
 *
 * `unresolvedRemote` is the case that matters: the window is attached to a remote, but
 * no ssh target could be derived from it. Falling back to the local-window behaviour
 * there would inject client-side paths into a terminal running on another machine —
 * paths that silently do not exist. It is reported instead.
 */
export type PasteMode =
  | { kind: 'upload'; target: RemoteTarget }
  | { kind: 'local' }
  | { kind: 'passthrough' }
  | { kind: 'unresolvedRemote'; remoteName: string };

/**
 * Decides how a paste should behave, given what the window reports about itself.
 *
 * `remoteName` is the authority on whether the window is local: it is public API and is
 * set for every remote window, whereas the authority string has to be scavenged off a
 * URI and is absent in a remote window with no folder or editor open.
 */
export function resolvePasteMode(opts: {
  remoteName: string | undefined;
  target: RemoteTarget | undefined;
  enableInLocalWindows: boolean;
}): PasteMode {
  if (opts.target) return { kind: 'upload', target: opts.target };
  if (opts.remoteName !== undefined) {
    return { kind: 'unresolvedRemote', remoteName: opts.remoteName };
  }
  return opts.enableInLocalWindows ? { kind: 'local' } : { kind: 'passthrough' };
}

/**
 * Short, stable id for a local file.
 *
 * Deliberately fingerprints metadata rather than contents: hashing a multi-hundred-MB
 * screen recording on every paste would cost seconds, and size+mtime+name is enough
 * to make repeat pastes of an unchanged file resolve to the same remote path.
 */
export function fingerprint(filePath: string): string {
  const stat = fs.statSync(filePath);
  return crypto
    .createHash('sha256')
    .update(`${stat.size}:${stat.mtimeMs}:${path.basename(filePath)}`)
    .digest('hex')
    .slice(0, 12);
}

/**
 * Remote destination for a local file: a per-fingerprint directory holding the file
 * under its original name, so `report.zip` stays `report.zip` for the agent to read
 * while distinct files can never collide.
 */
export function remotePathFor(filePath: string, remoteDir: string): string {
  return `${remoteDir.replace(/\/+$/, '')}/${fingerprint(filePath)}/${path.basename(filePath)}`;
}

export interface SshOptions {
  target: RemoteTarget;
  reuseConnection: boolean;
  /**
   * True when the user's own ssh_config already multiplexes this host, in which case
   * we must not impose our own ControlPath — see {@link hasOwnMultiplexing}.
   */
  inheritMultiplexing?: boolean;
}

/**
 * Whether `ssh -G <host>` reports multiplexing the user configured themselves.
 *
 * This matters beyond speed. When a master connection already exists — Remote-SSH holds
 * one open for the window — riding it needs no authentication at all, which is the only
 * way uploads can work against a host reachable solely by password: `BatchMode=yes`
 * forbids prompting, but a multiplexed session never has to.
 */
export function hasOwnMultiplexing(sshConfigOutput: string): boolean {
  const values = new Map<string, string>();
  for (const line of sshConfigOutput.split('\n')) {
    const [key, ...rest] = line.trim().split(/\s+/);
    if (key) values.set(key.toLowerCase(), rest.join(' '));
  }

  const controlPath = values.get('controlpath');
  const controlMaster = values.get('controlmaster');

  if (!controlPath || controlPath.toLowerCase() === 'none') return false;
  // `no`/`false` means ssh will use an existing master but never start one — still reuse.
  return controlMaster !== undefined && controlMaster.toLowerCase() !== 'false';
}

/**
 * Asks ssh what config it would apply to a host. Makes no connection, so it is cheap
 * enough to consult before each upload.
 */
export async function detectOwnMultiplexing(host: string): Promise<boolean> {
  const res = await run('ssh', ['-G', host]);
  return res.code === 0 ? hasOwnMultiplexing(res.stdout) : false;
}

/** macOS caps sockaddr_un.sun_path at 104 bytes (103 usable chars); Linux allows 107. */
const MAX_SOCKET_PATH = 103;

/**
 * ssh binds `<ControlPath>.XXXXXXXXXXXXXXXX` while the master starts up and renames it
 * afterwards, so the budget is 17 chars tighter than the socket path itself.
 */
const SSH_TEMP_SUFFIX = 17;

/**
 * Control-socket path for a target.
 *
 * ssh's own `%r@%h:%p` tokens expand to an unbounded length, and macOS roots TMPDIR at a
 * ~48-char `/var/folders/…` path, so a merely ordinary `user@host:port` overruns sun_path
 * and ssh refuses to connect at all. A fixed-width hash of the target keeps every path the
 * same size, falling back to `/tmp` if the temp dir is long enough to blow the budget anyway.
 */
export function controlPathFor(target: RemoteTarget, tmpDir: string = os.tmpdir()): string {
  const id = crypto
    .createHash('sha256')
    .update(`${target.host}:${target.port ?? ''}`)
    .digest('hex')
    .slice(0, 12);

  const name = `c2r-${id}`;
  const preferred = path.join(tmpDir, name);
  return preferred.length + SSH_TEMP_SUFFIX <= MAX_SOCKET_PATH ? preferred : path.join('/tmp', name);
}

/** ssh/scp flags shared by every invocation, including optional connection multiplexing. */
export function sshBaseArgs(opts: SshOptions, forScp: boolean): string[] {
  const args: string[] = ['-o', 'BatchMode=yes'];

  if (opts.target.port) args.push(forScp ? '-P' : '-p', String(opts.target.port));

  // Never override a ControlPath the user configured: their master may already be
  // authenticated, and replacing it would force a fresh login we cannot perform.
  if (opts.reuseConnection && !opts.inheritMultiplexing) {
    const controlPath = controlPathFor(opts.target);
    args.push(
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${controlPath}`,
      '-o', 'ControlPersist=120'
    );
  }

  return args;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], onSpawn?: (child: ChildProcess) => void): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const exitCode = err && typeof (err as { code?: unknown }).code === 'number'
        ? ((err as { code: number }).code)
        : err ? 1 : 0;
      resolve({
        code: exitCode,
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
      });
    });
    onSpawn?.(child);
  });
}

/**
 * Ensures the destination directory exists remotely and reports whether the file
 * is already there — one round trip, so an unchanged file skips the upload entirely.
 */
export async function prepareDestination(
  opts: SshOptions,
  remoteFile: string
): Promise<{ exists: boolean; error?: string; code?: number }> {
  const dir = path.posix.dirname(remoteFile);
  const script = `mkdir -p ${shellQuote(dir)} && { [ -f ${shellQuote(remoteFile)} ] && echo EXISTS || echo MISSING; }`;
  const res = await run('ssh', [...sshBaseArgs(opts, false), opts.target.host, script]);

  if (res.code !== 0) {
    return { exists: false, code: res.code, error: res.stderr.trim() || `ssh exited ${res.code}` };
  }
  return { exists: res.stdout.trim().endsWith('EXISTS') };
}

export async function upload(
  opts: SshOptions,
  localFile: string,
  remoteFile: string,
  onSpawn?: (child: ChildProcess) => void
): Promise<{ ok: boolean; error?: string }> {
  const res = await run(
    'scp',
    [...sshBaseArgs(opts, true), '-q', localFile, `${opts.target.host}:${remoteFile}`],
    onSpawn
  );

  if (res.code !== 0) return { ok: false, error: res.stderr.trim() || `scp exited ${res.code}` };
  return { ok: true };
}

/** Deletes uploaded files older than `ttlSeconds`, returning how many were removed. */
export async function pruneRemote(
  opts: SshOptions,
  remoteDir: string,
  ttlSeconds: number
): Promise<{ removed: number; error?: string }> {
  const dir = shellQuote(remoteDir.replace(/\/+$/, ''));
  // A non-positive TTL means "remove everything"; anything else filters by age.
  const ageFilter = ttlSeconds > 0 ? ` -mmin +${Math.floor(ttlSeconds / 60)}` : '';
  const select = `find ${dir} -mindepth 1 -maxdepth 1 -type d${ageFilter}`;
  const script =
    `[ -d ${dir} ] || { echo 0; exit 0; }; ` +
    `n=$(${select} | wc -l); ${select} -exec rm -rf {} +; echo $n`;

  const res = await run('ssh', [...sshBaseArgs(opts, false), opts.target.host, script]);
  if (res.code !== 0) return { removed: 0, error: res.stderr.trim() || `ssh exited ${res.code}` };
  return { removed: parseInt(res.stdout.trim(), 10) || 0 };
}
