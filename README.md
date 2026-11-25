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

## Packaging & publishing

Packaging is handled by **electron-builder** (already configured in `package.json`).

```bash
# Linux  → dist/Dreamy Researcher-1.0.0.AppImage
npm run dist:linux

# Windows → dist/Dreamy Researcher Setup 1.0.0.exe   (run on/ via Windows)
npm run dist:win

# macOS   → dist/Dreamy Researcher-1.0.0.dmg          (must build on macOS)
npm run dist:mac

# All targets for the current OS
npm run dist
```

Outputs land in `dist/`. The `python/` folder is bundled via `extraResources`, so the
sidecar ships with the app (end users still need Python 3 + the pip packages installed,
or you can freeze the sidecar with PyInstaller for a fully standalone build).

### Publish on GitHub
```bash
git init && git add . && git commit -m "Dreamy Researcher v1.0.0"
git branch -M main
git remote add origin https://github.com/<you>/dreamy-researcher.git
git push -u origin main
# Then create a GitHub Release and upload the files from dist/
```

### Optional distribution
- **Flathub (Linux):** wrap the AppImage in a Flatpak manifest and submit to flathub/flathub.
- **SourceForge:** create a project and upload the `dist/` artifacts to the Files section.

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
