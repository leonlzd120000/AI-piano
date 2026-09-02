export type LabelStyle = "letter" | "letter_octave";

export interface WorkflowStep {
  id: string;
  title: string;
  status: "completed" | "failed" | "pending";
  detail: string;
  duration_ms: number;
}

export interface ScoreNote {
  index: number;
  event_index: number;
  part: number;
  measure: string;
  staff: string;
  voice: string;
  step: string;
  alter: number;
  octave: number;
  label: string;
  is_chord_note: boolean;
}

export interface ScoreSummary {
  part_count: number;
  measure_count: number;
  note_count: number;
  event_count: number;
  pitch_counts: Record<string, number>;
}

export interface AnnotationResult {
  run_id: string;
  filename: string;
  status: string;
  source_format: string;
  annotated_musicxml: string;
  notes: ScoreNote[];
  summary: ScoreSummary;
  steps: WorkflowStep[];
  annotated_pdf_url: string | null;
  model_id: string;
  omr: {
    engine: string;
    pages: number;
    source_kind: "image" | "pdf";
    pdf_labels_expected?: number;
    pdf_labels_placed?: number;
    cleaned_pixels?: number;
  } | null;
}

export interface ModelDefinition {
  id: string;
  provider: string;
  provider_label: string;
  name: string;
  description: string;
  status: "stable" | "preview";
  configured: boolean;
}

export interface ModelCatalog {
  active_model_id: string;
  google_configured: boolean;
  models: ModelDefinition[];
}

export interface AnnotationOptions {
  labelStyle: LabelStyle;
  showAccidentals: boolean;
}
