#!/usr/bin/env node
// print-agent/agent.mjs — 会場プリントPC(Mac)で動かすジョブ処理エージェント。
//
// /api/print-jobs を3秒ごとにポーリングし、新しいジョブごとに A4縦・両面PDFを合成して
// lp で印刷、アンケートを survey.csv に追記する。素の Node ESM（依存は pdf-lib のみ、
// リポジトリルートの node_modules を使う）。
//
// 使い方:
//   node print-agent/agent.mjs                      # 3秒ポーリングを継続
//   node print-agent/agent.mjs --once                # 1回だけポーリングして終了
//   node print-agent/agent.mjs --dry-run              # 印刷せず out/ にPDF保存のみ
//   node print-agent/agent.mjs --since <id>           # このid以降から再開（1回限りの上書き）
//   node print-agent/agent.mjs --retry-failed          # 失敗ジョブだけ再試行
//   node print-agent/agent.mjs --front-only            # 表面だけ1ページで印刷（元PDF不要・緊急用）
//   node print-agent/agent.mjs --api http://host:3010  # API_BASE の代わりに指定
//
// 接続先: --api > 環境変数 API_BASE > 既定 https://adl-exhibition-2026.vercel.app
// トークン: --token > 環境変数 PRINT_AGENT_TOKEN > print-agent/token.txt
// env: PRINTER(lp -d で使うプリンタ名)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// pdf-lib は起動時に読み込む（入っていなければ自動で npm install する）。
// 静的 import にすると未インストール時にエラーだけ出て落ちてしまうため、あえて遅延読み込み。
let PDFDocument = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const POSTERS_DIR = path.join(ROOT, "data", "posters");
const WORKS_JSON = path.join(ROOT, "data", "works.json");
const OUT_DIR = path.join(__dirname, "out");
const STATE_FILE = path.join(__dirname, "state.json");
const CSV_FILE = path.join(__dirname, "survey.csv");
const CSV_HEADER =
  "id,createdAt,work1,work2,work3,emotion,visit,who,satisfaction,comment";

// A4縦(pt)。詳細は docs/SPEC_visit-impl.md の print-agent 節を参照。
const A4_W = 595.28;
const A4_H = 841.89;
const HALF_H = 420.94;
const SLOT_W = 297.64;
// 元PDF(4161×2976pt横)の左半分。上下 16.85pt ずつトリムして比率をスロットに合わせる。
const LEFT_HALF_BOX = { left: 0, right: 2080.5, bottom: 16.85, top: 2959.15 };

const POLL_MS = 3000;

