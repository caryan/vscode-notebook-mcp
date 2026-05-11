# vscode-notebook-mcp

A VS Code extension that exposes the Jupyter notebooks in your VSCode editor to MCP-compatible AI agents (e.g. Claude Code). The agent reads, edits, and runs cells against the same kernel VS Code is using.

> Status: pre-alpha, single-developer project. Built fresh; not a fork.

## Tools (13)

### Discovery
| Tool | Description |
|---|---|
| `notebook_list_open` | List all open notebooks with URI, file name, cell count, and which is active |
| `notebook_open` | Open a `.ipynb` file (absolute path, `file://` URI, or workspace-relative) so its cells become available |
| `notebook_list_cells` | List cells with index, kind, language, preview, execution state |
| `notebook_get_cell_content` | Full source of a cell |
| `notebook_get_cell_output` | Outputs of a cell (text, errors, images as base64) |

### Cell manipulation
| Tool | Description |
|---|---|
| `notebook_insert_cell` | Insert a code or markdown cell at any position; optionally execute |
| `notebook_edit_cell` | Replace contents of an existing cell |
| `notebook_delete_cell` | Delete a cell by index |

### Execution
| Tool | Description |
|---|---|
| `notebook_run_cell` | Execute an existing code cell and return outputs |
| `notebook_clear_cell_output` | Clear outputs of one cell |
| `notebook_clear_all_outputs` | Clear outputs of every cell |

