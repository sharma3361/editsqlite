/* editsqlite sqlmini.js — a small SQL interpreter, written by hand.
   Tokenizer → recursive-descent parser → row predicates. Covers the four
   verbs a data editor honestly needs: SELECT / UPDATE / DELETE / INSERT,
   with WHERE (=, <>, <, <=, >, >=, LIKE, IS NULL, AND/OR/NOT, parens),
   ORDER BY and LIMIT. Not the mountain — the well-made footpath. */
var SQLMINI = (function () {
  "use strict";

  // A genuine user error the full engine couldn't rescue either (the table or
  // column really isn't there). Tagged so app.js surfaces it instead of falling
  // through to sql.js. Everything else this engine throws is "grammar I don't
  // cover" — the router treats those as a cue to summon the analysis engine.
  function rerr(msg) { var e = new Error(msg); e.runtime = true; return e; }

  // ---------- tokenizer ----------
  function tokenize(sql) {
    var toks = [];
    var i = 0, n = sql.length;
    var KW = /^(SELECT|FROM|WHERE|AND|OR|NOT|ORDER|BY|LIMIT|DESC|ASC|UPDATE|SET|DELETE|INSERT|INTO|VALUES|LIKE|IS|NULL|AS)$/i;
    while (i < n) {
      var c = sql[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "'") {
        var s = "";
        i++;
        while (i < n) {
          if (sql[i] === "'" && sql[i + 1] === "'") { s += "'"; i += 2; continue; }
          if (sql[i] === "'") break;
          s += sql[i++];
        }
        i++;
        toks.push({ t: "str", v: s });
        continue;
      }
      if (c === '"' || c === "`") {
        var q = c, id = "";
        i++;
        while (i < n && sql[i] !== q) id += sql[i++];
        i++;
        toks.push({ t: "ident", v: id });
        continue;
      }
      if (/[0-9]/.test(c) || (c === "-" && /[0-9]/.test(sql[i + 1]) && (!toks.length || /^(op|lparen|comma|kw)$/.test(toks[toks.length - 1].t)))) {
        var num = c;
        i++;
        while (i < n && /[0-9.eE+\-]/.test(sql[i])) {
          if ((sql[i] === "+" || sql[i] === "-") && !/[eE]/.test(sql[i - 1])) break;
          num += sql[i++];
        }
        toks.push({ t: "num", v: parseFloat(num) });
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        var w = "";
        while (i < n && /[A-Za-z0-9_]/.test(sql[i])) w += sql[i++];
        if (KW.test(w)) toks.push({ t: "kw", v: w.toUpperCase() });
        else toks.push({ t: "ident", v: w });
        continue;
      }
      if (c === "<" && sql[i + 1] === "=") { toks.push({ t: "op", v: "<=" }); i += 2; continue; }
      if (c === ">" && sql[i + 1] === "=") { toks.push({ t: "op", v: ">=" }); i += 2; continue; }
      if (c === "<" && sql[i + 1] === ">") { toks.push({ t: "op", v: "<>" }); i += 2; continue; }
      if (c === "!" && sql[i + 1] === "=") { toks.push({ t: "op", v: "<>" }); i += 2; continue; }
      if ("=<>".indexOf(c) >= 0) { toks.push({ t: "op", v: c }); i++; continue; }
      if (c === "(") { toks.push({ t: "lparen" }); i++; continue; }
      if (c === ")") { toks.push({ t: "rparen" }); i++; continue; }
      if (c === ",") { toks.push({ t: "comma" }); i++; continue; }
      if (c === "*") { toks.push({ t: "star" }); i++; continue; }
      if (c === ";") { i++; continue; }
      throw new Error("unexpected character '" + c + "' at position " + i);
    }
    return toks;
  }

  // ---------- parser state ----------
  function Parser(toks) {
    this.toks = toks;
    this.i = 0;
  }
  Parser.prototype.peek = function () { return this.toks[this.i] || {}; };
  Parser.prototype.next = function () { return this.toks[this.i++] || {}; };
  Parser.prototype.kw = function (word) {
    if (this.peek().t === "kw" && this.peek().v === word) { this.i++; return true; }
    return false;
  };
  Parser.prototype.expectKw = function (word) {
    if (!this.kw(word)) throw new Error("expected " + word + " near token " + this.i);
  };
  Parser.prototype.ident = function () {
    var t = this.next();
    if (t.t !== "ident") throw new Error("expected a name, got " + JSON.stringify(t.v || t.t));
    return t.v;
  };

  // ---------- WHERE expression → predicate(rowObj) ----------
  function parseExpr(p) { return parseOr(p); }
  function parseOr(p) {
    var left = parseAnd(p);
    while (p.kw("OR")) {
      var right = parseAnd(p);
      left = (function (l, r) { return function (row) { return l(row) || r(row); }; })(left, right);
    }
    return left;
  }
  function parseAnd(p) {
    var left = parseNot(p);
    while (p.kw("AND")) {
      var right = parseNot(p);
      left = (function (l, r) { return function (row) { return l(row) && r(row); }; })(left, right);
    }
    return left;
  }
  function parseNot(p) {
    if (p.kw("NOT")) {
      var inner = parseNot(p);
      return function (row) { return !inner(row); };
    }
    return parseCmp(p);
  }
  function parseCmp(p) {
    if (p.peek().t === "lparen") {
      p.next();
      var e = parseExpr(p);
      if (p.next().t !== "rparen") throw new Error("missing )");
      return e;
    }
    var left = parseOperand(p);
    if (p.kw("IS")) {
      var negated = p.kw("NOT");
      p.expectKw("NULL");
      return function (row) {
        var v = left(row);
        return negated ? v !== null : v === null;
      };
    }
    if (p.kw("LIKE")) {
      var pat = p.next();
      if (pat.t !== "str") throw new Error("LIKE needs a 'pattern'");
      var rx = new RegExp("^" + pat.v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%/g, "[\\s\\S]*").replace(/_/g, "[\\s\\S]") + "$", "i");
      return function (row) {
        var v = left(row);
        return v !== null && rx.test(String(v));
      };
    }
    var op = p.next();
    if (op.t !== "op") throw new Error("expected a comparison near token " + (p.i - 1));
    var right = parseOperand(p);
    var o = op.v;
    return function (row) {
      var a = left(row), b = right(row);
      if (a === null || b === null) return false;      // SQL three-valued lite
      if (typeof a === "number" && typeof b === "number") {
        // numeric compare
      } else { a = String(a); b = String(b); }
      if (o === "=") return a === b;
      if (o === "<>") return a !== b;
      if (o === "<") return a < b;
      if (o === "<=") return a <= b;
      if (o === ">") return a > b;
      if (o === ">=") return a >= b;
      return false;
    };
  }
  function parseOperand(p) {
    var t = p.next();
    if (t.t === "num") return function () { return t.v; };
    if (t.t === "str") return function () { return t.v; };
    if (t.t === "kw" && t.v === "NULL") return function () { return null; };
    if (t.t === "ident") return function (row) {
      if (!(t.v in row)) throw rerr("no such column: " + t.v);
      return row[t.v];
    };
    throw new Error("unexpected " + (t.v || t.t) + " in expression");
  }

  function parseValueToken(p) {
    var t = p.next();
    if (t.t === "num") return t.v;
    if (t.t === "str") return t.v;
    if (t.t === "kw" && t.v === "NULL") return null;
    throw new Error("expected a value, got " + (t.v || t.t));
  }

  // ---------- run(sql, tables) ----------
  // tables: {name: {columns: [...], rows: [[...]]}} — rows are arrays
  // returns {kind, columns?, rows?, changed?, table}
  function run(sql, tables) {
    var p = new Parser(tokenize(sql));

    function getTable(name) {
      var key = Object.keys(tables).find(function (k) { return k.toLowerCase() === name.toLowerCase(); });
      if (!key) throw rerr("no such table: " + name);
      return tables[key];
    }
    function rowObj(t, arr) {
      var o = {};
      t.columns.forEach(function (c, i) { o[c] = arr[i] === undefined ? null : arr[i]; });
      return o;
    }

    if (p.kw("SELECT")) {
      var cols = [];
      var star = false;
      if (p.peek().t === "star") { p.next(); star = true; }
      else {
        do { cols.push(p.ident()); } while (p.peek().t === "comma" && p.next());
      }
      p.expectKw("FROM");
      var t = getTable(p.ident());
      var pred = p.kw("WHERE") ? parseExpr(p) : function () { return true; };
      var orderCol = null, orderDesc = false;
      if (p.kw("ORDER")) {
        p.expectKw("BY");
        orderCol = p.ident();
        if (p.kw("DESC")) orderDesc = true;
        else p.kw("ASC");
      }
      var limit = Infinity;
      if (p.kw("LIMIT")) limit = p.next().v;
      var outCols = star ? t.columns.slice() : cols;
      outCols.forEach(function (c) {
        if (t.columns.indexOf(c) < 0) throw rerr("no such column: " + c);
      });
      var picked = [];
      for (var r = 0; r < t.rows.length; r++) {
        var obj = rowObj(t, t.rows[r]);
        if (pred(obj)) picked.push(obj);
      }
      if (orderCol) {
        picked.sort(function (a, b) {
          var x = a[orderCol], y = b[orderCol];
          if (x === null) return -1;
          if (y === null) return 1;
          if (x < y) return -1;
          if (x > y) return 1;
          return 0;
        });
        if (orderDesc) picked.reverse();
      }
      if (picked.length > limit) picked.length = limit;
      return {
        kind: "select",
        columns: outCols,
        rows: picked.map(function (o) { return outCols.map(function (c) { return o[c]; }); })
      };
    }

    if (p.kw("UPDATE")) {
      var tu = getTable(p.ident());
      p.expectKw("SET");
      var sets = [];
      do {
        var col = p.ident();
        if (p.next().v !== "=") throw new Error("expected = in SET");
        sets.push({ col: col, idx: tu.columns.indexOf(col), val: parseValueToken(p) });
      } while (p.peek().t === "comma" && p.next());
      sets.forEach(function (s) { if (s.idx < 0) throw rerr("no such column: " + s.col); });
      var predU = p.kw("WHERE") ? parseExpr(p) : function () { return true; };
      var changed = 0;
      tu.rows.forEach(function (arr) {
        if (predU(rowObj(tu, arr))) {
          sets.forEach(function (s) { arr[s.idx] = s.val; });
          changed++;
        }
      });
      return { kind: "update", changed: changed, table: tu.name };
    }

    if (p.kw("DELETE")) {
      p.expectKw("FROM");
      var tdel = getTable(p.ident());
      var predD = p.kw("WHERE") ? parseExpr(p) : function () { return true; };
      var before = tdel.rows.length;
      tdel.rows = tdel.rows.filter(function (arr) { return !predD(rowObj(tdel, arr)); });
      return { kind: "delete", changed: before - tdel.rows.length, table: tdel.name };
    }

    if (p.kw("INSERT")) {
      p.expectKw("INTO");
      var tin = getTable(p.ident());
      var insCols = null;
      if (p.peek().t === "lparen") {
        p.next();
        insCols = [];
        do { insCols.push(p.ident()); } while (p.peek().t === "comma" && p.next());
        if (p.next().t !== "rparen") throw new Error("missing ) after columns");
      }
      p.expectKw("VALUES");
      var added = 0;
      while (p.peek().t === "lparen") {
        p.next();
        var vals = [];
        do { vals.push(parseValueToken(p)); } while (p.peek().t === "comma" && p.next());
        if (p.next().t !== "rparen") throw new Error("missing ) after values");
        var arr = new Array(tin.columns.length).fill(null);
        if (insCols) {
          insCols.forEach(function (c, i) {
            var idx = tin.columns.indexOf(c);
            if (idx < 0) throw rerr("no such column: " + c);
            arr[idx] = vals[i];
          });
        } else {
          vals.forEach(function (v, i) { arr[i] = v; });
        }
        tin.rows.push(arr);
        added++;
        if (p.peek().t === "comma") p.next();
      }
      return { kind: "insert", changed: added, table: tin.name };
    }

    throw new Error("statements start with SELECT, UPDATE, DELETE or INSERT here");
  }

  return { run: run };
})();
if (typeof module !== "undefined") module.exports = SQLMINI;
