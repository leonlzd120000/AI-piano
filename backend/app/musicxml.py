from __future__ import annotations

from collections import Counter
from copy import deepcopy
from dataclasses import dataclass
from io import BytesIO
from pathlib import PurePosixPath
from typing import Any
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile


MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_EXPANDED_BYTES = 25 * 1024 * 1024
SUPPORTED_SUFFIXES = {".musicxml", ".xml", ".mxl"}
AGENT_LYRIC_NAME = "note-agent"
AGENT_LYRIC_NUMBER = "99"


class ScoreFormatError(ValueError):
    """Raised when an uploaded score cannot be safely parsed."""


@dataclass(frozen=True)
class AnnotationOptions:
    label_style: str = "letter"
    show_accidentals: bool = True

    def validate(self) -> None:
        if self.label_style not in {"letter", "letter_octave"}:
            raise ScoreFormatError("不支持的标注模式")


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def namespace_uri(tag: str) -> str | None:
    if tag.startswith("{"):
        return tag[1:].split("}", 1)[0]
    return None


def qualified(name: str, namespace: str | None) -> str:
    return f"{{{namespace}}}{name}" if namespace else name


def direct_child(element: ET.Element, name: str) -> ET.Element | None:
    return next((child for child in element if local_name(child.tag) == name), None)


def direct_children(element: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in element if local_name(child.tag) == name]


def child_text(element: ET.Element, name: str, default: str = "") -> str:
    child = direct_child(element, name)
    return child.text.strip() if child is not None and child.text else default


def _reject_unsafe_xml(payload: bytes) -> None:
    prefix = payload[:8192].upper()
    if b"<!ENTITY" in prefix:
        raise ScoreFormatError("不允许包含自定义 XML 实体")


def _read_mxl(payload: bytes) -> bytes:
    try:
        with ZipFile(BytesIO(payload)) as archive:
            entries = [entry for entry in archive.infolist() if not entry.is_dir()]
            if not entries:
                raise ScoreFormatError("MXL 文件为空")

            expanded_size = sum(entry.file_size for entry in entries)
            if expanded_size > MAX_EXPANDED_BYTES:
                raise ScoreFormatError("MXL 解压后的文件过大")

            names = {entry.filename for entry in entries}
            score_path: str | None = None

            if "META-INF/container.xml" in names:
                container = ET.fromstring(archive.read("META-INF/container.xml"))
                for element in container.iter():
                    if local_name(element.tag) == "rootfile":
                        candidate = element.attrib.get("full-path")
                        if candidate and candidate in names:
                            score_path = candidate
                            break

            if score_path is None:
                score_path = next(
                    (
                        name
                        for name in names
                        if PurePosixPath(name).suffix.lower() in {".musicxml", ".xml"}
                        and not name.startswith("META-INF/")
                    ),
                    None,
                )

            if score_path is None:
                raise ScoreFormatError("MXL 中没有找到 MusicXML 主文件")

            return archive.read(score_path)
    except BadZipFile as exc:
        raise ScoreFormatError("MXL 压缩包损坏") from exc


def extract_musicxml(payload: bytes, filename: str) -> tuple[str, str]:
    if not payload:
        raise ScoreFormatError("上传文件为空")
    if len(payload) > MAX_UPLOAD_BYTES:
        raise ScoreFormatError("文件不能超过 10 MB")

    suffix = PurePosixPath(filename).suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise ScoreFormatError("仅支持 MusicXML、XML 和 MXL 文件")

    xml_bytes = _read_mxl(payload) if suffix == ".mxl" else payload
    _reject_unsafe_xml(xml_bytes)

    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise ScoreFormatError(f"MusicXML 解析失败：{exc}") from exc

    if local_name(root.tag) != "score-partwise":
        raise ScoreFormatError("当前 Demo 仅支持 score-partwise MusicXML")

    namespace = namespace_uri(root.tag)
    if namespace:
        ET.register_namespace("", namespace)

    normalized = ET.tostring(root, encoding="utf-8", xml_declaration=True).decode("utf-8")
    return normalized, "mxl" if suffix == ".mxl" else "musicxml"


def _pitch_data(note: ET.Element) -> tuple[str, int, int] | None:
    pitch = direct_child(note, "pitch")
    if pitch is None:
        return None

    step = child_text(pitch, "step").upper()
    octave_text = child_text(pitch, "octave")
    if step not in set("CDEFGAB") or not octave_text:
        return None

    alter_text = child_text(pitch, "alter", "0")
    try:
        alter = int(float(alter_text))
        octave = int(octave_text)
    except ValueError:
        return None

    return step, alter, octave