### Kernel
| Tool | Description |
|---|---|
| `notebook_get_kernel_info` | Language, status, notebook URI |
| `notebook_select_kernel` | Pop the picker, or attach a specific controller by `kernel_id` (see [Kernel selection](#kernel-selection)) |

All tools accept an optional `notebook_uri` (omitted → uses the active notebook editor) and `response_format` (`"markdown"` or `"json"`).

## Setup

1. Install the [Jupyter extension](https://marketplace.visualstudio.com/items?itemName=ms-toolsai.jupyter) in VS Code if you don't already have it.
2. Build and run this extension:
   ```bash
   npm install
   npm run build
   ```
   Then open this folder in VS Code and press **F5** to launch an Extension Development Host with the extension loaded.
3. Add to your MCP client config:
   ```json
   {
     "mcpServers": {
       "notebook": {
         "url": "http://127.0.0.1:49777/mcp"
       }
     }
   }
   ```
4. Open a `.ipynb` file in the Extension Development Host. Look for the `🪐 :49777` indicator in the status bar.

### Configuration

| Setting | Default | Description |
|---|---|---|
| `notebook-mcp.port` | `49777` | Preferred port. Auto-increments if busy (up to +99). |

### Commands

- `Notebook MCP: Restart Server`
- `Notebook MCP: Show Server Info`

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    VS Code window                       │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Jupyter extension (ms-toolsai.jupyter)           │  │
│  │                                                   │  │
│  │  Notebook document  ◄──►  Kernel  ──►  Outputs    │  │
│  └───────────────────────────────────────────────────┘  │
│                          ▲                              │
│                          │ vscode.NotebookEdit,         │
│                          │ notebook.cell.execute,       │
│                          │ jupyter.kernels.getKernel    │
│                          │                              │
│  ┌───────────────────────┴───────────────────────────┐  │
│  │  This extension                                   │  │
│  │                                                   │  │
│  │   HTTP server :49777  ──►  MCP tools (13)         │  │
│  │   (StreamableHTTPServerTransport)                 │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                              │ HTTP (MCP protocol)
                              ▼
                ┌───────────────────────────────┐
                │   AI agent                    │
                │   (Claude Code, Cursor, etc.) │
                └───────────────────────────────┘
```

### Implementation notes

- **Writes** go through `vscode.NotebookEdit` + `vscode.WorkspaceEdit`, preserving undo/redo.
- **Execution** dispatches `notebook.cell.execute` and waits by polling `cell.executionSummary.success` for a `boolean` value (VS Code creates the summary as soon as execution starts but `success` only becomes a boolean when the kernel finishes).
- **Inserted cells** are tagged with a metadata id so the executor can find them again after the index shifts due to other concurrent edits.
- **Multi-notebook**: every tool accepts `notebook_uri`. Resolution: explicit URI → look up in `vscode.workspace.notebookDocuments` (or open it); otherwise fall back to `vscode.window.activeNotebookEditor`.

## Kernel selection

`notebook_select_kernel` today is mostly a passthrough to VS Code's `notebook.selectKernel` command. Without a `kernel_id` it pops the kernel picker UI — fine when there's a human at the editor, useless to a headless agent. With a `kernel_id` it tries to attach the controller with that exact id.

The friction: **the Jupyter extension exposes no public API to enumerate or assign controllers, and controller ids for interpreter-backed Python kernels are derived strings the Jupyter extension computes internally**. There is also no standard "kernel id" an agent can be expected to know in advance — the format depends on the kernel source (kernelspec vs. interpreter) and includes a hash of the interpreter path. Empirically (verified by reading VS Code's "wanted kernel … all: …" log line) the format for an interpreter-backed kernel is:

```
.jvsc74a57bd0<sha256(normalizedInterpreterPath)>.<normPath>.<normPath>.-m#ipykernel_launcher
```

Where `normalizedInterpreterPath` strips just the `bin/` segment of a venv path while keeping the `python` filename — so `/x/y/.venv/bin/python` becomes `/x/y/.venv/python` (system paths like `/usr/bin/python3` are left untouched). See `getKernelId` and `getInterpreterKernelSpecName` in [microsoft/vscode-jupyter](https://github.com/microsoft/vscode-jupyter/blob/main/src/kernels/helpers.ts).

**What the integration test suite does today.** The test helper `selectVenvKernel` at `test/integration/suite/helpers.ts` (a) tells the Python extension to mark the venv as the active interpreter so the Jupyter extension creates a controller for it, then (b) constructs the controller id from the normalized path, then (c) dispatches `notebook.selectKernel`. Brittle to upstream changes in the Jupyter extension, but it works and is documented in code. If a future Jupyter version changes the format, the failure mode is informative — VS Code logs both the requested id and the available ones (`wanted kernel DOES NOT EXIST, wanted: <id>, all: <ids>`) so the new format can be reverse-engineered the same way.

**Where this is heading.** The intent is to make this an MCP tool — something like `notebook_attach_python_kernel({ python_path })` — so an agent can say "use this venv" without having to know any controller id. Implementation plan: take an interpreter path, normalize it, probe the version, compute the controller id, dispatch `notebook.selectKernel`, and confirm via `kernels.getKernel(uri)`. Same logic as the test helper, exposed as a tool. Open questions before that lands:

- Should it accept other forms of "kernel" too (a global kernelspec name, a remote Jupyter server URL)?
- How should it report failure (controller not registered yet, version mismatch, picker fallback)?
- What happens when the upstream id format changes — fall back to popping the picker, or surface a clear error?

If you want to push this along, the helper code in `test/integration/suite/helpers.ts` is a good starting point.

## Development

```bash
npm install
npm run build       # esbuild bundle
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
npm test            # @vscode/test-electron + Mocha integration tests
```

Press **F5** in VS Code to launch the Extension Development Host.

### Running the tests

`npm test` runs the integration suite under `@vscode/test-electron`. It downloads a fresh **VS Code Insiders** build, installs `ms-python.python` and `ms-toolsai.jupyter` into it, opens the test workspace at `test/fixtures/workspace/`, and runs Mocha specs that drive the MCP tools through an in-memory transport (no HTTP). Test files live in `test/integration/suite/`.

> Why Insiders: macOS refuses to launch a second extension-host of the same bundle id, so running tests against stable VS Code fails when you already have stable VS Code open ("currently only supported if no other instance of Code is running"). Insiders and stable have distinct bundle ids and coexist. Override with `VSCODE_TEST_CHANNEL=stable` if you don't have stable open.

Prerequisites:

- [`uv`](https://docs.astral.sh/uv/) on PATH — used to manage the Python venv at `test/fixtures/python/.venv` that supplies the test kernel (ipykernel + matplotlib + numpy + plotly). Pinned to Python 3.13 via `.python-version`.

The `pretest` hook builds the extension (`npm run build`), compiles the tests (`npm run build:test` → `out/`), and runs `scripts/setup-test-python.sh` which is idempotent (`uv sync` only).

Notes on what the tests cover:

- **Non-execution tools** (`notebooks.test.ts`, `cells.test.ts`) — list/open/get/insert/edit/delete/clear, error paths, active-editor fallback. Run without a Python kernel.
- **Execution + kernel** (`execution.test.ts`, `kernel.test.ts`) — depend on `selectVenvKernel` attaching the venv's interpreter; see [Kernel selection](#kernel-selection).
- **Plotly** (`plotly.test.ts`) — verifies a Plotly figure flows through the hidden webview renderer to a PNG image content block.

### Dependencies

**Runtime (`dependencies`)**

- **`@modelcontextprotocol/sdk`** — the MCP server itself. We use `McpServer` (one per session, see `src/mcp/server.ts`) and `StreamableHTTPServerTransport` to speak MCP over the embedded HTTP server. Tool registration in `src/mcp/tools/*.ts` is all SDK API.
- **`plotly.js-dist-min`** — bundled into `dist/plotly.min.js` by the `copy:plotly` script and loaded inside the hidden `notebook-mcp.plotlyRenderer` webview. The webview converts Plotly figure JSON to PNG via `Plotly.newPlot` + `Plotly.toImage`. We can't run Plotly in the extension host (no DOM), and shipping the bundle locally avoids a runtime CDN fetch under the webview's strict CSP. Using `-dist-min` (the prebuilt minified bundle) instead of `plotly.js` keeps the VSIX smaller and avoids pulling in Plotly's full build toolchain.
- **`zod`** — schema definitions in `src/schemas/index.ts` and per-tool input validation across `cells.ts` / `kernel.ts` / `notebooks.ts`. The MCP SDK accepts zod schemas directly when registering tools, so we get validation + JSON Schema generation for free.

**Dev (`devDependencies`)**

- **`@types/node`** — Node typings for extension-host code (`Buffer`, `process`, `http`, etc.).
- **`@types/vscode`** — VS Code Extension API typings. Pinned to `^1.85.0` to match `engines.vscode`.
- **`esbuild`** — bundler used by `npm run build` to produce the single `dist/extension.js` that VS Code loads. Chosen over `tsc` for build speed and tree-shaking; `--external:vscode` keeps the host-provided module out of the bundle.
- **`typescript`** — provides `tsc` for the `typecheck` script (`tsc --noEmit`) and the `build:test` script (`tsc -p tsconfig.test.json` → `out/`). Esbuild handles the production bundle; tsc handles the test build because Mocha loads test files directly.
- **`mocha` + `@types/mocha`** — test runner, the convention with `@vscode/test-electron`. The bootstrapper at `test/integration/suite/index.ts` discovers `*.test.js` files under `out/test/integration/suite/` and feeds them to Mocha.
- **`@vscode/test-electron`** — downloads a stable VS Code into `.vscode-test/`, installs `ms-toolsai.jupyter` into it, and launches it with the extension under development plus the test workspace fixture. See `test/integration/runTest.ts`.
- **`glob` + `@types/glob`** — used by the Mocha bootstrapper to discover compiled test files.

### Building a VSIX

To produce an installable `.vsix` file:

```bash
npx @vscode/vsce package
```

This runs `vscode:prepublish` (which builds via esbuild) and writes `vscode-notebook-mcp-<version>.vsix` to the repo root. Install it with:

```bash
code --install-extension vscode-notebook-mcp-<version>.vsix
```

`.vscodeignore` keeps the package small by excluding TS sources, `node_modules`, source maps, and dev configs — only the bundled `dist/`, `package.json`, `README.md`, and `LICENSE` are shipped.

## References

Other projects along similar lines to this project:

- [datalayer/jupyter-mcp-server](https://github.com/datalayer/jupyter-mcp-server) — MCP server that talks to a running Jupyter server via HTTP/WebSocket.
- [olavocarvalho/vscode-runtime-notebook-mcp](https://github.com/olavocarvalho/vscode-runtime-notebook-mcp) — similar architecture as this project (VS Code Notebook API + embedded HTTP MCP server).

I built this fresh to learn and so I have room to tweak the design and develop new features such as reading Plotly images. 

## License

MIT
