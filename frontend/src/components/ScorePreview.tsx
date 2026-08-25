import { FileMusic, Hand, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ScoreNote } from "../types";
import { PdfCanvasPreview } from "./PdfCanvasPreview";

interface ScorePreviewProps {
  musicxml: string | null;
  notes: ScoreNote[];
  processing: boolean;
  pdfUrl: string | null;
}

const NOTE_COLORS: Record<string, string> = {
  C: "#2563eb",
  D: "#059669",
  E: "#d97706",
  F: "#dc2626",
  G: "#7c3aed",
  A: "#db2777",
  B: "#0891b2"
};

type PracticeHand = "right" | "left";

const PRACTICE_COLORS: Record<PracticeHand, string> = {
  right: "#f59e0b",
  left: "#8bd8cc"
};

const SCORE_HAND_COLORS: Record<PracticeHand, string> = {
  right: "#c92ca4",
  left: "#2250d8"
};

const BLACK_PITCH_CLASSES = new Set([1, 3, 6, 8, 10]);
const PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

interface PianoKey {
  midi: number;
  name: string;
  isBlack: boolean;
  whiteIndex: number;
}

function buildPianoKeys(): PianoKey[] {
  const keys: PianoKey[] = [];
  let whiteIndex = -1;
  for (let midi = 21; midi <= 108; midi += 1) {
    const isBlack = BLACK_PITCH_CLASSES.has(midi % 12);
    if (!isBlack) whiteIndex += 1;
    keys.push({
      midi,
      name: `${PITCH_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`,
      isBlack,
      whiteIndex
    });
  }
  return keys;
}

const PIANO_KEYS = buildPianoKeys();

function noteToMidi(note: ScoreNote): number {
  const pitchClass = ["C", "D", "E", "F", "G", "A", "B"].indexOf(note.step);
  const naturalOffsets = [0, 2, 4, 5, 7, 9, 11];
  return (note.octave + 1) * 12 + naturalOffsets[pitchClass] + note.alter;
}

function midiToKeyboardPosition(midi: number): number {
  const key = PIANO_KEYS.find((candidate) => candidate.midi === midi);
  if (!key) return 0;
  return key.isBlack
    ? ((key.whiteIndex + 1) / 52) * 100
    : ((key.whiteIndex + 0.5) / 52) * 100;
}

function noteSort(a: ScoreNote, b: ScoreNote): number {
  return a.event_index - b.event_index || noteToMidi(a) - noteToMidi(b);
}

function notePitchName(note: ScoreNote): string {
  if (!note.alter) return note.step;
  const accidental = note.alter > 0 ? "#" : "b";
  return `${note.step}${accidental.repeat(Math.abs(note.alter))}`;
}

function isNoteForHand(note: ScoreNote, hand: PracticeHand): boolean {
  if (note.staff === "1") return hand === "right";
  if (note.staff === "2") return hand === "left";
  if (note.voice === "5") return hand === "left";
  return hand === "right";
}

function handForNote(note: ScoreNote): PracticeHand {
  return isNoteForHand(note, "left") ? "left" : "right";
}

interface Toolkit {
  setOptions(options: Record<string, unknown>): void;
  loadData(data: string): boolean;
  getPageCount(): number;
  renderToSVG(page: number, options?: Record<string, unknown>): string;
}

interface RenderedScorePage {
  svg: string;
  notes: ScoreNote[];
}

let toolkitPromise: Promise<Toolkit> | null = null;

async function getToolkit(): Promise<Toolkit> {
  if (!toolkitPromise) {
    toolkitPromise = Promise.all([
      import("verovio/wasm"),
      import("verovio/esm")
    ]).then(async ([wasmModule, toolkitModule]) => {
      const module = await wasmModule.default();
      return new toolkitModule.VerovioToolkit(module);
    });
  }
  return toolkitPromise;
}

function stripAgentLyrics(musicxml: string): string {
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(musicxml, "application/xml");
  const elements = Array.from(documentNode.getElementsByTagName("*"));

  elements.forEach((element) => {
    if (
      element.localName === "lyric" &&
      (element.getAttribute("name") === "note-agent" ||
        element.getAttribute("number") === "99")
    ) {
      element.remove();
    }
  });

  return new XMLSerializer().serializeToString(documentNode);
}