def format_pitch(step: str, alter: int, octave: int, options: AnnotationOptions) -> str:
    accidental = ""
    if options.show_accidentals:
        accidental = {
            -2: "bb",
            -1: "b",
            0: "",
            1: "#",
            2: "##",
        }.get(alter, f"({alter:+d})")

    label = f"{step}{accidental}"
    if options.label_style == "letter_octave":
        label = f"{label}{octave}"
    return label


def analyze_musicxml(xml_text: str, options: AnnotationOptions) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    options.validate()
    root = ET.fromstring(xml_text)
    notes: list[dict[str, Any]] = []
    pitch_counts: Counter[str] = Counter()
    part_count = 0
    measure_count = 0
    event_index = 0

    for part_index, part in enumerate(
        (element for element in root if local_name(element.tag) == "part"),
        start=1,
    ):
        part_count += 1
        measures = direct_children(part, "measure")
        measure_count += len(measures)

        for measure_position, measure in enumerate(measures, start=1):
            measure_number = measure.attrib.get("number", str(measure_position))
            current_event = 0

            for note in direct_children(measure, "note"):
                pitch = _pitch_data(note)
                if pitch is None:
                    continue

                is_chord_note = direct_child(note, "chord") is not None
                if not is_chord_note:
                    event_index += 1
                    current_event = event_index

                step, alter, octave = pitch
                pitch_counts[step] += 1
                notes.append(
                    {
                        "index": len(notes) + 1,
                        "event_index": current_event,
                        "part": part_index,
                        "measure": measure_number,
                        "staff": child_text(note, "staff", "1"),
                        "voice": child_text(note, "voice", "1"),
                        "step": step,
                        "alter": alter,
                        "octave": octave,
                        "label": format_pitch(step, alter, octave, options),
                        "is_chord_note": is_chord_note,
                    }
                )

    if not notes:
        raise ScoreFormatError("乐谱中没有找到可标注的有音高音符")

    return notes, {
        "part_count": part_count,
        "measure_count": measure_count,
        "note_count": len(notes),
        "event_count": event_index,
        "pitch_counts": dict(sorted(pitch_counts.items())),
    }


def _remove_existing_agent_lyrics(note: ET.Element) -> None:
    for lyric in direct_children(note, "lyric"):
        if (
            lyric.attrib.get("name") == AGENT_LYRIC_NAME
            or lyric.attrib.get("number") == AGENT_LYRIC_NUMBER
        ):
            note.remove(lyric)


def annotate_musicxml(xml_text: str, options: AnnotationOptions) -> tuple[str, int]:
    options.validate()
    root = ET.fromstring(xml_text)
    namespace = namespace_uri(root.tag)
    if namespace:
        ET.register_namespace("", namespace)

    label_count = 0

    for part in (element for element in root if local_name(element.tag) == "part"):
        for measure in direct_children(part, "measure"):
            groups: list[list[ET.Element]] = []

            for note in direct_children(measure, "note"):
                _remove_existing_agent_lyrics(note)
                if _pitch_data(note) is None:
                    continue

                if direct_child(note, "chord") is not None and groups:
                    groups[-1].append(note)
                else:
                    groups.append([note])

            for group in groups:
                labels = []
                for note in group:
                    pitch = _pitch_data(note)
                    if pitch is not None:
                        labels.append(format_pitch(*pitch, options))

                if not labels:
                    continue

                lyric = ET.SubElement(
                    group[0],
                    qualified("lyric", namespace),
                    {
                        "number": AGENT_LYRIC_NUMBER,
                        "name": AGENT_LYRIC_NAME,
                        "placement": "below",
                        "justify": "center",
                    },
                )
                syllabic = ET.SubElement(lyric, qualified("syllabic", namespace))
                syllabic.text = "single"
                text = ET.SubElement(lyric, qualified("text", namespace))
                text.text = "/".join(labels)
                label_count += 1

    annotated = ET.tostring(root, encoding="utf-8", xml_declaration=True).decode("utf-8")
    return annotated, label_count


def count_agent_labels(xml_text: str) -> int:
    root = ET.fromstring(xml_text)
    return sum(
        1
        for element in root.iter()
        if local_name(element.tag) == "lyric"
        and (
            element.attrib.get("name") == AGENT_LYRIC_NAME
            or element.attrib.get("number") == AGENT_LYRIC_NUMBER
        )
    )
