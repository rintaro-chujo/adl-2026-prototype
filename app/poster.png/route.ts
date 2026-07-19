// /poster.png — アクセスするたびに違うポスターを描いて返す動的エンドポイント。
//
// index.html の自動生成と同じ流儀（同じパレット・かたちライブラリ・ぼかし）で
// SVG を組み立て、resvg でラスタライズして PNG を返す。
// クエリ:
//   ?seed=…   同じ一枚を再現（省略時は毎回ランダム）
//   ?shape=…  auto | blob | mono（かたちの出どころ。既定 auto）
//   ?size=…   poster | insta（既定 poster）
//   ?w=…      出力幅 px（320〜2400、既定 1200）
import { readFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Resvg } from "@resvg/resvg-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------- 共通デザイン（index.html と揃える）----------
const CREAM = "#F4EFE4";
const PALETTE = ["#C75C5C", "#A6CFE3", "#F1C4D1", "#EFD884", "#A9C56C", "#C9C6E4", "#3B3A38"];
// 「背景に色」で珊瑚・墨のときは文字を白にする
const WHITE_TEXT_COLORS = new Set(["#C75C5C", "#3B3A38"]);

const SIZES = {
  poster: { svg: "poster.svg", w: 1684, h: 2384 }, // 文字組み SVG の viewBox 比
  insta: { svg: "insta.svg", w: 1080, h: 1350 },
} as const;

// ---------- 乱数（index.html と同じ mulberry32）----------
function hashSeed(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pt = { x: number; y: number };

// ---------- 「もの」の輪郭ライブラリ（index.html と同じ座標）----------
const MONO_SHAPES: Record<string, number[][]> = {
  mug: [[20, 28], [78, 28], [80, 42], [93, 40], [100, 52], [92, 66], [80, 62], [78, 82], [68, 94], [32, 94], [22, 82]],
  umbrella: [[10, 50], [18, 34], [34, 24], [50, 20], [66, 24], [82, 34], [90, 50], [72, 46], [56, 46], [55, 84], [52, 92], [46, 90], [45, 84], [49, 84], [50, 46], [34, 46], [18, 46]],
  key: [[10, 32], [16, 20], [30, 14], [44, 20], [50, 32], [44, 44], [34, 48], [52, 46], [88, 44], [88, 56], [80, 56], [80, 48], [72, 48], [72, 58], [64, 58], [64, 48], [30, 50], [16, 44]],
  book: [[10, 30], [30, 24], [48, 30], [50, 32], [52, 30], [70, 24], [90, 30], [90, 74], [70, 70], [52, 76], [50, 78], [48, 76], [30, 70], [10, 74]],
  chair: [[30, 10], [36, 10], [36, 50], [76, 50], [76, 92], [70, 92], [70, 58], [36, 58], [36, 92], [30, 92]],
  bottle: [[42, 8], [56, 8], [56, 22], [64, 34], [68, 52], [66, 74], [58, 90], [40, 90], [32, 74], [30, 52], [34, 34], [42, 22]],
  shirt: [[36, 16], [46, 20], [54, 20], [64, 16], [86, 28], [78, 44], [68, 40], [68, 88], [32, 88], [32, 40], [22, 44], [14, 28]],
  bowl: [[16, 40], [84, 40], [80, 58], [68, 74], [58, 80], [62, 88], [38, 88], [42, 80], [32, 74], [20, 58]],
};

// 輪郭を「中心原点・最長辺 1」に正規化しつつ等間隔の N 点に増やす
function densify(raw: number[][], N: number): Pt[] {
  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  for (const [x, y] of raw) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const s = 1 / Math.max(1e-9, Math.max(maxX - minX, maxY - minY));
  const ox = (minX + maxX) / 2, oy = (minY + maxY) / 2;
  const pts = raw.map(([x, y]) => ({ x: (x - ox) * s, y: (y - oy) * s }));
  const closed = pts.concat([pts[0]]);
  const cum = [0];
  for (let i = 1; i < closed.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(closed[i].x - closed[i - 1].x, closed[i].y - closed[i - 1].y));
  }
  const total = cum[cum.length - 1];
  const out: Pt[] = [];
  let j = 0;
  for (let i = 0; i < N; i++) {
    const d = (i / N) * total;
    while (j < closed.length - 2 && cum[j + 1] < d) j++;
    const t = (d - cum[j]) / Math.max(1e-9, cum[j + 1] - cum[j]);
    out.push({
      x: closed[j].x + (closed[j + 1].x - closed[j].x) * t,
      y: closed[j].y + (closed[j + 1].y - closed[j].y) * t,
    });
  }
  return out;
}

