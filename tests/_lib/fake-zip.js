// tests/_lib/fake-zip.js
// A duck-typed stand-in for a JSZip instance. loadZipFiles touches exactly
// two things on the object it is handed: `zip.files` (a map from entry name
// to entry) and, per entry, `entry.dir` and `entry.async('string')`. Any
// object of that shape works, which is what lets the ZIP-walking and
// anchor-detection code run under Node with no zip library at all.
'use strict';
const fs = require('fs');
const path = require('path');

// entries: { 'path/in/zip.json': string | object | { dir: true } }
// A string is served verbatim (so malformed JSON and HTML can be tested);
// an object is serialised; { dir: true } is a directory entry.
function fakeZip(entries) {
  const files = {};
  for (const name of Object.keys(entries)) {
    const v = entries[name];
    if (v && typeof v === 'object' && v.dir === true) {
      files[name] = { name, dir: true, async: async () => '' };
      continue;
    }
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    files[name] = {
      name,
      dir: false,
      async: async (type) => {
        if (type !== 'string') throw new Error('fake zip only serves strings, got ' + type);
        return text;
      },
    };
  }
  return { files };
}

// A fake zip built from a directory on disk (the fixture), optionally wrapped
// in a root folder the way Meta's own archives are ("instagram-<user>-<date>-<id>/").
function fakeZipFromDir(root, rootPrefix) {
  const entries = {};
  const prefix = rootPrefix || '';
  if (prefix) entries[prefix] = { dir: true };
  (function recurse(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { entries[prefix + r + '/'] = { dir: true }; recurse(full, r); }
      else entries[prefix + r] = fs.readFileSync(full, 'utf8');
    }
  })(root, '');
  return fakeZip(entries);
}

// loadZipFiles prints two informational lines per archive. Keep the test
// output readable without touching the file under test.
async function quiet(fn) {
  const log = console.log, warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { return await fn(); } finally { console.log = log; console.warn = warn; }
}

module.exports = { fakeZip, fakeZipFromDir, quiet };
