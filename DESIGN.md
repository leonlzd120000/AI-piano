# AI Piano Design System

## 1. Product Intent

AI Piano converts uploaded piano scores into study-ready scores with note-name
annotations. The score itself is the primary artifact. Application chrome must
stay quiet and must not alter the source score's page geometry.

## 2. Visual Tokens

### Score Annotation

- PDF right-hand fill: `#DB05A8`
- PDF left-hand fill: `#0552E0`
- Browser color-managed preview: right `#C92CA4`, left `#2250D8`
- Label halo: `#FFFFFF`
- Label font: Helvetica-Bold
- Label size: 17 px on a 2048 px-wide source page; 14 px for dense chords
- Label halo width: 19.55 px at size 17; 16.1 px at size 14
- Label baseline offset: 15 px above the notehead at size 17
- Alignment: horizontally centered on each notehead

These values are extracted from
`6夜的钢琴曲5_CDEFGAB标注版.pdf` and are the source of truth for both preview
and exported PDF annotations.

### Application Chrome

- Primary action: `#2563EB`
- Text: `#172033`
- Muted text: `#7B8495`
- Canvas: `#EEF1F5`
- Surface: `#FFFFFF`
- Border: `#DFE3EA`

## 3. Typography

- Application UI: system sans-serif stack
- Score annotation: Helvetica-Bold only
- Annotation text uses uppercase `C D E F G A B`; accidentals are appended as
  `b`, `bb`, `#`, or `##`.

## 4. Spacing

- UI spacing follows a 4 px base unit.
- Score page dimensions and system spacing come from the uploaded PDF and must
  not be reflowed for PDF output.
- Annotation position scales proportionally with the source page width.

## 5. Components

- `ScorePreview`: browser preview and practice interaction.
- `Header`: runtime status and score download command.
- PDF annotation layer: preserves the source page raster and places note labels
  at OMR-detected notehead coordinates.

## 6. Responsive Behavior

- Application panels may reflow at narrow widths.
- Score pages preserve their aspect ratio at every viewport.
- PDF export is independent of viewport size.

## 7. Accessibility And Debt

- Hand colors must always be paired with explicit `右手` and `左手` labels.
- Download controls expose the actual output format in their accessible name.
- OMR coordinates are probabilistic. Export must report how many recognized
  pitches were placed so incomplete recognition is visible to the workflow.
