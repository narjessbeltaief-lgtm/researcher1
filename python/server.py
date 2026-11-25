#!/usr/bin/env python3
"""
server.py — the "Automatic Researcher" sidecar.

It speaks newline-delimited JSON over stdin/stdout with the Electron main process:

    <- {"id": 1, "method": "preprocess", "params": {...}}
    -> {"id": 1, "result": {...}}            # success
    -> {"id": 1, "error": "message"}         # failure

Every method is designed so a non-coder can trigger it from a button:
the UI sends the dataset (as CSV text or a file path) plus a few options,
and gets back ready-to-render results (tables, base64 PNG charts, text).

Heavy libraries (pandas, scikit-learn, shap, lime, matplotlib) are imported
lazily inside each handler so the app still launches even if some are missing —
the affected button simply returns a friendly "please install X" error.
"""

import sys
import json
import io
import base64
import traceback
import ast
import contextlib
import warnings


# --------------------------------------------------------------------------- #
#  Small helpers
# --------------------------------------------------------------------------- #

def _fig_to_base64(fig):
    """Render a matplotlib figure to a base64 PNG data URI."""
    import matplotlib
    matplotlib.use("Agg")
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", dpi=110)
    buf.seek(0)
    import matplotlib.pyplot as plt
    plt.close(fig)
    return "data:image/png;base64," + base64.b64encode(buf.read()).decode("ascii")


def _prepare_matplotlib():
    """Use a headless backend and keep figures open so code cells can capture them."""
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        if not getattr(plt.show, "_dreamy_noop", False):
            def _show(*args, **kwargs):
                return None

            _show._dreamy_noop = True
            plt.show = _show
    except Exception:
        # Matplotlib is optional; a missing install should not break text cells.
        pass


def _collect_figures():
    """Render every open matplotlib figure to a data URI and close it."""
    if "matplotlib.pyplot" not in sys.modules:
        return []
    try:
        import matplotlib.pyplot as plt
        images = []
        for num in list(plt.get_fignums()):
            try:
                images.append(_fig_to_base64(plt.figure(num)))
            except Exception:
                continue
        plt.close("all")
        return images
    except Exception:
        return []


def _load_df(params):
    """Load a pandas DataFrame from either inline CSV text or a file path."""
    import pandas as pd
    if params.get("csv"):
        return pd.read_csv(io.StringIO(params["csv"]))
    if params.get("path"):
        return pd.read_csv(params["path"])
    raise ValueError("No dataset provided. Open a CSV first.")


# --------------------------------------------------------------------------- #
#  1. PYTHON NOTEBOOK CELLS
# --------------------------------------------------------------------------- #

# Keep a small, persistent namespace so variables can be reused between cells.
_CELL_GLOBALS = {"__name__": "__dreamy_notebook__"}


def _install_dataset(params):
    """Expose the CSV selected in the UI to notebook code as a DataFrame.

    The renderer sends a descriptor with each execute_code call:

        {"name": "iris.csv", "sig": "...", "path": "/home/me/iris.csv"}
        {"name": "iris.csv", "sig": "...", "csv": "sepal_length,..."}

    The signature lets us skip reinstalling an unchanged dataset, so variables
    the user changed in a previous cell (for example a filtered ``df``) are
    preserved. When the sidecar restarts, the next cell call reinstalls it.
    """
    dataset = params.get("dataset") or {}
    sig = dataset.get("sig")
    if not sig or _CELL_GLOBALS.get("__dreamy_dataset_sig__") == sig:
        return

    csv_text = dataset.get("csv")
    path = dataset.get("path")
    if not csv_text and not path:
        return

    import pandas as pd
    frame = pd.read_csv(io.StringIO(csv_text)) if csv_text else pd.read_csv(path)
    _CELL_GLOBALS["df"] = frame
    _CELL_GLOBALS["dataset"] = frame
    _CELL_GLOBALS["dataset_name"] = dataset.get("name") or "dataset.csv"
    _CELL_GLOBALS["dataset_path"] = path
    _CELL_GLOBALS["__dreamy_dataset_sig__"] = sig


