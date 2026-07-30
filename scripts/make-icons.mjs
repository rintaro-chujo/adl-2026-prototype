#!/usr/bin/env node
// scripts/make-icons.mjs — visit.html の PWA マニフェスト用アイコンを生成する。
// 地色 #F4EFE4 + 珊瑚色のぼやけたブロブという、展示デザインシステムに沿った簡単なSVGを
// @resvg/resvg-js でラスタライズし、assets/visit/icon-192.png / icon-512.png に書き出す。
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "assets", "visit");

const CREAM = "#F4EFE4";
const CORAL = "#C75C5C";

// 固定シードの緩いブロブ輪郭（10点・二次ベジェで平滑化）
function blobPath(cx, cy, r) {
  const wob = [1.06, 0.94, 1.08, 0.92, 1.05, 0.95, 1.07, 0.93, 1.04, 0.96];
  const N = wob.length;
  const pts = wob.map((w, i) => {
    const th = (i / N) * Math.PI * 2;
    return [cx + Math.cos(th) * r * w, cy + Math.sin(th) * r * w];
  });
  const f = (n) => n.toFixed(1);
  let d = `M ${f((pts[0][0] + pts[N - 1][0]) / 2)} ${f((pts[0][1] + pts[N - 1][1]) / 2)}`;
  for (let i = 0; i < N; i++) {
    const cur = pts[i];
    const nxt = pts[(i + 1) % N];
    const mx = (cur[0] + nxt[0]) / 2;
    const my = (cur[1] + nxt[1]) / 2;
    d += ` Q ${f(cur[0])} ${f(cur[1])} ${f(mx)} ${f(my)}`;
  }
  return d + " Z";
}

async function makeIcon(size, outPath) {
  const r = size * 0.34;
  const blur = size * 0.012;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="${blur.toFixed(2)}"/>
    </filter>
  </defs>
  <rect width="${size}" height="${size}" fill="${CREAM}"/>
  <path d="${blobPath(size / 2, size / 2, r)}" fill="${CORAL}" filter="url(#soft)"/>
</svg>`;
  const resvg = new Resvg(svg);
  const png = resvg.render().asPng();
  await writeFile(outPath, png);
  console.log(`[make-icons] wrote ${outPath}`);
}

await makeIcon(192, path.join(OUT_DIR, "icon-192.png"));
await makeIcon(512, path.join(OUT_DIR, "icon-512.png"));
