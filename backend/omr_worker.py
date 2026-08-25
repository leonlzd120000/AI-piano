from __future__ import annotations

import argparse
import ctypes
import json
import math
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from xml.etree import ElementTree as ET

import cv2
import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageOps


MAX_PDF_PAGES = 8
MAX_RENDER_PIXELS = 22_000_000
MAX_IMAGE_EDGE = 6000
TEMPLATE_PAGE_WIDTH = 2048.0
TEMPLATE_FONT_SIZE = 17.0
TEMPLATE_STROKE_WIDTH = 19.55
TEMPLATE_BASELINE_OFFSET = 15.0
TEMPLATE_DENSE_FONT_SIZE = 14.0
TEMPLATE_DENSE_STROKE_WIDTH = 16.1
TEMPLATE_DENSE_BASELINE_OFFSET = 12.35
TEMPLATE_DENSE_X_TOLERANCE = 8.0
TEMPLATE_DENSE_Y_TOLERANCE = 70.0
PDF_RIGHT_HAND_COLOR = (219, 5, 168, 255)
PDF_LEFT_HAND_COLOR = (5, 82, 224, 255)
HANDWRITING_MIN_RATIO = 0.005


@dataclass(frozen=True)
class RenderedPage:
    image_path: Path
    page_width: float
    page_height: float
    cleaned_pixels: int


@dataclass(frozen=True)
class ExpectedNote:
    step: str
    octave: int
    label: str
    hand: str
    group: int


@dataclass(frozen=True)
class VisualNote:
    step: str
    octave: int
    hand: str
    x: float
    y: float


@dataclass(frozen=True)
class LabelPlacement:
    label: str
    hand: str
    x: float
    y: float


def local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def direct_children(element: ET.Element, name: str) -> list[ET.Element]:
    return [child for child in element if local_name(child.tag) == name]


def normalize_image(source: Path, destination: Path) -> None:
    with Image.open(source) as image:
        normalized = ImageOps.exif_transpose(image).convert("RGB")
        if max(normalized.size) > MAX_IMAGE_EDGE:
            normalized.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
        normalized.save(destination, format="PNG", optimize=True)


def clean_colored_handwriting(image: Image.Image) -> tuple[Image.Image, int]:
    rgb = np.asarray(image.convert("RGB"), dtype=np.int16)
    red = rgb[:, :, 0]
    green = rgb[:, :, 1]
    blue = rgb[:, :, 2]
    spread = rgb.max(axis=2) - rgb.min(axis=2)

    magenta = (red > green + 28) & (blue > green + 8)
    blue_ink = (blue > red + 18) & (blue > green + 5)
    cyan = (blue > red + 18) & (green > red + 12)
    color_family = magenta | blue_ink | cyan
    strong_mask = (
        (spread > 60)
        & (rgb.max(axis=2) > 105)
        & color_family
    )
    if float(strong_mask.mean()) < HANDWRITING_MIN_RATIO:
        return image, 0

    mask = (spread > 32) & (rgb.max(axis=2) > 95) & color_family
    cleaned_pixels = int(mask.sum())

    cleaned = rgb.copy()
    cleaned[mask] = 255
    return Image.fromarray(cleaned.astype(np.uint8), "RGB"), cleaned_pixels


def render_pdf(source: Path, destination_dir: Path) -> list[RenderedPage]:
    document = pdfium.PdfDocument(str(source))
    page_count = len(document)
    if page_count == 0:
        raise ValueError("PDF 没有页面")
    if page_count > MAX_PDF_PAGES:
        raise ValueError(f"PDF 最多支持 {MAX_PDF_PAGES} 页")

    images: list[RenderedPage] = []
    try:
        for page_index in range(page_count):
            page = document[page_index]
            width, height = page.get_size()
            preferred_scale = min(4.0, TEMPLATE_PAGE_WIDTH / width)
            projected_pixels = width * height * preferred_scale * preferred_scale
            scale = (
                preferred_scale
                if projected_pixels <= MAX_RENDER_PIXELS
                else math.sqrt(MAX_RENDER_PIXELS / (width * height))
            )
            bitmap = page.render(scale=scale)
            image = bitmap.to_pil().convert("RGB")
            image, cleaned_pixels = clean_colored_handwriting(image)
            output = destination_dir / f"page-{page_index + 1:03d}.png"
            image.save(output, format="PNG", optimize=True)
            images.append(RenderedPage(output, width, height, cleaned_pixels))
            page.close()
    finally:
        document.close()

    return images


