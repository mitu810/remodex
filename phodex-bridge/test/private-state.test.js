const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('private writes restrict existing Windows files before replacing sensitive contents', (t) => {
  const { writePrivateFile } = require('../src/private-state');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remodex acl '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'device-state.json');
  fs.writeFileSync(file, 'old');
  let script;
  writePrivateFile(file, 'private', { platform: 'win32', execFileSyncImpl(command, args) {
    assert.match(command, /^[A-Z]:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
    assert.equal(fs.readFileSync(file, 'utf8'), 'old');
    script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  } });
  assert.equal(fs.readFileSync(file, 'utf8'), 'private');
  assert.match(script, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(script, /WindowsIdentity/);
  assert.match(script, /Set-Acl/);
});

test('replacing a private file invalidates the cached Windows ACL check', (t) => {
  const { writePrivateFile } = require('../src/private-state');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remodex acl replacement '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  let checks = 0;
  const options = { platform: 'win32', execFileSyncImpl() { checks++; } };
  writePrivateFile(file, 'private', options);
  const replacement = path.join(root, 'replacement');
  fs.writeFileSync(replacement, 'public');
  fs.renameSync(replacement, file);
  writePrivateFile(file, 'private again', options);
  assert.equal(checks, 2);
});

test('private writes fail closed when Windows ACL setup fails', (t) => {
  const { writePrivateFile } = require('../src/private-state');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remodex acl failure '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'pairing.json');
  assert.throws(() => writePrivateFile(file, 'bearer-secret', { platform: 'win32', execFileSyncImpl() { throw new Error('access denied'); } }), /private.*permission/i);
  assert.equal(fs.readFileSync(file, 'utf8'), '');
});

test('private files are owner-only on POSIX', { skip: process.platform === 'win32' }, (t) => {
  const { writePrivateFile } = require('../src/private-state');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remodex private '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  fs.writeFileSync(file, 'old', { mode: 0o644 });
  writePrivateFile(file, 'new');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
