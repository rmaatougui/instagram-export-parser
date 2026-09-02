// tests/_lib/load-export.js
// Walks an UNZIPPED Instagram export on disk and returns the same `files`
// dict that report.js's loadZipFiles() builds from a ZIP in the browser, so
// the tests can run the real extractors against a directory.
//
// Where the export comes from:
//   IG_EXPORT_PATH  absolute path to an unzipped export root (the folder that
//                   contains your_instagram_activity/, ads_information/, ...).
//                   Set it to run the suite against your own export.
//   (unset)         the synthetic fixture in tests/fixture/export: obviously
//                   fake data, so the suite runs with no real export at all.
//
// There is deliberately no other default. A real export is someone's private
// data, and its location on their disk is not something a test file records.
'use strict';
const fs = require('fs');
const path = require('path');
const { fixMetaMojibakeDeep } = require('./parser');

const FIXTURE_ROOT = path.join(__dirname, '..', 'fixture', 'export');
const INBOX_PREFIX = 'your_instagram_activity/messages/inbox/';
const REQUESTS_PREFIX = 'your_instagram_activity/messages/message_requests/';

function usingFixture() {
  return !process.env.IG_EXPORT_PATH;
}

function resolveExportRoot() {
  const fromEnv = process.env.IG_EXPORT_PATH;
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) {
      throw new Error('IG_EXPORT_PATH is set but does not exist: ' + fromEnv);
    }
    return fromEnv;
  }
  return FIXTURE_ROOT;
}

// Mirrors loadZipFiles: every .json file parsed and mojibake-fixed, keyed by
// its path relative to the export root with '/' separators; every .html file
// stored as an { _html } stub; the inbox and message_requests conversation
// folders listed; the same _format / _hasJson / _hasHtml markers.
function walkExport(root) {
  const files = {
    _rootPrefix: '',
    _platformId: 'instagram',
    _platformName: 'Instagram',
    _platformParent: 'Meta',
    _hasJson: false,
    _hasHtml: false,
    _format: 'json',
    _zipFilename: '',
  };
  const inbox = new Set();
  const requests = new Set();

  function convoFolder(relPath, prefix, set) {
    if (!relPath.startsWith(prefix)) return;
    const rest = relPath.substring(prefix.length);
    const slash = rest.indexOf('/');
    if (slash > 0) set.add(rest.substring(0, slash));
  }

  function recurse(dir, relBase) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = relBase ? relBase + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { recurse(full, rel); continue; }
      if (!entry.isFile()) continue;
      if (entry.name.endsWith('.json')) {
        try {
          files[rel] = fixMetaMojibakeDeep(JSON.parse(fs.readFileSync(full, 'utf8')));
          files._hasJson = true;
        } catch (e) { /* malformed: skipped, exactly as loadZipFiles skips it */ }
      } else if (entry.name.endsWith('.html')) {
        try {
          files[rel] = { _html: fs.readFileSync(full, 'utf8') };
          files._hasHtml = true;
        } catch (e) { /* unreadable: skipped */ }
      } else {
        continue;
      }
      convoFolder(rel, INBOX_PREFIX, inbox);
      convoFolder(rel, REQUESTS_PREFIX, requests);
    }
  }

  recurse(root, '');
  files._inboxConvoFolders = Array.from(inbox);
  files._messageRequestFolders = Array.from(requests);
  files._format = files._hasJson ? (files._hasHtml ? 'mixed' : 'json') : (files._hasHtml ? 'html' : 'json');
  return files;
}

let cached = null;
function loadExport() {
  if (!cached) cached = walkExport(resolveExportRoot());
  return cached;
}

module.exports = { FIXTURE_ROOT, usingFixture, resolveExportRoot, walkExport, loadExport };
