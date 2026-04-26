import * as vscode from "vscode";

const CHARACTER_LIMIT = 25_000;

const ERROR_MIME = vscode.NotebookCellOutputItem.error(new Error("")).mime;

export interface TextOutput {
  type: "text";
  text: string;
}

export interface ErrorOutput {
  type: "error";
  name: string;
  message: string;
  stack: string;
}

export interface ImageOutput {
  type: "image";
  data: string;
  mimeType: string;
}

export type CellOutput = TextOutput | ErrorOutput | ImageOutput;

export function parseOutputs(
  outputs: readonly vscode.NotebookCellOutput[]
): CellOutput[] {
  const decoder = new TextDecoder();
  const results: CellOutput[] = [];

  for (const output of outputs) {
    for (const item of output.items) {
      if (item.mime === ERROR_MIME) {
        try {
          const error = JSON.parse(decoder.decode(item.data));
          results.push({
            type: "error",
            name: error.name ?? "Error",
            message: error.message ?? "Unknown error",
            stack: error.stack ?? ""
          });
        } catch {
          results.push({ type: "text", text: decoder.decode(item.data) });
        }
      } else if (item.mime.startsWith("image/")) {
        const base64 = Buffer.from(item.data).toString("base64");
        results.push({ type: "image", data: base64, mimeType: item.mime });
      } else {
        let text = decoder.decode(item.data);
        if (text.length > CHARACTER_LIMIT) {
          text =
            text.substring(0, CHARACTER_LIMIT) +
            `\n\n[Output truncated. Total length: ${text.length} characters]`;
        }
        results.push({ type: "text", text });
      }
    }
  }

  return results;
}

export function formatOutputsAsMarkdown(outputs: CellOutput[]): string {
  const lines: string[] = [];
  for (const output of outputs) {
    if (output.type === "text") {
      lines.push("```", output.text, "```");
    } else if (output.type === "error") {
      lines.push(`**Error**: ${output.name}: ${output.message}`);
      if (output.stack) {
        lines.push("```", output.stack, "```");
      }
    } else {
      lines.push(`[Image output: ${output.mimeType}]`);
    }
  }
  return lines.join("\n");
}
