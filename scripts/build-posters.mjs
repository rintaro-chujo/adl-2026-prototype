#!/usr/bin/env node
// data/works.json(★手動管理: 番号・セクションはユーザーが編集する)を正として、
// assets/posters/{id}.main.jpg / .thumb.jpg / .full.jpg を生成する。
// - works.json の id/section/タイトルは一切書き換えない(focus/crop のみ MAIN_OVERRIDE から補完)
// - works.json に無い PDF がディスクにあれば警告(w41 追加時はエントリを手で足してから実行)
// - 生成済み画像はスキップ。番号を付け替えたときは --force で全再生成
// 依存: poppler (pdfimages, pdftoppm), macOS sips
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SRC = path.join(ROOT, "data", "posters");
const OUT = path.join(ROOT, "assets", "posters");
const WORKS_JSON = path.join(ROOT, "data", "works.json");
const FORCE = process.argv.includes("--force");
fs.mkdirSync(OUT, { recursive: true });

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

// 自動選択(表示面積最大)が外れる作品の手動上書き。
// 値: 画像番号 or { num, focus:[x,y], crop:[x,y,w,h] }
//   focus = ブロブ中央に据える被写体位置 0..1(crop 内基準、省略時は中央)
//   crop  = 元画像のうち使うサブ矩形 0..1(描画時の仮想クロップ、ファイルは切らない)
const MAIN_OVERRIDE = {
  "Monetic Plotter.pdf": 4,                          // モネの絵+ドットのアクリル(自動だとテキスト面)
  "アイ・ラベル.pdf": { num: 0, focus: [0.38, 0.62] }, // 目玉シール付き野菜の箱(自動だと暗い引き写真)
  "コプター.pdf": 0,                                  // ヘルメットを被った3人(紙面ヒーローと同一)
  "ここえ.pdf": { num: 8, focus: [0.55, 0.45] },      // たまご型デバイスを覗く人(自動だとテキスト面)
  "WANTAG.pdf": { num: 2, focus: [0.42, 0.5] },      // コートを持つ女性のイラスト=紙面ヒーロー
  "逃げるスマートスピーカー.pdf": { num: 0, crop: [0, 0, 0.485, 1], focus: [0.42, 0.7] }, // 2コマ比較の左コマのみ
};

// pdfimages -list を解析して表示面積(width/xppi × height/yppi)最大の画像 num を返す
function largestImageNum(pdf) {
  const out = run("pdfimages", ["-list", pdf]);
  let best = null;
  for (const line of out.split("\n").slice(2)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 14 || f[2] !== "image") continue;
    const [w, h] = [+f[3], +f[4]];
    const [xppi, yppi] = [+f[12], +f[13]];
    if (!xppi || !yppi) continue;
    const area = (w / xppi) * (h / yppi);
    if (!best || area > best.area) best = { num: +f[1], area };
  }
  return best?.num ?? null;
}

// ---- works.json 読み込みと検証 ----
const works = JSON.parse(fs.readFileSync(WORKS_JSON, "utf8"));
{
  const ids = new Set();
  let bad = false;
  for (const w of works) {
    if (!/^w\d{2}$/.test(w.id)) { console.error(`不正な id: ${JSON.stringify(w)}`); bad = true; }
    if (ids.has(w.id)) { console.error(`id 重複: ${w.id}`); bad = true; }
    ids.add(w.id);
    if (!fs.existsSync(path.join(SRC, w.pdf))) { console.error(`PDF が見つかりません: ${w.pdf} (${w.id})`); bad = true; }
  }
  if (bad) process.exit(1);
  const listed = new Set(works.map(w => w.pdf));
  for (const f of fs.readdirSync(SRC)) {
    if (f.toLowerCase().endsWith(".pdf") && !listed.has(f)) {
      console.warn(`⚠ works.json に未登録の PDF: ${f} — id/section を決めてエントリを追加してから再実行してください`);
    }
  }
}

let changed = false;
for (const work of works) {
  const { id, title, pdf: file } = work;
  const pdf = path.join(SRC, file);
  const ov = MAIN_OVERRIDE[file];

  // focus/crop を works.json に反映(手動編集された他フィールドは触らない)
  if (ov && typeof ov === "object") {
    if (ov.focus && JSON.stringify(work.focus) !== JSON.stringify(ov.focus)) { work.focus = ov.focus; changed = true; }
    if (ov.crop && JSON.stringify(work.crop) !== JSON.stringify(ov.crop)) { work.crop = ov.crop; changed = true; }
  }

  const mainOut = path.join(OUT, `${id}.main.jpg`);
  const thumbOut = path.join(OUT, `${id}.thumb.jpg`);
  const fullOut = path.join(OUT, `${id}.full.jpg`);
  const log = m => console.log(`[${id}] ${title}: ${m}`);

  // --- main visual ---
  if (FORCE || !fs.existsSync(mainOut)) {
    try {
      const num = (typeof ov === "object" ? ov.num : ov) ?? largestImageNum(pdf);
      if (num == null) throw new Error("no raster images");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-"));
      run("pdfimages", ["-all", "-f", "1", "-l", "1", pdf, path.join(tmp, "im")]);
      const want = `im-${String(num).padStart(3, "0")}`;
      const hit = fs.readdirSync(tmp).find(f => f.startsWith(want + "."));
      if (!hit) throw new Error(`extracted file ${want}.* not found`);
      run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "88", "-Z", "1600",
        path.join(tmp, hit), "--out", mainOut]);
      fs.rmSync(tmp, { recursive: true, force: true });
      log(`main ← image #${num} (${hit})`);
    } catch (e) {
      // フォールバック: ページ全体をレンダリング
      log(`main extract failed (${e.message}) → page-render fallback`);
      run("pdftoppm", ["-jpeg", "-scale-to", "1600", "-f", "1", "-l", "1", pdf, path.join(OUT, id + ".mainfb")]);
      const fb = fs.readdirSync(OUT).find(f => f.startsWith(id + ".mainfb"));
      fs.renameSync(path.join(OUT, fb), mainOut);
    }
  }

  // --- page renders ---
  const page = (px, dst, tag) => {
    if (!FORCE && fs.existsSync(dst)) return;
    run("pdftoppm", ["-jpeg", "-jpegopt", "quality=85", "-scale-to", String(px), "-f", "1", "-l", "1", pdf, dst.replace(/\.jpg$/, "")]);
    const got = fs.readdirSync(OUT).find(f => f.startsWith(path.basename(dst, ".jpg") + "-"));
    if (got) fs.renameSync(path.join(OUT, got), dst);
    log(tag);
  };
  page(1600, fullOut, "full 1600px");
  page(480, thumbOut, "thumb 480px");
}

if (changed) {
  fs.writeFileSync(WORKS_JSON, JSON.stringify(works, null, 2) + "\n");
  console.log("works.json: focus/crop を更新");
}

// works.json に存在しない id の古い画像を掃除(番号付け替えの残骸)
const valid = new Set(works.map(w => w.id));
for (const f of fs.readdirSync(OUT)) {
  const m = f.match(/^(w\d{2})\./);
  if (m && !valid.has(m[1])) {
    fs.rmSync(path.join(OUT, f));
    console.log(`古い画像を削除: ${f}`);
  }
}
console.log(`\n完了: ${works.length} 作品`);
