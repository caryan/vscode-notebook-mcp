import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ResponseFormatSchema,
  NotebookUriSchema
} from "../../schemas/index.js";
import { resolveNotebook } from "../../utils/notebook.js";
import { controllerIdForInterpreter } from "../../utils/kernel.js";

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
      "Kernel controller id (e.g. 'python3' or a Jupyter kernelspec id). Takes precedence over python_path. If both are omitted, opens the kernel picker UI."
    ),
  python_path: z
    .string()
    .optional()
    .describe(
      "Absolute path to a Python interpreter (e.g. a venv's bin/python). The matching Jupyter controller id is computed automatically — no need to hash anything. Ignored if kernel_id is given."
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
    "Select a kernel for a notebook. With kernel_id or python_path, attempts to set it directly; without either, opens the VS Code kernel picker for the user.",
    SelectKernelInput,
    async ({ kernel_id, python_path, notebook_uri, response_format }) => {
      const access = await resolveNotebook(notebook_uri);
      if (!access.allowed) return ErrorResult(`Error: ${access.error}`);
      const notebook = access.notebook!;

      // Prefer an explicit kernel_id; otherwise derive the controller id from
      // the interpreter path so callers never have to hash it themselves.
      const effectiveKernelId =
        kernel_id ??
        (python_path ? controllerIdForInterpreter(python_path) : undefined);

      try {
        if (effectiveKernelId) {
          await vscode.commands.executeCommand("notebook.selectKernel", {
            notebookEditor: { notebookUri: notebook.uri },
            id: effectiveKernelId,
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
        requested: effectiveKernelId ?? null,
        pythonPath: python_path ?? null,
        mode: effectiveKernelId ? "programmatic" : "picker",
        connected: !!confirmed,
        language: confirmed?.language ?? null,
        status: confirmed?.status ?? null
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      const lines = [`# Kernel Selection`, ""];
      if (effectiveKernelId) {
        lines.push(`Attempted to select **${effectiveKernelId}**.`);
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
