import { ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  readClipboard,
  describeBackend,
  isSupportedPlatform,
  ClipboardContent,
  STAGING_DIR,
} from './services/clipboard';
import {
  RemoteTarget,
  SshOptions,
  detectOwnMultiplexing,
  prepareDestination,
  pruneRemote,
  remotePathFor,
  resolvePasteMode,
  resolveRemoteTarget,
  shellQuote,
  upload,
} from './services/remote';
import { establishMaster, hasLiveMaster, isAuthFailure } from './services/ssh-auth';
import { insertIntoTerminal, passThroughPaste } from './services/terminal';

let output: vscode.OutputChannel;

/** Guards the one-shot notice for an unreadable clipboard; see {@link warnUnavailableOnce}. */
let unavailableWarned = false;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Clip2Remote');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.commands.registerCommand('clip2remote.paste', () => paste(context)),
    vscode.commands.registerCommand('clip2remote.diagnose', () => diagnose(context)),
    vscode.commands.registerCommand('clip2remote.cleanRemote', cleanRemote)
  );

  pruneStagingDir();
}

export function deactivate(): void {
  /* nothing to tear down — ssh control sockets expire on their own */
}

function config() {
  const c = vscode.workspace.getConfiguration('clip2remote');
  return {
    remoteDir: c.get<string>('remoteDir', '/tmp/clip2remote'),
    host: c.get<string>('host', '').trim(),
    warnAboveBytes: c.get<number>('warnAboveBytes', 104857600),
    ttlSeconds: c.get<number>('ttlSeconds', 86400),
    reuseConnection: c.get<boolean>('reuseSshConnection', true),
    trailingSpace: c.get<boolean>('trailingSpace', true),
    enableInLocalWindows: c.get<boolean>('enableInLocalWindows', false),
    masterPersistSeconds: c.get<number>('masterPersistSeconds', 3600),
  };
}

/**
 * The remote authority backing this window, e.g. `ssh-remote+devbox`.
 *
 * `vscode.env.remoteAuthority` is not public API, so the authority is taken off a
 * `vscode-remote://` URI belonging to the window — the workspace folder normally,
 * or the active editor when the window has no folder open.
 */
function currentAuthority(): string | undefined {
  // Deliberately NOT `env.remoteAuthority`: it exists at runtime but is a *proposed*
  // API, and touching it from a published extension raises a user-visible
  // "CANNOT use API proposal" error rather than returning undefined.
  const candidates = [
    ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri),
    vscode.workspace.workspaceFile,
    vscode.window.activeTextEditor?.document.uri,
    ...vscode.window.visibleTextEditors.map((e) => e.document.uri),
    ...vscode.workspace.textDocuments.map((d) => d.uri),
  ];

  for (const uri of candidates) {
    if (uri?.scheme === 'vscode-remote' && uri.authority) return uri.authority;
  }
  return undefined;
}

/** The ssh target for this window, honouring an explicit `clip2remote.host` override. */
function target(): RemoteTarget | undefined {
  const override = config().host;
  if (override) return { host: override };
  return resolveRemoteTarget(currentAuthority());
}

/**
 * Main entry point, bound to the terminal's paste keystroke.
 *
 * Anything that is not a file or an image on the clipboard is handed straight back
 * to VS Code, so ordinary text pasting is never intercepted or slowed down beyond
 * the clipboard probe (~60 ms on macOS, ~10 ms on Linux).
 */
async function paste(context: vscode.ExtensionContext): Promise<void> {
  if (!isSupportedPlatform()) {
    await passThroughPaste();
    return;
  }

  // Decide before touching the clipboard, so a window we do not act in carries zero
  // overhead and the paste keystroke behaves exactly as stock VS Code.
  const mode = resolvePasteMode({
    remoteName: vscode.env.remoteName,
    target: target(),
    enableInLocalWindows: config().enableInLocalWindows,
  });

  if (mode.kind === 'passthrough') {
    await passThroughPaste();
    return;
  }
  if (mode.kind === 'unresolvedRemote') {
    // Never insert client-side paths into a terminal on another machine: they would
    // point at files the remote cannot see. Opening a folder gives us the authority.
    fail(
      `this window is attached to "${mode.remoteName}" but no SSH target could be resolved ` +
      `from it — open a folder on the remote, or set "clip2remote.host".`
    );
    await passThroughPaste();
    return;
  }

  const remote = mode.kind === 'upload' ? mode.target : undefined;

  const clip = await readClipboard(context.extensionPath);

  if (clip.kind === 'unavailable') {
    // Actionable and unchanging for the session — surface it once, then stay quiet
    // so an unfixed environment does not nag on every keystroke.
    output.appendLine(`clipboard unavailable: ${clip.message}`);
    warnUnavailableOnce(clip.message);
    await passThroughPaste();
    return;
  }
  if (clip.kind === 'error') {
    output.appendLine(`clipboard read failed: ${clip.message}`);
    await passThroughPaste();
    return;
  }
  if (clip.kind === 'other') {
    await passThroughPaste();
    return;
  }

  const localPaths = clip.paths.filter((p) => isRegularFile(p));
  if (localPaths.length === 0) {
    // Directories and vanished paths are not something an agent can read; let the
    // normal paste put whatever text representation the clipboard has instead.
    await passThroughPaste();
    return;
  }

  const finalPaths = remote
    ? await uploadAll(localPaths, remote, clip)
    : localPaths; // local window (opt-in): the path is already reachable

  if (finalPaths.length === 0) return;

  const cfg = config();
  const text = finalPaths.map(quoteIfNeeded).join(' ') + (cfg.trailingSpace ? ' ' : '');
  if (!(await insertIntoTerminal(text))) {
    vscode.window.showErrorMessage('Clip2Remote: could not write into the terminal.');
  }
}