// ---------- CLI 引数 ----------
function parseArgs(argv) {
  const args = {
    dryRun: false,
    once: false,
    retryFailed: false,
    frontOnly: false,
    since: null,
    api: null,
    token: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--once") args.once = true;
    else if (a === "--retry-failed") args.retryFailed = true;
    else if (a === "--front-only") args.frontOnly = true;
    else if (a === "--since") args.since = argv[++i] ?? null;
    else if (a === "--api") args.api = argv[++i] ?? null;
    else if (a === "--token") args.token = argv[++i] ?? null;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const API_BASE =
  args.api || process.env.API_BASE || "https://adl-exhibition-2026.vercel.app";

// トークンはソースに書かない（このリポジトリは公開されている）。
// --token / 環境変数 / print-agent/token.txt（gitignore 済み）の順に読む。
function readTokenFile() {
  for (const f of [path.join(__dirname, "token.txt"), path.join(ROOT, "print-agent", "token.txt")]) {
    try { if (existsSync(f)) return readFileSync(f, "utf8").trim(); } catch (e) { /* 読めなければ次 */ }
  }
  return "";
}
const TOKEN = args.token || process.env.PRINT_AGENT_TOKEN || readTokenFile();
const PRINTER = process.env.PRINTER || "";

// ---------- state.json ----------
async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return { lastId: null, failed: [] };
  }
}
async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------- survey.csv（RFC4180エスケープ） ----------
function csvField(v) {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
async function appendSurveyRow(job) {
  const exists = await readFile(CSV_FILE, "utf8")
    .then(() => true)
    .catch(() => false);
  const row =
    [
      job.id,
      new Date(job.meta.createdAt).toISOString(),
      job.meta.workIds[0],
      job.meta.workIds[1],
      job.meta.workIds[2],
      job.meta.emotion,
      job.meta.survey.visit,
      job.meta.survey.who,
      job.meta.survey.satisfaction,
      job.meta.survey.comment,
    ]
      .map(csvField)
      .join(",") + "\r\n";
  if (!exists) await writeFile(CSV_FILE, CSV_HEADER + "\r\n" + row);
  else await writeFile(CSV_FILE, row, { flag: "a" });
}

// ---------- works.json ----------
let worksByIdPromise = null;
function loadWorksById() {
  if (!worksByIdPromise) {
    worksByIdPromise = readFile(WORKS_JSON, "utf8").then((raw) => {
      const map = new Map();
      for (const w of JSON.parse(raw)) map.set(w.id, w);
      return map;
    });
  }
  return worksByIdPromise;
}

// ---------- PDF合成 ----------
async function buildPdf(job, frontBuf) {
  const pdfDoc = await PDFDocument.create();

  // p1 表: front.jpg を全面
  const p1 = pdfDoc.addPage([A4_W, A4_H]);
  const frontImg = await pdfDoc.embedJpg(frontBuf);
  p1.drawImage(frontImg, { x: 0, y: 0, width: A4_W, height: A4_H });

  // --front-only: 元PDFを持たない環境の緊急用。表面だけの1ページで出す
  // （QRから3作品は見られるが、裏面のポスターは入らない）
  if (args.frontOnly) return pdfDoc.save();

  const worksById = await loadWorksById();
  const [favId, subId1, subId2] = job.meta.workIds;

  // p2 裏
  const p2 = pdfDoc.addPage([A4_W, A4_H]);

  // 上半分: お気に入り作品の1ページ目を contain・無トリミング・中央
  const favWork = worksById.get(favId);
  if (!favWork) throw new Error(`works.json に見つからない workId: ${favId}`);
  const favBytes = await readFile(path.join(POSTERS_DIR, favWork.pdf));
  const favSrcDoc = await PDFDocument.load(favBytes);
  const favSrcPage = favSrcDoc.getPages()[0];
  const [favEmbed] = await pdfDoc.embedPages([favSrcPage]);
  const favScale = Math.min(A4_W / favEmbed.width, HALF_H / favEmbed.height);
  const favW = favEmbed.width * favScale;
  const favH = favEmbed.height * favScale;
  p2.drawPage(favEmbed, {
    x: (A4_W - favW) / 2,
    y: HALF_H + (HALF_H - favH) / 2,
    width: favW,
    height: favH,
  });

  // 下半分: 残り2作品を左半分クロップで A6縦スロット×2
  const subIds = [subId1, subId2];
  for (let i = 0; i < 2; i++) {
    const work = worksById.get(subIds[i]);
    if (!work)
      throw new Error(`works.json に見つからない workId: ${subIds[i]}`);
    const bytes = await readFile(path.join(POSTERS_DIR, work.pdf));
    const srcDoc = await PDFDocument.load(bytes);
    const srcPage = srcDoc.getPages()[0];
    const embedded = await pdfDoc.embedPage(srcPage, LEFT_HALF_BOX);
    p2.drawPage(embedded, {
      x: i * SLOT_W,
      y: 0,
      width: SLOT_W,
      height: HALF_H,
    });
  }

  return pdfDoc.save();
}

// ---------- API 呼び出し ----------
async function fetchJobs(after) {
  const url = new URL("/api/print-jobs", API_BASE);
  if (after) url.searchParams.set("after", after);
  const res = await fetch(url, {
    headers: TOKEN ? { "x-agent-token": TOKEN } : {},
  });
  if (!res.ok) throw new Error(`GET /api/print-jobs failed: ${res.status}`);
  return res.json();
}
async function fetchFront(frontUrl) {
  const res = await fetch(frontUrl, {
    headers: TOKEN ? { "x-agent-token": TOKEN } : {},
  });
  if (!res.ok) throw new Error(`front.jpg 取得失敗: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ---------- 印刷 ----------
function printPdf(filePath) {
  const lpArgs = ["-o", "media=A4", "-o", "sides=two-sided-long-edge"];
  if (PRINTER) lpArgs.push("-d", PRINTER);
  lpArgs.push(filePath);
  const result = spawnSync("lp", lpArgs, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `lp failed (status ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  console.log(`[print-agent] lp 送信: ${result.stdout.trim()}`);
}

// ---------- 1ジョブ処理 ----------
async function processJob(job) {
  console.log(
    `[print-agent] 処理開始 id=${job.id} works=${job.meta.workIds.join(",")}`,
  );
  const frontBuf = await fetchFront(job.frontUrl);
  const pdfBytes = await buildPdf(job, frontBuf);

  await mkdir(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${job.id}.pdf`);
  await writeFile(outPath, pdfBytes);

  if (args.dryRun) {
    console.log(`[print-agent] dry-run: ${outPath} に保存`);
  } else {
    printPdf(outPath);
  }
  await appendSurveyRow(job);
  console.log(`[print-agent] 完了 id=${job.id}`);
}

// ---------- ポーリング1回分 ----------
async function pollOnce(state) {
  const failedSet = new Set(state.failed);
  const after = args.retryFailed ? null : state.lastId;
  let jobs;
  try {
    jobs = await fetchJobs(after);
  } catch (e) {
    console.error("[print-agent] ジョブ一覧の取得に失敗:", e);
    return;
  }

  for (const job of jobs) {
    const shouldProcess = args.retryFailed ? failedSet.has(job.id) : true;
    if (!shouldProcess) continue;

    try {
      await processJob(job);
      failedSet.delete(job.id);
    } catch (e) {
      // 1ジョブの失敗で止まらない。state に記録して次のジョブへ。
      console.error(`[print-agent] ジョブ失敗 id=${job.id}:`, e);
      failedSet.add(job.id);
    }
    if (!args.retryFailed) state.lastId = job.id;
  }
  state.failed = [...failedSet];
  await saveState(state);
}

// ---------- 起動前チェック ----------
// 会場のPCで「必要なものが揃っていない」まま動かして気づけない事故を防ぐ。
// 依存が無ければその場で入れ、それ以外の不足は日本語で理由を出して止める。
function npmInstall(pkgArgs, cwd) {
  const r = spawnSync("npm", pkgArgs, { cwd, stdio: "inherit", encoding: "utf8" });
  return !r.error && r.status === 0;
}

async function ensureDeps() {
  try {
    ({ PDFDocument } = await import("pdf-lib"));
    return;
  } catch (e) {
    if (e && e.code !== "ERR_MODULE_NOT_FOUND") throw e;
  }
  // ここに来る＝pdf-lib が無い。リポジトリ内なら一括 install、
  // 単体ファイル運用（--front-only）なら agent.mjs と同じ場所に pdf-lib だけ入れる
  // （Node は import 元のフォルダから上へ node_modules を探すのでこれで解決できる）。
  const inRepo = existsSync(path.join(ROOT, "package.json"));
  const cwd = inRepo ? ROOT : __dirname;
  const pkgArgs = inRepo ? ["install"] : ["install", "pdf-lib"];
  console.log(`[print-agent] pdf-lib が見つかりません。${cwd} で npm ${pkgArgs.join(" ")} を実行します…`);
  if (!npmInstall(pkgArgs, cwd)) {
    throw new Error(
      "依存パッケージのインストールに失敗しました。ネットにつながっているか、" +
      `このフォルダ（${cwd}）に書き込めるかを確認してください。`
    );
  }
  ({ PDFDocument } = await import("pdf-lib"));
  console.log("[print-agent] pdf-lib を用意しました");
}

function checkFiles() {
  if (args.frontOnly) return;   // 表面だけなら元PDFも works.json も要らない
  const missing = [];
  if (!existsSync(WORKS_JSON)) missing.push(path.relative(ROOT, WORKS_JSON));
  if (!existsSync(POSTERS_DIR)) missing.push(path.relative(ROOT, POSTERS_DIR) + "/（作品PDF）");
  if (missing.length) {
    throw new Error(
      "リポジトリの中で実行してください。見つからないもの: " + missing.join(", ") + "\n" +
      "  リーフレットの裏面は data/posters の元PDFから作るため、agent.mjs 単体では動きません。\n" +
      "  git clone https://github.com/rintaro-chujo/adl-2026-prototype.git\n" +
      "  cd adl-2026-prototype && npm install\n" +
      "  ※ どうしても元PDFを用意できないときは --front-only で表面だけ印刷できます"
    );
  }
}

function checkPrinter() {
  if (args.dryRun) return;
  const r = spawnSync("lp", ["-h"], { encoding: "utf8" });
  if (r.error) {
    console.warn("[print-agent] 警告: lp コマンドが見つかりません。印刷できない可能性があります");
    return;
  }
  const st = spawnSync("lpstat", ["-p"], { encoding: "utf8" });
  const out = (st.stdout || "").trim();
  if (!out) {
    console.warn("[print-agent] 警告: プリンターが1台も見つかりません（システム設定で追加してください）");
  } else if (PRINTER && out.indexOf(PRINTER) < 0) {
    console.warn(`[print-agent] 警告: PRINTER=${PRINTER} が見つかりません。利用可能:\n${out}`);
  }
}

async function preflight() {
  console.log(`[print-agent] Node ${process.version}`);
  checkFiles();   // 先に置き場所を確かめる（単体コピー実行で無関係な場所に install しないため）
  await ensureDeps();
  checkPrinter();
  if (!TOKEN) {
    console.warn(
      "[print-agent] 警告: トークンが未設定です。print-agent/token.txt に書くか、" +
      "PRINT_AGENT_TOKEN 環境変数か --token で渡してください"
    );
  }
  // API に到達できるかを先に確かめる（URL の打ち間違いやトークン違いをここで気づけるように）
  let res;
  try {
    res = await fetch(`${API_BASE}/api/print-jobs`, {
      headers: TOKEN ? { "x-agent-token": TOKEN } : {},
    });
  } catch (e) {
    throw new Error(`API に接続できません（${API_BASE}）: ${e.message}\n` +
      "  --api か環境変数 API_BASE で正しい URL を指定してください。\n" +
      "  例: API_BASE=https://adl-exhibition-2026.vercel.app");
  }
  if (res.status === 401) {
    throw new Error(
      "API の認証に失敗しました（401）。PRINT_AGENT_TOKEN が Vercel 側の設定と一致していません。\n" +
      "  Vercel ダッシュボード → Settings → Environment Variables の値と同じものを指定してください。"
    );
  }
  if (res.status === 404) {
    throw new Error(
      `この URL に API がありません（${API_BASE}）。接続先のドメインが違う可能性があります。\n` +
      "  本番は https://adl-exhibition-2026.vercel.app です（adl-2026-prototype は別プロジェクト）。\n" +
      "  --api か環境変数 API_BASE で指定できます。"
    );
  }
  if (!res.ok) throw new Error(`API が ${res.status} を返しました（${API_BASE}）`);
  const jobs = await res.json().catch(() => null);
  console.log(`[print-agent] API 接続OK ${API_BASE}（未処理ジョブ ${Array.isArray(jobs) ? jobs.length : "?"} 件）`);
}

// ---------- main ----------
async function main() {
  await preflight();
  const state = await loadState();
  if (args.since) state.lastId = args.since;

  if (args.once) {
    await pollOnce(state);
    return;
  }

  console.log(`[print-agent] 起動 API_BASE=${API_BASE} dryRun=${args.dryRun}`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await pollOnce(state);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  console.error("[print-agent] 致命的エラー:", e);
  process.exit(1);
});
