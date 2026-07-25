import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:7314",
      "/ws": { target: "ws://localhost:7314", ws: true },
    },
  },
});