function buildLargeScoreChunks(
  musicxml: string,
  notes: ScoreNote[],
  measuresPerChunk = 8
): Array<{ musicxml: string; notes: ScoreNote[] }> {
  const parser = new DOMParser();
  const source = parser.parseFromString(musicxml, "application/xml");
  const parts = Array.from(source.getElementsByTagNameNS("*", "part"));
  const firstPartMeasures = Array.from(parts[0]?.children ?? []).filter(
    (element) => element.localName === "measure"
  );

  if (!parts.length || !firstPartMeasures.length) {
    return [{ musicxml, notes }];
  }

  const root = source.documentElement;
  const chunks: Array<{ musicxml: string; notes: ScoreNote[] }> = [];
  const noteMeasureIndexes = new Map(
    firstPartMeasures.map((measure, index) => [
      measure.getAttribute("number") ?? String(index + 1),
      index
    ])
  );

  for (
    let start = 0;
    start < firstPartMeasures.length;
    start += measuresPerChunk
  ) {
    const measureIndexes = new Set(
      Array.from(
        {
          length: Math.min(
            measuresPerChunk,
            firstPartMeasures.length - start
          )
        },
        (_, offset) => start + offset
      )
    );
    const chunkRoot = root.cloneNode(false) as Element;

    Array.from(root.children)
      .filter((child) => child.localName !== "part")
      .forEach((child) => chunkRoot.appendChild(child.cloneNode(true)));

    parts.forEach((part) => {
      const chunkPart = part.cloneNode(false) as Element;
      let measureIndex = 0;
      Array.from(part.children).forEach((child) => {
        if (child.localName === "measure") {
          if (measureIndexes.has(measureIndex)) {
            const chunkMeasure = child.cloneNode(true) as Element;
            if (measureIndex === start && start > 0) {
              const initialAttributes = Array.from(
                firstPartMeasures[0].children
              ).find((candidate) => candidate.localName === "attributes");
              const existingAttributes = Array.from(
                chunkMeasure.children
              ).find((candidate) => candidate.localName === "attributes");
              if (initialAttributes && !existingAttributes) {
                chunkMeasure.insertBefore(
                  initialAttributes.cloneNode(true),
                  chunkMeasure.firstChild
                );
              }
            }
            chunkPart.appendChild(chunkMeasure);
          }
          measureIndex += 1;
        } else {
          chunkPart.appendChild(child.cloneNode(true));
        }
      });
      chunkRoot.appendChild(chunkPart);
    });

    chunks.push({
      musicxml: new XMLSerializer().serializeToString(chunkRoot),
      notes: notes.filter((note) =>
        measureIndexes.has(noteMeasureIndexes.get(note.measure) ?? -1)
      )
    });
  }

  return chunks;
}

