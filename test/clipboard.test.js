const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

const { parseFileUris, selectFlavor, detectBackend } = require('../dist/services/clipboard/linux.js');
const { isSupportedPlatform, STAGING_DIR } = require('../dist/services/clipboard/index.js');

// --- parseFileUris: the uri-list payload every Linux file manager publishes ---

test('reads a single file uri', () => {
  assert.deepStrictEqual(parseFileUris('file:///home/jay/report.zip'), ['/home/jay/report.zip']);
});

test('percent-decodes spaces in filenames', () => {
  assert.deepStrictEqual(
    parseFileUris('file:///home/jay/screen%20recording.mov'),
    ['/home/jay/screen recording.mov']
  );
});

test('percent-decodes non-ascii filenames', () => {
  assert.deepStrictEqual(parseFileUris('file:///home/jay/r%C3%A9sum%C3%A9.pdf'), ['/home/jay/résumé.pdf']);
});

test('reads a CRLF-separated multi-file selection in order', () => {
  const payload = 'file:///tmp/a.txt\r\nfile:///tmp/b.txt\r\nfile:///tmp/c.txt\r\n';
  assert.deepStrictEqual(parseFileUris(payload), ['/tmp/a.txt', '/tmp/b.txt', '/tmp/c.txt']);
});

test('skips uri-list comment lines', () => {
  assert.deepStrictEqual(parseFileUris('# a comment\nfile:///tmp/a.txt'), ['/tmp/a.txt']);
});

test('a hash in a filename is not mistaken for a comment', () => {
  // The `#` arrives percent-encoded, so the comment rule can never eat a real path.
  assert.deepStrictEqual(parseFileUris('file:///tmp/draft%232.txt'), ['/tmp/draft#2.txt']);
});

test('a backslash in a filename survives verbatim', () => {
  // Legal on Linux, and the case a shell-based reader mangles via printf %b.
  assert.deepStrictEqual(parseFileUris('file:///tmp/we%5Cird.txt'), ['/tmp/we\\ird.txt']);
});

test('skips the GNOME operation header', () => {
  assert.deepStrictEqual(parseFileUris('copy\nfile:///tmp/a.txt\nfile:///tmp/b.txt'), [
    '/tmp/a.txt',
    '/tmp/b.txt',
  ]);
});

test('skips the legacy Nautilus mime header and its operation line', () => {
  const payload = 'x-special/nautilus-clipboard\ncut\nfile:///tmp/a.txt\n';
  assert.deepStrictEqual(parseFileUris(payload), ['/tmp/a.txt']);
});

test('ignores remote urls dragged from a browser', () => {
  assert.deepStrictEqual(parseFileUris('https://example.com/a.zip\nfile:///tmp/a.txt'), ['/tmp/a.txt']);
});

test('ignores a file url belonging to another host', () => {
  assert.deepStrictEqual(parseFileUris('file://otherbox/srv/a.txt'), []);
});

test('deduplicates repeated entries', () => {
  assert.deepStrictEqual(parseFileUris('file:///tmp/a.txt\nfile:///tmp/a.txt'), ['/tmp/a.txt']);
});

test('an empty payload yields no paths', () => {
  assert.deepStrictEqual(parseFileUris(''), []);
});

test('a payload of only remote urls yields no paths', () => {
  assert.deepStrictEqual(parseFileUris('https://example.com/a.zip\n'), []);
});

// --- captured fixtures: bytes a real GNOME Files copy actually put on the clipboard ---
//
// Source: Ubuntu 24.04.4, GNOME Files on a Wayland session (WAYLAND_DISPLAY=wayland-0),
// captured 2026-08-23 via `wl-paste --type <flavor>` after a Ctrl+C on one file, and
// decoded from base64. These assert against observed bytes rather than against the spec,
// which is the difference between believing the format and knowing it.

test('parses the real text/uri-list GNOME publishes (CRLF-terminated, percent-encoded)', () => {
  const captured = 'file:///home/jayrome/clip2remote-test/screen%20recording.mov\r\n';
  assert.deepStrictEqual(parseFileUris(captured), [
    '/home/jayrome/clip2remote-test/screen recording.mov',
  ]);
});

