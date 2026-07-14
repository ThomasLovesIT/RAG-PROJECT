import UploadZone from "./UploadZone.jsx";

const CATEGORIES = ["General", "Network", "Hardware", "Account Access", "Software"];

export default function Sidebar({
  articles,
  role,
  setRole,
  category,
  setCategory,
  source,
  setSource,
  visibility,
  setVisibility,
  uploading,
  error,
  onUpload,
  onDelete,
  open,
  onClose,
}) {
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand">
        <span className="status-dot" aria-hidden="true" />
        IT Helpdesk Assistant
        <button className="sidebar-close" onClick={onClose} aria-label="Close knowledge base panel">
          ×
        </button>
      </div>

      <div className="panel">
        <label className="field">
          Simulated role
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="EMPLOYEE">Employee (PUBLIC docs only)</option>
            <option value="IT_STAFF">IT Staff (all docs)</option>
          </select>
        </label>
        <span className="role-note">Production: role comes from auth</span>
      </div>

      <div className="upload-meta">
        <label className="field">
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="field">
          Source type
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="RUNBOOK">Runbook</option>
            <option value="FAQ">FAQ</option>
            <option value="PAST_TICKET">Past ticket</option>
          </select>
        </label>
        <label className="field">
          Visibility
          <select value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            <option value="INTERNAL">Internal (IT staff only)</option>
            <option value="PUBLIC">Public (all employees)</option>
          </select>
        </label>
      </div>

      <UploadZone uploading={uploading} onUpload={onUpload} />

      <ul className="doc-list">
        {articles.map((a) => (
          <li key={a.id} className="doc-item">
            <div>
              <span className="doc-title">{a.title}</span>
              <span className="doc-badges">
                <span className="badge">{a.source}</span>
                <span className="badge">{a.category}</span>
                <span className="badge">{a.visibility}</span>
                <span className="badge">{a.chunkCount} chunks</span>
              </span>
            </div>
            <button
              className="delete-btn"
              onClick={() => onDelete(a.id)}
              aria-label={`Delete ${a.title}`}
              title="Delete"
            >
              ×
            </button>
          </li>
        ))}
        {articles.length === 0 && (
          <li className="doc-empty">No documents yet. Upload a runbook or FAQ to start.</li>
        )}
      </ul>
      {error && <div className="error-banner" role="alert">{error}</div>}
    </aside>
  );
}
