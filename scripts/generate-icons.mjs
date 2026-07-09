// PWA用アイコン(PNG)を依存パッケージなしで生成するスクリプト。
// 実行: node scripts/generate-icons.mjs
//
// 生成物:
//   public/apple-touch-icon.png   (180x180, iOSホーム画面用)
//   public/icons/icon-192.png     (192x192, manifest用)
//   public/icons/icon-512.png     (512x512, manifest用)
//   public/icons/icon-maskable-512.png (512x512, purpose:maskable — 安全領域内に縮小)
//
// デザインはシミュレーション画面の配色に合わせている:
//   背景 #0f1115 / 参加済み(緑) #22c55e / 接近中(青) #3b82f6 / observerJoiner(橙) #f97316
// 「確定した緑のグループへ青のエージェントが近づき、橙のobserverJoinerが外縁で様子を見ている」
// というUGSの主題をドットのみで表す。

import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---- 最小限のPNGエンコーダ (RGBA8, filter=0固定) ----

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 描画 (アンチエイリアス付き円のみ) ----

function hex(color) {
  return [
    parseInt(color.slice(1, 3), 16),
    parseInt(color.slice(3, 5), 16),
    parseInt(color.slice(5, 7), 16),
  ];
}

function makeCanvas(size, bg) {
  const px = Buffer.alloc(size * size * 4);
  const [r, g, b] = hex(bg);
  for (let i = 0; i < size * size; i++) {
    px[i * 4] = r;
    px[i * 4 + 1] = g;
    px[i * 4 + 2] = b;
    px[i * 4 + 3] = 255;
  }
  return px;
}

function blend(px, size, x, y, [r, g, b], a) {
  if (a <= 0 || x < 0 || y < 0 || x >= size || y >= size) return;
  const i = (y * size + x) * 4;
  px[i] = Math.round(px[i] + (r - px[i]) * a);
  px[i + 1] = Math.round(px[i + 1] + (g - px[i + 1]) * a);
  px[i + 2] = Math.round(px[i + 2] + (b - px[i + 2]) * a);
}

function fillCircle(px, size, cx, cy, radius, color, alpha = 1) {
  const rgb = hex(color);
  const x0 = Math.max(0, Math.floor(cx - radius - 1));
  const x1 = Math.min(size - 1, Math.ceil(cx + radius + 1));
  const y0 = Math.max(0, Math.floor(cy - radius - 1));
  const y1 = Math.min(size - 1, Math.ceil(cy + radius + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = Math.min(1, Math.max(0, radius + 0.5 - d));
      blend(px, size, x, y, rgb, cov * alpha);
    }
  }
}

function strokeCircle(px, size, cx, cy, radius, width, color, alpha = 1) {
  const rgb = hex(color);
  const outer = radius + width / 2 + 1;
  const x0 = Math.max(0, Math.floor(cx - outer));
  const x1 = Math.min(size - 1, Math.ceil(cx + outer));
  const y0 = Math.max(0, Math.floor(cy - outer));
  const y1 = Math.min(size - 1, Math.ceil(cy + outer));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = Math.min(1, Math.max(0, width / 2 + 0.5 - Math.abs(d - radius)));
      blend(px, size, x, y, rgb, cov * alpha);
    }
  }
}

// ---- アイコン本体 ----

const BG = "#0f1115";
const JOINED = "#22c55e";
const APPROACHING = "#3b82f6";
const OBSERVER = "#f97316";

// motifScale: 1で全面使用、maskable用は安全領域(中央80%)に収まるよう縮小する
function drawIcon(size, motifScale = 1) {
  const px = makeCanvas(size, BG);
  const s = (v) => ((v - 256) * motifScale + 256) * (size / 512);
  const r = (v) => v * motifScale * (size / 512);

  // 確定グループ(緑): クラスタを囲む淡い円 + メンバー3人
  strokeCircle(px, size, s(198), s(202), r(128), r(10), JOINED, 0.35);
  fillCircle(px, size, s(150), s(160), r(52), JOINED);
  fillCircle(px, size, s(258), s(146), r(52), JOINED);
  fillCircle(px, size, s(196), s(262), r(52), JOINED);

  // 接近中(青): グループへ向かう1人
  fillCircle(px, size, s(352), s(310), r(44), APPROACHING);

  // observerJoiner(橙): 外縁で様子を見ている1人
  fillCircle(px, size, s(420), s(416), r(48), OBSERVER);

  return encodePng(px, size);
}

mkdirSync(join(root, "public/icons"), { recursive: true });
writeFileSync(join(root, "public/apple-touch-icon.png"), drawIcon(180));
writeFileSync(join(root, "public/icons/icon-192.png"), drawIcon(192));
writeFileSync(join(root, "public/icons/icon-512.png"), drawIcon(512));
writeFileSync(join(root, "public/icons/icon-maskable-512.png"), drawIcon(512, 0.72));
console.log("generated: apple-touch-icon.png, icons/icon-192.png, icons/icon-512.png, icons/icon-maskable-512.png");
