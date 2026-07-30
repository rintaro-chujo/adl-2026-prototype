# 実装スペック — visit.html / screen.html / API / print-agent

PLAN_visit-app.md の実装契約。**ここに書かれた契約(ファイルパス・JSON形状・API)は全モジュール共通。勝手に変えない。**

## 共通デザインシステム
- 地色 `#F4EFE4` / 墨 `#2C2A26`(SVG内の文字色は `#3f3b3a`)
- フォント: Google Fonts `Cormorant Infant`(欧文) + `Shippori Mincho`(和文)。`<link>` で読み込み(weights 400;500;700)
- 展示タイトル: 日本語「モノにこころをあずけておりまして」/ 英語 "Things That Embrace your Heart"
- 7色パレット+感情ラベル: `window.LeafletGraphic.EMOTIONS`(assets/visit/graphic.js)を必ず使う
- UIの言葉づかいは丁寧で短く。絵文字は使わない

## 既存アセット(すべて実装済み・変更禁止)
- `assets/visit/graphic.js` … `window.LeafletGraphic = { makeSpec({seed,color,workIds}), render(canvas, spec, imagesMap, {t, typo, style, transparent}), mulberry32, hashSeed, STYLE, ANCHORS, EMOTIONS }`
  - spec = `{v:1, seed, color, blobs:[{cx,cy,r,imgId,harm:[{k,a,ph,om}]}×3]}`(正規化座標)。blobs[0]=大=お気に入り
  - render は毎フレーム呼べる(t=秒 でウニョウニョ)。canvas に `__lgKey` 文字列を設定すること(スクラッチ再利用キー)
  - 画像は `Map<workId, HTMLImageElement>`。`img.__focus=[x,y]` / `img.__crop=[x,y,w,h]` を works.json の `focus`/`crop` から設定する
- `assets/leaflet.svg` … リーフレット表面のタイポグラフィ(1683.78×2383.94)。ATC フォント置換+Google Fonts data-URI 埋め込みは graphic-lab.html の `buildFontCss`/`typoAt` 実装をそのまま流用
- `assets/posters/{id}.main.jpg / .thumb.jpg / .full.jpg`(40作品)
- `data/works.json` … `[{id:"w01", title, pdf, section:1-4, focus?, crop?}]`
- `data/sections.json` … `[{n, title, en}]`(タイトルは仮、後で差し替え)
- QR 配置(表面): viewBox 単位で size=197、位置 x=1683.78−93−197, y=2094.6。モジュールは隙間なし(+0.5px 重ね)、白背景なし、色 `#2C2A26`、クワイエットゾーンは地色。graphic-lab.html の `drawQrPlaceholder` と同じ幾何

## ジョブ JSON(契約の中心)
```jsonc
// POST /api/print-jobs リクエストボディ
{
  "v": 1,
  "spec": { /* LeafletGraphic.makeSpec の出力そのまま */ },
  "workIds": ["w12","w03","w40"],   // [0]=お気に入り。spec.blobs[i].imgId と一致
  "emotion": "wakuwaku",             // EMOTIONS.key
  "survey": {
    "visit": "SNSを見て",           // Q1 選択肢の文字列
    "who": "学生",                  // Q2
    "satisfaction": 4,               // Q3 1..5
    "comment": "…"                  // Q4 自由記述(空可, ≤2000字)
  },
  "front": "data:image/jpeg;base64,…" // 表面 2480×3508 JPEG q0.85(QR焼き込み済み)
}
// レスポンス: { "id": "1753960000000-ab12" }
```
- id は `${Date.now()}-${4桁ランダム}`(サーバー生成、辞書順=時系列)

## API(Next.js App Router)
`app/api/print-jobs/route.ts`:
- **POST**(公開): バリデーション(workIds `^w\d{2}$`×3・spec.blobs 3個・satisfaction 1-5・front は `data:image/jpeg;base64,` で ≤3.8MB・文字列は trim+長さ制限)。保存して `{id}` を返す。1 IP あたり 5 秒 1 回の素朴なメモリ内レート制限
- **GET**(印刷エージェント用): ヘッダ `x-agent-token` が `process.env.PRINT_AGENT_TOKEN` と一致必須(env 未設定時は開発用に許可+console.warn)。`?after=<id>` より新しいジョブの `[{id, meta, frontUrl}]` を返す(meta = front 抜きのジョブJSON)

`app/api/latest/route.ts`:
- **GET**(公開・スクリーンモード用): `{id, createdAt, spec, workIds, emotion}` か `null`。**survey は絶対に含めない**。`Cache-Control: no-store`

