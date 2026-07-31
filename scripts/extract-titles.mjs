#!/usr/bin/env node
// 各ポスターPDFの左上にある正式タイトルを取り出す。
// 「左上の領域で最も大きい文字」＝タイトル。折り返しは同じブロック内の
// 直下・同じ左端・同じ文字サイズの行だけをつなぐ。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = path.join(ROOT, "data", "posters");
const dec = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

export function extractTitle(pdfName) {
  const xml = execFileSync("pdftotext",
    ["-f", "1", "-l", "1", "-bbox-layout", path.join(SRC, pdfName), "-"], { encoding: "utf8" });

  const blocks = [];
  const blockRe = /<block xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/block>/g;
  let bm;
  while ((bm = blockRe.exec(xml))) {
    const lines = [];
    const lineRe = /<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([\s\S]*?)<\/line>/g;
    let lm;
    while ((lm = lineRe.exec(bm[5]))) {
      const words = [];
      const wordRe = /<word xMin="([\d.]+)" yMin="[\d.]+" xMax="([\d.]+)" yMax="[\d.]+">([\s\S]*?)<\/word>/g;
      let wm;
      while ((wm = wordRe.exec(lm[5]))) {
        words.push({ x0: +wm[1], x1: +wm[2], t: dec(wm[3]).replace(/\s+/g, " ").trim() });
      }
      const h = +lm[4] - +lm[2];
      // 単語の間隔が空いていれば半角スペースを入れる（欧文が詰まるのを防ぐ）
      let text = "";
      words.forEach((w, i) => {
        if (!w.t) return;
        if (i > 0 && w.x0 - words[i - 1].x1 > h * 0.12) text += " ";
        text += w.t;
      });
      text = text.trim();
      if (text) lines.push({ x0: +lm[1], y0: +lm[2], x1: +lm[3], y1: +lm[4], h, text });
    }
    if (lines.length) blocks.push({ x0: +bm[1], y0: +bm[2], lines });
  }

  // 左上の領域。左端の縦書きラベル（2025｜Autonomy 等）は除外
  const cand = [];
  for (const b of blocks) {
    for (const l of b.lines) {
      if (l.x0 < 40 || l.x0 > 2300 || l.y0 > 1400) continue;
      if (/^\d{4}\s*[｜|]/.test(l.text)) continue;
      cand.push(l);
    }
  }
  if (!cand.length) return null;

  const head = cand.reduce((a, b) => (b.h > a.h ? b : a));
  // 折り返し: 同じ文字サイズ・同じ左端で、上下に隣接している行をつなぐ
  // （ブロックが分かれている紙面もあるので、候補全体から探す）
  const sorted = [...cand].sort((a, b) => a.y0 - b.y0);
  const fits = (l, ref) =>
    Math.abs(l.h - head.h) < head.h * 0.15 &&
    Math.abs(l.x0 - head.x0) < head.h * 0.6 &&
    Math.abs(l.y0 - ref.y1) < head.h * 0.6;
  const parts = [head];
  let cur = head;
  for (const l of sorted) { if (l.y0 > cur.y0 && fits(l, cur)) { parts.push(l); cur = l; } }
  cur = head;
  for (const l of [...sorted].reverse()) {
    if (l.y0 < cur.y0 && Math.abs(l.h - head.h) < head.h * 0.15 &&
        Math.abs(l.x0 - head.x0) < head.h * 0.6 && Math.abs(cur.y0 - l.y1) < head.h * 0.6) {
      parts.unshift(l); cur = l;
    }
  }
  // 和文どうしの折り返しはスペースを入れずにつなぐ
  const isCjk = c => c && /[^\x00-\x7F]/.test(c);
  return parts.reduce((acc, p) => {
    if (!acc) return p.text;
    const sep = isCjk(acc.slice(-1)) && isCjk(p.text[0]) ? "" : " ";
    return acc + sep + p.text;
  }, "").replace(/\s+/g, " ").trim();
}

// 文字が図形化されていて読み取れない紙面の手当て
export const TITLE_OVERRIDE = {
  "tugmii.pdf": "tugmii",
};

if (process.argv[1] && process.argv[1].endsWith("extract-titles.mjs")) {
  const works = JSON.parse(fs.readFileSync(path.join(ROOT, "data/works.json"), "utf8"));
  for (const w of works) {
    let t;
    try { t = TITLE_OVERRIDE[w.pdf] || extractTitle(w.pdf); } catch (e) { t = "ERR:" + e.message.slice(0, 40); }
    console.log(`${w.id}\t${t === w.title ? "  " : "変更"}\t${w.title}${t === w.title ? "" : "\t→ " + t}`);
  }
}
