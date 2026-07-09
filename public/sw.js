// UGSのService Worker。目的は「再訪問時の読み込み安定」と「オフライン時に最低限
// アプリシェルを表示できること」のみで、プッシュ通知等は扱わない(issue #55)。
//
// 方針:
// - ナビゲーション: network-first。オフライン時はキャッシュ済みシェル("./")を返す。
// - その他の同一オリジンGET: stale-while-revalidate。キャッシュを即返しつつ裏で更新する
//   ので、デプロイ後も次回訪問時には新しいアセットに追いつく。
// - このファイルを変更するときは CACHE_NAME のバージョンを上げること。activate時に
//   旧バージョンのキャッシュを全削除するので、古いキャッシュが残り続けない。
//
// パスはすべてsw.jsの配置場所(GitHub Pagesでは /UGS/)からの相対で解決されるため、
// base pathをハードコードしない。

const CACHE_NAME = "ugs-cache-v1";

// オフライン時に最低限必要なアプリシェル。JS/CSSはファイル名にハッシュが付くため
// ここには列挙できず、install時にシェルHTMLを解析して参照先を一緒にプリキャッシュする
// (初回ロード時のfetchはまだこのSWを経由しないので、それだけには頼れない)。
const SHELL_ASSETS = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

// サーバーがVaryヘッダ(vite previewは"Vary: Origin"、GitHub Pagesは"Vary: Accept-Encoding")
// を返すと、保存時と照会時でリクエストヘッダが異なるだけでcache.matchが外れてしまう。
// 同一オリジンの静的アセットしか扱わないのでVaryは常に無視してよい。
const MATCH_OPTS = { ignoreVary: true };

async function precacheShell() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(SHELL_ASSETS);
  const shell = await cache.match("./", MATCH_OPTS);
  const html = await shell.text();
  const assetUrls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1], self.location.href))
    .filter((url) => url.origin === self.location.origin)
    .map((url) => url.href);
  await cache.addAll([...new Set(assetUrls)]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precacheShell());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./", copy));
          return response;
        })
        .catch(() => caches.match("./", MATCH_OPTS)),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request, MATCH_OPTS).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response.ok) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => cached);
        return cached ?? network;
      }),
    ),
  );
});
