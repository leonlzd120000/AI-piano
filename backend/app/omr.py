from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Literal

from .musicxml import (
    MAX_UPLOAD_BYTES,
    AnnotationOptions,
    ScoreFormatError,
    extract_musicxml,
)


InputKind = Literal["digital", "image", "pdf"]

DIGITAL_SUFFIXES = {".musicxml", ".xml", ".mxl"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}
PDF_SUFFIXES = {".pdf"}
SUPPORTED_UPLOAD_SUFFIXES = DIGITAL_SUFFIXES | IMAGE_SUFFIXES | PDF_SUFFIXES

BACKEND_DIR = Path(__file__).resolve().parent.parent
DEFAULT_OMR_PYTHON = BACKEND_DIR / ".omr-venv" / "bin" / "python"
OMR_WORKER = BACKEND_DIR / "omr_worker.py"


def classify_score_input(filename: str, payload: bytes) -> InputKind:
    if not filename:
        raise ScoreFormatError("缺少文件名")
    if not payload:
        raise ScoreFormatError("上传文件为空")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise ScoreFormatError("文件不能超过 20 MB")

    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_UPLOAD_SUFFIXES:
        raise ScoreFormatError(
            "仅支持 MusicXML、MXL、PDF、PNG、JPG、WEBP 和 TIFF 乐谱"
        )

    if suffix in DIGITAL_SUFFIXES:
        return "digital"

    if suffix == ".pdf":
        if not payload.startswith(b"%PDF-"):
            raise ScoreFormatError("PDF 文件签名无效")
        return "pdf"

    signatures = {
        ".png": payload.startswith(b"\x89PNG\r\n\x1a\n"),
        ".jpg": payload.startswith(b"\xff\xd8\xff"),
        ".jpeg": payload.startswith(b"\xff\xd8\xff"),
        ".webp": payload.startswith(b"RIFF")
        and len(payload) >= 12
        and payload[8:12] == b"WEBP",
        ".tif": payload.startswith((b"II*\x00", b"MM\x00*")),
        ".tiff": payload.startswith((b"II*\x00", b"MM\x00*")),
    }
    if not signatures.get(suffix, False):
        raise ScoreFormatError("图片文件签名与扩展名不匹配")
    return "image"


def _failure_detail(process: subprocess.CompletedProcess[str]) -> str:
    output = "\n".join(
        line.strip()
        for line in (process.stderr or process.stdout).splitlines()
        if line.strip()
    )
    if not output:
        return "OMR 子进程没有返回错误信息"
    return output[-1200:]


def convert_score_with_omr(
    payload: bytes,
    filename: str,
    input_kind: InputKind,
    options: AnnotationOptions,
) -> tuple[str, dict[str, Any], bytes | None]:
    python_path = Path(os.environ.get("OMR_PYTHON", str(DEFAULT_OMR_PYTHON)))
    if not python_path.exists():
        raise ScoreFormatError(
            "OMR 环境尚未安装，请在 backend/.omr-venv 中安装 homr 和 pypdfium2"
        )

    suffix = Path(filename).suffix.lower()
    with TemporaryDirectory(prefix="score-agent-omr-") as temp_dir:
        workspace = Path(temp_dir)
        input_path = workspace / f"input{suffix}"
        output_path = workspace / "recognized.musicxml"
        annotated_pdf_path = workspace / "annotated.pdf"
        input_path.write_bytes(payload)

        command = [
            str(python_path),
            str(OMR_WORKER),
            "--input",
            str(input_path),
            "--output",
            str(output_path),
            "--label-style",
            options.label_style,
        ]
        if not options.show_accidentals:
            command.append("--hide-accidentals")
        if input_kind == "pdf":
            command.extend(["--annotated-pdf", str(annotated_pdf_path)])

        try:
            process = subprocess.run(
                command,
                cwd=workspace,
                capture_output=True,
                check=False,
                text=True,
                timeout=900,
            )
        except subprocess.TimeoutExpired as exc:
            raise ScoreFormatError("光学识谱超时，请减少 PDF 页数或上传更清晰的图片") from exc

        if process.returncode != 0:
            raise ScoreFormatError(f"光学识谱失败：{_failure_detail(process)}")
        if not output_path.exists():
            raise ScoreFormatError("光学识谱没有生成 MusicXML")

        metadata = None
        for line in reversed(process.stdout.strip().splitlines()):
            try:
                candidate = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict) and candidate.get("engine"):
                metadata = candidate
                break
        if metadata is None:
            metadata = {"engine": "homr", "pages": 1}

        musicxml, _ = extract_musicxml(
            output_path.read_bytes(),
            output_path.name,
        )
        metadata["source_kind"] = input_kind
        annotated_pdf = (
            annotated_pdf_path.read_bytes()
            if annotated_pdf_path.exists()
            else None
        )
        return musicxml, metadata, annotated_pdf