def recognize_page(image_path: Path, output: Path):
    import onnxruntime as ort
    from homr.main import ProcessingConfig, detect_staffs_in_image
    from homr.music_xml_generator import XmlGeneratorArguments, generate_xml
    from homr.onnx_providers import coreml_available, cuda_available
    from homr.staff_parsing import parse_staffs
    from homr.transformer.configs import Config

    use_cuda = cuda_available()
    config = ProcessingConfig(
        False,
        False,
        False,
        False,
        -1,
        use_cuda,
        use_cuda or coreml_available(),
        False,
    )
    ort.set_default_logger_severity(3)
    multi_staffs, processed_image, debug, title_future = detect_staffs_in_image(
        str(image_path),
        config,
    )
    try:
        transformer_config = Config()
        transformer_config.use_gpu_inference = use_cuda
        result_staffs = parse_staffs(
            debug,
            multi_staffs,
            processed_image,
            selected_staff=-1,
            config=transformer_config,
        )
        title = title_future.result(60)
        xml = generate_xml(XmlGeneratorArguments(), result_staffs, title)
        xml.write(output)
        return multi_staffs, processed_image.shape
    finally:
        debug.clean_debug_files_from_previous_runs()


def accidental_text(alter: int, show_accidentals: bool) -> str:
    if not show_accidentals:
        return ""
    return {
        -2: "bb",
        -1: "b",
        0: "",
        1: "#",
        2: "##",
    }.get(alter, f"({alter:+d})")


def expected_systems(
    musicxml: Path,
    label_style: str,
    show_accidentals: bool,
) -> list[list[ExpectedNote]]:
    root = ET.parse(musicxml).getroot()
    part = next((child for child in root if local_name(child.tag) == "part"), None)
    if part is None:
        return []

    systems: list[list[ExpectedNote]] = []
    current: list[ExpectedNote] = []
    group = 0
    for measure in direct_children(part, "measure"):
        starts_system = any(
            local_name(child.tag) == "print"
            and child.attrib.get("new-system") == "yes"
            for child in measure
        )
        if starts_system and current:
            systems.append(current)
            current = []
            group = 0

        for note in direct_children(measure, "note"):
            pitch = next(
                (child for child in note if local_name(child.tag) == "pitch"),
                None,
            )
            if pitch is None:
                continue
            values = {
                local_name(child.tag): (child.text or "").strip()
                for child in pitch
            }
            step = values.get("step", "").upper()
            try:
                octave = int(values["octave"])
                alter = int(float(values.get("alter", "0")))
            except (KeyError, ValueError):
                continue
            if step not in "CDEFGAB":
                continue

            staff = next(
                (
                    (child.text or "").strip()
                    for child in note
                    if local_name(child.tag) == "staff"
                ),
                "1",
            )
            is_chord_note = any(
                local_name(child.tag) == "chord"
                for child in note
            )
            if not is_chord_note:
                group += 1
            label = f"{step}{accidental_text(alter, show_accidentals)}"
            if label_style == "letter_octave":
                label = f"{label}{octave}"
            current.append(
                ExpectedNote(
                    step=step,
                    octave=octave,
                    label=label,
                    hand="left" if staff == "2" else "right",
                    group=group,
                )
            )

    if current:
        systems.append(current)
    return systems


def nearest_staff_point(staff, x: float):
    point = staff.get_at(x)
    if point is not None:
        return point
    return min(staff.grid, key=lambda candidate: abs(candidate.x - x))


def visual_pitch(staff, note, hand: str) -> tuple[str, int]:
    bottom_step = 2 if hand == "right" else 4
    bottom_octave = 4 if hand == "right" else 2
    diatonic = bottom_octave * 7 + bottom_step + note.position - 1
    return "CDEFGAB"[diatonic % 7], diatonic // 7


