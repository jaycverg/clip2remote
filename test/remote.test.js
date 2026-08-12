const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveRemoteTarget,
  fingerprint,
  remotePathFor,
  sshBaseArgs,
  shellQuote,
  controlPathFor,
} = require('../dist/services/remote.js');

// macOS sockaddr_un.sun_path allows 103 usable chars, minus ssh's 17-char temp-master suffix.
const SOCKET_BUDGET = 103 - 17;

// A 24-char `%r@%h:%p` expansion — the length that overran sun_path under a macOS TMPDIR.
const LONG_TARGET = { host: 'devuser@build-macmini', port: 22 };

test('resolves a plain ssh_config alias', () => {
  assert.deepStrictEqual(resolveRemoteTarget('ssh-remote+devbox'), { host: 'devbox' });
});

test('resolves a hex-encoded authority into user@host and port', () => {
  const payload = JSON.stringify({ hostName: 'build-box', user: 'jayrome', port: 2222 });
  const authority = 'ssh-remote+' + Buffer.from(payload, 'utf8').toString('hex');

  assert.deepStrictEqual(resolveRemoteTarget(authority), {
    host: 'jayrome@build-box',
    port: 2222,
  });
});

test('a hex-looking alias that is not JSON is treated literally', () => {
  // "abcdef0123456789ab" is valid hex and long enough to tempt the decoder.
  assert.deepStrictEqual(resolveRemoteTarget('ssh-remote+abcdef0123456789ab'), {
    host: 'abcdef0123456789ab',
  });
});

test('non-ssh authorities are rejected', () => {
  for (const authority of [undefined, '', 'dev-container+abc', 'wsl+ubuntu', 'codespaces+x']) {
    assert.strictEqual(resolveRemoteTarget(authority), undefined, `for ${authority}`);
  }
});

test('fingerprint is stable for an unchanged file and differs across content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2r-'));
  const a = path.join(dir, 'report.zip');
  fs.writeFileSync(a, 'aaa');

  assert.strictEqual(fingerprint(a), fingerprint(a));

  const b = path.join(dir, 'other.zip');
  fs.writeFileSync(b, 'aaaaaaaaaaaa');
  assert.notStrictEqual(fingerprint(a), fingerprint(b));
});

test('remote path keeps the original filename under a fingerprint dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2r-'));
  const file = path.join(dir, 'demo clip.mov');
  fs.writeFileSync(file, 'x');

  const remote = remotePathFor(file, '/tmp/clip2remote/');
  assert.match(remote, /^\/tmp\/clip2remote\/[0-9a-f]{12}\/demo clip\.mov$/);
});

test('shell quoting survives single quotes', () => {
  assert.strictEqual(shellQuote("it's.zip"), `'it'\\''s.zip'`);
});

test('scp uses -P for the port while ssh uses -p', () => {
  const opts = { target: { host: 'h', port: 2222 }, reuseConnection: false };
  assert.ok(sshBaseArgs(opts, true).includes('-P'));
  assert.ok(sshBaseArgs(opts, false).includes('-p'));
});

test('connection reuse is opt-out', () => {
  const opts = { target: { host: 'h' }, reuseConnection: false };
  assert.ok(!sshBaseArgs(opts, false).some((a) => String(a).startsWith('ControlMaster')));
});

test('control path fits sun_path for a long target under a macOS temp dir', () => {
  // Same 48-char shape macOS gives every user: /var/folders/<2>/<30>/T
  const macTmp = '/var/folders/mc/abcdefghijklmnopqrstuvwx0000gn/T';
  const socket = controlPathFor(LONG_TARGET, macTmp);

  assert.ok(socket.startsWith(macTmp + '/'), `expected it under the temp dir, got ${socket}`);
  assert.ok(socket.length <= SOCKET_BUDGET, `${socket.length} chars: ${socket}`);
});

test('control path falls back to /tmp when the temp dir blows the budget', () => {
  const longTmp = '/var/folders/' + 'x'.repeat(80);
  const socket = controlPathFor(LONG_TARGET, longTmp);

  assert.match(socket, /^\/tmp\/c2r-[0-9a-f]{12}$/);
  assert.ok(socket.length <= SOCKET_BUDGET, `${socket.length} chars: ${socket}`);
});

test('control path is stable per target and distinct across targets', () => {
  const a = controlPathFor(LONG_TARGET);
  assert.strictEqual(a, controlPathFor(LONG_TARGET));

  assert.notStrictEqual(a, controlPathFor({ host: LONG_TARGET.host, port: 2222 }));
  assert.notStrictEqual(a, controlPathFor({ host: 'otheruser@build-macmini', port: 22 }));
});

test('reuse passes the hashed control path to ssh, not %r@%h:%p', () => {
  const args = sshBaseArgs({ target: LONG_TARGET, reuseConnection: true }, false);
  const controlPath = args.find((a) => String(a).startsWith('ControlPath='));

  assert.ok(controlPath, 'expected a ControlPath option');
  assert.ok(!controlPath.includes('%'), `no ssh tokens expected: ${controlPath}`);
  assert.strictEqual(
    controlPath,
    `ControlPath=${controlPathFor(LONG_TARGET)}`
  );
});
