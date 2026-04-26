# vscode-notebook-mcp

A VS Code extension that exposes the Jupyter notebooks in your VSCode editor to MCP-compatible AI agents (e.g. Claude Code). The agent reads, edits, and runs cells against the same kernel VS Code is using.

> Status: pre-alpha, single-developer project. Built fresh; not a fork.

## Tools (12)

### Discovery
| Tool | Description |
|---|---|
| `notebook_list_open` | List all open notebooks with URI, file name, cell count, and which is active |
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
│  │   HTTP server :49777  ──►  MCP tools (12)         │  │
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

## References

Other projects along similar lines to this project:

- [datalayer/jupyter-mcp-server](https://github.com/datalayer/jupyter-mcp-server) — MCP server that talks to a running Jupyter server via HTTP/WebSocket.
- [olavocarvalho/vscode-runtime-notebook-mcp](https://github.com/olavocarvalho/vscode-runtime-notebook-mcp) — similar architecture as this project (VS Code Notebook API + embedded HTTP MCP server).

I built this fresh to learn and so I have room to tweak the design and develop new features.

## License

MIT
