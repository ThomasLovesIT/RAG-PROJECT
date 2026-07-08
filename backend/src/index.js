import "dotenv/config";
import express from "express";
import cors from "cors";
import documentsRouter from "./routes/documents.js";
import chatRouter from "./routes/chat.js";

// Fail fast at boot instead of failing confusingly on the first request.
const missing = ["DATABASE_URL", "GEMINI_API_KEY"].filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(
    `Missing environment variables: ${missing.join(", ")}\n` +
      `Copy backend/.env.example to backend/.env and fill in the values.`
  );
  process.exit(1);
}

const app = express();
app.use(cors()); // dev convenience — the Vite proxy makes this mostly moot
app.use(express.json());

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/documents", documentsRouter);
app.use("/api/chat", chatRouter);

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`RAG backend listening on http://localhost:${PORT}`);
});
