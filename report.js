// report/instagram/report.js — Instagram report engine.
// Browser-only. Depends on JSZip (already loaded in index.html).
// Parses an Instagram ZIP export and renders the V2 dashboard data
// shape consumed by report/instagram/v2/v2-discovery.jsx.
(function () {
  'use strict';

  // ===========================================================================
  // Constants (ported from generate.py)
  // ===========================================================================
  //
  // Platform model — every report is ALWAYS for exactly one platform at a time.
  // When we add Facebook, its upload flows through the same engine but tagged as
  // { id: 'facebook', parent: 'Meta', ... }. "Meta" only appears in the report
  // when we're explicitly talking about the parent company / Meta-branded products
  // (Meta Accounts Center, Off-Meta Activity, Ads About Meta). Platform-specific
  // revenue claims always use the specific platform name so an Instagram report
  // doesn't conflate itself with a Facebook one.
  // Every platform entry should be self-describing: folder anchors (used by
  // loadZipFiles to detect the archive type), CPM (ad economics), live URLs
  // (export request / account center / delete), and `available` (whether the
  // parser is wired up for this platform yet). To add a new platform, drop a
  // new entry in here, set `available: false` until the parser lands, then
  // flip to true when it does — no changes needed in loadZipFiles or the
  // error handling.
  const PLATFORMS = {
    instagram: {
      id: 'instagram', name: 'Instagram', parent: 'Meta',
      available: true,
      cpm: 12, cpm_label: 'Instagram CPM',
      icon_domain: 'instagram.com',
      // Platform-specific product names used in user-facing copy
      shop_product: 'Instagram Shop',
      dm_product: 'Instagram DM',
      // Folder anchors — presence of any of these at the root (or one level
      // deep) of the ZIP identifies this platform's archive. Source of truth;
      // loadZipFiles builds its detection list from here.
      anchors: [
        'your_instagram_activity/',
        'apps_and_websites_off_of_instagram/',
      ],
      request_export_url: 'https://www.instagram.com/download/request/',
      account_center_url: 'https://accountscenter.meta.com/',
      delete_account_url: 'https://accountscenter.meta.com/info_and_permissions/delete_account/',
      manage_contacts_url: 'https://www.instagram.com/accounts/manage_contacts/',
      off_app_setting_url: 'https://accountscenter.meta.com/off-facebook-activity/',
      ad_prefs_url: 'https://accountscenter.meta.com/ad_preferences/',
      cross_platform_note: 'Data may be shared with other Meta apps (Facebook, Threads, WhatsApp) under Meta&rsquo;s cross-app framework.',
    },
    facebook: {
      id: 'facebook', name: 'Facebook', parent: 'Meta',
      available: false, // parser not yet wired — archives are rejected by the strict guard
      cpm: 8.5, cpm_label: 'Facebook CPM',
      icon_domain: 'facebook.com',
      shop_product: 'Facebook Marketplace',
      dm_product: 'Messenger',
      anchors: [
        'your_facebook_activity/',
        'apps_and_websites_off_of_facebook/',
      ],
      request_export_url: 'https://www.facebook.com/dyi/',
      account_center_url: 'https://accountscenter.meta.com/',
      delete_account_url: 'https://accountscenter.meta.com/info_and_permissions/delete_account/',
      manage_contacts_url: 'https://www.facebook.com/mobile/facebook/contacts/',
      off_app_setting_url: 'https://accountscenter.meta.com/off-facebook-activity/',
      ad_prefs_url: 'https://accountscenter.meta.com/ad_preferences/',
      cross_platform_note: 'Data may be shared with other Meta apps (Instagram, Threads, WhatsApp) under Meta&rsquo;s cross-app framework.',
    },
  };

  // Shared folder anchors — present in both IG and FB archives. Used only to
  // confirm "this looks like a Meta-family export" when the platform-specific
  // anchors haven't matched yet, so we can give a better error message.
  const SHARED_META_ANCHORS = [
    'ads_information/',
    'personal_information/',
    'connections/',
    'preferences/',
    'logged_information/',
    'security_and_login_information/',
  ];
  // Active platform for the current report — defaults to Instagram; detection
  // logic in loadZipFiles() overwrites this when we identify a Facebook archive.
  let ACTIVE_PLATFORM = PLATFORMS.instagram;

  const IG_BASE_CPM = 12;  // kept for back-compat refs; ACTIVE_PLATFORM.cpm is canonical
  const ADS_SEEN_PER_LIKE = 3;

  // A 53-entry advertiser-name -> domain table used to live here, feeding an
  // appDomain() helper just below it. Both are gone (2026-09-09).
  //
  // The table had to go because its MEMBERSHIP was the leak: those 53 were the
  // advertisers that happened to appear in ONE person's export, so the list read
  // as a profile of them -- the games they played, the dating app they used, the
  // supplements they bought, the city their train line runs through. A reader
  // learned nothing about parsing and something about a stranger. Same shape as
  // the ~165 handles removed from clusterAdImpressions in 2026-07. The parser
  // carries no real-world data.
  //
  // Nothing regressed, because appDomain() had NO caller anywhere in the repo.
  // Real domains come from the link URLs in the export itself, parsed with
  // `new URL(...).hostname` in extractAdImpressions -- the correct source, and
  // untouched by this. If favicon coverage for named-but-not-domain advertisers
  // is ever wanted, it needs public reference data, not one archive.

  const EVENT_GLOSSARY = {
    'PURCHASE': 'Completed a purchase on their site/app',
    'INITIATE_CHECKOUT': 'Started checkout but may not have completed',
    'ADD_TO_CART': 'Added something to cart',
    'ADD_PAYMENT_INFO': 'Entered payment details',
    'PAGE_VIEW': 'Viewed a page',
    'VIEW_CONTENT': 'Viewed specific content (product, article, etc.)',
    'SEARCH': 'Performed a search',
    'ACTIVATE_APP': 'Opened their mobile app',
    'CUSTOM': 'Custom event defined by the brand',
    'LEAD': 'Submitted a lead form',
    'COMPLETE_REGISTRATION': 'Completed signup',
    'CONTACT': 'Made contact (form, call, message)',
    'SCHEDULE': 'Scheduled an appointment',
    'SUBSCRIBE': 'Subscribed to a service',
    'DONATE': 'Made a donation',
    'CUSTOMIZE_PRODUCT': 'Customized a product',
    'AD_IMPRESSION': 'Saw an ad on their platform',
    'AD_REQUEST': 'Their system requested to show you an ad',
    'RESULT_SENT': 'Received a result/output',
    'GRANT': 'Granted permission (usually OAuth)',
    'GEN_RESPONSE': 'AI/system generated a response to your input',
    'SUCCESS': 'Completed an action successfully',
    'EXPIRED_IMPRESSION': 'An ad impression that expired before being served',
    'IMPRESSION': 'Impression event (ad served)',
  };

  // ===========================================================================
  // Helpers
  // ===========================================================================
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Allow only http(s) URLs from export data into link fields. A tampered
  // archive can carry javascript: URIs in advertiser/profile URL fields —
  // esc() does not neutralize the scheme, and neither React's href={} nor
  // our CSP blocks javascript: navigation on click. Applied at extraction
  // so every consumer (legacy render, V2 jsx, saved summaries) is covered.
  function safeHttpUrl(u) {
    const s = String(u || '').trim();
    return /^https?:\/\//i.test(s) ? s : '';
  }

  // Locale-agnostic per-entry timestamp for the ads_and_topics streams:
  // e.timestamp first, then string_map_data."Time" (English exports), then
  // ANY string_map_data value carrying a timestamp (non-English exports
  // localize the key name), then string_list_data. Without the generic
  // fallback, localized exports read as "no window" and downstream math
  // degraded to estimates / fabricated defaults.
  function entryTimestamp(e) {
    if (!e) return 0;
    if (e.timestamp) return e.timestamp;
    const sm = e.string_map_data;
    if (sm && typeof sm === 'object') {
      if (sm.Time && sm.Time.timestamp) return sm.Time.timestamp;
      for (const k in sm) {
        const v = sm[k];
        if (v && v.timestamp) return v.timestamp;
      }
    }
    for (const s of (e.string_list_data || [])) if (s.timestamp) return s.timestamp;
    return 0;
  }

  // Locale-agnostic {name, username, url} out of a label_values item, or null
  // if this item isn't an owner block.
  //
  // Meta emits the post/story/ad owner as a label_values item whose inner dict
  // carries Name / Username / URL. Key off STRUCTURE rather than the localized
  // "Owner" title (other locales translate it), but structure ALONE is not
  // enough — see the Hashtags hazard below. English exports label the inner
  // fields Name/Username/URL; other locales translate Name and Username while
  // "URL" stays constant, so any field the label doesn't name is classified by
  // value: the URL-shaped one is the bio link, and of the leftover text values
  // the Instagram-handle-shaped one is the username (Meta emits Name before
  // Username, so the last text value is the handle when both look handle-shaped)
  // and the other is the display name.
  //
  // THE HASHTAGS HAZARD (2026-08-02 — a regression this helper itself shipped,
  // caught before it reached a user report). The first version of this comment
  // asserted "a sibling Hashtags block is an empty dict, excluded by the
  // dict[0].dict guard". That is FALSE for real exports: a large share of
  // stories_viewed.json entries carry a POPULATED Hashtags block that appears
  // BEFORE the Owner block, shaped as N dict GROUPS of a single
  // {label:'Name', value:'<tag>'} field and no URL — structurally
  // indistinguishable from an owner card unless you look at what it yields.
  // Taking the first populated dict therefore picked Hashtags, produced no
  // username, and the callers' `if (owner && owner.username)` dropped the row,
  // roughly halving the unique-creator count on both posts+videos and stories.
  //
  // So the contract is now: a block is an owner block ONLY if it yields a
  // USERNAME. Two guards enforce that, and both matter —
  //   1. return null when no username was resolved, so a Hashtags block is
  //      skipped and the loop reaches the real Owner block. This also makes
  //      first-wins and last-wins call sites converge, which is why the three
  //      call sites no longer have to agree on iteration order.
  //   2. the localized leftover-text heuristic only runs when the block LOOKS
  //      like an owner card (it carries a link, or it has both a display name
  //      and a handle). Without this, a LOCALIZED Hashtags block — whose
  //      single value is handle-shaped, e.g. "solotravel" — would mint that
  //      hashtag as a username and fabricate a creator.
  function ownerFromLabelValue(lv) {
    if (!lv || !lv.dict || !lv.dict[0] || !lv.dict[0].dict) return null;
    const o = { name: '', username: '', url: '' };
    const text = [];
    for (const f of lv.dict[0].dict) {
      const fu = safeHttpUrl(f.value);
      if (f.label === 'Name') o.name = f.value || '';
      else if (f.label === 'Username') o.username = f.value || '';
      else if (f.label === 'URL') o.url = fu;
      else if (fu) { if (!o.url) o.url = fu; }
      else if (typeof f.value === 'string' && f.value.trim()) text.push(f.value.trim());
    }
    // Guard 2 — only an owner-shaped block may mint a handle from leftovers.
    if (!o.username && text.length && (o.url || text.length >= 2)) {
      const handles = text.filter((s) => /^[a-z0-9._]{1,30}$/i.test(s));
      o.username = handles.length === 1 ? handles[0] : text[text.length - 1];
    }
    if (!o.name && text.length) {
      o.name = text.find((s) => s !== o.username) || o.username;
    }
    // Guard 1 — no handle means this was not the owner.
    return o.username ? o : null;
  }

  // Pick the owner out of a whole entry's label_values. Prefers an explicitly
  // titled Owner block, falls back to the first block that yields a handle.
  function ownerFromLabelValues(lvs) {
    let fallback = null;
    for (const lv of (lvs || [])) {
      const o = ownerFromLabelValue(lv);
      if (!o) continue;
      const t = String((lv.title || lv.label) || '');
      if (t === 'Owner' || t === 'Автор' /* RU */) return o;
      if (!fallback) fallback = o;
    }
    return fallback;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }


  function parseExportDate(files) {
    // Try the root prefix first (for ZIPs that wrap everything in instagram-<user>-<date>/)
    const root = (files && files._rootPrefix) || '';
    let m = root.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    // Try the zip filename (handles unwrapped ZIPs like instagram-username-2026-04-20-xxx.zip)
    const name = (files && files._zipFilename) || '';
    m = name.match(/(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    // Last resort: today
    const d = new Date();
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function formatDisplayDate(iso) {
    if (!iso) return '';
    try {
      const [Y, M, D] = iso.split('-').map(Number);
      const months = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];
      return months[M - 1] + ' ' + D + ', ' + Y;
    } catch (e) { return iso; }
  }

  function fmtInt(n) {
    if (n === null || n === undefined) return '';
    return Number(n).toLocaleString('en-US');
  }

  // ===========================================================================
  // Meta JSON mojibake recovery — Meta's IG export double-encodes non-ASCII
  // text. The JSON file contains ASCII escape sequences like `\u00d0\u009d`
  // which JSON.parse decodes to Latin-1 characters. Those Latin-1 characters
  // are actually UTF-8 bytes in disguise. We recover the original text by
  // reinterpreting the character codepoints as UTF-8 bytes and decoding.
  //
  // Detection: a string that contains ANY character in U+0080-U+00FF (the
  // Latin-1 supplement range) is a candidate. If reinterpreting the codepoints
  // as UTF-8 bytes produces a valid UTF-8 decode, that's the correct text.
  //
  // Safe for ASCII-only strings (early return), safe for emoji/CJK-already-
  // correctly-encoded strings (decoding will throw, we preserve original).
  // ===========================================================================
  function fixMetaMojibakeString(s) {
    if (typeof s !== 'string' || !s) return s;
    // Fast path: ASCII-only or no Latin-1-range chars → no mojibake possible
    let hasLatin1 = false;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x80 && c <= 0xFF) { hasLatin1 = true; break; }
      if (c > 0xFF) { /* proper Unicode already, don't touch */ return s; }
    }
    if (!hasLatin1) return s;
    // Reinterpret each codepoint as a byte and decode as UTF-8
    try {
      const bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c > 0xFF) return s; // shouldn't happen given the guard above
        bytes[i] = c;
      }
      // `fatal: true` makes the decoder throw on invalid UTF-8 sequences so
      // we can keep the original string rather than produce garbage.
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      return s;
    }
  }
  function fixMetaMojibakeDeep(obj) {
    if (obj == null) return obj;
    if (typeof obj === 'string') return fixMetaMojibakeString(obj);
    if (Array.isArray(obj)) return obj.map(fixMetaMojibakeDeep);
    if (typeof obj === 'object') {
      const out = {};
      for (const k of Object.keys(obj)) {
        // Keys ALSO need mojibake fix (string_map_data keys are localized)
        const fixedKey = fixMetaMojibakeString(k);
        out[fixedKey] = fixMetaMojibakeDeep(obj[k]);
      }
      return out;
    }
    return obj;
  }

  // ===========================================================================
  // ZIP loading
  // ===========================================================================
  async function loadZipFiles(zip, progressCb, zipFilename) {
    // CRITICAL: Reset ACTIVE_PLATFORM at the very start so a failed-then-retried
    // upload can never inherit stale state from a previous run. A user who first
    // tries a Facebook ZIP (error) then tries an Instagram ZIP would otherwise
    // get Facebook labels on an Instagram report.
    ACTIVE_PLATFORM = PLATFORMS.instagram;
    // Normalize Windows-style backslash separators. Meta's own ZIPs use '/',
    // but users re-zip unzipped exports with PowerShell/Explorer (e.g. after
    // the download link expires) and those archives carry '\' entry names —
    // which used to hard-fail platform detection on a perfectly valid
    // export. Keep a map back to the original entry name for zip lookups.
    const _originalPath = {};
    const allPaths = Object.keys(zip.files).map(p => {
      const n = p.indexOf('\\') >= 0 ? p.replace(/\\/g, '/') : p;
      _originalPath[n] = p;
      return n;
    });
    const zipEntry = (normPath) => zip.files[_originalPath[normPath] || normPath];
    // Build the detection list from each PLATFORMS entry's `anchors` field
    // (platform-specific) plus the SHARED_META_ANCHORS list (platform:null,
    // used only to detect "this is some kind of Meta archive" for better
    // error copy). Order: platform-specific first so they take precedence.
    const PLATFORM_ANCHORS = [];
    for (const platformId of Object.keys(PLATFORMS)) {
      for (const folder of (PLATFORMS[platformId].anchors || [])) {
        PLATFORM_ANCHORS.push({ folder, platform: platformId });
      }
    }
    for (const folder of SHARED_META_ANCHORS) {
      PLATFORM_ANCHORS.push({ folder, platform: null });
    }
    let rootPrefix = '';
    let detectedPlatform = null;
    let anyMetaAnchorSeen = false;
    // First pass: look for platform-identifying anchors. Combined Accounts
    // Center exports can contain BOTH an Instagram and a Facebook tree in
    // one archive — scan the whole archive and prefer the available platform
    // (Instagram) instead of letting ZIP entry order decide which tree
    // "wins" (entry order used to hard-reject valid IG data when a Facebook
    // folder happened to come first).
    const foundPlatforms = {}; // platformId → rootPrefix of first match
    for (const path of allPaths) {
      for (const anchor of PLATFORM_ANCHORS) {
        if (!anchor.platform) {
          if (path.indexOf('/' + anchor.folder) >= 0 || path.startsWith(anchor.folder)) {
            anyMetaAnchorSeen = true;
          }
          continue;
        }
        if (foundPlatforms[anchor.platform] !== undefined) continue;
        const idx = path.indexOf('/' + anchor.folder);
        if (idx >= 0) {
          foundPlatforms[anchor.platform] = path.substring(0, idx + 1);
          continue;
        }
        if (path.startsWith(anchor.folder)) {
          foundPlatforms[anchor.platform] = '';
        }
      }
      // The preferred platform was found — no need to keep scanning.
      if (foundPlatforms.instagram !== undefined) break;
    }
    // Available platforms take precedence over coexisting unsupported trees.
    const platformPreference = Object.keys(PLATFORMS).sort((a, b) =>
      (PLATFORMS[b].available ? 1 : 0) - (PLATFORMS[a].available ? 1 : 0));
    for (const pid of platformPreference) {
      if (foundPlatforms[pid] !== undefined) {
        detectedPlatform = pid;
        rootPrefix = foundPlatforms[pid];
        break;
      }
    }
    // STRICT GUARD: only accept archives from platforms flagged `available:true`
    // in PLATFORMS config. Reject every other case with a clear error so the
    // user doesn't get a half-broken report generated from unsupported data.
    // No silent fallback — if a future platform lands, flip `available:true`
    // in its PLATFORMS entry.
    if (detectedPlatform && PLATFORMS[detectedPlatform] && !PLATFORMS[detectedPlatform].available) {
      const detected = PLATFORMS[detectedPlatform];
      const err = new Error(
        'This looks like a ' + detected.name + ' data export. Opt2In currently only supports Instagram reports. ' +
        detected.name + ' support is coming soon — upload an Instagram export for now.'
      );
      err.code = 'WRONG_PLATFORM_' + detected.id.toUpperCase();
      throw err;
    }
    if (!detectedPlatform) {
      // No platform-specific anchors at all. Could be a random ZIP, a Google
      // Takeout, a Twitter archive, or an unusual Meta variant. Fail loudly.
      const sample = allPaths.slice(0, 8).map(p => p.split('/').slice(-1)[0]).filter(Boolean).join(', ');
      const hint = anyMetaAnchorSeen
        ? 'The archive has Meta-style folders but no Instagram-specific ones (your_instagram_activity/, apps_and_websites_off_of_instagram/). Two common causes: (1) a category-limited export — re-request with "All available information" selected; (2) a media-only part of a multi-part export — upload the part that contains your activity data. Also confirm "Instagram" was selected in Accounts Center.'
        : 'The archive does not look like a standard Instagram export. Re-download from accountscenter.meta.com with "Instagram" selected and "JSON" as the format.';
      const err = new Error(
        'Not an Instagram export. ' + hint + (sample ? ' (First files seen: ' + sample + ')' : '')
      );
      err.code = 'NOT_AN_INSTAGRAM_EXPORT';
      throw err;
    }
    ACTIVE_PLATFORM = PLATFORMS[detectedPlatform] || PLATFORMS.instagram;
    console.log('[Opt2In] Detected platform:', ACTIVE_PLATFORM.name, '| root prefix:', JSON.stringify(rootPrefix));
    const files = {
      _rootPrefix: rootPrefix,
      _platformId: ACTIVE_PLATFORM.id,
      _platformName: ACTIVE_PLATFORM.name,
      _platformParent: ACTIVE_PLATFORM.parent,
    };
    const jsonEntries = allPaths.filter(p => p.endsWith('.json') && !zipEntry(p).dir);
    const htmlEntries = allPaths.filter(p => p.endsWith('.html') && !zipEntry(p).dir);

    // Fail if the archive has neither JSON nor HTML — not a recognizable export.
    if (jsonEntries.length === 0 && htmlEntries.length === 0) {
      const err = new Error(
        'No JSON or HTML data files found in this archive (' + allPaths.length + ' entries scanned). ' +
        'This does not look like a standard ' + ACTIVE_PLATFORM.name + ' data export. ' +
        'Please re-download from accountscenter.meta.com, selecting "' + ACTIVE_PLATFORM.name + '" + "JSON" format.'
      );
      err.code = 'NOT_A_RECOGNIZED_EXPORT';
      throw err;
    }

    // Record which formats are present so the renderer can show a banner when HTML-only.
    files._hasJson = jsonEntries.length > 0;
    files._hasHtml = htmlEntries.length > 0;
    files._format = jsonEntries.length > 0
      ? (htmlEntries.length > 0 ? 'mixed' : 'json')
      : 'html';
    files._zipFilename = zipFilename || '';
    console.log('[Opt2In] Archive format:', files._format,
                '| JSON files:', jsonEntries.length,
                '| HTML files:', htmlEntries.length);

    // Load JSON files (primary path — these parse to full structured data).
    // CRITICAL: Meta's JSON export has a long-standing bug where non-ASCII text
    // is double-escaped. The file literally contains ASCII sequences like
    // `\u00d0\u009d` instead of the proper Unicode codepoint `\u041d` for the
    // Cyrillic letter "Н". After JSON.parse, those escape sequences become
    // Latin-1 characters (U+0080-U+00FF) that are actually UTF-8 BYTES in
    // disguise. We detect this and reinterpret them as UTF-8 to recover the
    // real text ("Неверно" instead of "ÐÐµÐ²ÐµÑÐ½Ð¾").
    //
    // This affects Russian, Chinese, Japanese, Arabic, Spanish (accented chars),
    // etc. — every non-English-locale export. English exports are ASCII-only
    // so the fix is a no-op for them.
    const total = jsonEntries.length + htmlEntries.length;
    let done = 0;
    for (const path of jsonEntries) {
      const entry = zipEntry(path);
      try {
        const text = await entry.async('string');
        const relPath = path.startsWith(rootPrefix) ? path.substring(rootPrefix.length) : path;
        const parsed = JSON.parse(text);
        files[relPath] = fixMetaMojibakeDeep(parsed);
      } catch (e) { /* skip malformed */ }
      done++;
      if (progressCb && (done % 20 === 0 || done === total)) progressCb(done, total);
    }

    // Load HTML files (fallback path — only the critical extractors know how to parse these)
    for (const path of htmlEntries) {
      const entry = zipEntry(path);
      try {
        const text = await entry.async('string');
        const relPath = path.startsWith(rootPrefix) ? path.substring(rootPrefix.length) : path;
        // Store raw HTML text keyed by .html path — extractors parse on demand via DOMParser
        files[relPath] = { _html: text };
      } catch (e) { /* skip malformed */ }
      done++;
      if (progressCb && (done % 20 === 0 || done === total)) progressCb(done, total);
    }
    // Cache list of inbox conversation folders (for messages_summary)
    const inboxPrefix = 'your_instagram_activity/messages/inbox/';
    const convoSet = new Set();
    for (const path of allPaths) {
      const rel = path.startsWith(rootPrefix) ? path.substring(rootPrefix.length) : path;
      if (rel.startsWith(inboxPrefix)) {
        const remainder = rel.substring(inboxPrefix.length);
        const slash = remainder.indexOf('/');
        if (slash > 0) convoSet.add(remainder.substring(0, slash));
      }
    }
    files._inboxConvoFolders = Array.from(convoSet);
    // Cache list of message_request folders
    const mrPrefix = 'your_instagram_activity/messages/message_requests/';
    const mrSet = new Set();
    for (const path of allPaths) {
      const rel = path.startsWith(rootPrefix) ? path.substring(rootPrefix.length) : path;
      if (rel.startsWith(mrPrefix)) {
        const remainder = rel.substring(mrPrefix.length);
        const slash = remainder.indexOf('/');
        if (slash > 0) mrSet.add(remainder.substring(0, slash));
      }
    }
    files._messageRequestFolders = Array.from(mrSet);
    return files;
  }

  function loadJson(files, relPath) {
    const v = files[relPath];
    // Only return if it's real JSON (object/array), not an HTML stub
    if (v && !v._html) return v;
    return null;
  }

  // ===========================================================================
  // HTML fallback helpers — used only when the archive is HTML-format
  // ===========================================================================
  function loadHtmlDoc(files, relPath) {
    // Node-safety: DOMParser is browser-only. HTML branches gracefully bail.
    if (typeof DOMParser === 'undefined') return null;
    // Try the exact path with .html extension; if not found, swap .json → .html
    const htmlPath = relPath.endsWith('.json') ? relPath.slice(0, -5) + '.html' : relPath;
    const v = files[htmlPath];
    if (!v || !v._html) return null;
    try {
      return new DOMParser().parseFromString(v._html, 'text/html');
    } catch (e) { return null; }
  }

  // ===========================================================================
  // Locale-agnostic JSON helpers — Meta's export localizes BOTH string_map_data
  // keys AND label_values labels based on user's IG language setting. English
  // exports use `sm.Email`, Russian exports use `sm["Электронный адрес"]`. For
  // label_values files (ad_preferences, advertisers_*, ads_about_meta, etc.),
  // Meta also wraps data in a positional array where [0] is always the primary
  // record, regardless of locale. We use position + value-pattern matching to
  // extract data without depending on English label strings.
  // ===========================================================================

  // Return the first value in a string_map_data object, regardless of key name.
  // Useful for files where only one field exists (e.g. recommended_topics entries).
  function smFirstValue(sm) {
    if (!sm) return '';
    const keys = Object.keys(sm);
    if (!keys.length) return '';
    return (sm[keys[0]] || {}).value || '';
  }

  // For label_values-wrapped files: find the first entry whose `vec` has at least
  // `minSize` items (or any non-empty vec if minSize not given). Locale-agnostic.
  function lvFirstWithVec(labelValues, minSize) {
    if (!Array.isArray(labelValues)) return null;
    for (const entry of labelValues) {
      if (entry && Array.isArray(entry.vec) && entry.vec.length >= (minSize || 1)) return entry;
    }
    return null;
  }

  // For label_values: find the first entry whose `value` field is set.
  function lvFirstWithValue(labelValues) {
    if (!Array.isArray(labelValues)) return null;
    for (const entry of labelValues) {
      if (entry && typeof entry.value === 'string' && entry.value.length) return entry;
    }
    return null;
  }

  // For label_values: find the first entry whose `timestamp_value` is set.
  function lvFirstWithTimestamp(labelValues) {
    if (!Array.isArray(labelValues)) return null;
    for (const entry of labelValues) {
      if (entry && entry.timestamp_value) return entry;
    }
    return null;
  }

  // Parse Meta's boolean strings in multiple locales.
  // English: "True" / "False". Russian: "Верно" / "Неверно". Spanish: "Verdadero"/"Falso". German: "Wahr"/"Falsch".
  // Note: JS regex /i flag only case-folds ASCII unless combined with /u. We
  // avoid the complexity by lowercasing the input manually via toLocaleLowerCase,
  // which handles Unicode case correctly (Н → н) across all locales.
  function parseMetaBool(s) {
    if (s == null) return null;
    const v = String(s).trim().toLocaleLowerCase();
    if (!v) return null;
    // Known truthy markers — EXACT match only. The old unanchored prefixes
    // (y, n, si, ja, да…) swallowed any username or display name starting
    // with those letters ("yana_k" → true, "Nina" → false), fabricating
    // phone_confirmed/private values and losing the name from the report.
    if (/^(true|yes|y|verno|верно|verdadero|vero|si|sí|sim|ja|wahr|да|oui|vrai)$/.test(v)) return true;
    if (/^(false|no|n|neverno|неверно|falso|nao|não|nein|non|nicht|falsch|нет|faux)$/.test(v)) return false;
    return null;
  }

  // Collect all "line items" — each rendered block of data in the HTML export
  // that represents one record (one advertiser, one app, one topic, etc.).
  // Meta wraps each record in a div with its own label/value block.
  function collectLineItems(doc, opts) {
    opts = opts || {};
    if (!doc || !doc.body) return [];
    // Meta uses a structure where each record is its own small container.
    // We look for divs that contain a single leaf text child (the record name/label).
    const items = [];
    const seen = new Set();
    const candidates = doc.body.querySelectorAll('div, li');
    candidates.forEach(el => {
      const text = (el.textContent || '').trim();
      if (!text || text.length < 2 || text.length > 200) return;
      // Skip if this element has children with their own text — we only want
      // leaves. (This guard was computed but never applied, letting section
      // headers / page chrome from mixed containers register as records.)
      const hasTextChildren = Array.from(el.children).some(c =>
        c.children.length === 0 && (c.textContent || '').trim().length > 0
      );
      if (hasTextChildren) return;
      // Use direct text content — the el's immediate text without descendant text
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === 3)
        .map(n => n.nodeValue.trim())
        .join(' ')
        .trim();
      const candidateText = directText || (el.children.length === 0 ? text : '');
      if (!candidateText) return;
      if (seen.has(candidateText)) return;
      if (opts.filter && !opts.filter(candidateText)) return;
      seen.add(candidateText);
      items.push(candidateText);
    });
    return items;
  }

  // ===========================================================================
  // Extractors (port of generate.py extract_* functions)
  // ===========================================================================
  // Derive the alias/computed fields every consumer of data.window expects.
  // Three consumers read three different key sets (v2-data-adapter buildWindow:
  // days/start_iso/end_iso/download_attempts; v2-export-structure-data:
  // window_days/start_ts/end_ts/media_quality/export_date_iso; legacy render:
  // start/end). Emit the superset here so no consumer falls back to a
  // fabricated default. Meta's "all available history" exports use a start
  // sentinel around 1905 (negative unix ts) — anything before 2010 (Instagram
  // founding) cannot be a real window start, so flag it instead of computing
  // a ~44,000-day window.
  function deriveWindowFields(out) {
    const SENTINEL_CUTOFF = 1262304000; // 2010-01-01
    const isoOf = (ts) => {
      const dd = new Date(ts * 1000);
      return isNaN(dd.getTime()) ? '' : dd.toISOString().slice(0, 10);
    };
    const startOk = !!(out.start && out.start > SENTINEL_CUTOFF);
    if (out.start != null && out.start !== 0 && !startOk) out.all_history = true;
    if (startOk && out.end && out.end > out.start) {
      out.days = Math.max(1, Math.round((out.end - out.start) / 86400));
      out.window_days = out.days;
    }
    if (startOk) { out.start_iso = isoOf(out.start); out.start_ts = out.start; }
    if (out.end) { out.end_iso = isoOf(out.end); out.end_ts = out.end; }
    if (out.attempts != null && out.download_attempts == null) out.download_attempts = out.attempts;
    if (out.quality && !out.media_quality) out.media_quality = out.quality;
    if (!out.export_date_iso && out.completion_ts) out.export_date_iso = isoOf(out.completion_ts);
    return out;
  }

  function extractWindow(files) {
    const d = loadJson(files, 'your_instagram_activity/other_activity/your_information_download_requests.json');
    if (d) {
      // label_values entries in Meta's export follow a stable ORDER regardless
      // of locale. Labels are localized so we can't match by string. Inferred
      // order (verified against a non-English export):
      //   [0] Request completion time (timestamp_value)
      //   [1] How many times did you try to download (value: string number)
      //   [2] Start date (timestamp_value)
      //   [3] End date (timestamp_value)
      //   [4] Types of information (empty vec for standard export)
      //   [5-6] Media quality, Output format (value)
      //   [7] Have you seen this archive? (value)
      const lv = {};
      // Try English label match first (fast path for English users)
      for (const e of (d.label_values || [])) lv[e.label] = e;
      const out = {
        start: (lv['Start date'] || {}).timestamp_value,
        end: (lv['End date'] || {}).timestamp_value,
        request_ts: d.timestamp,
        completion_ts: (lv['Request completion time'] || {}).timestamp_value,
        attempts: (lv['How many times did you try to download the file?'] || {}).value,
        quality: (lv['Media quality'] || {}).value,
        format: (lv['Output format'] || {}).value,
        seen_before: (lv['Have you seen this archive?'] || {}).value,
      };
      // If English labels didn't land, use position-based fallback
      if (!out.start && !out.end && Array.isArray(d.label_values)) {
        const entries = d.label_values;
        // Collect all timestamp-bearing entries in order. [0] = completion, [2] = start, [3] = end (typical)
        const timestamps = entries.map((e, i) => ({ i: i, ts: e.timestamp_value || 0 })).filter(x => x.ts);
        // Heuristic: the earliest two timestamps are start/end (distant past), the later one is completion (recent)
        timestamps.sort((a, b) => a.ts - b.ts);
        if (timestamps.length >= 2) {
          // Among the timestamps: completion is the one CLOSEST to request_ts (usually within days)
          // Start/end are the window bounds (usually ~1 year apart, in the past)
          const requestTs = d.timestamp || Math.floor(Date.now() / 1000);
          // Find completion: smallest absolute gap to request_ts
          let completionIdx = -1, completionGap = Infinity;
          timestamps.forEach((t, idx) => {
            const gap = Math.abs(t.ts - requestTs);
            if (gap < completionGap) { completionGap = gap; completionIdx = idx; }
          });
          const remaining = timestamps.filter((_, idx) => idx !== completionIdx);
          if (remaining.length >= 2) {
            // start = earliest, end = latest of remaining
            out.start = remaining[0].ts;
            out.end = remaining[remaining.length - 1].ts;
          }
          if (completionIdx >= 0) out.completion_ts = timestamps[completionIdx].ts;
        }
        // Values (attempts, quality, format, seen_before) — fill in any missing via first-value fallback
        if (!out.attempts) {
          const valEntries = entries.filter(e => typeof e.value === 'string' && /^\d+$/.test(e.value));
          if (valEntries.length) out.attempts = valEntries[0].value;
        }
      }
      return deriveWindowFields(out);
    }
    // HTML mode: Meta omits this metadata file entirely. Fall back to the standard
    // Meta DYI default of 365 days, anchored to the export date derived from the ZIP
    // filename. Mark as inferred so the renderer surfaces the provenance.
    if (files._hasHtml) {
      const iso = (function () {
        const root = (files && files._rootPrefix) || '';
        let m = root.match(/(\d{4}-\d{2}-\d{2})/);
        if (m) return m[1];
        const name = (files && files._zipFilename) || '';
        m = name.match(/(\d{4}-\d{2}-\d{2})/);
        return m ? m[1] : null;
      })();
      if (iso) {
        const end = Math.floor(Date.UTC(
          parseInt(iso.slice(0, 4), 10),
          parseInt(iso.slice(5, 7), 10) - 1,
          parseInt(iso.slice(8, 10), 10)
        ) / 1000);
        const start = end - 365 * 86400;
        return deriveWindowFields({ start, end, _inferred: true, export_date_iso: iso });
      }
    }
    return {};
  }

  // Plan Phase B.9: surface FULL autofill detail (currently reduced to a
  // boolean by extractIdentity). Reads ig_autofill_data from autofill_information.json
  // and emits structured address/name/phone/email so the Identity tab can
  // show "Meta has your full shipping address" with the actual fields.
  // Per [feedback_trust_killers], render masked by default in the UI; the
  // parser exposes the data so the user can choose to reveal.
  function extractAutofillFull(files) {
    const doc = loadJson(files, 'personal_information/autofill_information/autofill_information.json') || {};
    const af = doc.ig_autofill_data || {};
    const present = !!(af.address_line1 || af.tel || af.email || af.given_name);
    if (!present) return { autofill_present: false };
    // Compose a single-line address from the available fields
    const addrParts = [
      af.address_line1, af.address_line2, af.address_line3,
      af.address_level2 || af.address_level3,
      af.address_level1,
      af.postal_code,
      af.country_name || af.country,
    ].map(s => (s || '').trim()).filter(Boolean);
    return {
      autofill_present: true,
      autofill_full_name: [af.given_name, af.family_name].filter(Boolean).join(' '),
      autofill_given_name: af.given_name || '',
      autofill_family_name: af.family_name || '',
      autofill_email: af.email || '',
      autofill_phone: af.tel || '',
      autofill_phone_country: af.tel_country_code || '',
      autofill_address_line1: af.address_line1 || '',
      autofill_address_line2: af.address_line2 || '',
      autofill_city: af.address_level2 || '',
      autofill_state: af.address_level1 || '',
      autofill_postal: af.postal_code || '',
      autofill_country: af.country || af.country_name || '',
      autofill_address_one_line: addrParts.join(', '),
    };
  }

  // Plan Phase A.5: parses personal_information/personal_information/
  // instagram_profile_information.json — account history fields the
  // primary personal_information.json doesn't carry. Same folder, very
  // similar name; this is the OTHER one that was being ignored. Fields:
  // First Story Time (anchors "you've used IG since" framing), Contact
  // Syncing flag (explains why so many contacts are uploaded), Last
  // Login / Last Logout (account-recency context), First Country Code,
  // Has Shared Live Video, Has Archived Reels. Shape: label_values
  // array with either {value} (string) or {timestamp_value} (Unix sec).
  function extractInstagramProfileInfo(files) {
    const d = loadJson(files, 'personal_information/personal_information/instagram_profile_information.json');
    if (!d || !Array.isArray(d.label_values)) return {};
    const out = {};
    for (const lv of d.label_values) {
      const label = (lv.label || '').trim();
      const v = lv.value !== undefined ? lv.value : null;
      const ts = lv.timestamp_value || 0;
      switch (label) {
        case 'Contact Syncing':         out.contact_syncing = parseMetaBool(v); break;
        case 'First Country Code':      out.first_country_code = v || null; break;
        case 'Last Login':              if (ts) out.last_login_ts = ts; break;
        case 'Last Logout':             if (ts) out.last_logout_ts = ts; break;
        case 'First Story Time':        if (ts) out.first_story_ts = ts; break;
        case 'Last Story Time':         if (ts) out.last_story_ts = ts; break;
        case 'Has Shared Live Video':   out.has_shared_live_video = parseMetaBool(v); break;
        case 'Do you have any archived Reels?': out.has_archived_reels = parseMetaBool(v); break;
        case 'First Close Friends Story Time':  if (ts) out.first_close_friends_story_ts = ts; break;
        case 'Last time email address was changed': if (ts) out.last_email_change_ts = ts; break;
      }
    }
    return out;
  }

  // Parses your_instagram_activity/other_activity/your_information_download_requests.json
  // The metadata for the user's most recent data-export request to Meta:
  // when they asked, when it was ready, how long it took, which format/quality
  // they picked, the data window they requested, and whether they ever opened
  // the archive. Powers Section 9b ("How Meta delivered this data") so users
  // understand the request-to-ready latency for their own export.
  //
  // Shape handling:
  //   - the common case: a single object at the top level
  //   - Future-proofed for an array of request objects (filename is plural)
  //
  // The "Start date" sentinel -2048515200 (~year 1905) is Meta's "all history"
  // marker; we surface that as a label rather than a fake old date.
  // NO RENDER SURFACE YET (the Section 9b panel it fed is gone; the Export
  // passport reads its request/completion timing from extractWindow, which
  // parses this SAME file). Kept anyway: it carries fields extractWindow does
  // not (total_requests, and the all-history sentinel handling), and it has a
  // dedicated test suite covering identity. Flagged as an
  // unconsumed key by the 2026-08-01 HTML audit; deleting it means deleting
  // those tests too, so it is a deliberate decision, not a sweep. (2026-08-02)
  function extractDownloadRequest(files) {
    const doc = loadJson(files, 'your_instagram_activity/other_activity/your_information_download_requests.json');
    if (!doc) return { has_export_request: false };
    const entries = Array.isArray(doc) ? doc : [doc];
    if (!entries.length) return { has_export_request: false };
    // Most recent by top-level request timestamp
    entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    const e = entries[0];
    const out = {
      has_export_request: true,
      request_ts: e.timestamp || 0,
      total_requests: entries.length,
    };
    // Meta's "all history" sentinel — negative Unix seconds (~year 1905)
    const ALL_HISTORY_SENTINEL_MAX = -315619200; // any value <= 1960 treated as sentinel
    for (const lv of (e.label_values || [])) {
      const label = lv.label || '';
      const v = lv.value;
      const tsv = lv.timestamp_value;
      switch (label) {
        case 'Request completion time':
          if (tsv) out.ready_ts = tsv;
          break;
        case 'How many times did you try to download the file?':
          if (v !== undefined) out.download_attempts = parseInt(v, 10) || 0;
          break;
        case 'Start date':
          if (tsv !== undefined) {
            out.requested_start_ts = tsv;
            if (tsv <= ALL_HISTORY_SENTINEL_MAX) out.requested_start_is_all_history = true;
          }
          break;
        case 'End date':
          if (tsv !== undefined) out.requested_end_ts = tsv;
          break;
        case 'Media quality':
          if (v) out.media_quality = v;
          break;
        case 'Output format':
          if (v) out.output_format = v;
          break;
        case 'Have you seen this archive?':
          if (v !== undefined) out.has_seen = String(v).toLowerCase() === 'true';
          break;
      }
    }
    if (out.request_ts && out.ready_ts) {
      out.duration_sec = Math.max(0, out.ready_ts - out.request_ts);
    }
    return out;
  }

  // Parses your_instagram_activity/shopping/checkout_payment_information.json
  // The MOST COMPLETE identity record in the entire export — Meta's full
  // checkout profile for IG Shop / Meta Pay. Holds every email, address, and
  // phone the user has ever added to checkout, with timestamps and verification
  // flags. Way richer than autofill_information.json (which only has one of each).
  //
  // Structure: label_values is a flat list of scalars (Region, Update time) AND
  // dict-sections titled "Emails", "Mailing addresses", "Phones", "Names used for
  // automatically filling forms". Each section contains an array of records;
  // each record is its own dict of label/value or timestamp_value pairs.
  //
  // Trailing unlabeled timestamps inside each record = "added" / creation time.
  //
  // Per [feedback_normal_life_not_anomaly]: surface counts/data without flagging
  // multiple emails or addresses as anomalies — that's normal hygiene.
  function extractCheckoutProfile(files) {
    const doc = loadJson(files, 'your_instagram_activity/shopping/checkout_payment_information.json');
    if (!doc) return { has_checkout_profile: false };
    const lv = doc.label_values || [];
    const out = {
      has_checkout_profile: true,
      profile_created_ts: doc.timestamp || 0,
      profile_updated_ts: 0,
      region: '',
      emails: [],
      addresses: [],
      phones: [],
      names: [],
    };
    const truthy = v => String(v).toLowerCase() === 'true';
    for (const item of lv) {
      if (item.label === 'Region' && item.value) {
        out.region = item.value;
        continue;
      }
      if (item.label === 'Update time' && item.timestamp_value) {
        out.profile_updated_ts = Math.max(out.profile_updated_ts, item.timestamp_value);
        continue;
      }
      if (!Array.isArray(item.dict)) continue;

      if (item.title === 'Emails') {
        for (const entry of item.dict) {
          if (!Array.isArray(entry.dict)) continue;
          const rec = { email: '', primary: false, added_ts: 0, updated_ts: 0, verified: false };
          for (const f of entry.dict) {
            if (f.label === 'Email' && f.value) rec.email = f.value;
            else if (f.label === 'Primary email') rec.primary = truthy(f.value);
            else if (f.label === 'Verified') rec.verified = truthy(f.value);
            else if (f.label === 'Update time' && f.timestamp_value) {
              rec.updated_ts = Math.max(rec.updated_ts, f.timestamp_value);
            } else if (!f.label && f.timestamp_value && !rec.added_ts) {
              rec.added_ts = f.timestamp_value;
            }
          }
          if (rec.email) out.emails.push(rec);
        }
      } else if (item.title === 'Mailing addresses') {
        for (const entry of item.dict) {
          if (!Array.isArray(entry.dict)) continue;
          const rec = { name: '', line1: '', line2: '', city: '', state: '', country: '',
                        zip: '', zip_ext: '', is_default: false, verified: false,
                        added_ts: 0, updated_ts: 0 };
          for (const f of entry.dict) {
            if (f.label === 'Name' && f.value) rec.name = f.value;
            else if (f.label === 'Street' && f.value) rec.line1 = f.value;
            else if (f.label === 'Apt/suite/other' && f.value) rec.line2 = f.value;
            else if (f.label === 'City' && f.value) rec.city = f.value;
            else if (f.label === 'State' && f.value) rec.state = f.value;
            else if (f.label === 'Country' && f.value) rec.country = f.value;
            else if (f.label === 'ZIP/postal code' && f.value) rec.zip = f.value;
            else if (f.label === 'Zip code extension' && f.value) rec.zip_ext = f.value;
            else if (f.label === 'Default address') rec.is_default = truthy(f.value);
            else if (f.label === 'Verified') rec.verified = truthy(f.value);
            else if (f.label === 'Update time' && f.timestamp_value) {
              rec.updated_ts = Math.max(rec.updated_ts, f.timestamp_value);
            } else if (!f.label && f.timestamp_value && !rec.added_ts) {
              rec.added_ts = f.timestamp_value;
            }
          }
          if (rec.line1 || rec.city) out.addresses.push(rec);
        }
      } else if (item.title === 'Phones') {
        for (const entry of item.dict) {
          if (!Array.isArray(entry.dict)) continue;
          const rec = { number: '', country_code: '', added_ts: 0, updated_ts: 0 };
          for (const f of entry.dict) {
            if (f.label === 'Phone number' && f.value) rec.number = f.value;
            else if (f.label === 'Country code' && f.value) rec.country_code = f.value;
            else if (f.label === 'Update time' && f.timestamp_value) {
              rec.updated_ts = Math.max(rec.updated_ts, f.timestamp_value);
            } else if (!f.label && f.timestamp_value && !rec.added_ts) {
              rec.added_ts = f.timestamp_value;
            }
          }
          if (rec.number) out.phones.push(rec);
        }
      } else if (item.title === 'Names used for automatically filling forms') {
        for (const entry of item.dict) {
          if (!Array.isArray(entry.dict)) continue;
          const rec = { first: '', last: '', added_ts: 0, updated_ts: 0 };
          for (const f of entry.dict) {
            if (f.label === 'First name' && f.value) rec.first = f.value;
            else if (f.label === 'Last name' && f.value) rec.last = f.value;
            else if (f.label === 'Update time' && f.timestamp_value) {
              rec.updated_ts = Math.max(rec.updated_ts, f.timestamp_value);
            } else if (!f.label && f.timestamp_value && !rec.added_ts) {
              rec.added_ts = f.timestamp_value;
            }
          }
          if (rec.first || rec.last) out.names.push(rec);
        }
      }
    }
    // Compute profile age vs the user's current clock (browser-side render)
    if (out.profile_created_ts) {
      const nowSec = Math.floor(Date.now() / 1000);
      out.profile_age_days = Math.max(0, Math.floor((nowSec - out.profile_created_ts) / 86400));
    }
    // Primary email first, then by added_ts asc (oldest first)
    out.emails.sort((a, b) => {
      if (a.primary !== b.primary) return a.primary ? -1 : 1;
      return (a.added_ts || 0) - (b.added_ts || 0);
    });
    // Default address first, then by added_ts asc
    out.addresses.sort((a, b) => {
      if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
      return (a.added_ts || 0) - (b.added_ts || 0);
    });
    return out;
  }

  // Parses your_instagram_activity/shopping/cart_items.json
  // Active IG Shop carts the user never checked out from. The merchant
  // relationship is always preserved; the specific products are often
  // wiped by Meta's retention (empty Products array). We surface both —
  // merchant for relationship context, products when present for the
  // exact intent signal.
  //
  // Abandoned carts are the strongest commercial-intent signal short of
  // an actual purchase, so this feeds Section 7 / Intent and (later) the
  // monetize page's competitor-affiliate matching.
  function extractCartItems(files) {
    const doc = loadJson(files, 'your_instagram_activity/shopping/cart_items.json');
    if (!doc) return { has_carts: false, carts: [] };
    const out = { has_carts: false, carts: [] };
    const lv = doc.label_values || [];
    for (const item of lv) {
      if (item.title !== 'Carts' || !Array.isArray(item.dict)) continue;
      for (const cart of item.dict) {
        if (!Array.isArray(cart.dict)) continue;
        const rec = {
          last_modified_ts: 0,
          products: [],
          merchant_name: '',
          merchant_username: '',
          merchant_url: '',
        };
        for (const f of cart.dict) {
          if (f.label === 'Last modified time' && f.timestamp_value) {
            rec.last_modified_ts = f.timestamp_value;
          } else if (f.title === 'Products' && Array.isArray(f.dict)) {
            for (const p of f.dict) {
              if (!Array.isArray(p.dict)) continue;
              const prod = {};
              for (const pf of p.dict) {
                if (pf.label && pf.value !== undefined) prod[pf.label] = pf.value;
              }
              if (Object.keys(prod).length) rec.products.push(prod);
            }
          } else if (f.title === 'Merchant' && Array.isArray(f.dict)) {
            for (const m of f.dict) {
              if (!Array.isArray(m.dict)) continue;
              for (const mf of m.dict) {
                if (mf.label === 'URL' && mf.value) {
                  // Merchant URLs come scheme-less ("nike.com") — keep those,
                  // but block anything carrying a scheme other than http(s).
                  const mv = String(mf.value).trim();
                  rec.merchant_url = /^https?:\/\//i.test(mv) ? mv : (mv.includes(':') ? '' : mv);
                }
                else if (mf.label === 'Name' && mf.value) rec.merchant_name = mf.value;
                else if (mf.label === 'Username' && mf.value) rec.merchant_username = mf.value;
              }
            }
          }
        }
        if (rec.merchant_name || rec.merchant_username || rec.products.length) {
          out.carts.push(rec);
        }
      }
    }
    out.has_carts = out.carts.length > 0;
    // Most recently modified first
    out.carts.sort((a, b) => (b.last_modified_ts || 0) - (a.last_modified_ts || 0));
    return out;
  }

  function extractIdentity(files) {
    const d = loadJson(files, 'personal_information/personal_information/personal_information.json');
    if (d && d.profile_user) {
      // JSON path (primary). Meta localizes string_map_data KEYS per user locale:
      //   English: sm.Email, sm.Username, sm["Phone Number"]
      //   Russian: sm["Электронный адрес"], sm["Имя пользователя"], sm["Номер телефона"]
      // We first try the English keys (fast path for English users), then fall
      // back to value-pattern matching (locale-agnostic).
      const sm = (d.profile_user[0] || {}).string_map_data || {};
      const autofillDoc = loadJson(files, 'personal_information/autofill_information/autofill_information.json') || {};
      const af = autofillDoc.ig_autofill_data || {};
      const su = loadJson(files, 'security_and_login_information/login_and_profile_creation/signup_details.json');
      let signup_ts = null;
      if (su) {
        const entry = (su.account_history_registration_info || [])[0] || {};
        const smSu = entry.string_map_data || {};
        // Try English "Time" key first, then first timestamp-bearing entry
        signup_ts = (smSu.Time || {}).timestamp;
        if (!signup_ts) {
          for (const k of Object.keys(smSu)) {
            const t = (smSu[k] || {}).timestamp;
            if (t) { signup_ts = t; break; }
          }
        }
      }

      // English-key path (fast)
      const eng = {
        username: (sm.Username || {}).value || '',
        name: (sm.Name || {}).value || '',
        email: (sm.Email || {}).value || '',
        phone: (sm['Phone Number'] || {}).value || '',
        phone_confirmed: (sm['Phone Confirmed'] || {}).value || '',
        gender: (sm.Gender || {}).value || '',
        dob: (sm['Date of birth'] || {}).value || '',
        private: (sm['Private Account'] || {}).value || '',
      };
      // If the English keys worked (at least username landed), return directly.
      if (eng.username || eng.email) {
        return Object.assign(eng, {
          has_autofill_address: !!af.address_line1,
          signup_ts: signup_ts,
        });
      }

      // Locale-agnostic path — match values by pattern (same heuristics as HTML
      // fallback). Order matters: extract more-specific patterns first so they
      // don't get claimed by broader ones.
      const out = { has_autofill_address: !!af.address_line1, signup_ts: signup_ts };
      const claimed = new Set();
      // Build a list of {key, value} pairs from string_map_data
      const pairs = Object.keys(sm).map(k => ({ key: k, value: (sm[k] || {}).value || '' }));
      // Email (most specific)
      for (const p of pairs) {
        if (!out.email && /^[\w.+-]+@[\w.-]+\.\w+$/.test(p.value)) { out.email = p.value; claimed.add(p.key); break; }
      }
      // Phone (starts with + or digit, length ≥ 7). Exclude date-shaped
      // values — a "YYYY-MM-DD" string matches the phone pattern but is the DOB,
      // which the next loop claims.
      for (const p of pairs) {
        if (claimed.has(p.key)) continue;
        if (!out.phone && /^\+?\d[\d\s()-]{6,}$/.test(p.value) && !/^\d{4}-\d{2}-\d{2}$/.test(p.value)) { out.phone = p.value; claimed.add(p.key); break; }
      }
      // DOB (YYYY-MM-DD)
      for (const p of pairs) {
        if (claimed.has(p.key)) continue;
        if (!out.dob && /^\d{4}-\d{2}-\d{2}$/.test(p.value)) { out.dob = p.value; claimed.add(p.key); break; }
      }
      // Gender — single-word enum
      for (const p of pairs) {
        if (claimed.has(p.key)) continue;
        if (!out.gender && /^(male|female|nonbinary|other|custom|мужской|женский|masculino|femenino)$/i.test(p.value)) {
          out.gender = p.value;
          claimed.add(p.key);
          break;
        }
      }
      // Phone Confirmed / Private — True/False in any locale
      for (const p of pairs) {
        if (claimed.has(p.key)) continue;
        const b = parseMetaBool(p.value);
        if (b !== null) {
          if (out.phone_confirmed === undefined) { out.phone_confirmed = b ? 'True' : 'False'; claimed.add(p.key); }
          else if (out.private === undefined) { out.private = b ? 'True' : 'False'; claimed.add(p.key); }
        }
      }
      // Username (lowercase alphanumeric + dot + underscore, no spaces, no email)
      for (const p of pairs) {
        if (claimed.has(p.key)) continue;
        if (!out.username && /^[a-z0-9._]{3,30}$/.test(p.value) && !p.value.includes('.com')) {
          out.username = p.value;
          claimed.add(p.key);
          break;
        }
      }
      // Name — title-case, spaces allowed, any script (Latin/Cyrillic/etc.).
      // Explicit guards to avoid claiming Meta's status-enum values as names:
      //   - booleans in any locale (True/False/Yes/No/Verno/Неверно/etc.)
      //   - gender enums
      //   - phone-confirmation status values ("Unconfirmed", "Verified" — Meta
      //     uses these English enum values even in non-English exports)
      //   - account-status values
      const STATUS_ENUM = /^(unconfirmed|confirmed|verified|unverified|pending|active|inactive|none|private|public|default|custom|other|unknown|не подтвержден|подтвержден|активен|неактивен)$/i;
      for (const p of pairs) {
        if (claimed.has(p.key)) continue;
        if (out.name) break;
        if (!/^[\p{Lu}][\p{L}\s'.-]{1,59}$/u.test(p.value)) continue;
        if (p.value.startsWith('http')) continue;
        if (parseMetaBool(p.value) !== null) continue;
        if (/^(male|female|nonbinary|other|custom|мужской|женский|masculino|femenino)$/i.test(p.value)) continue;
        if (STATUS_ENUM.test(p.value)) continue;
        out.name = p.value;
        claimed.add(p.key);
        break;
      }
      return out;
    }
    // HTML fallback — Meta's HTML export localizes labels (English, Russian, etc.)
    // so we can't match by label text. Instead we extract every "td _a6_q" cell's
    // value from its nested <div><div>VALUE</div></div> structure and match values
    // to identity fields by regex heuristics.
    const htmlDoc = loadHtmlDoc(files, 'personal_information/personal_information/personal_information.html');
    if (!htmlDoc) return {};
    const values = [];
    htmlDoc.querySelectorAll('td._a6_q, td[colspan="2"]').forEach(td => {
      // The nested structure is: Label text + <div><div>VALUE</div></div>
      const lastInnerDiv = td.querySelector('div > div');
      if (lastInnerDiv) {
        const v = (lastInnerDiv.textContent || '').trim();
        if (v) values.push(v);
      }
    });
    // Value-pattern heuristic matching (locale-agnostic)
    const out = { has_autofill_address: false, signup_ts: null };
    for (const v of values) {
      if (!out.email && /^[\w.+-]+@[\w.-]+\.\w+$/.test(v)) out.email = v;
      else if (!out.phone && /^\+?\d[\d\s()-]{6,}$/.test(v) && !/^\d{4}-\d{2}-\d{2}$/.test(v)) out.phone = v;
      else if (!out.dob && /^\d{4}-\d{2}-\d{2}$/.test(v)) out.dob = v;
      else if (!out.gender && /^(male|female|nonbinary|other|custom)$/i.test(v)) out.gender = v;
      else if ((v === 'True' || v === 'False') && out.phone_confirmed === undefined) out.phone_confirmed = v;
      else if ((v === 'True' || v === 'False') && out.private === undefined) out.private = v;
      else if (!out.username && /^[a-z0-9._]{3,30}$/.test(v) && !v.includes('.com')) out.username = v;
      // Same guards the JSON path applies (parseMetaBool + STATUS_ENUM): a
      // THIRD boolean row falls past the two branches above, fails the
      // lowercase username test on its capital letter, and then matches this
      // name regex — so an account with no display name rendered its identity
      // as "False" (2026-08-01 review). Fabricated identity, which the
      // no-fake-data rule forbids outright.
      else if (!out.name && /^[A-ZА-ЯЁ][\p{L}\s'-]{0,49}$/u.test(v) && !v.startsWith('http') && v.length < 60
        && parseMetaBool(v) === null
        && !/^(unconfirmed|confirmed|verified|unverified|pending|active|inactive|none|private|public|default|custom|other|unknown)$/i.test(v)) out.name = v;
    }

    // Signup timestamp from signup HTML (if present)
    const suDoc = loadHtmlDoc(files, 'security_and_login_information/login_and_profile_creation/signup_details.html');
    if (suDoc) {
      const timeVals = [];
      suDoc.querySelectorAll('td._a6_q, td[colspan="2"]').forEach(td => {
        const inner = td.querySelector('div > div');
        if (inner) {
          const v = (inner.textContent || '').trim();
          if (v) timeVals.push(v);
        }
      });
      for (const v of timeVals) {
        const t = Date.parse(v);
        if (!isNaN(t)) { out.signup_ts = Math.floor(t / 1000); break; }
      }
    }

    // Autofill file — presence alone flags "address on file"
    const afDoc = loadHtmlDoc(files, 'personal_information/autofill_information/autofill_information.html');
    if (afDoc) {
      const afText = (afDoc.body || {}).textContent || '';
      // Look for anything that resembles a street address pattern
      out.has_autofill_address = /\d{1,5}\s+[A-ZA-Za-zА-Яа-я]/.test(afText) && afText.length > 200;
    }

    return out;
  }

  // Plan Phase C.12: when devices.json is missing, fall back to
  // camera_information.json — it carries device-id hashes + camera SDK
  // probes, enough to count distinct devices and stamp a "last seen"
  // even though we lose the user-agent string.
  function extractDeviceSummaryFromCameraInfo(files) {
    const c = loadJson(files, 'personal_information/device_information/camera_information.json');
    if (!Array.isArray(c) || !c.length) return null;
    const ids = new Set();
    let lastTs = 0;
    for (const e of c) {
      if (e.timestamp && e.timestamp > lastTs) lastTs = e.timestamp;
      for (const lv of (e.label_values || [])) {
        if (lv.label === 'Device ID' && lv.value) ids.add(lv.value);
      }
    }
    if (!ids.size && !lastTs) return null;
    const last = lastTs ? new Date(lastTs * 1000).toISOString().slice(0, 10) : '?';
    return `${ids.size} device${ids.size === 1 ? '' : 's'} fingerprinted via camera SDK probes &middot; last ${last}`;
  }
  function extractDeviceSummary(files) {
    const d = loadJson(files, 'personal_information/device_information/devices.json');
    if (!d) return extractDeviceSummaryFromCameraInfo(files);
    let best = null;
    for (const e of (d.devices_devices || [])) {
      const sm = e.string_map_data || {};
      // English keys first
      let ts = ((sm['Last Login'] || {}).timestamp) || 0;
      let ua = ((sm['User Agent'] || {}).value) || '';
      // Locale-agnostic fallback: UA contains "Mozilla" / slash; timestamp is any entry with a timestamp
      if (!ua) {
        for (const k of Object.keys(sm)) {
          const v = (sm[k] || {}).value || '';
          if (/Mozilla|Windows|iPhone|Android|Macintosh/.test(v)) { ua = v; break; }
        }
      }
      if (!ts) {
        for (const k of Object.keys(sm)) {
          const t = (sm[k] || {}).timestamp;
          if (t) { ts = t; break; }
        }
      }
      if (!best || ts > best.ts) best = { ts, ua };
    }
    if (!best) return extractDeviceSummaryFromCameraInfo(files);
    const ua = best.ua;
    const m = ua.match(/iPhone(\d+,\d+);[^)]*iOS (\d+_\d+_\d+)/);
    if (m) return `iPhone ${m[1]} &middot; iOS ${m[2].replace(/_/g, '.')}`;
    if (ua.indexOf('Windows') >= 0) {
      const m2 = ua.match(/Chrome\/([\d.]+)/);
      return `Windows desktop &middot; Chrome ${m2 ? m2[1] : '?'}`;
    }
    // Raw-UA fallback: strip HTML-significant chars — this string is the one
    // device_summary value that reaches an innerHTML sink unescaped (legacy
    // render), and a tampered devices.json controls it.
    return ua.replace(/[<>&"']/g, '').substring(0, 60);
  }

  // Attention gap #3 (2026-07-10): camera_information.json is a per-event
  // device-fingerprint log — every entry is one timestamped probe carrying a
  // Device ID hash. extractDeviceSummaryFromCameraInfo (above) still consumes
  // the SAME file as the devices.json fallback (distinct-ID count + last-seen);
  // this promotes it to a first-class signal so probe VOLUME and CADENCE are
  // visible, not just presence. Emits counts + dates only:
  //   events         — how many probe entries the file holds
  //   distinct_ids   — how many distinct Device ID hashes across those entries
  //   window_days    — span between the oldest and newest probe timestamp
  //   probes_per_day — events / window_days (null when the span is under a day,
  //                    which would divide by ~0 and inflate the rate)
  //   first_ts / last_ts — observed window bounds (unix seconds) for display
  // The Device ID hashes themselves NEVER leave this function — only counts and
  // dates flow out. JSON-only: camera_information.json has no HTML export
  // variant (like its sibling device readers), so an HTML-format archive
  // returns null here and the dashboard shows an honest empty state.
  function extractDeviceFingerprint(files) {
    const c = loadJson(files, 'personal_information/device_information/camera_information.json');
    if (!Array.isArray(c) || !c.length) return null;
    const ids = new Set();
    let min = Infinity, max = 0, timed = 0;
    for (const e of c) {
      const ts = (e && typeof e.timestamp === 'number' && e.timestamp > 0) ? e.timestamp : 0;
      if (ts) { timed++; if (ts < min) min = ts; if (ts > max) max = ts; }
      for (const lv of ((e && e.label_values) || [])) {
        if (lv && lv.label === 'Device ID' && lv.value) ids.add(lv.value);
      }
    }
    // No timestamped probe → nothing honest to say about a window or cadence.
    if (!timed) return null;
    // Round the window to 0.1d and derive the rate from that SAME published
    // value, so "N events over D days" and "~R/day" stay internally consistent
    // and the sub-day guard below keys on exactly the value we surface.
    const windowDays = Math.round(((max - min) / 86400) * 10) / 10;
    // Guard div-by-zero / an inflated rate when every probe lands inside a
    // single day (window under 1.0d): report the count + window, omit the rate.
    // Count and rate both use the TIMED entries - the same set the window came
    // from - so if Meta ever ships untimestamped rows, "N events over D days"
    // still describes one consistent set.
    const probesPerDay = windowDays >= 1
      ? Math.round((timed / windowDays) * 10) / 10
      : null;
    return {
      events: timed,
      distinct_ids: ids.size,
      window_days: windowDays,
      probes_per_day: probesPerDay,
      first_ts: min,
      last_ts: max,
    };
  }

  function extractLocation(files) {
    const out = { profile_city: '', gps: null, interests: [], interests_explanation: '' };
    // 2026-05-31: an export was returning empty profile_city
    // even though the file existed in that archive — Meta appears to have
    // moved profile_based_in.json out of /information_about_you/ in newer
    // exports. Add a filename-suffix fallback so we find the file no
    // matter what parent directory Meta nests it under this week. Same
    // pattern for last_known_location.json + locations_of_interest.json
    // since they have the same path-stability risk.
    const findFileEndingIn = (suffix) => {
      // Try known canonical path first (fast path, no scan)
      const direct = files[suffix.replace(/^\//, '')];
      if (direct && !direct._html) return direct;
      // Fall back to suffix-match across all keys. Skip internal keys
      // (_hasJson, _format, _zipFilename, etc.) and HTML stubs.
      for (const key in files) {
        if (!Object.prototype.hasOwnProperty.call(files, key)) continue;
        if (key.startsWith('_')) continue;
        if (key.endsWith(suffix)) {
          const v = files[key];
          if (v && !v._html) return v;
        }
      }
      return null;
    };
    const pb = loadJson(files, 'personal_information/information_about_you/profile_based_in.json')
            || findFileEndingIn('/profile_based_in.json');
    if (pb) {
      // Shape A — older exports: inferred_data_primary_location[].string_map_data
      for (const e of (pb.inferred_data_primary_location || [])) {
        const sm = e.string_map_data || {};
        // Try English key first, then fallback to first value (the file has only
        // one field per locale: "City Name" / "Название города" / etc.)
        out.profile_city = ((sm['City Name'] || {}).value) || smFirstValue(sm);
      }
      // Shape B — a 2026-05-12 export (new Meta format):
      //   label_values[0].label = "Location"
      //   label_values[0].dict = [{label:"Country",value:"..."},
      //                           {label:"Region",value:"..."},
      //                           {label:"City",value:"<city>, <state>"}]
      // The C/R/C dict is the user's CONFIRMED home city, far more
      // authoritative than locations_of_interest[0] (which is just the first
      // of the many cities Meta inferred). Prefer this when present.
      if (!out.profile_city && Array.isArray(pb.label_values)) {
        for (const lv of pb.label_values) {
          if (Array.isArray(lv.dict)) {
            for (const d of lv.dict) {
              if (d && d.label === 'City' && d.value) { out.profile_city = d.value; break; }
            }
          }
          if (out.profile_city) break;
        }
      }
    }
    const lkl = loadJson(files, 'security_and_login_information/login_and_profile_creation/last_known_location.json')
             || findFileEndingIn('/last_known_location.json');
    if (lkl) {
      for (const e of (lkl.account_history_imprecise_last_known_location || [])) {
        const sm = e.string_map_data || {};
        // English keys first
        let lat = (sm['Precise Latitude'] || {}).value || '';
        let lon = (sm['Precise Longitude'] || {}).value || '';
        let ts = (sm['GPS Time Uploaded'] || {}).timestamp || 0;
        // Locale-agnostic fallback: look for values that match decimal lat/lon patterns
        if (!lat || !lon) {
          const latPattern = /^-?\d{1,2}\.\d{3,}$/;   // latitude: -90 to 90, decimal
          const lonPattern = /^-?\d{1,3}\.\d{3,}$/;   // longitude: -180 to 180, decimal
          const vals = Object.keys(sm).map(k => ({ key: k, value: (sm[k] || {}).value, timestamp: (sm[k] || {}).timestamp }));
          const decimals = vals.filter(v => v.value && /^-?\d+\.\d+$/.test(v.value));
          // First decimal value = latitude (range: -90 to 90), second = longitude
          if (decimals.length >= 2) {
            const a = parseFloat(decimals[0].value);
            const b = parseFloat(decimals[1].value);
            if (Math.abs(a) <= 90 && Math.abs(b) <= 180) { lat = decimals[0].value; lon = decimals[1].value; }
            else if (Math.abs(b) <= 90 && Math.abs(a) <= 180) { lat = decimals[1].value; lon = decimals[0].value; }
          }
          // Find any timestamp in the entries
          if (!ts) {
            for (const v of vals) { if (v.timestamp) { ts = v.timestamp; break; } }
          }
        }
        if (lat && lon) {
          out.gps = { precise_lat: lat, precise_lon: lon, uploaded_ts: ts };
        }
      }
    }
    const loi = loadJson(files, 'personal_information/information_about_you/locations_of_interest.json')
             || findFileEndingIn('/locations_of_interest.json');
    if (loi) {
      // English label match first
      for (const lv of (loi.label_values || [])) {
        if (lv.label === 'Locations of interest') {
          out.interests = (lv.vec || []).map(v => v.value || '');
        } else if (lv.label === 'Usage explanation') {
          out.interests_explanation = lv.value || '';
        }
      }
      // Locale-agnostic fallback
      if (!out.interests.length) {
        const vecEntry = lvFirstWithVec(loi.label_values, 1);
        if (vecEntry) out.interests = vecEntry.vec.map(v => v.value || '').filter(Boolean);
      }
      if (!out.interests_explanation) {
        const valEntry = lvFirstWithValue(loi.label_values);
        if (valEntry) out.interests_explanation = valEntry.value;
      }
    }
    return out;
  }

  function parsePct(s) {
    // Names can contain commas ("Springfield, Illinois: 12.3%, Riverton,
    // Wyoming: 8.1%") — split on the % that ENDS each pair, not every comma, or the
    // city fragment gets discarded and the row is mislabeled with the state.
    // Also accept comma decimals ("12,3%") from non-English locales.
    const out = [];
    for (const part of String(s || '').split(/%\s*,\s*/)) {
      const m = part.trim().match(/^(.+?):\s*(\d+(?:[.,]\d+)?)\s*%?$/);
      if (m) out.push([m[1].trim(), parseFloat(m[2].replace(',', '.'))]);
    }
    return out;
  }

  function extractAudience(files) {
    const d = loadJson(files, 'logged_information/past_instagram_insights/audience_insights.json');
    if (d && d.organic_insights_audience && d.organic_insights_audience.length) {
      const sm = d.organic_insights_audience[0].string_map_data || {};
      const get = k => ((sm[k] || {}).value || '');
      // Fast path: English keys
      const eng = {
        date_range: get('Date Range'),
        total_followers: get('Followers'),
        cities: parsePct(get('Follower Percentage by City')),
        countries: parsePct(get('Follower Percentage by Country')),
        age_all: parsePct(get('Follower Percentage by Age for All Genders')),
        age_men: parsePct(get('Follower Percentage by Age for Men')),
        age_women: parsePct(get('Follower Percentage by Age for Women')),
        pct_men: get('Total Follower Percentage for Men'),
        pct_women: get('Total Follower Percentage for Women'),
      };
      if (eng.date_range || eng.total_followers) return eng;
      // Locale-agnostic path — walk every value in string_map_data and classify
      // by pattern (same approach as the HTML fallback). Meta's insight rows
      // appear in a consistent order across locales so we can bucket by pattern.
      const values = Object.keys(sm).map(k => (sm[k] || {}).value || '').filter(Boolean);
      const out = { date_range: '', total_followers: '', cities: [], countries: [], age_all: [], age_men: [], age_women: [], pct_men: '', pct_women: '' };
      const pctBreakdowns = [];
      const singlePcts = [];
      for (const v of values) {
        // Date range: e.g. "Jan 20 - Apr 19" (month abbreviations in English regardless of locale)
        if (!out.date_range && / - /.test(v) && /[A-Za-zА-Яа-я]{3,}\s+\d+/.test(v) && v.indexOf(':') < 0 && v.length < 40) {
          out.date_range = v;
          continue;
        }
        // Total followers: first standalone integer after date_range
        if (out.date_range && !out.total_followers && /^\d[\d,]*$/.test(v)) {
          out.total_followers = v;
          continue;
        }
        // Percentage breakdown: "Name: XX%," pattern
        if (/[A-Za-zА-Яа-я0-9\-\+][^,]*:\s*[\d.]+%/.test(v) && v.indexOf(',') >= 0) {
          pctBreakdowns.push(v);
          continue;
        }
        // Single percentage (gender split)
        if (/^[\d.]+%$/.test(v)) {
          singlePcts.push(v);
          continue;
        }
      }
      // Fixed Meta order: cities, countries, age_all, age_men, age_women
      out.cities = pctBreakdowns[0] ? parsePct(pctBreakdowns[0]) : [];
      out.countries = pctBreakdowns[1] ? parsePct(pctBreakdowns[1]) : [];
      out.age_all = pctBreakdowns[2] ? parsePct(pctBreakdowns[2]) : [];
      out.age_men = pctBreakdowns[3] ? parsePct(pctBreakdowns[3]) : [];
      out.age_women = pctBreakdowns[4] ? parsePct(pctBreakdowns[4]) : [];
      out.pct_men = singlePcts[0] || '';
      out.pct_women = singlePcts[1] || '';
      return out;
    }
    // HTML fallback — rows appear in a fixed order. We walk value cells and classify
    // each by pattern (date-range, integer, pct-breakdown, single-pct) so we stay
    // locale-agnostic even when labels are Russian/Spanish/etc.
    const htmlDoc = loadHtmlDoc(files, 'logged_information/past_instagram_insights/audience_insights.html');
    if (!htmlDoc) return {};
    // Collect every value string from <td><div><div>VALUE</div></div></td> rows
    const values = [];
    htmlDoc.querySelectorAll('td._a6_q, td[colspan="2"]').forEach(td => {
      const inner = td.querySelector('div > div');
      if (!inner) return;
      const v = (inner.textContent || '').trim();
      if (v) values.push(v);
    });
    const out = {};
    const pctBreakdowns = [];
    const singlePcts = [];
    for (const v of values) {
      // Date range: e.g. "Jan 20 - Apr 19" (month abbreviations in English regardless of locale)
      if (!out.date_range && / - /.test(v) && /[A-Za-zА-Яа-я]{3,}\s+\d+/.test(v) && v.indexOf(':') < 0 && v.length < 40) {
        out.date_range = v;
        continue;
      }
      // Total followers: first standalone integer after date_range
      if (out.date_range && !out.total_followers && /^\d[\d,]*$/.test(v)) {
        out.total_followers = v;
        continue;
      }
      // Percentage breakdown: contains "Name: XX%," pattern (cities, countries, age)
      if (/[A-Za-zА-Яа-я0-9\-\+][^,]*:\s*[\d.]+%/.test(v) && v.indexOf(',') >= 0) {
        pctBreakdowns.push(v);
        continue;
      }
      // Single percentage (gender split)
      if (/^[\d.]+%$/.test(v)) {
        singlePcts.push(v);
        continue;
      }
    }
    // Rows in fixed Meta order: city, country, age_all, age_men, age_women
    out.cities = pctBreakdowns[0] ? parsePct(pctBreakdowns[0]) : [];
    out.countries = pctBreakdowns[1] ? parsePct(pctBreakdowns[1]) : [];
    out.age_all = pctBreakdowns[2] ? parsePct(pctBreakdowns[2]) : [];
    out.age_men = pctBreakdowns[3] ? parsePct(pctBreakdowns[3]) : [];
    out.age_women = pctBreakdowns[4] ? parsePct(pctBreakdowns[4]) : [];
    out.pct_men = singlePcts[0] || '';
    out.pct_women = singlePcts[1] || '';
    return out;
  }

  // Plan Phase A.4: creator stats — content_interactions + profiles_reached.
  // Companion to extractAudience (audience demographics). The trio shares the
  // SAME date_range field per Meta's quarterly insights cadence — when all
  // three are present the report can show "creator stats for Feb-May 2026"
  // once and align all three blocks. Returns flat ints + raw delta strings
  // (deltas come as "-12.3% vs <start> - <end>" — keep raw so the renderer
  // can split into magnitude + comparison window).
  function _ciToInt(s) {
    const n = parseInt(String(s).replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
  }
  function extractContentInteractions(files) {
    const d = loadJson(files, 'logged_information/past_instagram_insights/content_interactions.json');
    if (!d || !Array.isArray(d.organic_insights_interactions) || !d.organic_insights_interactions.length) {
      return { available: false };
    }
    const sm = d.organic_insights_interactions[0].string_map_data || {};
    const get = (k) => ((sm[k] || {}).value || '');
    return {
      available: true,
      date_range: get('Date Range'),
      content_interactions: _ciToInt(get('Content Interactions')),
      content_interactions_delta: get('Content Interactions Delta'),
      post_interactions: _ciToInt(get('Post Interactions')),
      post_interactions_delta: get('Post Interactions Delta'),
      post_likes: _ciToInt(get('Post Likes')),
      story_interactions: _ciToInt(get('Story Interactions')),
      story_interactions_delta: get('Story Interactions Delta'),
      story_replies: _ciToInt(get('Story Replies')),
      video_interactions: _ciToInt(get('Video Interactions')),
      video_interactions_delta: get('Video Interactions Delta'),
      reels_interactions: _ciToInt(get('Reels Interactions')),
      reels_interactions_delta: get('Reels Interactions Delta'),
      live_video_interactions: _ciToInt(get('Live Video Interactions')),
      accounts_engaged: _ciToInt(get('Accounts engaged')),
      accounts_engaged_delta: get('Accounts Engaged Delta'),
      engaged_account_by_follow_type: get('Engaged Account By Follow Type'),
    };
  }
  function extractProfilesReached(files) {
    const d = loadJson(files, 'logged_information/past_instagram_insights/profiles_reached.json');
    if (!d || !Array.isArray(d.organic_insights_reach) || !d.organic_insights_reach.length) {
      return { available: false };
    }
    const sm = d.organic_insights_reach[0].string_map_data || {};
    const get = (k) => ((sm[k] || {}).value || '');
    return {
      available: true,
      date_range: get('Date Range'),
      accounts_reached: _ciToInt(get('Accounts Reached')),
      accounts_reached_delta: get('Accounts Reached Delta'),
      followers_pct: get('Followers'),
      non_followers_pct: get('Non-Followers'),
      non_followers_delta: get('Non-Followers Delta'),
      impressions: _ciToInt(get('Impressions')),
      impressions_delta: get('Impressions Delta'),
      profile_visits: _ciToInt(get('Profile visits')),
      profile_visits_delta: get('Profile Visits Delta'),
    };
  }

  function extractAIInterests(files) {
    const d = loadJson(files, 'your_instagram_activity/ai/interest_categories.json');
    if (d) {
      // Wrapper-key tolerant — an object-shaped file used to crash the
      // whole report here (for…of over a non-iterable).
      const list = Array.isArray(d)
        ? d
        : (typeof d === 'object' ? (Object.values(d).find(Array.isArray) || []) : []);
      // English exports wrap the value as "The user might be interested in X";
      // other locales phrase it differently. Strip the English prefix when
      // present, otherwise keep the value verbatim (mojibake is already fixed
      // at load, so Cyrillic / non-Latin text comes through clean).
      const cleanInterest = (v) => String(v || '')
        .replace(/^the user (?:might be |is )?interested in\s*/i, '').trim();
      const out = [];
      for (const e of list) {
        const lvs = (e && e.label_values) || [];
        // Fast path: English 'Interest' label — no regression for EN exports.
        let matched = 0;
        for (const lv of lvs) {
          if (lv && lv.label === 'Interest' && lv.value) {
            const val = cleanInterest(lv.value);
            if (val) { out.push(val); matched++; }
          }
        }
        // Localized-label fallback: Meta translates label_values labels by the
        // account's IG language (Russian "Интерес", etc.), so a hard
        // === 'Interest' match silently dropped EVERY interest for non-English
        // exports (a bug a non-English export surfaced 2026-07-01). When no
        // English label matched this entry, take its first value-bearing
        // label_value instead — same locale-agnostic approach the rest of the
        // parser uses (lvFirstWithValue / smFirstValue / lvFirstWithVec).
        if (!matched) {
          const any = lvFirstWithValue(lvs);
          if (any) {
            const val = cleanInterest(any.value);
            if (val) out.push(val);
          }
        }
      }
      return out;
    }
    // HTML fallback — English-only: the prose regex below matches the English
    // "The user … interested in …" phrasing, so a localized HTML export won't
    // match. HTML is already a known degraded path (JSON is Meta's default).
    const htmlDoc = loadHtmlDoc(files, 'your_instagram_activity/ai/interest_categories.html');
    if (!htmlDoc) return [];
    const text = (htmlDoc.body || {}).textContent || '';
    const out = [];
    const re = /The user (?:might be |is )?interested in ([^\n.]+?)(?=\s*(?:Last updated|$|The user))/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const val = m[1].trim().replace(/[.;]$/, '');
      if (val && val.length < 200) out.push(val);
    }
    return out;
  }

  // Plan Phase C.14: partial-signal fallback for topics. see_less_topics.json
  // carries TIMESTAMPS of "see less" taps but NO topic names. Useful as a
  // count signal ("user has actively muted N topics in the last window")
  // when recommended_topics.json is absent — Meta dropped it in 2026.
  //
  // NO RENDER SURFACE YET, AND THAT IS NOT A REASON TO DELETE IT (2026-08-02):
  // this exists as resilience for a Meta schema change that has already begun,
  // so the day recommended_topics.json vanishes for a user, the Interests
  // section still has a number to show. The 2026-08-01 HTML audit flagged it
  // as an unconsumed key; keeping it is deliberate. Wire it into the Interests
  // tab or drop it as a pair with that decision — don't prune it in a sweep.
  function extractSeeLessTopics(files) {
    const d = loadJson(files, 'preferences/your_topics/your_ads_see_more/see_less_topics.json');
    if (!Array.isArray(d) || !d.length) return { count: 0, first_ts: 0, last_ts: 0 };
    let first = Infinity, last = 0;
    for (const e of d) {
      const ts = e.timestamp || 0;
      if (ts) {
        if (ts < first) first = ts;
        if (ts > last) last = ts;
      }
      for (const lv of (e.label_values || [])) {
        if (lv.label === 'Update time' && lv.timestamp_value) {
          if (lv.timestamp_value < first) first = lv.timestamp_value;
          if (lv.timestamp_value > last) last = lv.timestamp_value;
        }
      }
    }
    return { count: d.length, first_ts: first === Infinity ? 0 : first, last_ts: last };
  }

  function extractTopics(files) {
    const d = loadJson(files, 'preferences/your_topics/recommended_topics.json');
    if (d) {
      // string_map_data key is localized: "Name" (English), "Название" (Russian),
      // "Nombre" (Spanish), etc. Each topic entry has exactly ONE field in
      // string_map_data, so smFirstValue returns the topic name regardless of key.
      return (d.topics_your_topics || [])
        .map(e => {
          const sm = e.string_map_data || {};
          // Prefer English key for perf; fall back to first value
          return ((sm.Name || {}).value) || smFirstValue(sm);
        })
        .filter(Boolean);
    }
    // HTML fallback — extract the nested <td><div><div>TOPIC</div></div></td> values
    const htmlDoc = loadHtmlDoc(files, 'preferences/your_topics/recommended_topics.html');
    if (!htmlDoc) return [];
    const topics = [];
    const seen = new Set();
    htmlDoc.querySelectorAll('td._a6_q, td[colspan="2"]').forEach(td => {
      const lastInnerDiv = td.querySelector('div > div');
      if (lastInnerDiv) {
        const v = (lastInnerDiv.textContent || '').trim();
        // Filter out the label row itself (e.g., "Название") and non-topic noise
        if (v && v.length >= 2 && v.length <= 80 && !seen.has(v)) {
          seen.add(v);
          topics.push(v);
        }
      }
    });
    return topics;
  }

  function extractAdPreferences(files) {
    const d = loadJson(files, 'ads_information/instagram_ads_and_businesses/ad_preferences.json');
    if (!d) return { removed: [], hidden_ads: [], hidden_advertisers: [], fbid: '' };
    const out = { removed: [], hidden_ads: [], hidden_advertisers: [], fbid: '' };

    // Removed categories — position [0] in the export, regardless of locale.
    // Try English label first, fall back to first-vec entry.
    let removedEntry = null;
    for (const entry of (d.label_values || [])) {
      if (entry.label === 'Removed categories' && Array.isArray(entry.vec)) {
        removedEntry = entry; break;
      }
    }
    if (!removedEntry) removedEntry = lvFirstWithVec(d.label_values, 1);
    if (removedEntry) out.removed = removedEntry.vec.map(v => v.value || '').filter(Boolean);

    // Hidden ads — entries shaped as { title: "Hidden ads", dict: [{dict:[{label,value},...], title:""}, ...] }
    // Each sub-dict carries Event/Ad title/Creation time. Locale-agnostic: walk
    // every label_values entry with a .dict array of dicts and classify by
    // English title when present, otherwise by inner contents.
    for (const entry of (d.label_values || [])) {
      if (!Array.isArray(entry.dict)) continue;
      const isHiddenAds = entry.title === 'Hidden ads';
      const isHiddenAdvertisers = entry.title === 'Hidden advertisers';
      // If title is unrecognized, peek inside to classify (first sub-dict's
      // Event label often gives it away).
      if (!isHiddenAds && !isHiddenAdvertisers && entry.dict.length) {
        // Try to detect ads vs advertisers by looking for "Ad title" key
        const first = entry.dict[0];
        if (first && Array.isArray(first.dict)) {
          const hasAdTitle = first.dict.some(kv => kv && kv.label === 'Ad title');
          if (hasAdTitle) {
            // treat as hidden ads
            for (const item of entry.dict) {
              if (!item || !Array.isArray(item.dict)) continue;
              const rec = { title: '', ts: 0, event: '' };
              for (const kv of item.dict) {
                if (kv.label === 'Ad title') rec.title = kv.value || '';
                else if (kv.label === 'Event') rec.event = kv.value || '';
                else if (kv.label === 'Creation time') rec.ts = kv.timestamp_value || 0;
              }
              if (rec.title) out.hidden_ads.push(rec);
            }
          }
        }
        continue;
      }
      if (isHiddenAds) {
        for (const item of entry.dict) {
          if (!item || !Array.isArray(item.dict)) continue;
          const rec = { title: '', ts: 0, event: '' };
          for (const kv of item.dict) {
            if (kv.label === 'Ad title') rec.title = kv.value || '';
            else if (kv.label === 'Event') rec.event = kv.value || '';
            else if (kv.label === 'Creation time') rec.ts = kv.timestamp_value || 0;
          }
          if (rec.title) out.hidden_ads.push(rec);
        }
      } else if (isHiddenAdvertisers) {
        for (const item of entry.dict) {
          if (!item || !Array.isArray(item.dict)) continue;
          const rec = { name: '', ts: 0 };
          for (const kv of item.dict) {
            if (kv.label === 'Advertiser name' || kv.label === 'Name') rec.name = kv.value || '';
            else if (kv.label === 'Creation time') rec.ts = kv.timestamp_value || 0;
          }
          if (rec.name) out.hidden_advertisers.push(rec);
        }
      }
    }

    // Meta's persistent cross-surface user ID. Stitches IG ↔ FB ↔ Threads ↔
    // ad measurement. Surface as a single-line proof element.
    if (d.fbid) out.fbid = String(d.fbid);

    return out;
  }

  function extractOtherCategories(files) {
    const d = loadJson(files, 'ads_information/instagram_ads_and_businesses/other_categories_used_to_reach_you.json');
    if (!d) return [];
    // Try English label first, then locale-agnostic first-vec fallback.
    for (const lv of (d.label_values || [])) {
      if (lv.label === 'Name' && Array.isArray(lv.vec)) {
        return lv.vec.map(v => v.value || '').filter(Boolean);
      }
    }
    const primary = lvFirstWithVec(d.label_values, 1);
    if (primary) return primary.vec.map(v => v.value || '').filter(Boolean);
    return [];
  }

  function extractAdsAboutMeta(files) {
    const d = loadJson(files, 'ads_information/instagram_ads_and_businesses/ads_about_meta.json');
    if (!d) return {};
    const out = {};
    // Try English label match first
    for (const lv of (d.label_values || [])) {
      if (lv.label === 'Is opted out of ads about Meta') out.opted_out = lv.value || '';
      else if (lv.label === 'When you last opted out of ads about Meta') out.last_opted_out_ts = lv.timestamp_value || 0;
    }
    // If we didn't match English labels, use locale-agnostic detection:
    //   - entry with .value = opt-out status (True/False in any locale)
    //   - entry with .timestamp_value = when opted out
    if (out.opted_out === undefined) {
      const valueEntry = lvFirstWithValue(d.label_values);
      if (valueEntry) {
        const b = parseMetaBool(valueEntry.value);
        // Store in the same shape the renderer expects: 'True' / 'False' strings
        if (b === true) out.opted_out = 'True';
        else if (b === false) out.opted_out = 'False';
        else out.opted_out = valueEntry.value; // preserve raw if we can't parse
      }
    }
    if (!out.last_opted_out_ts) {
      const tsEntry = lvFirstWithTimestamp(d.label_values);
      if (tsEntry) out.last_opted_out_ts = tsEntry.timestamp_value;
    }
    return out;
  }

  function extractAdvertisers(files) {
    const d = loadJson(files, 'ads_information/instagram_ads_and_businesses/advertisers_using_your_activity_or_information.json');
    // rawRecords carries the per-advertiser flags from modern (Shape A)
    // exports: has_remarketing_custom_audience (= they fired a pixel based
    // on YOUR action — strongest "you interacted" signal), has_in_person_
    // store_visit (they tracked an offline visit), has_data_file_custom_
    // audience (they uploaded a list with your hashed email — weakest
    // signal). Older / EU exports (Shape B, vec-of-values) don't carry
    // the flags; entries fall back to {name, hasRemarketing:false, ...}.
    let rawRecords = [];
    if (d) {
      // JSON path — handle BOTH schema shapes:
      //   (A) Old direct shape: { ig_custom_audiences_all_types: [{advertiser_name, has_remarketing_custom_audience, has_in_person_store_visit, has_data_file_custom_audience}, ...] }
      //   (B) New wrapped shape: { media, label_values: [{label, vec: [{value}]}, ...], fbid }
      //       Position [0] is ALWAYS the primary advertiser list (localized label).
      //       Vec items have {value: "BrandName"} — no flags.
      if (Array.isArray(d.ig_custom_audiences_all_types) && d.ig_custom_audiences_all_types.length) {
        // Shape A — modern, with flags
        for (const it of d.ig_custom_audiences_all_types) {
          const n = (it.advertiser_name || it.value || '').trim();
          if (!n) continue;
          rawRecords.push({
            name: n,
            hasRemarketing: !!it.has_remarketing_custom_audience,
            hasStoreVisit: !!it.has_in_person_store_visit,
            hasDataFile: !!it.has_data_file_custom_audience,
          });
        }
      } else if (Array.isArray(d.label_values)) {
        // Shape B — take the first entry that has a non-empty vec (position-based,
        // locale-agnostic). Entry [0] is "custom-audience advertisers", [1] is
        // "interacted-with advertisers" (subset of [0]), [2] is "marketers with
        // your information" (often empty). No flags on this shape.
        const primary = lvFirstWithVec(d.label_values, 1);
        if (primary) {
          for (const item of primary.vec) {
            const n = (item.value || item.advertiser_name || '').trim();
            if (!n) continue;
            // Shape B carries NO per-advertiser flags — don't fabricate one.
            // (lvFirstWithVec can also land on position [1] when [0] is
            // empty, so even the positional "must be data-file" inference
            // wasn't safe.)
            rawRecords.push({
              name: n,
              hasRemarketing: false,
              hasStoreVisit: false,
              hasDataFile: false,
            });
          }
        }
      }
    } else {
      // HTML fallback — Meta wraps each advertiser in `.pam.uiBoxWhite > ._a6-p`
      const htmlDoc = loadHtmlDoc(files, 'ads_information/instagram_ads_and_businesses/advertisers_using_your_activity_or_information.html');
      if (htmlDoc) {
        // Primary selector: the individual advertiser boxes
        const boxes = htmlDoc.querySelectorAll('div.pam.uiBoxWhite > div._a6-p, div._a6-p');
        boxes.forEach(b => {
          // Only leaf divs — no nested structure
          if (b.children.length === 0) {
            const n = (b.textContent || '').trim();
            if (n && n.length >= 2 && n.length <= 150) {
              rawRecords.push({ name: n, hasRemarketing:false, hasStoreVisit:false, hasDataFile:false });
            }
          }
        });
        // Fallback ONLY when the primary selector parsed NOTHING (2026-08-01
        // HTML audit). The old `< 5` threshold DISCARDED correctly box-parsed
        // records and replaced them with a whole-document leaf-text scan — so
        // a user with 2 real advertisers got those 2 thrown away and rebuilt
        // from page chrome (record-footer timestamps, section blurbs), minting
        // fabricated "advertisers" into the headline count. A small verified
        // list beats a padded one; the wide scan is strictly a last resort for
        // a Meta re-skin that renames the box class. Its filter also drops
        // date-shaped strings (the record-footer timestamps that were the
        // main chrome source).
        if (rawRecords.length === 0) {
          const items = collectLineItems(htmlDoc, {
            filter: t => t.length >= 3 && t.length <= 80
              && !/^(Has|Yes|No|True|False)$/.test(t)
              && !/^[A-Za-zа-яА-Я]{2,4}\s+\d{1,2},?\s+\d{4}/.test(t)
          });
          rawRecords = items.map(n => ({ name:n, hasRemarketing:false, hasStoreVisit:false, hasDataFile:false }));
        }
      }
    }
    // Dedupe by name, preferring the record with the most flags set.
    const byName = new Map();
    for (const r of rawRecords) {
      const k = r.name.toLowerCase();
      const existing = byName.get(k);
      if (!existing) { byName.set(k, r); continue; }
      // Merge flags — OR them so we don't lose signal across duplicates.
      existing.hasRemarketing = existing.hasRemarketing || r.hasRemarketing;
      existing.hasStoreVisit  = existing.hasStoreVisit  || r.hasStoreVisit;
      existing.hasDataFile    = existing.hasDataFile    || r.hasDataFile;
    }
    const unique = Array.from(byName.values()).sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase())
    );
    // Length + non-symbol filter only. An earlier Latin-script filter dropped
    // valid Cyrillic / Chinese / Arabic brand names from the table, so the
    // headline advertiser count disagreed with the table beneath it
    // (flagged 2026-05). Non-Latin advertisers are
    // real custom-audience entries — show them.
    const shownObjects = unique.filter(r =>
      r.name.length >= 2 && !/^[\d\W]+$/.test(r.name)
    );
    return {
      // Backward-compat: `shown` stays a string array so legacy renderers
      // (report.js HTML output, plus any bundled-export consumer) keep working.
      shown: shownObjects.map(r => r.name),
      // New: `shownObjects` carries the flags for the V2 dashboard's
      // logo + relevance filter.
      shownObjects,
      total_unique: unique.length,
      excluded_count: unique.length - shownObjects.length,
      total_rows: rawRecords.length,
    };
  }

  function extractOffMeta(files) {
    const d = loadJson(files, 'apps_and_websites_off_of_instagram/apps_and_websites/your_activity_off_meta_technologies.json');
    if (d) {
      // JSON path — handle BOTH schema shapes:
      //   (A) Old direct shape: { apps_and_websites_off_meta_activity: [{name, events: [{type, timestamp}]}] }
      //   (B) New array shape: [{title: "<merchant>", label_values: [{label:"ID", value}, {label:"Events"(localized), vec: [{dict: [{label:"ID",value},{label:"Event"(localized), value:"VIEW_CONTENT"}, {label:"Received"(localized), timestamp_value}]}]}]}]
      const out = [];
      const records = Array.isArray(d)
        ? d
        : (d.apps_and_websites_off_meta_activity || []);
      for (const a of records) {
        let appName = '';
        const types = {};
        const tsList = [];
        let eventCount = 0;
        // Shape A: flat events array with {type, timestamp}
        if (Array.isArray(a.events)) {
          appName = a.name || a.title || '';
          for (const e of a.events) {
            const t = e.type;
            if (t) types[t] = (types[t] || 0) + 1;
            if (e.timestamp) tsList.push(e.timestamp);
            eventCount++;
          }
        }
        // Shape B: title at top-level, events nested in label_values entry with vec of {dict}
        else if (a.title && Array.isArray(a.label_values)) {
          appName = a.title;
          // Events are in the label_values entry whose vec contains dict items
          const eventsEntry = a.label_values.find(lv =>
            Array.isArray(lv.vec) && lv.vec.length && lv.vec[0] && Array.isArray(lv.vec[0].dict)
          );
          if (eventsEntry) {
            for (const eventRecord of eventsEntry.vec) {
              const dict = eventRecord.dict || [];
              let type = '';
              let ts = 0;
              for (const field of dict) {
                // Event type: value matching ALL_CAPS_UNDERSCORES pattern
                if (!type && field.value && /^[A-Z][A-Z_]{2,30}$/.test(field.value)) {
                  type = field.value;
                }
                // Timestamp: timestamp_value field
                if (!ts && field.timestamp_value) ts = field.timestamp_value;
              }
              if (type) types[type] = (types[type] || 0) + 1;
              if (ts) tsList.push(ts);
              eventCount++;
            }
          }
        }
        if (!appName) continue;
        out.push({
          name: appName,
          event_count: eventCount,
          types: types,
          first_ts: tsList.length ? Math.min.apply(null, tsList) : 0,
          last_ts: tsList.length ? Math.max.apply(null, tsList) : 0,
        });
      }
      out.sort((a, b) => b.event_count - a.event_count);
      return out;
    }
    // HTML fallback — Meta's HTML export splits off-Meta activity into one file per app,
    // inside a directory: apps_and_websites_off_of_instagram/apps_and_websites/your_activity_off_meta_technologies/<app>.html
    //
    // Each app file has a structure like:
    //   <main>
    //     <div.pam.uiBoxWhite> (app-level wrapper)
    //       <h2>AppName</h2>
    //       For each event:
    //         <div.pam.uiBoxWhite> (event record)
    //           <tr><td>ID</td><td>event_id</td></tr>
    //           <tr><td>Событие/Event</td><td>PAGE_VIEW</td></tr>
    //           <tr><td>Получено/Received</td><td>2026 apr 06 5:01 am</td></tr>
    //         </div>
    //     </div>
    //   </main>
    //
    // The naive <tr>-per-event count used to triple-count (3 rows per event).
    // We now key on the EVENT-TYPE cell (an all-caps token like PAGE_VIEW)
    // since that appears exactly once per event record.
    const prefix = 'apps_and_websites_off_of_instagram/apps_and_websites/your_activity_off_meta_technologies/';
    const appFiles = Object.keys(files).filter(p =>
      p.startsWith(prefix) && p.endsWith('.html') && files[p] && files[p]._html
    );
    if (appFiles.length === 0) return [];
    const out = [];
    for (const path of appFiles) {
      const doc = loadHtmlDoc(files, path);
      if (!doc) continue;
      // App name is in the <h1> or <title>
      const h1 = doc.querySelector('h1');
      const titleEl = doc.querySelector('title');
      const appName = (h1 && h1.textContent.trim()) || (titleEl && titleEl.textContent.trim()) || '';
      // Strategy: count each "event type" cell — Meta tags event types as
      // ALL_CAPS_WITH_UNDERSCORES (PAGE_VIEW, PURCHASE, INITIATE_CHECKOUT, etc.)
      // and each event record contains exactly one such cell.
      const types = {};
      let eventCount = 0;
      const tsList = [];
      // Walk every <td> once; recognize event-type cells vs timestamp cells.
      doc.querySelectorAll('td').forEach(td => {
        const txt = (td.textContent || '').trim();
        if (!txt) return;
        if (/^[A-Z][A-Z_]{2,29}$/.test(txt)) {
          types[txt] = (types[txt] || 0) + 1;
          eventCount++;
          return;
        }
        // Timestamp heuristics — try native Date.parse first, then the locale-
        // agnostic Meta-timestamp parser (handles Russian month abbreviations).
        const t = Date.parse(txt);
        if (!isNaN(t) && t > 946684800000 /* year 2000 */) {
          tsList.push(Math.floor(t / 1000));
          return;
        }
        const t2 = parseMetaTimestamp(txt);
        if (t2 > 0) tsList.push(t2);
      });
      if (!appName) continue;
      // Honest zero when no event cells parsed (2026-08-01 HTML audit). The
      // old `eventCount || 1` + `{ UNKNOWN: 1 }` minted one event and one
      // event TYPE per app out of thin air — those flowed into the "N actions
      // shipped back to Meta" KPI and rendered an "Unknown" tracked-action row
      // with a computed share. The app's PRESENCE is real (Meta lists it), so
      // the row stays; the count it never carried does not.
      out.push({
        name: appName,
        event_count: eventCount,
        types: Object.keys(types).length ? types : null,
        first_ts: tsList.length ? Math.min.apply(null, tsList) : 0,
        last_ts: tsList.length ? Math.max.apply(null, tsList) : 0,
      });
    }
    out.sort((a, b) => b.event_count - a.event_count);
    return out;
  }

  function extractShopping(files) {
    const d = loadJson(files, 'your_instagram_activity/shopping/recently_viewed_items.json');
    if (!d) return [];
    const out = [];
    for (const it of (d.checkout_saved_recently_viewed_products || [])) {
      const sm = it.string_map_data || {};
      // English keys first, then position-based fallback (key order is
      // consistent: first = product name, second = merchant name)
      let product = (sm['Product Name'] || {}).value || '';
      let merchant = (sm['Merchant Name'] || {}).value || '';
      if (!product || !merchant) {
        const keys = Object.keys(sm);
        if (!product && keys[0]) product = (sm[keys[0]] || {}).value || '';
        if (!merchant && keys[1]) merchant = (sm[keys[1]] || {}).value || '';
      }
      // Fully-empty rows used to satisfy the Intent-section gate with
      // nothing to show.
      if (product || merchant) out.push({ product, merchant });
    }
    // Newer export shape (2026): a flat label_values entry whose label is
    // "Product names" and whose `vec` holds {value} per product. No merchant
    // is present in this shape, so surface the product alone rather than
    // silently dropping every recently-viewed item (the old code only read
    // checkout_saved_recently_viewed_products and returned [] on this shape).
    if (!out.length && Array.isArray(d.label_values)) {
      for (const lv of d.label_values) {
        if (!lv || !Array.isArray(lv.vec) || !/product/i.test(lv.label || '')) continue;
        for (const v of lv.vec) {
          const product = (v && (v.value != null ? v.value : v.Value)) || '';
          if (product) out.push({ product, merchant: '' });
        }
      }
    }
    return out;
  }

  function extractSubscriptionStatus(files) {
    const s = loadJson(files, 'your_instagram_activity/subscriptions/show_exclusive_story_promo_setting.json');
    if (!s) return null;
    for (const e of (s.subscriptions_show_story_teaser_setting || [])) {
      const sm = e.string_map_data || {};
      // English key first, then first-value fallback (file has single field)
      return (((sm['Exclusive Story Promo Setting'] || {}).value) || smFirstValue(sm)) || '';
    }
    return null;
  }

  // NO RENDER SURFACE YET, and it has a NON-RENDER CONSUMER: the parser
  // validator (tools/parser-validator/check.js) asserts this count against the
  // real export on every `npm run diff-check`, so deleting it breaks that tool
  // (2026-08-02, after the 2026-08-01 HTML audit flagged it as an unconsumed
  // key). The product rule that muted creators "surface in the Subscriptions
  // tab" is stale — that tab can never mount today, see extractSubscriptionStatus
  // above. Surface it or drop the pair deliberately; not in a prune sweep.
  //
  // Plan Phase B.11: muted_creators alongside the subscription-promo setting.
  // Returns array of usernames you've muted from paid-subscription teasers.
  // Currently surfaces in the Subscriptions tab; small but high-signal —
  // these are creators you actively chose not to see.
  function extractMutedCreators(files) {
    const d = loadJson(files, 'your_instagram_activity/subscriptions/your_muted_story_teaser_creators.json');
    if (!d) return [];
    const arr = d.subscriptions_muted_story_teaser_creators || [];
    const out = [];
    for (const e of arr) {
      const sm = e.string_map_data || {};
      const v = ((sm['Muted Creators'] || {}).value || smFirstValue(sm) || '').trim();
      if (v) out.push(v);
    }
    return out;
  }

  function extractLikesSummary(files) {
    const d = loadJson(files, 'your_instagram_activity/likes/liked_posts.json');
    const lcRaw = loadJson(files, 'your_instagram_activity/likes/liked_comments.json');
    // Empty only when BOTH likes files are absent (2026-08-01 HTML audit).
    // Meta omits files with no data, so a user who liked comments but no
    // posts in the window ships ONLY liked_comments.json — the old
    // `if (!d) return {}` threw that real signal away and the report claimed
    // zero tracked engagement over data that was sitting in the ZIP.
    if (!d && !lcRaw) return {};
    // Liked posts can come in three shapes Meta has shipped over time:
    //   (A) Array of {title, label_values, timestamp}
    //   (B) Object { likes_media_likes: [...] }
    //   (C) Object with NUMBERED keys "0", "1", "2", ... each holding
    //       an entry with timestamp + label_values. This is the
    //       newer export format Meta uses; an earlier parser
    //       returned 0 entries because neither (A) nor (B) matched.
    function entriesFromMixedShape(raw) {
      if (!raw) return [];
      if (Array.isArray(raw)) return raw;
      if (Array.isArray(raw.likes_media_likes)) return raw.likes_media_likes;
      if (Array.isArray(raw.likes_comment_likes)) return raw.likes_comment_likes;
      if (Array.isArray(raw.story_activities_story_likes)) return raw.story_activities_story_likes;
      // Shape C — numeric keys at the top level. Detect by checking
      // whether key "0" exists and is an object with a timestamp.
      if (raw['0'] && typeof raw['0'] === 'object' && (raw['0'].timestamp || raw['0'].label_values)) {
        const out = [];
        let i = 0;
        while (raw[String(i)] !== undefined) { out.push(raw[String(i)]); i++; }
        return out;
      }
      return [];
    }
    const items = entriesFromMixedShape(d);
    const creators = new Set();
    let firstTs = Infinity, lastTs = 0;
    for (const it of items) {
      // entryTimestamp: classic-shape exports carry the timestamp in
      // string_list_data, not it.timestamp — without the fallback the
      // likes window read as 0 days.
      const ts = entryTimestamp(it);
      if (ts > 0) { if (ts < firstTs) firstTs = ts; if (ts > lastTs) lastTs = ts; }
      // Shape A (label_values wrapper): owner username lives in title field.
      if (it.title && typeof it.title === 'string') {
        creators.add(it.title);
        continue;
      }
      // Legacy / nested dict shape: look for {label: "Username", value}
      for (const lv of (it.label_values || [])) {
        if (lv.title === 'Owner' || lv.label === 'Owner' || lv.label === 'Автор' /* RU */) {
          for (const inner of (lv.dict || [])) {
            for (const f2 of (inner.dict || [])) {
              if (f2.label === 'Username' || f2.label === 'Имя пользователя' /* RU */) {
                creators.add(f2.value || '');
              }
            }
          }
        }
      }
    }
    const lcItems = entriesFromMixedShape(lcRaw);
    // Compute actual window across both liked-posts and liked-comments
    // timestamps. This is what we show in the UI eyebrow. Reported 2026-06:
    // the likes are not over a 365-day period, probably also 7 days. Indeed,
    // Meta's newer exports cap these to ~7 days (matching ads_and_topics).
    for (const it of lcItems) {
      const ts = it && it.timestamp || (it && it.string_list_data && it.string_list_data[0] && it.string_list_data[0].timestamp) || 0;
      if (ts > 0) { if (ts < firstTs) firstTs = ts; if (ts > lastTs) lastTs = ts; }
    }
    const window_first = firstTs === Infinity ? 0 : firstTs;
    const window_last = lastTs;
    const window_days = (window_first && window_last > window_first)
      ? Math.max(1, Math.round((window_last - window_first) / 86400)) : 0;
    return {
      liked_posts_count: items.length,
      unique_creators: creators.size,
      liked_comments_count: lcItems.length,
      window_first, window_last, window_days,
    };
  }

  // Direct feed-impression counts from the IG export — these are the actual
  // posts + videos Meta showed in your feed during the data window. Cleaner
  // signal than the old "likes × 3" hack: instead of inferring impressions
  // from engagement, we just count what the export tells us was shown.
  // CPM auto-tier by detected locale. IG export labels + author names are a
  // reliable signal for the user's primary locale even when the platform
  // identity says US. We only down-tier; we never up-tier.
  function detectCpmTier(files) {
    const cyrillicRe = /[Ѐ-ӿ]/;
    function scan(filePath, wrapperKeys, max) {
      const d = loadJson(files, filePath);
      if (!d) return { cyrillic: 0, total: 0 };
      let entries = d;
      if (!Array.isArray(entries)) {
        entries = [];
        for (const k of wrapperKeys) if (Array.isArray(d[k])) { entries = d[k]; break; }
      }
      let cyrillic = 0, total = 0;
      for (const e of entries.slice(0, max)) {
        const blob = JSON.stringify(e);
        total++;
        if (cyrillicRe.test(blob)) cyrillic++;
      }
      return { cyrillic, total };
    }
    const a = scan('ads_information/ads_and_topics/ads_viewed.json',
      ['impressions_history_ads_seen', 'ads_viewed'], 200);
    const b = scan('ads_information/ads_and_topics/posts_viewed.json',
      ['impressions_history_posts_seen', 'posts_viewed'], 200);
    const c = scan('ads_information/ads_and_topics/videos_watched.json',
      ['impressions_history_videos_watched', 'videos_watched'], 200);
    const totalCyr = a.cyrillic + b.cyrillic + c.cyrillic;
    const totalEntries = a.total + b.total + c.total;
    if (totalEntries === 0) return { cpm: ACTIVE_PLATFORM.cpm, locale: 'unknown', reason: 'no content sampled' };
    const cyrFraction = totalCyr / totalEntries;
    if (cyrFraction >= 0.40) {
      return {
        cpm: 4,
        locale: 'ru-cis',
        reason: `Cyrillic detected in ${(cyrFraction * 100).toFixed(0)}% of sampled content (${totalCyr}/${totalEntries}) — Russia/CIS markets command $2-4 CPM, far below the US/UK $12 default. Using $4.`,
      };
    }
    return { cpm: ACTIVE_PLATFORM.cpm, locale: 'default', reason: '' };
  }

  function extractFeedImpressions(files) {
    const entryTime = entryTimestamp;
    function analyze(filePath, wrapperKeys) {
      const d = loadJson(files, filePath);
      if (!d) return { count: 0, first: 0, last: 0, days: 0, daily: 0 };
      let entries = d;
      if (!Array.isArray(entries)) {
        entries = [];
        for (const k of wrapperKeys) if (Array.isArray(d[k])) { entries = d[k]; break; }
      }
      let first = Infinity, last = 0;
      for (const e of entries) {
        const t = entryTime(e);
        if (t > 0) { if (t < first) first = t; if (t > last) last = t; }
      }
      // days: integer for display. days_exact: fractional span with a 1-day
      // floor, for annualization math — Math.round alone gave up to ±50%
      // error at Meta's 1-3-day windows, and a single-timestamp file
      // (span 0) used to read as "no window" and lose its real count.
      const hasSpan = first !== Infinity && last >= first;
      // days_exact is the RAW fractional span (no floor) — callers decide
      // how to clamp. Flooring sub-day spans to "1 day" here let a
      // single-session burst beat the wider sibling-file window downstream
      // and inflate the annualized headline ~7x for light users.
      const days_exact = hasSpan ? (last - first) / 86400 : 0;
      const days = hasSpan ? Math.max(1, Math.round(days_exact)) : 0;
      return {
        count: entries.length,
        first: first === Infinity ? 0 : first,
        last,
        days,
        days_exact,
        // Per-day rate floored at a 1-day span — a sub-day burst is "what
        // they saw that day", not a rate to extrapolate from.
        daily: (hasSpan && entries.length) ? entries.length / Math.max(1, days_exact) : 0,
      };
    }

    const posts = analyze('ads_information/ads_and_topics/posts_viewed.json',
      ['impressions_history_posts_seen', 'posts_viewed']);
    const videos = analyze('ads_information/ads_and_topics/videos_watched.json',
      ['impressions_history_videos_watched', 'videos_watched']);
    const adsViewed = analyze('ads_information/ads_and_topics/ads_viewed.json',
      ['impressions_history_ads_seen', 'ads_viewed']);
    const adsClicked = analyze('ads_information/ads_and_topics/ads_clicked.json',
      ['impressions_history_ads_clicked', 'ads_clicked']);

    // Shared fallback window: span across the sibling feed files (same
    // ads_and_topics export window) — used when a file's own timestamps
    // are missing/identical.
    const fwFirst = (posts.first && videos.first)
      ? Math.min(posts.first, videos.first)
      : (posts.first || videos.first || 0);
    const fwLast = Math.max(posts.last, videos.last);
    const fwDaysExact = (fwFirst && fwLast >= fwFirst)
      ? Math.max(1, (fwLast - fwFirst) / 86400) : 0;

    // Pick the best signal for ad-impression count — "actual over estimated":
    //  · ads_viewed.json is a direct ad-impression log → ALWAYS use the real
    //    count when it exists, even if its own timestamps are unusable
    //    (annualize via the sibling feed-file window in that case).
    //  · Fallback: (posts + videos) × 1/6 sponsored-ratio when ads_viewed
    //    is missing or empty. S6 (2026-08-07): this was 1/3 with nothing behind
    //    it. The one export we could measure end to end came out near 1 in 6,
    //    so 1/3 was doubling the
    //    assumed ad load of every export without an ads file. Re-cut the
    //    constant as more real exports arrive; it is a one-sample median, not a
    //    published benchmark. The v2 adapter's estimate branch carries the same
    //    number and the same note.
    let ad_method, period_ad_impressions, ad_window_days, ad_window_days_exact,
        ad_window_first, ad_window_last;
    if (adsViewed.count > 0) {
      ad_method = 'ads_viewed_direct';
      period_ad_impressions = adsViewed.count;
      const ownSpan = adsViewed.days_exact; // raw — 0 for single-timestamp files
      // N2 (2026-08-07), annualization floor. The old test was `ownSpan >= 1`,
      // so a 1-day span multiplied the count by 365 and one heavy evening
      // became the whole year. Below MIN_ANNUALIZE_DAYS we prefer the sibling
      // feed-file window — the same widening the sub-day branch below has
      // always done, now reached from a sane threshold instead of only from a
      // literal zero. The rule, in order:
      //   1. own span >= 5 days      -> use it, it is a real retention window
      //   2. a WIDER sibling window  -> use that (same export window, more days)
      //   3. own span >= 1 day       -> use it; a genuinely 3-day export is a
      //                                 short basis, not a refusal state, and
      //                                 inventing one would lose real counts
      //   4. some timestamps only    -> floor at 1 day
      //   5. nothing                 -> 0, and nothing gets annualized
      // Step 2 is gated on the sibling being WIDER (`> ownSpan`), never merely
      // present: swapping in a NARROWER window would inflate the very figure
      // this floor exists to protect. For ownSpan 0 that test is identical to
      // the old `fwDaysExact > 0`, so single-timestamp exports are unchanged.
      const MIN_ANNUALIZE_DAYS = 5;
      if (ownSpan >= MIN_ANNUALIZE_DAYS) {
        // The ads file's own span covers a real window — use it directly.
        ad_window_days = adsViewed.days;
        ad_window_days_exact = ownSpan;
        ad_window_first = adsViewed.first;
        ad_window_last = adsViewed.last;
      } else if (fwDaysExact > ownSpan) {
        // Short or sub-day ads span with a wider sibling window: annualize
        // against the sibling (same export window) instead of extrapolating a
        // burst across the year.
        ad_window_days = Math.round(fwDaysExact) || 1;
        ad_window_days_exact = fwDaysExact;
        ad_window_first = fwFirst;
        ad_window_last = fwLast;
      } else if (ownSpan >= 1) {
        // Short span, and no sibling window is any wider. An honestly short
        // basis beats refusing to report — keep the file's own window.
        ad_window_days = adsViewed.days;
        ad_window_days_exact = ownSpan;
        ad_window_first = adsViewed.first;
        ad_window_last = adsViewed.last;
      } else if (adsViewed.first > 0) {
        // Some timestamp signal, nothing covering a day, no sibling window:
        // floor at 1 day — the least-inflating defensible basis.
        ad_window_days = 1;
        ad_window_days_exact = 1;
        ad_window_first = adsViewed.first;
        ad_window_last = adsViewed.last;
      } else {
        // No timestamps anywhere — cannot annualize (handled below).
        ad_window_days = 0;
        ad_window_days_exact = 0;
        ad_window_first = 0;
        ad_window_last = 0;
      }
    } else {
      // Method id keeps its historical name so saved reports and any consumer
      // keying off the string still match; the RATIO is the thing that moved.
      ad_method = 'feed_one_third';
      period_ad_impressions = Math.round((posts.count + videos.count) / 6);
      ad_window_first = fwFirst;
      ad_window_last = fwLast;
      ad_window_days = Math.round(fwDaysExact) || 0;
      ad_window_days_exact = fwDaysExact;
    }
    // No usable window anywhere → we cannot honestly annualize. Emit 0 with
    // ad_annualized:false rather than passing the raw period count off as an
    // annual figure (the headline $ banner already gates on window > 0).
    const ad_annualized = ad_window_days_exact > 0;
    const annualScale = ad_annualized ? (365 / ad_window_days_exact) : 0;
    const ad_impressions = Math.round(period_ad_impressions * annualScale);
    // NO annualized click figure is emitted (removed 2026-09-07). There used
    // to be an ad_clicks_annual here. Nothing read it, and it could not have
    // been read honestly: Instagram prices no clicks, the count behind it is
    // outbound LINK taps rather than ad taps, and the CPC that would turn it
    // into money has no source. That is why the dashboard's click line was
    // removed on 2026-08-06 -- this was
    // the producer nobody switched off with it. The raw ads_clicked_count and
    // its source window are still emitted below; a consumer that finds an
    // honest basis for annualizing them can do it there.
    return {
      posts_viewed: posts.count,
      videos_watched: videos.count,
      ads_viewed_count: adsViewed.count,
      ads_clicked_count: adsClicked.count,
      total_views: posts.count + videos.count,
      sources: { posts, videos, ads_viewed: adsViewed, ads_clicked: adsClicked },
      ad_method,
      ad_window_days,
      ad_window_days_exact,
      ad_annualized,
      ad_window_first,
      ad_window_last,
      // Backward-compat aliases
      feed_window_days: ad_window_days,
      feed_window_first: ad_window_first,
      feed_window_last: ad_window_last,
      period_ad_impressions,
      ad_impressions,
    };
  }

  // Deep per-impression detail from ads_viewed.json — preserves caption,
  // Ad Library URL, IG post URL, owner bio-link, and timestamp for every
  // ad shown. Powers the "Who paid Meta to reach you" section: KPI strip,
  // daily stacked-column chart, hour-of-day sparkline, expandable brand
  // grid with per-row Ad Library links, quote rail, and interest clusters.
  // extractFeedImpressions only keeps count/days — this keeps the full
  // signal so 100% of the file's fields earn screen time. JSON-only;
  // HTML-format exports return {available:false} and the section renders
  // an honest empty state.
  function extractAdImpressionsDetail(files) {
    const empty = {
      available: false,
      total_impressions: 0,
      unique_brands: 0,
      days_observed: 0,
      first_ts: 0,
      last_ts: 0,
      ads_with_caption: 0,
      ads_with_ad_library: 0,
      ads_with_owner_url: 0,
      brands: [],
      daily: [],
      hourly: new Array(24).fill(0),
      domains: [],
      clusters: {},
    };
    const d = loadJson(files, 'ads_information/ads_and_topics/ads_viewed.json');
    if (!d) return empty;
    let entries = d;
    if (!Array.isArray(entries)) {
      entries = [];
      for (const k of ['impressions_history_ads_seen', 'ads_viewed']) {
        if (Array.isArray(d[k])) { entries = d[k]; break; }
      }
    }
    if (!entries.length) return empty;

    const brandMap = new Map();
    const dayMap = new Map();
    const hourly = new Array(24).fill(0);
    const domainMap = new Map();
    let withCaption = 0, withAdLibrary = 0, withOwnerUrl = 0;
    let firstTs = Infinity, lastTs = 0;
    const pad2 = (n) => String(n).padStart(2, '0');

    // Entries that carry a usable timestamp. Everything this function reports
    // — brands, daily, hourly, domains, days_observed — is derived from THIS
    // set, because the loop skips untimed rows. total_impressions must count
    // the same set or the headline and the breakdown beneath it describe
    // different things (2026-08-01 review): an ads_viewed.json without
    // per-event timestamps would otherwise claim N impressions above an empty
    // brand grid and days_observed 0. extractDeviceFingerprint keeps its count
    // and rate on one set for the same reason.
    let timedEntries = 0;

    for (const e of entries) {
      const ts = entryTimestamp(e);
      if (!ts) continue;
      timedEntries++;
      if (ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;

      let owner = null, postUrl = '', adLibrary = '', caption = '';
      for (const lv of (e.label_values || [])) {
        // Advertiser (Owner) block — locale-agnostic, structure-keyed. The
        // logic moved to the shared ownerFromLabelValue helper (2026-08-01)
        // so the story + attention extractors run the SAME rules instead of
        // their old English-title-only copies. This is what lets non-English
        // exports (the population most likely to carry ads_clicked.json)
        // populate sa.brands and the click cross-ref at all.
        {
          const o = ownerFromLabelValue(lv);
          if (o) { owner = o; continue; }
        }
        // Flat fields — English label first, value pattern as the locale-
        // agnostic fallback: the Ad Library link is detectable by /ads/library/,
        // and the first non-URL free-text value is the caption.
        const val = lv.value;
        if (!val) continue;
        const vu = safeHttpUrl(val);
        if (lv.label === 'URL') postUrl = vu;
        else if (lv.label === 'Ad library public URL' || (vu && /\/ads\/library/i.test(vu))) adLibrary = vu;
        else if (lv.label === 'Caption') caption = val;
        else if (!vu && !caption && typeof val === 'string' && val.trim()) caption = val;
      }
      if (caption) withCaption++;
      if (adLibrary) withAdLibrary++;

      // Local-time bucketing — what hour the user actually saw the ad on
      // their device, not UTC. getHours()/getDate() use the runtime TZ.
      const dt = new Date(ts * 1000);
      const dateKey = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
      const hour = dt.getHours();
      hourly[hour]++;
      if (!dayMap.has(dateKey)) {
        dayMap.set(dateKey, { date: dateKey, total: 0, morning: 0, afternoon: 0, evening: 0, lateNight: 0 });
      }
      const day = dayMap.get(dateKey);
      day.total++;
      if (hour >= 6 && hour < 12) day.morning++;
      else if (hour >= 12 && hour < 18) day.afternoon++;
      else if (hour >= 18 && hour < 24) day.evening++;
      else day.lateNight++;

      if (owner && owner.username) {
        if (owner.url) withOwnerUrl++;
        if (!brandMap.has(owner.username)) {
          brandMap.set(owner.username, {
            username: owner.username,
            name: owner.name || '',
            url: owner.url || '',
            count: 0,
            firstSeen: ts,
            lastSeen: ts,
            impressions: [],
          });
        }
        const b = brandMap.get(owner.username);
        b.count++;
        if (ts < b.firstSeen) b.firstSeen = ts;
        if (ts > b.lastSeen) b.lastSeen = ts;
        if (!b.name && owner.name) b.name = owner.name;
        if (!b.url && owner.url) b.url = owner.url;
        b.impressions.push({ ts, caption, adLibrary, postUrl });

        // Bio URLs only — postUrl is an instagram.com permalink, which used
        // to flood the domains ranking with "instagram.com".
        const linkUrl = owner.url;
        if (linkUrl) {
          try {
            const u = new URL(linkUrl.startsWith('http') ? linkUrl : 'http://' + linkUrl);
            const host = u.hostname.replace(/^www\./, '');
            domainMap.set(host, (domainMap.get(host) || 0) + 1);
          } catch (_) {}
        }
      }
    }

    for (const b of brandMap.values()) {
      let top = '';
      for (const imp of b.impressions) {
        if (imp.caption && imp.caption.length > top.length) top = imp.caption;
      }
      b.topCaption = top;
    }

    const brands = [...brandMap.values()].sort((a, b) => b.count - a.count);
    const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    const domains = [...domainMap.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count);
    const days = (firstTs !== Infinity && lastTs > firstTs)
      ? Math.max(1, Math.round((lastTs - firstTs) / 86400)) : 0;

    // Recency-bounded unique-advertiser count for the "competed for your
    // attention recently" demand metric (2026-06-30 audit). A normal IG export
    // already spans only ~7 days, so its whole window IS the recent window —
    // don't reduce it (the user's own count is preserved). Only when the export window
    // is materially wider than that (a merged / continuous-ledger archive) do we
    // enforce a true 7-day cutoff so stale advertisers aren't counted as "recent".
    const recentCutoff = (lastTs - firstTs) > 14 * 86400 ? (lastTs - 7 * 86400) : 0;
    const uniqueBrandsRecent = recentCutoff
      ? brands.filter((b) => b.lastSeen >= recentCutoff).length
      : brands.length;
    return {
      available: true,
      total_impressions: timedEntries,
      unique_brands: brands.length,
      // Recent (last-7-day) unique advertisers when the window is wide; equals
      // unique_brands for a normal export. This is what feeds the demand metric.
      unique_brands_recent: uniqueBrandsRecent,
      days_observed: days,
      first_ts: firstTs === Infinity ? 0 : firstTs,
      last_ts: lastTs,
      ads_with_caption: withCaption,
      ads_with_ad_library: withAdLibrary,
      ads_with_owner_url: withOwnerUrl,
      brands,
      daily,
      hourly,
      domains,
      clusters: clusterAdImpressions(brands),
    };
  }

  // ads_information/ads_and_topics/ads_clicked.json — the exact ads the user
  // TAPPED, advertiser by advertiser, with per-event timestamps. Distinct from
  // extractFeedImpressions (keeps only a count) and extractAdImpressionsDetail
  // (ads SHOWN, from ads_viewed.json). Handles BOTH the bare top-level-array
  // shape (newer exports) and the legacy { impressions_history_ads_clicked: [] }
  // wrapper. Locale-agnostic by design: the advertiser and the Ad Library URL
  // are detected by VALUE pattern and position, never by the (localized) label
  // text — Meta's schema order is [Action, Name, Ad-library URL, URL], so the
  // last non-URL text value seen before the ad-library link IS the advertiser
  // and the constant Action word ("Click"/localized) is skipped without reading
  // any label. Mojibake in advertiser names is already fixed upstream by the
  // load pipeline (fixMetaMojibakeDeep on every parsed file), so no extra
  // decoding happens here. Returns null when the file is absent OR carries no
  // usable rows — the COMMON case: Meta caps this file around 7 days and often
  // omits it entirely (measured exports have had none), so the dashboard shows
  // an honest empty state rather than an error.
  function extractClickedAds(files) {
    const raw = loadJson(files, 'ads_information/ads_and_topics/ads_clicked.json');
    if (!raw) return null; // file absent -> honest empty state
    let entries = raw;
    if (!Array.isArray(entries)) {
      entries = [];
      for (const k of ['impressions_history_ads_clicked', 'ads_clicked']) {
        if (Array.isArray(raw[k])) { entries = raw[k]; break; }
      }
    }
    if (!Array.isArray(entries)) entries = [];

    const events = [];
    let firstTs = Infinity, lastTs = 0;
    for (const e of entries) {
      if (!e || typeof e !== 'object') continue;
      const ts = entryTimestamp(e);

      let advertiser = '', adLibraryUrl = '';
      const lvs = Array.isArray(e.label_values) ? e.label_values : null;
      if (lvs) {
        // Walk label_values in order. A URL value is never the advertiser; the
        // one matching /ads/library/ is the Ad Library link. The advertiser is
        // the most recent NON-URL text value seen before that link.
        let lastText = '';
        for (const lv of lvs) {
          if (!lv || typeof lv !== 'object') continue;
          const url = safeHttpUrl(lv.value) || safeHttpUrl(lv.href);
          if (url) {
            if (/\/ads\/library/i.test(url)) {
              if (!adLibraryUrl) adLibraryUrl = url;
              if (!advertiser && lastText) advertiser = lastText;
            }
            continue; // URL-shaped value: not an advertiser name
          }
          if (typeof lv.value === 'string' && lv.value.trim()) lastText = lv.value.trim();
        }
        if (!advertiser && lastText) advertiser = lastText;
      }
      // Legacy wrapper rows (and any bare-array row without label_values) may
      // carry the advertiser as a plain title/name field instead.
      if (!advertiser) {
        if (typeof e.title === 'string') advertiser = e.title.trim();
        else if (typeof e.name === 'string') advertiser = e.name.trim();
      }
      advertiser = String(advertiser || '').trim();
      if (!advertiser && !ts) continue; // nothing usable on this row

      if (ts > 0) { if (ts < firstTs) firstTs = ts; if (ts > lastTs) lastTs = ts; }
      events.push({ ts: ts || 0, advertiser: advertiser, ad_library_url: adLibraryUrl });
    }

    if (!events.length) return null; // present-but-empty log -> same empty state

    const hasSpan = firstTs !== Infinity && lastTs >= firstTs;
    // Whole-day window, floored at 1 — consistent with extractAdImpressionsDetail.
    // Callers that need the exact fractional span derive it from first_ts/last_ts.
    const window_days = hasSpan ? Math.max(1, Math.round((lastTs - firstTs) / 86400)) : 0;
    return {
      events: events,
      total: events.length,
      window_days: window_days,
      first_ts: firstTs === Infinity ? 0 : firstTs,
      last_ts: lastTs,
    };
  }

  // Heuristic interest clustering over the brand list. Patterns match
  // username, display name, and the longest caption. Tagged "Inferred"
  // in the UI per feedback_evidence_hierarchy. Add/edit a rule = add a
  // bucket; brand can appear in multiple buckets if it matches.
  function clusterAdImpressions(brands) {
    // Every token here has to name a brand with its own commercial presence, or
    // be a plain category word. Nothing that names one person.
    //
    // This list was originally grown by reading one real export, and by
    // 2026-07-31 it had picked up ~69 tokens that were individual creators, a
    // personal coach, single-city venues, a private club, health brands that
    // imply a diagnosis, and the handles of a class-action claim. report.js is
    // served to every visitor, so all of that was public. Two whole rules came
    // out with it: "Comedy & creators" and "Class action / legal" were nothing
    // but individual handles once the personal ones were removed.
    //
    // The test is not "would this brand advertise to me" but "could many
    // unrelated people see this ad". When unsure, leave it out: a missing token
    // costs one uncategorized brand, a personal one publishes somebody's life.
    // The gate's served-file scan holds the removed names so they cannot
    // return.
    const RULES = [
      { key: 'ai_productivity', label: 'AI & productivity', re: /openai|chatgpt|perplexity|claude|anthropic|gemini|copilot|midjourney|notion|grammarly|canva|codex/i },
      { key: 'finance', label: 'Personal finance', re: /capitalone|americanexpress|\bchase\b|citibank|wellsfargo|discover ?card|\bstripe\b|\bvisa\b|mastercard|paypal|progressive|geico|robinhood|coinbase|fidelity|vanguard|schwab|\bsofi\b|nerdwallet|creditkarma|quickbooks|turbotax|wallstreet/i },
      { key: 'poker', label: 'Poker', re: /poker|wsop|888poker/i },
      { key: 'tennis', label: 'Tennis', re: /tennis|babolat|yonex|atptour|wtatennis/i },
      // Prefix boundary (\bchess, not \bchess\b) so handle forms like
      // chesscom/chess24/chessbrah still match while "duchess" doesn't.
      { key: 'chess', label: 'Chess', re: /\bchess/i },
      // Fitness hardware and general wellness only. A brand whose whole
      // inventory treats ONE condition is deliberately excluded: matching it
      // would record a diagnosis. Fitness stays; treatment does not.
      { key: 'health', label: 'Health & body', re: /whoop|fitbit|garmin|peloton|nordictrack|myfitnesspal|strava|oura ?ring|gymshark|lululemon|planetfitness/i },
      { key: 'luxury_travel', label: 'Luxury & travel', re: /chanel|gucci|prada|burberry|rolex|cartier|tiffany|louisvuitton|hermes|lexus|\bbmw\b|mercedes|fourseasons|ritzcarlton|marriott|hilton|hyatt|airbnb|expedia|booking\.com|tripadvisor|emirates|equinox/i },
      { key: 'pets', label: 'Pets', re: /purina|chewy|petco|petsmart|pedigree|royalcanin|bluebuffalo|hillspet|barkbox/i },
      { key: 'news_media', label: 'News & media', re: /nytimes|washingtonpost|\bwsj\b|bloomberg|reuters|\bcnn\b|\bbbc\b|nypost|netflix|hbomax|paramountplus|\bhulu\b|disneyplus|spotify/i },
      { key: 'b2b_saas', label: 'B2B software', re: /salesforce|hubspot|\bslack\b|\bzoom\b|atlassian|shopify|squarespace|godaddy|bluehost|mailchimp|coursera|udemy|wharton|harvard/i },
      { key: 'fashion_apparel', label: 'Fashion & apparel', re: /adidas|\bnike\b|\bpuma\b|underarmour|\bzara\b|uniqlo|levis|ralphlauren|tommyhilfiger|calvinklein|oldnavy|\basos\b|shein|warbyparker/i },
    ];
    const out = {};
    for (const rule of RULES) {
      const matches = [];
      for (const b of brands) {
        const blob = (b.username + '|' + b.name + '|' + (b.topCaption || '')).toLowerCase();
        if (rule.re.test(blob)) {
          // Brands (from extractAdImpressionsDetail) have b.count; creators
          // (from extractAttentionMining's creatorMap) have b.total. Accept
          // either shape so this clusterer is safe to call from both sites.
          const n = (typeof b.count === 'number') ? b.count
                   : (typeof b.total === 'number') ? b.total : 0;
          matches.push({ username: b.username, name: b.name, count: n });
        }
      }
      if (matches.length > 0) {
        out[rule.key] = {
          label: rule.label,
          brands: matches,
          impressions: matches.reduce((s, m) => s + (m.count || 0), 0),
        };
      }
    }
    return out;
  }

  // Fresh-interest mining over the full ads_and_topics folder
  // (posts_viewed + videos_watched + ads_viewed). extractFeedImpressions
  // only counts entries; extractAdImpressionsDetail only deep-parses the
  // ads stream. This extractor mines OWNERS + CAPTIONS across all three
  // streams to surface:
  //   · top_creators       — who actually held your attention (organic feed)
  //   · top_advertisers_7d — who paid to reach you in the 7-day window
  //                          (distinct from the lifetime advertiser list)
  //   · behavior_topics    — caption-keyword inference, fresher than
  //                          Meta's stated `topics` (which can be months
  //                          stale). Tagged "Inferred from behavior" in UI.
  //   · ad_density_pct     — ads / (posts + videos + ads), the
  //                          "1 in 6 things on your feed was sponsored"
  //                          headline number.
  function extractAttentionMining(files) {
    const empty = {
      available: false,
      window_first: 0, window_last: 0, window_days: 0,
      posts_count: 0, videos_count: 0, ads_count: 0, total_content: 0,
      ad_density_pct: 0,
      top_creators: [], top_advertisers_7d: [], behavior_topics: [],
      top_hashtags: [], top_brand_mentions: [],
      hourly: new Array(24).fill(0),
      daily: [],
      peak_day: null, peak_hour: null,
      daypart: { morning: 0, afternoon: 0, evening: 0, lateNight: 0 },
      linkInBioCreatorPct: 0, linkInBioCreators: 0,
      non_english_share_pct: 0,
      captions_analyzed: 0,
    };

    function entriesOf(d, keys) {
      if (!d) return [];
      if (Array.isArray(d)) return d;
      for (const k of keys) if (Array.isArray(d[k])) return d[k];
      return [];
    }

    const postsRaw = entriesOf(loadJson(files, 'ads_information/ads_and_topics/posts_viewed.json'),
      ['impressions_history_posts_seen', 'posts_viewed']);
    const videosRaw = entriesOf(loadJson(files, 'ads_information/ads_and_topics/videos_watched.json'),
      ['impressions_history_videos_watched', 'videos_watched']);
    const adsRaw = entriesOf(loadJson(files, 'ads_information/ads_and_topics/ads_viewed.json'),
      ['impressions_history_ads_seen', 'ads_viewed']);

    if (!postsRaw.length && !videosRaw.length && !adsRaw.length) return empty;

    // Aggregators shared across all three streams. Hourly/daily are
    // bucketed in LOCAL time (user's browser TZ) — that's what they
    // actually experienced, not UTC. Matches extractAdImpressionsDetail.
    const creatorMap = new Map();      // organic only (posts + videos)
    const advertiserMap = new Map();   // ads only
    const hourly = new Array(24).fill(0);
    const dayMap = new Map();
    const allCaptions = [];
    const pad2 = (n) => String(n).padStart(2, '0');

    function parseStream(entries, kind, map) {
      let firstTs = Infinity, lastTs = 0;
      for (const e of entries) {
        const ts = entryTimestamp(e);
        if (ts > 0) { if (ts < firstTs) firstTs = ts; if (ts > lastTs) lastTs = ts; }
        let caption = '', postUrl = '';
        // Owner via the shared picker (prefers a titled Owner block, and never
        // returns a Hashtags block — see ownerFromLabelValue's Hashtags note).
        const owner = ownerFromLabelValues(e.label_values);
        for (const lv of (e.label_values || [])) {
          if (lv.dict && lv.dict[0] && lv.dict[0].dict) continue; // handled above
          if (!lv.value) continue;
          const vu = safeHttpUrl(lv.value);
          if (lv.label === 'URL') postUrl = vu;
          else if (lv.label === 'Caption') caption = lv.value;
          // Locale fallback, same rule extractAdImpressionsDetail uses: the
          // first non-URL free-text value on the entry is the caption.
          else if (!vu && !caption && typeof lv.value === 'string' && lv.value.trim()) caption = lv.value;
        }
        if (caption) allCaptions.push(caption);
        if (ts > 0) {
          const dt = new Date(ts * 1000);
          hourly[dt.getHours()]++;
          const dateKey = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
          if (!dayMap.has(dateKey)) dayMap.set(dateKey, { date: dateKey, total: 0, posts: 0, videos: 0, ads: 0 });
          const day = dayMap.get(dateKey);
          day.total++;
          day[kind]++;
        }
        if (owner && owner.username) {
          const k = owner.username;
          const c = map.get(k) || {
            username: k, name: '', url: '',
            posts: 0, videos: 0, ads: 0, total: 0,
            firstSeen: ts || 0, lastSeen: ts || 0,
            topCaption: '', topPostUrl: '',
          };
          if (!c.name && owner.name) c.name = owner.name;
          if (!c.url && owner.url) c.url = owner.url;
          c[kind]++;
          c.total++;
          if (ts > 0) {
            if (!c.firstSeen || ts < c.firstSeen) c.firstSeen = ts;
            if (ts > c.lastSeen) c.lastSeen = ts;
          }
          // Pick the longest caption per creator — best chance of being
          // representative content (short captions are usually just
          // hashtags or emoji). Mirrors extractAdImpressionsDetail.
          if (caption && caption.length > c.topCaption.length) c.topCaption = caption;
          // First non-empty post URL we see; preserved so the UI can
          // link "see what this creator showed you" → IG permalink.
          if (postUrl && !c.topPostUrl) c.topPostUrl = postUrl;
          map.set(k, c);
        }
      }
      return { firstTs: firstTs === Infinity ? 0 : firstTs, lastTs };
    }

    const wp = parseStream(postsRaw, 'posts', creatorMap);
    const wv = parseStream(videosRaw, 'videos', creatorMap);
    const wa = parseStream(adsRaw, 'ads', advertiserMap);

    // Window union
    const allFirst = [wp.firstTs, wv.firstTs, wa.firstTs].filter(t => t > 0);
    const allLast = [wp.lastTs, wv.lastTs, wa.lastTs].filter(t => t > 0);
    const window_first = allFirst.length ? Math.min(...allFirst) : 0;
    const window_last = allLast.length ? Math.max(...allLast) : 0;
    const window_days = (window_first && window_last > window_first)
      ? Math.max(1, Math.round((window_last - window_first) / 86400)) : 0;

    const posts_count = postsRaw.length;
    const videos_count = videosRaw.length;
    const ads_count = adsRaw.length;
    const total_content = posts_count + videos_count + ads_count;
    const ad_density_pct = total_content > 0
      ? Math.round(ads_count / total_content * 1000) / 10 : 0;

    // Daypart roll-up + peak hour/day. Dayparts match the ads_viewed
    // extractor's buckets so the UI can share legend colors.
    const daypart = { morning: 0, afternoon: 0, evening: 0, lateNight: 0 };
    for (let h = 0; h < 24; h++) {
      if (h >= 6 && h < 12) daypart.morning   += hourly[h];
      else if (h >= 12 && h < 18) daypart.afternoon += hourly[h];
      else if (h >= 18 && h < 24) daypart.evening   += hourly[h];
      else daypart.lateNight  += hourly[h];
    }
    let peak_hour = null, peakHourCount = 0;
    for (let h = 0; h < 24; h++) {
      if (hourly[h] > peakHourCount) { peakHourCount = hourly[h]; peak_hour = h; }
    }
    const daily = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
    let peak_day = null;
    for (const d of daily) if (!peak_day || d.total > peak_day.total) peak_day = d;

    // Caption-keyword topic inference. Each rule fires independently;
    // a caption can match multiple. The buckets cover the broad categories
    // of feed content so large swaths do not go unbucketed. Every token is a
    // plain category word or a household-name brand — never something whose
    // presence would say whose archive the list was written against.
    const TOPIC_RULES = [
      { topic: 'Personal finance & investing', re: /\b(invest(?:ing|ment|or)?|stocks?|nasdaq|s&p ?500|nvda|tesla|tsla|aapl|spy|qqq|wall ?street|federal reserve|the fed|fomc|earnings|crypto|bitcoin|ethereum|trading|portfolio|broker(?:age)?|robinhood|coinbase|sofi|nyse|ipo|hedge fund|kalshi|options? trad|hedge)\b/i },
      { topic: 'AI & productivity tools',      re: /\b(chatgpt|openai|anthropic|claude|perplexity|llm|prompt engineering|cursor|copilot|midjourney|stable diffusion|generative ai|ai (?:tool|app|model|agent))\b/i },
      { topic: 'Poker & casino',               re: /\b(poker|hold[- ]?em|wsop|wpt|texas hold|chip leader|final table|pocket aces|pocket kings|all[- ]?in|bluff|tournament play|casino|blackjack|roulette)\b/i },
      // "wow" dropped — the bare exclamation is one of the most common
      // caption words and inflated Gaming for non-gamers.
      { topic: 'Gaming',                       re: /\b(dota ?2|apex legends|league of legends|fortnite|valorant|esports|twitch stream|gameplay|raid boss|patch notes|world of warcraft)\b/i },
      { topic: 'Pets & animals',               re: /\b(puppy|puppies|kitten|kittens|pomeranian|golden retriever|labrador|husky|chihuahua|breed(?:s|er)|cat (?:owner|video|meme|s? of)|dog (?:owner|video|meme|park|s? of)|catsofinstagram|dogsofinstagram)\b/i },
      { topic: 'Fitness & body',               re: /\b(gym|workout|fitness|protein|deadlift|squat|bench press|cardio|whoop|peloton|crossfit|hypertrophy|macros?)\b/i },
      { topic: 'News & politics',              re: /\b(trump|biden|harris|gaza|israel|ukraine|russia|election|senator|president|congress|breaking news)\b/i },
      { topic: 'Sports',                       re: /\b(nfl|nba|mlb|nhl|ufc|knicks|lakers|warriors|playoffs|championship|super bowl|world series|stanley cup|tennis|formula 1|f1 racing|soccer|football|futbol|fútbol|premier league|la liga|serie a|bundesliga|ligue 1|uefa|champions league|europa league|world cup|euros|mls|concacaf|fifa|barcelona|real madrid|manchester united|manchester city|liverpool|arsenal|chelsea|tottenham|bayern|psg|juventus|dortmund|espn ?fc|fabrizio romano|bleacher report|onefootball|messi|ronaldo|cristiano|mbappe|haaland|neymar|ballon d'or)\b/i },
      { topic: 'Food & cooking',               re: /\b(recipe|cooking|chef|restaurant|kitchen|cuisine|burger|pizza|sushi|cocktail|barista)\b/i },
      { topic: 'Cars & luxury',                re: /\b(porsche|ferrari|lamborghini|mclaren|bugatti|supercar|patek|rolex|hublot|audemars piguet)\b/i },
      { topic: 'Travel',                       re: /\b(travel|flight|hotel|vacation|airbnb|destination|four seasons|ritz[- ]?carlton|layover|itinerary|frequent flyer|boarding pass|tourism)\b/i },
      { topic: 'Business & entrepreneurship',  re: /\b(entrepreneur|founder(?:s)?|ceo|startup|saas|revenue|fundraise|llc|seed round|series [abc]|venture capital)\b/i },
      // Buckets added from prior videos_watched chat:
      { topic: 'Comedy, memes & relatable',    re: /\b(meme|memes|comedy|funny|hilarious|joke|relatable|skit|sketch|lol|lmao|brainrot|ngl|fr fr|ong)\b/i },
      { topic: 'Dating & relationships',       re: /\b(dating|relationship|girlfriend|boyfriend|husband|wife|breakup|heartbreak|red flag|green flag|situationship|gf|bf)\b/i },
      { topic: 'Family & parenting',           re: /\b(parenting|mom|mommy|dad|daddy|kids|toddler|infant|newborn|family vlog|momlife|dadlife)\b/i },
      { topic: 'Music',                        re: /\b(producer|songwriter|tour dates|new album|new single|spotify|apple music|drake|kendrick|taylor swift|beyonce)\b/i },
      { topic: 'Fashion & beauty',             re: /\b(fashion|outfit|ootd|streetwear|aesthetic|makeup|skincare|haircare|nail art|vogue|gucci|chanel|hermes)\b/i },
      { topic: 'Self-improvement',             re: /\b(self[- ]improvement|mindset|discipline|grindset|motivation|productivity|habit stack|hustle culture|stoic|stoicism)\b/i },
      { topic: 'Real estate',                  re: /\b(real estate|realtor|listing|mortgage|first[- ]time (?:home )?buyer|fix and flip|airbnb investor|rent vs buy)\b/i },
    ];

    // Hashtag extraction — independent signal from topic regex.
    // #FYP / #explore are Meta-suggested algorithm tags; finance/poker
    // hashtags are creator-chosen niche claims. Both worth surfacing.
    const hashtagCounts = {};

    // Brand mentions in organic captions — DIFFERENT from advertisers.
    // These are creators name-dropping brands (Goldman, NYT, Apple, etc.)
    // which proves Meta's algorithm clusters you with audiences that
    // talk about those brands, regardless of whether those brands paid
    // to reach you. Keep the list tight (curated; not exhaustive).
    const BRAND_MENTIONS = {
      finance: /\b(goldman|jpmorgan|bloomberg|chase bank|blackrock|vanguard|fidelity|charles schwab|morgan stanley|citi|barclays|deutsche bank)\b/i,
      big_tech: /\b(youtube|tiktok(?!\.com\/embed)|apple inc|google search|microsoft|amazon prime|nvidia|tesla|spacex|meta platforms|x \(twitter\))\b/i,
      ai_brands: /\b(chatgpt|openai|anthropic|claude|perplexity|gemini|copilot)\b/i,
      streaming: /\b(netflix|hbo max|hulu|disney\+|paramount\+|peacock|tidal|spotify premium)\b/i,
      media: /\b(new york times|nytimes|nyt|wall street journal|wsj|washington post|the atlantic|bloomberg news)\b/i,
      luxury: /\b(lamborghini|ferrari|porsche|patek philippe|rolex|hermes|chanel|gucci|louis vuitton|cartier|audemars piguet|hublot)\b/i,
      airlines: /\b(southwest airlines|delta air|american airlines|united airlines|emirates airlines|qatar airways|lufthansa)\b/i,
    };

    // Disclaimer fingerprint — "not financial advice" boilerplate the
    // SEC-aware finance creators paste at the end of their content.
    // Density of these phrases is a publishable proof that Meta has
    // clustered you into the finance-attuned audience: the algorithm
    // serves you content from creators who write disclaimers, even if
    // you've never said the word "stocks" yourself.
    const DISCLAIMER_PHRASES = [
      /not financial advice/i,
      /for educational purposes/i,
      /for informational purposes/i,
      /do your own research/i,
      /\bdyor\b/i,
      /consult (?:a |with a |your )?(?:financial|investment) (?:advisor|professional)/i,
      /not investment advice/i,
      /entertainment purposes only/i,
    ];

    const topicCounts = {};
    const brandMentionCounts = { finance: 0, big_tech: 0, ai_brands: 0, streaming: 0, media: 0, luxury: 0, airlines: 0 };
    let nonEnglish = 0;
    let disclaimerHits = 0;
    for (const cap of allCaptions) {
      for (const r of TOPIC_RULES) {
        if (r.re.test(cap)) topicCounts[r.topic] = (topicCounts[r.topic] || 0) + 1;
      }
      for (const [bk, re] of Object.entries(BRAND_MENTIONS)) {
        if (re.test(cap)) brandMentionCounts[bk]++;
      }
      const tags = cap.match(/#[A-Za-z0-9_]{2,30}/g) || [];
      for (const t of tags) {
        const k = t.toLowerCase();
        hashtagCounts[k] = (hashtagCounts[k] || 0) + 1;
      }
      // Non-English heuristic: < 40% ASCII letters means the caption
      // probably isn't English (Arabic, Cyrillic, Japanese, etc.).
      // Honest caveat — our regex topic rules are English-biased.
      const asciiLetters = (cap.match(/[A-Za-z]/g) || []).length;
      const totalLetters = (cap.match(/\p{L}/gu) || []).length || 1;
      if (asciiLetters / totalLetters < 0.4) nonEnglish++;
      // Disclaimer fingerprint — a caption matches if ANY phrase fires.
      for (const re of DISCLAIMER_PHRASES) {
        if (re.test(cap)) { disclaimerHits++; break; }
      }
    }
    // capsBase = ALL captions: correct denominator for the non-English and
    // disclaimer "share of captions" stats below.
    const capsBase = allCaptions.length || 1;
    // topicHitTotal = sum of topic hits: the correct denominator for each
    // interest's share of CLASSIFIED signal. Dividing by all captions deflated
    // each topic to near-zero — a heavy football fan read low single digits. count
    // drives the bars; pct is kept correct in case it's surfaced.
    const topicHitTotal = Object.values(topicCounts).reduce((a, b) => a + b, 0) || 1;
    const behavior_topics = Object.entries(topicCounts)
      .map(([topic, count]) => ({ topic, count, pct: Math.round(count / topicHitTotal * 1000) / 10 }))
      .sort((a, b) => b.count - a.count);
    const top_hashtags = Object.entries(hashtagCounts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);
    const top_brand_mentions = Object.entries(brandMentionCounts)
      .filter(([, c]) => c > 0)
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
    const non_english_share_pct = Math.round(nonEnglish / capsBase * 1000) / 10;

    // Top creators — preserve link-in-bio URL so the UI can surface
    // "creator monetizes you via X" + an outbound link button.
    const top_creators = [...creatorMap.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 50);
    const top_advertisers_7d = [...advertiserMap.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 30)
      .map(a => ({
        username: a.username, name: a.name, url: a.url || '',
        count: a.total,
        firstSeen: a.firstSeen || 0, lastSeen: a.lastSeen || 0,
        topCaption: a.topCaption || '', topPostUrl: a.topPostUrl || '',
      }));

    // Link-in-bio creator share — the "creator economy storefront" stat.
    // Counted across ALL organic creators, not just the top N.
    let creatorsWithLink = 0;
    for (const c of creatorMap.values()) if (c.url) creatorsWithLink++;
    const linkInBioCreators = creatorsWithLink;
    const linkInBioCreatorPct = creatorMap.size > 0
      ? Math.round(creatorsWithLink / creatorMap.size * 1000) / 10 : 0;

    // Outbound domain aggregation across ALL organic creators (not just
    // top 50). Mirrors extractAdImpressionsDetail.domains — surfaces the
    // raw monetization plumbing: linktr.ee = X creators, beacons.ai = Y,
    // etc. A large share of impressions routes through bio-link aggregators —
    // that is a real "you ARE the creator economy" stat.
    const organicDomainMap = new Map();
    for (const c of creatorMap.values()) {
      if (!c.url) continue;
      try {
        const u = new URL(c.url.startsWith('http') ? c.url : 'http://' + c.url);
        const host = u.hostname.replace(/^www\./, '');
        if (!host) continue;
        // Count weighted by creator's total views — a popular linktree
        // creator counts more than a 1-view tail creator.
        organicDomainMap.set(host, (organicDomainMap.get(host) || 0) + c.total);
      } catch (_) {}
    }
    const organic_domains = [...organicDomainMap.entries()]
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);

    // Organic creator clustering — reuses the same 14-bucket ruleset
    // as clusterAdImpressions (AI, Finance, Poker, Tennis, Health, etc.)
    // so the report can surface "AI creators on your feed: N organic
    // accounts AND M advertiser accounts" — same buckets, two sources.
    const organic_clusters = clusterAdImpressions([...creatorMap.values()]);

    // Disclaimer fingerprint final stat.
    const disclaimer_caption_share_pct = Math.round(disclaimerHits / capsBase * 1000) / 10;

    return {
      available: true,
      window_first, window_last, window_days,
      posts_count, videos_count, ads_count, total_content,
      ad_density_pct,
      top_creators,
      top_advertisers_7d,
      behavior_topics,
      top_hashtags,
      top_brand_mentions,
      hourly,
      daily,
      peak_day,
      peak_hour,
      daypart,
      linkInBioCreatorPct,
      linkInBioCreators,
      non_english_share_pct,
      // Depth fields (round 3):
      organic_domains,
      organic_clusters,
      disclaimer_caption_share_pct,
      disclaimer_caption_hits: disclaimerHits,
      unique_creators: creatorMap.size,
      unique_advertisers_7d: advertiserMap.size,
      captions_analyzed: allCaptions.length,
    };
  }

  // Plan Phase A.2: stories engagement footprint. Parses BOTH
  // story_interactions/stories_viewed.json AND story_likes.json.
  // Both files share the ads_viewed.json shape (label_values + Owner
  // dict with Name/Username/URL). Per-creator tally is the value:
  // these are the cleanest "users you actually pay attention to"
  // signals after ads_viewed. Tags creators with their bio URL so the
  // monetize page can match them to affiliate offers downstream.
  // Returns { available, stories_viewed: {...}, story_likes: {...} }
  // where each block has count/first_ts/last_ts/top_creators. Honest
  // empty state when neither file is present.
  function extractStoryInteractions(files) {
    function walk(path) {
      const d = loadJson(files, path);
      if (!d) return null;
      let entries = d;
      if (!Array.isArray(entries)) {
        entries = [];
        for (const k of ['story_activities_stories_viewed', 'story_activities_story_likes', 'story_interactions']) {
          if (Array.isArray(d[k])) { entries = d[k]; break; }
        }
      }
      if (!entries.length) return { count: 0, first_ts: 0, last_ts: 0, unique_creators: 0, top_creators: [], daily: [], window: null };
      const creatorMap = new Map();
      const dayCounts = new Map(); // local-date key -> view count (counts only)
      let first = Infinity, last = 0;
      for (const e of entries) {
        const ts = entryTimestamp(e);
        if (ts) {
          if (ts < first) first = ts;
          if (ts > last) last = ts;
          const dt = new Date(ts * 1000);
          const dk = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
          dayCounts.set(dk, (dayCounts.get(dk) || 0) + 1);
        }
        // Shared picker — see ownerFromLabelValue's Hashtags note for why this
        // must not simply take the first populated dict.
        const owner = ownerFromLabelValues(e.label_values);
        if (owner && owner.username) {
          if (!creatorMap.has(owner.username)) {
            creatorMap.set(owner.username, {
              username: owner.username,
              name: owner.name || '',
              url: owner.url || '',
              count: 0,
              firstSeen: ts || 0,
              lastSeen: ts || 0,
            });
          }
          const c = creatorMap.get(owner.username);
          c.count++;
          // !c.firstSeen guard: a 0 seed (first entry without a timestamp)
          // could otherwise never be replaced by a real timestamp.
          if (ts && (!c.firstSeen || ts < c.firstSeen)) c.firstSeen = ts;
          if (ts && ts > c.lastSeen) c.lastSeen = ts;
          if (!c.name && owner.name) c.name = owner.name;
          if (!c.url && owner.url) c.url = owner.url;
        }
      }
      const top_creators = [...creatorMap.values()].sort((a, b) => b.count - a.count);
      // Per-DAY view counts over the observed min..max span, zero-filling gap
      // days (real zeros). Counts only — no per-event timestamps or creator
      // identity leave the function. This drives the "Stories you watched"
      // strip, which carries its OWN window: story views span a different
      // number of days than the 7-day posts/videos/ads log, so the two are
      // never mixed in one chart (Option A, 2026-07-11). Local-time date keys
      // match extractAttentionMining's daily bucketing. A hard 400-day ceiling
      // guards against millisecond-unit timestamp drift blowing the array up
      // (Meta ships timestamp_ms in some files — a known drift risk).
      let daily = [], win = null;
      if (first !== Infinity && last >= first) {
        const start = new Date(first * 1000); start.setHours(0, 0, 0, 0);
        const end = new Date(last * 1000); end.setHours(0, 0, 0, 0);
        const out = [];
        let overflow = false;
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          if (out.length > 400) { overflow = true; break; }
          const dk = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
          out.push({ date: dk, count: dayCounts.get(dk) || 0 });
        }
        if (!overflow && out.length) {
          daily = out;
          win = { first_date: out[0].date, last_date: out[out.length - 1].date, day_count: out.length };
        }
      }
      return {
        count: entries.length,
        first_ts: first === Infinity ? 0 : first,
        last_ts: last,
        unique_creators: creatorMap.size,
        top_creators,
        daily,
        window: win,
      };
    }
    const viewed = walk('your_instagram_activity/story_interactions/stories_viewed.json');
    const likes  = walk('your_instagram_activity/story_interactions/story_likes.json');
    if (!viewed && !likes) return { available: false, stories_viewed: null, story_likes: null };
    return {
      available: !!(viewed || likes),
      stories_viewed: viewed || { count: 0, first_ts: 0, last_ts: 0, unique_creators: 0, top_creators: [], daily: [], window: null },
      story_likes:    likes  || { count: 0, first_ts: 0, last_ts: 0, unique_creators: 0, top_creators: [], daily: [], window: null },
    };
  }

  // Plan Phase A.1: Threads block. Walks all 7 files in
  // your_instagram_activity/threads/* and emits a unified social-graph +
  // consumption shape for the Threads tab. Threads views with a per-author
  // tally are among the cleanest single interest signals in the archive.
  // All Threads wrappers prefix `text_post_app_` so we walk
  // them tolerantly: each file has one root array under a known key.
  function _thWalkEntries(d, knownKeys) {
    if (!d) return [];
    if (Array.isArray(d)) return d;
    for (const k of knownKeys) if (Array.isArray(d[k])) return d[k];
    // Catch-all: first array property whose key starts with text_post_app_
    for (const k of Object.keys(d)) {
      if (k.indexOf('text_post_app_') === 0 && Array.isArray(d[k])) return d[k];
    }
    return [];
  }
  // Locale-agnostic string_map_data picks for the Threads files (2026-08-01
  // HTML-audit follow-up — the same M8 class fixed in the attention/story
  // extractors: non-English exports localize the Author/Time/URL/Search keys,
  // so English-keyed reads returned a real count beside zeroed authors and
  // terms, a wrong non-empty state). Structure rules: the field carrying
  // .href is the URL; the field carrying .timestamp is the time; the
  // remaining value-bearing field is the text (Author / Search term).
  function _thSmText(sm) {
    if (!sm) return '';
    for (const k of Object.keys(sm)) {
      const f = sm[k] || {};
      const v = typeof f.value === 'string' ? f.value.trim() : '';
      if (!v) continue;
      if (f.timestamp) continue;
      if (/^https?:\/\//i.test(v)) continue;
      return v;
    }
    return '';
  }
  function _thSmHref(sm) {
    if (!sm) return '';
    for (const k of Object.keys(sm)) {
      const f = sm[k] || {};
      if (f.href) return safeHttpUrl(f.href);
    }
    return '';
  }
  function _thReadProfile(d) {
    const arr = _thWalkEntries(d, ['text_post_app_text_post_app_profile']);
    if (!arr.length) return null;
    const sm = arr[0].string_map_data || {};
    const get = (k) => ((sm[k] || {}).value || '');
    const getTs = (k) => ((sm[k] || {}).timestamp || 0);
    return {
      username: get('Username'),
      name: get('Name'),
      bio: get('Bio'),
      email: get('Email'),
      phone: get('Phone Number'),
      private: parseMetaBool(get('Private Account')),
      onboarding_ts: getTs('Onboarding Time'),
      eligible_activation: parseMetaBool(get('Is Eligible for Profile Activation Badge')),
      shows_activation: parseMetaBool(get('Profile Shows Activation Badge')),
    };
  }
  function _thReadGraphFile(d, knownKey) {
    const arr = _thWalkEntries(d, [knownKey]);
    const entries = [];
    for (const e of arr) {
      const title = e.title || '';
      const sld = (e.string_list_data || [])[0] || {};
      const username = sld.value || title || '';
      if (!username) continue;
      entries.push({
        username,
        name: title && title !== username ? title : '',
        url: safeHttpUrl(sld.href),
        ts: sld.timestamp || 0,
      });
    }
    entries.sort((a, b) => b.ts - a.ts);
    return { total: entries.length, entries };
  }
  function extractThreads(files) {
    const empty = {
      available: false,
      profile: null,
      viewed: { count: 0, first_ts: 0, last_ts: 0, unique_authors: 0, top_authors: [] },
      following: { total: 0, entries: [] },
      followers: { total: 0, entries: [] },
      blocked: { total: 0, entries: [] },
      follow_requests: { total: 0, entries: [] },
      searches: { total: 0, entries: [], top_terms: [] },
    };
    const profile = _thReadProfile(loadJson(files, 'your_instagram_activity/threads/personal_information.json'));
    const following = _thReadGraphFile(loadJson(files, 'your_instagram_activity/threads/following.json'),
      'text_post_app_text_post_app_following');
    const followers = _thReadGraphFile(loadJson(files, 'your_instagram_activity/threads/followers.json'),
      'text_post_app_text_post_app_followers');
    const blocked = _thReadGraphFile(loadJson(files, 'your_instagram_activity/threads/blocked_profiles.json'),
      'text_post_app_text_post_app_blocked_profiles');
    const requests = _thReadGraphFile(loadJson(files, 'your_instagram_activity/threads/recent_follow_requests.json'),
      'text_post_app_text_post_app_recent_follow_requests');

    // threads_viewed: array of {string_map_data: {Author, Time, URL}}
    const viewedRaw = _thWalkEntries(
      loadJson(files, 'your_instagram_activity/threads/threads_viewed.json'),
      ['text_post_app_text_post_app_posts_seen', 'text_post_app_text_post_app_threads_viewed']
    );
    const authorMap = new Map();
    let vFirst = Infinity, vLast = 0;
    for (const e of viewedRaw) {
      const sm = e.string_map_data || {};
      // English keys first (fast path), structure-keyed locale fallback second
      // — see _thSmText/_thSmHref. entryTimestamp already walks every sm field
      // for a timestamp regardless of key name.
      const author = ((sm.Author || {}).value || '').trim() || _thSmText(sm);
      const ts = (sm.Time || {}).timestamp || entryTimestamp(e);
      const url = safeHttpUrl((sm.URL || {}).href) || _thSmHref(sm);
      if (ts) {
        if (ts < vFirst) vFirst = ts;
        if (ts > vLast) vLast = ts;
      }
      if (!author) continue;
      if (!authorMap.has(author)) authorMap.set(author, { username: author, count: 0, lastSeen: ts, sampleUrl: url });
      const a = authorMap.get(author);
      a.count++;
      if (ts > a.lastSeen) a.lastSeen = ts;
      if (!a.sampleUrl && url) a.sampleUrl = url;
    }
    const top_authors = [...authorMap.values()].sort((a, b) => b.count - a.count);
    const viewed = {
      count: viewedRaw.length,
      first_ts: vFirst === Infinity ? 0 : vFirst,
      last_ts: vLast,
      unique_authors: authorMap.size,
      top_authors,
    };

    // word_or_phrase_searches: array of {string_map_data: {Search, Time}}
    const searchRaw = _thWalkEntries(
      loadJson(files, 'your_instagram_activity/threads/word_or_phrase_searches.json'),
      ['text_post_app_keyword']
    );
    const searchEntries = [];
    const termMap = new Map();
    for (const e of searchRaw) {
      const sm = e.string_map_data || {};
      // Same locale fallback as the viewed loop above.
      const query = ((sm.Search || {}).value || '').trim() || _thSmText(sm);
      const ts = (sm.Time || {}).timestamp || entryTimestamp(e);
      if (!query) continue;
      searchEntries.push({ query, ts });
      const key = query.toLowerCase();
      termMap.set(key, (termMap.get(key) || 0) + 1);
    }
    searchEntries.sort((a, b) => b.ts - a.ts);
    const top_terms = [...termMap.entries()]
      .map(([term, count]) => ({ term, count }))
      .sort((a, b) => b.count - a.count);
    const searches = { total: searchEntries.length, entries: searchEntries, top_terms };

    const anyData = !!(profile || viewed.count || following.total || followers.total
                       || blocked.total || requests.total || searches.total);
    if (!anyData) return empty;
    return {
      available: true,
      profile,
      viewed,
      following,
      followers,
      blocked,
      follow_requests: requests,
      searches,
    };
  }

  // Plan Phase A.6: comments posted — engagement footprint companion to
  // story_interactions. Per-comment Media Owner + timestamp lets us tally
  // who the user engaged with via comments (separate from passive views).
  // Together with story likes + story views = a full picture of where the
  // user spent active attention. Single sharded file in JSON: post_comments_1.json.
  // Shape: array of {string_map_data: {Comment:{value}, "Media Owner":{value}, Time:{timestamp}}}.
  function extractCommentsPosted(files) {
    // Concat all post_comments_*.json shards (some exports split into _1, _2 …)
    const entries = [];
    for (const relPath of Object.keys(files)) {
      if (relPath.startsWith('_')) continue;
      if (!relPath.startsWith('your_instagram_activity/comments/post_comments_')) continue;
      if (!relPath.endsWith('.json')) continue;
      let d = files[relPath];
      // Wrapper-key tolerant (Meta ships both bare-array and {key: [...]}).
      if (d && !Array.isArray(d) && typeof d === 'object') d = Object.values(d).find(Array.isArray);
      if (!Array.isArray(d)) continue;
      for (const e of d) {
        const sm = e.string_map_data || {};
        const ts = (sm.Time || {}).timestamp || 0;
        const owner = ((sm['Media Owner'] || {}).value || '').trim();
        const comment = ((sm.Comment || {}).value || '').trim();
        if (!ts && !owner && !comment) continue;
        entries.push({ ts, owner, comment });
      }
    }
    if (!entries.length) return { available: false, total: 0, top_owners: [], entries: [] };

    let first = Infinity, last = 0;
    const ownerMap = new Map();
    for (const e of entries) {
      if (e.ts) {
        if (e.ts < first) first = e.ts;
        if (e.ts > last) last = e.ts;
      }
      if (e.owner) {
        if (!ownerMap.has(e.owner)) ownerMap.set(e.owner, { username: e.owner, count: 0 });
        ownerMap.get(e.owner).count++;
      }
    }
    const top_owners = [...ownerMap.values()].sort((a, b) => b.count - a.count);
    entries.sort((a, b) => b.ts - a.ts);
    return {
      available: true,
      total: entries.length,
      first_ts: first === Infinity ? 0 : first,
      last_ts: last,
      unique_owners: ownerMap.size,
      top_owners,
      // Cap recent sample for the UI — full impression log isn't needed,
      // the top-owners tally + window covers the analytical question.
      entries: entries.slice(0, 50),
    };
  }

  // Plan Phase A.3: social graph from connections/followers_and_following/*.
  // Following = the "who you actually care about" graph. Brand pages
  // followed feed offer matching per project_monetize_brand_match_scoring.
  // Also captures recently_unfollowed + recent_follow_requests (same area,
  // tiny extra cost). Followers list is included when present but flagged
  // capped_by_meta — Meta truncates that file; the real follower count
  // comes from audience_insights.json.
  //
  // Shapes vary per file:
  //   following.json            → { relationships_following: [{title: username, string_list_data: [{href, timestamp}]}] }
  //   followers_N.json          → array of {string_list_data: [{value, href, timestamp}]} (sharded)
  //   recently_unfollowed.json  → array of {timestamp, label_values: [{label, value}]}
  //   recent_follow_requests.json → single object OR array of same shape
  function extractSocialGraph(files) {
    const out = {
      available: false,
      following:              { entries: [], total: 0 },
      followers:              { entries: [], total: 0, capped_by_meta: true },
      recently_unfollowed:    { entries: [], total: 0 },
      recent_follow_requests: { entries: [], total: 0 },
      blocked:                { entries: [], total: 0 },
      // 2026-09-08: the follower arithmetic every "unfollower checker" sells,
      // computed only when the follower list is provably complete (see
      // computeFollowBack at the end of this extractor). `reason` names why it
      // was NOT computed so the card can say what to re-export instead of
      // printing a wrong list. Entries are scrubbed from saved reports like
      // every other identity list here (save-report.js, build-demo.js).
      not_following_back:     { entries: [], total: 0, verified: false, reason: 'not_computed' },
      fans:                   { entries: [], total: 0 },
      mutual_count:           0,
    };

    const fol = loadJson(files, 'connections/followers_and_following/following.json');
    if (fol) {
      const arr = (fol.relationships_following) || (Array.isArray(fol) ? fol : []);
      for (const e of arr) {
        const username = e.title || ((e.string_list_data || [])[0] || {}).value || '';
        const sld = (e.string_list_data || [])[0] || {};
        if (!username) continue;
        out.following.entries.push({ username, url: safeHttpUrl(sld.href), ts: sld.timestamp || 0 });
      }
      out.following.entries.sort((a, b) => b.ts - a.ts);
      out.following.total = out.following.entries.length;
      if (out.following.total > 0) out.available = true;
    }

    // Blocked accounts. Newer exports ship connections/followers_and_following/
    // blocked_profiles.json again (older ones dropped it — only the Threads block
    // list survived). Shape is unconfirmed across export versions, so parse
    // defensively: unwrap any {wrapper_key: [...]} object, and read the username
    // from title / string_list_data / label_values. Missing file → honest empty.
    const blk = loadJson(files, 'connections/followers_and_following/blocked_profiles.json');
    if (blk) {
      const barr = (blk && blk.relationships_blocked_users)
        || (Array.isArray(blk) ? blk : (blk && typeof blk === 'object' ? (Object.values(blk).find(Array.isArray) || []) : []));
      for (const e of (barr || [])) {
        const sld = (e.string_list_data || [])[0] || {};
        let username = e.title || sld.value || '';
        if (!username && Array.isArray(e.label_values)) {
          const uv = e.label_values.find((lv) => lv.label === 'Username');
          username = (uv && uv.value) || '';
        }
        if (!username) continue;
        out.blocked.entries.push({ username, url: safeHttpUrl(sld.href), ts: sld.timestamp || e.timestamp || 0 });
      }
      out.blocked.entries.sort((a, b) => b.ts - a.ts);
      out.blocked.total = out.blocked.entries.length;
      // Do NOT flip out.available on blocked-only data — blocked drives only the
      // blockedStillFollowed footnote (always 0 when following is empty), so a
      // blocked-only export would otherwise render a hollow "0 accounts" card.
    }

    const followerEntries = [];
    for (const relPath of Object.keys(files)) {
      if (relPath.startsWith('_')) continue;
      if (!relPath.startsWith('connections/followers_and_following/followers_')) continue;
      if (!relPath.endsWith('.json')) continue;
      let d = files[relPath];
      // Wrapper-key tolerant (Meta ships both bare-array and {key: [...]}).
      if (d && !Array.isArray(d) && typeof d === 'object') d = Object.values(d).find(Array.isArray);
      if (!Array.isArray(d)) continue;
      for (const e of d) {
        const sld = (e.string_list_data || [])[0] || {};
        const username = sld.value || '';
        if (!username) continue;
        followerEntries.push({ username, url: safeHttpUrl(sld.href), ts: sld.timestamp || 0 });
      }
    }
    if (followerEntries.length > 0) {
      followerEntries.sort((a, b) => b.ts - a.ts);
      out.followers.entries = followerEntries;
      out.followers.total = followerEntries.length;
      out.available = true;
    }

    function walkLabelValuesFile(path, target) {
      const d = loadJson(files, path);
      if (!d) return;
      const arr = Array.isArray(d) ? d : [d];
      for (const e of arr) {
        const ts = e.timestamp || 0;
        let username = '', name = '', url = '';
        for (const lv of (e.label_values || [])) {
          if (lv.label === 'Username') username = lv.value || '';
          else if (lv.label === 'Name') name = lv.value || '';
          else if (lv.label === 'URL') url = safeHttpUrl(lv.value);
        }
        if (username) target.entries.push({ username, name, url, ts });
      }
      target.entries.sort((a, b) => b.ts - a.ts);
      target.total = target.entries.length;
      if (target.total > 0) out.available = true;
    }
    walkLabelValuesFile('connections/followers_and_following/recently_unfollowed_profiles.json', out.recently_unfollowed);
    walkLabelValuesFile('connections/followers_and_following/recent_follow_requests.json', out.recent_follow_requests);

    // ── Who does not follow you back ──────────────────────────────────────
    // following minus followers: the arithmetic every unfollower checker
    // sells. It is only honest when the follower list is COMPLETE, and Meta's
    // export makes that conditional in two ways seen on real files:
    //   1. An export requested for a date range carries only the follows
    //      inside the range. One measured export carried 106 of 6,110.
    //   2. Even an all-history export can ship a follower file that holds only
    //      the last few weeks of new followers. One measured export had 3
    //      followers, all dated within 32 days of the request, against 990 in
    //      Insights, while following.json reached back to 2012.
    // So the download-request record alone cannot clear the list. Gate, in
    // order: both lists exist; the most recent request record, when present,
    // did not ask for a date range; when Insights carry a follower total the
    // list covers at least 90% of it (churn since the quarterly snapshot);
    // and without Insights, the list must reach further back than the last
    // 60 days whenever the follow list does (a complete list on an account
    // older than the window contains old followers; a brand-new account has
    // nothing old on either side and passes). Anything short of that stays an
    // honest empty state with the reason, never a wrong list (the project rule
    // 5). Deactivated accounts are a caveat, not a gate: following.json keeps
    // edges to accounts Meta has since disabled, nothing in the export says
    // which, so the card says so in words and links each name. Matching is
    // case-insensitive on the username.
    (function computeFollowBack() {
      const nfb = out.not_following_back;
      let reason = '';
      if (out.following.total === 0) reason = 'no_following_file';
      else if (out.followers.total === 0) reason = 'no_followers_file';
      if (!reason) {
        let req = null;
        try { req = extractDownloadRequest(files); } catch (e) { req = null; }
        if (req && req.has_export_request && req.requested_start_ts !== undefined
            && !req.requested_start_is_all_history) reason = 'range_partial';
      }
      let insightsTotal = 0;
      if (!reason) {
        let aud = null;
        try { aud = extractAudience(files); } catch (e) { aud = null; }
        insightsTotal = aud && aud.total_followers
          ? parseInt(String(aud.total_followers).replace(/[^\d]/g, ''), 10) || 0
          : 0;
        if (insightsTotal > 0 && out.followers.total < insightsTotal * 0.9) reason = 'followers_file_short';
      }
      if (!reason && insightsTotal === 0) {
        const WINDOW = 60 * 86400;
        const tsOf = (e) => Number(e && e.ts) || 0;
        const minTs = (arr) => arr.reduce((m, e) => (tsOf(e) > 0 && (m === 0 || tsOf(e) < m) ? tsOf(e) : m), 0);
        const maxTs = (arr) => arr.reduce((m, e) => (tsOf(e) > m ? tsOf(e) : m), 0);
        const newest = Math.max(maxTs(out.followers.entries), maxTs(out.following.entries));
        const oldestFollower = minTs(out.followers.entries);
        const oldestFollowing = minTs(out.following.entries);
        if (newest > 0 && oldestFollower > 0 && oldestFollowing > 0
            && newest - oldestFollower < WINDOW && newest - oldestFollowing >= WINDOW) {
          reason = 'followers_recent_only';
        }
      }
      if (reason) { nfb.reason = reason; return; }
      const lower = (u) => String(u || '').toLowerCase();
      const followerSet = new Set(out.followers.entries.map((e) => lower(e.username)));
      const followingSet = new Set(out.following.entries.map((e) => lower(e.username)));
      nfb.entries = out.following.entries.filter((e) => !followerSet.has(lower(e.username)));
      nfb.total = nfb.entries.length;
      nfb.verified = true;
      nfb.reason = '';
      out.fans.entries = out.followers.entries.filter((e) => !followingSet.has(lower(e.username)));
      out.fans.total = out.fans.entries.length;
      out.mutual_count = out.following.total - nfb.total;
    })();

    return out;
  }

  // R62: derive a human title from a URL path we already have, client-side,
  // with NO network fetch (fetching would broadcast click history off-device
  // and break the privacy promise). App Store / Play / link-in-bio get
  // special-cased to their app or profile slug; everything else titleizes the
  // last meaningful path segment, falling back to the bare host.
  function urlToTitle(url) {
    if (!url) return '';
    let u;
    try { u = new URL(url.startsWith('http') ? url : 'http://' + url); } catch (_) { return ''; }
    const host = u.hostname.replace(/^www\./, '');
    const segs = u.pathname.split('/').filter(Boolean);
    const titleize = (s) => decodeURIComponent(String(s || ''))
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[-_+]+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
    if (/(^|\.)apps\.apple\.com$/i.test(host)) {
      const ai = segs.indexOf('app');
      if (ai >= 0 && segs[ai + 1]) return titleize(segs[ai + 1]);
    }
    if (/(^|\.)play\.google\.com$/i.test(host)) {
      const id = u.searchParams.get('id') || u.searchParams.get('q');
      if (id) return titleize(String(id).split('.').pop());
    }
    if (/^(linktr\.ee|link\.me|beacons\.ai|lnk\.bio|taplink\.cc|linkin\.bio|sprout\.link|solo\.to|bio\.link|msha\.ke)$/i.test(host) && segs[0]) {
      return '@' + segs[0].replace(/^@/, '');
    }
    for (let i = segs.length - 1; i >= 0; i--) {
      if (/^(id\d+|\d+|index\.\w+|home|p|posts?|product|dp|gp)$/i.test(segs[i])) continue;
      const t = titleize(segs[i]);
      if (t && t.length >= 2) return t;
    }
    return host;
  }

  function extractLinkHistory(files) {
    // Every external link the user clicked from inside Instagram. Some URLs
    // carry paid-ad markers (fbclid, campaign_id, ad_id, adset_id); others
    // are organic taps. Each entry has start/end timestamps so we can
    // compute dwell time per click.
    const d = loadJson(files, 'logged_information/link_history/link_history.json');
    // Wrapper-key tolerant + locale-agnostic. These rules were inherited from
    // the since-deleted extractUniqueLinks (removed 2026-08-02; it parsed this
    // SAME file into a per-domain rollup that top_brands below already carries,
    // and nothing read it). This extractor is now the only reader of the file —
    // its sibling over the SAME file (2026-08-01 review, the one uncertain
    // finding). This extractor used to require a bare array and the English
    // labels, so a wrapper-shaped or non-English export yielded 0 taps (or N
    // blank rows) while the unique-links pass parsed the identical file fine.
    const items = !d ? [] : (Array.isArray(d) ? d : (Object.values(d).find(Array.isArray) || []));
    if (!items.length) {
      return { count: 0, entries: [], window_days: 0, top_brands: [], annualized: 0 };
    }
    const entries = [];
    let firstTs = Infinity, lastTs = 0;
    const brandCounts = {};
    for (const e of items) {
      const lv = {};
      for (const item of (e.label_values || [])) lv[item.label] = item.value;
      let url = safeHttpUrl(lv['Website link you visited']);
      let title = lv['Title of website page you visited'] || '';
      // Locale fallback — classify by value pattern: the http(s)-shaped value
      // is the link; any other free-text value that isn't a URL or a
      // date-looking string is the page title.
      if (!url && Array.isArray(e.label_values)) {
        for (const it of e.label_values) {
          if (typeof it.value === 'string' && /^https?:\/\//.test(it.value)) { url = safeHttpUrl(it.value); break; }
        }
      }
      if (!title && Array.isArray(e.label_values)) {
        for (const it of e.label_values) {
          if (typeof it.value === 'string' && it.value !== url
              && !/^https?:\/\//.test(it.value)
              && !/^[A-Za-zа-яА-Я]{2,4}\s+\d{1,2},?\s+\d{4}/.test(it.value)) { title = it.value; break; }
        }
      }
      // No resolvable URL = no usable signal. Skip rather than push a blank
      // row: count, top_brands, and the rendered list must all describe the
      // same set (the no-fake-data rule; same principle as the ads-viewed
      // timed-set fix).
      if (!url) continue;
      if (!title) title = urlToTitle(url);
      const ts = e.timestamp || 0;
      if (ts > 0) {
        if (ts < firstTs) firstTs = ts;
        if (ts > lastTs) lastTs = ts;
      }
      let brand = '';
      try { brand = new URL(url).hostname.replace(/^www\./, ''); } catch (_) {}
      if (brand) brandCounts[brand] = (brandCounts[brand] || 0) + 1;
      // Paid-ad markers ONLY. utm_* appears on organic creator/link-in-bio
      // taps and igshid is Instagram's organic share id — counting either
      // as "an advertiser paid for this click" inflated the click-revenue
      // math with organic activity.
      const isAd = /[?&](fbclid|campaign_id|ad_id|adset_id)/i.test(url);
      entries.push({
        url, title, ts, brand,
        session_start: lv['Website session start time'] || '',
        session_end: lv['Website session end time'] || '',
        is_ad_attributed: isAd,
      });
    }
    const windowDays = (firstTs !== Infinity && lastTs > firstTs)
      ? Math.max(1, Math.round((lastTs - firstTs) / 86400))
      : 0;
    // Exact fractional span, for the annualize guard below. windowDays floors
    // to 1, which is right for "N taps over D days" but wrong as a RATE
    // denominator: a burst of taps inside one afternoon would be extrapolated
    // as if it were a full day's browsing, every day, for a year (12 taps in
    // three hours read as "about 4,380 link taps per year"). extractFeedImpressions
    // was reworked for exactly this — "a sub-day burst is what they saw that
    // day, not a rate to extrapolate from" — and this extractor kept the old
    // behavior (2026-08-01 review).
    const windowDaysExact = (firstTs !== Infinity && lastTs > firstTs)
      ? (lastTs - firstTs) / 86400
      : 0;
    const canAnnualize = windowDaysExact >= 1;
    entries.sort((a, b) => b.ts - a.ts);
    const topBrands = Object.entries(brandCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([brand, count]) => ({ brand, count }));
    const adAttributedCount = entries.filter(e => e.is_ad_attributed).length;

    // Click-derived interest categories. 2026-06: build a category
    // list from what was ACTUALLY clicked — strongest intent signal in the
    // whole export. Each ad-attributed tap is bucketed by domain + title
    // keywords. Same bucket scheme as clusterAdImpressions where it
    // fits, plus consumer-facing buckets (shopping, art, music/events,
    // gifts) the ad-cluster rules don't cover.
    //
    // Same rule as clusterAdImpressions: brands only, never a person, and
    // never a brand whose whole inventory is a medical condition. Three
    // telehealth names came out of the health bucket on 2026-07-31 for that
    // reason, along with a handful of single-creator handles.
    const CLICK_INTEREST_RULES = [
      { key: 'ai_productivity', label: 'AI & productivity', re: /openai|chatgpt|perplexity|claude|anthropic|gemini|copilot|midjourney|notion|canva/i },
      { key: 'fashion',         label: 'Fashion & apparel',  re: /gucci|chanel|prada|adidas|\bnike\b|zara|uniqlo|asos|shein|shirt|\btees?\b|hoodie|sneakers|jeans/i },
      { key: 'art',             label: 'Art & prints',        re: /saatchi|society6|redbubble|etsy.*art|gallery|\bprints?\b/i },
      { key: 'wearables_tech',  label: 'Wearable tech',       re: /smart glasses|whoop|apple watch|garmin|oura|fitbit|samsung ?watch/i },
      { key: 'music_events',    label: 'Music & live events', re: /livenation|spotify|apple music|ticketmaster|concert|tour dates|festival/i },
      { key: 'fitness_apps',    label: 'Fitness apps',        re: /peloton|nike training|strava|myfitnesspal|fitness|workout|gym/i },
      { key: 'food_drink',      label: 'Food & drink',        re: /doordash|ubereats|grubhub|starbucks|cocktail|brewing|bourbon|whiskey|wine|coffee|\bbeer\b/i },
      { key: 'gifts',           label: 'Gifts & personalized', re: /personalized|mother.?s? day|father.?s? day|gift/i },
      { key: 'finance',         label: 'Personal finance',     re: /sofi|robinhood|coinbase|wealthfront|chase|fidelity|vanguard|nerdwallet|creditkarma|investing/i },
      { key: 'travel',          label: 'Travel & hotels',      re: /booking|expedia|airbnb|hotels|kayak|delta|united|four ?seasons|ritz|marriott|hilton/i },
      { key: 'health',          label: 'Health & wellness',    re: /peloton|noom|weightwatchers|headspace|calm\b|wellness/i },
      { key: 'activism_culture',label: 'Activism & culture',   re: /aclu|change\.org|petition|advocacy/i },
      { key: 'tools',           label: 'Help & tools',         re: /help\.|support\.|customer-service|how to/i },
    ];

    function categorizeUrl(entry) {
      const haystack = ((entry.brand || '') + ' ' + (entry.title || '') + ' ' + (entry.url || '')).toLowerCase();
      const hits = [];
      for (const r of CLICK_INTEREST_RULES) {
        if (r.re.test(haystack)) hits.push(r.key);
      }
      return hits;
    }

    const interestCounts = {};
    const interestLabel = {};
    const interestBrands = {};
    for (const r of CLICK_INTEREST_RULES) interestLabel[r.key] = r.label;
    for (const e of entries) {
      if (!e.is_ad_attributed) continue;  // only paid clicks count
      const cats = categorizeUrl(e);
      for (const c of cats) {
        interestCounts[c] = (interestCounts[c] || 0) + 1;
        if (!interestBrands[c]) interestBrands[c] = [];
        if (e.brand && interestBrands[c].indexOf(e.brand) < 0) interestBrands[c].push(e.brand);
      }
    }
    const clickInterests = Object.entries(interestCounts)
      .map(([key, count]) => ({ key, label: interestLabel[key] || key, count, brands: interestBrands[key] || [] }))
      .sort((a, b) => b.count - a.count);

    // Top ad-attributed brands ONLY (separate from the all-brands list).
    const adBrandCounts = {};
    for (const e of entries) {
      if (!e.is_ad_attributed || !e.brand) continue;
      adBrandCounts[e.brand] = (adBrandCounts[e.brand] || 0) + 1;
    }
    const top_ad_brands = Object.entries(adBrandCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([brand, count]) => ({ brand, count }));

    return {
      count: entries.length,
      ad_attributed_count: adAttributedCount,
      window_days: windowDays,
      window_first: firstTs === Infinity ? 0 : firstTs,
      window_last: lastTs,
      entries,
      top_brands: topBrands,
      top_ad_brands: top_ad_brands,
      click_interests: clickInterests,
      // 0 when the whole log fits inside a single day — an honest "we can't
      // annualize this" rather than a number built from one browsing session.
      annualized: canAnnualize ? Math.round(entries.length * 365 / windowDaysExact) : 0,
      annualized_ad_attributed: canAnnualize ? Math.round(adAttributedCount * 365 / windowDaysExact) : 0,
    };
  }

  function extractPrivacyCallouts(files) {
    const sc = loadJson(files, 'connections/contacts/synced_contacts.json');
    let synced = 0, phones = 0, emails = 0;
    if (sc) {
      for (const c of (sc.contacts_contact_info || [])) {
        synced++;
        const sm = c.string_map_data || {};
        // English key first, then first-value fallback (file has single contact-info field per entry)
        const ci = ((sm['Contact Information'] || {}).value) || smFirstValue(sm);
        if (ci.indexOf('@') >= 0) emails++;
        else if (/\d/.test(ci)) phones++;
      }
    } else {
      // HTML fallback — each contact is wrapped in a .pam.uiBoxWhite box
      const htmlDoc = loadHtmlDoc(files, 'connections/contacts/synced_contacts.html');
      if (htmlDoc) {
        // Find all the "Contact Information" value cells and bucket by pattern
        htmlDoc.querySelectorAll('td._a6_q, td[colspan="2"]').forEach(td => {
          const inner = td.querySelector('div > div');
          if (!inner) return;
          const v = (inner.textContent || '').trim();
          if (!v) return;
          // Each contact has a single "Contact Information" line containing the number/email
          const labelText = Array.from(td.childNodes)
            .filter(n => n.nodeType === 3)
            .map(n => n.nodeValue.trim()).join(' ').trim();
          if (/Contact Information|Contact info|Кон|télé|dato/i.test(labelText) || /^\d{6,}$/.test(v) || /@/.test(v)) {
            synced++;
            if (v.indexOf('@') >= 0) emails++;
            else if (/\d/.test(v)) phones++;
          }
        });
      }
    }
    const cf = loadJson(files, 'connections/followers_and_following/close_friends.json');
    let cf_count = 0;
    if (cf) {
      for (const e of (cf.relationships_close_friends || [])) {
        cf_count += (e.string_list_data || []).length;
      }
    } else {
      // HTML fallback — each close friend is one .pam.uiBoxWhite box with their handle
      const cfDoc = loadHtmlDoc(files, 'connections/followers_and_following/close_friends.html');
      if (cfDoc) {
        const boxes = cfDoc.querySelectorAll('main div.pam.uiBoxWhite');
        cf_count = boxes.length;
      }
    }
    return { synced_total: synced, synced_phones: phones, synced_emails: emails, close_friends: cf_count };
  }

  // Russian month abbreviation → numeric month (Meta's HTML export uses user locale)
  var RU_MONTH = {
    'янв': 1, 'фев': 2, 'мар': 3, 'апр': 4, 'май': 5, 'июн': 6,
    'июл': 7, 'авг': 8, 'сен': 9, 'окт': 10, 'ноя': 11, 'дек': 12,
  };
  // Other locale abbreviations Meta uses (partial — English pass-through via Date.parse)
  function parseMetaTimestamp(s) {
    if (!s) return 0;
    const t = Date.parse(s);
    if (!isNaN(t) && t > 946684800000) return Math.floor(t / 1000);
    // Russian: "июн 14, 2025 6:42 am"
    const m = String(s).trim().toLowerCase().match(/^([а-я]{3})\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(am|pm)?/);
    if (m) {
      const mo = RU_MONTH[m[1]];
      if (!mo) return 0;
      let hr = parseInt(m[4], 10);
      const min = parseInt(m[5], 10);
      if (m[6] === 'pm' && hr < 12) hr += 12;
      if (m[6] === 'am' && hr === 12) hr = 0;
      const d = new Date(Date.UTC(parseInt(m[3], 10), mo - 1, parseInt(m[2], 10), hr, min));
      return Math.floor(d.getTime() / 1000);
    }
    return 0;
  }

  function extractMessagesSummary(files) {
    const convos = (files._inboxConvoFolders || []).length;
    const mr = (files._messageRequestFolders || []).length;
    let inboxMsgs = 0, requestMsgs = 0, oldest = null, newest = null;
    // Plan Phase A.7: walk BOTH inbox/ AND message_requests/ subdirs.
    // Plan Phase B.10: also capture per-conversation participants + counts
    // so the report can show "you have a 4-person group chat with X, Y, Z."
    const sources = [
      { prefix: 'your_instagram_activity/messages/inbox/',           bucket: 'inbox' },
      { prefix: 'your_instagram_activity/messages/message_requests/', bucket: 'requests' },
    ];
    // Track per-conversation aggregates keyed by folder name. Maps
    // conversationId → { folder, bucket, participants[], msg_count, first_ts, last_ts }.
    const convoMap = new Map();
    // JSON path
    for (const src of sources) {
      for (const relPath of Object.keys(files)) {
        if (relPath.startsWith('_')) continue;
        if (!relPath.startsWith(src.prefix)) continue;
        const basename = relPath.split('/').pop();
        if (!basename.startsWith('message_') || !basename.endsWith('.json')) continue;
        const d = files[relPath];
        if (!d || !d.messages) continue;
        // Folder name = conversation id (e.g. "examplehandle_000000000000000")
        const rest = relPath.substring(src.prefix.length);
        const convoFolder = rest.split('/')[0] || '';
        if (!convoMap.has(convoFolder)) {
          convoMap.set(convoFolder, {
            folder: convoFolder,
            bucket: src.bucket,
            participants: (d.participants || []).map(p => p.name || '').filter(Boolean),
            msg_count: 0,
            first_ts: 0,
            last_ts: 0,
          });
        }
        const co = convoMap.get(convoFolder);
        // Merge participants if a later shard introduced new ones (rare)
        if (Array.isArray(d.participants)) {
          const known = new Set(co.participants);
          for (const p of d.participants) {
            const n = (p && p.name) || '';
            if (n && !known.has(n)) { co.participants.push(n); known.add(n); }
          }
        }
        for (const m of d.messages) {
          const ms = m.timestamp_ms;
          if (ms) {
            const s = ms / 1000;
            if (oldest === null || s < oldest) oldest = s;
            if (newest === null || s > newest) newest = s;
            if (!co.first_ts || s < co.first_ts) co.first_ts = s;
            if (s > co.last_ts) co.last_ts = s;
          }
          co.msg_count++;
          if (src.bucket === 'inbox') inboxMsgs++; else requestMsgs++;
        }
      }
    }
    // HTML fallback: each convo folder has message_*.html with one uiBoxWhite per message.
    if (inboxMsgs + requestMsgs === 0) {
      for (const src of sources) {
        for (const relPath of Object.keys(files)) {
          if (relPath.startsWith('_')) continue;
          if (!relPath.startsWith(src.prefix)) continue;
          const basename = relPath.split('/').pop();
          if (!basename.startsWith('message_') || !basename.endsWith('.html')) continue;
          const doc = loadHtmlDoc(files, relPath);
          if (!doc) continue;
          const boxes = doc.querySelectorAll('main > div.pam.uiBoxWhite');
          if (src.bucket === 'inbox') inboxMsgs += boxes.length; else requestMsgs += boxes.length;
          boxes.forEach(b => {
            const tsEl = b.querySelector('div._3-94._a6-o');
            if (!tsEl) return;
            const ts = parseMetaTimestamp((tsEl.textContent || '').trim());
            if (!ts) return;
            if (oldest === null || ts < oldest) oldest = ts;
            if (newest === null || ts > newest) newest = ts;
          });
        }
      }
    }
    // Plan Phase B.10: convert convoMap → sorted array. Cap at 200 to keep
    // localStorage payload bounded; group chats float to the top since they
    // carry more participant context. The full count stays in conversations
    // and total_messages.
    const convoList = [...convoMap.values()]
      .sort((a, b) => {
        const ag = a.participants.length > 2 ? 1 : 0;
        const bg = b.participants.length > 2 ? 1 : 0;
        if (ag !== bg) return bg - ag;
        return b.last_ts - a.last_ts;
      })
      .slice(0, 200);
    return {
      conversations: convos,
      total_messages: inboxMsgs + requestMsgs,
      inbox_messages: inboxMsgs,
      request_messages: requestMsgs,
      oldest_ts: oldest,
      newest_ts: newest,
      message_requests: mr,
      // Phase B.10 — per-conversation participant + count detail. Top 200.
      conversation_list: convoList,
      group_chat_count: convoList.filter(c => c.participants.length > 2).length,
    };
  }

  // ===========================================================================
  // Value calculators
  // ===========================================================================
  function estimateExtractedAnnual(data) {
    // What Meta ACTUALLY makes from you, annually = ad revenue on impressions.
    //
    // The IG export gives us DIRECT impression counts (posts_viewed.json +
    // videos_watched.json), so we count those directly and apply the ~1/3
    // sponsored-slot ratio rather than inferring from engagement signals.
    // Old formula was likes × 3 which conflated post-likes (organic
    // engagement) with ad consumption — wrong, because liking a friend's
    // post doesn't tell you how many ads you saw.
    //
    // Things we deliberately DO NOT count as Meta revenue:
    //   · Custom-audience uploads — Meta does NOT charge advertisers per slot;
    //     custom audiences are a free feature. Advertisers then pay CPM on the
    //     ad delivery, which IS captured in the ad_revenue line.
    //   · Off-Instagram purchase events — that money went to the merchant
    //     directly, not to Meta.
    //   · Attribution/Pixel conversions — free feature for advertisers.
    const fi = data.feed_impressions || {};
    const cpmTier = data.cpm_tier || {};
    const cpm = cpmTier.cpm || ACTIVE_PLATFORM.cpm;
    const ad_impressions = fi.ad_impressions || 0;
    const ad_revenue = ad_impressions * cpm / 1000;
    // Daily breakdown from the actual feed-impression window.
    // RATES use the exact fractional window — the same denominator that
    // produced annual_impressions — so per-day x 365 reconciles with the
    // per-year row on screen. The rounded integer stays for labels only.
    const wdExact = fi.ad_window_days_exact || fi.feed_window_days || 0;
    const period_ads = fi.period_ad_impressions || 0;
    const daily_ads = wdExact > 0 ? period_ads / wdExact : 0;
    const daily_revenue = daily_ads * cpm / 1000;
    // WHAT THIS EMITS, and what it deliberately does not (trimmed 2026-09-07).
    //
    // This used to return twenty-two fields. Five were read; the other
    // seventeen were mirrors of numbers that are already in this same output
    // under feed_impressions or advertisers, monthly figures that are the
    // daily ones times thirty, ad_revenue (a second name for total), and
    // likes_per_year, a hard zero kept for a "legacy render branch and the
    // analyst context builder" that do not read it -- the server-side
    // explain.js never touches this object. Seventeen unread fields beside
    // a handful of load-bearing ones is how a later reader ends up preserving
    // the wrong ones.
    //
    // WHO READS WHAT. Rechecked 2026-09-08, and it had already moved: the
    // 2026-09-07 version of this block said the ledger builder read four of these
    // five. It merged the same day as the ledger's flat-rate removal, which
    // deleted those reads, so the map was stale within hours of being written.
    // The point of this block is to stop a later reader preserving the wrong
    // fields, so a wrong map here is worse than no map.
    //
    //   total              -> report/instagram/v2/v2-data-adapter.js (fallback
    //                         when math.cpmRevenueUsd is absent) and
    //                         the ledger's own integration tests.
    //                         LIVE.
    //   annual_impressions -> read by the ledger builder. LIVE.
    //   daily_ads          -> read by the ledger builder. LIVE.
    //   daily_revenue      -> NO live reader. Kept so the dollars this function
    //                         emits stay checkable by hand against daily_ads
    //                         and ad_cpm.
    //   ad_cpm             -> NO live reader. Kept for the same reason: it is
    //                         the only rate that makes `total` recomputable.
    //                         READ THIS BEFORE REUSING IT -- it is report.js's
    //                         flat market tier, the basis the ledger BANNED on
    //                         2026-09-01. The ledger builder now names it only in
    //                         comments explaining that it refuses to price at
    //                         it. Nothing downstream should start pricing here.
    //   platform           -> no reader, and it stays anyway: it is the only
    //                         thing in this object that says which engine
    //                         produced the numbers, and report.js ships as a
    //                         public parser.
    //
    // So two of the six emitted fields have no consumer today and are kept
    // deliberately, for auditability rather than for a caller. Dropping them is
    // a further breaking change to the published parser output and is the owner's
    // call, not a tidy-up.
    //
    // Nothing is lost. Every removed field is still derivable from what the
    // report emits: the counts and windows from data.feed_impressions, the
    // advertiser count from data.advertisers.total_unique, the monthlies from
    // the dailies, ad_revenue from total.
    return {
      platform: ACTIVE_PLATFORM.name,
      annual_impressions: ad_impressions,
      daily_ads,
      daily_revenue,
      ad_cpm: cpm,
      total: ad_revenue,
    };
  }


  // ===========================================================================
  // Orchestrator
  // ===========================================================================
  function extractAll(files) {
    // Per-extractor isolation: one extractor hitting unexpected Meta schema
    // drift must degrade ITS section to an honest empty state, not kill the
    // entire report ("Something went wrong" with zero output). On failure we
    // re-run the extractor against an empty archive so it returns its own
    // canonical empty shape — consumers see exactly what a missing file
    // produces. Failures are recorded in data._extract_errors for telemetry.
    const _errors = {};
    const safe = (label, fn) => {
      try { return fn(files); } catch (e) {
        _errors[label] = String((e && e.message) || e);
        try { console.warn('[Opt2In] extractor "' + label + '" failed — section degrades to empty:', e); } catch (_) {}
        try { return fn({}); } catch (e2) { return null; }
      }
    };
    const data = {
      window: safe('window', extractWindow) || {},
      identity: Object.assign(
        safe('identity', extractIdentity) || {},
        safe('instagram_profile_information', extractInstagramProfileInfo),
        safe('autofill', extractAutofillFull)
      ),
      export_request: safe('export_request', extractDownloadRequest),
      checkout_profile: safe('checkout_profile', extractCheckoutProfile),
      cart_items: safe('cart_items', extractCartItems),
      device_summary: safe('device_summary', extractDeviceSummary),
      device_fingerprint: safe('device_fingerprint', extractDeviceFingerprint),
      location: safe('location', extractLocation),
      audience: safe('audience', extractAudience),
      content_interactions: safe('content_interactions', extractContentInteractions),
      profiles_reached: safe('profiles_reached', extractProfilesReached),
      ai_interests: safe('ai_interests', extractAIInterests),
      topics: safe('topics', extractTopics),
      ad_prefs: safe('ad_prefs', extractAdPreferences),
      other_categories: safe('other_categories', extractOtherCategories),
      ads_about_meta: safe('ads_about_meta', extractAdsAboutMeta),
      advertisers: safe('advertisers', extractAdvertisers),
      off_meta: safe('off_meta', extractOffMeta),
      link_history: safe('link_history', extractLinkHistory),
      shopping: safe('shopping', extractShopping),
      subscription_status: safe('subscription_status', extractSubscriptionStatus),
      likes_summary: safe('likes_summary', extractLikesSummary),
      feed_impressions: safe('feed_impressions', extractFeedImpressions),
      ad_impressions_detail: safe('ad_impressions_detail', extractAdImpressionsDetail),
      clicked_ads: safe('clicked_ads', extractClickedAds),
      attention_mining: safe('attention_mining', extractAttentionMining),
      story_interactions: safe('story_interactions', extractStoryInteractions),
      comments_posted: safe('comments_posted', extractCommentsPosted),
      social_graph: safe('social_graph', extractSocialGraph),
      threads: safe('threads', extractThreads),
      muted_creators: safe('muted_creators', extractMutedCreators),
      see_less_topics: safe('see_less_topics', extractSeeLessTopics),
      cpm_tier: safe('cpm_tier', detectCpmTier),
      privacy_callouts: safe('privacy_callouts', extractPrivacyCallouts),
      messages_summary: safe('messages_summary', extractMessagesSummary),
    };
    data.extracted = safe('extracted', () => estimateExtractedAnnual(data)) || { total: 0 };
    data._extract_errors = _errors;
    // Pass archive format + active platform through so render() knows when to
    // blur-gate sections and so the outer HTML page can persist platform tagging
    // into localStorage for the monetize flow.
    data._format = files._format || 'json';
    data._platform = {
      id: ACTIVE_PLATFORM.id,
      name: ACTIVE_PLATFORM.name,
      parent: ACTIVE_PLATFORM.parent,
    };
    return data;
  }

  // ===========================================================================
  // Public API
  // ===========================================================================
  const opt2InAudit = {
    loadZipFiles,
    extractAll,
    parseExportDate,
    // Exposed for the adapter's not-following-back tests, which feed
    // hand-built export files through the REAL extractor (fixture-free, so it
    // can gate the build). Browser-harmless extra method.
    extractSocialGraph,
    // Exposed so the parser test harness can reuse the REAL mojibake fix
    // instead of mirroring it (no drift). Browser-harmless extra methods.
    fixMetaMojibakeString,
    fixMetaMojibakeDeep,
  };
  if (typeof window !== 'undefined') window.Opt2InAudit = opt2InAudit;
  if (typeof module !== 'undefined' && module.exports) module.exports = opt2InAudit;
})();
