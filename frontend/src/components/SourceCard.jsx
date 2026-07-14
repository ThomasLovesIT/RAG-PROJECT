// The 0.75 split mirrors CONFIDENCE_THRESHOLD in backend/src/routes/chat.js:
// green means this chunk cleared the escalation guardrail, amber means it didn't.
const GUARDRAIL = 0.75;

export default function SourceCard({ source }) {
  const sim = Number(source.similarity) || 0;
  const pct = Math.round(Math.min(Math.max(sim, 0), 1) * 100);
  return (
    <div className="source-card">
      <div className="source-head">
        <span className="source-ref">[{source.ref}]</span>
        {source.articleTitle}
        <span className="badge">{source.source}</span>
        <span className="badge">{source.category}</span>
      </div>
      <div className="confidence" title={`Similarity ${sim} (guardrail ${GUARDRAIL})`}>
        <div className="conf-track">
          <div
            className={`conf-fill ${sim < GUARDRAIL ? "low" : ""}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="conf-score">{sim.toFixed(2)}</span>
      </div>
      <div className="source-excerpt">{source.excerpt}</div>
    </div>
  );
}
