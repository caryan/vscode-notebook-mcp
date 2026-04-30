import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ResponseFormatSchema,
  NotebookUriSchema,
  CellIndexSchema
} from "../../schemas/index.js";
import {
  parseOutputs,
  formatOutputsAsMarkdown,
  CellOutput
} from "../../utils/output.js";
import {
  resolveNotebook,
  insertCells,
  deleteCells,
  editCellContent,
  generateCellId,
  waitForCellExecution,
  waitForCellExecutionByIndex
} from "../../utils/notebook.js";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const TextResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }] });

const ErrorResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }], isError: true });

function ResultWithImages(text: string, outputs: CellOutput[]) {
  const content: ContentBlock[] = [{ type: "text", text }];
  for (const o of outputs) {
    if (o.type === "image") {
      content.push({ type: "image", data: o.data, mimeType: o.mimeType });
    }
  }
  return { content };
}

function isCellExecuting(cell: vscode.NotebookCell): boolean {
  const timing = cell.executionSummary?.timing;
  return !!timing && timing.startTime !== undefined && timing.endTime === undefined;
}

const ListCellsInput = {
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const CellTargetInput = {
  index: CellIndexSchema,
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const InsertCellInput = {
  content: z.string().describe("Cell content (code or markdown source)"),
  type: z.enum(["code", "markdown"]).default("code").describe("Cell type"),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Position to insert at. Defaults to appending at the end."),
  language: z
    .string()
    .default("python")
    .describe("Language identifier for code cells"),
  execute: z
    .boolean()
    .default(false)
    .describe("Execute the cell immediately after inserting (code cells only)"),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const EditCellInput = {
  index: CellIndexSchema,
  content: z.string().describe("New cell content (replaces existing)"),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const ClearAllInput = {
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

export function registerCellTools(server: McpServer): void {
  server.tool(
    "notebook_list_cells",
    "List cells in a notebook with index, kind, language, line count, content preview, and execution state.",
    ListCellsInput,
    async ({ notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const cells = access.notebook!.getCells().map((cell, index) => ({
        index,
        kind:
          cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
        language: cell.document.languageId,
        lineCount: cell.document.lineCount,
        preview: cell.document
          .getText()
          .substring(0, 100)
          .replace(/\n/g, "↵"),
        hasOutput: cell.outputs.length > 0,
        executionOrder: cell.executionSummary?.executionOrder ?? null
      }));

      if (response_format === "json") {
        return TextResult(JSON.stringify({ total: cells.length, cells }, null, 2));
      }

      const lines = [`# Notebook Cells (${cells.length} total)`, ""];
      for (const cell of cells) {
        const exec = cell.executionOrder ? ` [${cell.executionOrder}]` : "";
        const out = cell.hasOutput ? " 📊" : "";
        lines.push(
          `## Cell ${cell.index}${exec}${out} (${cell.kind}/${cell.language})`
        );
        lines.push("```", cell.preview + (cell.lineCount > 3 ? "..." : ""), "```", "");
      }
      return TextResult(lines.join("\n"));
    }
  );

  server.tool(
    "notebook_get_cell_content",
    "Get the full source of a cell.",
    CellTargetInput,
    async ({ index, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const notebook = access.notebook!;
      if (index >= notebook.cellCount) {
        return ErrorResult(
          `Error: Cell index ${index} out of range (0-${notebook.cellCount - 1}).`
        );
      }
      const cell = notebook.cellAt(index);
      const output = {
        index,
        kind: cell.kind === vscode.NotebookCellKind.Code ? "code" : "markdown",
        language: cell.document.languageId,
        content: cell.document.getText()
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(output, null, 2));
      }
      return TextResult(
        [
          `# Cell ${index} (${output.kind}/${output.language})`,
          "",
          "```" + output.language,
          output.content,
          "```"
        ].join("\n")
      );
    }
  );

  server.tool(
    "notebook_get_cell_output",
    "Get the outputs of a cell (text, errors, images as base64).",
    CellTargetInput,
    async ({ index, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const notebook = access.notebook!;
      if (index >= notebook.cellCount) {
        return ErrorResult(
          `Error: Cell index ${index} out of range (0-${notebook.cellCount - 1}).`
        );
      }
      const cell = notebook.cellAt(index);
      const outputs = await parseOutputs(cell.outputs);
      const result = {
        index,
        hasOutput: outputs.length > 0,
        executionOrder: cell.executionSummary?.executionOrder ?? null,
        outputs
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      if (outputs.length === 0) {
        return TextResult(`# Cell ${index} Output\n\nNo output available.`);
      }
      return ResultWithImages(
        [
          `# Cell ${index} Output`,
          result.executionOrder ? `Execution #${result.executionOrder}` : "",
          "",
          formatOutputsAsMarkdown(outputs)
        ].join("\n"),
        outputs
      );
    }
  );

  server.tool(
    "notebook_insert_cell",
    "Insert a new cell (code or markdown). Optionally execute it immediately.",
    InsertCellInput,
    async ({ content, type, index, language, execute, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const notebook = access.notebook!;
      const cellId = generateCellId();
      const kind =
        type === "code"
          ? vscode.NotebookCellKind.Code
          : vscode.NotebookCellKind.Markup;
      const cellData = new vscode.NotebookCellData(
        kind,
        content,
        type === "code" ? language : "markdown"
      );
      cellData.metadata = { id: cellId };

      const insertIndex =
        index !== undefined ? Math.min(index, notebook.cellCount) : notebook.cellCount;
      await insertCells(notebook.uri, insertIndex, [cellData]);

      const inserted = notebook.getCells().find((c) => c.metadata?.id === cellId);
      if (!inserted) return ErrorResult("Error: failed to locate inserted cell.");

      const cellIndex = inserted.index;

      if (access.editor) {
        access.editor.revealRange(
          new vscode.NotebookRange(cellIndex, cellIndex + 1),
          vscode.NotebookEditorRevealType.InCenter
        );
      }

      let execution: {
        success: boolean;
        executionOrder: number | null;
        outputs: CellOutput[];
        error?: string;
      } | null = null;

      if (execute && type === "code") {
        try {
          await vscode.commands.executeCommand("notebook.cell.execute", {
            ranges: [{ start: cellIndex, end: cellIndex + 1 }],
            document: notebook.uri
          });
          const executed = await waitForCellExecution(notebook, cellId);
          execution = {
            success: executed.executionSummary?.success ?? false,
            executionOrder: executed.executionSummary?.executionOrder ?? null,
            outputs: await parseOutputs(executed.outputs)
          };
        } catch (err) {
          execution = {
            success: false,
            executionOrder: null,
            outputs: [],
            error: err instanceof Error ? err.message : String(err)
          };
        }
      }

      const result = {
        cellIndex,
        type,
        language: type === "code" ? language : "markdown",
        executed: !!execute && type === "code",
        execution
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }

      const lines = [
        `# Cell Inserted`,
        "",
        `**Index**: ${cellIndex}`,
        `**Type**: ${type}/${result.language}`
      ];
      if (result.executed && execution) {
        lines.push("");
        if (execution.error) {
          lines.push(`**Execution**: Failed - ${execution.error}`);
        } else {
          lines.push(
            `**Execution**: ${execution.success ? "Success" : "Failed"}${execution.executionOrder ? ` (#${execution.executionOrder})` : ""}`
          );
          if (execution.outputs.length > 0) {
            lines.push("", "## Output", formatOutputsAsMarkdown(execution.outputs));
          }
        }
      }
      return ResultWithImages(
        lines.join("\n"),
        execution?.outputs ?? []
      );
    }
  );

  server.tool(
    "notebook_edit_cell",
    "Replace the contents of an existing cell.",
    EditCellInput,
    async ({ index, content, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const notebook = access.notebook!;
      if (index >= notebook.cellCount) {
        return ErrorResult(
          `Error: Cell index ${index} out of range (0-${notebook.cellCount - 1}).`
        );
      }

      await editCellContent(notebook.cellAt(index), content);

      if (response_format === "json") {
        return TextResult(JSON.stringify({ index, updated: true }, null, 2));
      }
      return TextResult(`Updated cell ${index}`);
    }
  );

  server.tool(
    "notebook_delete_cell",
    "Delete a cell by index.",
    CellTargetInput,
    async ({ index, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const notebook = access.notebook!;
      if (index >= notebook.cellCount) {
        return ErrorResult(
          `Error: Cell index ${index} out of range (0-${notebook.cellCount - 1}).`
        );
      }

      await deleteCells(notebook.uri, index, 1);

      if (response_format === "json") {
        return TextResult(
          JSON.stringify(
            { deletedIndex: index, newCellCount: notebook.cellCount },
            null,
            2
          )
        );
      }
      return TextResult(
        `Deleted cell ${index}. New cell count: ${notebook.cellCount}`
      );
    }
  );

  server.tool(
    "notebook_run_cell",
    "Execute an existing code cell by index and return its outputs. The cell and its output persist in the notebook.",
    CellTargetInput,
    async ({ index, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const notebook = access.notebook!;
      if (index >= notebook.cellCount) {
        return ErrorResult(
          `Error: Cell index ${index} out of range (0-${notebook.cellCount - 1}).`
        );
      }

      const cell = notebook.cellAt(index);
      if (cell.kind !== vscode.NotebookCellKind.Code) {
        return ErrorResult(
          `Error: Cell ${index} is markdown. Only code cells can be executed.`
        );
      }

      if (access.editor) {
        access.editor.revealRange(
          new vscode.NotebookRange(index, index + 1),
          vscode.NotebookEditorRevealType.InCenter
        );
      }

      let executed: vscode.NotebookCell;
      try {
        if (!isCellExecuting(cell)) {
          await vscode.commands.executeCommand("notebook.cell.execute", {
            ranges: [{ start: index, end: index + 1 }],
            document: notebook.uri
          });
        }
        executed = await waitForCellExecutionByIndex(notebook, index);
      } catch (err) {
        return ErrorResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const outputs = await parseOutputs(executed.outputs);
      const result = {
        success: executed.executionSummary?.success ?? false,
        cellIndex: index,
        executionOrder: executed.executionSummary?.executionOrder ?? null,
        outputs
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      const lines = [
        `# Cell ${index} Execution Result`,
        "",
        `**Status**: ${result.success ? "Success" : "Failed"}${result.executionOrder ? ` (execution #${result.executionOrder})` : ""}`,
        "",
        "## Output",
        formatOutputsAsMarkdown(outputs)
      ];
      return ResultWithImages(lines.join("\n"), outputs);
    }
  );

  server.tool(
    "notebook_clear_cell_output",
    "Clear the outputs of a single cell.",
    CellTargetInput,
    async ({ index, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const notebook = access.notebook!;
      if (index >= notebook.cellCount) {
        return ErrorResult(
          `Error: Cell index ${index} out of range (0-${notebook.cellCount - 1}).`
        );
      }

      await vscode.commands.executeCommand("notebook.cell.clearOutputs", {
        ranges: [{ start: index, end: index + 1 }],
        document: notebook.uri
      });

      if (response_format === "json") {
        return TextResult(JSON.stringify({ index, cleared: true }, null, 2));
      }
      return TextResult(`Cleared outputs for cell ${index}`);
    }
  );

  server.tool(
    "notebook_clear_all_outputs",
    "Clear outputs from every cell in the notebook.",
    ClearAllInput,
    async ({ notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);

      const notebook = access.notebook!;
      const ranges = [{ start: 0, end: notebook.cellCount }];
      await vscode.commands.executeCommand("notebook.cell.clearOutputs", {
        ranges,
        document: notebook.uri
      });

      if (response_format === "json") {
        return TextResult(
          JSON.stringify(
            { cleared: true, cellCount: notebook.cellCount },
            null,
            2
          )
        );
      }
      return TextResult(
        `Cleared outputs from all ${notebook.cellCount} cells`
      );
    }
  );
}
