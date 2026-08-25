from pathlib import Path

from app.agent import score_agent
from app.musicxml import (
    AnnotationOptions,
    count_agent_labels,
)
from app.omr import classify_score_input


SAMPLE = Path(__file__).resolve().parent.parent / "sample_scores" / "c-major.musicxml"


def test_agent_annotates_sample_score() -> None:
    result = score_agent.invoke(
        {
            "filename": SAMPLE.name,
            "payload": SAMPLE.read_bytes(),
            "options": AnnotationOptions(label_style="letter", show_accidentals=True),
            "steps": [],
            "errors": [],
        }
    )

    assert result["status"] == "completed"
    assert result["errors"] == []
    assert result["summary"]["note_count"] == 12
    assert result["summary"]["event_count"] == 10
    assert count_agent_labels(result["annotated_musicxml"]) == 10
    assert [step["status"] for step in result["steps"]] == ["completed"] * 5


def test_agent_can_include_octaves() -> None:
    result = score_agent.invoke(
        {
            "filename": SAMPLE.name,
            "payload": SAMPLE.read_bytes(),
            "options": AnnotationOptions(label_style="letter_octave", show_accidentals=True),
            "steps": [],
            "errors": [],
        }
    )

    assert ">C4<" in result["annotated_musicxml"]
    assert ">C3/E3/G3<" in result["annotated_musicxml"]


def test_agent_rejects_unsupported_file() -> None:
    result = score_agent.invoke(
        {
            "filename": "score.docx",
            "payload": b"not-a-score",
            "options": AnnotationOptions(),
            "steps": [],
            "errors": [],
        }
    )

    assert result["status"] == "failed"
    assert result["errors"]
    assert result["steps"][-1]["status"] == "failed"


def test_agent_routes_image_through_omr(monkeypatch) -> None:
    def fake_omr(payload, filename, input_kind, options):
        assert filename == "score.png"
        assert input_kind == "image"
        assert options.label_style == "letter"
        return SAMPLE.read_text(), {"engine": "test-omr", "pages": 1}, None

    monkeypatch.setattr("app.agent.convert_score_with_omr", fake_omr)
    result = score_agent.invoke(
        {
            "filename": "score.png",
            "payload": b"\x89PNG\r\n\x1a\nfake-image",
            "options": AnnotationOptions(),
            "steps": [],
            "errors": [],
        }
    )

    assert result["status"] == "completed"
    assert result["source_format"] == "omr-image"
    assert result["omr_metadata"]["engine"] == "test-omr"
    assert [step["title"] for step in result["steps"]] == [
        "文件校验",
        "光学识谱",
        "解析乐谱",
        "识别音符",
        "添加标注",
        "验证结果",
    ]


def test_pdf_signature_is_validated() -> None:
    assert classify_score_input("score.pdf", b"%PDF-1.7\n") == "pdf"
