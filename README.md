# Color Studio

Reusable color-study engine with per-subject configuration plus an optional
vote-collection backend.

```
public/                       static site, deploy to GitHub Pages
  index.html                  shell — loads app.js + style.css
  app.js                      engine
  style.css
  subjects/
    index.json                list of subjects (used by the picker page)
    harbor-south/
      data.json               subject config (surfaces, palettes, rules)
      main.jpg                main rendering
      photos/                 reference photos
backend/                      Rust + Axum + SQLite vote collector
  Cargo.toml
  src/main.rs
```

## Frontend

### URL conventions
- `/` — subject picker (reads `subjects/index.json`).
- `/?subject=<id>` — load that subject from `subjects/<id>/data.json`.
- `/?subject=<id>#p=BBBBBB-TTTTTT-AAAAAA` — preselected palette via hash.
  Components are 6-hex without `#`, in the surface order from `data.json`.
- `/?subject=<id>&backend=<url>` — overrides backend at runtime.

### Adding a new subject
1. Make a folder under `public/subjects/<new-id>/`.
2. Drop in `main.<jpg|png>` and any `photos/*.jpg`.
3. Copy `harbor-south/data.json` and tweak:
   - `id`, `title`, `subtitle`, `meta`, `footer`, `canvasId`
   - `image` filename
   - `surfaces[]` — the paintable regions; each has `id`, `label`, `default`,
     `origHsl` (sample the original rendering), `areaShare` (rough share of
     visible area, used by the compliance summary).
   - `segmentation.rules[]` — ordered classifier. Each rule may set:
     - `rgbMin`, `rgbMax` raw RGB gates
     - `lumMin/lumMax`, `satMin/satMax`
     - `hueRanges` — `[[lo, hi], …]`, matches if hue ∈ any range
     - `assign` — surface id to paint, or `null` to skip the pixel
     The first matching rule wins. To calibrate, sample pixel colors from
     your rendering and adjust ranges until the mask covers what you want.
   - `palettes[]` — preset color schemes; `colors` keys must match surface ids.
   - `compliance` — optional. Remove the section to hide it.
4. Append the subject to `public/subjects/index.json`.
5. Reload `/?subject=<new-id>`.

### Local preview
```sh
cd public
python3 -m http.server 8000
# open http://localhost:8000/?subject=harbor-south
```

### Deploy to GitHub Pages
Anything in `public/` is the deployable site. Push that folder as the repo
root (or use Pages with `/docs`-style source).

## Backend (vote collector)

Single-binary Rust service. SQLite storage with WAL. CORS configurable.

### Run locally
```sh
cd backend
cargo run --release
# defaults: PORT=8080, DB_PATH=votes.sqlite, CORS_ORIGIN=*
```

Then point the frontend at it:
```
/?subject=harbor-south&backend=http://localhost:8080
```
…or set permanently in `public/index.html`:
```html
<meta name="vote-backend" content="http://localhost:8080">
```

### API
- `GET  /health` → `ok`
- `POST /vote` body:
  ```json
  { "subject": "harbor-south",
    "paletteIdx": 1, "paletteName": "Option B",
    "colors": { "body": "#fafaf7", "tower": "#7d9aa0", "accent": "#5e94a0" } }
  ```
  → `{ "ok": true, "totalForSubject": 42 }`
- `GET  /tally?subject=harbor-south`
  → `{ "subject", "total", "rows": [{ "paletteName", "paletteIdx", "colors", "count" }, …] }`

### Environment
- `PORT` — listen port (default 8080)
- `DB_PATH` — SQLite file (default `votes.sqlite`)
- `CORS_ORIGIN` — exact origin allowed, or `*` (default)
- `IP_HASH_SALT` — salt for the per-vote IP hash (default `color-studio`)
- `RUST_LOG` — tracing filter (default `info`)

### Deploy options
The backend is a single static binary plus a SQLite file. Any host that runs
a long-lived process works: Fly.io, Railway, Shuttle.rs, a small VPS. Mount
a persistent volume at `DB_PATH`. After deploy, set `CORS_ORIGIN` to your
Pages URL (e.g. `https://milxliv.github.io`) and update the `<meta>` tag in
`public/index.html` to the backend URL.
