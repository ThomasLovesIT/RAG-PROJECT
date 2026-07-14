import { useEffect, useRef, useState } from "react";

// Phase 1 UI: a knowledge-base sidebar (upload/list/delete articles) + a
// helpdesk chat pane that shows the model's answer AND the retrieved source
// chunks with their similarity scores. Showing sources isn't decoration —
// it's the whole trust story of RAG: every answer points at the exact
// runbook/FAQ text it came from.

const CATEGORIES = ["General", "Network", "Hardware", "Account Access", "Software"];

export default function App() {
  const [articles, setArticles] = useState([]);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  // Metadata attached to the NEXT upload. Captured now (Phase 1) so that
  // Phase 2's retrieval-time access control has real data to filter on.
  const [role, setRole] = useState("EMPLOYEE");
  const [category, setCategory] = useState("General");
  const [source, setSource] = useState("RUNBOOK");
  const [visibility, setVisibility] = useState("INTERNAL");
  const fileInputRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    loadArticles();
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function loadArticles() {
    try {
      const res = await fetch("/api/articles");
      setArticles(await res.json());
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
      form.append("category", category);
      form.append("source", source);
      form.append("visibility", visibility);
      const res = await fetch("/api/articles", { method: "POST", body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      await loadArticles();
    } catch (err) {
      setError(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete(id) {
    await fetch(`/api/articles/${id}`, { method: "DELETE" });
    await loadArticles();
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
        body: JSON.stringify({ question: q, role }),
      });
      // Parse defensively: a rate-limited or restarted backend can return an
      // empty/non-JSON body, and res.json() would otherwise throw the cryptic
      // "Unexpected end of JSON input".
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Request failed (${res.status}). Please try again.`);
      }
      setMessages((m) => [
        ...m,
        { role: "assistant", text: body.answer, sources: body.sources, meta: body.meta },
      ]);
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", text: `Error: ${err.message}`, sources: [] }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>🛠️ IT Helpdesk Assistant</h1>

        <div className="role-selector">
          <label>
            Simulated role
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="EMPLOYEE">Employee (PUBLIC docs only)</option>
              <option value="IT_STAFF">IT Staff (all docs)</option>
            </select>
          </label>
          <span className="role-note">Production: role comes from auth</span>
        </div>

        <div className="upload-meta">
          <label>
            Category
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Source type
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="RUNBOOK">Runbook</option>
              <option value="FAQ">FAQ</option>
              <option value="PAST_TICKET">Past ticket</option>
            </select>
          </label>
          <label>
            Visibility
            <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
              <option value="INTERNAL">Internal (IT staff only)</option>
              <option value="PUBLIC">Public (all employees)</option>
            </select>
          </label>
        </div>

        <label className={`upload-btn ${uploading ? "disabled" : ""}`}>
          {uploading ? "Ingesting…" : "+ Upload doc (.pdf / .md / .txt)"}
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain"
            onChange={handleUpload}
            disabled={uploading}
            hidden
          />
        </label>

        <ul className="doc-list">
          {articles.map((a) => (
            <li key={a.id}>
              <div>
                <span className="doc-title">{a.title}</span>
                <span className="doc-meta">
                  {a.source} · {a.category} · {a.visibility} · {a.chunkCount} chunks
                </span>
              </div>
              <button className="delete" onClick={() => handleDelete(a.id)} title="Delete">
                ×
              </button>
            </li>
          ))}
          {articles.length === 0 && <li className="empty">Knowledge base is empty</li>}
        </ul>
        {error && <div className="error">{error}</div>}
      </aside>

      <main className="chat">
        <div className="messages">
          {messages.length === 0 && (
            <div className="placeholder">
              Upload runbooks, FAQs, or ticket writeups — then ask a support question.
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`message ${m.role}`}>
              <div className="bubble">{m.text}</div>
              {m.meta && (
                <div className="meta">
                  {m.meta.rerank ? "re-ranked" : "no re-rank"} · top sim {m.meta.topScore} ·{" "}
                  {m.meta.tokens} tok · ${m.meta.costUsd} · {m.meta.latencyMs}ms
                </div>
              )}
              {m.sources?.length > 0 && (
                <details className="sources">
                  <summary>Sources ({m.sources.length})</summary>
                  {m.sources.map((s) => (
                    <div key={s.ref} className="source">
                      <div className="source-head">
                        [{s.ref}] {s.articleTitle}{" "}
                        <span className="score">
                          {s.source} · {s.category} · similarity {s.similarity}
                        </span>
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
            placeholder="Describe the IT issue, e.g. “user's AD account is locked”…"
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
