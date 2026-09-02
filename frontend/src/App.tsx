import { useCallback, useEffect, useRef, useState } from "react";
import {
  AgentApiError,
  annotateScore,
  fetchModels,
  loadSampleFile
} from "./api";
import { Header } from "./components/Header";
import { ModelManager } from "./components/ModelManager";
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
  ModelCatalog,
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
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [modelManagerOpen, setModelManagerOpen] = useState(false);

  const runAgent = useCallback(
    async (targetFile: File, targetOptions: AnnotationOptions) => {
      setProcessing(true);
      setError(null);
      setFailedSteps([]);

      try {
        const nextResult = await annotateScore(
          targetFile,
          targetOptions,
          modelCatalog?.active_model_id
        );
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
    [modelCatalog?.active_model_id]
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

  useEffect(() => {
    void fetchModels()
      .then(setModelCatalog)
      .catch(() => {
        setModelCatalog({
          active_model_id: "deterministic-score-parser",
          google_configured: false,
          models: []
        });
      });
  }, []);

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
        modelName={
          modelCatalog?.models.find(
            (model) => model.id === modelCatalog.active_model_id
          )?.name ?? "确定性解析"
        }
        onManageModels={() => setModelManagerOpen(true)}
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
      {modelCatalog && modelManagerOpen ? (
        <ModelManager
          catalog={modelCatalog}
          onClose={() => setModelManagerOpen(false)}
          onChanged={(nextCatalog) => {
            setModelCatalog(nextCatalog);
            setModelManagerOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