def execute_code(params):
    """Execute a notebook cell and return captured stdout plus its final value."""
    code = str(params.get("code", ""))
    if not code.strip():
        return {"output": "(no output)", "images": []}

    # Make plt.show() a no-op before the cell runs, so figures stay open for
    # _collect_figures() instead of warning about the non-interactive backend.
    _prepare_matplotlib()

    stdout = io.StringIO()
    stderr = io.StringIO()
    result = None
    try:
        _install_dataset(params)
        tree = ast.parse(code, mode="exec")
        # Display the value of the final expression, like a small notebook does.
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = tree.body.pop()
            compiled = compile(ast.Module(body=tree.body, type_ignores=[]), "<cell>", "exec")
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exec(compiled, _CELL_GLOBALS, _CELL_GLOBALS)
                result = eval(compile(ast.Expression(last.value), "<cell>", "eval"), _CELL_GLOBALS, _CELL_GLOBALS)
        else:
            compiled = compile(tree, "<cell>", "exec")
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                exec(compiled, _CELL_GLOBALS, _CELL_GLOBALS)
    except Exception:
        traceback.print_exc(file=stderr)

    output = stdout.getvalue()
    errors = stderr.getvalue()
    if result is not None:
        if output and not output.endswith("\n"):
            output += "\n"
        output += repr(result)
    if errors:
        if output and not output.endswith("\n"):
            output += "\n"
        output += errors

    # Anything the cell plotted (plt.plot, df.plot, plt.show, ...) is rendered
    # to PNG data URIs and shown under the cell.
    images = _collect_figures()
    return {"output": output.rstrip() or "(no output)", "images": images}


# --------------------------------------------------------------------------- #
#  2. PREPROCESSING  — clean, normalize, augment
# --------------------------------------------------------------------------- #

def preprocess(params):
    import pandas as pd
    import numpy as np

    df = _load_df(params)
    before_rows, before_cols = df.shape
    steps = []

    if params.get("clean", True):
        # Drop fully-empty columns, fill numeric NaN with median, drop dup rows.
        df = df.dropna(axis=1, how="all")
        num_cols = df.select_dtypes(include="number").columns
        for c in num_cols:
            df[c] = df[c].fillna(df[c].median())
        obj_cols = df.select_dtypes(exclude="number").columns
        for c in obj_cols:
            if not df[c].mode().empty:
                df[c] = df[c].fillna(df[c].mode()[0])
        dups = df.duplicated().sum()
        df = df.drop_duplicates()
        steps.append(f"Cleaned: filled missing values, removed {int(dups)} duplicate rows.")

    if params.get("normalize", True):
        num_cols = df.select_dtypes(include="number").columns
        for c in num_cols:
            rng = df[c].max() - df[c].min()
            if rng:
                df[c] = (df[c] - df[c].min()) / rng
        steps.append(f"Normalized {len(num_cols)} numeric column(s) to 0–1 range.")

    if params.get("augment", False):
        # Simple tabular augmentation: add small gaussian noise copies.
        num_cols = df.select_dtypes(include="number").columns
        noise = df.copy()
        for c in num_cols:
            noise[c] = noise[c] + np.random.normal(0, 0.01, size=len(noise))
        df = pd.concat([df, noise], ignore_index=True)
        steps.append(f"Augmented dataset to {len(df)} rows with gaussian-noise copies.")

    return {
        "summary": {
            "rows_before": before_rows,
            "cols_before": before_cols,
            "rows_after": int(df.shape[0]),
            "cols_after": int(df.shape[1]),
        },
        "steps": steps,
        "preview": df.head(15).to_dict(orient="records"),
        "columns": list(df.columns),
        "csv": df.to_csv(index=False),
    }


# --------------------------------------------------------------------------- #
#  2. VISUALIZATION — one-click charts, clustering, confusion matrix
# --------------------------------------------------------------------------- #

