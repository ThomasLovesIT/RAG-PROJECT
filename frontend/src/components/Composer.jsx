export default function Composer({ question, setQuestion, busy, onSubmit, inputRef }) {
  return (
    <form className="composer" onSubmit={onSubmit}>
      <div className="composer-inner">
        <input
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Describe the IT issue, e.g. “user's AD account is locked”…"
          aria-label="Support question"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !question.trim()}>
          Ask
        </button>
      </div>
    </form>
  );
}
