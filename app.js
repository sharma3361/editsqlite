/* editsqlite — the editor core. databases come in as files, live as an
   in-memory model, get edited by grid or by SQL, and leave as fresh files
   rebuilt from scratch. originals are never operated on — that's the
   safety architecture, not a limitation. */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var model = null;        // {tables: [{name, columns, rows, sql, pkColumn}], extras: [{kind, name, sql}]}
  var active = 0;
  var undoStack = [], redoStack = [];
  var UNDO_CAP = 40;
  var modelRev = 0;        // bumps on every model change; the analysis engine caches its ephemeral DB by this

  function note(m) { $("draftline").textContent = m; }
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ---------- intake ----------
  function loadFile(f) {
    var name = f.name;
    var r = new FileReader();
    if (/\.(sql|txt)$/i.test(name)) {
      r.onload = function () { fromDump(r.result, name); };
      r.readAsText(f);
    } else if (/\.csv$/i.test(name)) {
      r.onload = function () { fromCsv(r.result, name); };
      r.readAsText(f);
    } else {
      r.onload = function () { fromSqlite(new Uint8Array(r.result), name); };
      r.readAsArrayBuffer(f);
    }
  }
  function fromSqlite(u8, name) {
    var db = SQLITE.open(u8);
    if (!db.ok) { note("⚠ " + db.reason); return; }
    var tables = [];
    var extras = [];
    db.schema.forEach(function (s) {
      if (s.type === "table" && s.name.indexOf("sqlite_") !== 0) {
        var rows = [];
        SQLITE.walkTable(db, s.rootpage, function (rowid, vals) {
          var arr = vals.slice(0, s.columns.length);
          while (arr.length < s.columns.length) arr.push(null);
          // INTEGER PRIMARY KEY: stored null, real value is rowid
          if (rowid !== null) {
            var pkIdx = pkColumnOf(s.sql, s.columns);
            if (pkIdx >= 0 && arr[pkIdx] === null) arr[pkIdx] = rowid;
          }
          rows.push(arr.map(function (v) { return (v && typeof v === "object") ? new Uint8Array(v.blob) : v; }));
        });
        tables.push({ name: s.name, columns: s.columns.slice(), rows: rows, sql: s.sql,
                      pkColumn: pkColumnOf(s.sql, s.columns) });
      } else if (s.type !== "table") {
        extras.push({ kind: s.type, name: s.name, sql: s.sql });
      }
    });
    boot({ tables: tables, extras: extras }, name);
  }
  function pkColumnOf(sql, columns) {
    if (!sql) return -1;
    var m = sql.match(/([`"\[]?)(\w+)\1\s+INTEGER\s+PRIMARY\s+KEY/i);
    return m ? columns.indexOf(m[2]) : -1;
  }
  function fromDump(text, name) {
    var r = DUMPPARSE.parse(text);
    if (!r.ok) { note("⚠ " + r.reason); return; }
    var extras = [];
    Object.keys(r.skipped.kinds).forEach(function (k) {
      extras.push({ kind: "skipped", name: r.skipped.kinds[k] + "× " + k, sql: null });
    });
    boot({
      tables: r.tables.map(function (t) {
        return { name: t.name, columns: t.columns.length ? t.columns
                 : (t.rows[0] || []).map(function (_, i) { return "col" + (i + 1); }),
                 rows: t.rows, sql: t.sql, pkColumn: -1 };
      }),
      extras: extras
    }, name);
  }
  function fromCsv(text, name) {
    var rows = [];
    var row = [], cur = "", inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') inQ = false;
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") {
        if (cur !== "" || row.length) { row.push(cur); rows.push(row); row = []; cur = ""; }
        if (c === "\r" && text[i + 1] === "\n") i++;
      } else cur += c;
    }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    if (rows.length < 1) { note("⚠ empty CSV"); return; }
    var columns = rows[0].map(String);
    var data = rows.slice(1).map(function (r2) {
      return columns.map(function (_, ci) {
        var v = r2[ci];
        if (v === undefined || v === "") return null;
        if (/^-?\d+$/.test(v)) return parseInt(v, 10);
        if (/^-?\d*\.\d+$/.test(v)) return parseFloat(v);
        return v;
      });
    });
    boot({ tables: [{ name: name.replace(/\.csv$/i, "").replace(/\W+/g, "_") || "sheet",
                      columns: columns, rows: data, sql: null, pkColumn: -1 }], extras: [] }, name);
  }
  function newBlank() {
    boot({ tables: [{ name: "table1", columns: ["id", "name"], rows: [[1, ""]], sql: null, pkColumn: 0 }],
           extras: [] }, "new database");
  }

  function boot(m, sourceName) {
    model = m;
    active = 0;
    undoStack = []; redoStack = [];
    $("board").hidden = false;
    $("intake").hidden = true;
    $("sourcename").textContent = sourceName;
    renderTabs();
    renderGrid();
    var extraNote = model.extras.length
      ? " · " + model.extras.length + " non-table items set aside (see export panel)"
      : "";
    note("loaded into the working model — the original file is untouched and will stay that way" + extraNote);
    autosave();
  }

  // ---------- undo/redo (snapshot the active table) ----------
  function checkpoint() {
    var t = model.tables[active];
    undoStack.push({ active: active, table: JSON.parse(JSON.stringify({
      name: t.name, columns: t.columns,
      rows: t.rows.map(function (r) { return r.map(function (v) { return v instanceof Uint8Array ? { __blob: Array.from(v) } : v; }); })
    })) });
    if (undoStack.length > UNDO_CAP) undoStack.shift();
    redoStack = [];
    updateUndoButtons();
  }
  function reviveRows(rows) {
    return rows.map(function (r) {
      return r.map(function (v) { return (v && v.__blob) ? new Uint8Array(v.__blob) : v; });
    });
  }
  function swapState(fromStack, toStack) {
    if (!fromStack.length) return;
    var snap = fromStack.pop();
    var t = model.tables[snap.active];
    toStack.push({ active: snap.active, table: JSON.parse(JSON.stringify({
      name: t.name, columns: t.columns,
      rows: t.rows.map(function (r) { return r.map(function (v) { return v instanceof Uint8Array ? { __blob: Array.from(v) } : v; }); })
    })) });
    t.name = snap.table.name;
    t.columns = snap.table.columns;
    t.rows = reviveRows(snap.table.rows);
    active = snap.active;
    renderTabs(); renderGrid();
    updateUndoButtons();
    autosave();
  }
  $("undo").addEventListener("click", function () { swapState(undoStack, redoStack); });
  $("redo").addEventListener("click", function () { swapState(redoStack, undoStack); });
  function updateUndoButtons() {
    $("undo").disabled = !undoStack.length;
    $("redo").disabled = !redoStack.length;
  }

  // ---------- tabs ----------
  function renderTabs() {
    var bar = $("tabs");
    bar.innerHTML = "";
    model.tables.forEach(function (t, i) {
      var b = document.createElement("button");
      b.className = "tab" + (i === active ? " on" : "");
      b.textContent = t.name + " (" + t.rows.length + ")";
      b.addEventListener("click", function () { active = i; renderTabs(); renderGrid(); });
      bar.appendChild(b);
    });
    var plus = document.createElement("button");
    plus.className = "tab plus";
    plus.textContent = "+ table";
    plus.addEventListener("click", function () {
      var name = prompt("new table name:", "table" + (model.tables.length + 1));
      if (!name) return;
      model.tables.push({ name: name.replace(/\W+/g, "_"), columns: ["id"], rows: [], sql: null, pkColumn: 0 });
      active = model.tables.length - 1;
      renderTabs(); renderGrid(); autosave();
    });
    bar.appendChild(plus);
    renderSchema();
  }

  // ---------- schema panel (the sidebar drawing) ----------
  // Reads the model the way the writer will: tables, their columns, the type
  // each column will store, and live row counts. It only offers edits the
  // writer regenerates cleanly — rename table, add/rename/drop column.
  var TYPE_RX = /^\s*[`"\[]?([A-Za-z_][\w ]*?)[`"\]]?\s+(INTEGER|INT|REAL|FLOAT|DOUBLE|DOUBLE PRECISION|TEXT|VARCHAR|NVARCHAR|CHAR|CLOB|NUMERIC|DECIMAL|BOOLEAN|BLOB|DATE|DATETIME|TIMESTAMP)\b/i;
  function declaredType(sql, col) {
    if (!sql) return null;
    var open = sql.indexOf("(");
    if (open < 0) return null;
    var body = sql.slice(open + 1);
    var parts = body.split(",");
    for (var i = 0; i < parts.length; i++) {
      var m = parts[i].match(TYPE_RX);
      if (m && m[1].trim().toLowerCase() === String(col).toLowerCase()) return m[2].toUpperCase();
    }
    return null;
  }
  function columnType(t, ci) {
    var dt = declaredType(t.sql, t.columns[ci]);
    if (dt) return { label: dt, sourced: "declared in the source DDL" };
    // no declared type — read the affinity from the data the way the writer stores it
    var vals = [];
    for (var r = 0; r < t.rows.length && vals.length < 400; r++) vals.push(t.rows[r][ci]);
    return { label: CSVWIZ.guessType(vals), sourced: "affinity read from the current values" };
  }
  function renderSchema() {
    var host = $("schema");
    if (!host || !model) return;
    var html = "<div class='schemahd'><span>SCHEMA</span>" +
      "<button class='draftbtn small' id='schema-csv'>+ CSV</button></div>";
    model.tables.forEach(function (t, ti) {
      html += "<div class='sto" + (ti === active ? " on" : "") + "'>";
      html += "<div class='stname'><button class='stpick' data-t='" + ti + "'>" +
        esc(t.name) + "</button><span class='strows'>" + t.rows.length + " row" +
        (t.rows.length === 1 ? "" : "s") + "</span></div>";
      html += "<ul class='stcols'>";
      t.columns.forEach(function (c, ci) {
        var ty = columnType(t, ci);
        html += "<li title='" + esc(ty.sourced) + "'><span class='scn'>" + esc(c) +
          (ci === t.pkColumn ? " <span class='spk'>PK</span>" : "") +
          "</span><span class='sct'>" + ty.label + "</span></li>";
      });
      html += "</ul>";
      html += "<div class='stbtns'><button class='draftbtn small' data-addc='" + ti +
        "'>+ column</button><button class='draftbtn small' data-rent='" + ti + "'>rename</button></div>";
      html += "</div>";
    });
    html += "<p class='schemanote'>Only edits the writer can regenerate cleanly are offered here — " +
      "this table models values, not constraints. Types are declared where the source DDL kept them, " +
      "otherwise read from the data. Indexes, foreign keys and CHECK constraints ride aside in the recreate script.</p>";
    host.innerHTML = html;
    var csvb = $("schema-csv");
    if (csvb) csvb.addEventListener("click", openWizard);
    host.querySelectorAll(".stpick").forEach(function (b) {
      b.addEventListener("click", function () { active = Number(b.dataset.t); renderTabs(); renderGrid(); });
    });
    host.querySelectorAll("[data-addc]").forEach(function (b) {
      b.addEventListener("click", function () {
        active = Number(b.dataset.addc); renderTabs(); renderGrid(); doAddColumn();
      });
    });
    host.querySelectorAll("[data-rent]").forEach(function (b) {
      b.addEventListener("click", function () {
        active = Number(b.dataset.rent); renderTabs(); renderGrid(); doRenameTable();
      });
    });
  }

  // ---------- the grid ----------
  var SHOW_CAP = 500;
  function renderGrid() {
    var t = model.tables[active];
    var head = "<tr><th class='rowno'></th>";
    t.columns.forEach(function (c, ci) {
      head += "<th><span class='colname' data-c='" + ci + "'>" + esc(c) + "</span>" +
        "<button class='colx' data-delc='" + ci + "' title='delete column'>×</button></th>";
    });
    head += "<th><button class='addcol' id='addcol'>+ col</button></th></tr>";
    $("gridhead").innerHTML = head;
    var body = "";
    var n = Math.min(t.rows.length, SHOW_CAP);
    for (var r = 0; r < n; r++) {
      body += "<tr><td class='rowno'>" + (r + 1) +
        "<button class='rowx' data-delr='" + r + "' title='delete row'>×</button></td>";
      for (var c = 0; c < t.columns.length; c++) {
        var v = t.rows[r][c];
        var disp = v === null || v === undefined ? "<i class='nul'>∅</i>"
          : v instanceof Uint8Array ? "<i class='blob'>BLOB " + v.length + "B</i>"
          : esc(String(v).length > 120 ? String(v).slice(0, 120) + "…" : String(v));
        body += "<td class='cell' data-r='" + r + "' data-c='" + c + "'>" + disp + "</td>";
      }
      body += "<td></td></tr>";
    }
    $("gridbody").innerHTML = body;
    $("gridfacts").textContent = t.rows.length + " rows · " + t.columns.length + " columns" +
      (t.rows.length > SHOW_CAP ? " · showing first " + SHOW_CAP + " (edits & exports cover all)" : "");
    wireGrid();
  }

  function wireGrid() {
    var t = model.tables[active];
    document.querySelectorAll(".cell").forEach(function (td) {
      td.addEventListener("dblclick", function () { editCell(td); });
    });
    document.querySelectorAll("[data-delr]").forEach(function (b) {
      b.addEventListener("click", function () {
        checkpoint();
        t.rows.splice(Number(b.dataset.delr), 1);
        renderTabs(); renderGrid(); autosave();
      });
    });
    document.querySelectorAll("[data-delc]").forEach(function (b) {
      b.addEventListener("click", function () {
        if (t.columns.length <= 1) { note("a table keeps at least one column"); return; }
        if (!confirm("delete column “" + t.columns[Number(b.dataset.delc)] + "” and its data?")) return;
        checkpoint();
        var ci = Number(b.dataset.delc);
        t.columns.splice(ci, 1);
        t.rows.forEach(function (r) { r.splice(ci, 1); });
        if (t.pkColumn === ci) t.pkColumn = -1;
        renderGrid(); autosave();
      });
    });
    document.querySelectorAll(".colname").forEach(function (sp) {
      sp.addEventListener("dblclick", function () {
        var ci = Number(sp.dataset.c);
        var name = prompt("rename column:", t.columns[ci]);
        if (!name) return;
        checkpoint();
        t.columns[ci] = name.replace(/\W+/g, "_");
        t.sql = null;                 // schema changed; original DDL no longer speaks for it
        renderGrid(); autosave();
      });
    });
    var ac = $("addcol");
    if (ac) ac.addEventListener("click", doAddColumn);
  }

  // add-column and rename-table are the two schema edits the writer can
  // regenerate cleanly; the schema panel drives these same paths. Both act
  // on the active table so the per-table undo snapshot stays honest.
  function doAddColumn() {
    var t = model.tables[active];
    var name = prompt("new column name:", "col" + (t.columns.length + 1));
    if (!name) return;
    checkpoint();
    t.columns.push(name.replace(/\W+/g, "_"));
    t.rows.forEach(function (r) { r.push(null); });
    t.sql = null;
    renderGrid(); renderSchema(); autosave();
  }
  function doRenameTable() {
    var t = model.tables[active];
    var name = prompt("rename table:", t.name);
    if (!name) return;
    checkpoint();
    t.name = name.replace(/\W+/g, "_");
    t.sql = null;
    renderTabs(); autosave();
  }

  function editCell(td) {
    var t = model.tables[active];
    var r = Number(td.dataset.r), c = Number(td.dataset.c);
    var v = t.rows[r][c];
    if (v instanceof Uint8Array) { note("blobs ride along untouched — edit them in a hex tool"); return; }
    var input = document.createElement("input");
    input.className = "celledit";
    input.value = v === null || v === undefined ? "" : String(v);
    td.innerHTML = "";
    td.appendChild(input);
    input.focus();
    input.select();
    var done = false;
    function commit(save) {
      if (done) return;
      done = true;
      if (save) {
        var raw = input.value;
        var nv;
        if (raw === "" || raw.toUpperCase() === "NULL") nv = null;
        else if (/^-?\d+$/.test(raw)) nv = parseInt(raw, 10);
        else if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(raw)) nv = parseFloat(raw);
        else nv = raw;
        if (nv !== v) {
          checkpoint();
          t.rows[r][c] = nv;
          autosave();
        }
      }
      renderGrid();
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    });
    input.addEventListener("blur", function () { commit(true); });
  }

  $("addrow").addEventListener("click", function () {
    var t = model.tables[active];
    checkpoint();
    var row = t.columns.map(function () { return null; });
    if (t.pkColumn >= 0) {
      var mx = 0;
      t.rows.forEach(function (r) { if (typeof r[t.pkColumn] === "number") mx = Math.max(mx, r[t.pkColumn]); });
      row[t.pkColumn] = mx + 1;
    }
    t.rows.push(row);
    renderTabs(); renderGrid(); autosave();
    note("row added at the end — double-click cells to fill it");
  });
  $("renametable").addEventListener("click", doRenameTable);
  $("droptable").addEventListener("click", function () {
    if (model.tables.length <= 1) { note("the model keeps at least one table"); return; }
    if (!confirm("drop table “" + model.tables[active].name + "” entirely?")) return;
    model.tables.splice(active, 1);
    active = 0;
    undoStack = []; redoStack = [];      // cross-table snapshots would lie; honest reset
    updateUndoButtons();
    renderTabs(); renderGrid(); autosave();
  });

  // ---------- SQL console ----------
  // Two engines, one console. The four editing verbs run on the hand-written
  // sqlmini — instant, offline, and they mutate the model so undo and export
  // work. Reads that need more than a footpath — joins, grouping, aggregates,
  // subqueries — route to the analysis engine (sql.js, summoned lazily and used
  // only to read). If sqlmini can't even parse a read, we fall through to it too.
  $("runsql").addEventListener("click", runSql);
  $("sqlin").addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) runSql();
  });
  var hasAnalysis = typeof ANALYSIS !== "undefined";
  function setEngine(state) {
    var chip = $("engchip");
    if (!chip) {
      var host = $("runsql") && $("runsql").parentNode;
      if (!host) return;
      chip = document.createElement("span");
      chip.id = "engchip";
      chip.className = "engchip";
      host.appendChild(chip);
    }
    if (state === "builtin") { chip.textContent = "engine: built-in"; chip.className = "engchip"; }
    else if (state === "loading") { chip.textContent = "engine: summoning SQLite…"; chip.className = "engchip on"; }
    else if (state === "sqlite") { chip.textContent = "engine: SQLite · read-only"; chip.className = "engchip on"; }
  }
  function cellHtml(v) {
    if (v === null || v === undefined) return "<i class='nul'>∅</i>";
    if (v instanceof Uint8Array) return "<i class='blob'>BLOB " + v.length + "B</i>";
    return esc(String(v));
  }
  var lastResult = null;      // {columns, rows} of the most recent SELECT — for "save as table"
  function showSelect(res, viaEngine) {
    var out = "<tr>" + res.columns.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr>";
    res.rows.slice(0, 200).forEach(function (r) {
      out += "<tr>" + r.map(function (v) { return "<td>" + cellHtml(v) + "</td>"; }).join("") + "</tr>";
    });
    $("sqlout").innerHTML = out;
    lastResult = { columns: res.columns.slice(), rows: res.rows };
    $("sqloutcap").textContent = res.rows.length + " row" + (res.rows.length === 1 ? "" : "s") +
      (res.rows.length > 200 ? " · first 200 shown, all saved" : "");
    $("sqloutwrap").hidden = false;
    note(res.rows.length + " row" + (res.rows.length === 1 ? "" : "s") +
      (res.rows.length > 200 ? " (first 200 shown)" : "") +
      (viaEngine ? " · read-only analysis — save it as a table to keep or edit it" : ""));
  }
  function clearResult() { lastResult = null; $("sqloutwrap").hidden = true; }
  // Materialize the last SELECT into the model — the analysis→edit→export bridge.
  // Run a join, save it, and the result becomes a real table: editable in the
  // grid and rebuilt by the certified writer like any other.
  $("saveresult").addEventListener("click", function () {
    if (!lastResult || !lastResult.columns.length) { note("run a query first — then its result can become a table"); return; }
    var name = prompt("name the new table:", "result_" + ((model ? model.tables.length : 0) + 1));
    if (!name) return;
    name = name.replace(/\W+/g, "_").replace(/^_+|_+$/g, "") || "result";
    var columns = wizHeaders(lastResult.columns);        // sanitize & de-duplicate headers
    var rows = lastResult.rows.map(function (r) { return columns.map(function (_, i) { return r[i] === undefined ? null : r[i]; }); });
    addTable({ name: name, columns: columns, rows: rows, sql: null, pkColumn: -1 });
  });
  // Download the query result straight to CSV — same quoting the table export uses.
  $("resultcsv").addEventListener("click", function () {
    if (!lastResult || !lastResult.columns.length) { note("run a query first — then its result can be saved as CSV"); return; }
    function ce(v) {
      if (v === null || v === undefined) return "";
      if (v instanceof Uint8Array) return "[BLOB]";
      var s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = [lastResult.columns.map(ce).join(",")];
    lastResult.rows.forEach(function (r) { lines.push(r.map(ce).join(",")); });
    dl(new Blob([lines.join("\n")], { type: "text/csv" }), "editsqlite-result.csv");
    note("query result exported — " + lastResult.rows.length + " row" + (lastResult.rows.length === 1 ? "" : "s") + " to CSV");
  });
  function runAnalysis(sql) {
    setEngine("loading");
    note("summoning the SQLite analysis engine…");
    ANALYSIS.query(model, modelRev, sql).then(function (res) {
      setEngine("sqlite");
      showSelect(res, true);
    }).catch(function (err) {
      setEngine("builtin");
      note("SQL: " + err.message);
    });
  }
  function runSql() {
    var sql = $("sqlin").value.trim();
    if (!sql) return;
    var isMutation = /^\s*(UPDATE|DELETE|INSERT)/i.test(sql);

    // Analytical reads go straight to the full engine.
    if (!isMutation && hasAnalysis && ANALYSIS.needsFullEngine(sql)) return runAnalysis(sql);

    var handles = {};
    model.tables.forEach(function (t) { handles[t.name] = t; });
    try {
      if (isMutation) checkpoint();
      var res = SQLMINI.run(sql, handles);
      setEngine("builtin");
      if (res.kind === "select") {
        showSelect(res, false);
      } else {
        clearResult();
        renderTabs(); renderGrid(); autosave();
        note(res.kind.toUpperCase() + ": " + res.changed + " row" + (res.changed === 1 ? "" : "s") +
          " in " + res.table + " — undo has your back");
      }
    } catch (err) {
      if (isMutation) { undoStack.pop(); updateUndoButtons(); note("SQL: " + err.message); return; }
      // A read sqlmini couldn't parse — hand it to the analysis engine. A genuine
      // error (no such table/column) is tagged runtime and surfaces as-is.
      if (hasAnalysis && !err.runtime) return runAnalysis(sql);
      updateUndoButtons();
      note("SQL: " + err.message);
    }
  }

  // ---------- plain-English → SQL (built-in, fully local) ----------
  // No model, no key, no network. smartquery.js reads the question and the live
  // model (names, types AND rows — it can resolve a value like "London" against
  // the data because everything stays in the tab) and writes a SQLite query into
  // the console for you to review and run. It proposes; you approve.
  var hasSmart = typeof SMARTQUERY !== "undefined";
  function askLocal() {
    if (!hasSmart || !model) return;
    var q = $("aiq").value.trim();
    if (!q) { note("type a question — e.g. “count by role”, “top 5 by salary”, “rows in London”"); return; }
    var tables = model.tables.map(function (t) {
      return { name: t.name, columns: t.columns, rows: t.rows,
               types: t.columns.map(function (c, ci) { return columnType(t, ci).label; }) };
    });
    var res = SMARTQUERY.toSQL(q, tables, model.tables[active].name);
    if (res.error) { note("couldn't read that — " + res.error); return; }
    $("sqlin").value = res.sql;
    note("wrote SQL from your question (" + res.note + ") — review it, then Run.");
  }
  if (hasSmart) {
    $("aigen").addEventListener("click", askLocal);
    $("aiq").addEventListener("keydown", function (e) { if (e.key === "Enter") askLocal(); });
  } else {
    var airow = document.querySelector(".airow");
    if (airow) airow.style.display = "none";
  }

  // ---------- exports ----------
  function dl(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  $("exp-sqlite").addEventListener("click", function () {
    try {
      var bytes = SQLWRITE.build(model.tables.map(function (t) {
        return { name: t.name, columns: t.columns, rows: t.rows, sql: t.sql || undefined,
                 pkColumn: t.pkColumn >= 0 ? t.pkColumn : undefined };
      }));
      dl(new Blob([bytes], { type: "application/x-sqlite3" }), "editsqlite.sqlite");
      var extras = model.extras.filter(function (e) { return e.sql; });
      note("a fresh .sqlite, built page by page by our writer — certified format" +
        (extras.length ? " · " + extras.length + " indexes/views not included (download their recreate script)" : ""));
    } catch (err) {
      note("export: " + err.message);
    }
  });
  $("exp-sql").addEventListener("click", function () {
    var dialect = $("dialect").value;
    var qc = dialect === "mysql" ? "`" : '"';
    var lines = [];
    model.tables.forEach(function (t) {
      lines.push((t.sql && dialect === "sqlite") ? t.sql + ";" :
        "CREATE TABLE " + qc + t.name + qc + " (" +
        t.columns.map(function (c) { return qc + c + qc; }).join(", ") + ");");
      t.rows.forEach(function (r) {
        lines.push("INSERT INTO " + qc + t.name + qc + " VALUES (" + r.map(function (v) {
          if (v === null || v === undefined) return "NULL";
          if (typeof v === "number") return String(v);
          if (v instanceof Uint8Array) {
            var hex = "";
            v.forEach(function (b) { hex += (b < 16 ? "0" : "") + b.toString(16); });
            return dialect === "postgres" ? "'\\x" + hex + "'" : "X'" + hex + "'";
          }
          var s = String(v).replace(/'/g, "''");
          if (dialect === "mysql") s = s.replace(/\\/g, "\\\\");
          return "'" + s + "'";
        }).join(",") + ");");
      });
    });
    dl(new Blob([lines.join("\n")], { type: "text/plain" }), "editsqlite-" + dialect + ".sql");
    note("dump written in " + dialect + " dialect — " + lines.length + " statements.");
  });
  $("exp-csv").addEventListener("click", function () {
    var t = model.tables[active];
    function ce(v) {
      if (v === null || v === undefined) return "";
      if (v instanceof Uint8Array) return "[BLOB]";
      var s = String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = [t.columns.map(ce).join(",")];
    t.rows.forEach(function (r) { lines.push(r.map(ce).join(",")); });
    dl(new Blob([lines.join("\n")], { type: "text/csv" }), t.name + ".csv");
  });
  $("exp-extras").addEventListener("click", function () {
    var extras = model.extras.filter(function (e) { return e.sql; });
    if (!extras.length) { note("nothing set aside — this model had no indexes or views"); return; }
    dl(new Blob([extras.map(function (e) { return e.sql + ";"; }).join("\n")], { type: "text/plain" }),
      "recreate-indexes-views.sql");
  });

  // ---------- session persistence (flush pattern) ----------
  var saveTimer = null;
  function autosave() {
    modelRev++;                       // the model changed — the analysis engine must rebuild on next read
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushNow, 800);
  }
  function flushNow() {
    clearTimeout(saveTimer);
    if (!model) return;
    try {
      var slim = JSON.stringify({
        tables: model.tables.map(function (t) {
          return { name: t.name, columns: t.columns, pkColumn: t.pkColumn, sql: t.sql,
                   rows: t.rows.map(function (r) { return r.map(function (v) { return v instanceof Uint8Array ? { __blob: Array.from(v) } : v; }); }) };
        }),
        extras: model.extras
      });
      if (slim.length < 2500000) localStorage.setItem("editsqlite-session", slim);
    } catch (e) {}
  }
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") flushNow();
  });

  // ---------- CSV import wizard ----------
  // The machinery lives in csvwiz.js — a quote-correct parser, a per-column
  // type survey, affinity-honest coercion and a typed CREATE. This is only the
  // bench UI around it; the table it makes goes through the same model as any
  // other, so grid, console and the certified writer treat it identically.
  var wizRows = null;
  function openWizard() {
    $("wizmodal").hidden = false;
    $("wizmap").hidden = true;
    $("wizpaste").value = "";
    $("wizmsg").textContent = "";
    wizRows = null;
  }
  function closeWizard() { $("wizmodal").hidden = true; wizRows = null; }
  function wizHeaders(row) {
    var seen = {};
    return row.map(function (h, i) {
      var name = String(h).trim().replace(/\W+/g, "_").replace(/^_+|_+$/g, "") || ("col" + (i + 1));
      var base = name;
      while (seen[name]) name = base + "_" + (Object.keys(seen).length + 1);
      seen[name] = true;
      return name;
    });
  }
  function wizSurvey(text) {
    var rows = CSVWIZ.parse(text);
    if (!rows.length || !rows[0].length) { $("wizmsg").textContent = "no rows found — paste some CSV or pick a file first"; return; }
    wizRows = rows;
    var headers = wizHeaders(rows[0]);
    var data = rows.slice(1);
    var host = $("wizcols");
    host.innerHTML = "";
    headers.forEach(function (h, ci) {
      var col = data.map(function (r) { return r[ci]; });
      var guess = CSVWIZ.guessType(col);
      var wrap = document.createElement("div");
      wrap.className = "wizcol";
      var nm = document.createElement("span");
      nm.className = "wcn"; nm.textContent = h;
      var sel = document.createElement("select");
      ["INTEGER", "REAL", "TEXT"].forEach(function (ty) {
        var o = document.createElement("option");
        o.value = ty; o.textContent = ty.toLowerCase();
        if (ty === guess) o.selected = true;
        sel.appendChild(o);
      });
      sel.dataset.h = h;
      var gs = document.createElement("span");
      gs.className = "wcg"; gs.textContent = "auto: " + guess.toLowerCase();
      wrap.appendChild(nm); wrap.appendChild(sel); wrap.appendChild(gs);
      host.appendChild(wrap);
    });
    var prev = "<table><tr>" + headers.map(function (h) { return "<th>" + esc(h) + "</th>"; }).join("") + "</tr>";
    data.slice(0, 6).forEach(function (r) {
      prev += "<tr>" + headers.map(function (_, ci) {
        var v = r[ci];
        return "<td>" + (v === undefined || v === "" ? "<i class='nul'>∅</i>" : esc(String(v))) + "</td>";
      }).join("") + "</tr>";
    });
    prev += "</table>";
    $("wizprev").innerHTML = prev;
    $("wiztname").value = "imported_" + ((model ? model.tables.length : 0) + 1);
    $("wizmap").hidden = false;
    $("wizmsg").textContent = data.length + " data row" + (data.length === 1 ? "" : "s") +
      " · " + headers.length + " columns surveyed — set types, then create";
  }
  function wizCreate() {
    if (!wizRows) return;
    var name = ($("wiztname").value || "imported").replace(/\W+/g, "_").replace(/^_+|_+$/g, "") || "imported";
    var sels = $("wizcols").querySelectorAll("select");
    var columns = [], types = [];
    sels.forEach(function (s) { columns.push(s.dataset.h); types.push(s.value); });
    var data = wizRows.slice(1);
    var rows = data.map(function (r) {
      return columns.map(function (_, ci) { return CSVWIZ.coerce(r[ci], types[ci]); });
    });
    addTable({ name: name, columns: columns, rows: rows, sql: CSVWIZ.ddl(name, columns, types), pkColumn: -1 });
    closeWizard();
  }
  function addTable(t) {
    if (!model) { boot({ tables: [t], extras: [] }, "imported CSV"); }
    else {
      model.tables.push(t);
      active = model.tables.length - 1;
      renderTabs(); renderGrid(); autosave();
    }
    note("table “" + t.name + "” created from CSV — " + t.rows.length + " row" +
      (t.rows.length === 1 ? "" : "s") + ", each column typed as you set it");
  }

  // ---------- saved queries (device-local shelf) ----------
  var shelf = null;
  try { if (typeof SHELF !== "undefined" && "indexedDB" in window) shelf = SHELF.open("editsqlite"); } catch (e) {}
  function fmtWhen(ts) {
    if (!ts) return "not run yet";
    var diff = Date.now() - ts;
    if (diff < 60000) return "ran just now";
    if (diff < 3600000) return "ran " + Math.round(diff / 60000) + "m ago";
    if (diff < 86400000) return "ran " + Math.round(diff / 3600000) + "h ago";
    return "ran " + new Date(ts).toLocaleDateString();
  }
  function renderSaved() {
    if (!shelf) return;
    shelf.list("query").then(function (items) {
      var host = $("savedq");
      host.innerHTML = "";
      $("savedqwrap").hidden = !items.length;
      items.forEach(function (it) {
        var row = document.createElement("div");
        row.className = "sq";
        var run = document.createElement("button");
        run.className = "draftbtn small"; run.textContent = "▷ run";
        var nm = document.createElement("span");
        nm.className = "sqn"; nm.textContent = it.name; nm.title = it.data;
        var tm = document.createElement("span");
        tm.className = "sqt"; tm.textContent = fmtWhen(it.meta && it.meta.lastRun);
        var del = document.createElement("button");
        del.className = "rowx"; del.textContent = "×"; del.title = "forget this query";
        run.addEventListener("click", function () {
          $("sqlin").value = it.data;
          runSql();
          it.meta = it.meta || {}; it.meta.lastRun = Date.now();
          shelf.put(it).then(renderSaved);
        });
        del.addEventListener("click", function () { shelf.remove(it.id).then(renderSaved); });
        row.appendChild(run); row.appendChild(nm); row.appendChild(tm); row.appendChild(del);
        host.appendChild(row);
      });
    });
  }
  function saveQuery() {
    if (!shelf) { note("saved queries need IndexedDB, which this browser has blocked"); return; }
    var sql = $("sqlin").value.trim();
    if (!sql) { note("the console is empty — nothing to save"); return; }
    var name = prompt("name this query:", sql.slice(0, 32).replace(/\s+/g, " "));
    if (!name) return;
    shelf.put({ kind: "query", name: name, data: sql, meta: { lastRun: null } }).then(function () {
      note("saved “" + name + "” to your shelf — one tap re-runs it, timestamp and all");
      renderSaved();
    });
  }

  // ---------- boot ----------
  $("csvwiz").addEventListener("click", openWizard);
  $("wizclose").addEventListener("click", closeWizard);
  $("wizpick").addEventListener("click", function () { $("wizfile").click(); });
  $("wizfile").addEventListener("change", function () {
    if (!this.files.length) return;
    var r = new FileReader();
    r.onload = function () { $("wizpaste").value = r.result; wizSurvey(r.result); };
    r.readAsText(this.files[0]);
  });
  $("wizparse").addEventListener("click", function () { wizSurvey($("wizpaste").value); });
  $("wizcreate").addEventListener("click", wizCreate);
  $("savequery").addEventListener("click", saveQuery);
  renderSaved();
  $("pick").addEventListener("click", function () { $("filein").click(); });
  $("filein").addEventListener("change", function () { if (this.files.length) loadFile(this.files[0]); });
  $("blank").addEventListener("click", newBlank);
  var sampleBtn = $("trysample");
  if (sampleBtn) sampleBtn.addEventListener("click", function () {
    boot({ tables: [{
      name: "employees",
      columns: ["id", "name", "role", "city", "salary"],
      rows: [
        [1, "Ada Lovelace", "Engineer", "London", 95000],
        [2, "Grace Hopper", "Architect", "New York", 102000],
        [3, "Alan Turing", "Researcher", "Manchester", 99000],
        [4, "Katherine Johnson", "Scientist", "Hampton", 97000],
        [5, "Edsger Dijkstra", "Analyst", null, 88000]
      ],
      sql: "CREATE TABLE employees (id INTEGER PRIMARY KEY, name TEXT, role TEXT, city TEXT, salary INTEGER)",
      pkColumn: 0
    }], extras: [] }, "sample.sqlite");
  });
  document.addEventListener("dragover", function (e) { e.preventDefault(); });
  document.addEventListener("drop", function (e) {
    e.preventDefault();
    if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0]);
  });
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem("editsqlite-session")); } catch (e) {}
  if (saved && saved.tables && saved.tables.length) {
    $("resume").hidden = false;
    $("resume").addEventListener("click", function () {
      saved.tables.forEach(function (t) { t.rows = reviveRows(t.rows); });
      boot(saved, "last session (autosaved)");
    });
  }
  $("closefile").addEventListener("click", function () {
    flushNow();
    model = null;
    if (typeof ANALYSIS !== "undefined") ANALYSIS.reset();
    $("board").hidden = true;
    $("intake").hidden = false;
    note("");
  });

  // ---------- deep-link intake presets ----------
  // The /convert/ landing pages link here with ?from=csv|mysql|postgres|sql|sqlite.
  // CSV opens the import wizard directly (just a modal — no gesture needed);
  // file-based conversions can't auto-pop the OS picker without a gesture, so we
  // drop an honest hint into the intake pointing at the "Open a database" button.
  (function () {
    var from = new URLSearchParams(location.search).get("from");
    if (!from) return;
    if (from === "csv") { openWizard(); return; }
    var what = from === "mysql" ? "mysqldump .sql file"
      : from === "postgres" ? "pg_dump .sql file"
      : from === "sql" ? ".sql dump"
      : "SQLite database";
    var actions = document.querySelector("#intake .hero .actions");
    if (!actions) return;
    var hint = document.createElement("p");
    hint.className = "dlhint";
    hint.textContent = "Converting a " + what + "? Click “Open a database” above — it's read in this tab and never uploaded.";
    actions.parentNode.insertBefore(hint, actions.nextSibling);
  })();
})();
