/* editsqlite analysisdb.js — the read-only analysis engine.
   sqlmini handles the four editing verbs by hand, instantly, offline. But joins,
   grouping, subqueries and aggregates are a mountain, not a footpath — so for
   those we summon the real thing: SQLite compiled to WebAssembly (sql.js),
   loaded lazily the first time it's needed and used only to READ. It never
   touches the model, never writes, never sits on the export path. The editor
   still boots with zero WASM; this only wakes up when a question needs it.

   Public shape mirrors SQLMINI so app.js renders results the same way:
     ANALYSIS.needsFullEngine(sql) -> boolean   (should this route here?)
     ANALYSIS.isRead(sql)          -> boolean   (read-only guard)
     ANALYSIS.available()          -> boolean   (engine already loaded?)
     ANALYSIS.query(model, rev, sql) -> Promise<{kind:"select", columns, rows}>
*/
var ANALYSIS = (function () {
  "use strict";

  var SQL = null;          // the sql.js module, once loaded
  var loading = null;      // in-flight load promise (dedupe concurrent calls)
  var cache = null;        // { rev, db } — ephemeral DB rebuilt only when rev changes

  // ---------- routing classifier ----------
  // Strip strings and comments so keywords inside data don't trigger a route.
  function scrub(sql) {
    return String(sql)
      .replace(/'(?:[^']|'')*'/g, "''")          // string literals
      .replace(/--[^\n]*/g, " ")                  // line comments
      .replace(/\/\*[\s\S]*?\*\//g, " ");         // block comments
  }

  // Does this read need more than sqlmini's footpath? (joins, grouping,
  // aggregates, subqueries, set ops, CTEs, window funcs, multi-table FROM,
  // or an expression/function in the select list.)
  function needsFullEngine(sql) {
    var s = scrub(sql);
    if (!/^\s*(SELECT|WITH)\b/i.test(s)) return false;   // only reads route here
    if (/^\s*WITH\b/i.test(s)) return true;
    if (/\bJOIN\b/i.test(s)) return true;
    if (/\bGROUP\s+BY\b/i.test(s)) return true;
    if (/\bHAVING\b/i.test(s)) return true;
    if (/\bDISTINCT\b/i.test(s)) return true;
    if (/\b(UNION|INTERSECT|EXCEPT)\b/i.test(s)) return true;
    if (/\bOVER\s*\(/i.test(s)) return true;
    if (/\b(COUNT|SUM|AVG|MIN|MAX|TOTAL|GROUP_CONCAT)\s*\(/i.test(s)) return true;
    if (/\bCASE\b/i.test(s)) return true;
    // subquery anywhere
    if (/\(\s*SELECT\b/i.test(s)) return true;
    // multiple tables in FROM (comma before WHERE/GROUP/ORDER/LIMIT/end)
    var fromM = /\bFROM\b([\s\S]*?)(\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|$)/i.exec(s);
    if (fromM && /,/.test(fromM[1])) return true;
    // an expression or function call in the select list (before FROM)
    var selM = /^\s*SELECT\b([\s\S]*?)\bFROM\b/i.exec(s);
    if (selM && /[()+\-*/]|\|\|/.test(selM[1].replace(/\*/, ""))) {
      // bare "SELECT *" is fine; anything with operators/parens/concat is not
      if (!/^\s*\*\s*$/.test(selM[1])) return true;
    }
    return false;
  }

  // Read-only guard: exactly one statement, and it must be a read.
  function isRead(sql) {
    var s = scrub(sql).trim().replace(/;\s*$/, "");
    if (/;/.test(s)) return false;                        // no multi-statement here
    return /^\s*(SELECT|WITH|EXPLAIN|PRAGMA)\b/i.test(s);
  }

  // ---------- lazy engine load ----------
  function load() {
    if (SQL) return Promise.resolve(SQL);
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      if (typeof initSqlJs === "function") return initHere(resolve, reject);
      var s = document.createElement("script");
      s.src = "sql-wasm.js";
      s.onload = function () { initHere(resolve, reject); };
      s.onerror = function () {
        loading = null;
        reject(new Error("analysis engine could not be fetched — connect once and it caches for offline use; simple queries still work without it"));
      };
      document.head.appendChild(s);
    });
    return loading;
  }
  function initHere(resolve, reject) {
    if (typeof initSqlJs !== "function") { loading = null; return reject(new Error("analysis engine failed to initialize")); }
    initSqlJs({ locateFile: function () { return "sql-wasm.wasm"; } })
      .then(function (mod) { SQL = mod; resolve(SQL); })
      .catch(function (e) { loading = null; reject(e); });
  }

  // ---------- build an ephemeral DB from the model ----------
  // Primary path dogfoods the certified writer: analysis sees the exact bytes an
  // export would produce. If the writer declines (e.g. a >4KB row it can't page
  // yet), fall back to a direct CREATE/INSERT build so analysis still works where
  // export can't. Either way this DB is a throwaway — read from, never written back.
  function buildDb(model) {
    var bytes = null;
    try {
      bytes = SQLWRITE.build(model.tables.map(function (t) {
        return { name: t.name, columns: t.columns, rows: t.rows,
                 sql: t.sql || undefined,
                 pkColumn: (t.pkColumn != null && t.pkColumn >= 0) ? t.pkColumn : undefined };
      }));
    } catch (e) { bytes = null; }              // writer limit — use the direct path

    if (bytes) {
      try { return new SQL.Database(bytes); } catch (e) { /* fall through */ }
    }
    return buildDirect(model);
  }

  function q(id) { return '"' + String(id).replace(/"/g, '""') + '"'; }

  function buildDirect(model) {
    var db = new SQL.Database();
    model.tables.forEach(function (t) {
      var cols = t.columns.map(function (c) { return q(c); }).join(", ");
      db.run("CREATE TABLE " + q(t.name) + " (" + cols + ")");
      if (!t.rows.length) return;
      var ph = "(" + t.columns.map(function () { return "?"; }).join(",") + ")";
      var stmt = db.prepare("INSERT INTO " + q(t.name) + " VALUES " + ph);
      t.rows.forEach(function (r) {
        var bind = t.columns.map(function (_, i) {
          var v = r[i];
          return (v === undefined) ? null : v;   // numbers/strings/null/Uint8Array bind natively
        });
        stmt.run(bind);
      });
      stmt.free();
    });
    return db;
  }

  function dbFor(model, rev) {
    if (cache && cache.rev === rev) return cache.db;
    if (cache && cache.db) { try { cache.db.close(); } catch (e) {} }
    cache = { rev: rev, db: buildDb(model) };
    return cache.db;
  }

  // Drop the cached engine DB (called when a model is closed).
  function reset() {
    if (cache && cache.db) { try { cache.db.close(); } catch (e) {} }
    cache = null;
  }

  // ---------- run a read ----------
  function query(model, rev, sql) {
    if (!isRead(sql)) {
      return Promise.reject(new Error("the analysis engine only reads — run UPDATE / DELETE / INSERT through the editor, which edits the model and keeps undo"));
    }
    return load().then(function () {
      var db = dbFor(model, rev);
      var stmt = db.prepare(sql);
      var columns = null, rows = [];
      try {
        while (stmt.step()) {
          if (!columns) columns = stmt.getColumnNames();
          rows.push(stmt.get(null, { useBigInt: false }));
        }
        if (!columns) columns = stmt.getColumnNames();
      } finally {
        stmt.free();
      }
      // sql.js hands blobs back as Uint8Array already; null stays null — the
      // existing renderer knows both.
      return { kind: "select", columns: columns || [], rows: rows, engine: "sqlite" };
    });
  }

  return {
    needsFullEngine: needsFullEngine,
    isRead: isRead,
    available: function () { return !!SQL; },
    query: query,
    reset: reset
  };
})();
if (typeof module !== "undefined") module.exports = ANALYSIS;
