// tests/load-zip-files.test.js
// The archive-detection rules, run through the real loadZipFiles against a
// duck-typed fake ZIP (tests/_lib/fake-zip.js). This is coverage the private
// test suite never had: it walks unzipped directories and calls extractAll
// directly, so the ZIP walking and the typed refusals were only ever exercised
// by hand in a browser.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { loadZipFiles } = require('./_lib/parser');
const { fakeZip, fakeZipFromDir, quiet } = require('./_lib/fake-zip');
const { FIXTURE_ROOT } = require('./_lib/load-export');
const disguise = (s) => Array.from(Buffer.from(s, 'utf8')).map((b) => String.fromCharCode(b)).join('');

const ZIP_NAME = 'instagram-example_user-2025-01-20-AbCdEf12.zip';
const load = (zip, name) => quiet(() => loadZipFiles(zip, () => {}, name || ZIP_NAME));
const refusal = async (zip) => {
  try { await load(zip); } catch (e) { return e; }
  assert.fail('expected loadZipFiles to refuse');
};

test('accepts the synthetic fixture and parses every JSON file', async () => {
  const files = await load(fakeZipFromDir(FIXTURE_ROOT));
  assert.equal(files._platformId, 'instagram');
  assert.equal(files._format, 'json');
  assert.equal(files._hasJson, true);
  assert.equal(typeof files['your_instagram_activity/ai/interest_categories.json'], 'object');
  assert.equal(files._rootPrefix, '');
});

test('strips a wrapping root folder the way Meta names it', async () => {
  const files = await load(fakeZipFromDir(FIXTURE_ROOT, 'instagram-example_user-2025-01-20-AbCdEf12/'));
  assert.equal(typeof files['your_instagram_activity/ai/interest_categories.json'], 'object',
    'the entry is keyed without the wrapper: ' + Object.keys(files).filter((k) => !k.startsWith('_')).slice(0, 3).join(', '));
});

test('a combined Instagram + Facebook export is accepted as Instagram, in either entry order', async () => {
  const ig = { 'your_instagram_activity/ai/interest_categories.json': { topics_your_topics: [] } };
  const fb = { 'your_facebook_activity/posts/your_posts_1.json': [] };
  const a = await load(fakeZip(Object.assign({}, fb, ig)));
  const b = await load(fakeZip(Object.assign({}, ig, fb)));
  assert.equal(a._platformId, 'instagram');
  assert.equal(b._platformId, 'instagram');
});

test('a Facebook-only archive is refused with WRONG_PLATFORM_FACEBOOK', async () => {
  const e = await refusal(fakeZip({
    'your_facebook_activity/posts/your_posts_1.json': [],
    'personal_information/profile_information/profile_information.json': {},
  }));
  assert.equal(e.code, 'WRONG_PLATFORM_FACEBOOK');
  assert.match(String(e.message), /Facebook/i);
});

test('an archive with no Instagram anchor is refused with NOT_AN_INSTAGRAM_EXPORT', async () => {
  const e = await refusal(fakeZip({
    'photos/IMG_0001.jpg': 'not really a jpeg',
    'notes.txt': 'hello',
  }));
  assert.equal(e.code, 'NOT_AN_INSTAGRAM_EXPORT');
});

test('a Meta-shaped archive without the Instagram anchor is refused, and the message points at a partial export', async () => {
  const e = await refusal(fakeZip({
    'ads_information/ads_and_topics/ads_viewed.json': { impressions_history_ads_seen: [] },
    'personal_information/personal_information/personal_information.json': { profile_user: [] },
  }));
  assert.equal(e.code, 'NOT_AN_INSTAGRAM_EXPORT');
});

test('an Instagram anchor with no JSON or HTML inside is refused with NOT_A_RECOGNIZED_EXPORT', async () => {
  const e = await refusal(fakeZip({
    'your_instagram_activity/': { dir: true },
    'your_instagram_activity/media/photo.jpg': 'binary-ish',
  }));
  assert.equal(e.code, 'NOT_A_RECOGNIZED_EXPORT');
});

test('backslash entry names from a re-zipped export are normalised', async () => {
  const files = await load(fakeZip({
    'your_instagram_activity\\ai\\interest_categories.json': { topics_your_topics: [] },
  }));
  assert.equal(typeof files['your_instagram_activity/ai/interest_categories.json'], 'object');
});

test('malformed JSON is skipped rather than failing the archive', async () => {
  const files = await load(fakeZip({
    'your_instagram_activity/ai/interest_categories.json': { topics_your_topics: [] },
    'your_instagram_activity/likes/liked_posts.json': '{ this is not json',
  }));
  assert.equal(files._platformId, 'instagram');
  assert.equal(files['your_instagram_activity/likes/liked_posts.json'], undefined);
});

test('HTML files are kept as raw text and the format is recorded', async () => {
  const files = await load(fakeZip({
    'your_instagram_activity/ai/interest_categories.html': '<html><body><div>Example</div></body></html>',
  }));
  assert.equal(files._hasHtml, true);
  assert.equal(files._format, 'html');
  const entry = files['your_instagram_activity/ai/interest_categories.html'];
  assert.equal(typeof (entry && entry._html), 'string');
});

test('mojibake is fixed at load time, keys included', async () => {
  const files = await load(fakeZip({
    'your_instagram_activity/ai/interest_categories.json': { topics_your_topics: [{ string_map_data: { [disguise('Été')]: { value: disguise('café') } } }] },
  }));
  const row = files['your_instagram_activity/ai/interest_categories.json'].topics_your_topics[0].string_map_data;
  assert.deepEqual(Object.keys(row), ['Été']);
  assert.equal(row['Été'].value, 'café');
});

test('the progress callback is called and the zip filename is recorded', async () => {
  let calls = 0;
  const files = await quiet(() => loadZipFiles(fakeZipFromDir(FIXTURE_ROOT), () => { calls++; }, ZIP_NAME));
  assert.ok(calls > 0);
  assert.equal(files._zipFilename, ZIP_NAME);
});
