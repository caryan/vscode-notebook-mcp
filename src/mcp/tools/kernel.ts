import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ResponseFormatSchema,
  NotebookUriSchema
} from "../../schemas/index.js";
import { resolveNotebook } from "../../utils/notebook.js";

const TextResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }] });

const ErrorResult = (text: string) =>
  ({ content: [{ type: "text" as const, text }], isError: true });

const JUPYTER_EXTENSION_ID = "ms-toolsai.jupyter";

let jupyterApi: any | undefined;

async function getJupyterApi(): Promise<any> {
  if (jupyterApi) return jupyterApi;
  const ext = vscode.extensions.getExtension(JUPYTER_EXTENSION_ID);
  if (!ext) {
    throw new Error(
      `Jupyter extension (${JUPYTER_EXTENSION_ID}) is not installed.`
    );
  }
  jupyterApi = await ext.activate();
  return jupyterApi;
}

const KernelInfoInput = {
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const SelectKernelInput = {
  kernel_id: z
    .string()
    .optional()
    .describe(
      "Kernel controller id (e.g. 'python3' or a Jupyter kernelspec id). If omitted, opens the kernel picker UI."
    ),
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

export function registerKernelTools(server: McpServer): void {
  server.tool(
    "notebook_get_kernel_info",
    "Get the active notebook's kernel: language, status, and notebook URI.",
    KernelInfoInput,
    async ({ notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;

      let kernel: any;
      try {
        const api = await getJupyterApi();
        kernel = await api?.kernels?.getKernel?.(notebook.uri);
      } catch (err) {
        return ErrorResult(
          `Error: cannot reach Jupyter extension. ${err instanceof Error ? err.message : String(err)}`
        );
      }

      if (!kernel) {
        const result = {
          connected: false,
          notebookUri: notebook.uri.toString()
        };
        if (response_format === "json") {
          return TextResult(JSON.stringify(result, null, 2));
        }
        return TextResult(
          `# Kernel Info\n\nNo kernel connected for ${notebook.uri.toString()}.\n\nUse notebook_select_kernel to attach one.`
        );
      }

      const result = {
        connected: true,
        language: kernel.language ?? "unknown",
        status: kernel.status ?? "unknown",
        notebookUri: notebook.uri.toString()
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      return TextResult(
        [
          `# Kernel Info`,
          `- **Language**: ${result.language}`,
          `- **Status**: ${result.status}`,
          `- **Notebook**: ${result.notebookUri}`
        ].join("\n")
      );
    }
  );

  server.tool(
    "notebook_select_kernel",
    "Select a kernel for a notebook. With kernel_id, attempts to set it directly; without, opens the VS Code kernel picker for the user.",
    SelectKernelInput,
    async ({ kernel_id, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;

      try {
        if (kernel_id) {
          await vscode.commands.executeCommand("notebook.selectKernel", {
            notebookEditor: { notebookUri: notebook.uri },
            id: kernel_id,
            extension: JUPYTER_EXTENSION_ID
          });
        } else {
          await vscode.commands.executeCommand("notebook.selectKernel", {
            notebookEditor: { notebookUri: notebook.uri }
          });
        }
      } catch (err) {
        return ErrorResult(
          `Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      let confirmed: any;
      try {
        const api = await getJupyterApi();
        confirmed = await api?.kernels?.getKernel?.(notebook.uri);
      } catch {
        // best-effort confirmation only
      }

      const result = {
        notebookUri: notebook.uri.toString(),
        requested: kernel_id ?? null,
        mode: kernel_id ? "programmatic" : "picker",
        connected: !!confirmed,
        language: confirmed?.language ?? null,
        status: confirmed?.status ?? null
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      const lines = [`# Kernel Selection`, ""];
      if (kernel_id) {
        lines.push(`Attempted to select **${kernel_id}**.`);
      } else {
        lines.push(`Opened the kernel picker for the user.`);
      }
      lines.push(
        result.connected
          ? `Currently connected: ${result.language} (${result.status})`
          : `No kernel currently reported as connected (the picker may still be open).`
      );
      return TextResult(lines.join("\n"));
    }
  );
}
