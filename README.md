# Music Score Annotation Agent

A LangGraph demo that accepts digital or scanned scores and adds automatic
piano note labels such as `C D E F G A B`.

## What the demo shows

The agent executes a bounded graph:

```text
validate upload
  -> [PDF/image] optical music recognition
  -> extract MusicXML
  -> recognize notes
  -> add labels
  -> verify result
  -> return annotated score
```

Music recognition and annotation are deterministic. LangGraph owns workflow
state, routing, step results, errors, and the final run record.

## Supported input

- `.musicxml`
- `.xml` containing MusicXML `score-partwise`
- `.mxl` compressed MusicXML
- `.pdf` scanned or exported sheet music, up to 8 pages
- `.png`, `.jpg`, `.jpeg`, `.webp`, `.tif`, `.tiff`

PDF and image inputs use HOMR 0.7.0 as a separate Optical Music Recognition
node. OMR quality depends on image clarity, staff alignment, notation style,
and scan resolution. Uploads are limited to 20 MB.

The included fixtures cover all three paths:

- `backend/sample_scores/c-major.musicxml`
- `backend/sample_scores/c-major-scan.png`
- `backend/sample_scores/c-major-scan.pdf`

## Components

- `backend/app/agent.py`: LangGraph state and workflow routing
- `backend/app/musicxml.py`: deterministic MusicXML parsing and annotation
- `backend/app/omr.py`: validated PDF/image OMR subprocess boundary
- `backend/omr_worker.py`: image normalization, PDF rendering, HOMR, and
  multi-page MusicXML merging
- `frontend/src`: React workbench and Verovio score rendering

This demo intentionally does not use an LLM for pitch extraction. A language
model is useful later for teaching explanations, fingering suggestions, music
theory Q&A, and retrieval over a curriculum, but it should not replace
deterministic score parsing.

## Run

Backend:

```bash
cd "/Users/lee/Documents/AI piano/backend"
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --reload --port 8000
```

Install the isolated OMR environment once:

```bash
cd "/Users/lee/Documents/AI piano/backend"
python3.11 -m venv .omr-venv
.omr-venv/bin/python -m pip install -r omr-requirements.txt
.omr-venv/bin/python -c 'from homr.main import main; main()' --init
```

Frontend:

```bash
cd "/Users/lee/Documents/AI piano/frontend"
npm install
npm run dev -- --host 0.0.0.0 --port 5173
```

Open `http://localhost:5173`.

## Test

```bash
cd "/Users/lee/Documents/AI piano/backend"
.venv/bin/python -m pytest -q
```

```bash
cd "/Users/lee/Documents/AI piano/frontend"
npm run build
npm run test:e2e
```

The end-to-end suite uploads MusicXML, PNG, and PDF fixtures through the real
browser and backend. The first OMR run can be slower while models initialize.

## GitHub Pages

The frontend is deployed automatically by
`.github/workflows/pages.yml` when changes reach `main`.

GitHub Pages hosts only the static React frontend. The FastAPI backend must
run separately, for example on a server or container platform. Before the
first deployment, add a repository variable named `VITE_API_BASE_URL` in
**Settings -> Secrets and variables -> Actions -> Variables** and set it to
the public backend origin, such as `https://api.example.com` without a
trailing slash.

The published site is:

```text
https://leonlzd120000.github.io/AI-piano/
```

The backend accepts `CORS_ORIGINS` as a comma-separated environment variable.
If it is not set, the Pages origin above and the local Vite origins are
allowed by default. `SAMPLE_FILE` can point to the PDF loaded by the sample
button; deployments fall back to the bundled scan fixture when the configured
file does not exist.
