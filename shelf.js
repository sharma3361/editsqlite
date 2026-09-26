/* shelf.js — house shared module: the user's local library. IndexedDB-backed
   store for the things a tool makes or remembers (files, projects, sessions,
   streaks), so a visit becomes a return visit. Blobs welcome. No dependencies,
   promise-based, quota-honest. */
var SHELF = (function () {
  "use strict";

  function open(dbName) {
    var dbp = new Promise(function (resolve, reject) {
      if (!("indexedDB" in window)) { reject(new Error("no IndexedDB")); return; }
      var rq = indexedDB.open(dbName, 1);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        var st = db.createObjectStore("items", { keyPath: "id", autoIncrement: true });
        st.createIndex("kind", "kind");
        st.createIndex("when", "when");
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });

    function tx(mode, fn) {
      return dbp.then(function (db) {
        return new Promise(function (resolve, reject) {
          var t = db.transaction("items", mode);
          var st = t.objectStore("items");
          var out = fn(st);
          t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
          t.onerror = function () { reject(t.error); };
          t.onabort = function () { reject(t.error || new Error("aborted (storage full?)")); };
        });
      });
    }

    return {
      /* put({kind, name, data?, blob?, meta?}) -> id. Overwrite by passing id. */
      put: function (item) {
        item.when = item.when || Date.now();
        return tx("readwrite", function (st) { return st.put(item); });
      },
      get: function (id) {
        return tx("readonly", function (st) { return st.get(id); });
      },
      /* list(kind?, limit?) -> newest first */
      list: function (kind, limit) {
        return dbp.then(function (db) {
          return new Promise(function (resolve, reject) {
            var out = [];
            var st = db.transaction("items", "readonly").objectStore("items");
            var src = kind ? st.index("kind").openCursor(IDBKeyRange.only(kind)) : st.openCursor();
            src.onsuccess = function () {
              var cur = src.result;
              if (cur) { out.push(cur.value); cur.continue(); }
              else {
                out.sort(function (a, b) { return b.when - a.when; });
                resolve(limit ? out.slice(0, limit) : out);
              }
            };
            src.onerror = function () { reject(src.error); };
          });
        });
      },
      remove: function (id) {
        return tx("readwrite", function (st) { return st.delete(id); });
      },
      clear: function (kind) {
        if (!kind) return tx("readwrite", function (st) { return st.clear(); });
        return this.list(kind).then(function (items) {
          return tx("readwrite", function (st) {
            items.forEach(function (i) { st.delete(i.id); });
          });
        });
      },
      /* storage estimate for honest "your shelf uses X MB" copy */
      usage: function () {
        if (navigator.storage && navigator.storage.estimate) {
          return navigator.storage.estimate().then(function (e) {
            return { used: e.usage || 0, quota: e.quota || 0 };
          });
        }
        return Promise.resolve({ used: 0, quota: 0 });
      }
    };
  }

  return { open: open };
})();
if (typeof module !== "undefined") module.exports = SHELF;
