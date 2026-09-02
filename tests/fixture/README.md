# Synthetic fixture

`export/` is a made-up Instagram export, laid out the way Meta's JSON export
is laid out, so the test suite can run the real parser with no real export at
all. Nothing in it comes from a person:

- every account is `example_user`, `example_creator`, `sample_photographer`,
  `demo_kitchen` and the like; every advertiser is Example Corp, Sample Brand
  Co, Acme Outlet or Widget Warehouse;
- every email is under `example.com`, every phone number is in the reserved
  555-01xx range, every URL points at `example.com`, `instagram.com` or
  `facebook.com`;
- every timestamp falls in January 2025 (`tests/fixture.test.js` enforces
  this, along with the email and URL rules, so the fixture cannot quietly
  pick up real data).

The top-level keys of every fixture file that also appears in
`tests/meta-schema-snapshot.json` are asserted equal to the snapshot's keys,
so the fixture cannot drift from the shapes Meta actually ships.

It covers 25 files across the export's main folders. It does not cover every
file the parser reads (`threads/`, `audience_insights.json`, the shopping
files, `ads_clicked.json`, the off-Instagram activity file). Extractors whose
inputs are absent return their empty shapes, which the suite also checks. To
run the suite against a complete export, set `IG_EXPORT_PATH`.
