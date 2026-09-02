from __future__ import annotations

import operator
from time import perf_counter
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph

from .musicxml import (
    AnnotationOptions,
    ScoreFormatError,
    analyze_musicxml,
    annotate_musicxml,
    count_agent_labels,
    extract_musicxml,
)
from .model_manager import active_model_id, validate_model_selection
from .omr import InputKind, classify_score_input, convert_score_with_omr


class ScoreAgentState(TypedDict, total=False):
    filename: str
    payload: bytes
    options: AnnotationOptions
    model_id: str
    input_kind: InputKind
    omr_musicxml: str
    omr_metadata: dict[str, Any]
    source_format: str
    musicxml: str
    notes: list[dict[str, Any]]
    summary: dict[str, Any]
    annotated_musicxml: str
    annotated_pdf: bytes
    expected_labels: int
    status: str
    steps: Annotated[list[dict[str, Any]], operator.add]
    errors: Annotated[list[str], operator.add]


def _step(step_id: str, title: str, status: str, detail: str, started: float) -> dict[str, Any]:
    return {
        "id": step_id,
        "title": title,
        "status": status,
        "detail": detail,
        "duration_ms": max(1, round((perf_counter() - started) * 1000)),
    }


def validate_upload(state: ScoreAgentState) -> ScoreAgentState:
    started = perf_counter()
    try:
        input_kind = classify_score_input(
            state.get("filename", ""),
            state.get("payload", b""),
        )
        state["options"].validate()
        model_id = validate_model_selection(
            state.get("model_id") or active_model_id()
        )
        return {
            "input_kind": input_kind,
            "model_id": model_id,
            "steps": [
                _step(
                    "validate",
                    "文件校验",
                    "completed",
                    f"已接收 {state['filename']} · 模型 {model_id}",
                    started,
                )
            ]
        }
    except ScoreFormatError as exc:
        return {
            "status": "failed",
            "errors": [str(exc)],
            "steps": [_step("validate", "文件校验", "failed", str(exc), started)],
        }


def optical_recognition(state: ScoreAgentState) -> ScoreAgentState:
    started = perf_counter()
    try:
        musicxml, metadata, annotated_pdf = convert_score_with_omr(
            state["payload"],
            state["filename"],
            state["input_kind"],
            state["options"],
        )
        pages = metadata.get("pages", 1)
        placed = metadata.get("pdf_labels_placed")
        expected = metadata.get("pdf_labels_expected")
        detail = f"HOMR 已识别 {pages} 页图像并转换为 MusicXML"
        if (
            state["input_kind"] == "pdf"
            and placed is not None
            and expected is not None
        ):
            detail = f"{detail}，PDF 已定位 {placed}/{expected} 个音符"
        return {
            "omr_musicxml": musicxml,
            "omr_metadata": metadata,
            "annotated_pdf": annotated_pdf,
            "steps": [
                _step(
                    "omr",
                    "光学识谱",
                    "completed",
                    detail,
                    started,
                )
            ],
        }
    except ScoreFormatError as exc:
        return {
            "status": "failed",
            "errors": [str(exc)],
            "steps": [_step("omr", "光学识谱", "failed", str(exc), started)],
        }


def extract_score(state: ScoreAgentState) -> ScoreAgentState:
    started = perf_counter()
    try:
        if state["input_kind"] == "digital":
            musicxml, source_format = extract_musicxml(
                state["payload"],
                state["filename"],
            )
        else:
            musicxml, _ = extract_musicxml(
                state["omr_musicxml"].encode("utf-8"),
                "recognized.musicxml",
            )
            source_format = f"omr-{state['input_kind']}"
        return {
            "musicxml": musicxml,
            "source_format": source_format,
            "steps": [
                _step(
                    "extract",
                    "解析乐谱",
                    "completed",
                    f"已解析完整 {source_format.upper()} 数据",
                    started,
                )
            ],
        }
    except ScoreFormatError as exc:
        return {
            "status": "failed",
            "errors": [str(exc)],
            "steps": [_step("extract", "解析乐谱", "failed", str(exc), started)],
        }


def recognize_notes(state: ScoreAgentState) -> ScoreAgentState:
    started = perf_counter()
    try:
        notes, summary = analyze_musicxml(state["musicxml"], state["options"])
        return {
            "notes": notes,
            "summary": summary,
            "steps": [
                _step(
                    "recognize",
                    "识别音符",
                    "completed",
                    f"识别到 {summary['note_count']} 个音符、{summary['event_count']} 个发音事件",
                    started,
                )
            ],
        }
    except ScoreFormatError as exc:
        return {
            "status": "failed",
            "errors": [str(exc)],
            "steps": [_step("recognize", "识别音符", "failed", str(exc), started)],
        }