test('parses the real x-special/gnome-copied-files payload (copy header, no trailing newline)', () => {
  const captured = 'copy\nfile:///home/jayrome/clip2remote-test/screen%20recording.mov';
  assert.deepStrictEqual(parseFileUris(captured), [
    '/home/jayrome/clip2remote-test/screen recording.mov',
  ]);
});

test('selects uri-list from the real advertised type list', () => {
  // Exactly what `wl-paste --list-types` reported for that copy. Note GNOME parameterizes
  // text/plain but not text/uri-list, which is why exact-string matching is sound.
  const captured = [
    'text/plain;charset=utf-8',
    'text/uri-list',
    'application/vnd.portal.files',
    'application/vnd.portal.filetransfer',
    'x-special/gnome-copied-files',
  ];
  assert.deepStrictEqual(selectFlavor(captured), { kind: 'uris', type: 'text/uri-list' });
});

// --- selectFlavor: which advertised clipboard type to actually read ---

test('prefers file references over an image of the same file', () => {
  // A file manager copying a PNG publishes both; the real file beats a re-encode.
  assert.deepStrictEqual(selectFlavor(['image/png', 'text/uri-list']), {
    kind: 'uris',
    type: 'text/uri-list',
  });
});

test('prefers the standard uri-list over the GNOME flavor', () => {
  assert.deepStrictEqual(selectFlavor(['x-special/gnome-copied-files', 'text/uri-list']), {
    kind: 'uris',
    type: 'text/uri-list',
  });
});

test('falls back to the GNOME flavor', () => {
  assert.deepStrictEqual(selectFlavor(['x-special/gnome-copied-files', 'text/plain']), {
    kind: 'uris',
    type: 'x-special/gnome-copied-files',
  });
});

test('falls back to the legacy Nautilus flavor', () => {
  assert.deepStrictEqual(selectFlavor(['x-special/nautilus-clipboard']), {
    kind: 'uris',
    type: 'x-special/nautilus-clipboard',
  });
});

test('selects a screenshot when no file references are present', () => {
  assert.deepStrictEqual(selectFlavor(['image/png', 'text/html']), {
    kind: 'image',
    type: 'image/png',
  });
});

test('plain text selects nothing, so paste falls through', () => {
  assert.deepStrictEqual(selectFlavor(['text/plain', 'UTF8_STRING', 'TARGETS']), { kind: 'none' });
});

test('an unreadable image flavor selects nothing rather than guessing', () => {
  assert.deepStrictEqual(selectFlavor(['image/bmp', 'image/tiff']), { kind: 'none' });
});

test('an empty clipboard selects nothing', () => {
  assert.deepStrictEqual(selectFlavor([]), { kind: 'none' });
});

// --- detectBackend: session detection ---

test('a Wayland session uses wl-paste', () => {
  const backend = detectBackend({ WAYLAND_DISPLAY: 'wayland-0' });
  assert.strictEqual(backend.session, 'wayland');
  assert.strictEqual(backend.tool, 'wl-paste');
});

test('an X11 session uses xclip', () => {
  const backend = detectBackend({ DISPLAY: ':0' });
  assert.strictEqual(backend.session, 'x11');
  assert.strictEqual(backend.tool, 'xclip');
});

test('Wayland wins when XWayland also exports DISPLAY', () => {
  // The bridged X selection does not reliably carry the file flavors, so preferring
  // it would silently degrade a file paste into a text paste.
  const backend = detectBackend({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' });
  assert.strictEqual(backend.session, 'wayland');
});

test('no graphical session yields no backend', () => {
  assert.strictEqual(detectBackend({}), undefined);
});

// --- dispatcher ---

test('macOS and Linux clients are supported; others pass through', () => {
  assert.strictEqual(isSupportedPlatform('darwin'), true);
  assert.strictEqual(isSupportedPlatform('linux'), true);
  assert.strictEqual(isSupportedPlatform('win32'), false);
  assert.strictEqual(isSupportedPlatform('freebsd'), false);
});

test('the staging dir sits under the OS temp dir, not a literal /tmp', () => {
  assert.strictEqual(STAGING_DIR, path.join(os.tmpdir(), 'clip2remote-staging'));
});