/**
 * Prompts for a password and opens a reusable master connection.
 *
 * Returns whether a master is now available. Declining is a normal outcome, not an error:
 * the upload then fails with the original ssh message, which says what is wrong.
 */
async function authenticate(remote: RemoteTarget, persistSeconds: number): Promise<boolean> {
  if (hasLiveMaster(remote)) return true;

  const password = await vscode.window.showInputBox({
    password: true,
    ignoreFocusOut: true,
    title: `Clip2Remote: authenticate to ${remote.host}`,
    prompt:
      `${remote.host} accepts no key, so the upload cannot authenticate on its own. ` +
      `The connection is kept open for ${Math.round(persistSeconds / 60)} min, so later pastes will not ask again.`,
  });
  if (!password) return false;

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Clip2Remote: connecting to ${remote.host}` },
    () => establishMaster(remote, password, persistSeconds)
  );

  if (!result.ok) {
    fail(`could not authenticate to ${remote.host}: ${result.error}`);
    return false;
  }
  output.appendLine(`opened master connection to ${remote.host}`);
  return true;
}

/** Uploads every clipboard file, returning the remote paths that landed successfully. */
async function uploadAll(
  localPaths: string[],
  remote: RemoteTarget,
  clip: ClipboardContent
): Promise<string[]> {
  const cfg = config();
  const ssh: SshOptions = {
    target: remote,
    reuseConnection: cfg.reuseConnection,
    // Riding a master the user already authenticated (Remote-SSH holds one open) is
    // what lets a password-only host work at all, since BatchMode cannot prompt.
    inheritMultiplexing: await detectOwnMultiplexing(remote.host),
  };

  const oversized = localPaths.filter((p) => fs.statSync(p).size > cfg.warnAboveBytes);
  if (cfg.warnAboveBytes > 0 && oversized.length > 0) {
    const total = oversized.reduce((sum, p) => sum + fs.statSync(p).size, 0);
    const answer = await vscode.window.showWarningMessage(
      `Clip2Remote: upload ${humanSize(total)} to ${remote.host}?`,
      { modal: true },
      'Upload'
    );
    if (answer !== 'Upload') return [];
  }

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Clip2Remote → ${remote.host}`,
      cancellable: true,
    },
    async (progress, token) => {
      const done: string[] = [];

      for (const [index, localPath] of localPaths.entries()) {
        if (token.isCancellationRequested) break;

        const label = path.basename(localPath);
        progress.report({
          message: `${label}${localPaths.length > 1 ? ` (${index + 1}/${localPaths.length})` : ''}`,
        });

        const remoteFile = remotePathFor(localPath, cfg.remoteDir);
        let prepared = await prepareDestination(ssh, remoteFile);

        // A password-only host cannot authenticate under BatchMode. Offer to open one
        // master connection now; ControlPersist then covers every later paste.
        if (prepared.error && isAuthFailure(prepared.error, prepared.code ?? 0) && !ssh.inheritMultiplexing) {
          if (await authenticate(remote, cfg.masterPersistSeconds)) {
            ssh.reuseConnection = true;
            prepared = await prepareDestination(ssh, remoteFile);
          }
        }

        if (prepared.error) {
          fail(`ssh to ${remote.host} failed: ${prepared.error}`);
          break;
        }

        if (prepared.exists) {
          output.appendLine(`reusing ${remoteFile}`);
          done.push(remoteFile);
          continue;
        }

        let child: ChildProcess | undefined;
        const cancel = token.onCancellationRequested(() => child?.kill());
        const result = await upload(ssh, localPath, remoteFile, (c) => (child = c));
        cancel.dispose();

        if (!result.ok) {
          if (!token.isCancellationRequested) fail(`upload of ${label} failed: ${result.error}`);
          break;
        }

        output.appendLine(`uploaded ${localPath} → ${remoteFile}`);
        done.push(remoteFile);
      }

      // Staged screenshots are ours to clean up; files the user copied are not.
      if (clip.kind === 'image') {
        for (const p of localPaths) safeUnlink(p);
      }

      return done;
    }
  );
}

