import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResponseFormatSchema } from "../../schemas/index.js";

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
}
