import { FileMusic, Hand, LoaderCircle, Play, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
type PlaybackMode = "single" | "range";

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
const PLAYBACK_STEP_SECONDS = 0.58;
const PLAYBACK_NOTE_SECONDS = 0.76;

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

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function schedulePianoTone(
  context: AudioContext,
  midi: number,
  startsAt: number,
  duration: number
): OscillatorNode[] {
  const frequency = midiToFrequency(midi);
  const envelope = context.createGain();
  const filter = context.createBiquadFilter();
  const oscillators: OscillatorNode[] = [];

  envelope.gain.setValueAtTime(0.0001, startsAt);
  envelope.gain.exponentialRampToValueAtTime(0.13, startsAt + 0.014);
  envelope.gain.exponentialRampToValueAtTime(0.055, startsAt + 0.18);
  envelope.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(Math.min(5200, 1100 + frequency * 5), startsAt);
  filter.Q.setValueAtTime(0.7, startsAt);
  filter.connect(envelope);
  envelope.connect(context.destination);

  const partials: Array<[number, OscillatorType, number]> = [
    [1, "triangle", 0.78],
    [2, "sine", 0.16],
    [3, "sine", 0.06]
  ];

  partials.forEach(([multiple, type, level]) => {
    const oscillator = context.createOscillator();
    const partialGain = context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency * multiple, startsAt);
    partialGain.gain.setValueAtTime(level, startsAt);
    oscillator.connect(partialGain);
    partialGain.connect(filter);
    oscillator.start(startsAt);
    oscillator.stop(startsAt + duration + 0.03);
    oscillators.push(oscillator);
  });

  return oscillators;
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
  const [rangeHand, setRangeHand] = useState<PracticeHand>("right");
  const [rangeStartMeasure, setRangeStartMeasure] = useState("");
  const [rangeEndMeasure, setRangeEndMeasure] = useState("");
  const [playbackMode, setPlaybackMode] = useState<PlaybackMode | null>(null);
  const [activePlaybackMidis, setActivePlaybackMidis] = useState<Set<number>>(
    new Set()
  );
  const audioContextRef = useRef<AudioContext | null>(null);
  const playbackOscillatorsRef = useRef<OscillatorNode[]>([]);
  const playbackTimersRef = useRef<number[]>([]);
  const playbackRunRef = useRef(0);

  useEffect(() => {
    if (!measures.includes(selectedMeasure)) {
      setSelectedMeasure(measures[0] ?? "");
    }
  }, [measures, selectedMeasure]);

  useEffect(() => {
    if (!measures.includes(rangeStartMeasure)) {
      setRangeStartMeasure(measures[0] ?? "");
    }
    if (!measures.includes(rangeEndMeasure)) {
      setRangeEndMeasure(measures[Math.min(3, measures.length - 1)] ?? "");
    }
  }, [measures, rangeEndMeasure, rangeStartMeasure]);

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
  const playbackEvents = useMemo(
    () =>
      groupNotesByEvent(practiceNotes).map((group) =>
        Array.from(new Set(group.map(noteToMidi)))
      ),
    [practiceNotes]
  );
  const rangePlaybackNotes = useMemo(() => {
    const startIndex = measures.indexOf(rangeStartMeasure);
    const endIndex = measures.indexOf(rangeEndMeasure);
    if (startIndex < 0 || endIndex < startIndex) return [];

    const rangeMeasures = new Set(measures.slice(startIndex, endIndex + 1));
    return notes
      .filter(
        (note) =>
          rangeMeasures.has(note.measure) && isNoteForHand(note, rangeHand)
      )
      .sort(noteSort);
  }, [
    measures,
    notes,
    rangeEndMeasure,
    rangeHand,
    rangeStartMeasure
  ]);
  const rangePlaybackEvents = useMemo(
    () =>
      groupNotesByEvent(rangePlaybackNotes).map((group) =>
        Array.from(new Set(group.map(noteToMidi)))
      ),
    [rangePlaybackNotes]
  );
  const stopPlayback = useCallback(() => {
    playbackRunRef.current += 1;
    playbackTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    playbackTimersRef.current = [];
    playbackOscillatorsRef.current.forEach((oscillator) => {
      try {
        oscillator.stop();
      } catch {
        // The oscillator may have already completed naturally.
      }
    });
    playbackOscillatorsRef.current = [];
    setActivePlaybackMidis(new Set());
    setPlaybackMode(null);
  }, []);
  const startPlayback = useCallback(async (
    events: number[][],
    mode: PlaybackMode
  ) => {
    if (playbackMode === mode) {
      stopPlayback();
      return;
    }
    if (!events.length) return;

    stopPlayback();
    let context = audioContextRef.current;
    if (!context || context.state === "closed") {
      context = new AudioContext();
      audioContextRef.current = context;
    }
    if (context.state === "suspended") {
      await context.resume();
    }

    const runId = playbackRunRef.current;
    const contextNow = context.currentTime;
    const startsAt = contextNow + 0.06;
    setPlaybackMode(mode);

    events.forEach((midis, eventIndex) => {
      const eventStartsAt = startsAt + eventIndex * PLAYBACK_STEP_SECONDS;
      const duration =
        eventIndex === events.length - 1
          ? PLAYBACK_NOTE_SECONDS + 0.18
          : PLAYBACK_NOTE_SECONDS;
      midis.forEach((midi) => {
        playbackOscillatorsRef.current.push(
          ...schedulePianoTone(context, midi, eventStartsAt, duration)
        );
      });

      const activeTimer = window.setTimeout(() => {
        if (playbackRunRef.current === runId) {
          setActivePlaybackMidis(new Set(midis));
        }
      }, Math.max(0, (eventStartsAt - contextNow) * 1000));
      playbackTimersRef.current.push(activeTimer);
    });

    const playbackEndsAt =
      startsAt +
      (events.length - 1) * PLAYBACK_STEP_SECONDS +
      PLAYBACK_NOTE_SECONDS +
      0.2;
    const finishTimer = window.setTimeout(() => {
      if (playbackRunRef.current !== runId) return;
      playbackOscillatorsRef.current = [];
      playbackTimersRef.current = [];
      setActivePlaybackMidis(new Set());
      setPlaybackMode(null);
    }, Math.max(0, (playbackEndsAt - contextNow) * 1000));
    playbackTimersRef.current.push(finishTimer);
  }, [playbackMode, stopPlayback]);

  const handlePlayback = useCallback(
    () => startPlayback(playbackEvents, "single"),
    [playbackEvents, startPlayback]
  );
  const handleRangePlayback = useCallback(
    () => startPlayback(rangePlaybackEvents, "range"),
    [rangePlaybackEvents, startPlayback]
  );

  useEffect(() => {
    stopPlayback();
  }, [selectedHand, selectedMeasure, stopPlayback]);

  useEffect(() => {
    stopPlayback();
  }, [
    rangeEndMeasure,
    rangeHand,
    rangeStartMeasure,
    stopPlayback
  ]);

  useEffect(
    () => () => {
      playbackRunRef.current += 1;
      playbackTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      playbackOscillatorsRef.current.forEach((oscillator) => {
        try {
          oscillator.stop();
        } catch {
          // The oscillator may have already completed naturally.
        }
      });
      if (audioContextRef.current?.state !== "closed") {
        void audioContextRef.current?.close();
      }
    },
    []
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
  const activePlaybackLabels = useMemo(() => {
    const sourceNotes =
      playbackMode === "range" ? rangePlaybackNotes : practiceNotes;
    const labels = new Map<number, string>();

    sourceNotes.forEach((note) => {
      const midi = noteToMidi(note);
      if (activePlaybackMidis.has(midi) && !labels.has(midi)) {
        labels.set(midi, notePitchName(note));
      }
    });

    activePlaybackMidis.forEach((midi) => {
      if (!labels.has(midi)) {
        labels.set(midi, PITCH_NAMES[midi % 12]);
      }
    });

    return Array.from(labels, ([midi, name]) => ({ midi, name })).sort(
      (a, b) => a.midi - b.midi
    );
  }, [
    activePlaybackMidis,
    playbackMode,
    practiceNotes,
    rangePlaybackNotes
  ]);
  const highlightColor = PRACTICE_COLORS[selectedHand];
  const playbackHand =
    playbackMode === "range" ? rangeHand : selectedHand;
  const playbackColor = PRACTICE_COLORS[playbackHand];

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
            <button
              className={`practice-play-button${playbackMode === "single" ? " is-playing" : ""}`}
              type="button"
              disabled={!playbackEvents.length}
              onClick={() => {
                void handlePlayback();
              }}
              aria-label={
                playbackMode === "single"
                  ? "停止播放"
                  : `播放第 ${selectedMeasure} 小节${selectedHand === "right" ? "右手" : "左手"}音符`
              }
            >
              {playbackMode === "single" ? (
                <Square size={13} />
              ) : (
                <Play size={14} />
              )}
              {playbackMode === "single" ? "停止" : "播放"}
            </button>
          </div>
        </div>

        <div className="piano-stage">
          <aside className="range-player" aria-label="范围自动播放">
            <strong>范围播放</strong>
            <div
              className="range-hand-switch"
              role="group"
              aria-label="范围播放演奏手"
            >
              <button
                className={rangeHand === "right" ? "is-active right" : ""}
                type="button"
                aria-label="范围播放：右手"
                onClick={() => setRangeHand("right")}
              >
                <Hand size={13} />
                右手
              </button>
              <button
                className={rangeHand === "left" ? "is-active left" : ""}
                type="button"
                aria-label="范围播放：左手"
                onClick={() => setRangeHand("left")}
              >
                <Hand size={13} />
                左手
              </button>
            </div>
            <div className="range-measure-fields">
              <label>
                <span>从</span>
                <select
                  aria-label="范围播放起始小节"
                  value={rangeStartMeasure}
                  onChange={(event) => {
                    const nextStart = event.target.value;
                    setRangeStartMeasure(nextStart);
                    if (
                      measures.indexOf(rangeEndMeasure) <
                      measures.indexOf(nextStart)
                    ) {
                      setRangeEndMeasure(nextStart);
                    }
                  }}
                >
                  {measures.map((measure) => (
                    <option value={measure} key={`range-start-${measure}`}>
                      第 {measure} 小节
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>到</span>
                <select
                  aria-label="范围播放结束小节"
                  value={rangeEndMeasure}
                  onChange={(event) => setRangeEndMeasure(event.target.value)}
                >
                  {measures.map((measure, index) => (
                    <option
                      value={measure}
                      disabled={index < measures.indexOf(rangeStartMeasure)}
                      key={`range-end-${measure}`}
                    >
                      第 {measure} 小节
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button
              className={`range-play-button${playbackMode === "range" ? " is-playing" : ""}`}
              type="button"
              disabled={!rangePlaybackEvents.length}
              onClick={() => {
                void handleRangePlayback();
              }}
              aria-label={
                playbackMode === "range"
                  ? "停止范围播放"
                  : `自动播放第 ${rangeStartMeasure} 至第 ${rangeEndMeasure} 小节${rangeHand === "right" ? "右手" : "左手"}音符`
              }
            >
              {playbackMode === "range" ? (
                <Square size={13} />
              ) : (
                <Play size={14} />
              )}
              {playbackMode === "range" ? "停止" : "自动播放"}
            </button>
            <span className="range-note-count">
              {rangePlaybackNotes.length} 个音符
            </span>
          </aside>

          <div className="piano-wrap">
            <div className="piano-labels" aria-label="高亮琴键对应音符">
              {pianoKeyLabels.map((label) => (
                <span
                  className={`piano-key-label${activePlaybackMidis.has(label.midi) ? " is-sounding" : ""}`}
                  data-midi={label.midi}
                  data-note={label.name}
                  key={label.midi}
                  title={`${label.name} · 第 ${label.orders.join("、")} 个音`}
                  style={{
                    color: activePlaybackMidis.has(label.midi)
                      ? playbackColor
                      : highlightColor,
                    left: `${midiToKeyboardPosition(label.midi)}%`
                  }}
                >
                  {label.name}
                </span>
              ))}
              {activePlaybackLabels
                .filter(
                  (activeLabel) =>
                    !pianoKeyLabels.some(
                      (label) => label.midi === activeLabel.midi
                    )
                )
                .map((label) => (
                  <span
                    className="piano-key-label is-sounding"
                    data-midi={label.midi}
                    data-note={label.name}
                    key={`active-${label.midi}`}
                    title={`正在弹奏 ${label.name}`}
                    style={{
                      color: playbackColor,
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
                    className={`piano-key white${highlightedMidis.has(key.midi) ? ` is-highlighted ${selectedHand}` : ""}${activePlaybackMidis.has(key.midi) ? ` is-sounding ${playbackHand}` : ""}`}
                    data-midi={key.midi}
                    key={key.midi}
                    title={key.name}
                    style={
                      activePlaybackMidis.has(key.midi)
                        ? { backgroundColor: playbackColor }
                        : highlightedMidis.has(key.midi)
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
                      className={`piano-key black${highlightedMidis.has(key.midi) ? ` is-highlighted ${selectedHand}` : ""}${activePlaybackMidis.has(key.midi) ? ` is-sounding ${playbackHand}` : ""}`}
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
