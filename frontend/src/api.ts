import type { AnnotationOptions, AnnotationResult, WorkflowStep } from "./types";

interface ErrorDetail {
  message?: string;
  steps?: WorkflowStep[];
}

export class AgentApiError extends Error {
  steps: WorkflowStep[];

  constructor(message: string, steps: WorkflowStep[] = []) {
    super(message);
    this.name = "AgentApiError";
    this.steps = steps;
  }
}

async function parseError(response: Response): Promise<AgentApiError> {
  try {
    const payload = (await response.json()) as {
      detail?: string | ErrorDetail;
    };
    if (typeof payload.detail === "string") {
      return new AgentApiError(payload.detail);
    }
    if (payload.detail && typeof payload.detail === "object") {
      return new AgentApiError(
        payload.detail.message ?? "乐谱处理失败",
        payload.detail.steps ?? []
      );
    }
  } catch {
    // Fall through to the status-based error.
  }
  return new AgentApiError(`请求失败（HTTP ${response.status}）`);
}

export async function annotateScore(
  file: File,
  options: AnnotationOptions
): Promise<AnnotationResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("label_style", options.labelStyle);
  formData.append("show_accidentals", String(options.showAccidentals));

  const response = await fetch("/api/annotate", {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    throw await parseError(response);
  }

  return (await response.json()) as AnnotationResult;
}

export async function loadSampleFile(): Promise<File> {
  const response = await fetch("/api/sample");
  if (!response.ok) {
    throw await parseError(response);
  }
  const blob = await response.blob();
  const contentType = response.headers.get("content-type") || "application/pdf";
  const contentDisposition = response.headers.get("content-disposition");
  let filename = "sample.pdf";
  if (contentDisposition) {
    const filenameMatch = contentDisposition.match(/filename\*=utf-8''([^;\n]*)/);
    if (filenameMatch) {
      filename = decodeURIComponent(filenameMatch[1]);
    } else {
      const standardMatch = contentDisposition.match(/filename="?([^;\n"]*)"?/);
      if (standardMatch) {
        filename = standardMatch[1];
      }
    }
  }
  return new File([blob], filename, { type: contentType });
}
