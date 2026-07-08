import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Proxy /api/* to the Express backend so the frontend can just call
    // fetch("/api/chat") with no CORS setup and no hardcoded backend URL.
    proxy: {
      "/api": "http://localhost:3001",
    },
  },
});
