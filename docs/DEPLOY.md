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

## 稼働ずみ / 未設定

- ✅ 全ページ配信、作品コレクション（NFC タグを読む → 集まる）、`/poster.png`、`GET /api/latest`
- ❌ **リーフレットの送信・印刷・スクリーンへの反映** … Vercel Blob 未接続のため `POST /api/print-jobs` が 503

`POST` は原因が分かるメッセージを返すので、設定できたかは下記コマンドで確認できる。

```bash
curl -s -X POST https://adl-exhibition-2026.vercel.app/api/print-jobs -H 'Content-Type: application/json' -d '{"v":1}'
```

`{"error":"invalid v"}` 等のバリデーションエラーが返れば Blob は接続済み。
`BLOB_READ_WRITE_TOKEN が未設定です…` が返るならまだ未接続。

---

## 1. Vercel Blob を接続する（必須・ダッシュボード作業）

1. Vercel ダッシュボード → プロジェクト `adl-exhibition-2026` → **Storage** タブ
2. **Create Database** → **Blob** を選択 → 名前は任意（例 `adl-exhibition-blob`）
3. 作成後、そのプロジェクトに **Connect**（`BLOB_READ_WRITE_TOKEN` が自動で環境変数に入る）
4. **Deployments** タブ → 最新デプロイの ⋯ → **Redeploy**（環境変数は再デプロイで反映される）

## 2. 印刷エージェント用のトークンを設定する（必須）

1. 適当な長い文字列を作る（例: `openssl rand -hex 24`）
2. ダッシュボード → **Settings** → **Environment Variables** に追加
   - Name: `PRINT_AGENT_TOKEN` / Value: 生成した文字列 / Environment: Production
3. Redeploy
4. 同じ値を印刷 PC の環境変数にも設定する（下記）

> 未設定でも動くが、その場合 `GET /api/print-jobs`（ジョブ一覧＝アンケート回答を含む）が
> 誰でも取得できてしまう。**本番では必ず設定すること。**

## 3. 印刷 PC（Mac）のセットアップ

```bash
git clone https://github.com/rintaro-chujo/adl-2026-prototype.git
cd adl-2026-prototype
npm install
lpstat -p                      # プリンター名を確認
```

```bash
API_BASE=https://adl-exhibition-2026.vercel.app PRINT_AGENT_TOKEN=<設定した値> PRINTER=<プリンター名> npm run agent
```

- まず `--dry-run` を付けて `print-agent/out/*.pdf` を目視 → 実機で1枚テスト印刷して両面の向きを確認する
- 詳しくは [print-agent/README.md](../print-agent/README.md)
- アンケート回答は `print-agent/survey.csv` に追記される（Blob 側にも残る）

## 4. NFC タグ

[NFC_URLS.md](NFC_URLS.md) の一覧どおりに書き込む。**ドメインが変わると全部書き直しになる**ので、
書き込み前にこのドメインで確定しているか確認すること。

## 5. スクリーン（プロジェクター）

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
