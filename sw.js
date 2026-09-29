/* editsqlite service worker — the editor keeps working offline once loaded. */
var VERSION = "el-v10";
// sql-wasm.js / sql-wasm.wasm are deliberately NOT precached — they're the
// analysis engine, fetched lazily on the first join/GROUP BY query and then
// runtime-cached by the fetch handler below, so they cost nothing until used.
var PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./sqlite.js",
  "./sqlwrite.js",
  "./dumpparse.js",
  "./sqlmini.js",
  "./analysisdb.js",
  "./smartquery.js",
  "./csvwiz.js",
  "./shelf.js",
  "./app.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-maskable.svg",
  "./404.html",
  "./privacy/",
  "./contact/",
  "./convert/",
  "./convert/csv-to-sqlite/",
  "./convert/mysql-to-sqlite/",
  "./convert/postgres-to-sqlite/",
  "./convert/sqlite-to-csv/",
  "./convert/sqlite-to-sql/",
  "./blog/",
  "./blog/writing-a-database-by-hand/",
  "./blog/regeneration-not-surgery/",
  "./blog/four-verbs-are-enough/",
  "./blog/why-exports-get-smaller/"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (cache) {
      return cache.addAll(PRECACHE);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          var copy = res.clone();
          caches.open(VERSION).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match("./404.html");
      });
    })
  );
});
