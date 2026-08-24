import { execFile, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RemoteTarget, controlPathFor } from './remote';

/** ssh reports its own failures with 255; anything else is the remote command's status. */
const SSH_OWN_ERROR = 255;

/**
 * Recognises an ssh failure the user could fix by authenticating.
 *
 * The exit code carries most of the weight. A remote command can print "permission
 * denied" for its own reasons — `mkdir` into a read-only directory does — and prompting
 * for a password there would teach the user to enter credentials at unrelated errors.
 * Only ssh itself exits 255.
 */
export function isAuthFailure(stderr: string, exitCode: number): boolean {
  if (exitCode !== SSH_OWN_ERROR) return false;

  const text = stderr.toLowerCase();
  return (
    text.includes('permission denied') ||
    text.includes('too many authentication failures') ||
    text.includes('no supported authentication methods')
  );
}

/**
 * The askpass helper ssh will invoke, written fresh into a private directory.
 *
 * Generated at runtime rather than bundled because a VSIX is a zip and does not reliably
 * carry the executable bit, and `SSH_ASKPASS` must name something ssh can exec.
 *
 * The password reaches it through a FIFO, so the secret exists only in kernel pipe memory
 * — never in a file on disk, and never in any process's environment, where a same-user
 * process could read it out of `/proc/<pid>/environ`.
 */
const ASKPASS_BODY = `#!/bin/sh
# Written by clip2remote. Emits one password from the FIFO named in the environment.
head -n 1 "$CLIP2REMOTE_ASKPASS_FIFO"
`;

interface Workspace {
  dir: string;
  fifo: string;
  helper: string;
}

function mkfifo(fifoPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('mkfifo', ['-m', '600', fifoPath], (err) => (err ? reject(err) : resolve()));
  });
}

/** Private 0700 directory holding the askpass helper and the one-shot password FIFO. */
async function createWorkspace(): Promise<Workspace> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clip2remote-auth-'));
  await fs.promises.chmod(dir, 0o700);

  const helper = path.join(dir, 'askpass.sh');
  await fs.promises.writeFile(helper, ASKPASS_BODY, { mode: 0o700 });

  const fifo = path.join(dir, 'pw.fifo');
  await mkfifo(fifo);

  return { dir, fifo, helper };
}

async function destroyWorkspace(ws: Workspace): Promise<void> {
  await fs.promises.rm(ws.dir, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Puts the password on the FIFO without blocking.
 *
 * A FIFO opened write-only blocks until a reader arrives, which would deadlock when ssh
 * decides not to ask at all. Opening read-write never blocks, so the value simply waits
 * in the pipe buffer for the helper — or is discarded with the directory if it never runs.
 */
async function primeFifo(fifo: string, password: string): Promise<fs.promises.FileHandle> {
  const handle = await fs.promises.open(fifo, fs.constants.O_RDWR);
  await handle.write(`${password}\n`);
  return handle;
}

export interface MasterResult {
  ok: boolean;
  controlPath?: string;
  error?: string;
}

/**
 * Opens a background ssh master authenticated with a password, so later uploads reuse it.
 *
 * This is what makes a password-only host usable at all: uploads run under
 * `BatchMode=yes` and can never prompt, but a multiplexed session never needs to
 * authenticate again. The user types the password once and `ControlPersist` keeps the
 * connection warm for subsequent pastes.
 */
export async function establishMaster(
  target: RemoteTarget,
  password: string,
  persistSeconds: number
): Promise<MasterResult> {
  const controlPath = controlPathFor(target);
  const ws = await createWorkspace();
  let handle: fs.promises.FileHandle | undefined;

  try {
    handle = await primeFifo(ws.fifo, password);

    const args = [
      '-o', 'ControlMaster=yes',
      '-o', `ControlPath=${controlPath}`,
      '-o', `ControlPersist=${persistSeconds}`,
      '-o', 'BatchMode=no',
      // One attempt only: a wrong password must fail fast, not sit on a hidden retry.
      '-o', 'NumberOfPasswordPrompts=1',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-N',
      '-f',
    ];
    if (target.port) args.push('-p', String(target.port));
    args.push(target.host);

    const stderr = await new Promise<{ code: number; stderr: string }>((resolve) => {
      const child = spawn('ssh', args, {
        env: {
          ...process.env,
          SSH_ASKPASS: ws.helper,
          // Without `force`, ssh ignores SSH_ASKPASS whenever a TTY is available.
          SSH_ASKPASS_REQUIRE: 'force',
          CLIP2REMOTE_ASKPASS_FIFO: ws.fifo,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let text = '';
      child.stderr.on('data', (chunk) => (text += chunk.toString()));
      child.on('error', (err) => resolve({ code: 1, stderr: err.message }));
      child.on('close', (code) => resolve({ code: code ?? 1, stderr: text }));
    });

    if (stderr.code !== 0) {
      return { ok: false, error: stderr.stderr.trim() || `ssh exited ${stderr.code}` };
    }
    if (!fs.existsSync(controlPath)) {
      return { ok: false, error: 'ssh reported success but no control socket appeared' };
    }
    return { ok: true, controlPath };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    await handle?.close().catch(() => undefined);
    await destroyWorkspace(ws);
  }
}

/** Whether a master connection is already open for this target. */
export function hasLiveMaster(target: RemoteTarget): boolean {
  return fs.existsSync(controlPathFor(target));
}

/** Closes the master this extension opened, if any. */
export function closeMaster(target: RemoteTarget): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'ssh',
      ['-o', `ControlPath=${controlPathFor(target)}`, '-O', 'exit', target.host],
      () => resolve()
    );
  });
}
