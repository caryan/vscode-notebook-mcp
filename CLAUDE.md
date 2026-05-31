# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A VS Code extension (`extensionDependencies: ms-toolsai.jupyter`) that runs an embedded HTTP MCP server inside the VS Code extension host. It exposes the Jupyter notebooks already open in the user's editor — and their kernels — to MCP-compatible AI agents (Claude Code, Cursor, etc.). All notebook reads/writes/executions go through the live VS Code Notebook API, so they share state with the editor (undo/redo, the same kernel, the same outputs).

## Commands

```bash
npm install
npm run build       # esbuild bundle → dist/extension.js
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
npm test            # @vscode/test-electron + Mocha integration suite
```

To run the extension: open this folder in VS Code and press **F5** to launch an Extension Development Host. The dev host runs the launch config in `.vscode/launch.json` (which has `npm: build` as a preLaunchTask).

`npm test` requires `uv` on PATH — `pretest` runs `scripts/setup-test-python.sh` which `uv sync`s two venvs (pinned to Python 3.13 via `.python-version`): the main kernel env at `test/fixtures/python/.venv`, and `test/fixtures/python-unregistered/.venv` — an ipykernel-only env that no test registers with the Python extension itself, used by the step-2 kernel test to prove `notebook_select_kernel` can make a never-before-seen interpreter usable on its own. Tests live in `test/integration/suite/` and are compiled by `tsc -p tsconfig.test.json` to `out/`. The runner downloads a fresh stable VS Code into `.vscode-test/`, installs `ms-toolsai.jupyter` into it, opens the workspace at `test/fixtures/workspace/`, and drives the MCP tools through an in-memory transport (no HTTP). Manual testing still uses `end-to-end-test/test.ipynb` opened in the dev host.

### Kernel selection in tests
The Jupyter extension exposes no public API to assign a kernel to a notebook. The controller-id format Jupyter uses internally (`.jvsc74a57bd0<sha256(normalizedInterpreterPath)>.<normPath>.<normPath>.-m#ipykernel_launcher`) now lives in production code — `controllerIdForInterpreter` / `normalizeInterpreterPath` in `src/utils/kernel.ts`, mirroring `getKernelId` / `getInterpreterKernelSpecName` in microsoft/vscode-jupyter; if Jupyter changes that scheme these break. The helper `selectVenvKernel` in `test/integration/suite/helpers.ts` imports those and dispatches `notebook.selectKernel`, and `notebook_select_kernel`'s `python_path` parameter exposes the same logic to agents so they can attach a kernel by interpreter path without hashing or popping the picker (the former roadmap item, now shipped).

## Manual end-to-end tool exercise (SOP)

Use this when you want to smoke-test every MCP tool against the live extension. The integration suite (`npm test`) covers correctness through an in-memory transport; this SOP covers the wiring end-to-end (HTTP transport, real Jupyter extension, real kernel, Plotly webview). Run it from inside a Claude Code session connected to the running extension's MCP server.

### One-time venv setup (uv)

```bash
cd end-to-end-test
uv venv --python 3.13 .venv
uv pip install --python .venv/bin/python ipykernel nbformat matplotlib numpy pandas plotly
```

`ipykernel` is the only hard requirement — without it Jupyter can't start a kernel. `nbformat` keeps Plotly's `_ipython_display_` from raising `ValueError: Mime type rendering requires nbformat>=4.2.0` alongside the rendered figure (the webview branch still renders without it, but the cell ends up with a noisy ErrorOutput). The visualization libs cover the image / Plotly / DataFrame output branches; skipping any of them just makes the corresponding cell raise `ModuleNotFoundError` (which is still a valid exercise of the error path, just not of the image path).

### Reset the notebook

```bash
rm -f end-to-end-test/test.ipynb
python3 -c 'import json,pathlib; pathlib.Path("end-to-end-test/test.ipynb").write_text(json.dumps({"cells":[{"cell_type":"code","metadata":{},"source":[],"outputs":[],"execution_count":None}],"metadata":{"kernelspec":{"name":"python3","display_name":"Python 3"}},"nbformat":4,"nbformat_minor":5}))'
```

That yields a minimal nbformat 4.5 notebook with a single empty code cell — the placeholder that row 19 eventually deletes.

### Attaching a kernel — picker workaround

`notebook_select_kernel` without `kernel_id`/`python_path` currently errors with `Cannot read properties of undefined (reading 'uri')` when the notebook isn't a focused editor. The stub `notebookEditor` payload we pass at `src/mcp/tools/kernel.ts` is rejected by VS Code's picker handler (the picker path dereferences something on the real `NotebookEditor` that our stub lacks); the programmatic branch takes a code path that doesn't trip the deref. So drive selection programmatically: **pass `python_path`** (the absolute path to the env's `bin/python`) and the tool computes the controller id for you — no hashing required. (The `kernel_id` parameter is still accepted for the rare case you already have a controller id.)

