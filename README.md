# Dreamy Researcher

A lightweight, multilingual **mini-VS Code for researchers** — a notebook app with
**text cells**, **code cells**, and **one-click ML researcher modules** that need
*no coding at all*. Built with **Electron + Monaco** (the real VS Code editor) and a
**Python sidecar** for the data-science work.

> Vibe: "Dreamy Tech Researcher" — cute, fluid, soft periwinkle/pink, dark & light.

---

## Features

| Area | What you get |
|------|--------------|
| **Editor engine** | Monaco editor, text + code cells, syntax highlighting, autocompletion, file open/save/export |
| **Preprocessing** | One button → clean (fill missing, drop dupes), normalize (0–1), augment (noise copies) |
| **Visualization** | One button → histograms, correlation matrix, KMeans clustering (PCA scatter) |
| **Explainability** | SHAP summary, LIME per-row rules, Grad-CAM heatmaps + plain-language text |
| **Multilingual** | Instant switch between **English / العربية / Français** (Arabic flips to RTL) |
| **Theming** | Dark / light toggle (editor theme follows) |
| **Distribution** | Packaged to `.AppImage` (Linux), `.exe` (Windows), `.dmg` (macOS) via electron-builder |

---

## Project structure

```
dreamy-researcher/
├── package.json          # scripts, deps, electron-builder config
├── main.js               # Electron main: window, menus, file IPC, Python sidecar
├── preload.js            # secure window.api bridge (contextIsolation)
├── LICENSE               # MIT
├── assets/
│   └── icon.png          # app icon
├── samples/
│   ├── iris-sample.csv       # demo dataset to try the modules
│   ├── study-scores.csv      # 120-row classification demo
│   ├── example-notebook.ipynb # code-cell walkthrough (Jupyter format)
│   └── example-notebook.dnb  # same walkthrough in Dreamy's native format
├── python/
│   ├── server.py         # the "Automatic Researcher" sidecar (JSON over stdio)
│   └── requirements.txt  # pandas, scikit-learn, shap, lime, torch…
└── src/
    ├── index.html        # app shell (toolbar, sidebar, notebook, results)
    ├── styles.css        # dreamy theme (dark/light, RTL-aware)
    ├── i18n.js           # en / ar / fr dictionary
    └── renderer.js       # UI brain: Monaco, cells, theme, i18n, module calls
```

### How it talks to Python (architecture)

```
[ Renderer (UI) ]  --window.api-->  [ Preload bridge ]  --IPC-->  [ main.js ]
                                                                      |
                                                          spawn + JSON over stdio
                                                                      v
                                                            [ python/server.py ]
                                                       pandas / sklearn / shap / lime / torch
```

The renderer is fully sandboxed (`contextIsolation: true`, `nodeIntegration: false`).
It can only do what `preload.js` whitelists — no direct filesystem or process access.

---

## Setup on Fedora with VS Code (step by step)

```bash
# 1. System dependencies
sudo dnf install -y nodejs npm python3 python3-pip git

# 2. Get the project & open it in VS Code
cd dreamy-researcher
code .            # opens VS Code in this folder

# 3. Install Node dependencies (Electron + Monaco)
npm install

# 4. Install the Python ML stack for the researcher modules
python3 -m pip install --user -r python/requirements.txt
#   torch/torchvision are large — skip them if you don't need Grad-CAM:
#   python3 -m pip install --user pandas numpy scikit-learn matplotlib seaborn shap lime

# 5. Run the app
npm start
#   Live-reload dev mode with DevTools:
npm run dev
```

**Recommended VS Code extensions:** ESLint, Python, Prettier.

### First run
1. Click **Load CSV…** in the left sidebar and pick `samples/iris-sample.csv` (or `samples/study-scores.csv`).
2. Hit **Run preprocessing**, then **Visualize**, then **Explain** (SHAP or LIME). For Grad-CAM, use **Load image…** in the Explainability panel.
3. Open `samples/example-notebook.ipynb` (or `samples/example-notebook.dnb`) and press **Run all** to test code cells end to end.
4. Switch language from the top-right dropdown; toggle the theme with the moon/sun button.

