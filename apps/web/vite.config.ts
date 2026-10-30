import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { existsSync, readFileSync } from "fs";
import path from "path";

function readAppVersion(): string {
  const candidates = [
    path.resolve(__dirname, "../../VERSION"),
    path.resolve(__dirname, "../VERSION"),
    path.resolve(process.cwd(), "../VERSION"),
    path.resolve(process.cwd(), "../../VERSION"),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) return "dev";
  return readFileSync(found, "utf-8").trim();
}

const APP_VERSION = readAppVersion();

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        // iOS Home Screen apps have a separate cache. Precaching every JS
        // bundle competes with the first page load on slow connections and
        // can leave the app on a blank shell before the entry module arrives.
        // Runtime requests still cache scripts and styles after they load.
        globPatterns: ["index.html"],
        globIgnores: ["app-logo.png", "lyaotalk-original-icon.png", "lyaotalk-wordmark.png"],
      },
      manifest: {
        name: "Lyao Talk",
        short_name: "Lyao Talk",
        description: "More Than Just Chat",
        theme_color: "#1a1a2e",
        background_color: "#0f0f1a",
        display: "standalone",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",  // Never bind to 0.0.0.0 — prevents CVE-2025-30208 / CVE-2025-32395 exposure
    strictPort: false,
    fs: {
      strict: true,  // Only serve files inside project root
    },
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, "") },
    },
  },
  build: {
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("strophe.js") || id.includes("@converse/headless")) return "xmpp";
          if (id.includes("emoji-picker-react") || id.includes("react-dropzone")) return "rich-input";
          if (id.includes("dexie")) return "dexie";
          return undefined;
        },
      },
    },
  },
});
