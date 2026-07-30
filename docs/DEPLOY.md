# デプロイと会場セットアップ

本番: **https://adl-exhibition-2026.vercel.app**（GitHub の main に push すると自動デプロイ）

| URL | 中身 |
|---|---|
| `/` | スクリーン投影用のメイングラフィックス（screen.html） |
| `/visit.html` | 来場者アプリ（NFC コレクション + リーフレット作成） |
| `/poster.html` | ポスターメーカー（旧ルート） |
| `/venue.html` | 会場3Dウォークスルー |
| `/graphic-lab.html` | リーフレット表面の調整ラボ |

配信レイアウトは `npm run sync` が `public/` を組み立てて決めている
（`public/index.html` ← screen.html、`public/poster.html` ← index.html）。
リポジトリ直下の `index.html` はポスターメーカーのままなので GitHub Pages 側は従来どおり。

---

## 稼働状況（2026-07-31 時点・本番で疎通確認ずみ）

- ✅ 全ページ配信、作品コレクション（NFC タグ → 集まる）、`/poster.png`
- ✅ Vercel Blob 接続ずみ（**private ストア**）。`POST /api/print-jobs` → 200
- ✅ `GET /api/latest`（survey を含まないことを確認）、`GET /api/my/<token>`、未知トークンは 404
- ✅ `PRINT_AGENT_TOKEN` 設定ずみ（トークンなしの `GET /api/print-jobs` は 401）
- ✅ 印刷エージェントが本番からジョブを取得 → A4 両面 PDF 生成まで成功

Blob は private なので、blob の URL に直接アクセスしても読めない。読み出しは全て
サーバー側の `get()` を通り、front.jpg も `GET /api/print-jobs?front=<id>`（トークン必須）
経由でしか取れない。アンケートの自由記述が公開URLに乗ることはない。

> ⚠️ **疎通確認用のテストジョブ `1785453802968-5577` が本番に1件残っている。**
> 会場で初めてエージェントを起動するときは `--since 1785453802968-5577` を付けること
> （付けないと、このテストジョブが1枚印刷される）。

---

## 1. 印刷 PC（Mac）のセットアップ

```bash
git clone https://github.com/rintaro-chujo/adl-2026-prototype.git
cd adl-2026-prototype
npm install
lpstat -p                      # プリンター名を確認
```

初回だけ、テストジョブを飛ばすために `--since` を付ける:

```bash
API_BASE=https://adl-exhibition-2026.vercel.app PRINT_AGENT_TOKEN=<設定した値> PRINTER=<プリンター名> npm run agent -- --since 1785453802968-5577
```

2回目以降は `print-agent/state.json` に処理ずみ ID が残るので `--since` は不要:

```bash
API_BASE=https://adl-exhibition-2026.vercel.app PRINT_AGENT_TOKEN=<設定した値> PRINTER=<プリンター名> npm run agent
```

- まず `--dry-run` を付けて `print-agent/out/*.pdf` を目視 → 実機で1枚テスト印刷して両面の向きを確認する
- 詳しくは [print-agent/README.md](../print-agent/README.md)
- アンケート回答は `print-agent/survey.csv` に追記される（Blob 側にも残る）

## 2. NFC タグ

[NFC_URLS.md](NFC_URLS.md) の一覧どおりに書き込む。**ドメインが変わると全部書き直しになる**ので、
書き込み前にこのドメインで確定しているか確認すること。

## 3. スクリーン（プロジェクター）

`https://adl-exhibition-2026.vercel.app/` を開いてダブルクリックで全画面。
PC のスリープと画面オフを無効にしておく。誰かがリーフレットを作ると 5 秒以内に反映される。

---

## メモ

- この Vercel プロジェクトは元々「静的サイト」としてビルドされていて `/api/*` と `/poster.png` が
  404 だった。`vercel.json` で `framework: nextjs` を宣言して解決している。**この設定は消さないこと。**
- `next.config.ts` の rewrites はこのプロジェクトでは効かなかったため使っていない。
  配信パスを変えたいときは `package.json` の `sync` を編集する。
- 作品の番号・セクションは `data/works.json` が正。変更したら
  `node scripts/build-posters.mjs`（画像再生成、番号を入れ替えたら `--force`）と
  `node scripts/make-nfc-urls.mjs`（URL 一覧の作り直し）を実行する。
