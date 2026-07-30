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
//   node print-agent/agent.mjs --api http://host:3010  # API_BASE の代わりに指定
//
// env: API_BASE(既定 http://localhost:3000) / PRINT_AGENT_TOKEN / PRINTER(lp -d)

import { PDFDocument } from "pdf-lib";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const POSTERS_DIR = path.join(ROOT, "data", "posters");
const WORKS_JSON = path.join(ROOT, "data", "works.json");
const OUT_DIR = path.join(__dirname, "out");
const STATE_FILE = path.join(__dirname, "state.json");
const CSV_FILE = path.join(__dirname, "survey.csv");
const CSV_HEADER = "id,createdAt,work1,work2,work3,emotion,visit,who,satisfaction,comment";

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
  const args = { dryRun: false, once: false, retryFailed: false, since: null, api: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--once") args.once = true;
    else if (a === "--retry-failed") args.retryFailed = true;
    else if (a === "--since") args.since = argv[++i] ?? null;
    else if (a === "--api") args.api = argv[++i] ?? null;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const API_BASE = args.api || process.env.API_BASE || "http://localhost:3000";
const TOKEN = process.env.PRINT_AGENT_TOKEN || "";
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
  const exists = await readFile(CSV_FILE, "utf8").then(() => true).catch(() => false);
  const row = [
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
  ].map(csvField).join(",") + "\r\n";
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
  const worksById = await loadWorksById();
  const [favId, subId1, subId2] = job.meta.workIds;

  const pdfDoc = await PDFDocument.create();

  // p1 表: front.jpg を全面
  const p1 = pdfDoc.addPage([A4_W, A4_H]);
  const frontImg = await pdfDoc.embedJpg(frontBuf);
  p1.drawImage(frontImg, { x: 0, y: 0, width: A4_W, height: A4_H });

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
    if (!work) throw new Error(`works.json に見つからない workId: ${subIds[i]}`);
    const bytes = await readFile(path.join(POSTERS_DIR, work.pdf));
    const srcDoc = await PDFDocument.load(bytes);
    const srcPage = srcDoc.getPages()[0];
    const embedded = await pdfDoc.embedPage(srcPage, LEFT_HALF_BOX);
    p2.drawPage(embedded, { x: i * SLOT_W, y: 0, width: SLOT_W, height: HALF_H });
  }

  return pdfDoc.save();
}

// ---------- API 呼び出し ----------
async function fetchJobs(after) {
  const url = new URL("/api/print-jobs", API_BASE);
  if (after) url.searchParams.set("after", after);
  const res = await fetch(url, { headers: TOKEN ? { "x-agent-token": TOKEN } : {} });
  if (!res.ok) throw new Error(`GET /api/print-jobs failed: ${res.status}`);
  return res.json();
}
async function fetchFront(frontUrl) {
  const res = await fetch(frontUrl, { headers: TOKEN ? { "x-agent-token": TOKEN } : {} });
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
    throw new Error(`lp failed (status ${result.status}): ${result.stderr || result.stdout}`);
  }
  console.log(`[print-agent] lp 送信: ${result.stdout.trim()}`);
}

// ---------- 1ジョブ処理 ----------
async function processJob(job) {
  console.log(`[print-agent] 処理開始 id=${job.id} works=${job.meta.workIds.join(",")}`);
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

// ---------- main ----------
async function main() {
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
