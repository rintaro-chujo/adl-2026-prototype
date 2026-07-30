#!/usr/bin/env node
// デザイナーSVG(hp-top.svg / poster.svg)のタイトル文字組を、フォント埋め込み済みの
// 自己完結 SVG として書き出す(visit.html / screen.html が <img> でそのまま使う)。
//   assets/visit/title-ja.svg … 縦書き「モノにこころをあずけておりまして」(hp-top.svg cls-7 と同一の組み)
//   assets/visit/title-en.svg … "somehow, my heart is with those things"(poster.svg cls-9 と同一の組み)
// viewBox はブラウザ実測のインク BBox(2026-07-31 計測)に基づく。
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "assets", "visit");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function fontCss(family, weight, text) {
  const api = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, "+")}:wght@${weight}&text=${encodeURIComponent(text)}`;
  let css = await fetch(api, { headers: { "User-Agent": UA } }).then(r => r.text());
  const urls = [...new Set([...css.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]))];
  for (const u of urls) {
    const buf = Buffer.from(await fetch(u).then(r => r.arrayBuffer()));
    css = css.split(u).join(`data:font/woff2;base64,${buf.toString("base64")}`);
  }
  return css;
}

const svgFile = (viewBox, css, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">\n<style>${css}</style>\n${body}\n</svg>\n`;

// --- 日本語タイトル(縦書き4列) ---
{
  const text = "モノにこころをあずけておりまして";
  const css = (await fontCss("Shippori Mincho", 700, text)) + `
    text { font: 700 89.76px 'Shippori Mincho', serif; fill: #3e3a39;
           letter-spacing: .35em; writing-mode: vertical-rl; text-orientation: upright; }`;
  const body = `<text transform="translate(468.92 0)">` +
    `<tspan x="0" y="0">モノに</tspan>` +
    `<tspan x="-134.64" y="0">こころを</tspan>` +
    `<tspan x="-269.28" y="0">あずけて</tspan>` +
    `<tspan x="-403.92" y="0">おりまして</tspan></text>`;
  fs.writeFileSync(path.join(OUT, "title-ja.svg"), svgFile("-3 -3 540 612", css, body));
  console.log("title-ja.svg ✓");
}

// --- 英語タイトル(3行ずらし組み。全角スペース起こしは実測 x に置換済み) ---
{
  const text = "somehow, my heart is with those things";
  const css = (await fontCss("Cormorant Infant", 700, text)) + `
    text { font: 700 60px 'Cormorant Infant', serif; fill: #3e3a39; }`;
  const body = `<text transform="translate(0 55)">` +
    `<tspan x="240" y="0">someho</tspan><tspan x="421.14" y="0">w</tspan><tspan x="458.82" y="0">, </tspan>` +
    `<tspan x="0" y="105">my h</tspan><tspan x="121.14" y="105">e</tspan><tspan x="145.86" y="105">art is </tspan>` +
    `<tspan x="180" y="210">with those things</tspan></text>`;
  fs.writeFileSync(path.join(OUT, "title-en.svg"), svgFile("-3 -3 593 288", css, body));
  console.log("title-en.svg ✓");
}
