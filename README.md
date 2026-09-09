# instagram-export-parser

The parser behind the Instagram report at [opt2in.com](https://opt2in.com),
published as the one file it is: `report.js`, 4345 lines, no
dependencies, and byte-for-byte the file the site serves at
`https://opt2in.com/report/instagram/report.js` on the day of this build
(2026-09-09; SHA-256 `bd564325ec66cc40af89cd1bc5bdf902526ab6e2f9f27978f9ec3a3ce5d16e8a`).

It takes the ZIP that Meta hands you when you download your Instagram
information and turns it into a plain JavaScript object: who advertised to
you and how often, what you were shown, what Meta says it knows about you,
what you did. The site renders that object as a report. This repository holds
the parsing, and only the parsing.

**Scope, stated once.** The report's rendering, the offer matching, the
backend functions, the account and admin surfaces, and everything else that
makes up the site are not here and are not open source. This is a trust
artifact, not a community project: it exists so that a claim about your data
can be checked instead of believed. [CONTRIBUTING.md](CONTRIBUTING.md) says
what that means for pull requests (in short: bug reports yes, merges no).

## Verify it yourself

Two checks, which prove two different things.

### 1. Read the code: this file makes no network calls

`report.js` contains no call to `fetch`, `XMLHttpRequest`, `sendBeacon` or
`WebSocket`, no `require` or `import`, and, outside comments, no reference to
`navigator`, `localStorage` or cookies. Reproduce it (the second `grep` drops
comment lines, because the file's own comments discuss what it refuses to do):

```sh
# Call sites, comments excluded. Expected output: nothing.
grep -nE '\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\s*\(|\bnew\s+(XMLHttpRequest|WebSocket|EventSource|Worker|Image)\b|\b(require|import)\s*\(|^\s*import\s|\b(navigator|localStorage|sessionStorage|indexedDB|cookie)\b' report.js \
  | grep -vE '^[0-9]+:\s*(//|\*|/\*)'

# Every mention of the network words, comments included. Expected output at
# the time of this build: 1 line(s), each a comment.
grep -nwE 'fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource' report.js
```

At the time of this build the second search returned:

```
3775:// with NO network fetch (fetching would broadcast click history off-device
```

The only browser API the file touches is `DOMParser`, for the HTML variant
of the export, and that use is guarded so the file also runs under Node,
which is how the test suite runs it. `tests/smoke.test.js` pins the same
searches as assertions.

### 2. Watch the wire: what the page around this file does

The parser making no network calls is the narrow, provable claim. It does not
follow that nothing leaves your browser when you use the site, and the site
does not claim that either. Its privacy policy says, in the section headed
"Your raw export never leaves your device":

> When you upload your data export, it's unzipped, parsed, and turned into
> your report entirely on your device. The raw file (your messages, photos,
> the whole ZIP) is never uploaded. Open your browser's Network tab while the
> report builds and watch. You'll see a small ping that a report ran, or, if
> your file could not be turned into a report, one saying it was refused and
> why, in a short fixed label; a second one counting how many offers matched,
> a request for our own offers file, brand logos loading from DuckDuckGo
> unless you've switched them off at the top of the report, and, if you are
> signed in, the automatic save described just below. That is the whole list.

Read the full text at <https://opt2in.com/privacy.html>; it also names what
the DuckDuckGo logo requests carry (the advertiser domain names from your
report, and your IP address) and what the Locations map (Apple) receives if
you open it. Two things in that list are worth repeating here because this
repository cannot vouch for them:

- the code that makes those requests (the logo loader, the counters, the
  offers file, the map) lives in the site's page and render layer, which is
  outside this repository;
- **a saved report is uploaded and stored.** If you are signed in when a
  report finishes, the analyzed report (the counts, the company names and
  the value math, never your messages, photos or the export file) is saved
  to your account. Run the report signed out and the save does not happen.

So the check that this repository supports is the first one: read the file.
The check that covers the whole page is the second one: watch the Network
tab, and compare what you see to the list the policy publishes.

### Diff against what the site is running

```sh
curl -s https://opt2in.com/report/instagram/report.js | diff - report.js && echo identical
curl -s https://opt2in.com/report/instagram/report.js | sha256sum
```

The site deploys on every change; this repository is refreshed deliberately.
**The site may run a newer version than the repository tip.** A diff that
shows changes means the repository is behind, not that something is hidden:
the served file is the authoritative one, it is readable in full in your
browser, and the checks above apply to it just the same. `.gitattributes`
forces LF line endings so that the diff is byte-exact on any operating
system.

## What it parses

`extractAll(files)` runs 37 extractors, one per section of
the report, and returns an object with 39 top-level
keys. The table is generated from the code at build time: the key each
extractor fills, the files it reads (paths relative to the export root), and
whether it can also read Meta's HTML export.

| Key | Extractor | Reads | HTML export |
|---|---|---|---|
| `window` | `extractWindow` | `your_instagram_activity/other_activity/your_information_download_requests.json` | partial |
| `identity` | `extractIdentity` | `personal_information/autofill_information/autofill_information.html`, `personal_information/autofill_information/autofill_information.json`, `personal_information/personal_information/personal_information.html`, `personal_information/personal_information/personal_information.json`, `security_and_login_information/login_and_profile_creation/signup_details.html`, `security_and_login_information/login_and_profile_creation/signup_details.json` | yes |
| `identity` (merged, from `instagram_profile_information`) | `extractInstagramProfileInfo` | `personal_information/personal_information/instagram_profile_information.json` | no |
| `identity` (merged, from `autofill`) | `extractAutofillFull` | `personal_information/autofill_information/autofill_information.json` | no |
| `export_request` | `extractDownloadRequest` | `your_instagram_activity/other_activity/your_information_download_requests.json` | no |
| `checkout_profile` | `extractCheckoutProfile` | `your_instagram_activity/shopping/checkout_payment_information.json` | no |
| `cart_items` | `extractCartItems` | `your_instagram_activity/shopping/cart_items.json` | no |
| `device_summary` | `extractDeviceSummary` | `personal_information/device_information/devices.json` | no |
| `device_fingerprint` | `extractDeviceFingerprint` | `personal_information/device_information/camera_information.json` | no |
| `location` | `extractLocation` | `personal_information/information_about_you/locations_of_interest.json`, `personal_information/information_about_you/profile_based_in.json`, `security_and_login_information/login_and_profile_creation/last_known_location.json` | no |
| `audience` | `extractAudience` | `logged_information/past_instagram_insights/audience_insights.html`, `logged_information/past_instagram_insights/audience_insights.json` | yes |
| `content_interactions` | `extractContentInteractions` | `logged_information/past_instagram_insights/content_interactions.json` | no |
| `profiles_reached` | `extractProfilesReached` | `logged_information/past_instagram_insights/profiles_reached.json` | no |
| `ai_interests` | `extractAIInterests` | `your_instagram_activity/ai/interest_categories.html`, `your_instagram_activity/ai/interest_categories.json` | yes |
| `topics` | `extractTopics` | `preferences/your_topics/recommended_topics.html`, `preferences/your_topics/recommended_topics.json` | yes |
| `ad_prefs` | `extractAdPreferences` | `ads_information/instagram_ads_and_businesses/ad_preferences.json` | no |
| `other_categories` | `extractOtherCategories` | `ads_information/instagram_ads_and_businesses/other_categories_used_to_reach_you.json` | no |
| `ads_about_meta` | `extractAdsAboutMeta` | `ads_information/instagram_ads_and_businesses/ads_about_meta.json` | no |
| `advertisers` | `extractAdvertisers` | `ads_information/instagram_ads_and_businesses/advertisers_using_your_activity_or_information.html`, `ads_information/instagram_ads_and_businesses/advertisers_using_your_activity_or_information.json` | yes |
| `off_meta` | `extractOffMeta` | `apps_and_websites_off_of_instagram/apps_and_websites/your_activity_off_meta_technologies.json` | yes |
| `link_history` | `extractLinkHistory` | `logged_information/link_history/link_history.json` | no |
| `shopping` | `extractShopping` | `your_instagram_activity/shopping/recently_viewed_items.json` | no |
| `subscription_status` | `extractSubscriptionStatus` | `your_instagram_activity/subscriptions/show_exclusive_story_promo_setting.json` | no |
| `likes_summary` | `extractLikesSummary` | `your_instagram_activity/likes/liked_comments.json`, `your_instagram_activity/likes/liked_posts.json` | no |
| `feed_impressions` | `extractFeedImpressions` | `ads_information/ads_and_topics/ads_clicked.json`, `ads_information/ads_and_topics/ads_viewed.json`, `ads_information/ads_and_topics/posts_viewed.json`, `ads_information/ads_and_topics/videos_watched.json` | no |
| `ad_impressions_detail` | `extractAdImpressionsDetail` | `ads_information/ads_and_topics/ads_viewed.json` | no |
| `clicked_ads` | `extractClickedAds` | `ads_information/ads_and_topics/ads_clicked.json` | no |
| `attention_mining` | `extractAttentionMining` | `ads_information/ads_and_topics/ads_viewed.json`, `ads_information/ads_and_topics/posts_viewed.json`, `ads_information/ads_and_topics/videos_watched.json` | no |
| `story_interactions` | `extractStoryInteractions` | `your_instagram_activity/story_interactions/stories_viewed.json`, `your_instagram_activity/story_interactions/story_likes.json` | no |
| `comments_posted` | `extractCommentsPosted` | matched by path pattern over the file list | no |
| `social_graph` | `extractSocialGraph` | `connections/followers_and_following/blocked_profiles.json`, `connections/followers_and_following/following.json`, `connections/followers_and_following/recent_follow_requests.json`, `connections/followers_and_following/recently_unfollowed_profiles.json` | no |
| `threads` | `extractThreads` | `your_instagram_activity/threads/blocked_profiles.json`, `your_instagram_activity/threads/followers.json`, `your_instagram_activity/threads/following.json`, `your_instagram_activity/threads/personal_information.json`, `your_instagram_activity/threads/recent_follow_requests.json`, `your_instagram_activity/threads/threads_viewed.json`, `your_instagram_activity/threads/word_or_phrase_searches.json` | no |
| `muted_creators` | `extractMutedCreators` | `your_instagram_activity/subscriptions/your_muted_story_teaser_creators.json` | no |
| `see_less_topics` | `extractSeeLessTopics` | `preferences/your_topics/your_ads_see_more/see_less_topics.json` | no |
| `cpm_tier` | `detectCpmTier` | `ads_information/ads_and_topics/ads_viewed.json`, `ads_information/ads_and_topics/posts_viewed.json`, `ads_information/ads_and_topics/videos_watched.json` | no |
| `privacy_callouts` | `extractPrivacyCallouts` | `connections/contacts/synced_contacts.html`, `connections/contacts/synced_contacts.json`, `connections/followers_and_following/close_friends.html`, `connections/followers_and_following/close_friends.json` | yes |
| `messages_summary` | `extractMessagesSummary` | matched by path pattern over the file list | yes |

`extracted` and `cpm_tier` are the site's value estimate: how many ad
impressions the export implies per year, priced at a base CPM that is
lowered for some locales. Those constants are in this file because they are
in the served file; they are the site's assumptions, not a benchmark, and the
report labels the result as an estimate.

### What it refuses

`loadZipFiles(zip)` walks the archive before anything is parsed and decides
whether it is an Instagram export at all. It looks for one of two folder
names, at the root or one folder deep: `your_instagram_activity/` or
`apps_and_websites_off_of_instagram/`. Then:

| Situation | Result |
|---|---|
| An Instagram anchor is found | Accepted. A wrapping root folder (`instagram-<user>-<date>-<id>/`) is stripped; backslash entry names from re-zipped exports are normalised; JSON files are parsed and mojibake-fixed; HTML files are kept as raw text. |
| Both an Instagram and a Facebook tree are present (a combined Accounts Center export) | Accepted as Instagram, whatever order the entries come in. |
| Only a Facebook tree is found | Refused, error code `WRONG_PLATFORM_FACEBOOK`. |
| No Instagram anchor at all | Refused, error code `NOT_AN_INSTAGRAM_EXPORT`. If Meta-style folders (`ads_information/`, `personal_information/`, ...) are present the message suggests a category-limited or media-only export; otherwise it says the archive does not look like an Instagram export and names the first few files it saw. |
| An Instagram anchor, but not a single `.json` or `.html` file | Refused, error code `NOT_A_RECOGNIZED_EXPORT`. |

The report refuses to render rather than produce a half-wrong Instagram
report from data that is not an Instagram export. `tests/load-zip-files.test.js`
covers every row of that table through a duck-typed fake ZIP.

## The HTML caveat

Meta offers the export as JSON or as HTML. This parser was written for JSON.
Of the 37 extractors, **8 can also
read the HTML pages**:

- `extractIdentity` (`identity`)
- `extractAudience` (`audience`)
- `extractAIInterests` (`ai_interests`)
- `extractTopics` (`topics`)
- `extractAdvertisers` (`advertisers`)
- `extractOffMeta` (`off_meta`)
- `extractPrivacyCallouts` (`privacy_callouts`)
- `extractMessagesSummary` (`messages_summary`)

`extractWindow` has a partial HTML mode (marked `partial` in the table): with
no download-request metadata to read, it assumes Meta's default 365-day
window ending on the export date in the ZIP's name and flags the result
`_inferred`. The other 28 extractors return their empty
shape on an HTML export, and the report says so on screen rather than
showing zeros as facts.

That gap is deliberate, not a to-do list. The per-event files (ads viewed,
posts viewed, videos watched, stories, likes, link taps) only ever had JSON
readers written for them, because JSON is the format Meta selects by default
and the one the report was built on. HTML pages carry the same events in a
layout that changes with Meta's redesigns and with the account's language;
reading them reliably would mean maintaining a second parser against a
moving target for a minority of uploads. If you want a full report, request
the JSON format.

## Design properties

**Per-extractor failure isolation.** `extractAll` wraps every extractor in
`safe()`. An extractor that throws, typically because Meta changed a file's
shape, does not take the report down: its error message is recorded under
`_extract_errors`, and the extractor is re-run against an empty archive so
that the section receives its own canonical empty shape, the same one a
missing file produces. One broken section, thirty-something intact ones.

**Honest empty shapes.** With no input at all, `extractAll({})` returns every
key with a shape that says "nothing here" rather than a plausible number:
`null` for a device that was never seen, `available: false` for a section
with no source file, `ad_annualized: false` when there is no window to
annualize over. `tests/extract-all-empty.test.js` pins each of them.

**Locale-agnostic reading.** Meta localizes the export into the account's
language, including the keys of `string_map_data` objects and the labels of
`label_values` entries. The extractors try the English key first and fall
back to structure and value patterns (the entry carrying a timestamp is the
time, the `http`-shaped value is the link, the field labelled `URL` keeps its
English name in every locale), so a Russian or Spanish export reads the same
as an English one.

**The mojibake fix.** Meta's JSON writes non-ASCII text double-encoded: the
UTF-8 bytes of a string appear as individual `\u00XX` escapes, so after
`JSON.parse` a Cyrillic or accented word is a run of Latin-1 characters that
are really bytes in disguise. `fixMetaMojibakeString` reinterprets such a
string's code points as bytes and decodes them as UTF-8, strictly: a string
that is not valid UTF-8 under that reading is returned unchanged, and a
string that already contains characters outside Latin-1 is never touched.
`fixMetaMojibakeDeep` applies it to every string in a parsed file, keys
included, at load time, so no extractor has to think about it.

**Only http(s) URLs pass through.** Every URL taken from the export goes
through `safeHttpUrl`, which drops anything that is not `http://` or
`https://`. A tampered archive cannot plant a `javascript:` link in a report.

## Running it

```sh
npm test
```

runs 36 tests under Node's built-in test runner
(`node --test`, Node 21 or newer, nothing to install). They need no real
export: `tests/fixture/export/` is a small synthetic export (Example Corp,
`example_user`, every date in January 2025; see `tests/fixture/README.md`)
that covers the main folders and is asserted against the recorded schema so
it cannot drift from the shapes Meta ships. The suite also runs
`extractAll({})` on nothing, the mojibake cases, and the archive-detection
rules above.

To run the same suite against your own export, unzip it and point the
loader at the folder that contains `your_instagram_activity/`:

```sh
IG_EXPORT_PATH=/path/to/your/unzipped/export npm test
```

Nothing is read from that path except by the tests, and nothing about it is
recorded anywhere.

### Using the parser

```js
const { loadZipFiles, extractAll } = require('./report.js');

// In a browser: `zip` is a JSZip instance. Anywhere else: any object with a
// `files` map whose entries expose `dir` and `async('string')` works; the
// parser is duck-typed and references no zip library. tests/_lib/fake-zip.js
// is one such object, and tests/_lib/load-export.js builds the same `files`
// dict straight from a directory.
const files = await loadZipFiles(zip, (done, total) => {}, 'instagram-....zip');
const report = extractAll(files);
```

`extractAll(files)` is the whole report. The other five exports are the pieces
it is built from, exported so a caller can use one without the rest:

- `loadZipFiles(zip, onProgress, filename)` — read a zip into the `files` dict
  every other function takes.
- `parseExportDate(files)` — the date Meta generated the export.
- `fixMetaMojibakeString(s)` / `fixMetaMojibakeDeep(obj)` — repair Meta's
  double-encoded UTF-8, in one string or throughout a structure.
- `extractSocialGraph(files)` — followers, following, and who does not follow
  back. Returns an honest empty shape when the export's follower list is
  incomplete, which Meta does ship: it reports what it found rather than
  guessing at the difference.

Under Node there is no `DOMParser`, so the HTML branches return their empty
shapes; the JSON path is complete.

### Schema drift

`tests/meta-schema-snapshot.json` records the shape of a real export: its
folder tree (23 folders), its JSON files
(50), and each file's top-level keys. Never a value. It
is the canary for the failure mode that hurts most: Meta renames a file or a
key, the extractor that read it quietly returns its empty shape, and nothing
throws.

```sh
IG_EXPORT_PATH=/path/to/export npm run schema-check    # diff your export's shape against the snapshot
IG_EXPORT_PATH=/path/to/export npm run schema-update   # accept a new baseline
npm run schema-check                                    # no export: check the fixture against the snapshot
```

`scripts/schema-check.js` documents exactly what is compared. The messages
tree is excluded on purpose (its folder names are per conversation), and
`--update` is refused when there is no real export, so the synthetic fixture
can never overwrite the recorded shape.

## Why one file

`report.js` is one file of 4345 lines: an IIFE with about thirty
private helpers, the 37 extractors, the `extractAll`
orchestrator, and a six-function export guarded on `typeof module`. It is
not split because the site has no build step, and without a bundler
closure-scoped helpers cannot cross `<script>` files except through a global
namespace and a load-order contract, which is a worse structure than one long
file with a table of contents. It will be split when one of these becomes
true: a second platform's parser needs to share the helpers; the file passes
10,000 lines; or the codebase gains a second regular contributor. None is
true today. Keeping it as one file here also keeps the check that matters a
one-line `diff`.

## Changes since 1.0.0

**2.0.1** — removals only, no API change. A 53-entry advertiser-name → domain
table and the `appDomain()` helper it fed are gone. The helper had no caller, so
nothing changes for a consumer; the table went because its membership described
one person's advertisers rather than anything about parsing. Domains still come
from the export's own link URLs. Comments no longer cite internal repository
paths.


**2.0.0** — the first refresh since the 2026-09-02 publish. Breaking, because
the report object lost fields:

- `computeMoney` no longer emits `annual_impressions` or `ad_revenue`. Nothing
  is lost: `annual_impressions` is the same number as the impression count the
  report already carries, and `ad_revenue` was a second name for `total`.
- New export: `extractSocialGraph(files)` — followers, following, and who does
  not follow back. It returns an honest empty shape when Meta's export ships an
  incomplete follower list, which it does; it reports what it found rather than
  guessing at the difference.
- `scripts/schema-check.js` no longer defines its own shape rule. The rule now
  ships as `scripts/_meta-shape.js`, copied from the same source the parser's
  own checks use, so the two cannot drift apart.

If you cloned 1.0.0 and read either removed field, derive it as described above
before upgrading.

## License

AGPL-3.0-only. Copyright OPT2IN LLC. The full text is in [LICENSE](LICENSE).
The parser also ships inside Opt2In's iOS app under separate terms, which is
why external changes are not merged here (see
[CONTRIBUTING.md](CONTRIBUTING.md)); the AGPL binds licensees, not the
licensor, so the two coexist as long as every line stays OPT2IN LLC's own.