ストレージ(`lib/jobs-store.ts` に分離。visit/screen/agent からは API 経由のみ):
- `BLOB_READ_WRITE_TOKEN` があれば `@vercel/blob`: `jobs/{id}/meta.json`, `jobs/{id}/front.jpg`, `latest.json`(`addRandomSuffix:false, allowOverwrite:true`, access:public)
- なければローカル開発フォールバック: `.data/jobs/{id}/…` と `.data/latest.json` に fs 書き込み(.gitignore に `.data/` 追加)

## visit.html(スマホSPA・自己完結1ファイル+SW)
ハッシュルーティング(`hashchange`、ドキュメント再ロードなし):
- `#`(home) … ヒーロー+コレクション
- `#g/<id>` … 作品ゲット処理(下記)→ home 表示に戻す(history.replaceState で `#` へ)
- `#leaflet` … リーフレットモード開始
- `#my/<id>,<id>,<id>` … QR用ビュー(選んだ3作品の full.jpg を縦に大きく閲覧、タイトル付き。サーバー不要)

**ヒーロー(100dvh)**: graphic.js で色ブロブ3つ(画像なし、パレットからランダム)を常時アニメーション(rAF、t秒、プレビュー解像度は devicePixelRatio 上限 2)。取得済み作品が3つ以上あればランダムな3作品の画像入りブロブにする。左上に日本語タイトル(Shippori Mincho 縦書きでなく横書き・固定表示)、右下に英語タイトル(Cormorant Infant italic)。下部に「n / 40」と下向き矢印。**バックグラウンドタブでは rAF を止める**(visibilitychange)

**コレクション**: sections.json の順に小見出し(title + en)、各セクションの作品を2カラムグリッド(横ポスター比率のカード)。未取得= 地色より一段沈んだプレースホルダー(番号のみ、すりガラス風)。取得済み= thumb.jpg。タップ→詳細オーバーレイ(full.jpg、ピンチ/ダブルタップズーム、閉じる、PDF リンク `data/posters/<pdf>` は本番非同梱なので出さない)。進捗は localStorage

**ゲット演出**: `#g/<id>` 受信時(URL経由・Web NFC 経由共通の関数で): 未取得なら — 画面を暗く→カード(thumb)が画面下から X軸に2〜3回転しながらせり上がり中央で静止(CSS 3D transform+transition、約1.2s)→タイトル表示→1.5秒後 or タップでグリッドの該当セルへ FLIP アニメで吸い込まれる→セルがふわっと光る。取得済みなら詳細を開くだけ。リーフレットモード中ならスロット充填(下記)

**Web NFC**: `'NDEFReader' in window` なら右下に固定「タグをスキャン」ボタン(フローティング)。開始後は reading イベントの URL レコードから `#g/<id>` を抽出して同じゲット関数へ。エラーは小さくトースト表示

**リーフレットモード**(画面下固定ボタン「気になった作品でリーフレットをつくる」→):
1. スロット3つ(1つ目に★お気に入りバッジ)。NFCスキャン or コレクションの取得済みカードのタップで充填。重複はプルプル震わせて拒否。スロット長押し(500ms)で外す。3つ埋まると「つぎへ」
2. 気持ち選択: EMOTIONS の7つを大きめチップで(色+ラベル)。選択で即 makeSpec({seed: Date.now()%1e6, color, workIds})+**300ppi(2480×3508) レンダリングをバックグラウンド開始**(typoAt(2480,3508)+QR焼き込み→ toBlob jpeg 0.85 → dataURL 保持)
3. アンケート: Q1 ご来場のきっかけ(ラジオ: 出展者・研究室の知人 / SNSを見て / 大学・学校関係 / たまたま通りかかって / その他) Q2 あなたについて(ラジオ: 学生 / 研究・教育関係 / デザイン・クリエイティブ関係 / その他) Q3 展示の満足度(1〜5 の星orセグメント、5=とても満足) Q4 展示の中でもっともこころが動いたこと・その他コメント(textarea 任意)
4. 送信: 2 のレンダ完了を待って POST。送信中スピナー→完了画面: プレビュー(spec をプレビュー解像度で再レンダ+QR)+「あなただけのリーフレットができました。まもなくプリンターから出てきます」+ QRの説明(あとから3作品を見返せる)+「コレクションにもどる」。POST 失敗時はリトライボタン(dataURL は保持)
- モード状態・途中経過は localStorage(`pmv.leaflet`)に持ち、リロードでも復元

**QR**: `assets/visit/qr.js`(vendored qrcode-generator)で `location.origin + location.pathname + '#my/' + ids.join(',')` をエンコード、誤り訂正 M。描画幾何は上記契約どおり

