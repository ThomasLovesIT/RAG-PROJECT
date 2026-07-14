import { useRef, useState } from "react";

export default function UploadZone({ uploading, onUpload }) {
  const fileInputRef = useRef(null);
  const [dragover, setDragover] = useState(false);

  function handleFile(file) {
    if (!file || uploading) return;
    onUpload(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <label
      className={`upload-zone ${uploading ? "uploading" : ""} ${dragover ? "dragover" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragover(true);
      }}
      onDragLeave={() => setDragover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragover(false);
        handleFile(e.dataTransfer.files?.[0]);
      }}
    >
      <svg
        className="upload-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 15V4" />
        <path d="M8 8l4-4 4 4" />
        <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
      </svg>
      {uploading ? "Ingesting…" : "Drop a file here or click to upload"}
      <span className="upload-hint">PDF · MD · TXT</span>
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.md,.markdown,.txt,application/pdf,text/markdown,text/plain"
        onChange={(e) => handleFile(e.target.files?.[0])}
        disabled={uploading}
        className="visually-hidden"
      />
    </label>
  );
}
