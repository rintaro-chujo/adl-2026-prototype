#!/usr/bin/env node
// data/works.json + data/sections.json から docs/NFC_URLS.md を生成する。
// 作品の番号やセクションを変えたら必ず実行し直すこと（タグの書き直しが必要になる）。
//   node scripts/make-nfc-urls.mjs [--base https://example.com]
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const argBase = process.argv.indexOf("--base");
const BASE = (argBase >= 0 ? process.argv[argBase + 1] : "https://adl-exhibition-2026.vercel.app").replace(/\/$/, "");
const TODAY = new Date().toISOString().slice(0, 10);

const works = JSON.parse(fs.readFileSync(path.join(ROOT, "data/works.json"), "utf8"));
const sections = JSON.parse(fs.readFileSync(path.join(ROOT, "data/sections.json"), "utf8"));
const url = (id) => `${BASE}/visit.html#g/${id}`;
const byId = (a, b) => a.id.localeCompare(b.id);

const L = [];
L.push("# NFC タグ書き込み URL 一覧", "");
L.push(`本番URL: **${BASE}**  /  更新日: ${TODAY}`, "");
L.push("## 書き込みかた", "");
L.push("- レコード種別は **URL(URI)** ひとつだけ。テキストレコードは不要です。");
L.push("- タグは **NTAG213 以上**（URLは約55バイトなので余裕で収まります）。");
L.push("- iPhone/Android どちらでもかざすだけで開きます。アプリ内スキャン（Android）でも同じURLを読み取ります。");
L.push("- 書き込み後は **ロック（読み取り専用化）推奨**。来場者の端末で誤って書き換えられるのを防げます。");
L.push("- 貼る位置は作品ポスターの下部など、手が届いてかざしやすい高さに。", "");
L.push("> ⚠️ **URLのドメインが変わるとタグは全部書き直しです。** 書き込み前にドメイン確定を確認してください。", "");
L.push(`## 全${works.length}タグ`, "");

for (const s of sections) {
  const list = works.filter((w) => w.section === s.n).sort(byId);
  if (!list.length) continue;
  L.push(`### ${String(s.n).padStart(2, "0")} ${s.title}${s.en ? " / " + s.en : ""}`, "");
  L.push("| 番号 | 作品名 | 書き込む URL |", "|---|---|---|");
  for (const w of list) L.push(`| ${w.id.slice(1)} | ${w.title} | \`${url(w.id)}\` |`);
  L.push("");
}
const orphans = works.filter((w) => !sections.some((s) => s.n === w.section)).sort(byId);
if (orphans.length) {
  L.push("### ⚠ セクション未割り当て", "");
  for (const w of orphans) L.push(`- ${w.id} ${w.title}: \`${url(w.id)}\``);
  L.push("");
}

L.push("## コピペ用（番号順・URLのみ）", "", "```");
for (const w of [...works].sort(byId)) L.push(url(w.id));
L.push("```", "");
L.push("## 参考: タグ以外のURL", "");
L.push("| 用途 | URL |", "|---|---|");
L.push(`| 来場者アプリ（コレクション） | \`${BASE}/visit.html\` |`);
L.push(`| スクリーン投影（メイングラフィックス） | \`${BASE}/\` |`);
L.push(`| ポスターメーカー | \`${BASE}/poster.html\` |`);
L.push(`| 会場3Dウォークスルー | \`${BASE}/venue.html\` |`);
L.push(`| グラフィックス調整ラボ | \`${BASE}/graphic-lab.html\` |`, "");
L.push("リーフレット印刷面のQRは送信時に自動生成され、");
L.push(`\`${BASE}/visit.html#my/<ランダム14文字>\` を指します（タグに書く必要はありません）。`, "");
L.push("---", "");
L.push("この一覧は `node scripts/make-nfc-urls.mjs` で works.json / sections.json から再生成できます。");

const out = path.join(ROOT, "docs/NFC_URLS.md");
fs.writeFileSync(out, L.join("\n") + "\n");
console.log(`docs/NFC_URLS.md を生成しました（${works.length}件 / base=${BASE}）`);
