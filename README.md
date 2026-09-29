Powers **[editsqlite.com](https://editsqlite.com/)**: open, edit and re-export SQLite databases, SQL dumps and CSV files in the browser, nothing uploaded.

# editsqlite

**Open, edit and re-export a database — entirely in your browser.** Open a SQLite
file, a `.sql` dump (MySQL / Postgres / SQLite) or a CSV, edit the data in a
spreadsheet grid or with SQL, then download a fresh file. Read once, never
written to, never uploaded.

Live: **[editsqlite.com](https://editsqlite.com)**

editsqlite is a static site with no server behind it. Your database is read into a
working copy in the tab; every edit happens on that copy; and each export is a
brand-new file built from scratch by our own SQLite writer. Turn off your
network and it still works.

## Why it exists

Databases hold some of the most sensitive files people own — customers, messages,
finances. Every other "edit SQLite online" tool either uploads your file to a
server or is read-only. editsqlite does neither: it truly edits, and nothing ever
leaves your device.

## What it does

- **Opens the files you have** — `.sqlite` / `.db`, `.sql` dumps from mysqldump /
  pg_dump / sqlite3 (including Postgres `COPY` blocks), and plain CSV. Or start
  from a blank database.
- **Edit like a spreadsheet** — double-click a cell, add/delete rows and columns,
  rename tables, undo/redo. A schema panel shows every table's columns, types and
  live row counts.
- **Or edit with SQL** — a hand-written console runs `SELECT` / `UPDATE` /
  `DELETE` / `INSERT` instantly, offline. For heavier reads (joins, `GROUP BY`,
  aggregates, subqueries) it summons the real SQLite engine (sql.js), fetched
  lazily on first use and used **only to read**.
- **Plain-English → SQL** — a small built-in helper turns everyday questions
  ("count by role", "top 5 by salary", "rows in London") into SQL. No model, no
  API key, no download, no network — it runs locally and even reads your data to
  resolve values. It proposes the query; you review and run it.
- **Export a fresh, valid file** — a clean `.sqlite` our writer builds byte by
  byte (it passes the official engine's `PRAGMA integrity_check`), a `.sql` dump
  in three dialects, or CSV.
- **Convert between formats** — see [`/convert`](convert/): CSV→SQLite,
  MySQL→SQLite, Postgres→SQLite, SQLite→CSV, SQLite→SQL dump.

## How it works — small pieces, each written by hand

No framework, no build step. Just static files and a handful of hand-rolled
modules so the mechanism stays visible:

| File | Role |
|---|---|
| [`sqlite.js`](sqlite.js) | The **reader** — the SQLite file format parsed by hand: 100-byte header, b-tree pages, varints, the record serial-type zoo, overflow chains. |
| [`sqlwrite.js`](sqlwrite.js) | The **writer** — records encoded, pages packed, trees stacked, header stamped. Output the official engine's integrity check signs off on. |
| [`dumpparse.js`](dumpparse.js) | The **dump parser** — `CREATE TABLE` / `INSERT` / Postgres `COPY`, with each dialect's escapes. |
| [`sqlmini.js`](sqlmini.js) | The **console engine** — a compact hand-written SQL interpreter (four verbs, an honest `WHERE`). |
| [`analysisdb.js`](analysisdb.js) | The **analysis engine** — lazily loads sql.js for read-only joins/grouping/subqueries; caches an ephemeral DB built by the certified writer. |
| [`smartquery.js`](smartquery.js) | **Plain-English → SQL** — a small local slot-filling parser (no model, no key, no network) for the common questions: count/sum/avg by X, top N, filters, distinct. |
| [`csvwiz.js`](csvwiz.js) | The **CSV intake bench** — RFC-4180 parsing + per-column type inference. |
| [`app.js`](app.js) | The editor core — intake, in-memory model, grid, undo/redo, console router, exports, autosave. |

## Use the reader and writer from Node

`sqlite.js` and `sqlwrite.js` have no dependencies and run unchanged in Node. This reads a
database, prints its tables, and writes a fresh copy of every table:

```js
var fs = require("fs");
var SQLITE = require("./sqlite.js");
var SQLWRITE = require("./sqlwrite.js");

var db = SQLITE.open(new Uint8Array(fs.readFileSync("in.sqlite")));
if (!db.ok) throw new Error(db.reason);

var tables = db.schema
  .filter(function (s) { return s.type === "table" && s.name.indexOf("sqlite_") !== 0; })
  .map(function (s) {
    // an INTEGER PRIMARY KEY column is stored as the rowid: put it back and tell the writer
    var pk = s.columns.findIndex(function (c) { return new RegExp(c + "\\s+INTEGER\\s+PRIMARY\\s+KEY", "i").test(s.sql); });
    var rows = [];
    SQLITE.walkTable(db, s.rootpage, function (rowid, vals) {
      var row = vals.slice(0, s.columns.length);
      if (pk >= 0) row[pk] = rowid;
      rows.push(row);
    });
    console.log(s.name, s.columns.join(", "), rows.length + " rows");
    return { name: s.name, columns: s.columns, rows: rows, sql: s.sql, pkColumn: pk >= 0 ? pk : undefined };
  });

fs.writeFileSync("out.sqlite", SQLWRITE.build(tables));   // a Uint8Array holding a complete .sqlite file
```

Then hold the output to the official engine: `sqlite3 out.sqlite "PRAGMA integrity_check;"` prints `ok`.
The example keeps it short: BLOB values arrive from `walkTable` as `{ blob: ... }` and need
`new Uint8Array(v.blob)` before writing (see `app.js`), and the primary-key match is a simple pattern.
Indexes, views and triggers are not rebuilt; their `CREATE` statements are in `db.schema`.

## Run it locally

It's a static site — any static server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

A service worker (`sw.js`) caches everything for offline use after the first
load. The sql.js analysis engine (`sql-wasm.js` / `sql-wasm.wasm`) is fetched
only the first time you run a join/`GROUP BY`, then runtime-cached.

## VS Code extension

There's a companion **VS Code extension** that opens `.sqlite` / `.db` files as a
custom editor, reusing this repo's `sqlite.js` reader — pure JS, no native
dependencies, works in web VS Code too. It lives in a separate repository that is not published yet.

## Credits

- [sql.js](https://github.com/sql-js/sql.js) — SQLite compiled to WebAssembly
  (MIT), used lazily as the read-only analysis engine.
- [SQLite](https://sqlite.org) — the file format (public domain); the reference
  engine is the bar every `.sqlite` export is held to.
- Fonts: IBM Plex Sans / Mono and Caveat, via Google Fonts.

## Third-party

- `sql-wasm.js` / `sql-wasm.wasm` are a bundled build of [sql.js](https://github.com/sql-js/sql.js)
  (SQLite compiled to WebAssembly), published upstream under the MIT licence. Its licence
  notice is in [`LICENSE-sql.js.txt`](LICENSE-sql.js.txt); keep it alongside those two files
  when redistributing.
- [SQLite](https://sqlite.org) itself is public domain.
- Fonts (IBM Plex Sans / Mono, Caveat) are loaded from Google Fonts under their own licences.

## License

[MIT](LICENSE).
