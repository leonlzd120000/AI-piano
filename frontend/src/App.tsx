import { useCallback, useEffect, useRef, useState } from "react";
import { AgentApiError, annotateScore, loadSampleFile } from "./api";
import { Header } from "./components/Header";
import { RunPanel } from "./components/RunPanel";
import { ScorePreview } from "./components/ScorePreview";
import { UploadPanel } from "./components/UploadPanel";
import {
  annotatedMusicXmlFilename,
  annotatedPdfFilename,
  downloadFile,
  downloadText
} from "./lib/download";
import type {
  AnnotationOptions,
  AnnotationResult,
  WorkflowStep
} from "./types";

const DEFAULT_OPTIONS: AnnotationOptions = {
  labelStyle: "letter",
  showAccidentals: true
};

const OMR_FILE_PATTERN = /\.(pdf|png|jpe?g|webp|tiff?)$/i;

export default function App() {
  const initialized = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [result, setResult] = useState<AnnotationResult | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedSteps, setFailedSteps] = useState<WorkflowStep[]>([]);

  const runAgent = useCallback(
    async (targetFile: File, targetOptions: AnnotationOptions) => {
      setProcessing(true);
      setError(null);
      setFailedSteps([]);

      try {
        const nextResult = await annotateScore(targetFile, targetOptions);
        setResult(nextResult);
      } catch (caught) {
        setResult(null);
        if (caught instanceof AgentApiError) {
          setError(caught.message);
          setFailedSteps(caught.steps);
        } else {
          setError(caught instanceof Error ? caught.message : "乐谱处理失败");
        }
      } finally {
        setProcessing(false);
      }
    },
    []
  );

  const loadSample = useCallback(async () => {
    setProcessing(true);
    setError(null);
    setFailedSteps([]);
    try {
      const sample = await loadSampleFile();
      setFile(sample);
      await runAgent(sample, options);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "示例乐谱加载失败");
      setProcessing(false);
    }
  }, [options, runAgent]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void loadSample();
  }, [loadSample]);

  const handleFileChange = (nextFile: File) => {
    setFile(nextFile);
    setResult(null);
    setError(null);
    setFailedSteps([]);
  };

  const handleOptionsChange = (nextOptions: AnnotationOptions) => {
    setOptions(nextOptions);
  };

  const handleDownload = async () => {
    if (!result) return;
    if (result.annotated_pdf_url) {
      await downloadFile(
        result.annotated_pdf_url,
        annotatedPdfFilename(result.filename)
      );
      return;
    }
    downloadText(
      result.annotated_musicxml,
      annotatedMusicXmlFilename(result.filename),
      "application/vnd.recordare.musicxml+xml"
    );
  };

  return (
    <div className="app-shell">
      <Header
        canDownload={Boolean(result)}
        downloadFormat={result?.annotated_pdf_url ? "PDF" : "MusicXML"}
        onDownload={() => {
          void handleDownload();
        }}
      />
      <main className="workspace">
        <UploadPanel
          file={file}
          options={options}
          processing={processing}
          hasResult={Boolean(result)}
          onFileChange={handleFileChange}
          onOptionsChange={handleOptionsChange}
          onRun={() => {
            if (file) void runAgent(file, options);
          }}
          onLoadSample={() => void loadSample()}
        />

        <section className="score-workspace">
          <div className="score-toolbar">
            <div>
              <strong>{result?.filename ?? file?.name ?? "未选择乐谱"}</strong>
              <span>
                {result
                  ? `${result.summary.note_count} 个音符 · ${result.summary.measure_count} 个小节${
                      result.omr ? ` · OMR ${result.omr.pages} 页` : ""
                    }`
                  : processing
                    ? OMR_FILE_PATTERN.test(file?.name ?? "")
                      ? "HOMR 正在识别扫描乐谱"
                      : "LangGraph 正在执行"
                    : "等待处理"}
              </span>
            </div>
            <div className="hand-legend" aria-label="左右手标注颜色">
              <span>
                <i className="hand-color right" />
                右手
              </span>
              <span>
                <i className="hand-color left" />
                左手
              </span>
            </div>
          </div>
          <div className="score-canvas">
            <ScorePreview
              musicxml={result?.annotated_musicxml ?? null}
              notes={result?.notes ?? []}
              processing={processing}
              pdfUrl={result?.annotated_pdf_url ?? null}
            />
          </div>
        </section>

        <RunPanel
          result={result}
          processing={processing}
          error={error}
          failedSteps={failedSteps}
          expectsOmr={OMR_FILE_PATTERN.test(file?.name ?? "")}
        />
      </main>
    </div>
  );
}
