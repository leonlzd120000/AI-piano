import { Download, GitBranch, Music2 } from "lucide-react";

interface HeaderProps {
  canDownload: boolean;
  downloadFormat: "PDF" | "MusicXML";
  onDownload: () => void;
}

export function Header({
  canDownload,
  downloadFormat,
  onDownload
}: HeaderProps) {
  return (
    <header className="app-header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Music2 size={19} strokeWidth={2.2} />
        </span>
        <div>
          <h1>乐谱标注 Agent</h1>
          <span>MusicXML Note Labeler</span>
        </div>
      </div>

      <div className="header-actions">
        <div className="runtime-status" title="LangGraph 工作流已连接">
          <GitBranch size={15} />
          <span className="status-dot" />
          LangGraph
        </div>
        <button
          className="button button-primary"
          type="button"
          disabled={!canDownload}
          onClick={onDownload}
          aria-label={`下载标注 ${downloadFormat}`}
        >
          <Download size={16} />
          下载标注 {downloadFormat}
        </button>
      </div>
    </header>
  );
}
