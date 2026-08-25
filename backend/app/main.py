from __future__ import annotations

import os
from pathlib import Path
from uuid import UUID, uuid4

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from .agent import score_agent
from .musicxml import AnnotationOptions, MAX_UPLOAD_BYTES
from .omr import DEFAULT_OMR_PYTHON


BASE_DIR = Path(__file__).resolve().parent.parent
LOCAL_SAMPLE_FILE = Path(
    "/Users/lee/Downloads/1 卖课/2025 8 月课程整理/"
    "114 夜的钢琴曲五39B/夜的钢琴曲5/6夜的钢琴曲5.pdf"
)
configured_sample_file = Path(
    os.getenv("SAMPLE_FILE", str(LOCAL_SAMPLE_FILE))
).expanduser()
SAMPLE_FILE = (
    configured_sample_file
    if configured_sample_file.exists()
    else BASE_DIR / "sample_scores" / "c-major-scan.pdf"
)
RUN_OUTPUT_DIR = Path("/tmp/ai-piano-runs")
RUN_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="Music Score Annotation Agent",
    version="0.1.0",
)

configured_cors_origins = [
    origin.strip()
    for origin in os.getenv("CORS_ORIGINS", "").split(",")
    if origin.strip()
]
cors_origins = configured_cors_origins or [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "https://leonlzd120000.github.io",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class WorkflowStep(BaseModel):
    id: str
    title: str
    status: str
    detail: str
    duration_ms: int


class AnnotationResponse(BaseModel):
    run_id: str
    filename: str
    status: str
    source_format: str
    annotated_musicxml: str
    notes: list[dict]
    summary: dict
    steps: list[WorkflowStep]
    omr: dict | None = None
    annotated_pdf_url: str | None = None


@app.get("/api/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "omr": "ready" if DEFAULT_OMR_PYTHON.exists() else "missing",
    }


@app.get("/api/sample")
def sample_score() -> FileResponse:
    return FileResponse(
        SAMPLE_FILE,
        media_type="application/pdf",
        filename=SAMPLE_FILE.name,
    )


@app.get("/api/runs/{run_id}/annotated.pdf")
def annotated_pdf(run_id: str) -> FileResponse:
    try:
        normalized_run_id = str(UUID(run_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="标注 PDF 不存在") from exc
    path = RUN_OUTPUT_DIR / f"{normalized_run_id}.pdf"
    if not path.exists():
        raise HTTPException(status_code=404, detail="标注 PDF 不存在")
    return FileResponse(
        path,
        media_type="application/pdf",
        filename="CDEFGAB-annotated.pdf",
    )


@app.post("/api/annotate", response_model=AnnotationResponse)
async def annotate_score(
    file: UploadFile = File(...),
    label_style: str = Form("letter"),
    show_accidentals: bool = Form(True),
) -> AnnotationResponse:
    payload = await file.read(MAX_UPLOAD_BYTES + 1)
    initial_state = {
        "filename": file.filename or "score.musicxml",
        "payload": payload,
        "options": AnnotationOptions(
            label_style=label_style,
            show_accidentals=show_accidentals,
        ),
        "steps": [],
        "errors": [],
    }

    run_id = str(uuid4())
    result = await run_in_threadpool(score_agent.invoke, initial_state)
    if result.get("errors"):
        raise HTTPException(
            status_code=422,
            detail={
                "message": result["errors"][0],
                "steps": result.get("steps", []),
            },
        )

    annotated_pdf_url = None
    if result.get("annotated_pdf"):
        output_path = RUN_OUTPUT_DIR / f"{run_id}.pdf"
        output_path.write_bytes(result["annotated_pdf"])
        annotated_pdf_url = f"/api/runs/{run_id}/annotated.pdf"

    return AnnotationResponse(
        run_id=run_id,
        filename=file.filename or "score.musicxml",
        status=result["status"],
        source_format=result["source_format"],
        annotated_musicxml=result["annotated_musicxml"],
        notes=result["notes"],
        summary=result["summary"],
        steps=result["steps"],
        omr=result.get("omr_metadata"),
        annotated_pdf_url=annotated_pdf_url,
    )
