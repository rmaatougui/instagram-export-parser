// tests/smoke.test.js
// The claims the README makes about report.js itself, pinned as assertions so
// a refresh of the file cannot quietly falsify them: it loads under Node with
// no side effects, it exports exactly the six documented functions, and it
// contains no network or storage call site. The searches here are the same
// ones the README tells a reader to run by hand.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPORT = path.join(__dirname, '..', 'report.js');
const source = fs.readFileSync(REPORT, 'utf8');
const lines = source.split('\n');
const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l);
const code = lines.filter((l) => !isComment(l));

test('report.js loads under Node and exports exactly the six documented functions', () => {
  const parser = require('./_lib/parser');
  assert.deepEqual(Object.keys(parser).sort(), [
    'extractAll', 'extractSocialGraph', 'fixMetaMojibakeDeep', 'fixMetaMojibakeString', 'loadZipFiles', 'parseExportDate',
  ]);
  for (const k of Object.keys(parser)) assert.equal(typeof parser[k], 'function', k);
});

test('no network call site: fetch / XMLHttpRequest / sendBeacon / WebSocket / EventSource', () => {
  const hits = code.filter((l) => /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\s*\(/.test(l));
  assert.deepEqual(hits, []);
  const ctors = code.filter((l) => /\bnew\s+(XMLHttpRequest|WebSocket|EventSource|Worker|Image)\b/.test(l));
  assert.deepEqual(ctors, []);
});

test('no module loading: require() / import', () => {
  const hits = code.filter((l) => /\b(require|import)\s*\(|^\s*import\s/.test(l));
  assert.deepEqual(hits, []);
});

test('no storage or navigator access', () => {
  const hits = code.filter((l) => /\b(navigator|localStorage|sessionStorage|indexedDB|cookie)\b/.test(l));
  assert.deepEqual(hits, []);
});

test('every remaining mention of a network word is inside a comment', () => {
  const broad = lines.filter((l) => /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b/.test(l));
  for (const l of broad) assert.ok(isComment(l), 'not a comment: ' + l.trim());
});

test('the file ends with LF line endings only', () => {
  assert.equal(source.includes('\r\n'), false);
});

test('under Node there is no DOMParser, and an HTML-only archive still parses to empty shapes with no errors', () => {
  // The HTML branches are the only place the file reaches for a browser API.
  // They are guarded, so on Node (no DOMParser) every extractor returns its
  // empty shape rather than throwing; extractAll reports nothing under
  // _extract_errors and records the format it saw.
  assert.equal(typeof globalThis.DOMParser, 'undefined');
  const { extractAll } = require('./_lib/parser');
  const files = {
    _format: 'html', _hasJson: false, _hasHtml: true, _platformId: 'instagram',
    'personal_information/personal_information/personal_information.html': { _html: '<html><body><div>Example</div></body></html>' },
    'ads_information/instagram_ads_and_businesses/advertisers_using_your_activity_or_information.html': { _html: '<html><body><table></table></body></html>' },
  };
  const r = extractAll(files);
  assert.deepEqual(r._extract_errors, {});
  assert.equal(r._format, 'html');
  assert.equal(r.advertisers.total_unique, 0);
});
