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
npm test            # vitest run (no tests yet)
```

To run the extension: open this folder in VS Code and press **F5** to launch an Extension Development Host. The dev host runs the launch config in `.vscode/launch.json` (which has `npm: build` as a preLaunchTask).

There is no test suite yet (`npm test` runs vitest with zero tests). Manual testing uses `manual-test/test.ipynb` opened inside the dev host.

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