def visual_system_notes(multi_staff) -> list[VisualNote]:
    visual_notes: list[VisualNote] = []
    for staff_index, staff in enumerate(multi_staff.staffs):
        for note in staff.get_notes():
            point = nearest_staff_point(staff, float(note.center[0]))
            if len(point.y) >= 10:
                hand = (
                    "right"
                    if float(note.center[1]) < (point.y[4] + point.y[5]) / 2
                    else "left"
                )
            elif len(multi_staff.staffs) > 1:
                hand = "right" if staff_index == 0 else "left"
            else:
                hand = "right"
            step, octave = visual_pitch(staff, note, hand)
            visual_notes.append(
                VisualNote(
                    step=step,
                    octave=octave,
                    hand=hand,
                    x=float(note.center[0]),
                    y=float(note.center[1]),
                )
            )

    return visual_notes


def pitch_y(multi_staff, note: ExpectedNote, x: float) -> float:
    staff = (
        multi_staff.staffs[0]
        if note.hand == "right"
        else multi_staff.staffs[-1]
    )
    point = nearest_staff_point(staff, x)
    if len(point.y) >= 10:
        lines = point.y[:5] if note.hand == "right" else point.y[-5:]
    else:
        lines = point.y
    line_spacing = float(np.median(np.diff(lines)))
    bottom_diatonic = 4 * 7 + 2 if note.hand == "right" else 2 * 7 + 4
    target_diatonic = note.octave * 7 + "CDEFGAB".index(note.step)
    return float(
        lines[-1]
        - (target_diatonic - bottom_diatonic) * line_spacing / 2
    )


def recover_missing_notes(
    expected_system: list[ExpectedNote],
    visual: list[VisualNote],
    matched: list[tuple[ExpectedNote, VisualNote]],
    multi_staff,
) -> list[tuple[ExpectedNote, VisualNote]]:
    matched_by_expected = {
        id(expected_note): visual_note
        for expected_note, visual_note in matched
    }
    group_x: dict[tuple[str, int], list[float]] = {}
    for expected_note, visual_note in matched:
        group_x.setdefault(
            (expected_note.hand, expected_note.group),
            [],
        ).append(visual_note.x)

    recovered: list[tuple[ExpectedNote, VisualNote]] = []
    for note_index, expected_note in enumerate(expected_system):
        if id(expected_note) in matched_by_expected:
            continue

        chord_x = group_x.get((expected_note.hand, expected_note.group), [])
        if chord_x:
            x = float(np.median(chord_x))
        else:
            prior = next(
                (
                    matched_by_expected[id(candidate)]
                    for candidate in reversed(expected_system[:note_index])
                    if candidate.hand == expected_note.hand
                    and id(candidate) in matched_by_expected
                ),
                None,
            )
            following = next(
                (
                    matched_by_expected[id(candidate)]
                    for candidate in expected_system[note_index + 1 :]
                    if candidate.hand == expected_note.hand
                    and id(candidate) in matched_by_expected
                ),
                None,
            )
            if prior is not None and following is not None:
                x = (prior.x + following.x) / 2
            elif prior is not None:
                x = prior.x
            elif following is not None:
                x = following.x
            elif visual:
                x = float(np.median([note.x for note in visual]))
            else:
                continue

        visual_note = VisualNote(
            step=expected_note.step,
            octave=expected_note.octave,
            hand=expected_note.hand,
            x=x,
            y=pitch_y(multi_staff, expected_note, x),
        )
        recovered.append((expected_note, visual_note))
        matched_by_expected[id(expected_note)] = visual_note
        group_x.setdefault(
            (expected_note.hand, expected_note.group),
            [],
        ).append(x)

    return recovered


