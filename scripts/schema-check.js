#!/usr/bin/env node
// scripts/schema-check.js: the Meta schema canary.
//
// What it checks. The folder tree of an export and the TOP-LEVEL KEYS of every
// JSON file in it, compared with tests/meta-schema-snapshot.json. Never a
// value: the snapshot holds key names and the token "<array>", nothing else.
// This is the drift that silently empties a section of the report. When Meta
// renames a file or a top-level key, the extractor that read it returns its
// empty shape and nothing throws; this script is how that gets noticed.
//
// The messages tree (your_instagram_activity/messages/) is excluded: its
// subfolders are named per conversation, so they differ in every export and
// would read as constant drift.
//
// Modes.
//   IG_EXPORT_PATH set     full diff of that export against the snapshot.
//                          Exit 0 = no drift, exit 1 = drift, printed.
//   IG_EXPORT_PATH unset   fixture mode: every file in tests/fixture/export
//                          that the snapshot knows must carry exactly the
//                          snapshot's keys (exit 1 on a mismatch). Files the
//                          fixture does not contain are listed as uncovered;
//                          that is not drift.
//   --update               rewrite the snapshot from IG_EXPORT_PATH. Refused in
//                          fixture mode: the fixture is a synthetic subset and
//                          must never replace the recorded shape of a real
//                          export.
'use strict';
const fs = require('fs');
const path = require('path');
const { resolveExportRoot, usingFixture, walkExport } = require('../tests/_lib/load-export');

const SNAPSHOT_PATH = path.join(__dirname, '..', 'tests', 'meta-schema-snapshot.json');
const SKIP_RE = /^your_instagram_activity\/messages\//i;

function topLevelKeysOf(obj) {
  if (Array.isArray(obj)) return ['<array>'];
  if (obj && typeof obj === 'object') return Object.keys(obj).sort();
  return ['<' + typeof obj + '>'];
}

function buildShape(files) {
  const shape = { files: {}, folders: [] };
  const folders = new Set();
  for (const p of Object.keys(files).sort()) {
    if (p.startsWith('_') || SKIP_RE.test(p)) continue;
    const dir = p.includes('/') ? p.substring(0, p.lastIndexOf('/')) : '';
    if (dir) folders.add(dir);
    if (!p.endsWith('.json')) continue;
    shape.files[p] = { keys: topLevelKeysOf(files[p]) };
  }
  shape.folders = Array.from(folders).sort();
  return shape;
}

function diff(prev, next) {
  const out = { newFiles: [], removedFiles: [], changedFiles: [], newFolders: [], removedFolders: [] };
  const prevFiles = new Set(Object.keys(prev.files || {}));
  const nextFiles = new Set(Object.keys(next.files || {}));
  for (const f of nextFiles) if (!prevFiles.has(f)) out.newFiles.push(f);
  for (const f of prevFiles) if (!nextFiles.has(f)) out.removedFiles.push(f);
  for (const f of nextFiles) {
    if (!prevFiles.has(f)) continue;
    const a = prev.files[f].keys || [], b = next.files[f].keys || [];
    const addedKeys = b.filter((k) => !a.includes(k)), removedKeys = a.filter((k) => !b.includes(k));
    if (addedKeys.length || removedKeys.length) out.changedFiles.push({ file: f, addedKeys, removedKeys });
  }
  const prevFolders = new Set(prev.folders || []), nextFolders = new Set(next.folders || []);
  for (const f of nextFolders) if (!prevFolders.has(f)) out.newFolders.push(f);
  for (const f of prevFolders) if (!nextFolders.has(f)) out.removedFolders.push(f);
  return out;
}

function totalChangeCount(d) {
  return d.newFiles.length + d.removedFiles.length + d.changedFiles.length + d.newFolders.length + d.removedFolders.length;
}

function formatDrift(d, current) {
  const lines = [];
  const section = (title, items, fmt) => {
    if (!items.length) return;
    lines.push(title + ' (' + items.length + ')');
    for (const it of items) lines.push(...fmt(it));
    lines.push('');
  };
  section('NEW FOLDERS', d.newFolders, (f) => ['  + ' + f]);
  section('REMOVED FOLDERS', d.removedFolders, (f) => ['  - ' + f]);
  section('NEW FILES', d.newFiles, (f) => {
    const keys = (current.files[f] && current.files[f].keys) || [];
    return ['  + ' + f, '      top-level keys: ' + keys.slice(0, 6).join(', ') + (keys.length > 6 ? ' ...' : '')];
  });
  section('REMOVED FILES', d.removedFiles, (f) => ['  - ' + f]);
  section('CHANGED FILES (key drift)', d.changedFiles, (c) => {
    const l = ['  ~ ' + c.file];
    if (c.addedKeys.length) l.push('      + keys: ' + c.addedKeys.join(', '));
    if (c.removedKeys.length) l.push('      - keys: ' + c.removedKeys.join(', '));
    return l;
  });
  return lines.join('\n').replace(/\n+$/, '');
}

function loadSnapshot() {
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
}

module.exports = { SNAPSHOT_PATH, topLevelKeysOf, buildShape, diff, totalChangeCount, formatDrift, loadSnapshot };

if (require.main === module) {
  const UPDATE = process.argv.slice(2).includes('--update');
  const root = resolveExportRoot();
  const current = buildShape(walkExport(root));
  const prev = loadSnapshot();

  if (usingFixture()) {
    if (UPDATE) {
      console.error('Refusing --update in fixture mode: the fixture is a synthetic subset of a real export.');
      console.error('Set IG_EXPORT_PATH to an unzipped export to rewrite the snapshot.');
      process.exit(2);
    }
    console.log('Fixture mode (IG_EXPORT_PATH unset): checking ' + root);
    let mismatches = 0, covered = 0;
    const uncovered = [];
    for (const f of Object.keys(prev.files)) {
      if (!current.files[f]) { uncovered.push(f); continue; }
      covered++;
      const a = prev.files[f].keys.join(','), b = current.files[f].keys.join(',');
      if (a !== b) { mismatches++; console.log('  MISMATCH ' + f + '\n    snapshot: ' + a + '\n    fixture:  ' + b); }
    }
    for (const f of Object.keys(current.files)) {
      if (!prev.files[f]) console.log('  (fixture file not in snapshot, not checked: ' + f + ')');
    }
    console.log(covered + ' snapshot files covered by the fixture, ' + uncovered.length + ' not covered, ' + mismatches + ' mismatch' + (mismatches === 1 ? '' : 'es'));
    if (uncovered.length) console.log('Not covered: ' + uncovered.join(', '));
    process.exit(mismatches ? 1 : 0);
  }

  console.log('Scanning export at ' + root);
  console.log('Found ' + Object.keys(current.files).length + ' JSON files across ' + current.folders.length + ' folders');
  if (UPDATE) {
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + '\n');
    console.log('Wrote snapshot to ' + SNAPSHOT_PATH);
    process.exit(0);
  }
  const d = diff(prev, current);
  const total = totalChangeCount(d);
  console.log('');
  if (total === 0) {
    console.log('No schema drift detected: ' + Object.keys(prev.files).length + ' files, ' + prev.folders.length + ' folders unchanged');
    process.exit(0);
  }
  console.log('Schema drift detected: ' + total + ' change' + (total === 1 ? '' : 's'));
  console.log('');
  console.log(formatDrift(d, current));
  console.log('');
  console.log('If these changes are what Meta now ships, run with --update to accept the new baseline.');
  process.exit(1);
}
