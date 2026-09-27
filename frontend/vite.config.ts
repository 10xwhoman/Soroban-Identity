import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Serve built assets from the CDN when CDN_BASE_URL is set (see infrastructure/cdn)
  base: process.env.CDN_BASE_URL || "/",
  plugins: [react()],
  define: {
    global: "globalThis",
  },
});