function parseTranslate(transform: string | null): { x: number; y: number } | null {
  const match = transform?.match(
    /translate\(\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*\)/
  );
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

function groupNotesByEvent(notes: ScoreNote[]): ScoreNote[][] {
  const groups = new Map<number, ScoreNote[]>();
  notes.forEach((note) => {
    const group = groups.get(note.event_index) ?? [];
    group.push(note);
    groups.set(note.event_index, group);
  });
  return Array.from(groups.values());
}

function addRenderedLabels(
  svg: string,
  notes: ScoreNote[],
  highlightedIndices: Set<number>,
  orderByIndex: Map<number, number>,
  highlightColor: string
): string {
  const parser = new DOMParser();
  const documentNode = parser.parseFromString(svg, "image/svg+xml");
  const surface =
    documentNode.querySelector("svg.definition-scale") ??
    documentNode.documentElement;
  const eventNodes = Array.from(
    documentNode.querySelectorAll<SVGGElement>("g.note, g.chord")
  ).filter(
    (element) =>
      element.classList.contains("chord") ||
      element.closest("g.chord") === null
  );
  const noteGroups = groupNotesByEvent(notes);
  const svgNamespace = "http://www.w3.org/2000/svg";

  noteGroups.forEach((group, eventIndex) => {
    const eventNode = eventNodes[eventIndex];
    if (!eventNode) return;

    const points = Array.from(
      eventNode.querySelectorAll<SVGUseElement>(".notehead use")
    )
      .map((notehead) => parseTranslate(notehead.getAttribute("transform")))
      .filter((point): point is { x: number; y: number } => point !== null);

    if (!points.length) return;

    const isChord = group.length > 1;
    const centerX =
      points.reduce((total, point) => total + point.x, 0) / points.length;

    group.forEach((note, noteIndex) => {
      const point = points[Math.min(noteIndex, points.length - 1)];
      const text = documentNode.createElementNS(svgNamespace, "text");
      const x = isChord
        ? centerX + (noteIndex - (group.length - 1) / 2) * 520
        : point.x;
      const y = isChord
        ? Math.min(...points.map((item) => item.y)) - 125
        : point.y - 125;

      text.setAttribute("class", "agent-note-label");
      text.setAttribute("x", String(Math.round(x)));
      text.setAttribute("y", String(Math.round(y)));
      text.setAttribute("text-anchor", "middle");
      text.setAttribute("font-family", "Helvetica, Arial, sans-serif");
      text.setAttribute("font-size", "145");
      text.setAttribute("font-weight", "700");
      const isHighlighted = highlightedIndices.has(note.index);
      if (isHighlighted) {
        const ring = documentNode.createElementNS(svgNamespace, "circle");
        ring.setAttribute("class", "practice-note-ring");
        ring.setAttribute("cx", String(Math.round(point.x)));
        ring.setAttribute("cy", String(Math.round(point.y)));
        ring.setAttribute("r", "190");
        ring.setAttribute("fill", highlightColor);
        ring.setAttribute("fill-opacity", "0.16");
        ring.setAttribute("stroke", highlightColor);
        ring.setAttribute("stroke-width", "34");
        ring.setAttribute("pointer-events", "none");
        surface.appendChild(ring);
      }
      text.setAttribute(
        "fill",
        isHighlighted
          ? highlightColor
          : SCORE_HAND_COLORS[handForNote(note)] ?? NOTE_COLORS[note.step] ?? "#2563eb"
      );
      if (isHighlighted) {
        text.setAttribute("data-practice-note", "true");
      }
      text.setAttribute("stroke", "#ffffff");
      text.setAttribute("stroke-width", "24");
      text.setAttribute("paint-order", "stroke fill");
      text.textContent = note.label;
      surface.appendChild(text);

      if (isHighlighted) {
        const order = documentNode.createElementNS(svgNamespace, "text");
        order.setAttribute("class", "practice-order-label");
        order.setAttribute("x", String(Math.round(x)));
        order.setAttribute("y", String(Math.round(y - 145)));
        order.setAttribute("text-anchor", "middle");
        order.setAttribute("font-family", "Inter, Arial, sans-serif");
        order.setAttribute("font-size", "105");
        order.setAttribute("font-weight", "800");
        order.setAttribute("fill", "#5b4630");
        order.textContent = String(orderByIndex.get(note.index) ?? "");
        surface.appendChild(order);
      }
    });
  });

  return new XMLSerializer().serializeToString(documentNode.documentElement);
}

export function ScorePreview({
  musicxml,
  notes,
  processing,
  pdfUrl
}: ScorePreviewProps) {
  const [basePages, setBasePages] = useState<RenderedScorePage[]>([]);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const measures = useMemo(
    () =>
      Array.from(new Set(notes.map((note) => note.measure))).sort(
        (a, b) => Number(a) - Number(b)
      ),
    [notes]
  );
  const [selectedMeasure, setSelectedMeasure] = useState("");
  const [selectedHand, setSelectedHand] = useState<PracticeHand>("right");

  useEffect(() => {
    if (!measures.includes(selectedMeasure)) {
      setSelectedMeasure(measures[0] ?? "");
    }
  }, [measures, selectedMeasure]);

  const practiceNotes = useMemo(
    () =>
      notes
        .filter(
          (note) =>
            note.measure === selectedMeasure &&
            isNoteForHand(note, selectedHand)
        )
        .sort(noteSort),
    [notes, selectedHand, selectedMeasure]
  );
  const handleHandChange = (nextHand: PracticeHand) => {
    setSelectedHand(nextHand);
    if (
      selectedMeasure &&
      notes.some(
        (note) =>
          note.measure === selectedMeasure && isNoteForHand(note, nextHand)
      )
    ) {
      return;
    }

    const currentIndex = Math.max(0, measures.indexOf(selectedMeasure));
    const searchOrder = [
      ...measures.slice(currentIndex),
      ...measures.slice(0, currentIndex)
    ];
    const fallbackMeasure = searchOrder.find((measure) =>
      notes.some(
        (note) => note.measure === measure && isNoteForHand(note, nextHand)
      )
    );
    if (fallbackMeasure) setSelectedMeasure(fallbackMeasure);
  };
  const highlightedIndices = useMemo(
    () => new Set(practiceNotes.map((note) => note.index)),
    [practiceNotes]
  );
  const orderByIndex = useMemo(() => {
    const orders = new Map<number, number>();
    let order = 0;
    let previousEvent = -1;
    practiceNotes.forEach((note) => {
      if (note.event_index !== previousEvent) {
        order += 1;
        previousEvent = note.event_index;
      }
      orders.set(note.index, order);
    });
    return orders;
  }, [practiceNotes]);
  const highlightedMidis = useMemo(
    () => new Set(practiceNotes.map(noteToMidi)),
    [practiceNotes]
  );
  const pianoKeyLabels = useMemo(() => {
    const labels = new Map<
      number,
      { midi: number; name: string; orders: number[] }
    >();

    practiceNotes.forEach((note) => {
      const midi = noteToMidi(note);
      const order = orderByIndex.get(note.index);
      const existing = labels.get(midi);
      if (existing) {
        if (order !== undefined && !existing.orders.includes(order)) {
          existing.orders.push(order);
        }
        return;
      }

      labels.set(midi, {
        midi,
        name: notePitchName(note),
        orders: order === undefined ? [] : [order]
      });
    });

    return Array.from(labels.values()).sort((a, b) => a.midi - b.midi);
  }, [orderByIndex, practiceNotes]);
  const highlightColor = PRACTICE_COLORS[selectedHand];

  useEffect(() => {
    let cancelled = false;

    if (!musicxml) {
      setBasePages([]);
      setRenderError(null);
      return;
    }
    if (pdfUrl) {
      setBasePages([]);
      setRenderError(null);
      setRendering(false);
      return;
    }

    const render = async () => {
      setRendering(true);
      setRenderError(null);
      try {
        const toolkit = await getToolkit();
        const uniqueMeasures = new Set(notes.map((n) => n.measure));
        const isLargeScore =
          notes.length > 150 ||
          musicxml.length > 100000 ||
          uniqueMeasures.size > 8;
        toolkit.setOptions({
          adjustPageHeight: true,
          breaks: "auto",
          // Smaller pages keep Verovio's WASM allocations bounded for scanned,
          // multi-page scores while the SVG still scales to the available width.
          pageHeight: isLargeScore ? 2700 : 1800,
          pageWidth: isLargeScore ? 1800 : 1400,
          scale: isLargeScore ? 18 : 44,
        });
        const chunks = isLargeScore
          ? buildLargeScoreChunks(musicxml, notes)
          : [{ musicxml, notes }];
        const nextPages: RenderedScorePage[] = [];

        for (const chunk of chunks) {
          if (!toolkit.loadData(stripAgentLyrics(chunk.musicxml))) {
            throw new Error("Verovio 无法读取 MusicXML");
          }

          for (let page = 1; page <= toolkit.getPageCount(); page += 1) {
            nextPages.push({
              svg: toolkit.renderToSVG(page, {}),
              notes: chunk.notes,
            });
          }
        }

        if (!cancelled) {
          setBasePages(nextPages);
        }
      } catch (error) {
        if (toolkitPromise) {
          toolkitPromise.then((tk) => {
            try {
              if (tk && typeof (tk as any).destroy === "function") {
                (tk as any).destroy();
              }
            } catch {
              // ignore
            }
          });
          toolkitPromise = null;
        }
        if (!cancelled) {
          setBasePages([]);
          setRenderError(
            error instanceof Error
              ? `浏览器乐谱渲染失败：${error.message}`
              : "浏览器乐谱渲染失败"
          );
        }
      } finally {
        if (!cancelled) {
          setRendering(false);
        }
      }
    };

    void render();
    return () => {
      cancelled = true;
    };
  }, [musicxml, notes, pdfUrl]);

  const pages = useMemo(
    () =>
      basePages.map((page) =>
        addRenderedLabels(
          page.svg,
          page.notes,
          highlightedIndices,
          orderByIndex,
          highlightColor
        )
      ),
    [basePages, notes, highlightedIndices, orderByIndex, highlightColor]
  );

  if (!musicxml && !processing) {
    return (
      <div className="score-empty">
        <FileMusic size={32} />
        <strong>等待乐谱</strong>
        <span>上传 MusicXML 或载入示例后，标注结果会显示在这里。</span>
      </div>
    );
  }

  if (processing || rendering) {
    return (
      <div className="score-empty">
        <LoaderCircle className="spin" size={30} />
        <strong>{processing ? "Agent 正在标注" : "正在绘制乐谱"}</strong>
        <span>解析音符、写入标签并生成预览。</span>
      </div>
    );
  }

  if (renderError) {
    return (
      <div className="score-empty score-error">
        <FileMusic size={30} />
        <strong>乐谱预览失败</strong>
        <span>{renderError}</span>
      </div>
    );
  }

  return (
    <div className="score-preview-stack">
      <div className="score-pages" aria-label="标注后的乐谱预览">
        {pdfUrl ? (
          <PdfCanvasPreview url={pdfUrl} />
        ) : (
          pages.map((page, index) => (
            <div
              className="score-page"
              key={`${index}-${page.length}`}
              dangerouslySetInnerHTML={{ __html: page }}
            />
          ))
        )}
      </div>

      <section className="practice-panel" aria-label="钢琴小节练习">
        <div className="practice-header">
          <div>
            <span className="practice-kicker">PIANO PRACTICE</span>
            <strong>小节练习</strong>
            <span>
              {selectedMeasure
                ? `${selectedHand === "right" ? "右手" : "左手"} · 第 ${selectedMeasure} 小节 · ${practiceNotes.length} 个音符`
                : "选择小节和演奏手"}
            </span>
          </div>
          <div className="practice-controls">
            <label>
              <span>小节</span>
              <select
                aria-label="选择小节"
                value={selectedMeasure}
                onChange={(event) => setSelectedMeasure(event.target.value)}
              >
                {measures.map((measure) => (
                  <option value={measure} key={measure}>
                    第 {measure} 小节
                  </option>
                ))}
              </select>
            </label>
            <div className="hand-switch" role="group" aria-label="选择演奏手">
              <button
                className={selectedHand === "right" ? "is-active right" : ""}
                type="button"
                onClick={() => handleHandChange("right")}
              >
                <Hand size={14} />
                右手
              </button>
              <button
                className={selectedHand === "left" ? "is-active left" : ""}
                type="button"
                onClick={() => handleHandChange("left")}
              >
                <Hand size={14} />
                左手
              </button>
            </div>
          </div>
        </div>

        <div className="piano-wrap">
          <div className="piano-labels" aria-label="高亮琴键对应音符">
            {pianoKeyLabels.map((label) => (
              <span
                className="piano-key-label"
                data-midi={label.midi}
                data-note={label.name}
                key={label.midi}
                title={`${label.name} · 第 ${label.orders.join("、")} 个音`}
                style={{
                  color: highlightColor,
                  left: `${midiToKeyboardPosition(label.midi)}%`
                }}
              >
                {label.name}
              </span>
            ))}
          </div>
          <div className="piano-keyboard" aria-label="88键钢琴键盘">
            <div className="piano-white-keys">
              {PIANO_KEYS.filter((key) => !key.isBlack).map((key) => (
                <span
                  className={`piano-key white${highlightedMidis.has(key.midi) ? ` is-highlighted ${selectedHand}` : ""}`}
                  data-midi={key.midi}
                  key={key.midi}
                  title={key.name}
                  style={
                    highlightedMidis.has(key.midi)
                      ? { backgroundColor: highlightColor }
                      : undefined
                  }
                />
              ))}
            </div>
            <div className="piano-black-keys">
              {PIANO_KEYS.filter((key) => key.isBlack).map((key) => {
                const left = ((key.whiteIndex + 1) / 52) * 100;
                return (
                  <span
                    className={`piano-key black${highlightedMidis.has(key.midi) ? ` is-highlighted ${selectedHand}` : ""}`}
                    data-midi={key.midi}
                    key={key.midi}
                    title={key.name}
                    style={{ left: `${left}%` }}
                  />
                );
              })}
            </div>
          </div>
        </div>

        <div className="practice-sequence" aria-label="音符弹奏顺序">
          {practiceNotes.length ? (
            practiceNotes.map((note) => (
              <span
                className="sequence-note"
                key={note.index}
                style={{ borderColor: highlightColor }}
              >
                <b>{orderByIndex.get(note.index)}</b>
                {note.label}
              </span>
            ))
          ) : (
            <span className="sequence-empty">该小节暂无当前手部音符</span>
          )}
        </div>
      </section>
    </div>
  );
}
