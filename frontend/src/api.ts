import type {
  AnnotationOptions,
  AnnotationResult,
  ModelCatalog,
  WorkflowStep
} from "./types";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/+$/, "");

export function apiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}

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
  options: AnnotationOptions,
  modelId?: string
): Promise<AnnotationResult> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("label_style", options.labelStyle);
  formData.append("show_accidentals", String(options.showAccidentals));
  if (modelId) formData.append("model_id", modelId);

  const response = await fetch(apiUrl("/api/annotate"), {
    method: "POST",
    body: formData
  });

  if (!response.ok) {
    throw await parseError(response);
  }

  const result = (await response.json()) as AnnotationResult;
  return {
    ...result,
    annotated_pdf_url: result.annotated_pdf_url
      ? apiUrl(result.annotated_pdf_url)
      : null
  };
}

export async function fetchModels(): Promise<ModelCatalog> {
  const response = await fetch(apiUrl("/api/models"));
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as ModelCatalog;
}

export async function configureModel(
  modelId: string,
  apiKey?: string
): Promise<ModelCatalog> {
  const response = await fetch(apiUrl("/api/models/config"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model_id: modelId, api_key: apiKey || null })
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as ModelCatalog;
}

export async function testModel(
  modelId: string,
  prompt: string,
  apiKey?: string
): Promise<{ model_id: string; provider: string; text: string }> {
  const response = await fetch(apiUrl("/api/models/test"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: modelId,
      prompt,
      api_key: apiKey || null
    })
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as {
    model_id: string;
    provider: string;
    text: string;
  };
}

export async function loadSampleFile(): Promise<File> {
  const response = await fetch(apiUrl("/api/sample"));
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
