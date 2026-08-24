const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/**
 * Guards against a test file that lands in the repo and never runs.
 *
 * `npm test` names its files explicitly rather than scanning the directory, so a new
 * suite is invisible until it is added to the script — it would read as coverage from
 * the outside while asserting nothing. This test fails the run when that happens.
 */
test('every test file is registered in the npm test script', () => {
  const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test;
  assert.ok(script, 'package.json has no "test" script');

  const onDisk = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
  assert.ok(onDisk.length > 0, 'no test files found — an empty suite must not report green');

  const unregistered = onDisk.filter((f) => !script.includes(`test/${f}`));
  assert.deepStrictEqual(
    unregistered,
    [],
    `add these to the "test" script in package.json: ${unregistered.join(', ')}`
  );
});
