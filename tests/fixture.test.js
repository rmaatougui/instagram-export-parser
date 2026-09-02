// tests/fixture.test.js
// Two things about tests/fixture/export: it is unmistakably synthetic (every
// timestamp in January 2025, every email under example.com, every URL on an
// allowed host), and it agrees with the recorded Meta schema wherever the two
// overlap. Then the real parser runs on it end to end and produces populated
// sections with no extractor errors.
//
// With IG_EXPORT_PATH set, the fixture checks are skipped and the parser runs
// on that export instead; nothing about it is printed or recorded.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractAll } = require('./_lib/parser');
const { FIXTURE_ROOT, usingFixture, loadExport, walkExport } = require('./_lib/load-export');
const { buildShape, loadSnapshot } = require('../scripts/schema-check');

const JAN_2025_START = Date.UTC(2025, 0, 1) / 1000;
const FEB_2025_START = Date.UTC(2025, 1, 1) / 1000;
const ALLOWED_HOSTS = /^(?:[a-z0-9-]+\.)*(?:example\.com|instagram\.com|facebook\.com|meta\.com)$/i;

function walkValues(node, visit, keyPath) {
  if (Array.isArray(node)) node.forEach((v, i) => walkValues(v, visit, keyPath + '[' + i + ']'));
  else if (node && typeof node === 'object') for (const k of Object.keys(node)) walkValues(node[k], visit, keyPath + '.' + k);
  else visit(node, keyPath);
}

function fixtureFiles() {
  const out = [];
  (function rec(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) rec(p); else if (e.name.endsWith('.json')) out.push(p);
    }
  })(FIXTURE_ROOT);
  return out;
}

test('every fixture timestamp falls in January 2025', { skip: !usingFixture() && 'IG_EXPORT_PATH set' }, () => {
  let seen = 0;
  for (const f of fixtureFiles()) {
    walkValues(JSON.parse(fs.readFileSync(f, 'utf8')), (v, kp) => {
      if (typeof v === 'number' && v > 1e9 && v < 1e11 && /time|date|stamp|_at$/i.test(kp)) {
        seen++;
        assert.ok(v >= JAN_2025_START && v < FEB_2025_START, path.relative(FIXTURE_ROOT, f) + ' ' + kp + ' = ' + v);
      }
    }, '');
  }
  assert.ok(seen > 0, 'the fixture carries timestamps');
});

test('every fixture email is under example.com and every URL is on an allowed host', { skip: !usingFixture() && 'IG_EXPORT_PATH set' }, () => {
  for (const f of fixtureFiles()) {
    walkValues(JSON.parse(fs.readFileSync(f, 'utf8')), (v, kp) => {
      if (typeof v !== 'string') return;
      const emails = v.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
      for (const e of emails) assert.match(e, /@example\.com$/i, path.relative(FIXTURE_ROOT, f) + ' ' + kp + ' ' + e);
      const urls = v.match(/https?:\/\/[^\s"'<>]+/g) || [];
      for (const u of urls) {
        const host = new URL(u).hostname;
        assert.match(host, ALLOWED_HOSTS, path.relative(FIXTURE_ROOT, f) + ' ' + kp + ' ' + u);
      }
      if (/phone/i.test(kp)) {
        const digits = v.replace(/\D/g, '');
        if (digits.length >= 7) assert.match(digits, /555\d{4}$/, path.relative(FIXTURE_ROOT, f) + ' ' + kp + ' phone not in the 555 range: ' + v);
      }
    }, '');
  }
});

test('every fixture file the snapshot knows carries exactly the snapshot keys', { skip: !usingFixture() && 'IG_EXPORT_PATH set' }, () => {
  const shape = buildShape(walkExport(FIXTURE_ROOT));
  const snap = loadSnapshot();
  let covered = 0;
  for (const f of Object.keys(shape.files)) {
    if (!snap.files[f]) continue;
    covered++;
    assert.deepEqual(shape.files[f].keys, snap.files[f].keys, f);
  }
  assert.ok(covered >= 10, 'fixture covers ' + covered + ' snapshot files');
});

test('the parser runs end to end on the export with no extractor errors', () => {
  const r = extractAll(loadExport());
  assert.deepEqual(r._extract_errors, {}, JSON.stringify(r._extract_errors));
  assert.equal(r._format, 'json');
  assert.equal(r._platform && r._platform.id, 'instagram');
});

test('populated sections come back populated', { skip: !usingFixture() && 'IG_EXPORT_PATH set' }, () => {
  const r = extractAll(loadExport());
  assert.ok(Array.isArray(r.ai_interests) && r.ai_interests.length > 0, 'ai_interests from your_instagram_activity/ai/');
  assert.ok(r.identity && r.identity.username, 'identity.username from personal_information');
  assert.ok(r.social_graph && typeof r.social_graph === 'object', 'social_graph shape');
});
