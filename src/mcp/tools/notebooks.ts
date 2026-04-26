import * as path from "path";
import * as vscode from "vscode";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResponseFormatSchema } from "../../schemas/index.js";

const OpenNotebookInput = {
  path: z
    .string()
    .describe(
      "Path to the .ipynb file. Accepts an absolute path, a file:// URI, or a path relative to a workspace folder."
    ),
  show: z
    .boolean()
    .default(true)
    .describe("Reveal the notebook in an editor tab after opening."),
  response_format: ResponseFormatSchema
};

function resolveNotebookUri(input: string): vscode.Uri | { error: string } {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    try {
      return vscode.Uri.parse(input, true);
    } catch (err) {
      return { error: `Invalid URI: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  if (path.isAbsolute(input)) {
    return vscode.Uri.file(input);
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return {
      error: `Cannot resolve relative path "${input}": no workspace folder is open. Pass an absolute path or file:// URI.`
    };
  }
  return vscode.Uri.joinPath(folders[0].uri, input);
}

export function registerNotebookTools(server: McpServer): void {
  server.tool(
    "notebook_list_open",
    "List all open notebooks with their URI, file name, cell count, and which one is currently active in the editor.",
    { response_format: ResponseFormatSchema },
    async ({ response_format }) => {
      const activeUri = vscode.window.activeNotebookEditor?.notebook.uri.toString();
      const notebooks = vscode.workspace.notebookDocuments.map((nb) => ({
        uri: nb.uri.toString(),
        fileName: nb.uri.path.split("/").pop() ?? "unknown",
        cellCount: nb.cellCount,
        isActive: nb.uri.toString() === activeUri
      }));

      if (response_format === "json") {
        return {
          content: [
            { type: "text", text: JSON.stringify({ notebooks }, null, 2) }
          ]
        };
      }

      if (notebooks.length === 0) {
        return {
          content: [
            { type: "text", text: "No notebooks open. Open a .ipynb file first." }
          ]
        };
      }

      const lines = [`# Open Notebooks (${notebooks.length})`, ""];
      for (const nb of notebooks) {
        lines.push(
          `- **${nb.fileName}** (${nb.cellCount} cells)${nb.isActive ? " ← active" : ""}`
        );
        lines.push(`  \`${nb.uri}\``);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "notebook_open",
    "Open a .ipynb file in VS Code so its cells become available to the other notebook tools. Returns the resolved URI and cell count.",
    OpenNotebookInput,
    async ({ path: inputPath, show, response_format }) => {
      const resolved = resolveNotebookUri(inputPath);
      if (resolved instanceof vscode.Uri === false) {
        return {
          content: [{ type: "text", text: `Error: ${(resolved as { error: string }).error}` }],
          isError: true
        };
      }
      const uri = resolved as vscode.Uri;

      let notebook: vscode.NotebookDocument;
      try {
        notebook = await vscode.workspace.openNotebookDocument(uri);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error: failed to open notebook at ${uri.toString()}: ${err instanceof Error ? err.message : String(err)}`
            }
          ],
          isError: true
        };
      }

      if (show) {
        await vscode.window.showNotebookDocument(notebook, {
          preserveFocus: false,
          preview: false
        });
      }

      const result = {
        uri: notebook.uri.toString(),
        fileName: notebook.uri.path.split("/").pop() ?? "unknown",
        cellCount: notebook.cellCount,
        shown: show
      };

      if (response_format === "json") {
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      const lines = [
        `# Notebook Opened`,
        "",
        `**File**: ${result.fileName}`,
        `**Cells**: ${result.cellCount}`,
        `**URI**: \`${result.uri}\``
      ];
      if (!show) {
        lines.push("", "_Loaded in the background; not shown in an editor tab._");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