The controller is bound eagerly but the kernel session is lazy — `notebook_get_kernel_info` reports "not connected" until a cell actually executes. Issue an `notebook_insert_cell` with `execute: true` first to force the attach.

A *freshly created* venv no longer needs a manual **Python: Select Interpreter** step first: when given `python_path`, `notebook_select_kernel` registers the interpreter with the Python extension itself (`registerInterpreter` in `src/utils/pythonEnv.ts` — refresh discovery, resolve the path, set it active for the workspace) so Jupyter creates a controller for it. The controller lands a beat after the interpreter becomes known, so the tool retries `notebook.selectKernel` for a few seconds (`selectKernelById` in `src/utils/kernel.ts`) to avoid binding before it exists. The integration tests exercise exactly this through `test/fixtures/python-unregistered/.venv`, which nothing else registers.

### Tool coverage checklist

Drive through these in order. Each row exercises a non-trivial path of one tool. Rows 12a–15a explicitly insert the cells that rows 12–15 run, because the reset step leaves only the placeholder; without those inserts the run rows fail with "cell index out of range".

| # | Tool | Call |
|---|---|---|
| 1 | `notebook_open` | open the fresh `test.ipynb` |
| 2 | `notebook_list_open` | confirm it's active |
| 3 | `notebook_get_kernel_info` | expect `connected: false` |
| 4 | `notebook_select_kernel` | pass the env's `python_path` |
| 5 | `notebook_list_cells` | sanity check initial state |
| 6 | `notebook_insert_cell` (markdown, indexed) | insert title at index 0 |
| 7 | `notebook_insert_cell` (code, append) | e.g. `2 + 2` |
| 8 | `notebook_insert_cell` (code, `execute: true`) | forces kernel attach + exercises id-based wait |
| 9 | `notebook_get_kernel_info` | now reports `connected: true` — verifies the lazy attach worked |
| 10 | `notebook_edit_cell` | replace one cell's content |
| 11 | `notebook_get_cell_content` | verify the edit |
| 12a | `notebook_insert_cell` (code, append) | matplotlib source: `import matplotlib.pyplot as plt; plt.plot([1,2,3]); plt.show()` |
| 12 | `notebook_run_cell` | run the matplotlib cell → `image/png` branch |
| 13a | `notebook_insert_cell` (code, append) | Plotly source: `import plotly.express as px; px.line(y=[1,2,3])` |
| 13 | `notebook_run_cell` | run the Plotly cell → `notebook-mcp.plotlyRenderer` webview branch |
| 14a | `notebook_insert_cell` (code, append) | pandas source: `import pandas as pd; pd.DataFrame({"a":[1,2]})` |
| 14 | `notebook_run_cell` | run the DataFrame cell → html + text fallback branch |
| 15a | `notebook_insert_cell` (code, append) | error source: `raise ValueError("boom")` |
| 15 | `notebook_run_cell` | run the error cell → `ErrorOutput` branch |
| 16 | `notebook_get_cell_output` | re-fetch one of the rows-12–15 outputs *without* re-executing — exercises the standalone output-read path (cell-cached output, no run), once with `response_format: "markdown"` and once with `"json"` |
| 17 | `notebook_clear_cell_output` | clear one cell's output |
| 18 | `notebook_clear_all_outputs` | clear the rest |
| 19 | `notebook_delete_cell` | delete the original placeholder |

Finish by re-running every code cell in index order so the saved notebook has fresh outputs end to end, then save it in VS Code (Cmd+S) if it isn't auto-saved. Inspecting the resulting `test.ipynb` (committed or not) is the eyeball check that the bundle, the webview, and the kernel wiring all still work.

## Architecture

### Process layout
- The extension activates `onStartupFinished` (`src/extension.ts`) and starts an HTTP server on `127.0.0.1:<port>` (default `49777`, scans up to +99 if busy). The status bar item shows `$(notebook) :<port>` (VS Code notebook codicon) when up, `$(notebook) ✗` on failure.
- The server lives entirely inside the VS Code extension host process — it's not a separate binary. That's how it can call `vscode.*` APIs synchronously.
- MCP clients connect via `http://127.0.0.1:<port>/mcp` using **StreamableHTTP** transport. There's also a `GET /health` endpoint.

