/*
 * Run notebook Python in a Pyodide Web Worker. Code stays in the user's browser;
 * it is never sent to the public research API or executed on the web server.
 */
const PYODIDE_VERSION = "0.27.7"
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`
let runtimePromise

const PYTHON_HELPERS = `
import ast as __dreamy_ast
import base64 as __dreamy_base64
import contextlib as __dreamy_contextlib
import io as __dreamy_io
import json as __dreamy_json
import traceback as __dreamy_traceback

__dreamy_dataset_sig = None

def __dreamy_run_cell(code, dataset_json):
    global __dreamy_dataset_sig
    dataset = __dreamy_json.loads(dataset_json or "{}")
    sig = dataset.get("sig")
    csv_text = dataset.get("csv")
    if sig and sig != __dreamy_dataset_sig and csv_text:
        import pandas as pd
        frame = pd.read_csv(__dreamy_io.StringIO(csv_text))
        globals()["df"] = frame
        globals()["dataset"] = frame
        globals()["dataset_name"] = dataset.get("name") or "dataset.csv"
        globals()["dataset_path"] = None
        __dreamy_dataset_sig = sig

    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        plt.show = lambda *args, **kwargs: None
    except ImportError:
        pass

    stdout = __dreamy_io.StringIO()
    stderr = __dreamy_io.StringIO()
    result = None
    try:
        tree = __dreamy_ast.parse(code, mode="exec")
        with __dreamy_contextlib.redirect_stdout(stdout), __dreamy_contextlib.redirect_stderr(stderr):
            if tree.body and isinstance(tree.body[-1], __dreamy_ast.Expr):
                last = tree.body.pop()
                if tree.body:
                    exec(compile(tree, "<cell>", "exec"), globals(), globals())
                result = eval(compile(__dreamy_ast.Expression(last.value), "<cell>", "eval"), globals(), globals())
            else:
                exec(compile(tree, "<cell>", "exec"), globals(), globals())
    except Exception:
        __dreamy_traceback.print_exc(file=stderr)

    output = stdout.getvalue()
    errors = stderr.getvalue()
    if result is not None:
        if output and not output.endswith("\\n"):
            output += "\\n"
        output += repr(result)
    if errors:
        if output and not output.endswith("\\n"):
            output += "\\n"
        output += errors

    images = []
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        for number in list(plt.get_fignums())[:4]:
            buffer = __dreamy_io.BytesIO()
            plt.figure(number).savefig(buffer, format="png", bbox_inches="tight", dpi=100)
            images.append("data:image/png;base64," + __dreamy_base64.b64encode(buffer.getvalue()).decode("ascii"))
        plt.close("all")
    except ImportError:
        pass
    except Exception:
        try:
            import matplotlib.pyplot as plt
            plt.close("all")
        except Exception:
            pass

    return __dreamy_json.dumps({"output": output.rstrip() or "(no output)", "images": images})
`

async function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      importScripts(`${PYODIDE_BASE}pyodide.js`)
      const pyodide = await loadPyodide({ indexURL: PYODIDE_BASE })
      await pyodide.loadPackage(["numpy", "pandas", "matplotlib", "scikit-learn"])
      pyodide.runPython(PYTHON_HELPERS)
      return pyodide
    })().catch((error) => {
      runtimePromise = null
      throw error
    })
  }
  return runtimePromise
}

self.onmessage = async ({ data }) => {
  const { id, code, dataset } = data
  try {
    const pyodide = await getRuntime()
    pyodide.globals.set("__dreamy_js_code", String(code || ""))
    pyodide.globals.set("__dreamy_js_dataset", JSON.stringify(dataset || {}))
    const proxy = pyodide.runPython("__dreamy_run_cell(__dreamy_js_code, __dreamy_js_dataset)")
    const result = JSON.parse(proxy.toString())
    proxy.destroy()
    self.postMessage({ id, result })
  } catch (error) {
    self.postMessage({ id, error: error && error.message ? error.message : String(error) })
  }
}
