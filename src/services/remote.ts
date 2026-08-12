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

  if (opts.reuseConnection) {
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
): Promise<{ exists: boolean; error?: string }> {
  const dir = path.posix.dirname(remoteFile);
  const script = `mkdir -p ${shellQuote(dir)} && { [ -f ${shellQuote(remoteFile)} ] && echo EXISTS || echo MISSING; }`;
  const res = await run('ssh', [...sshBaseArgs(opts, false), opts.target.host, script]);

  if (res.code !== 0) return { exists: false, error: res.stderr.trim() || `ssh exited ${res.code}` };
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
