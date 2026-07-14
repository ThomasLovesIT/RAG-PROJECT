import { useEffect, useRef } from "react";
import SourceCard from "./SourceCard.jsx";

const EXAMPLES = [
  "User's AD account is locked",
  "How do I connect to the office VPN?",
  "Printer shows offline for everyone",
];

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Morning";
  if (h < 18) return "Afternoon";
  return "Evening";
}

export default function MessageList({ messages, busy, onPick }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  return (
    <div className="messages" role="log" aria-live="polite">
      <div className="msg-col">
        {messages.length === 0 && (
          <div className="empty-chat">
            <h2>
              <span className="asterisk" aria-hidden="true"></span>
              {greeting()}, what needs fixing?
            </h2>
            <p>Answers cite the exact runbook, FAQ, or ticket they came from.</p>
            <div className="chips">
              {EXAMPLES.map((q) => (
                <button key={q} className="chip" onClick={() => onPick(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            <div className="bubble">{m.text}</div>
            {m.meta && (
              <div className="telemetry">
                {m.meta.escalated && <span className="escalated">escalated · </span>}
                {m.meta.rerank ? "re-ranked" : "no re-rank"} · top sim {m.meta.topScore} ·{" "}
                {m.meta.tokens} tok · ${m.meta.costUsd} · {m.meta.latencyMs}ms
              </div>
            )}
            {m.sources?.length > 0 && (
              <details className="sources">
                <summary>Sources ({m.sources.length})</summary>
                {m.sources.map((s) => (
                  <SourceCard key={s.ref} source={s} />
                ))}
              </details>
            )}
          </div>
        ))}
        {busy && (
          <div className="message assistant">
            <div className="bubble thinking">
              <span className="status-dot busy" aria-hidden="true" />
              Thinking…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