// ---------- かたちの生成（index.html と同じパラメータ分布）----------
function generateShape(rng: () => number, W: number, H: number, mode: string): Pt[] {
  const rnd = (a: number, b: number) => a + rng() * (b - a);
  const pick = <T,>(arr: T[]) => arr[Math.floor(rng() * arr.length)];
  const TAU = Math.PI * 2;
  const kind = mode === "auto" ? (rng() < 0.5 ? "blob" : "mono") : mode;
  const cx = W * rnd(0.32, 0.68), cy = H * rnd(0.34, 0.62);
  const w0 = rng();
  const pts: Pt[] = [];
  if (kind === "blob") {
    const R = Math.min(W, H) * rnd(0.17, 0.3);
    const squash = rnd(0.75, 1.25);
    const rot = rnd(0, TAU);
    const gen = () => {
      const hs = [];
      for (let k = 2; k <= 5; k++) hs.push({ k, a: rnd(0.05, 0.24) / (k * 0.55), ph: rnd(0, TAU) });
      return hs;
    };
    const h1 = gen(), h2 = gen();
    const u = 0.5 - 0.5 * Math.cos(TAU * w0);
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const N = 72;
    for (let i = 0; i < N; i++) {
      const th = (i / N) * TAU;
      let r = 1;
      for (let j = 0; j < h1.length; j++) {
        const a = h1[j].a + (h2[j].a - h1[j].a) * u;
        const ph = h1[j].ph + (h2[j].ph - h1[j].ph) * u;
        r += a * Math.sin(h1[j].k * th + ph);
      }
      const x = Math.cos(th) * R * r, y = Math.sin(th) * R * r * squash;
      pts.push({ x: cx + x * cos - y * sin, y: cy + x * sin + y * cos });
    }
  } else {
    const base = densify(MONO_SHAPES[pick(Object.keys(MONO_SHAPES))], 64);
    const size = Math.min(W, H) * rnd(0.45, 0.66);
    const rot = rnd(-0.22, 0.22);
    const amp = rnd(0.012, 0.04);
    const m1 = 1 + Math.floor(rng() * 3), m2 = 1 + Math.floor(rng() * 3);
    const f2 = rng() < 0.5 ? 1 : 2;
    const phA = rnd(0, TAU), phB = rnd(0, TAU);
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const N = base.length;
    for (let i = 0; i < N; i++) {
      const dx = amp * Math.sin(TAU * w0 + (i / N) * TAU * m1 + phA);
      const dy = amp * Math.sin(TAU * f2 * w0 + (i / N) * TAU * m2 + phB);
      const x = (base[i].x + dx) * size, y = (base[i].y + dy) * size;
      pts.push({ x: cx + x * cos - y * sin, y: cy + x * sin + y * cos });
    }
  }
  return pts;
}

// index.html の tracePath と同じ二次ベジェ平滑化の path 文字列
function pathFrom(pts: Pt[], close: boolean): string {
  const f = (n: number) => n.toFixed(1);
  let d = `M ${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q ${f(pts[i].x)} ${f(pts[i].y)} ${f(mx)} ${f(my)}`;
  }
  const last = pts[pts.length - 1];
  if (close) d += ` Q ${f(last.x)} ${f(last.y)} ${f(pts[0].x)} ${f(pts[0].y)} Z`;
  else d += ` L ${f(last.x)} ${f(last.y)}`;
  return d;
}

// Illustrator 由来の SVG は tspan ごとに絶対 x を持つ（元フォントの字幅前提）。
// 代替フォントだと字幅が変わり隣の tspan と重なるため、同じ行で次に続く
// tspan の x 位置から各 tspan の幅を textLength で確定させる。
function fitTspans(typo: string): string {
  return typo.replace(/(<text[^>]*>)((?:(?!<\/text>)[\s\S])*)(<\/text>)/g, (_m, open, inner, close) => {
    const re = /<tspan([^>]*)>([^<]*)<\/tspan>/g;
    type Item = { attrs: string; text: string; x: number | null; y: number | null; start: number; end: number };
    const items: Item[] = [];
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(inner))) {
      const x = /(?:^|\s)x="([-\d.]+)"/.exec(mm[1]);
      const y = /(?:^|\s)y="([-\d.]+)"/.exec(mm[1]);
      items.push({
        attrs: mm[1], text: mm[2],
        x: x ? +x[1] : null, y: y ? +y[1] : null,
        start: mm.index, end: mm.index + mm[0].length,
      });
    }
    if (items.length < 2) return _m;
    let out = "", pos = 0;
    for (let i = 0; i < items.length; i++) {
      const cur = items[i], nxt = items[i + 1];
      out += inner.slice(pos, cur.start);
      const fixable = cur.x != null && nxt && nxt.x != null && nxt.y === cur.y && nxt.x > cur.x && cur.text.trim();
      const tl = fixable ? ` textLength="${(nxt!.x! - cur.x!).toFixed(2)}" lengthAdjust="spacingAndGlyphs"` : "";
      out += `<tspan${cur.attrs}${tl}>${cur.text}</tspan>`;
      pos = cur.end;
    }
    out += inner.slice(pos);
    return open + out + close;
  });
}

