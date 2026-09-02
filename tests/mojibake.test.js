// tests/mojibake.test.js
// Meta's JSON writes non-ASCII text double-encoded: after JSON.parse, a
// Cyrillic or accented word is a run of Latin-1 characters that are really
// UTF-8 bytes in disguise. These pin the fix's contract: strict, idempotent,
// and never touching a string that is already real Unicode.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixMetaMojibakeString, fixMetaMojibakeDeep } = require('./_lib/parser');
// How Meta writes a non-ASCII string: each UTF-8 byte as its own Latin-1 character.
const disguise = (s) => Array.from(Buffer.from(s, 'utf8')).map((b) => String.fromCharCode(b)).join('');

test('a double-encoded accented word is decoded', () => {
  assert.equal(fixMetaMojibakeString('Ã©tÃ©'), 'été');
  assert.equal(fixMetaMojibakeString('cafÃ©'), 'café');
});

test('double-encoded Cyrillic is decoded', () => {
  // "Привет" as Meta writes it: each UTF-8 byte as a Latin-1 character.
  assert.equal(fixMetaMojibakeString(disguise('Привет')), 'Привет');
});

test('plain ASCII is returned unchanged', () => {
  assert.equal(fixMetaMojibakeString('plain text 123'), 'plain text 123');
  assert.equal(fixMetaMojibakeString(''), '');
});

test('a string that is not valid UTF-8 under the byte reading is returned unchanged', () => {
  // A lone high byte is not a UTF-8 sequence; strict decoding must leave it.
  assert.equal(fixMetaMojibakeString('café'), 'café');
});

test('a string already outside Latin-1 is never touched', () => {
  assert.equal(fixMetaMojibakeString('été'), 'été');
  assert.equal(fixMetaMojibakeString('日本語'), '日本語');
});

test('the fix is idempotent', () => {
  const once = fixMetaMojibakeString('Ã©tÃ©');
  assert.equal(fixMetaMojibakeString(once), once);
});

test('fixMetaMojibakeDeep rewrites values and keys through nested objects and arrays', () => {
  const out = fixMetaMojibakeDeep({ [disguise('clé')]: [{ value: disguise('été'), n: 3, nested: { [disguise('à')]: disguise('ça') } }], keep: 'ok' });
  assert.deepEqual(out, { 'clé': [{ value: 'été', n: 3, nested: { 'à': 'ça' } }], keep: 'ok' });
});

test('fixMetaMojibakeDeep passes non-strings through', () => {
  assert.equal(fixMetaMojibakeDeep(42), 42);
  assert.equal(fixMetaMojibakeDeep(null), null);
  assert.deepEqual(fixMetaMojibakeDeep([true, 1.5]), [true, 1.5]);
});