async function cleanRemote(): Promise<void> {
  const remote = target();
  if (!remote) {
    vscode.window.showInformationMessage('Clip2Remote: this window is not attached to an SSH host.');
    return;
  }

  const cfg = config();
  const res = await pruneRemote(
    {
      target: remote,
      reuseConnection: cfg.reuseConnection,
      inheritMultiplexing: await detectOwnMultiplexing(remote.host),
    },
    cfg.remoteDir,
    cfg.ttlSeconds
  );

  if (res.error) {
    fail(`cleanup failed: ${res.error}`);
    return;
  }
  vscode.window.showInformationMessage(
    `Clip2Remote: removed ${res.removed} uploaded file(s) from ${remote.host}.`
  );
}

/**
 * Reports what the extension can actually see from where it is running.
 *
 * This exists because the whole design rests on one assumption — that a `ui`-kind
 * extension in a remote window still runs locally and can drive the remote terminal.
 * The report makes that verifiable rather than assumed.
 */
async function diagnose(context: vscode.ExtensionContext): Promise<void> {
  const remote = target();
  const clip = await readClipboard(context.extensionPath);

  const lines = [
    '=== Clip2Remote diagnostics ===',
    `extension host platform : ${process.platform}`,
    `extension host hostname : ${os.hostname()} (expect your own machine, not the remote)`,
    `clipboard backend       : ${describeBackend()}`,
    `remoteName              : ${vscode.env.remoteName ?? '(none — local window)'}`,
    `remote authority        : ${currentAuthority() ?? '(none — local window)'}`,
    `resolved ssh target     : ${remote ? remote.host + (remote.port ? `:${remote.port}` : '') : '(none)'}`,
    `remoteDir               : ${config().remoteDir}`,
    `active here             : ${remote ? 'yes (SSH window)' : config().enableInLocalWindows ? 'yes (local window, opted in)' : 'no — local window, Cmd+V passes straight through'}`,
    `activeTerminal visible  : ${vscode.window.activeTerminal ? 'yes' : 'no (expected for a ui extension; sendSequence is used instead)'}`,
    `clipboard kind          : ${clip.kind}`,
    `clipboard detail        : ${clipboardDetail(clip)}`,
  ];

  output.appendLine(lines.join('\n'));
  output.show(true);

  const probe = await insertIntoTerminal('');
  output.appendLine(`terminal injection      : ${probe ? 'OK' : 'FAILED'}`);
}

/**
 * Reports an unreadable clipboard once per session.
 *
 * The conditions behind `unavailable` — a missing helper tool, no graphical session —
 * cannot change without the user acting, so repeating the notice on every paste would
 * be pure noise. The output channel still records each occurrence.
 */
function warnUnavailableOnce(message: string): void {
  if (unavailableWarned) return;
  unavailableWarned = true;
  vscode.window.showWarningMessage(`Clip2Remote: ${message}`);
}

/** The informative half of a clipboard reading, whichever variant it is. */
function clipboardDetail(clip: ClipboardContent): string {
  switch (clip.kind) {
    case 'files':
    case 'image':
      return clip.paths.join(', ');
    case 'other':
      return clip.types.join(', ') || '(clipboard empty)';
    default:
      return clip.message;
  }
}

function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function quoteIfNeeded(p: string): string {
  return /[\s'"$`\\!*?()[\]{}|&;<>~#]/.test(p) ? shellQuote(p) : p;
}

function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

function safeUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}

/** Clears PNGs the JXA reader staged for clipboard images in earlier sessions. */
function pruneStagingDir(): void {
  try {
    for (const name of fs.readdirSync(STAGING_DIR)) {
      const file = path.join(STAGING_DIR, name);
      if (Date.now() - fs.statSync(file).mtimeMs > 3600_000) safeUnlink(file);
    }
  } catch {
    /* nothing staged yet */
  }
}

function fail(message: string): void {
  output.appendLine(message);
  vscode.window.showErrorMessage(`Clip2Remote: ${message}`, 'Show Log').then((choice) => {
    if (choice === 'Show Log') output.show(true);
  });
}