// ---------- 静的アセット（フォント・文字組み SVG）はモジュールスコープにキャッシュ ----------
const ASSETS = path.join(process.cwd(), "assets");
// fontBuffers は v2.6 系でファミリー解決が効かないため fontFiles（パス指定）を使う
const FONT_FILES = [
  "CormorantInfant-400.ttf", "CormorantInfant-500.ttf", "CormorantInfant-700.ttf",
  "ShipporiMincho-400.ttf", "ShipporiMincho-500.ttf", "ShipporiMincho-700.ttf",
].map(fname => path.join(ASSETS, "fonts", fname));
const svgCache = new Map<string, Promise<string>>();
function loadTypography(file: string) {
  if (!svgCache.has(file)) svgCache.set(file, readFile(path.join(ASSETS, file), "utf8"));
  return svgCache.get(file)!;
}

export async function GET(req: Request) {
  try {
    return await renderPoster(req);
  } catch (e) {
    console.error("[poster.png] render failed:", e);
    return new Response("poster render failed", { status: 500 });
  }
}

async function renderPoster(req: Request) {
  const url = new URL(req.url);
  const seed = url.searchParams.get("seed");
  const shapeMode = ["auto", "blob", "mono"].includes(url.searchParams.get("shape") ?? "")
    ? url.searchParams.get("shape")! : "auto";
  const sizeKey = (url.searchParams.get("size") === "insta" ? "insta" : "poster") as keyof typeof SIZES;
  const outW = Math.max(320, Math.min(2400, Number(url.searchParams.get("w")) || 1200));

  const rng = mulberry32(seed ? hashSeed(seed) : crypto.randomInt(0, 0xffffffff));
  const rnd = (a: number, b: number) => a + rng() * (b - a);

  const size = SIZES[sizeKey];
  const { w: W, h: H } = size;

  // index.html の generatePoster と同じ抽選
  const color = PALETTE[Math.floor(rng() * PALETTE.length)];
  const fillMode = rng() < 0.3 ? "background" : "shape";
  const line = rng() < 0.18;
  const lineW = rnd(3, 9) / 1000;
  const pts = generateShape(rng, W, H, shapeMode);
  const blur = W * 0.075 * rnd(0.15, 0.7);

  const bg = fillMode === "background" ? color : CREAM;
  const paint = fillMode === "background" ? CREAM : color;
  const white = fillMode === "background" && WHITE_TEXT_COLORS.has(color);

  // 文字組み SVG: 合成フォント指定を実フォントに差し替え、必要なら文字を白に
  let typo = (await loadTypography(size.svg))
    .replace(/^<\?xml[^>]*\?>\s*/, "")
    .replace(/font-family:\s*ATC-[^;]+;/g, "font-family:'Cormorant Infant','Shippori Mincho',serif;");
  if (white) typo = typo.replace(/#3f3b3a/gi, "#ffffff").replace(/#3e3a39/gi, "#ffffff");
  typo = fitTspans(typo);
  // ネストした <svg> として原寸に合わせる（viewBox でスケール）
  typo = typo.replace(/<svg /, `<svg width="${W}" height="${H}" `);

  const shapeEl = line
    ? `<path d="${pathFrom(pts, false)}" fill="none" stroke="${paint}" stroke-width="${Math.max(2, lineW * W).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`
    : `<path d="${pathFrom(pts, true)}" fill="${paint}"/>`;

  // fitTo はネストした <svg> と併用すると効かないため、
  // 外側の width/height を出力サイズにして viewBox でスケールする。
  const outH = Math.round((outW * H) / W);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${W} ${H}">
  <defs>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="${(blur / 2).toFixed(1)}"/>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <g filter="url(#soft)">${shapeEl}</g>
  ${typo}
</svg>`;

  const resvg = new Resvg(svg, {
    font: {
      fontFiles: FONT_FILES,
      loadSystemFonts: false,
      defaultFontFamily: "Shippori Mincho",
    },
  });
  const png = resvg.render().asPng();

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      // 毎回違う一枚を返すので、どの層にもキャッシュさせない
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
    },
  });
}
