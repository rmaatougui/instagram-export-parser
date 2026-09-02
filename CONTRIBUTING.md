# Contributing

This repository exists so that a claim about your data can be checked. It is
maintained for that purpose, and the rules below follow from it.

## Bug reports and questions: yes

If the parser misreads your export, refuses a real Instagram archive, or a
section of the report comes back empty when the file plainly has data, open an
issue. Say which export format you chose (JSON or HTML), which folder or file
the problem is in, and what the parser returned. Do not attach your export or
paste its contents; describe the shape (the file path and its top-level keys
is usually enough, and `npm run schema-check` prints exactly that).

Findings about the network-call claim, the mojibake handling, or the refusal
rules are especially welcome.

## Pull requests to `report.js`: read as reports, not merged

External changes to `report.js` are not merged into this repository, and the
reason is not pride of ownership. The same file ships inside Opt2In's iOS app
and website under OPT2IN LLC's own terms. The AGPL binds people who receive
the code from us; it does not bind us on code we wrote. That only stays true
while every line in the file is ours. A merged outside contribution would be
code we hold only under the AGPL, which cannot ship inside the app binary.

So a pull request that modifies `report.js` will be read carefully, answered,
and used as a bug report. If it is right, the fix is written independently
into the file the site serves, the public copy is refreshed from it, and the
issue credits the reporter. Your patch is not needed for that; the diagnosis
is.

Pull requests to the tests, the fixture, the schema script, or this
documentation are welcome and are merged on their merits.

## What refreshes this repository

The public `report.js` is copied from the served file, never edited here. A
diff between this repository and `https://opt2in.com/report/instagram/report.js`
means the repository is behind; the served file is authoritative and is
readable in full in your browser. The README's "Verify it yourself" section
gives the exact commands.