### MCP transport — one McpServer per session
`src/mcp/server.ts` keeps a `Map<sessionId, McpServer>` and a `Map<sessionId, StreamableHTTPServerTransport>`. On the first POST to `/mcp` without a session id, it mints a new UUID, builds a fresh `McpServer` via `createMcpServer()`, registers all tools on it, and connects it to a new transport. Subsequent requests carrying `mcp-session-id` route to the existing pair. `transport.onclose` cleans both maps.

This per-session construction is deliberate (commit `6c02e9a`) — sharing one `McpServer` across sessions caused issues, so do not refactor it back to a singleton.

### Tool registration
All tools are registered through `registerAllTools(server)` in `src/mcp/tools/index.ts`, which fans out to:
- `notebooks.ts` — `notebook_list_open`, `notebook_open`
- `cells.ts` — list / get / insert / edit / delete / run / clear-output tools
- `kernel.ts` — `notebook_get_kernel_info`, `notebook_select_kernel`

Every tool accepts an optional `notebook_uri` (omit → active notebook editor) and `response_format: "markdown" | "json"` (default `"markdown"`). Schemas live in `src/schemas/index.ts` (zod). Keep adding tools by following these conventions:
- Use `NotebookUriSchema`, `CellIndexSchema`, `ResponseFormatSchema` from `schemas/index.ts`.
- Resolve target notebook via `resolveNotebook(notebook_uri)` from `utils/notebook.ts` — it handles "explicit URI → workspace lookup → open if missing" and "no URI → active editor".
- Return through the `TextResult` / `ErrorResult` helpers used in `cells.ts` / `kernel.ts`.

### Three non-obvious mechanics

**Cell tracking across edits (`src/utils/notebook.ts`).** When `notebook_insert_cell` inserts a cell and `execute: true`, concurrent edits could shift its index before execution finishes. To survive that, every inserted cell gets a random `metadata.id` (`generateCellId`), and `waitForCellExecution` polls by **id**, not index. `notebook_run_cell` uses `waitForCellExecutionByIndex` because the user is targeting a stable, pre-existing index.

**Execution completion detection.** VS Code creates `cell.executionSummary` (with `timing.startTime`) as soon as a run starts but only assigns `executionSummary.success` to a boolean once the kernel reports completion. The wait helpers poll for `typeof success === "boolean"` — do not switch to checking `timing.endTime` or relying on the command awaitable, both of which return before the kernel is done.

**Plotly rendering via a hidden WebviewView (`src/utils/plotly.ts`).** Plotly outputs (`application/vnd.plotly.v1+json`) are not images out of the box — Jupyter ships JSON figure specs. We can't run `plotly.js` in the extension host (no DOM), so the extension contributes a `webviewView` (id `notebook-mcp.plotlyRenderer`) to a panel container. `parseOutputs` posts each figure to that webview, which calls `Plotly.newPlot` + `Plotly.toImage` and posts back a PNG data URL. The webview is set up with `retainContextWhenHidden: true` and the panel is auto-closed after the first resolve, so the renderer stays warm but invisible. Plotly is bundled at build time by `npm run copy:plotly` (which copies `plotly.min.js` into `dist/`) so the webview can load it as a local resource under the strict CSP.

### Edit semantics
- All structural changes (insert/delete) go through `vscode.NotebookEdit` + `vscode.WorkspaceEdit` (`utils/notebook.ts`) so they participate in undo/redo.
- Cell content edits use `WorkspaceEdit.replace` against the cell's text document.
- Output clearing and execution use VS Code commands (`notebook.cell.clearOutputs`, `notebook.cell.execute`) addressed by `{ ranges, document: notebook.uri }`.

### Kernel access
`kernel.ts` activates the Jupyter extension (`ms-toolsai.jupyter`) on demand and caches the API in `jupyterApi`. Kernel info comes from `api.kernels.getKernel(notebook.uri)`. Kernel selection goes through the `notebook.selectKernel` command — programmatic when a `kernel_id` is passed, picker UI when omitted.

### Output parsing (`src/utils/output.ts`)
`parseOutputs` walks `NotebookCellOutput.items` and produces a tagged union of `TextOutput | ErrorOutput | ImageOutput`. Errors are detected by mime — it compares against `vscode.NotebookCellOutputItem.error(new Error("")).mime` (computed once at module load) rather than hard-coding the mime string. Images are base64-encoded. Text outputs are truncated at 25,000 characters with a trailing length marker. If an output contains a Plotly mime item, the textual fallbacks in the same output are skipped in favor of the rendered PNG.

## Config surface

- `notebook-mcp.port` (number, default 49777) — preferred port; auto-bumps if busy.
- Two commands: `notebook-mcp.restartServer`, `notebook-mcp.showInfo` (status bar click target).
- One webview view: `notebook-mcp.plotlyRenderer` in a `notebook-mcp-utility` panel container — internal, used only for Plotly rendering.
