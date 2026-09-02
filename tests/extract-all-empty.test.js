// tests/extract-all-empty.test.js
// The honest-empty contract: extractAll on nothing at all returns every
// section with a shape that says "nothing here", never a plausible number,
// and records no extractor errors. This is the one test that needs no
// fixture and no export, which is why it runs first in a fresh clone.
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractAll } = require('./_lib/parser');

const EXPECTED_KEYS = [
  'window', 'identity', 'export_request', 'checkout_profile', 'cart_items', 'device_summary',
  'device_fingerprint', 'location', 'audience', 'content_interactions', 'profiles_reached',
  'ai_interests', 'topics', 'ad_prefs', 'other_categories', 'ads_about_meta', 'advertisers',
  'off_meta', 'link_history', 'shopping', 'subscription_status', 'likes_summary',
  'feed_impressions', 'ad_impressions_detail', 'clicked_ads', 'attention_mining',
  'story_interactions', 'comments_posted', 'social_graph', 'threads', 'muted_creators',
  'see_less_topics', 'cpm_tier', 'privacy_callouts', 'messages_summary', 'extracted',
  '_extract_errors', '_format', '_platform',
];

test('extractAll({}) returns every documented key, and nothing undefined', () => {
  const r = extractAll({});
  assert.deepEqual(Object.keys(r).sort(), EXPECTED_KEYS.slice().sort());
  for (const k of EXPECTED_KEYS) assert.notEqual(r[k], undefined, k + ' is undefined');
});

test('no extractor errors on an empty archive', () => {
  assert.deepEqual(extractAll({})._extract_errors, {});
});

test('the empty shapes claim nothing', () => {
  const r = extractAll({});
  assert.deepEqual(r.ai_interests, []);
  assert.equal(r.advertisers.total_unique, 0);
  assert.deepEqual(r.advertisers.shown, []);
  assert.equal(r.identity.autofill_present, false);
  assert.deepEqual(r.window, {});
});

test('extractAll on the same empty input is deterministic', () => {
  assert.deepEqual(extractAll({}), extractAll({}));
});
