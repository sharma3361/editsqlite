/* editsqlite smartquery.js — plain-English → SQL, the honest small way.
   No model, no API key, no download, no network. A slot-filling parser that
   covers the questions people actually ask a data grid — count/sum/avg by X,
   top/bottom N by X, filters, distinct, sort, show all — and turns them into a
   single SQLite statement that lands in the console for you to review and run.
   Being local, it can read the actual data to resolve a value ("in London" →
   which column holds "London") — something a schema-only model never could.

     SMARTQUERY.toSQL(question, tables, activeName)
        tables: [{ name, columns:[...], types:[...], rows:[[...]] }]
        -> { sql, note, table } | { error } */
var SMARTQUERY = (function () {
  "use strict";

  function q(id) { return '"' + String(id).replace(/"/g, '""') + '"'; }
  function lc(s) { return String(s).toLowerCase(); }
  function rx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function num(s) { return String(s).replace(/,/g, ""); }
  function isNumType(t) { return /^(INT|INTEGER|REAL|NUM|DEC|FLOAT|DOUBLE)/i.test(t || ""); }
  function lit(v) { return typeof v === "number" ? String(v) : "'" + String(v).replace(/'/g, "''") + "'"; }
  function ok(sql, note, table) { return { sql: sql, note: note, table: table }; }

  function colType(table, name) {
    var i = table.columns.indexOf(name);
    return (table.types && table.types[i]) || "";
  }
  function firstNumeric(table) {
    for (var i = 0; i < table.columns.length; i++) if (isNumType((table.types || [])[i])) return table.columns[i];
    return null;
  }
  function hasWord(ql, w) { return new RegExp("\\b" + rx(lc(w)) + "\\b").test(ql); }

  function matchCol(word, table) {
    var cols = table.columns, w = lc(word);
    for (var i = 0; i < cols.length; i++) if (lc(cols[i]) === w) return cols[i];
    for (var j = 0; j < cols.length; j++) {
      var c = lc(cols[j]);
      if (w.length >= 3 && (c.indexOf(w) >= 0 || w.indexOf(c) >= 0)) return cols[j];
    }
    return null;
  }
  function plural(c) { c = lc(c); return /y$/.test(c) ? c.slice(0, -1) + "ies" : c + "s"; }
  function mentionedCols(ql, table) {
    var found = [];
    table.columns.forEach(function (c) {
      var forms = [lc(c), plural(c)];
      for (var k = 0; k < forms.length; k++) {
        if (hasWord(ql, forms[k])) { found.push({ col: c, at: ql.indexOf(forms[k]), numeric: isNumType(colType(table, c)) }); break; }
      }
    });
    found.sort(function (a, b) { return a.at - b.at; });
    return found;
  }
  function pickTable(ql, tables, activeName) {
    for (var i = 0; i < tables.length; i++) {
      var n = lc(tables[i].name);
      if (hasWord(ql, n) || (n.slice(-1) === "s" && hasWord(ql, n.slice(0, -1)))) return tables[i];
    }
    if (activeName) for (var j = 0; j < tables.length; j++) if (tables[j].name === activeName) return tables[j];
    return tables[0];
  }

  // Local advantage: find which column holds a value by scanning the actual data.
  function findValue(token, table) {
    var tl = lc(token), rows = table.rows || [], cap = Math.min(rows.length, 5000);
    for (var c = 0; c < table.columns.length; c++) {
      for (var r = 0; r < cap; r++) {
        var v = rows[r][c];
        if (v != null && !(v instanceof Uint8Array) && lc(v) === tl) return { col: table.columns[c], value: v };
      }
    }
    return null;
  }

  // ---------- detectors ----------
  function detectAgg(ql) {
    if (hasWord(ql, "count") || /\bhow many\b|\bnumber of\b/.test(ql)) return { fn: "COUNT" };
    if (/\b(average|avg|mean)\b/.test(ql)) return { fn: "AVG" };
    if (/\b(sum|total)\b/.test(ql)) return { fn: "SUM" };
    if (/\b(max|maximum|highest|largest|biggest|greatest)\b/.test(ql)) return { fn: "MAX" };
    if (/\b(min|minimum|lowest|smallest)\b/.test(ql)) return { fn: "MIN" };
    return null;
  }
  function detectGroup(ql, table) {
    var m = /\b(?:by|per|for each|grouped by|group by)\s+([a-z0-9_]+)/.exec(ql);
    return m ? matchCol(m[1], table) : null;
  }
  function detectLimit(ql) {
    var m, n = null, dir = "DESC";
    if ((m = /\btop\s+(\d+)/.exec(ql))) { n = +m[1]; dir = "DESC"; }
    else if ((m = /\bbottom\s+(\d+)/.exec(ql))) { n = +m[1]; dir = "ASC"; }
    else if ((m = /\bfirst\s+(\d+)/.exec(ql))) { n = +m[1]; dir = "ASC"; }
    else if ((m = /\blast\s+(\d+)/.exec(ql))) { n = +m[1]; dir = "DESC"; }
    else if ((m = /\b(\d+)\s+(highest|largest|biggest|top|most|best|dearest)\b/.exec(ql))) { n = +m[1]; dir = "DESC"; }
    else if ((m = /\b(\d+)\s+(lowest|smallest|least|bottom|worst|cheapest)\b/.exec(ql))) { n = +m[1]; dir = "ASC"; }
    return n != null ? { n: n, dir: dir } : null;
  }
  function orderColumn(ql, table) {
    var m = /\bby\s+([a-z0-9_]+)/.exec(ql);
    if (m) { var c = matchCol(m[1], table); if (c) return c; }
    var ms = mentionedCols(ql, table).filter(function (x) { return x.numeric; });
    return ms.length ? ms[0].col : null;
  }
  function detectWhere(ql, table) {
    var m;
    if ((m = /\b([a-z0-9_]+)\s+(?:is\s+)?(?:null|empty|missing|blank|unset)\b/.exec(ql))) {
      var c0 = matchCol(m[1], table); if (c0) return { sql: q(c0) + " IS NULL", note: c0 + " is empty" };
    }
    var cmp = [
      [/\b([a-z0-9_]+)\s+(?:>=|at least|minimum of)\s+([0-9][0-9.,]*)/, ">="],
      [/\b([a-z0-9_]+)\s+(?:<=|at most|maximum of)\s+([0-9][0-9.,]*)/, "<="],
      [/\b([a-z0-9_]+)\s+(?:over|above|greater than|more than|bigger than|exceeds|>)\s+([0-9][0-9.,]*)/, ">"],
      [/\b([a-z0-9_]+)\s+(?:under|below|less than|fewer than|smaller than|<)\s+([0-9][0-9.,]*)/, "<"]
    ];
    for (var i = 0; i < cmp.length; i++) {
      if ((m = cmp[i][0].exec(ql))) {
        var cc = matchCol(m[1], table);
        if (cc) return { sql: q(cc) + " " + cmp[i][1] + " " + num(m[2]), note: cc + " " + cmp[i][1] + " " + num(m[2]) };
      }
    }
    // "<col> is/= <value>"
    if ((m = /\b([a-z0-9_]+)\s+(?:is|=|equals|equal to)\s+([a-z0-9_.\-']+)/.exec(ql))) {
      var c1 = matchCol(m[1], table);
      if (c1) {
        var val = m[2];
        if (/^-?\d+(\.\d+)?$/.test(val)) return { sql: q(c1) + " = " + val, note: c1 + " = " + val };
        var hit = findValue(val, table);
        var real = hit && hit.col === c1 ? hit.value : val;
        return { sql: q(c1) + " = " + lit(real), note: c1 + " = " + real };
      }
    }
    // data-driven: a leftover word that appears in the data → WHERE col = value
    return valueScan(ql, table);
  }

  var STOP = (" count how many number of average avg mean sum total max maximum min minimum highest lowest " +
    "largest smallest biggest greatest most least top bottom first last by per each grouped group order ordered " +
    "sort sorted unique distinct show list all everything rows row browse see display view where is are not null " +
    "empty missing blank unset over above greater than more under below less fewer at equals equal to in from with " +
    "and the a an of for me give find get which what who desc descending asc ascending reverse paid named called " +
    "value values only rows").split(/\s+/);
  function valueScan(ql, table) {
    var stop = {}; STOP.forEach(function (w) { stop[w] = 1; });
    table.columns.forEach(function (c) { stop[lc(c)] = 1; });
    stop[lc(table.name)] = 1;
    var words = ql.trim().split(/\s+/).filter(function (w) { return w && !/^\d+$/.test(w); });
    // try 2-word phrases first (e.g. "new york"), then single words
    for (var len = 2; len >= 1; len--) {
      for (var i = 0; i + len <= words.length; i++) {
        var win = words.slice(i, i + len);
        if (win.some(function (w) { return stop[w]; })) continue;
        var hit = findValue(win.join(" "), table);
        if (hit) return { sql: q(hit.col) + " = " + lit(hit.value), note: hit.col + " = " + hit.value };
      }
    }
    return null;
  }

  // ---------- main ----------
  function toSQL(question, tables, activeName) {
    if (!tables || !tables.length) return { error: "open a database first" };
    var raw = String(question || "").trim();
    if (!raw) return { error: "type a question first" };
    var ql = " " + lc(raw).replace(/\s+/g, " ") + " ";
    var table = pickTable(ql, tables, activeName), T = table.name;
    var where = detectWhere(ql, table);
    var wsql = where ? " WHERE " + where.sql : "";
    var wnote = where ? " where " + where.note : "";

    // distinct
    var mD = /\b(?:unique|distinct)\s+([a-z0-9_]+)/.exec(ql);
    if (mD) { var dc = matchCol(mD[1], table); if (dc) return ok("SELECT DISTINCT " + q(dc) + " FROM " + q(T) + wsql + " ORDER BY " + q(dc), "distinct values of " + dc + wnote, T); }

    var agg = detectAgg(ql);
    var groupCol = detectGroup(ql, table);
    var topN = detectLimit(ql);

    // aggregate — for COUNT/SUM/AVG, or any aggregate that's grouped
    if (agg && (agg.fn === "COUNT" || agg.fn === "SUM" || agg.fn === "AVG" || groupCol)) return aggregate(agg, groupCol, where, wsql, wnote, ql, table, T);

    // top / bottom N
    if (topN) {
      var oc = orderColumn(ql, table) || firstNumeric(table);
      if (oc) return ok("SELECT * FROM " + q(T) + wsql + " ORDER BY " + q(oc) + " " + topN.dir + " LIMIT " + topN.n,
        topN.n + " row" + (topN.n === 1 ? "" : "s") + " by " + oc + " (" + (topN.dir === "DESC" ? "highest" : "lowest") + " first)" + wnote, T);
      return ok("SELECT * FROM " + q(T) + wsql + " LIMIT " + topN.n, "first " + topN.n + " rows" + wnote, T);
    }

    // bare MAX/MIN (single value)
    if (agg) return aggregate(agg, null, where, wsql, wnote, ql, table, T);

    // sort / order by
    var mS = /\b(?:sort|order)(?:ed)?\s+by\s+([a-z0-9_]+)/.exec(ql);
    if (mS) { var sc = matchCol(mS[1], table); if (sc) { var dir = /\b(desc|descending|highest|reverse)\b/.test(ql) ? "DESC" : "ASC"; return ok("SELECT * FROM " + q(T) + wsql + " ORDER BY " + q(sc) + " " + dir, "sorted by " + sc + " " + (dir === "DESC" ? "↓" : "↑") + wnote, T); } }

    // filter only
    if (where) return ok("SELECT * FROM " + q(T) + " WHERE " + where.sql, "rows where " + where.note, T);

    // show all
    if (/\b(show|list|all|everything|rows|browse|see|display|view)\b/.test(ql)) return ok("SELECT * FROM " + q(T), "all rows of " + T, T);

    return { error: "couldn't turn that into SQL — try “count by <column>”, “average <number> by <column>”, “top 5 by <column>”, “<column> over 100”, or “rows in <value>”." };
  }

  function aggregate(agg, groupCol, where, wsql, wnote, ql, table, T) {
    var expr, whatCol = null;
    if (agg.fn === "COUNT") { expr = "COUNT(*)"; }
    else {
      var ms = mentionedCols(ql, table).filter(function (m) { return m.numeric && m.col !== groupCol; });
      whatCol = ms.length ? ms[0].col : firstNumeric(table);
      if (!whatCol) return { error: "couldn't find a number column to " + agg.fn.toLowerCase() + " — name one, e.g. “" + agg.fn.toLowerCase() + " salary by role”" };
      expr = agg.fn + "(" + q(whatCol) + ")";
    }
    if (groupCol) return ok("SELECT " + q(groupCol) + ", " + expr + " AS " + q(aggAlias(agg, whatCol)) + " FROM " + q(T) + wsql + " GROUP BY " + q(groupCol) + " ORDER BY 2 DESC",
      expr.toLowerCase() + " per " + groupCol + wnote, T);
    return ok("SELECT " + expr + " AS " + q(aggAlias(agg, whatCol)) + " FROM " + q(T) + wsql, expr.toLowerCase() + " of " + T + wnote, T);
  }
  function aggAlias(agg, col) {
    if (agg.fn === "COUNT") return "count";
    return agg.fn.toLowerCase() + "_" + (col || "value");
  }

  return { toSQL: toSQL };
})();
if (typeof module !== "undefined") module.exports = SMARTQUERY;
