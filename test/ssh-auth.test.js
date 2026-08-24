const test = require('node:test');
const assert = require('node:assert');

const { isAuthFailure } = require('../dist/services/ssh-auth.js');

// Source: real OpenSSH stderr. The "Permission denied" line is the exact text produced by
// OpenSSH 9.6p1 (Ubuntu 24.04) against a Mac running OpenSSH 10.2p1, captured 2026-08-23.

test('recognises a password/publickey rejection', () => {
  assert.strictEqual(
    isAuthFailure('jayrome@192.168.3.5: Permission denied (publickey,password,keyboard-interactive).', 255),
    true
  );
});

test('recognises exhausted authentication attempts', () => {
  assert.strictEqual(isAuthFailure('Received disconnect: Too many authentication failures', 255), true);
});

test('recognises a host offering nothing we can use', () => {
  assert.strictEqual(isAuthFailure('No supported authentication methods available', 255), true);
});

test('is case-insensitive', () => {
  assert.strictEqual(isAuthFailure('PERMISSION DENIED (publickey).', 255), true);
});

// The point of the guard: a password prompt must not appear for failures a password
// cannot fix, since that trains the user to type credentials at unrelated errors.

test('an unreachable host is not an auth failure', () => {
  assert.strictEqual(isAuthFailure('ssh: connect to host devbox port 22: Connection refused', 255), false);
});

test('a host key mismatch is not an auth failure', () => {
  assert.strictEqual(
    isAuthFailure('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! Host key verification failed.', 255),
    false
  );
});

test('a remote command printing "permission denied" does not trigger a prompt', () => {
  // The remote mkdir failing on a read-only dir exits 1, not 255. Prompting for a
  // password here would train the user to enter credentials at unrelated errors.
  assert.strictEqual(isAuthFailure('mkdir: cannot create directory: Permission denied', 1), false);
});

test('the same text from ssh itself does trigger a prompt', () => {
  assert.strictEqual(isAuthFailure('jayrome@mymac: Permission denied (publickey).', 255), true);
});

test('an empty stderr is not an auth failure', () => {
  assert.strictEqual(isAuthFailure('', 255), false);
});

test('a timeout is not an auth failure', () => {
  assert.strictEqual(isAuthFailure('ssh: connect to host x port 22: Operation timed out', 255), false);
});
