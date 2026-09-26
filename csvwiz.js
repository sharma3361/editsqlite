/* editsqlite csvwiz.js — the CSV intake bench. A quote-correct CSV reader
   (commas and newlines inside quoted fields, doubled quotes, CRLF), a
   per-column type surveyor, and the coercion rules the wizard applies.
   No DOM in here — the wizard UI lives in app.js; this is the machinery. */
var CSVWIZ = (function () {
  "use strict";

  // parse(text) -> array of rows, each an array of field strings.
  // RFC-4180 quoting: a quoted field may contain commas, newlines and
  // doubled quotes ("" -> "). CRLF and bare CR both end a row.
  function parse(text) {
    var rows = [], row = [], cur = "", inQ = false, fielded = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else if (c === '"') { inQ = true; fielded = true; }
      else if (c === ",") { row.push(cur); cur = ""; fielded = true; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        if (cur !== "" || row.length || fielded) { row.push(cur); rows.push(row); }
        row = []; cur = ""; fielded = false;
      } else { cur += c; fielded = true; }
    }
    if (cur !== "" || row.length || fielded) { row.push(cur); rows.push(row); }
    return rows;
  }

  var INT_RX = /^-?\d+$/;
  var REAL_RX = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

  // guessType(values) -> "INTEGER" | "REAL" | "TEXT"
  // Surveys a column: every non-empty value must agree. One stray word
  // makes the whole column TEXT — better honest than half-numeric.
  function guessType(values) {
    var sawAny = false, sawReal = false;
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      if (v === undefined || v === null || v === "") continue;
      v = String(v).trim();
      if (v === "") continue;
      sawAny = true;
      if (INT_RX.test(v)) continue;
      if (REAL_RX.test(v)) { sawReal = true; continue; }
      return "TEXT";
    }
    if (!sawAny) return "TEXT";
    return sawReal ? "REAL" : "INTEGER";
  }

  // coerce(raw, type) -> the value the model stores.
  // Empty -> NULL. A value that can't honor the chosen type stays text
  // (the same affinity mercy SQLite itself shows) rather than being mangled.
  function coerce(raw, type) {
    if (raw === undefined || raw === null || raw === "") return null;
    var s = String(raw);
    var t = s.trim();
    if (type === "INTEGER" && INT_RX.test(t)) return parseInt(t, 10);
    if (type === "REAL" && (REAL_RX.test(t) || INT_RX.test(t))) return parseFloat(t);
    return s;
  }

  // ddl(name, columns, types) -> a typed CREATE TABLE statement, quoted the
  // way our writer stores it on the schema page.
  function ddl(name, columns, types) {
    function q(x) { return '"' + String(x).replace(/"/g, '""') + '"'; }
    return "CREATE TABLE " + q(name) + " (" +
      columns.map(function (c, i) { return q(c) + " " + (types[i] || "TEXT"); }).join(", ") + ")";
  }

  return { parse: parse, guessType: guessType, coerce: coerce, ddl: ddl };
})();
if (typeof module !== "undefined") module.exports = CSVWIZ;
