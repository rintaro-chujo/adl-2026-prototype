// マイリーフレット表面グラフィックス 共通描画モジュール
// 用途: ①スマホでの印刷用 300ppi PNG ②完了画面プレビュー ③スクリーンモードのアニメ表示
// スペック(seed/色/作品ID/配置)は正規化座標(x,r: ページ幅基準 / y: ページ高さ基準)で持ち、
// どの解像度のキャンバスでも同じ絵になる。
(function () {
  const TAU = Math.PI * 2;

  // ---- seeded RNG (index.html と同じ mulberry32) ----
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const hashSeed = s => { // 文字列 seed も許す
    if (typeof s === "number") return s >>> 0;
    let h = 2166136261;
    for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  };

  // ---- 配置アンカー(A4縦・正規化)。大=お気に入り、小2つ。 ----
  const ANCHORS = [
    { cx: 0.615, cy: 0.33, r: 0.290 },
    { cx: 0.30, cy: 0.60, r: 0.175 },
    { cx: 0.635, cy: 0.775, r: 0.150 },
  ];
  const MARGIN_X = 0.06, MARGIN_TOP = 0.055, MARGIN_BOTTOM = 0.075;

  function makeSpec({ seed, color, workIds }) {
    const rnd = mulberry32(hashSeed(seed));
    // ジッター配置 + 重なり回避(数回試して一番マシな配置を採用)
    let best = null, bestScore = -1;
    for (let attempt = 0; attempt < 24; attempt++) {
      const pos = ANCHORS.map(a => {
        const r = a.r * (0.92 + 0.16 * rnd());
        return {
          cx: clamp(a.cx + (rnd() - 0.5) * 0.09, MARGIN_X + r, 1 - MARGIN_X - r),
          cy: clamp(a.cy + (rnd() - 0.5) * 0.07, MARGIN_TOP + r / 1.414, 1 - MARGIN_BOTTOM - r / 1.414),
          r,
        };
      });
      let minGap = Infinity;
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        const dx = (pos[i].cx - pos[j].cx), dy = (pos[i].cy - pos[j].cy) * 1.414; // y は高さ基準→幅基準へ
        const gap = Math.hypot(dx, dy) - (pos[i].r + pos[j].r) * 1.03;
        minGap = Math.min(minGap, gap);
      }
      if (minGap > bestScore) { bestScore = minGap; best = pos; }
      if (minGap > 0.005) break;
    }
    const blobs = best.map((p, i) => ({
      ...p,
      imgId: workIds[i],
      harm: [2, 3, 5].map((k, j) => ({
        k,
        a: [0.050, 0.038, 0.020][j] * (0.7 + 0.6 * rnd()),
        ph: rnd() * TAU,
        om: (0.12 + 0.10 * rnd()) * (rnd() < 0.5 ? -1 : 1),
      })),
    }));
    return { v: 1, seed, color, blobs };
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function tracePath(ctx, cx, cy, R, harm, t) {
    const N = 160;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * TAU;
      let f = 1;
      for (const h of harm) f += h.a * Math.sin(h.k * th + h.ph + h.om * t);
      const r = R * f;
      const x = cx + r * Math.cos(th), y = cy + r * Math.sin(th);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.closePath();
  }

  // 見た目パラメータ(ラボで調整して確定させる)
  // 2026-07-31 ユーザー調整値(graphic-lab.html で引き続き調整可)
  const STYLE = {
    bg: "#F4EFE4",
    featherR: 0.07,    // 縁のフェザー量 (×R)
    imgBlurR: 0.00,    // 画像(中心部)のごく薄い柔らかさ (×R)
    edgeBlurR: 0.09,   // 縁ぞいの画像のとろけ量 (×R)
    coreR: 0.96,       // シャープに見せる中心域 (×R)
    coreBlurR: 0.16,   // 中心域→縁への移行のなだらかさ (×R)
    veilAlpha: 0.20,   // 地色ベールで画像トーンを揃える
    rimWidthR: 0.41,   // 色リムのストローク幅 (×R) — 輪郭をまたいで上に載る
    rimBlurR: 0.13,    // 色リムのぼかし (×R)
    rimAlpha: 1.00,
    haloBlurR: 0.08,   // 図形の外へ滲む色 (×R)
    haloAlpha: 0.08,
    blobAlpha: 0.63,
  };

  // オフスクリーンをブロブごとに使い回してアニメ時の GC を抑える
  const scratch = new Map();
  function getScratch(key, S) {
    let set = scratch.get(key);
    if (!set || set.size !== S) {
      set = {
        size: S, mask: mk(S), maskF: mk(S), band: mk(S), core: mk(S),
        layer: mk(S), soft: mk(S), tmp: mk(S), rim: mk(S), rimF: mk(S), halo: mk(S),
      };
      scratch.set(key, set);
    }
    for (const k of ["mask", "maskF", "band", "core", "layer", "soft", "tmp", "rim", "rimF", "halo"]) {
      const c = set[k].getContext("2d");
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, S, S); c.restore();
    }
    return set;
  }
  // ---- キャンバス種別と「ぼかしが実際に効くか」の判定 ----
  // iOS Safari は OffscreenCanvas の 2D context で ctx.filter を黙って無視する。
  // 気づかないと「ぼけないポスター」が刷られてしまうので、起動時に実測して選ぶ。
  let CANVAS_KIND = null;   // "offscreen" | "dom"
  let NATIVE_BLUR = false;  // ctx.filter = blur() が本当に効くか

  const newOffscreen = (w, h) => new OffscreenCanvas(w, h);
  const newDom = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };

  function probeBlur(make) {
    try {
      const c = make(16, 16);
      const x = c.getContext("2d", { willReadFrequently: true });
      if (!x || !("filter" in x)) return false;
      x.clearRect(0, 0, 16, 16);
      x.filter = "blur(3px)";
      x.fillStyle = "#000";
      x.fillRect(6, 6, 4, 4);
      x.filter = "none";
      // 矩形の外側にも色が滲んでいれば、ぼかしが効いている
      return x.getImageData(3, 8, 1, 1).data[3] > 3;
    } catch (e) { return false; }
  }

  function initCanvasKind() {
    if (CANVAS_KIND) return;
    // 検証・切り分け用の強制指定（?blur=native / ?blur=fallback 相当）
    if (typeof window !== "undefined" && window.__LG_BLUR_MODE === "fallback") {
      CANVAS_KIND = "dom"; NATIVE_BLUR = false; return;
    }
    if (typeof OffscreenCanvas !== "undefined" && probeBlur(newOffscreen)) {
      CANVAS_KIND = "offscreen"; NATIVE_BLUR = true;
    } else if (typeof document !== "undefined" && probeBlur(newDom)) {
      CANVAS_KIND = "dom"; NATIVE_BLUR = true;   // Safari は通常のキャンバスなら効く
    } else {
      CANVAS_KIND = typeof document !== "undefined" ? "dom" : "offscreen";
      NATIVE_BLUR = false;                        // 縮小→拡大で代用する
    }
  }

  const mk2 = (w, h) => {
    initCanvasKind();
    return CANVAS_KIND === "offscreen" ? newOffscreen(w, h) : newDom(w, h);
  };
  const mk = S => mk2(S, S);

  // 縮小→拡大による近似ぼかし用の作業キャンバス(サイズごとに使い回す)
  const tmpCache = new Map();
  function tmpCanvas(w, h) {
    const key = w + "x" + h;
    let c = tmpCache.get(key);
    if (!c) {
      if (tmpCache.size > 24) tmpCache.clear();
      c = mk2(w, h);
      tmpCache.set(key, c);
    }
    const x = c.getContext("2d");
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, w, h);
    return c;
  }

  // src を半径 r でぼかして dst の (dx,dy) に描く。
  // dst 側の globalAlpha / globalCompositeOperation はそのまま活きる。
  function blurInto(dst, src, r, dx, dy) {
    dx = dx || 0; dy = dy || 0;
    if (!(r > 0.2)) { dst.drawImage(src, dx, dy); return; }
    if (NATIVE_BLUR) {
      dst.save();
      dst.filter = `blur(${r}px)`;
      dst.drawImage(src, dx, dy);
      dst.restore();
      return;
    }
    // ctx.filter が使えない環境(古い iOS など)向け: 一度小さく描いてから戻す。
    // フェザーやリムのような低周波の形なら、これで十分なめらかになる。
    const sw = src.width, sh = src.height;
    const k = Math.max(2, Math.min(48, Math.round(r / 1.4)));
    const w = Math.max(1, Math.round(sw / k)), h = Math.max(1, Math.round(sh / k));
    const small = tmpCanvas(w, h);
    const sx = small.getContext("2d");
    sx.imageSmoothingEnabled = true;
    sx.imageSmoothingQuality = "high";
    sx.drawImage(src, 0, 0, w, h);
    dst.save();
    dst.imageSmoothingEnabled = true;
    dst.imageSmoothingQuality = "high";
    dst.drawImage(small, dx, dy, sw, sh);
    dst.restore();
  }

  const colorLum = hex => {
    const n = parseInt(hex.slice(1), 16);
    return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
  };

  // 画像の平均輝度(0..1)。ベールの適応量に使う
  function measureLum(img) {
    const c = mk(8), x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0, 8, 8);
    const d = x.getImageData(0, 0, 8, 8).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return s / (d.length / 4) / 255;
  }

  function renderBlob(main, blob, img, color, t, W, H, key, style) {
    const R = blob.r * W, cx = blob.cx * W, cy = blob.cy * H;
    const pad = R * 0.55;
    const S = Math.ceil((R + pad) * 2);
    const c0 = S / 2; // ローカル中心
    const sc = getScratch(key, S);

    // 1) フェザーマスク(全体) と 縁バンドマスク(全体 − 中心域)
    {
      const m = sc.mask.getContext("2d");
      m.fillStyle = "#fff";
      tracePath(m, c0, c0, R, blob.harm, t);
      m.fill();
      blurInto(sc.maskF.getContext("2d"), sc.mask, R * style.featherR);
      // band = maskF から「中心域(縮小形をぼかしたもの)」をくり抜いた輪っか
      const core = sc.core.getContext("2d");
      core.fillStyle = "#fff";
      tracePath(core, c0, c0, R * style.coreR, blob.harm, t);
      core.fill();
      const b = sc.band.getContext("2d");
      b.drawImage(sc.maskF, 0, 0);
      b.globalCompositeOperation = "destination-out";
      blurInto(b, sc.core, R * style.coreBlurR);
      b.globalCompositeOperation = "source-over";
    }

    // 2) 画像レイヤー: 中心はほぼシャープ、縁ぞいだけとろけるように
    const L = sc.layer.getContext("2d");
    const drawCover = (c, blur) => {
      // 最大半径 R×(1+Σa) + フェザー分を覆う。既定 2.34 は印刷確定値なので変えない。
      // スクリーンモードのように変形を強める場合は style.coverSide を大きくして欠けを防ぐ
      const side = R * (style.coverSide || 2.34);
      // 仮想クロップ(img.__crop = [x,y,w,h] 0..1): 元画像のサブ矩形だけを使う
      const [cx0, cy0, cw, ch] = img.__crop || [0, 0, 1, 1];
      const sx = img.width * cx0, sy = img.height * cy0;
      const sw = img.width * cw, sh = img.height * ch;
      const s = Math.max(side / sw, side / sh);
      const dw = sw * s, dh = sh * s;
      // フォーカス点(img.__focus = [0..1,0..1] クロップ内基準)をブロブ中央へ。カバーが切れない範囲にクランプ
      const [fx, fy] = img.__focus || [0.5, 0.5];
      const dx = clamp(c0 - dw * fx, c0 + side / 2 - dw, c0 - side / 2);
      const dy = clamp(c0 - dh * fy, c0 + side / 2 - dh, c0 - side / 2);
      c.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
    };
    if (img) {
      // 素のカバー画像を1枚だけ作り、中心用と縁用でぼかし量を変えて使い回す
      drawCover(sc.tmp.getContext("2d"));
      blurInto(L, sc.tmp, R * style.imgBlurR);
      L.globalCompositeOperation = "destination-in";
      L.drawImage(sc.maskF, 0, 0);
      L.globalCompositeOperation = "source-over";
      // 縁バンドにだけ強くぼかした画像を重ねる
      const soft = sc.soft.getContext("2d");
      blurInto(soft, sc.tmp, R * style.edgeBlurR);
      soft.globalCompositeOperation = "destination-in";
      soft.drawImage(sc.band, 0, 0);
      soft.globalCompositeOperation = "source-over";
      L.drawImage(sc.soft, 0, 0);
    } else {
      L.globalAlpha = 0.35;
      L.fillStyle = color;
      L.fillRect(0, 0, S, S);
      L.globalAlpha = 1;
      L.globalCompositeOperation = "destination-in";
      L.drawImage(sc.maskF, 0, 0);
      L.globalCompositeOperation = "source-over";
    }

    // 3) 地色ベール(トーンを揃え、うるささを抑える)。暗い画像ほど強めて文字の可読性を守る
    let veil = style.veilAlpha;
    if (img) {
      if (img.__lum === undefined) img.__lum = measureLum(img);
      veil = Math.min(0.5, veil + Math.max(0, 0.55 - img.__lum) * 0.6);
    }
    L.globalCompositeOperation = "source-atop";
    L.globalAlpha = veil;
    L.fillStyle = style.bg;
    L.fillRect(0, 0, S, S);
    L.globalAlpha = 1;
    L.globalCompositeOperation = "source-over";

    // 4) 外側ハロー(選んだ色が図形の外へぼんやり滲む) — 本体より先に敷く
    const hc = sc.halo.getContext("2d");
    hc.fillStyle = color;
    tracePath(hc, c0, c0, R * 1.04, blob.harm, t);
    hc.fill();
    main.save();
    main.globalAlpha = style.haloAlpha;
    blurInto(main, sc.halo, R * style.haloBlurR, cx - c0, cy - c0);
    main.restore();

    // 5) 本体合成
    main.save();
    main.globalAlpha = style.blobAlpha;
    main.drawImage(sc.layer, cx - c0, cy - c0);
    main.restore();

    // 6) 色リム: 輪郭をまたいで上に載る、ぼかした太いリング(スケッチの筆致)
    // 墨のような暗色はタイトル文字(同系色)を沈めるので透明度を落とす
    {
      const cl = colorLum(color);
      const rimAlpha = style.rimAlpha * (cl < 0.3 ? 0.55 + cl : 1);
      const r = sc.rim.getContext("2d");
      r.strokeStyle = color;
      r.lineWidth = R * style.rimWidthR;
      r.lineJoin = "round";
      tracePath(r, c0, c0, R, blob.harm, t);
      r.stroke();
      blurInto(sc.rimF.getContext("2d"), sc.rim, R * style.rimBlurR);
      main.save();
      main.globalAlpha = rimAlpha;
      main.drawImage(sc.rimF, cx - c0, cy - c0);
      main.restore();
    }
  }

  // spec + 画像(imgId→Image の Map)をキャンバス全面に描く。
  // opts: t=アニメ時刻(秒), typo=タイポグラフィ画像(最前面), style上書き, bgなし(transparent)
  function render(canvas, spec, images, opts = {}) {
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    const style = Object.assign({}, STYLE, opts.style || {});
    const t = opts.t || 0;
    ctx.clearRect(0, 0, W, H);
    if (opts.transparent !== true) {
      ctx.fillStyle = style.bg;
      ctx.fillRect(0, 0, W, H);
    }
    spec.blobs.forEach((b, i) => {
      const img = images instanceof Map ? images.get(b.imgId) : images[b.imgId];
      renderBlob(ctx, b, img || null, spec.color, t, W, H, `${canvas.__lgKey || "c"}:${i}:${W}`, style);
    });
    if (opts.typo) ctx.drawImage(opts.typo, 0, 0, W, H);
  }

  // 「今の気持ち」↔ メインカラー(デザインシステム7色)。visit / screen / lab で共用
  const EMOTIONS = [
    { key: "wakuwaku", label: "わくわく", hex: "#C75C5C" },
    { key: "odayaka", label: "おだやか", hex: "#A6CFE3" },
    { key: "ureshii", label: "うれしい", hex: "#F1C4D1" },
    { key: "jinwari", label: "じんわり", hex: "#EFD884" },
    { key: "sukkiri", label: "すっきり", hex: "#A9C56C" },
    { key: "natsukashii", label: "なつかしい", hex: "#C9C6E4" },
    { key: "shinmiri", label: "しんみり", hex: "#3B3A38" },
  ];

  // ぼかしの実装が今どちらを使っているか（会場での切り分け用）。
  // setBlurMode("fallback") で ctx.filter を使わない経路を強制できる。
  function blurInfo() {
    initCanvasKind();
    return { canvas: CANVAS_KIND, nativeBlur: NATIVE_BLUR };
  }
  function setBlurMode(mode) {
    CANVAS_KIND = null;
    scratch.clear();
    tmpCache.clear();
    if (typeof window !== "undefined") window.__LG_BLUR_MODE = mode === "fallback" ? "fallback" : null;
    return blurInfo();
  }

  window.LeafletGraphic = {
    makeSpec, render, mulberry32, hashSeed, STYLE, ANCHORS, EMOTIONS,
    blurInfo, setBlurMode,
  };
})();
