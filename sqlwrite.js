/* editlama sqlwrite.js — a SQLite database WRITER, from the format document, by hand.
   The mirror of reading: records encoded into the serial-type zoo, packed into
   leaf pages, stacked under interior pages when they overflow a page, schema
   assembled on page 1, header stamped. Output must satisfy the official engine —
   that's the certification, not our opinion. */
var SQLWRITE = (function () {
  "use strict";

  var PAGE = 4096;
  var te = new TextEncoder();

  // ---------- value encoding (record format, write side) ----------
  function encodeValue(v) {
    if (v === null || v === undefined) return { type: 0, bytes: new Uint8Array(0) };
    if (typeof v === "number") {
      if (Number.isInteger(v) && Math.abs(v) <= 0x7FFFFFFFFFFF) {   // 48-bit safe path
        if (v === 0) return { type: 8, bytes: new Uint8Array(0) };
        if (v === 1) return { type: 9, bytes: new Uint8Array(0) };
        var neg = v < 0;
        var sizes = [1, 2, 3, 4, 6, 8];
        var types = [1, 2, 3, 4, 5, 6];
        for (var i = 0; i < sizes.length; i++) {
          var bits = sizes[i] * 8;
          var min = -Math.pow(2, bits - 1), max = Math.pow(2, bits - 1) - 1;
          if (v >= min && v <= max) {
            var b = new Uint8Array(sizes[i]);
            var u = neg ? v + Math.pow(256, sizes[i]) : v;
            for (var j = sizes[i] - 1; j >= 0; j--) {
              b[j] = u % 256;
              u = Math.floor(u / 256);
            }
            return { type: types[i], bytes: b };
          }
        }
      }
      var f = new Uint8Array(8);
      new DataView(f.buffer).setFloat64(0, v);
      return { type: 7, bytes: f };
    }
    if (v instanceof Uint8Array) return { type: 12 + v.length * 2, bytes: v };
    var s = te.encode(String(v));
    return { type: 13 + s.length * 2, bytes: s };
  }

  function varintBytes(n) {
    if (n < 0x80) return [n];
    var out = [];
    var v = n;
    while (v > 0) {
      out.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    }
    for (var i = 0; i < out.length - 1; i++) out[i] |= 0x80;
    return out;
  }

  function encodeRecord(values) {
    var encoded = values.map(encodeValue);
    var typeBytes = [];
    encoded.forEach(function (e) { typeBytes = typeBytes.concat(varintBytes(e.type)); });
    // header size varint includes itself — iterate to fixpoint (1 pass suffices <128²)
    var hlen = typeBytes.length + 1;
    if (hlen >= 128) hlen = typeBytes.length + varintBytes(hlen).length;
    var head = varintBytes(hlen).concat(typeBytes);
    var total = head.length;
    encoded.forEach(function (e) { total += e.bytes.length; });
    var out = new Uint8Array(total);
    out.set(head, 0);
    var op = head.length;
    encoded.forEach(function (e) { out.set(e.bytes, op); op += e.bytes.length; });
    return out;
  }

  // ---------- page builders ----------
  // build leaf pages from [ {rowid, record} ] — returns pages + their first rowids
  function buildLeaves(rows, isPageOne) {
    var pages = [];
    var cur = null;
    function newLeaf() {
      cur = { cells: [], size: 8, first: null, last: null };
      pages.push(cur);
    }
    newLeaf();
    rows.forEach(function (r) {
      var rid = varintBytes(r.rowid);
      var pl = varintBytes(r.record.length);
      var cellSize = pl.length + rid.length + r.record.length;
      var maxLocal = PAGE - 35;
      if (r.record.length > maxLocal) {
        throw new Error("row too large for a page — overflow writing not implemented (honest limit: rows under ~4KB)");
      }
      // room check: header(8) + pointers(2/cell) + cells
      var need = cur.size + 2 + cellSize;
      var budget = PAGE - (pages.length === 1 && isPageOne ? 100 : 0);
      if (cur.cells.length > 0 && need > budget) newLeaf();
      cur.cells.push({ rowid: r.rowid, bytes: pl.concat(rid), payload: r.record });
      cur.size += 2 + cellSize;
      if (cur.first === null) cur.first = r.rowid;
      cur.last = r.rowid;
    });
    return pages;
  }

  function serializeLeaf(leaf, pageOneOffset) {
    var u8 = new Uint8Array(PAGE);
    var dv = new DataView(u8.buffer);
    var base = pageOneOffset || 0;
    u8[base] = 13;                                  // leaf table
    dv.setUint16(base + 3, leaf.cells.length);
    var contentStart = PAGE;
    var ptrs = [];
    // cells packed from the end downward
    for (var i = leaf.cells.length - 1; i >= 0; i--) {
      var c = leaf.cells[i];
      var total = c.bytes.length + c.payload.length;
      contentStart -= total;
      u8.set(c.bytes, contentStart);
      u8.set(c.payload, contentStart + c.bytes.length);
      ptrs[i] = contentStart;
    }
    dv.setUint16(base + 5, contentStart);
    for (var p = 0; p < ptrs.length; p++) {
      dv.setUint16(base + 8 + p * 2, ptrs[p]);
    }
    return u8;
  }

  function serializeInterior(children) {
    // children: [{page, maxRowid}] — last becomes rightmost pointer
    var u8 = new Uint8Array(PAGE);
    var dv = new DataView(u8.buffer);
    u8[0] = 5;                                      // interior table
    var cells = children.slice(0, -1);
    dv.setUint16(3, cells.length);
    dv.setUint32(8, children[children.length - 1].page);
    var contentStart = PAGE;
    var ptrs = [];
    for (var i = cells.length - 1; i >= 0; i--) {
      var key = varintBytes(cells[i].maxRowid);
      contentStart -= 4 + key.length;
      dv.setUint32(contentStart, cells[i].page);
      u8.set(key, contentStart + 4);
      ptrs[i] = contentStart;
    }
    dv.setUint16(5, contentStart);
    for (var p = 0; p < ptrs.length; p++) {
      dv.setUint16(12 + p * 2, ptrs[p]);
    }
    return u8;
  }

  // ---------- the database assembler ----------
  // tables: [{name, columns: [names], sql?: CREATE stmt, rows: [[v,...]], pkColumn?: index}]
  function build(tables) {
    var pages = [null];              // 1-indexed; page 1 reserved for schema
    var schemaRows = [];

    tables.forEach(function (t) {
      var sql = t.sql || ("CREATE TABLE \"" + t.name.replace(/"/g, '""') + "\" (" +
        t.columns.map(function (c) { return "\"" + String(c).replace(/"/g, '""') + "\""; }).join(", ") + ")");
      // rows → records with rowids; INTEGER PRIMARY KEY column stored as NULL
      var rows = t.rows.map(function (vals, i) {
        var rowid = i + 1;
        var record = vals.slice();
        if (t.pkColumn !== undefined && t.pkColumn !== null) {
          var pk = record[t.pkColumn];
          if (typeof pk === "number" && Number.isInteger(pk) && pk > 0) rowid = pk;
          record[t.pkColumn] = null;
        }
        return { rowid: rowid, record: encodeRecord(record) };
      });
      // rowids must ascend for a valid b-tree
      rows.sort(function (a, b) { return a.rowid - b.rowid; });
      for (var d = 1; d < rows.length; d++) {
        if (rows[d].rowid <= rows[d - 1].rowid) rows[d].rowid = rows[d - 1].rowid + 1;
      }

      // pages are 1-indexed on disk; the array is 0-indexed. addPage returns
      // the true page number — the off-by-one here once pointed a whole tree
      // one page west and the official engine noticed immediately.
      function addPage(p) { pages.push(p); return pages.length; }
      var rootpage;
      if (rows.length === 0) {
        var empty = { cells: [], size: 8, first: null, last: null };
        rootpage = addPage(serializeLeaf(empty, 0));
      } else {
        var leaves = buildLeaves(rows, false);
        if (leaves.length === 1) {
          rootpage = addPage(serializeLeaf(leaves[0], 0));
        } else {
          var kids = [];
          leaves.forEach(function (leaf) {
            kids.push({ page: addPage(serializeLeaf(leaf, 0)), maxRowid: leaf.last });
          });
          if (kids.length > 680) throw new Error("table too large for one interior level — honest limit ~1.5M small rows");
          rootpage = addPage(serializeInterior(kids));
        }
      }
      schemaRows.push(["table", t.name, t.name, rootpage, sql]);
    });

    // page 1: the schema table (sqlite_schema) — leaf with 100-byte header offset
    var schemaRecords = schemaRows.map(function (vals, i) {
      return { rowid: i + 1, record: encodeRecord(vals) };
    });
    var schemaLeaves = buildLeaves(schemaRecords, true);
    if (schemaLeaves.length > 1) throw new Error("schema too large for page 1 — honest limit ~40 tables");
    var pageOne = serializeLeaf(schemaLeaves[0], 100);
    pages[0] = pageOne;

    // header
    var dv1 = new DataView(pageOne.buffer);
    var magic = "SQLite format 3 ";
    for (var m = 0; m < 16; m++) pageOne[m] = magic.charCodeAt(m);
    dv1.setUint16(16, PAGE);
    pageOne[18] = 1; pageOne[19] = 1;               // legacy journal read/write versions
    pageOne[21] = 64; pageOne[22] = 32; pageOne[23] = 32;  // payload fractions (spec constants)
    dv1.setUint32(24, 1);                           // change counter
    dv1.setUint32(28, pages.length);                // page count
    dv1.setUint32(40, 1);                           // schema cookie
    dv1.setUint32(44, 4);                           // schema format 4
    dv1.setUint32(56, 1);                           // text encoding: UTF-8
    dv1.setUint32(92, 1);                           // version-valid-for
    dv1.setUint32(96, 3049000);                     // sqlite version number stamp

    var out = new Uint8Array(pages.length * PAGE);
    pages.forEach(function (p, i) { out.set(p, i * PAGE); });
    return out;
  }

  return { build: build, encodeRecord: encodeRecord };
})();
if (typeof module !== "undefined") module.exports = SQLWRITE;
