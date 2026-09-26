/* editsqlite dumpparse.js — a .sql dump reader for the three big dialects.
   Not a SQL engine: a careful reader of what dump tools actually emit —
   CREATE TABLE, INSERT (single and multi-row), and Postgres COPY blocks —
   with string escapes handled the way each dialect really writes them. */
var DUMPPARSE = (function () {
  "use strict";

  // split a dump into statements, respecting quotes, comments and COPY blocks
  function parse(text) {
    var tables = {};             // name -> {name, columns, rows, sql}
    var order = [];
    var skipped = { statements: 0, kinds: {} };

    function getTable(name, columns, sql) {
      if (!tables[name]) {
        tables[name] = { name: name, columns: columns || [], rows: [], sql: sql || null };
        order.push(name);
      } else {
        if (columns && !tables[name].columns.length) tables[name].columns = columns;
        if (sql && !tables[name].sql) tables[name].sql = sql;
      }
      return tables[name];
    }

    var i = 0, n = text.length;
    while (i < n) {
      // skip whitespace + comments
      while (i < n) {
        var c = text[i];
        if (c === " " || c === "\n" || c === "\r" || c === "\t") { i++; continue; }
        if (c === "-" && text[i + 1] === "-") { while (i < n && text[i] !== "\n") i++; continue; }
        if (c === "/" && text[i + 1] === "*") {
          i += 2;
          while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
          i += 2;
          continue;
        }
        break;
      }
      if (i >= n) break;

      // Postgres COPY block: COPY name (cols) FROM stdin; ...data... \.
      var copyM = /^COPY\s+([^\s(]+)\s*(\(([^)]*)\))?\s+FROM\s+stdin;?/i.exec(text.slice(i, i + 400));
      if (copyM) {
        i += copyM[0].length;
        if (text[i] === "\n") i++;
        var end = text.indexOf("\n\\.", i);
        if (end < 0) end = n;
        var block = text.slice(i, end);
        var tname = cleanIdent(copyM[1]);
        var cols = copyM[3] ? copyM[3].split(",").map(function (s) { return cleanIdent(s.trim()); }) : [];
        var t = getTable(tname, cols, null);
        block.split("\n").forEach(function (line) {
          if (!line) return;
          t.rows.push(line.split("\t").map(copyValue));
        });
        i = end + 3;
        continue;
      }

      // read one statement to its ; (respecting quotes)
      var start = i;
      var inQ = null;
      while (i < n) {
        var ch = text[i];
        if (inQ) {
          if (ch === "\\" && inQ === "'" ) { i += 2; continue; }       // mysql backslash escape
          if (ch === inQ) {
            if (text[i + 1] === inQ) { i += 2; continue; }             // doubled quote
            inQ = null;
          }
          i++;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") { inQ = ch; i++; continue; }
        if (ch === ";") break;
        i++;
      }
      var stmt = text.slice(start, i);
      i++;                                                             // past the ;

      var head = stmt.slice(0, 40).toUpperCase();
      if (/^\s*CREATE\s+TABLE/i.test(stmt)) {
        var cm = /^\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?([^\s(]+)/i.exec(stmt);
        if (cm) {
          var name = cleanIdent(cm[2]);
          getTable(name, parseColumns(stmt), stmt.trim());
        }
      } else if (/^\s*INSERT\s+INTO/i.test(stmt)) {
        parseInsert(stmt, getTable);
      } else if (stmt.trim()) {
        skipped.statements++;
        var kind = (head.match(/^\s*([A-Z]+(\s+[A-Z]+)?)/) || [,"OTHER"])[1].trim().split(/\s+/).slice(0, 2).join(" ");
        skipped.kinds[kind] = (skipped.kinds[kind] || 0) + 1;
      }
    }

    return {
      ok: order.length > 0,
      reason: order.length ? null : "no CREATE TABLE, INSERT or COPY statements found — is this a SQL dump?",
      tables: order.map(function (k) { return tables[k]; }),
      skipped: skipped
    };
  }

  function cleanIdent(s) {
    s = s.trim().replace(/^[`"\[]|[`"\]]$/g, "");
    var dot = s.lastIndexOf(".");
    if (dot >= 0) s = s.slice(dot + 1).replace(/^[`"\[]|[`"\]]$/g, "");
    return s;
  }

  function parseColumns(createSql) {
    var m = createSql.match(/\(([\s\S]*)\)/);
    if (!m) return [];
    var body = m[1];
    var cols = [];
    var depth = 0, cur = "", inQ = null;
    for (var i = 0; i < body.length; i++) {
      var ch = body[i];
      if (inQ) { if (ch === inQ) inQ = null; cur += ch; continue; }
      if (ch === "'" || ch === '"' || ch === "`") { inQ = ch; cur += ch; continue; }
      if (ch === "(") { depth++; cur += ch; continue; }
      if (ch === ")") { depth--; cur += ch; continue; }
      if (ch === "," && depth === 0) { cols.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) cols.push(cur.trim());
    return cols
      .filter(function (c) { return !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT|KEY|INDEX|FULLTEXT)\b/i.test(c); })
      .map(function (c) {
        var mm = c.match(/^(`[^`]+`|"([^"]|"")+"|\[[^\]]+\]|\S+)/);
        return mm ? cleanIdent(mm[0]) : c;
      });
  }

  // INSERT INTO t (cols) VALUES (...), (...), ...;  — also without column list
  function parseInsert(stmt, getTable) {
    var m = /^\s*INSERT\s+INTO\s+([^\s(]+)\s*(\(([^)]*)\))?\s*VALUES\s*/i.exec(stmt);
    if (!m) return;
    var t = getTable(cleanIdent(m[1]), m[3] ? m[3].split(",").map(function (s) { return cleanIdent(s); }) : null, null);
    var i = m[0].length;
    var n = stmt.length;
    while (i < n) {
      while (i < n && stmt[i] !== "(") i++;
      if (i >= n) break;
      i++;
      var vals = [];
      var cur = "";
      var inQ = null;
      var depth = 0;
      var done = false;
      while (i < n && !done) {
        var ch = stmt[i];
        if (inQ) {
          if (ch === "\\" && inQ === "'") {                            // mysql escapes
            var nx = stmt[i + 1];
            cur += nx === "n" ? "\n" : nx === "t" ? "\t" : nx === "r" ? "\r" :
                   nx === "0" ? "\0" : nx;
            i += 2;
            continue;
          }
          if (ch === inQ) {
            if (stmt[i + 1] === inQ) { cur += inQ; i += 2; continue; } // doubled
            inQ = null;
            i++;
            continue;
          }
          cur += ch;
          i++;
          continue;
        }
        if (ch === "'") {
          inQ = "'";
          if (cur === "x" || cur === "X") cur = " HEX";      // X'...' blob literal
          else if (cur === "") cur = " STR";
          i++;
          continue;
        }
        if (ch === "(") { depth++; cur += ch; i++; continue; }
        if (ch === ")" && depth > 0) { depth--; cur += ch; i++; continue; }
        if (ch === ")" ) { vals.push(sqlValue(cur)); done = true; i++; continue; }
        if (ch === ",") { vals.push(sqlValue(cur)); cur = ""; i++; continue; }
        cur += ch;
        i++;
      }
      t.rows.push(vals);
    }
  }

  function sqlValue(raw) {
    if (raw.indexOf(" HEX") === 0) {
      var hex = raw.slice(4);
      var hb = new Uint8Array(hex.length / 2);
      for (var hi = 0; hi < hb.length; hi++) hb[hi] = parseInt(hex.substr(hi * 2, 2), 16);
      return hb;
    }
    if (raw.indexOf(" STR") === 0) return raw.slice(4);           // was quoted
    var s = raw.trim();
    if (/^NULL$/i.test(s)) return null;
    if (/^TRUE$/i.test(s)) return 1;
    if (/^FALSE$/i.test(s)) return 0;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(s) || /^-?\d+[eE][+-]?\d+$/.test(s)) return parseFloat(s);
    if (/^[xX]'[0-9a-fA-F]*'$/.test(s)) {                              // hex blob
      var hex = s.slice(2, -1);
      var b = new Uint8Array(hex.length / 2);
      for (var i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
      return b;
    }
    return s;                                                          // bare words survive as text
  }

  function copyValue(s) {
    if (s === "\\N") return null;
    var out = s.replace(/\\t/g, "\t").replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\\\/g, "\\");
    if (/^-?\d+$/.test(out)) return parseInt(out, 10);
    if (/^-?\d*\.\d+$/.test(out)) return parseFloat(out);
    return out;
  }

  return { parse: parse };
})();
if (typeof module !== "undefined") module.exports = DUMPPARSE;
