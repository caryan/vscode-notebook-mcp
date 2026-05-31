import * as crypto from "crypto";
import * as vscode from "vscode";

const JUPYTER_EXTENSION_ID = "ms-toolsai.jupyter";

/**
 * Normalize an interpreter path the way the Jupyter extension does before it
 * builds a controller id. For venv-style paths the "/bin" segment is dropped
 * while the "python" filename is kept:
 *   /x/y/.venv/bin/python  ->  /x/y/.venv/python
 * System interpreters like /usr/bin/python3 (<= 4 segments) are left untouched.
 *
 * Mirrors `normalizeInterpreterPath` in microsoft/vscode-jupyter. If upstream
 * changes the scheme this — and the controller ids derived from it — break.
 */
export function normalizeInterpreterPath(p: string): string {
  const parts = p.split("/");
  const last = parts[parts.length - 1] ?? "";
  const second = parts[parts.length - 2] ?? "";
  if (parts.length > 4 && last.startsWith("python") && second === "bin") {
    return [...parts.slice(0, -2), last].join("/");
  }
  return p;
}

/**
 * Compute the NotebookController id the Jupyter extension registers for a given
 * interpreter, so callers can attach a kernel by interpreter path instead of
 * hashing the id themselves. Format (derived empirically from the ids Jupyter
 * registers — see the VS Code log "wanted kernel ... all: ..."):
 *   .jvsc74a57bd0<sha256(normPath)>.<normPath>.<normPath>.-m#ipykernel_launcher
 * The Python version does not appear in the id for interpreter-backed kernels.
 */
export function controllerIdForInterpreter(pythonPath: string): string {
  const normalized = normalizeInterpreterPath(pythonPath);
  const sha = crypto.createHash("sha256").update(normalized).digest("hex");
  return `.jvsc74a57bd0${sha}.${normalized}.${normalized}.-m#ipykernel_launcher`;
}

/**
 * Bind a controller to a notebook via the `notebook.selectKernel` command,
 * retrying because the command silently no-ops when the controller doesn't
 * exist yet. For a freshly registered interpreter the Jupyter extension creates
 * the controller a beat after the interpreter becomes known, so a single select
 * can fire too early and never bind — leaving the next cell execution to pop the
 * kernel picker. Re-issuing the select on an interval guarantees one attempt
 * lands once the controller is live.
 */
export async function selectKernelById(
  notebookUri: vscode.Uri,
  kernelId: string,
  attempts = 1,
  intervalMs = 600
): Promise<void> {
  for (let i = 0; i < Math.max(1, attempts); i++) {
    await vscode.commands.executeCommand("notebook.selectKernel", {
      notebookEditor: { notebookUri },
      id: kernelId,
      extension: JUPYTER_EXTENSION_ID
    });
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
