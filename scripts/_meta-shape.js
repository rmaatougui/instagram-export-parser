// _meta-shape.js
// The canonical SHAPE of one parsed Meta export file — the single rule every
// schema check shares, so that no two of them can disagree about what a shape
// is. (Opt2In copies this file into the public parser repo verbatim; keep it
// free of internal addresses and operator detail so it stays publishable.)
//
// WHY THIS EXISTS. Meta's container is a function of RECORD COUNT, not of
// schema: a list file holding N>=2 records ships as an array of record
// objects, and the SAME file holding exactly one ships as the bare record
// object itself. 27 of the 50 watched files in a full export sit on that axis.
// That is why unchanged files flip shapes day over day, each day's added and
// removed key lists an exact inverse of the day before — drift reports that
// are pure noise, describing a record count rather than a schema change.
//
// The rule was written 2026-08-10 (extended 2026-08-11) after a canary alarmed
// on connections/followers_and_following/followers_1.json flipping from
// <array> to {media_list_data, string_list_data, title} — the ordinary Meta
// follower ITEM arriving as a lone bare object instead of a one-element array.
// 2026-08-11 added 'creation_timestamp' when your_instagram_activity/media/
// posts_1.json arrived as a LONE POST object, {creation_timestamp, media,
// title}. It lives here so there is one rule instead of a copy per caller.
//
// DO NOT ADD 'media', 'title' or 'timestamp' to the fingerprint.
//   'title'      IS a genuine top-level WRAPPER key. 35 message_1.json files
//                in the May export carry {participants, messages, title,
//                thread_path, magic_words, is_still_participant}, and the
//                observer canary watches exactly those, collapsed to
//                <conversation> paths. Fingerprinting on it would blind the
//                canary to Meta reorganising the DM export.
//   'media' and  Generic, un-namespaced field names. Every genuine Meta
//   'timestamp'  wrapper key is namespaced (ig_stories, relationships_following,
//                impressions_history_ads_seen …); these two are exactly the
//                shape a future wrapper could take, and a fingerprint is only
//                safe while it is made of keys no wrapper would plausibly
//                claim. They also buy nothing — every file they appear in
//                already carries 'fbid' or 'creation_timestamp'.
// (Corrected 2026-09-05: an earlier note excluded 'title' because it "IS a real
// wrapper key in your_instagram_activity/shopping/checkout_payment_information
// .json". That file is itself a bare item and 'title' is its own field, so the
// stated reason was wrong. Re-measured: the DM tree is where 'title' is
// genuinely a wrapper key. The exclusion always stood; only its reason was.)

'use strict';

const ITEM_KEY_FINGERPRINT = [
  'fbid', 'label_values', 'string_map_data',
  'string_list_data', 'media_list_data', 'creation_timestamp',
];

function isBareItemObject(keys) {
  return ITEM_KEY_FINGERPRINT.some((k) => keys.includes(k));
}

// The canonical shape token set for one parsed JSON file.
//   array (incl. []) ................. ['<array>']   an empty week is
//                                                    structurally identical
//                                                    to a busy one
//   object hitting the fingerprint ... ['<array>']   the 1-record form of the
//                                                    same list
//   any other object ................. sorted top-level keys (a real wrapper)
//   anything else .................... ['<' + typeof v + '>']
//
// The token stays '<array>' rather than a new '<records>': the committed
// baselines already store bare records that way and none as item keys, so
// they converge on one vocabulary with no migration.
function canonicalKeys(v) {
  if (Array.isArray(v)) return ['<array>'];
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).sort();
    return isBareItemObject(keys) ? ['<array>'] : keys;
  }
  return ['<' + typeof v + '>'];
}

module.exports = { ITEM_KEY_FINGERPRINT, isBareItemObject, canonicalKeys };