def align_notes(
    expected: list[ExpectedNote],
    detected: list[VisualNote],
) -> list[tuple[ExpectedNote, VisualNote]]:
    expected_count = len(expected)
    detected_count = len(detected)
    infinity = float("inf")
    costs = [
        [infinity] * (detected_count + 1)
        for _ in range(expected_count + 1)
    ]
    previous: list[list[tuple[str, int, int] | None]] = [
        [None] * (detected_count + 1)
        for _ in range(expected_count + 1)
    ]
    costs[0][0] = 0.0

    for expected_index in range(expected_count + 1):
        for detected_index in range(detected_count + 1):
            current_cost = costs[expected_index][detected_index]
            if current_cost == infinity:
                continue

            if expected_index < expected_count and detected_index < detected_count:
                expected_note = expected[expected_index]
                detected_note = detected[detected_index]
                if (
                    expected_note.step == detected_note.step
                    and expected_note.octave == detected_note.octave
                ):
                    match_cost = 0.0
                elif expected_note.step == detected_note.step:
                    match_cost = 0.7
                else:
                    match_cost = 1.8
                if expected_note.hand != detected_note.hand:
                    match_cost += 0.9
                candidate = current_cost + match_cost
                if candidate < costs[expected_index + 1][detected_index + 1]:
                    costs[expected_index + 1][detected_index + 1] = candidate
                    previous[expected_index + 1][detected_index + 1] = (
                        "match",
                        expected_index,
                        detected_index,
                    )

            if expected_index < expected_count:
                candidate = current_cost + 2.6
                if candidate < costs[expected_index + 1][detected_index]:
                    costs[expected_index + 1][detected_index] = candidate
                    previous[expected_index + 1][detected_index] = (
                        "skip_expected",
                        expected_index,
                        detected_index,
                    )

            if detected_index < detected_count:
                candidate = current_cost + 0.65
                if candidate < costs[expected_index][detected_index + 1]:
                    costs[expected_index][detected_index + 1] = candidate
                    previous[expected_index][detected_index + 1] = (
                        "skip_detected",
                        expected_index,
                        detected_index,
                    )

    pairs: list[tuple[ExpectedNote, VisualNote]] = []
    expected_index = expected_count
    detected_index = detected_count
    while expected_index or detected_index:
        step = previous[expected_index][detected_index]
        if step is None:
            break
        action, prior_expected, prior_detected = step
        if action == "match":
            pairs.append(
                (
                    expected[prior_expected],
                    detected[prior_detected],
                )
            )
        expected_index = prior_expected
        detected_index = prior_detected

    pairs.reverse()
    return pairs


def build_page_placements(
    expected: list[list[ExpectedNote]],
    multi_staffs,
    processed_shape: tuple[int, ...],
    page_width: float,
    page_height: float,
) -> tuple[list[LabelPlacement], int]:
    placements: list[LabelPlacement] = []
    expected_count = sum(len(system) for system in expected)
    processed_height, processed_width = processed_shape[:2]
    x_scale = page_width / processed_width
    y_scale = page_height / processed_height

    for expected_system, multi_staff in zip(expected, multi_staffs, strict=False):
        visual = visual_system_notes(multi_staff)
        matched: list[tuple[ExpectedNote, VisualNote]] = []
        expected_ids: set[int] = set()
        visual_ids: set[int] = set()
        for hand in ("right", "left"):
            expected_hand = [note for note in expected_system if note.hand == hand]
            detected_hand = sorted(
                (note for note in visual if note.hand == hand),
                key=lambda note: (note.x, note.y),
            )
            hand_pairs = align_notes(expected_hand, detected_hand)
            matched.extend(hand_pairs)
            expected_ids.update(id(note) for note, _ in hand_pairs)
            visual_ids.update(id(note) for _, note in hand_pairs)

        remaining_expected = [
            note for note in expected_system if id(note) not in expected_ids
        ]
        remaining_visual = sorted(
            (note for note in visual if id(note) not in visual_ids),
            key=lambda note: (note.x, note.y),
        )
        recovery_pairs = align_notes(remaining_expected, remaining_visual)
        matched.extend(
            (expected_note, visual_note)
            for expected_note, visual_note in recovery_pairs
            if expected_note.step == visual_note.step
            and expected_note.octave == visual_note.octave
        )
        matched.extend(
            recover_missing_notes(
                expected_system,
                visual,
                matched,
                multi_staff,
            )
        )

        for expected_note, visual_note in matched:
            placements.append(
                LabelPlacement(
                    label=expected_note.label,
                    hand=expected_note.hand,
                    x=visual_note.x * x_scale,
                    y=visual_note.y * y_scale,
                )
            )

    return placements, expected_count


