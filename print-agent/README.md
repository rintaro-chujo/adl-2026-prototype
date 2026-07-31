# print-agent — 会場プリントPC セットアップ手順

会場の Mac（プリント担当PC）で `/api/print-jobs` をポーリングし、来場者のマイリーフレットを
A4縦・両面で自動印刷するエージェント。依存は `pdf-lib` のみで、リポジトリルートの
`node_modules` を使う（`npm install` 済みのチェックアウトで動かす）。

## 1. 事前準備

**`agent.mjs` だけをコピーしても動かない。** リーフレットの裏面は `data/posters/` の
元PDFから合成するので、リポジトリごと持ってくる必要がある。

```sh
git clone https://github.com/rintaro-chujo/adl-2026-prototype.git
cd adl-2026-prototype
npm install
```

- Node.js 20 以上（`node -v` で確認）。
- 対象プリンタが macOS に追加済みで、両面印刷（長辺とじ）に対応していること。
  `lpstat -p` でプリンタ名を確認する。

`npm install` を忘れても、エージェントは起動時に `pdf-lib` の有無を確認して
自動でインストールしてから続行する。起動前チェックでは他に、リポジトリ内で
実行されているか / プリンタがあるか / API に到達できてトークンが合っているか
も確認し、問題があれば日本語で理由を出して止まる。

> よくある失敗: デスクトップに置いた `agent.mjs` を実行して
> `Cannot find package 'pdf-lib'` や `Could not read package.json` になる。
> 上のとおり clone したフォルダの中で実行すること。

## 2. Vercel の環境変数の値を取得

本番の Vercel プロジェクトから以下を確認する（Vercel Dashboard → Project → Settings →
Environment Variables、または `vercel env pull`）:

- `PRINT_AGENT_TOKEN` … `/api/print-jobs` の GET に必須のトークン。visit側の POST には不要。
- （`BLOB_READ_WRITE_TOKEN` はサーバー側だけで使うのでプリントPCには不要）

取得した値を、プリントPC側の環境変数として設定する（`.zshrc` などに追記、または起動時に指定）。

```sh
export PRINT_AGENT_TOKEN="<vercelから取得した値>"
export API_BASE="https://<本番ドメイン>"      # 会場LANから直接ローカルAPIを叩けない場合
export PRINTER="<lpstat -p で確認したプリンタ名>"
```

## 3. テスト印刷（まず dry-run で確認）

```sh
cd <このリポジトリ>
node print-agent/agent.mjs --dry-run --once
```

- `print-agent/out/<job-id>.pdf` にPDFが生成される。`open print-agent/out/` で開いて
  レイアウトを目で確認する（表=グラフィックス、裏=上にお気に入り作品、下に残り2作品）。
- `pdfinfo print-agent/out/<job-id>.pdf` で 2ページ・595.28×841.89pt(A4縦) を確認できる。

## 4. lp の確認コマンド

プリンタ名や両面対応を確認してから、実際に1枚テスト印刷する:

```sh
lpstat -p                              # プリンタ名・状態の確認
lpoptions -l -p <プリンタ名>            # 両面(Duplex)オプションが選べるか確認

# 実際にエージェント経由でテスト印刷(1件だけ処理して終了)
node print-agent/agent.mjs --once
```

エージェントは内部で以下を実行する（`PRINTER` 未設定時は既定プリンタに送られる）:

```sh
lp -o media=A4 -o sides=two-sided-long-edge -d <PRINTER> <pdfファイル>
```

## 5. 両面の向き確認

- `sides=two-sided-long-edge` は長辺とじ（縦向きのA4を長辺で綴じる想定）。
  プリンタのADF/手動両面ユニットの設定と合っているか、テスト印刷の実物で確認する:
  - 表(1ページ目)がグラフィックス+QR、裏(2ページ目)を透かして見た時に**上下が正しく揃っているか**
    （長辺とじでない設定だと裏面が180°回転して出てくることがある）。
  - 裏面レイアウト: 上半分にお気に入り作品のポスターがそのまま(無トリミング)、下半分に
    残り2作品が左半分だけ縦2枚で並ぶ。

## 6. 本番運用

```sh
node print-agent/agent.mjs
```

- 3秒間隔で `/api/print-jobs` をポーリングし、新しいジョブごとに印刷 + `survey.csv` に追記する。
- 処理済みIDは `print-agent/state.json` に記録される（再起動しても続きから）。
- 1件のジョブ処理に失敗しても止まらず、次のジョブへ進む。失敗IDは `state.json` の `failed` に
  記録され、以下で後からまとめて再試行できる:

  ```sh
  node print-agent/agent.mjs --retry-failed --once
  ```

- 特定のIDより後から再開したい場合（`state.json` を直接編集する代わりに）:

  ```sh
  node print-agent/agent.mjs --since <job-id>
  ```

## フラグ・環境変数まとめ

| 名前 | 種別 | 説明 |
|---|---|---|
| `API_BASE` | env（既定 `http://localhost:3000`） | APIのベースURL |
| `--api <url>` | flag | `API_BASE` の代わりにその場で指定 |
| `PRINT_AGENT_TOKEN` | env | `/api/print-jobs` GET 用トークン |
| `PRINTER` | env | `lp -d` で指定するプリンタ名（未指定なら既定プリンタ） |
| `--dry-run` | flag | 印刷せず `print-agent/out/` にPDF保存のみ |
| `--once` | flag | 1回ポーリングして終了（継続ポーリングしない） |
| `--since <id>` | flag | このID以降から再開（`state.json` の一時的な上書き） |
| `--retry-failed` | flag | 失敗記録済みのジョブだけ再試行 |

出力・記録ファイル（`.gitignore` 済み）:

- `print-agent/out/*.pdf` … 生成したPDF（dry-run時・本番時とも保存される）
- `print-agent/state.json` … 処理済み/失敗ジョブIDの記録
- `print-agent/survey.csv` … アンケート集計用CSV（`id,createdAt,work1,work2,work3,emotion,visit,who,satisfaction,comment`）
