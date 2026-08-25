import {
  FileMusic,
  LoaderCircle,
  Play,
  RefreshCw,
  Sparkles,
  Upload
} from "lucide-react";
import { useRef, useState } from "react";
import type { AnnotationOptions, LabelStyle } from "../types";
import { SegmentedControl } from "./SegmentedControl";

interface UploadPanelProps {
  file: File | null;
  options: AnnotationOptions;
  processing: boolean;
  hasResult: boolean;
  onFileChange: (file: File) => void;
  onOptionsChange: (options: AnnotationOptions) => void;
  onRun: () => void;
  onLoadSample: () => void;
}

const labelSegments: Array<{ value: LabelStyle; label: string }> = [
  { value: "letter", label: "字母" },
  { value: "letter_octave", label: "字母 + 八度" }
];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function UploadPanel({
  file,
  options,
  processing,
  hasResult,
  onFileChange,
  onOptionsChange,
  onRun,
  onLoadSample
}: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const selectFile = (candidate?: File) => {
    if (candidate) {
      onFileChange(candidate);
    }
  };

  return (
    <aside className="control-panel">
      <section className="panel-section">
        <div className="section-heading">
          <span>乐谱文件</span>
          <button className="text-button" type="button" onClick={onLoadSample}>
            <Sparkles size={14} />
            示例
          </button>
        </div>

        <button
          className={`drop-zone${dragActive ? " is-dragging" : ""}`}
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragActive(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            selectFile(event.dataTransfer.files[0]);
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".musicxml,.xml,.mxl,.pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff"
            onChange={(event) => selectFile(event.target.files?.[0])}
          />
          <span className="drop-zone-icon" aria-hidden="true">
            <Upload size={21} />
          </span>
          <strong>上传数字或扫描乐谱</strong>
          <span>拖放文件或点击选择</span>
          <small>MusicXML · PDF · PNG · JPG，最大 20 MB</small>
        </button>

        {file ? (
          <div className="selected-file">
            <FileMusic size={18} />
            <div>
              <strong title={file.name}>{file.name}</strong>
              <span>{formatFileSize(file.size)}</span>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel-section">
        <div className="section-heading">
          <span>标注设置</span>
        </div>

        <div className="field-group">
          <label>显示格式</label>
          <SegmentedControl
            ariaLabel="音符显示格式"
            value={options.labelStyle}
            segments={labelSegments}
            onChange={(labelStyle) =>
              onOptionsChange({ ...options, labelStyle })
            }
          />
        </div>

        <label className="toggle-row">
          <span>
            <strong>显示升降号</strong>
            <small>例如 F#、Bb</small>
          </span>
          <input
            type="checkbox"
            checked={options.showAccidentals}
            onChange={(event) =>
              onOptionsChange({
                ...options,
                showAccidentals: event.target.checked
              })
            }
          />
          <span className="toggle-control" aria-hidden="true" />
        </label>
      </section>

      <div className="panel-spacer" />

      <button
        className="button button-primary run-button"
        type="button"
        disabled={!file || processing}
        onClick={onRun}
      >
        {processing ? (
          <LoaderCircle className="spin" size={17} />
        ) : hasResult ? (
          <RefreshCw size={17} />
        ) : (
          <Play size={17} fill="currentColor" />
        )}
        {processing ? "Agent 处理中" : hasResult ? "重新标注" : "开始标注"}
      </button>
    </aside>
  );
}
