import {
  Check,
  Circle,
  Clock3,
  GitBranch,
  LoaderCircle,
  TriangleAlert,
  X
} from "lucide-react";
import type { AnnotationResult, WorkflowStep } from "../types";

interface RunPanelProps {
  result: AnnotationResult | null;
  processing: boolean;
  error: string | null;
  failedSteps: WorkflowStep[];
  expectsOmr: boolean;
}

const DIGITAL_STEPS = [
  "文件校验",
  "解析乐谱",
  "识别音符",
  "添加标注",
  "验证结果"
];

const NOTE_COLORS: Record<string, string> = {
  C: "#2563eb",
  D: "#059669",
  E: "#d97706",
  F: "#dc2626",
  G: "#7c3aed",
  A: "#db2777",
  B: "#0891b2"
};

function StepIcon({ status }: { status: WorkflowStep["status"] }) {
  if (status === "completed") return <Check size={13} strokeWidth={3} />;
  if (status === "failed") return <X size={13} strokeWidth={3} />;
  return <Circle size={10} />;
}

export function RunPanel({
  result,
  processing,
  error,
  failedSteps,
  expectsOmr
}: RunPanelProps) {
  const steps = result?.steps ?? failedSteps;
  const expectedSteps =
    expectsOmr || Boolean(result?.omr)
      ? ["文件校验", "光学识谱", ...DIGITAL_STEPS.slice(1)]
      : DIGITAL_STEPS;

  return (
    <aside className="run-panel">
      <section className="run-header">
        <div>
          <span className="eyebrow">执行记录</span>
          <h2>Agent 工作流</h2>
        </div>
        {processing ? (
          <LoaderCircle className="spin" size={18} />
        ) : result ? (
          <span className="run-complete">
            <Check size={13} />
            完成
          </span>
        ) : error ? (
          <TriangleAlert size={18} />
        ) : (
          <GitBranch size={18} />
        )}
      </section>

      <div className="step-list">
        {expectedSteps.map((title, index) => {
          const step = steps.find((candidate) => candidate.title === title);
          const status = step?.status ?? "pending";
          const isActive = processing && index === steps.length;

          return (
            <div className={`workflow-step is-${status}`} key={title}>
              <span className={`step-icon${isActive ? " is-active" : ""}`}>
                {isActive ? (
                  <LoaderCircle className="spin" size={13} />
                ) : (
                  <StepIcon status={status} />
                )}
              </span>
              <div>
                <strong>{title}</strong>
                <span>
                  {step?.detail ??
                    (isActive ? "正在执行该节点" : processing ? "等待执行" : "尚未运行")}
                </span>
              </div>
              {step ? (
                <small>
                  <Clock3 size={11} />
                  {step.duration_ms}ms
                </small>
              ) : null}
            </div>
          );
        })}
      </div>

      {error ? (
        <div className="error-message" role="alert">
          <TriangleAlert size={17} />
          <span>{error}</span>
        </div>
      ) : null}

      {result ? (
        <section className="run-summary">
          <div className="section-heading">
            <span>识别摘要</span>
          </div>
          <div className="summary-metrics">
            <div>
              <strong>{result.summary.note_count}</strong>
              <span>音符</span>
            </div>
            <div>
              <strong>{result.summary.event_count}</strong>
              <span>发音事件</span>
            </div>
            <div>
              <strong>{result.summary.measure_count}</strong>
              <span>小节</span>
            </div>
          </div>

          <div className="note-distribution">
            {"CDEFGAB".split("").map((note) => (
              <div key={note}>
                <span
                  className="note-swatch"
                  style={{ backgroundColor: NOTE_COLORS[note] }}
                />
                <strong>{note}</strong>
                <span>{result.summary.pitch_counts[note] ?? 0}</span>
              </div>
            ))}
          </div>

          <div className="run-id">
            <span>{result.omr ? `${result.omr.engine} · ${result.omr.pages} 页` : "Run ID"}</span>
            <code title={result.run_id}>{result.run_id.slice(0, 8)}</code>
          </div>
        </section>
      ) : null}
    </aside>
  );
}