def add_annotations(state: ScoreAgentState) -> ScoreAgentState:
    started = perf_counter()
    try:
        annotated_musicxml, label_count = annotate_musicxml(state["musicxml"], state["options"])
        return {
            "annotated_musicxml": annotated_musicxml,
            "expected_labels": label_count,
            "steps": [
                _step(
                    "annotate",
                    "添加标注",
                    "completed",
                    f"已添加 {label_count} 组 C/D/E/F/G/A/B 标注",
                    started,
                )
            ],
        }
    except ScoreFormatError as exc:
        return {
            "status": "failed",
            "errors": [str(exc)],
            "steps": [_step("annotate", "添加标注", "failed", str(exc), started)],
        }


def verify_result(state: ScoreAgentState) -> ScoreAgentState:
    started = perf_counter()
    actual_labels = count_agent_labels(state["annotated_musicxml"])
    expected_labels = state["expected_labels"]

    if actual_labels != expected_labels:
        detail = f"标注验证失败：预期 {expected_labels}，实际 {actual_labels}"
        return {
            "status": "failed",
            "errors": [detail],
            "steps": [_step("verify", "验证结果", "failed", detail, started)],
        }

    if state.get("input_kind") == "pdf":
        metadata = state.get("omr_metadata", {})
        pdf_expected = metadata.get("pdf_labels_expected")
        pdf_placed = metadata.get("pdf_labels_placed")
        if not state.get("annotated_pdf"):
            detail = "PDF 标注验证失败：没有生成可用的标注 PDF"
            return {
                "status": "failed",
                "errors": [detail],
                "steps": [_step("verify", "验证结果", "failed", detail, started)],
            }
        if pdf_expected is not None and pdf_placed != pdf_expected:
            detail = f"PDF 标注验证失败：预期定位 {pdf_expected}，实际 {pdf_placed}"
            return {
                "status": "failed",
                "errors": [detail],
                "steps": [_step("verify", "验证结果", "failed", detail, started)],
            }

    detail = f"{actual_labels} 组标注均已写入 MusicXML"
    if state.get("input_kind") == "pdf":
        pdf_expected = state["omr_metadata"].get("pdf_labels_expected")
        pdf_placed = state["omr_metadata"].get("pdf_labels_placed")
        if pdf_expected is not None and pdf_placed is not None:
            detail = (
                f"{detail}，{pdf_placed}/{pdf_expected} 个识别音符"
                "已写入原版式 PDF"
            )
        else:
            detail = f"{detail}，已写入原版式 PDF"
    return {
        "status": "completed",
        "steps": [
            _step(
                "verify",
                "验证结果",
                "completed",
                detail,
                started,
            )
        ],
    }


def finish_failure(state: ScoreAgentState) -> ScoreAgentState:
    return {"status": "failed"}


def route_after_step(state: ScoreAgentState) -> str:
    return "failed" if state.get("errors") else "continue"


def route_after_validation(state: ScoreAgentState) -> str:
    if state.get("errors"):
        return "failed"
    return "digital" if state.get("input_kind") == "digital" else "omr"


builder = StateGraph(ScoreAgentState)
builder.add_node("validate_upload", validate_upload)
builder.add_node("optical_recognition", optical_recognition)
builder.add_node("extract_score", extract_score)
builder.add_node("recognize_notes", recognize_notes)
builder.add_node("add_annotations", add_annotations)
builder.add_node("verify_result", verify_result)
builder.add_node("finish_failure", finish_failure)

builder.add_edge(START, "validate_upload")
builder.add_conditional_edges(
    "validate_upload",
    route_after_validation,
    {
        "digital": "extract_score",
        "omr": "optical_recognition",
        "failed": "finish_failure",
    },
)
builder.add_conditional_edges(
    "optical_recognition",
    route_after_step,
    {"continue": "extract_score", "failed": "finish_failure"},
)
builder.add_conditional_edges(
    "extract_score",
    route_after_step,
    {"continue": "recognize_notes", "failed": "finish_failure"},
)
builder.add_conditional_edges(
    "recognize_notes",
    route_after_step,
    {"continue": "add_annotations", "failed": "finish_failure"},
)
builder.add_conditional_edges(
    "add_annotations",
    route_after_step,
    {"continue": "verify_result", "failed": "finish_failure"},
)
builder.add_edge("verify_result", END)
builder.add_edge("finish_failure", END)

score_agent = builder.compile()
