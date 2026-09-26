/* editsqlite sqlite.js — the SQLite file format, read by hand.
   No sql.js, no wasm: the 100-byte header, b-tree pages walked cell by cell,
   varints, the record serial-type zoo, and overflow chains followed to the end.
   Reference: the format document every backup tool secretly depends on. */
var SQLITE = (function () {
  "use strict";

  var td = new TextDecoder("utf-8");

  function open(u8) {
    var magic = "";
    for (var i = 0; i < 15; i++) magic += String.fromCharCode(u8[i]);
    if (magic !== "SQLite format 3") return { ok: false, reason: "not an SQLite database (bad magic string)" };
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var pageSize = dv.getUint16(16);
    if (pageSize === 1) pageSize = 65536;
    var reserved = u8[20];
    var encoding = dv.getUint32(56);
    if (encoding !== 1) return { ok: false, reason: "text encoding " + encoding + " (UTF-16) — honest limit: UTF-8 databases only for now" };
    var db = {
      ok: true,
      u8: u8, dv: dv,
      pageSize: pageSize,
      usable: pageSize - reserved,
      pageCount: dv.getUint32(28) || Math.floor(u8.length / pageSize)
    };
    db.schema = readSchema(db);
    return db;
  }

  // ---------- varints (big-endian 7-bit, 9th byte full) ----------
  function varint(u8, pos) {
    var v = 0;
    for (var i = 0; i < 8; i++) {
      var b = u8[pos + i];
      v = v * 128 + (b & 0x7f);
      if (!(b & 0x80)) return { v: v, n: i + 1 };
    }
    v = v * 256 + u8[pos + 8];
    return { v: v, n: 9 };
  }

  // ---------- record decoding (§ Record Format) ----------
  function readRecord(u8, dv, base, pos) {
    var h = varint(u8, pos);
    var htop = pos + h.v;
    var p = pos + h.n;
    var types = [];
    while (p < htop) {
      var t = varint(u8, p);
      types.push(t.v);
      p += t.n;
    }
    var vals = [];
    var dpos = htop;
    types.forEach(function (t) {
      if (t === 0) { vals.push(null); }
      else if (t >= 1 && t <= 6) {
        var lens = [0, 1, 2, 3, 4, 6, 8][t];
        var v = 0;
        var neg = u8[dpos] & 0x80;
        for (var i = 0; i < lens; i++) v = v * 256 + u8[dpos + i];
        if (neg) v -= Math.pow(256, lens);            // two's complement
        vals.push(v);
        dpos += lens;
      }
      else if (t === 7) { vals.push(dv.getFloat64(base + dpos)); dpos += 8; }
      else if (t === 8) vals.push(0);
      else if (t === 9) vals.push(1);
      else if (t >= 12 && t % 2 === 0) {
        var bl = (t - 12) / 2;
        vals.push({ blob: bl });                      // blobs shown as size stubs
        dpos += bl;
      }
      else if (t >= 13) {
        var sl = (t - 13) / 2;
        vals.push(td.decode(u8.subarray(dpos, dpos + sl)));
        dpos += sl;
      }
      else vals.push(null);
    });
    return vals;
  }

  // ---------- payload assembly with overflow chains ----------
  function payload(db, pageOff, cellPos, total, localMaxKind) {
    var usable = db.usable;
    var maxLocal = localMaxKind === "leaf"
      ? usable - 35
      : Math.floor((usable - 12) * 64 / 255) - 23;    // index pages
    if (total <= maxLocal) {
      return { bytes: db.u8.subarray(pageOff + cellPos, pageOff + cellPos + total), local: total, next: cellPos + total };
    }
    var minLocal = Math.floor((usable - 12) * 32 / 255) - 23;
    var local = minLocal + (total - minLocal) % (usable - 4);
    if (local > maxLocal) local = minLocal;
    var out = new Uint8Array(total);
    out.set(db.u8.subarray(pageOff + cellPos, pageOff + cellPos + local), 0);
    var op = local;
    var next = db.dv.getUint32(pageOff + cellPos + local);
    while (next && op < total) {
      var noff = (next - 1) * db.pageSize;
      var chunk = Math.min(db.usable - 4, total - op);
      out.set(db.u8.subarray(noff + 4, noff + 4 + chunk), op);
      op += chunk;
      next = db.dv.getUint32(noff);
    }
    return { bytes: out, local: local, next: cellPos + local + 4 };
  }

  // ---------- b-tree traversal ----------
  // walk a table b-tree rooted at `page`, calling cb(rowid, values) per row
  function walkTable(db, page, cb, limit) {
    var stack = [page];
    var count = 0;
    while (stack.length) {
      var pg = stack.pop();
      var off = (pg - 1) * db.pageSize;
      var hdrOff = pg === 1 ? off + 100 : off;
      var type = db.u8[hdrOff];
      var nCells = db.dv.getUint16(hdrOff + 3);
      if (type === 5) {                                // interior table
        for (var c = nCells - 1; c >= 0; c--) {
          var cp = db.dv.getUint16(hdrOff + 12 + c * 2);
          stack.push(db.dv.getUint32(off + cp));
        }
        stack.push(db.dv.getUint32(hdrOff + 8));       // rightmost — pushed last? order: we want left-to-right...
        // fix ordering: children pushed so leftmost pops last → reverse:
        // simpler: we pushed cells right-to-left then rightmost; correct in-order needs
        // cells left-to-right THEN rightmost, popped in reverse. Rebuild:
        var kids = [];
        for (var c2 = 0; c2 < nCells; c2++) {
          var cp2 = db.dv.getUint16(hdrOff + 12 + c2 * 2);
          kids.push(db.dv.getUint32(off + cp2));
        }
        kids.push(db.dv.getUint32(hdrOff + 8));
        // remove what we just wrongly pushed (nCells+1 entries) and push reversed
        stack.length -= nCells + 1;
        for (var k = kids.length - 1; k >= 0; k--) stack.push(kids[k]);
      } else if (type === 13) {                        // leaf table
        for (var c3 = 0; c3 < nCells; c3++) {
          var cp3 = db.dv.getUint16(hdrOff + 8 + c3 * 2);
          var pl = varint(db.u8, off + cp3);
          var rid = varint(db.u8, off + cp3 + pl.n);
          var pay = payload(db, off, cp3 + pl.n + rid.n, pl.v, "leaf");
          var vals = readRecord(pay.bytes, new DataView(pay.bytes.buffer, pay.bytes.byteOffset, pay.bytes.byteLength), 0, 0);
          cb(rid.v, vals);
          count++;
          if (limit && count >= limit) return count;
        }
      } else if (type === 2 || type === 10) {
        // WITHOUT ROWID tables live in index b-trees
        if (type === 2) {                              // interior index
          var kids2 = [];
          for (var c4 = 0; c4 < nCells; c4++) {
            var cp4 = db.dv.getUint16(hdrOff + 12 + c4 * 2);
            kids2.push(db.dv.getUint32(off + cp4));
            // note: interior index cells ALSO carry a key record — those keys are
            // real rows in WITHOUT ROWID tables; decode them too
            var pl4 = varint(db.u8, off + cp4 + 4);
            var pay4 = payload(db, off, cp4 + 4 + pl4.n, pl4.v, "index");
            var vals4 = readRecord(pay4.bytes, new DataView(pay4.bytes.buffer, pay4.bytes.byteOffset, pay4.bytes.byteLength), 0, 0);
            cb(null, vals4);
            count++;
            if (limit && count >= limit) return count;
          }
          kids2.push(db.dv.getUint32(hdrOff + 8));
          for (var k2 = kids2.length - 1; k2 >= 0; k2--) stack.push(kids2[k2]);
        } else {                                       // leaf index
          for (var c5 = 0; c5 < nCells; c5++) {
            var cp5 = db.dv.getUint16(hdrOff + 8 + c5 * 2);
            var pl5 = varint(db.u8, off + cp5);
            var pay5 = payload(db, off, cp5 + pl5.n, pl5.v, "index");
            var vals5 = readRecord(pay5.bytes, new DataView(pay5.bytes.buffer, pay5.bytes.byteOffset, pay5.bytes.byteLength), 0, 0);
            cb(null, vals5);
            count++;
            if (limit && count >= limit) return count;
          }
        }
      }
    }
    return count;
  }

  // ---------- schema ----------
  function readSchema(db) {
    var items = [];
    walkTable(db, 1, function (rowid, vals) {
      items.push({
        type: vals[0], name: vals[1], table: vals[2],
        rootpage: vals[3], sql: vals[4]
      });
    });
    items.forEach(function (it) {
      it.withoutRowid = /WITHOUT\s+ROWID/i.test(it.sql || "");
      it.columns = it.sql ? parseColumns(it.sql) : [];
    });
    return items;
  }

  // decent-effort CREATE TABLE column extraction (quotes + parens respected)
  function parseColumns(sql) {
    var m = sql.match(/\(([\s\S]*)\)/);
    if (!m) return [];
    var body = m[1];
    var cols = [];
    var depth = 0, cur = "", inQ = null;
    for (var i = 0; i < body.length; i++) {
      var ch = body[i];
      if (inQ) {
        if (ch === inQ) inQ = null;
        cur += ch;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === "`" || ch === "[") { inQ = ch === "[" ? "]" : ch; cur += ch; continue; }
      if (ch === "(") { depth++; cur += ch; continue; }
      if (ch === ")") { depth--; cur += ch; continue; }
      if (ch === "," && depth === 0) { cols.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    if (cur.trim()) cols.push(cur.trim());
    return cols
      .filter(function (c) { return !/^(PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i.test(c); })
      .map(function (c) {
        var name = c.match(/^("([^"]|"")+"|\[[^\]]+\]|`[^`]+`|'([^']|'')+'|\S+)/)[0];
        return name.replace(/^["'`\[]|["'`\]]$/g, "").replace(/""/g, '"');
      });
  }

  return { open: open, walkTable: walkTable };
})();
if (typeof module !== "undefined") module.exports = SQLITE;
