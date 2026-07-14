import { useEffect, useRef, useState } from "react";
import Sidebar from "./components/Sidebar.jsx";
import MessageList from "./components/MessageList.jsx";
import Composer from "./components/Composer.jsx";

// A knowledge-base sidebar (upload/list/delete articles) + a helpdesk chat
// pane that shows the model's answer AND the retrieved source chunks with
// their similarity scores. Showing sources isn't decoration — it's the whole
// trust story of RAG: every answer points at the exact runbook/FAQ text it
// came from.

export default function App() {
  const [articles, setArticles] = useState([]);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  // Metadata attached to the NEXT upload, so retrieval-time access control
  // has real data to filter on.
  const [role, setRole] = useState("EMPLOYEE");
  const [category, setCategory] = useState("General");
  const [source, setSource] = useState("RUNBOOK");
  const [visibility, setVisibility] = useState("INTERNAL");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const composerRef = useRef(null);

  useEffect(() => {
    loadArticles();
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e) => e.key === "Escape" && setSidebarOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  async function loadArticles() {
    try {
      const res = await fetch("/api/articles");
      setArticles(await res.json());
      setError(null);
    } catch {
      setError("Backend unreachable — is it running on :3001?");
    }
  }

  async function uploadFile(file) {
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
    }
  }

  async function handleDelete(id) {
    await fetch(`/api/articles/${id}`, { method: "DELETE" });
    await loadArticles();
  }

  function pickExample(q) {
    setQuestion(q);
    composerRef.current?.focus();
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
      <Sidebar
        articles={articles}
        role={role}
        setRole={setRole}
        category={category}
        setCategory={setCategory}
        source={source}
        setSource={setSource}
        visibility={visibility}
        setVisibility={setVisibility}
        uploading={uploading}
        error={error}
        onUpload={uploadFile}
        onDelete={handleDelete}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      {sidebarOpen && (
        <button
          className="backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close knowledge base panel"
        />
      )}

      <main className="chat">
        <header className="statusbar">
          <button
            className="menu-btn"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open knowledge base panel"
          >
            ☰ Knowledge base
          </button>
          <span className="statusbar-title">
            <span
              className={`status-dot ${error ? "down" : ""} ${busy ? "busy" : ""}`}
              role="img"
              aria-label={error ? "Backend unreachable" : "Backend connected"}
            />
            IT Helpdesk
          </span>
          <span className="status-readout">
            KB {articles.length} {articles.length === 1 ? "doc" : "docs"} · ROLE {role}
          </span>
        </header>

        <MessageList messages={messages} busy={busy} onPick={pickExample} />

        <Composer
          question={question}
          setQuestion={setQuestion}
          busy={busy}
          onSubmit={handleAsk}
          inputRef={composerRef}
        />
      </main>
    </div>
  );
}
