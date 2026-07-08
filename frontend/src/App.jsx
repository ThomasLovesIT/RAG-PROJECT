import { useEffect, useRef, useState } from "react";

// Phase 1 UI: a document sidebar (upload/list/delete) + a chat pane that
// shows the model's answer AND the retrieved source chunks with their
// similarity scores. Showing sources isn't decoration — it's the whole
// trust story of RAG: every answer points at the exact text it came from.

export default function App() {
  const [docs, setDocs] = useState([]);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const fileInputRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    loadDocs();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function loadDocs() {
    try {
      const res = await fetch("/api/documents");
      setDocs(await res.json());
    } catch {
      setError("Backend unreachable — is it running on :3001?");
    }
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/documents", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      await loadDocs();
    } catch (err) {
      setError(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete(id) {
    await fetch(`/api/documents/${id}`, { method: "DELETE" });
    await loadDocs();
  }

  async function handleAsk(e) {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setQuestion("");
    setError(null);
    setMessages((m) => [...m, { role: "user", text: q }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setMessages((m) => [...m, { role: "assistant", text: body.answer, sources: body.sources }]);
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${err.message}`, sources: [] }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>📚 RAG Study Assistant</h1>
        <label className={`upload-btn ${uploading ? "disabled" : ""}`}>
          {uploading ? "Ingesting…" : "+ Upload PDF"}
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf"
            onChange={handleUpload}
            disabled={uploading}
            hidden
          />
        </label>
        <ul className="doc-list">
          {docs.map((d) => (
            <li key={d.id}>
              <div>
                <span className="doc-title">{d.title}</span>
                <span className="doc-meta">{d.chunkCount} chunks</span>
              </div>
              <button className="delete" onClick={() => handleDelete(d.id)} title="Delete">
                ×
              </button>
            </li>
          ))}
          {docs.length === 0 && <li className="empty">No documents yet</li>}
        </ul>
        {error && <div className="error">{error}</div>}
      </aside>

      <main className="chat">
        <div className="messages">
          {messages.length === 0 && (
            <div className="placeholder">Upload lecture notes, then ask a question about them.</div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`message ${m.role}`}>
              <div className="bubble">{m.text}</div>
              {m.sources?.length > 0 && (
                <details className="sources">
                  <summary>Sources ({m.sources.length})</summary>
                  {m.sources.map((s) => (
                    <div key={s.ref} className="source">
                      <div className="source-head">
                        [{s.ref}] {s.documentTitle}{" "}
                        <span className="score">similarity {s.similarity}</span>
                      </div>
                      <div className="source-excerpt">{s.excerpt}</div>
                    </div>
                  ))}
                </details>
              )}
            </div>
          ))}
          {busy && <div className="message assistant"><div className="bubble">Thinking…</div></div>}
          <div ref={bottomRef} />
        </div>

        <form className="composer" onSubmit={handleAsk}>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a question about your documents…"
            disabled={busy}
          />
          <button type="submit" disabled={busy || !question.trim()}>
            Ask
          </button>
        </form>
      </main>
    </div>
  );
}