### Use the selected dataset in code cells

After **Load CSV…** (or opening a `.csv` with **Open**), the dataset is available
to every code cell:

```python
df.head()
df["score"].mean()
df.groupby("passed").size()
```

The notebook namespace also contains:

| Name | Meaning |
|---|---|
| `df` / `dataset` | The selected dataset as a pandas DataFrame |
| `dataset_name` | Original CSV file name |
| `dataset_path` | Absolute file path, or `None` after preprocessing |

If you modify `df` in one cell, later cells see your changes. Loading a new CSV
or running **Preprocessing** refreshes `df` with the new data.

> If the status bar shows **"Python: offline"**, Python 3 isn't on your PATH or the
> requirements aren't installed — the editor still works, only the ML buttons need it.

---

## Desktop installers & GitHub Releases

Packaging is handled by **electron-builder**. Build locally on the matching operating
system (Windows and macOS installers should be built on Windows and macOS respectively):

```bash
npm ci
npm run dist:linux  # AppImage
npm run dist:win    # Windows NSIS installer
npm run dist:mac    # macOS DMG
```

Build outputs go to `dist/`. **These installers are not standalone:** they include the
Python sidecar source, but launch a system Python. Users need Python 3 and the packages
from `python/requirements.txt` installed. The app does not currently bundle a Python
runtime or those packages.

A GitHub Actions workflow in `.github/workflows/release.yml` builds all three OS targets.
To publish installers, push a version tag after your changes are on `main`:

```bash
git tag v1.1.0
git push origin v1.1.0
```

The workflow creates a GitHub Release and attaches the installers. Change the version tag
for each release; the package version in `package.json` should be updated to match.

## Browser version

The web version reuses the app UI and serves researcher modules through a small Node API.
Notebook code runs in a Pyodide Web Worker **in the visitor's browser**, not on the server.
The browser runtime supports common notebook packages (NumPy, pandas, matplotlib, and
scikit-learn); desktop-only packages such as SHAP, LIME, and PyTorch are not available in
that browser worker. The one-click researcher modules still run on the Python service.

Run the web version locally (Python dependencies are required for the server-side modules):

```bash
npm ci
python3 -m pip install -r python/requirements.txt
npm run web
```

Open <http://127.0.0.1:8080>. The browser loads Pyodide from jsDelivr. Selected CSVs
and images are sent to the web service when a researcher module runs; notebook code stays
in the browser. CSV requests are limited to 5 MB, images to 20 MB, module requests to 20
per IP per minute, and the service processes one module request at a time.

### Docker deployment

A Dockerfile is included for a hosted web service:

```bash
docker build -t dreamy-researcher-web .
docker run --rm -p 8080:8080 dreamy-researcher-web
```

Deploy the container behind HTTPS on a host that supports Docker. The container includes
the Python dependencies and uses CPU-only PyTorch for Grad-CAM. Public deployments have
no account system yet; do not use them for confidential datasets. Keep the host's request
limits and resource limits enabled, and only set `TRUST_PROXY=1` when the trusted hosting
proxy sanitizes `X-Forwarded-For`.

---

## Extending it (plugins)

Add a new researcher module in three small steps:
1. **Python:** add a function in `python/server.py` and register it in the `HANDLERS` map.
2. **UI:** add a `<button data-run="yourMethod">` in `src/index.html`.
3. **Wire:** handle it in `runModule()` / `renderModuleResult()` in `src/renderer.js`.

That's the whole "plugin" contract — one stdio method + one button.

---

## License

MIT — see [LICENSE](./LICENSE). Re-license as Apache-2.0 or GPL-3.0 if you prefer.