def visualize(params):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    df = _load_df(params)
    kind = params.get("kind", "auto")
    images = []

    num_df = df.select_dtypes(include="number")

    if kind in ("auto", "histograms") and not num_df.empty:
        cols = list(num_df.columns)[:6]
        fig, axes = plt.subplots(1, len(cols), figsize=(3.2 * len(cols), 3))
        if len(cols) == 1:
            axes = [axes]
        for ax, c in zip(axes, cols):
            ax.hist(num_df[c].dropna(), bins=20, color="#c2683f", edgecolor="white")
            ax.set_title(c, fontsize=9)
        fig.suptitle("Feature distributions", fontsize=11)
        images.append({"title": "Distributions", "data": _fig_to_base64(fig)})

    if kind in ("auto", "correlation") and num_df.shape[1] >= 2:
        corr = num_df.corr()
        fig, ax = plt.subplots(figsize=(5, 4))
        im = ax.imshow(corr, cmap="coolwarm", vmin=-1, vmax=1)
        ax.set_xticks(range(len(corr))); ax.set_xticklabels(corr.columns, rotation=45, ha="right", fontsize=8)
        ax.set_yticks(range(len(corr))); ax.set_yticklabels(corr.columns, fontsize=8)
        fig.colorbar(im, ax=ax, fraction=0.046)
        ax.set_title("Correlation matrix")
        images.append({"title": "Correlation", "data": _fig_to_base64(fig)})

    if kind in ("auto", "clustering") and num_df.shape[1] >= 2:
        from sklearn.cluster import KMeans
        from sklearn.decomposition import PCA
        X = num_df.dropna()
        if len(X) >= 3:
            k = min(int(params.get("k", 3)), max(2, len(X) // 2))
            labels = KMeans(n_clusters=k, n_init=10, random_state=42).fit_predict(X)
            coords = PCA(n_components=2).fit_transform(X) if X.shape[1] > 2 else X.values[:, :2]
            fig, ax = plt.subplots(figsize=(5, 4))
            sc = ax.scatter(coords[:, 0], coords[:, 1], c=labels, cmap="viridis", s=18)
            ax.set_title(f"KMeans clustering (k={k})")
            fig.colorbar(sc, ax=ax, fraction=0.046)
            images.append({"title": "Clustering", "data": _fig_to_base64(fig)})

    if not images:
        raise ValueError("No numeric columns available to visualize.")
    return {"images": images}


# --------------------------------------------------------------------------- #
#  3. EXPLAINABILITY — SHAP, LIME, Grad-CAM
# --------------------------------------------------------------------------- #

def explain(params):
    method = params.get("technique", "shap")
    if method == "shap":
        return _explain_shap(params)
    if method == "lime":
        return _explain_lime(params)
    if method == "gradcam":
        return _explain_gradcam(params)
    raise ValueError(f"Unknown explainability technique: {method}")


def _train_quick_model(df, target):
    """Train a small RandomForest on the fly so explainability has something to explain."""
    import pandas as pd
    from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor

    y = df[target]
    X = df.drop(columns=[target]).select_dtypes(include="number").fillna(0)
    if X.empty:
        raise ValueError("Need at least one numeric feature column.")
    is_class = y.dtype == object or y.nunique() <= 10
    if is_class:
        y = y.astype("category").cat.codes
        model = RandomForestClassifier(n_estimators=80, random_state=42)
    else:
        model = RandomForestRegressor(n_estimators=80, random_state=42)
    model.fit(X, y)
    return model, X, is_class


def _explain_shap(params):
    import numpy as np
    import shap
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    df = _load_df(params)
    target = params.get("target") or df.columns[-1]
    model, X, is_class = _train_quick_model(df, target)

    explainer = shap.TreeExplainer(model)
    sample = X.sample(min(100, len(X)), random_state=42)
    raw_values = explainer.shap_values(sample)

    # SHAP output shape depends on the model and shap version:
    #   regression:     (samples, features)
    #   classification: (samples, features, classes) or a list of 2D arrays.
    # Normalize everything to (samples, features, classes) so the rest of
    # this function works for binary, multiclass, and regression models.
    if isinstance(raw_values, list):
        values = np.stack([np.asarray(v) for v in raw_values], axis=-1)
    else:
        values = np.asarray(raw_values)
    if values.ndim == 2:
        values = values[:, :, None]
    if values.ndim != 3:
        raise ValueError(f"Unexpected SHAP output shape: {values.shape}")

    if values.shape[2] > 1:
        # Plot the class with the strongest overall signal.
        class_idx = int(np.argmax(np.abs(values).mean(axis=(0, 1))))
        plot_values = values[:, :, class_idx]
        class_label = class_idx
        if is_class:
            try:
                class_label = df[target].astype("category").cat.categories[class_idx]
            except Exception:
                pass
        class_note = f" (most influential class: {class_label})"
    else:
        plot_values = values[:, :, 0]
        class_note = ""

    fig = plt.figure()
    shap.summary_plot(plot_values, sample, show=False, plot_size=(6, 4))
    img = _fig_to_base64(plt.gcf())

    # Global importance: average |SHAP| over samples and classes.
    importance = np.abs(values).mean(axis=(0, 2))
    ranked = sorted(zip(X.columns, importance.tolist()), key=lambda t: -t[1])
    top = ranked[0][0] if ranked else "?"
    return {
        "image": img,
        "text": f"SHAP analysis on target '{target}'{class_note}. The most influential feature is "
                f"'{top}'. Bars to the right push predictions up; bars to the left push them down.",
        "ranking": [{"feature": f, "impact": float(v)} for f, v in ranked[:10]],
    }


def _explain_lime(params):
    import lime
    import lime.lime_tabular
    import numpy as np

    df = _load_df(params)
    target = params.get("target") or df.columns[-1]
    model, X, is_class = _train_quick_model(df, target)

    explainer = lime.lime_tabular.LimeTabularExplainer(
        X.values, feature_names=list(X.columns),
        mode="classification" if is_class else "regression",
    )
    idx = int(params.get("row", 0))
    idx = max(0, min(idx, len(X) - 1))
    predict_fn = model.predict_proba if is_class else model.predict
    exp = explainer.explain_instance(X.values[idx], predict_fn, num_features=8)
    contributions = exp.as_list()
    return {
        "text": f"LIME explanation for row {idx} (target '{target}'). "
                f"Each rule shows how a feature value nudged this single prediction.",
        "contributions": [{"rule": r, "weight": float(w)} for r, w in contributions],
    }


def _explain_gradcam(params):
    """
    Grad-CAM heatmap for an image. Expects params['image'] as a base64 data URI.
    Uses a pretrained ResNet18 (torchvision) so no training is required.
    """
    import numpy as np
    import torch
    import torch.nn.functional as F
    from torchvision import models, transforms
    from PIL import Image
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    raw = params.get("image") or ""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError("Grad-CAM needs an image. Load a PNG/JPG first.")
    if "," in raw:
        raw = raw.split(",", 1)[1]
    try:
        image_bytes = base64.b64decode(raw, validate=True)
    except Exception as exc:
        raise ValueError("The loaded image could not be decoded. Try a PNG or JPG.") from exc
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB").resize((224, 224))
    except Exception as exc:
        raise ValueError("The loaded file is not a readable image. Try a PNG or JPG.") from exc

    try:
        model = models.resnet18(weights=models.ResNet18_Weights.DEFAULT).eval()
    except Exception as exc:
        raise RuntimeError(
            "Could not load the ResNet18 weights. The first Grad-CAM run downloads them; "
            "check your internet connection and try again."
        ) from exc
    tfm = transforms.Compose([
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    x = tfm(img).unsqueeze(0)

    activations, gradients = {}, {}
    target_layer = model.layer4[-1]
    target_layer.register_forward_hook(lambda m, i, o: activations.__setitem__("v", o.detach()))
    target_layer.register_full_backward_hook(lambda m, gi, go: gradients.__setitem__("v", go[0].detach()))

    out = model(x)
    cls = out.argmax(dim=1)
    class_idx = int(cls)
    categories = models.ResNet18_Weights.DEFAULT.meta.get("categories", [])
    label = categories[class_idx] if 0 <= class_idx < len(categories) else f"class #{class_idx}"
    model.zero_grad()
    out[0, cls].backward()

    grads = gradients["v"].mean(dim=[2, 3], keepdim=True)
    cam = F.relu((grads * activations["v"]).sum(dim=1)).squeeze().numpy()
    cam = (cam - cam.min()) / (cam.max() - cam.min() + 1e-8)

    fig, ax = plt.subplots(figsize=(4, 4))
    ax.imshow(img)
    ax.imshow(np.array(Image.fromarray((cam * 255).astype("uint8")).resize((224, 224))),
              cmap="jet", alpha=0.45)
    ax.axis("off")
    ax.set_title(f"Grad-CAM: {label}")
    return {
        "image": _fig_to_base64(fig),
        "text": f"Grad-CAM heatmap. Warm (red) regions are where the model looked most "
                f"to decide '{label}'.",
    }


# --------------------------------------------------------------------------- #
#  Dispatch loop
# --------------------------------------------------------------------------- #

HANDLERS = {
    "execute_code": execute_code,
    "preprocess": preprocess,
    "visualize": visualize,
    "explain": explain,
    "ping": lambda params: {"ok": True},
}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        mid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params", {}) or {}
        handler = HANDLERS.get(method)
        try:
            if handler is None:
                raise ValueError(f"Unknown method: {method}")
            result = handler(params)
            sys.stdout.write(json.dumps({"id": mid, "result": result}) + "\n")
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(traceback.format_exc())
            sys.stdout.write(json.dumps({"id": mid, "error": str(exc)}) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