def create_text_object(
    document,
    font,
    text: str,
    font_size: float,
    x: float,
    y: float,
    fill: tuple[int, int, int, int],
    render_mode: int,
    stroke: tuple[int, int, int, int] | None = None,
    stroke_width: float = 1.0,
):
    raw_object = pdfium.raw.FPDFPageObj_CreateTextObj(document, font, font_size)
    if not raw_object:
        raise RuntimeError("无法创建 PDF 文字对象")
    text_object = pdfium.PdfTextObj(raw_object, pdf=document)

    encoded = text.encode("utf-16-le") + b"\x00\x00"
    units = (ctypes.c_ushort * (len(encoded) // 2)).from_buffer_copy(encoded)
    if not pdfium.raw.FPDFText_SetText(text_object, units):
        raise RuntimeError("无法写入 PDF 标注文字")
    if not pdfium.raw.FPDFTextObj_SetTextRenderMode(text_object, render_mode):
        raise RuntimeError("无法设置 PDF 文字渲染模式")
    if not pdfium.raw.FPDFPageObj_SetFillColor(text_object, *fill):
        raise RuntimeError("无法设置 PDF 文字颜色")
    if stroke is not None:
        if not pdfium.raw.FPDFPageObj_SetStrokeColor(text_object, *stroke):
            raise RuntimeError("无法设置 PDF 文字描边颜色")
        if not pdfium.raw.FPDFPageObj_SetStrokeWidth(text_object, stroke_width):
            raise RuntimeError("无法设置 PDF 文字描边宽度")
    text_object.set_matrix(pdfium.PdfMatrix(e=x, f=y))
    return text_object


def text_width(font, text: str, font_size: float) -> float:
    width = 0.0
    for character in text:
        glyph_width = ctypes.c_float()
        if pdfium.raw.FPDFFont_GetGlyphWidth(
            font,
            ord(character),
            font_size,
            glyph_width,
        ):
            width += glyph_width.value
    return width


def build_raster_document(
    rendered_pages: list[RenderedPage],
    workspace: Path,
):
    document = pdfium.PdfDocument.new()
    for page_index, rendered in enumerate(rendered_pages):
        page = document.new_page(rendered.page_width, rendered.page_height)
        jpeg_path = workspace / f"cleaned-page-{page_index + 1:03d}.jpg"
        with Image.open(rendered.image_path) as image:
            image.convert("RGB").save(
                jpeg_path,
                format="JPEG",
                quality=96,
                subsampling=0,
                optimize=True,
            )
        image_object = pdfium.PdfImage.new(document)
        image_object.load_jpeg(jpeg_path, inline=True)
        image_object.set_matrix(
            pdfium.PdfMatrix(
                a=rendered.page_width,
                d=rendered.page_height,
            )
        )
        page.insert_obj(image_object)
        page.gen_content()
        page.close()
    return document


def create_annotated_pdf(
    source: Path,
    output: Path,
    rendered_pages: list[RenderedPage],
    page_placements: list[list[LabelPlacement]],
    workspace: Path,
) -> None:
    if any(page.cleaned_pixels for page in rendered_pages):
        document = build_raster_document(rendered_pages, workspace)
    else:
        document = pdfium.PdfDocument(str(source))

    font = pdfium.PdfFont.load_standard(document, "Helvetica-Bold")
    try:
        for page_index, placements in enumerate(page_placements):
            page = document[page_index]
            page_width, page_height = page.get_size()
            page_scale = page_width / TEMPLATE_PAGE_WIDTH

            for placement in placements:
                is_dense = any(
                    other is not placement
                    and other.hand == placement.hand
                    and abs(other.x - placement.x)
                    <= TEMPLATE_DENSE_X_TOLERANCE * page_scale
                    and abs(other.y - placement.y)
                    <= TEMPLATE_DENSE_Y_TOLERANCE * page_scale
                    for other in placements
                )
                if is_dense:
                    font_size = TEMPLATE_DENSE_FONT_SIZE * page_scale
                    stroke_width = TEMPLATE_DENSE_STROKE_WIDTH * page_scale
                    baseline_offset = (
                        TEMPLATE_DENSE_BASELINE_OFFSET * page_scale
                    )
                else:
                    font_size = TEMPLATE_FONT_SIZE * page_scale
                    stroke_width = TEMPLATE_STROKE_WIDTH * page_scale
                    baseline_offset = TEMPLATE_BASELINE_OFFSET * page_scale
                width = text_width(font, placement.label, font_size)
                text_x = placement.x - width / 2
                text_y = page_height - placement.y + baseline_offset
                halo = create_text_object(
                    document,
                    font,
                    placement.label,
                    font_size,
                    text_x,
                    text_y,
                    (0, 0, 0, 255),
                    pdfium.raw.FPDF_TEXTRENDERMODE_FILL_STROKE,
                    (255, 255, 255, 255),
                    stroke_width,
                )
                page.insert_obj(halo)
                color = (
                    PDF_RIGHT_HAND_COLOR
                    if placement.hand == "right"
                    else PDF_LEFT_HAND_COLOR
                )
                fill = create_text_object(
                    document,
                    font,
                    placement.label,
                    font_size,
                    text_x,
                    text_y,
                    color,
                    pdfium.raw.FPDF_TEXTRENDERMODE_FILL,
                )
                page.insert_obj(fill)
            page.gen_content()
            page.close()
        document.save(output)
    finally:
        document.close()


def merge_musicxml(files: list[Path], output: Path) -> None:
    if not files:
        raise ValueError("没有可合并的 MusicXML")

    base_root = ET.parse(files[0]).getroot()
    namespace = (
        base_root.tag[1:].split("}", 1)[0]
        if base_root.tag.startswith("{")
        else None
    )
    if namespace:
        ET.register_namespace("", namespace)

    base_parts = direct_children(base_root, "part")
    measure_numbers = [len(direct_children(part, "measure")) for part in base_parts]

    for file in files[1:]:
        page_root = ET.parse(file).getroot()
        page_parts = direct_children(page_root, "part")
        if len(page_parts) != len(base_parts):
            raise ValueError("不同 PDF 页识别出了不同数量的乐器声部")

        for part_index, page_part in enumerate(page_parts):
            for measure in direct_children(page_part, "measure"):
                measure_numbers[part_index] += 1
                measure.set("number", str(measure_numbers[part_index]))
                base_parts[part_index].append(measure)

    output.write_bytes(
        ET.tostring(base_root, encoding="utf-8", xml_declaration=True)
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--annotated-pdf", type=Path)
    parser.add_argument(
        "--label-style",
        choices=("letter", "letter_octave"),
        default="letter",
    )
    parser.add_argument("--hide-accidentals", action="store_true")
    args = parser.parse_args()

    with TemporaryDirectory(prefix="homr-pages-") as temp_dir:
        workspace = Path(temp_dir)
        if args.input.suffix.lower() == ".pdf":
            rendered_pages = render_pdf(args.input, workspace)
        else:
            normalized = workspace / "page-001.png"
            normalize_image(args.input, normalized)
            with Image.open(normalized) as image:
                width, height = image.size
            rendered_pages = [
                RenderedPage(
                    normalized,
                    float(width),
                    float(height),
                    0,
                )
            ]

        recognized: list[Path] = []
        page_placements: list[list[LabelPlacement]] = []
        expected_labels = 0
        placed_labels = 0
        for page_index, rendered in enumerate(rendered_pages):
            recognized_xml = workspace / f"page-{page_index + 1:03d}.musicxml"
            multi_staffs, processed_shape = recognize_page(
                rendered.image_path,
                recognized_xml,
            )
            recognized.append(recognized_xml)
            expected = expected_systems(
                recognized_xml,
                args.label_style,
                not args.hide_accidentals,
            )
            placements, page_expected = build_page_placements(
                expected,
                multi_staffs,
                processed_shape,
                rendered.page_width,
                rendered.page_height,
            )
            page_placements.append(placements)
            expected_labels += page_expected
            placed_labels += len(placements)

        merge_musicxml(recognized, args.output)
        if args.annotated_pdf:
            create_annotated_pdf(
                args.input,
                args.annotated_pdf,
                rendered_pages,
                page_placements,
                workspace,
            )

    print(
        json.dumps(
            {
                "engine": "homr-0.7.0",
                "pages": len(rendered_pages),
                "pdf_labels_expected": expected_labels,
                "pdf_labels_placed": placed_labels,
                "cleaned_pixels": sum(
                    page.cleaned_pixels for page in rendered_pages
                ),
            }
        )
    )


if __name__ == "__main__":
    main()