**localStorage キー**: `pmv.collection` = `{[workId]: 取得エポックms}` / `pmv.leaflet` = `{active, slots:[], emotion, spec, surveyDraft}` / `pmv.heroSeed` 任意
**?debug=1**: 右上に開発パネル — 任意の作品ID入力+「スキャン模擬」、ランダム5作品取得、全消去。NFC なし環境のテスト用
**Service Worker `visit-sw.js`+`manifest.webmanifest`**: プリキャッシュ(visit.html, graphic.js, qr.js, leaflet.svg, works.json, sections.json)+ `assets/posters/` は cache-first ランタイムキャッシュ。`VERSION` 定数でバスト。**localhost では登録しない**(開発の邪魔)。manifest: name=モノにこころをあずけておりまして, display=standalone, 背景/テーマ色は地色, icons は assets/visit/icon-192.png / icon-512.png

## screen.html(プロジェクター投影)
- フルスクリーン地色。中央領域に現在ジョブの spec を graphic.js でアニメ描画(rAF、t 連続、images は main.jpg)。タイポグラフィは描かない。左上に日本語タイトル・右下に英語タイトルを小さく(ヒーローと同じ配置言語)
- 5秒ごと `GET /api/latest`(`?poll=` で変更可)。新しい id が来たら**押し出しトランジション**: 現行キャンバスが上へスライドアウトしつつ新 spec が下からスライドイン(1.4s, ease-in-out。2枚のキャンバスを translateY するか 1枚に 2 spec を y オフセット描画)
- ジョブがまだ無い/エラー時: デフォルトスペック(ランダム作品3+ランダム感情色、seed 固定配列)を 30 秒ごとに同じ押し出しで巡回
- 解像度: min(window, 1920×1080) 相当。ダブルクリックで requestFullscreen。カーソル自動非表示
- 会場では同一オリジン(Vercel or ローカル)で開く想定。`?api=` で API ベースURL上書き可(ローカル print PC で静的配信+本番API の構成用)

## print-agent/(Mac・Node)
`print-agent/agent.mjs`(deps: pdf-lib のみ。repo ルートの node_modules を使う):
- env/flags: `API_BASE`(default http://localhost:3000)、`PRINT_AGENT_TOKEN`、`PRINTER`(lp -d)、`--dry-run`(印刷せず out/ に PDF 保存)、`--once`、`--since <id>`
- 3秒ポーリング → 新ジョブごとに: meta+front.jpg 取得 → PDF 合成 → `lp -o media=A4 -o sides=two-sided-long-edge`(PRINTER 指定時 -d)→ `print-agent/state.json` に処理済み id 記録 → `print-agent/survey.csv` に追記(header: id,createdAt,work1,work2,work3,emotion,visit,who,satisfaction,comment。RFC4180 エスケープ)
- **PDF(A4縦 595.28×841.89pt)**:
  - p1 表: front.jpg を embedJpg して全面(595.28×841.89)
  - p2 裏: 上半分(y 420.94〜841.89)= お気に入り(workIds[0])の PDF 1ページ目を `data/posters/` から embedPdf、**contain・無トリミング・中央**(横4161×2976pt → 幅588.6×高420.94、左右余白 ≈3.3pt)。下半分 = workIds[1], workIds[2] を各 A6縦スロット(297.64×420.94)に**左半分クロップ**で: embedPage の boundingBox `{left:0, right:2080.5, bottom:16.85, top:2959.15}`(比率 0.7071 に合わせ上下 16.85pt ずつトリム)
  - 失敗したジョブはスキップして state に `failed` 記録、次回リトライは `--retry-failed`
- `print-agent/README.md`: 会場セットアップ手順(vercel env の値取得、テスト印刷、lp の確認コマンド、両面の向き確認)

## ビルド/同期
- `npm run sync` に追加: visit.html, screen.html, graphic-lab.html, visit-sw.js, manifest.webmanifest → public/ ; data/works.json+sections.json → public/data/ ; assets はまるごとコピー(既存)
- `scripts/make-icons.mjs`: @resvg/resvg-js(既存dep)で地色+珊瑚ブロブの簡単な SVG から icon-192/512.png を assets/visit/ に生成
- `.gitignore` に `.data/`, `print-agent/out/`, `print-agent/state.json`, `print-agent/survey.csv`
- package.json deps 追加: `@vercel/blob`, `pdf-lib`, `qrcode-generator`(vendor 用) / scripts: `"agent": "node print-agent/agent.mjs"`
- qrcode-generator の vendor: `node_modules/qrcode-generator/qrcode.js` を `assets/visit/qr.js` にコピー(先頭にライセンスコメント維持)

## 検証基準(実装エージェントは最低限ここまで自走)
- `npm run build` が通る(型エラーなし)
- API: `next dev` + curl で POST→GET(after)→latest の一連が通る(ローカル .data フォールバック)
- print-agent: `--dry-run --once` でサンプルジョブから PDF が生成され、`pdfinfo` で 2 ページ・A4 サイズを確認
- visit/screen: 構文エラーなしで開けて、?debug=1 の模擬スキャンで一連のフローが動く(視覚調整は統合レビューで Fable が行う)
