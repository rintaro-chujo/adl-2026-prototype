import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // ネイティブバイナリ（.node）を含むのでバンドルせず Node.js にそのまま解決させる
  serverExternalPackages: ["@resvg/resvg-js"],
  // アプリ本体はビルド不要の静的 index.html（public/ へは npm run sync でコピー）。
  // / をそのまま index.html に割り当てる。
  async rewrites() {
    return {
      beforeFiles: [{ source: "/", destination: "/index.html" }],
      afterFiles: [],
      fallback: [],
    };
  },
  // /poster.png は実行時に assets/（文字組み SVG とフォント）を読むので、
  // サーバレスバンドルに含める。
  outputFileTracingIncludes: {
    "/poster.png": ["./assets/**/*"],
  },
};

export default nextConfig;
