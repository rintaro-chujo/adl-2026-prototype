import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ネイティブバイナリ（.node）を含むのでバンドルせず Node.js にそのまま解決させる
  serverExternalPackages: ["@resvg/resvg-js"],
  // 各ページはビルド不要の静的 HTML。配信レイアウトは npm run sync が public/ を
  // 組み立てて決める（rewrites は使わない。この Vercel プロジェクトでは効かなかった）。
  //   public/index.html   ← screen.html    … / = 展示のメイングラフィックス
  //   public/poster.html  ← index.html     … ポスターメーカー
  // リポジトリ直下の index.html はポスターメーカーのまま（GitHub Pages 用）。
  // /poster.png は実行時に文字組み SVG とサブセットフォントを読むので、それだけを
  // サーバレスバンドルに含める（assets/posters の JPEG 22MB は関数には不要）。
  outputFileTracingIncludes: {
    "/poster.png": ["./assets/fonts/**/*", "./assets/poster.svg", "./assets/insta.svg"],
  },
};

export default nextConfig;
