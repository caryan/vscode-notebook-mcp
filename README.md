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
| `notebook_select_kernel` | Programmatic by `kernel_id`, or open the kernel picker if omitted |

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

## Development

```bash
npm install
npm run build       # esbuild bundle
npm run watch       # rebuild on change
npm run typecheck   # tsc --noEmit
npm test            # vitest (no tests yet)
```

Press **F5** in VS Code to launch the Extension Development Host.

### Dependencies

**Runtime (`dependencies`)**

- **`@modelcontextprotocol/sdk`** — the MCP server itself. We use `McpServer` (one per session, see `src/mcp/server.ts`) and `StreamableHTTPServerTransport` to speak MCP over the embedded HTTP server. Tool registration in `src/mcp/tools/*.ts` is all SDK API.
- **`plotly.js-dist-min`** — bundled into `dist/plotly.min.js` by the `copy:plotly` script and loaded inside the hidden `notebook-mcp.plotlyRenderer` webview. The webview converts Plotly figure JSON to PNG via `Plotly.newPlot` + `Plotly.toImage`. We can't run Plotly in the extension host (no DOM), and shipping the bundle locally avoids a runtime CDN fetch under the webview's strict CSP. Using `-dist-min` (the prebuilt minified bundle) instead of `plotly.js` keeps the VSIX smaller and avoids pulling in Plotly's full build toolchain.
- **`zod`** — schema definitions in `src/schemas/index.ts` and per-tool input validation across `cells.ts` / `kernel.ts` / `notebooks.ts`. The MCP SDK accepts zod schemas directly when registering tools, so we get validation + JSON Schema generation for free.

**Dev (`devDependencies`)**

- **`@types/node`** — Node typings for extension-host code (`Buffer`, `process`, `http`, etc.).
- **`@types/vscode`** — VS Code Extension API typings. Pinned to `^1.85.0` to match `engines.vscode`.
- **`esbuild`** — bundler used by `npm run build` to produce the single `dist/extension.js` that VS Code loads. Chosen over `tsc` for build speed and tree-shaking; `--external:vscode` keeps the host-provided module out of the bundle.
- **`typescript`** — provides `tsc` for the `typecheck` script (`tsc --noEmit`). Type checking only; esbuild does the actual transpilation.
- **`vitest`** — wired up as `npm test`. No tests yet, but the harness is ready so future tests don't need a separate setup step.

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
