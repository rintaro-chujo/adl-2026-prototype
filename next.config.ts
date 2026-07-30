import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ネイティブバイナリ（.node）を含むのでバンドルせず Node.js にそのまま解決させる
  serverExternalPackages: ["@resvg/resvg-js"],
  // 各ページはビルド不要の静的 HTML（public/ へは npm run sync でコピー）。
  // / = 展示のメイングラフィックス（screen.html／プロジェクター投影）、
  // /poster.html = ポスターメーカー（実体は index.html）。
  // 実ファイルは動かさないので、GitHub Pages 側のルート index.html は従来どおり。
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/", destination: "/screen.html" },
        { source: "/poster.html", destination: "/index.html" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  // /poster.png は実行時に文字組み SVG とサブセットフォントを読むので、それだけを
  // サーバレスバンドルに含める（assets/posters の JPEG 22MB は関数には不要）。
  outputFileTracingIncludes: {
    "/poster.png": ["./assets/fonts/**/*", "./assets/poster.svg", "./assets/insta.svg"],
  },
};

export default nextConfig;
