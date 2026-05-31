import * as vscode from "vscode";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ResponseFormatSchema,
  NotebookUriSchema
} from "../../schemas/index.js";
import { resolveNotebook } from "../../utils/notebook.js";
import {
  controllerIdForInterpreter,
  selectKernelById
} from "../../utils/kernel.js";
import { registerInterpreter } from "../../utils/pythonEnv.js";

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

/**
 * Wait for an in-flight kernel restart to finish.
 *
 * `jupyter.restartkernel` kicks the restart off fire-and-forget — its handler
 * (`restartKernelImpl` in vscode-jupyter) calls `wrapKernelMethod("restart")`
 * without awaiting it, so `executeCommand` resolves while the old kernel is
 * still alive. Returning then would let the caller's next execution race the
 * not-yet-restarted session and see stale state. We watch the kernel's public
 * status instead: a restart drives it out of "idle" (restarting/starting/busy)
 * and back to "idle"; "dead" means the restart failed. Subscribe BEFORE issuing
 * the command so no transition is missed (status changes are events, not polled).
 *
 * Two bounds keep this from hanging: if the restart never *starts* within
 * `startGraceMs` we stop waiting (the environment may not surface the transition
 * — e.g. the headless test host doesn't honor the command at all — or the
 * restart finished too fast to observe); once it has started we allow up to
 * `totalTimeoutMs` for it to settle back to idle.
 */
function waitForKernelRestart(
  kernel: any,
  startGraceMs = 5_000,
  totalTimeoutMs = 60_000
): Promise<string> {
  return new Promise<string>((resolve) => {
    if (typeof kernel?.onDidChangeStatus !== "function") {
      resolve(kernel?.status ?? "unknown");
      return;
    }
    let started = false;
    let settled = false;
    const finish = (status: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(graceTimer);
      clearTimeout(totalTimer);
      try {
        sub?.dispose?.();
      } catch {
        // disposing the listener is best-effort
      }
      resolve(status);
    };
    const onStatus = () => {
      const s = kernel?.status;
      if (
        s === "restarting" ||
        s === "autorestarting" ||
        s === "starting" ||
        s === "busy"
      ) {
        // The restart is underway — stop the start grace and wait for idle.
        started = true;
        clearTimeout(graceTimer);
      } else if (s === "dead") {
        finish(s);
      } else if (s === "idle" && started) {
        finish(s);
      }
    };
    const sub = kernel.onDidChangeStatus(onStatus);
    const graceTimer = setTimeout(
      () => finish(kernel?.status ?? "unknown"),
      startGraceMs
    );
    const totalTimer = setTimeout(
      () => finish(kernel?.status ?? "unknown"),
      totalTimeoutMs
    );
  });
}

const KernelInfoInput = {
  notebook_uri: NotebookUriSchema,
  response_format: ResponseFormatSchema
};

const RestartKernelInput = {
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
        // Make the Python extension aware of the interpreter first, so a venv
        // the user has never selected in VS Code still gets a controller to
        // bind to. Best effort: if it fails we still try to select by id.
        if (python_path) {
          try {
            await registerInterpreter(python_path);
          } catch (err) {
            console.error(
              `[notebook_select_kernel] could not register interpreter ${python_path}: ${
                err instanceof Error ? err.message : String(err)
              }`
            );
          }
        }

        if (effectiveKernelId) {
          // When we just registered a fresh interpreter, the controller may
          // appear a beat after selection — retry so the bind isn't lost.
          await selectKernelById(
            notebook.uri,
            effectiveKernelId,
            python_path ? 10 : 1
          );
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

  server.tool(
    "notebook_restart_kernel",
    "Restart the active notebook's kernel, clearing all in-memory state (variables, imports) while leaving cell outputs untouched. The kernel must already be connected — use notebook_select_kernel first if not.",
    RestartKernelInput,
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
        return ErrorResult(
          `Error: no kernel connected for ${notebook.uri.toString()}. Use notebook_select_kernel to attach one before restarting.`
        );
      }

      let finalStatus: string;
      try {
        // Subscribe to the kernel's status BEFORE issuing the command so the
        // restart transitions aren't missed, then block until the restart
        // actually completes (the command itself returns early — see
        // waitForKernelRestart).
        const restartDone = waitForKernelRestart(kernel);
        await vscode.commands.executeCommand("jupyter.restartkernel", {
          notebookEditor: { notebookUri: notebook.uri }
        });
        finalStatus = await restartDone;
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
        restarted: true,
        connected: !!confirmed,
        language: confirmed?.language ?? null,
        status: confirmed?.status ?? finalStatus ?? null
      };

      if (response_format === "json") {
        return TextResult(JSON.stringify(result, null, 2));
      }
      return TextResult(
        [
          `# Kernel Restart`,
          ``,
          `Restarted the kernel for ${result.notebookUri}.`,
          result.connected
            ? `Currently connected: ${result.language} (${result.status})`
            : `No kernel currently reported as connected.`
        ].join("\n")
      );
    }
  );
}
