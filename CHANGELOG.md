# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-10

Initial release.

### Added

- Embedded HTTP MCP server inside the VS Code extension host on `127.0.0.1:49777` (configurable via `notebook-mcp.port`; auto-increments up to +99 if the port is busy). Speaks MCP over `StreamableHTTPServerTransport`; also exposes `GET /health`.
- A fresh `McpServer` is created per session so multiple MCP clients can connect concurrently without colliding on a shared transport.
- 13 MCP tools covering the full notebook-editing loop:
  - **Discovery** — `notebook_list_open`, `notebook_open`, `notebook_list_cells`, `notebook_get_cell_content`, `notebook_get_cell_output`.
  - **Cell manipulation** — `notebook_insert_cell`, `notebook_edit_cell`, `notebook_delete_cell`.
  - **Execution** — `notebook_run_cell`, `notebook_clear_cell_output`, `notebook_clear_all_outputs`.
  - **Kernel** — `notebook_get_kernel_info`, `notebook_select_kernel`.
- All tools accept an optional `notebook_uri` (defaults to the active notebook editor) and a `response_format` of `"markdown"` or `"json"`.
- Edits flow through `vscode.NotebookEdit` + `vscode.WorkspaceEdit` so they participate in undo/redo and share state with the editor.
- Inserted cells are tagged with a `metadata.id`, letting the executor track them across concurrent edits that shift cell indices.
- Plotly outputs (`application/vnd.plotly.v1+json`) are rendered to PNG via a hidden `WebviewView` and returned as MCP image content blocks alongside the markdown summary.
- Status bar item showing server state, using the VS Code notebook codicon.
- Commands: `Notebook MCP: Restart Server`, `Notebook MCP: Show Server Info`.
- Packaging support via `@vscode/vsce`: `.vscodeignore` keeps the VSIX small (only `dist/`, `package.json`, `README.md`, and `LICENSE` ship); `repository` field set in `package.json`.

[0.1.0]: https://github.com/caryan/vscode-notebook-mcp/releases/tag/v0.1.0
