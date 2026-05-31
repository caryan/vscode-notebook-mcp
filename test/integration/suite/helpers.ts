import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { controllerIdForInterpreter } from "../../../src/utils/kernel.js";

// __dirname after compile is out/test/integration/suite — go up four levels to repo root.
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const FIXTURES = path.join(REPO_ROOT, "test/fixtures/workspace/notebooks");

export function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

export function copyFixtureToTmp(name: string): string {
  const src = fixturePath(name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nbmcp-test-"));
  const dest = path.join(tmp, name);
  fs.copyFileSync(src, dest);
  return dest;
}

export async function closeAllEditors(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

export async function ensureJupyterActivated(): Promise<void> {
  const ext = vscode.extensions.getExtension("ms-toolsai.jupyter");
  if (!ext) {
    throw new Error("ms-toolsai.jupyter is not installed in this VS Code");
  }
  if (!ext.isActive) {
    await ext.activate();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const VENV_PYTHON = path.join(
  REPO_ROOT,
  "test/fixtures/python/.venv/bin/python"
);

/**
 * Wait until the Jupyter extension reports a connected kernel for the notebook.
 * Polled rather than event-driven because the extension's public API has no
 * "kernel attached" event — only `kernels.getKernel(uri)`.
 */
export async function waitForKernel(
  notebookUri: vscode.Uri,
  timeoutMs = 60_000
): Promise<unknown> {
  await ensureJupyterActivated();
  const api = await vscode.extensions
    .getExtension("ms-toolsai.jupyter")!
    .activate();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const kernel = await api?.kernels?.getKernel?.(notebookUri);
    if (kernel) return kernel;
    await sleep(500);
  }
  throw new Error(
    `Kernel for ${notebookUri.toString()} did not attach within ${timeoutMs}ms.`
  );
}

/**
 * Programmatically attach the test venv as the notebook's controller.
 *
 * The Jupyter extension exposes no public API to assign a kernel; we invoke
 * `notebook.selectKernel` with the controller `id` it would have used. That
 * id is derived (private internal contract) from the interpreter's normalized
 * path. See the upstream `getKernelId` / `getInterpreterKernelSpecName` in
 * microsoft/vscode-jupyter:
 *   https://github.com/microsoft/vscode-jupyter/blob/main/src/kernels/helpers.ts
 *
 * Selecting a controller does NOT start a kernel session — Jupyter starts the
 * kernel lazily on first execution. So `kernels.getKernel(uri)` will return
 * undefined until something actually runs. Callers that need a live kernel
 * should call `startKernel()` afterward to force a session.
 *
 * If the Jupyter extension changes the controller-id format, this breaks and
 * needs updating; the failure mode is informative because VS Code logs
 * "wanted kernel DOES NOT EXIST, wanted: <id>, all: <ids>".
 */
export async function selectVenvKernel(
  notebookUri: vscode.Uri,
  pythonPath = VENV_PYTHON
): Promise<void> {
  await ensureJupyterActivated();
  await registerVenvWithPythonExt(pythonPath);

  const id = controllerIdForInterpreter(pythonPath);

  await vscode.commands.executeCommand("notebook.selectKernel", {
    notebookEditor: { notebookUri },
    id,
    extension: "ms-toolsai.jupyter"
  });

  // Give the controller binding a moment to register before tests run cells.
  await sleep(250);
}

/**
 * Force a kernel session to start by running an inserted no-op cell, then
 * delete the cell. Use this from tests that need `kernels.getKernel(uri)` to
 * return a started kernel (e.g. `notebook_get_kernel_info` correctness).
 */
export async function startKernel(notebookUri: vscode.Uri): Promise<void> {
  const notebook = vscode.workspace.notebookDocuments.find(
    (d) => d.uri.toString() === notebookUri.toString()
  );
  if (!notebook) throw new Error(`notebook not open: ${notebookUri.toString()}`);

  const insertAt = notebook.cellCount;
  const cell = new vscode.NotebookCellData(
    vscode.NotebookCellKind.Code,
    "1",
    "python"
  );
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [vscode.NotebookEdit.insertCells(insertAt, [cell])]);
  await vscode.workspace.applyEdit(edit);

  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: insertAt, end: insertAt + 1 }],
    document: notebook.uri
  });

  // Wait for the kernel to be reachable via the public Jupyter API.
  await waitForKernel(notebookUri, 30_000);

  // Clean up the bootstrap cell.
  const cleanup = new vscode.WorkspaceEdit();
  cleanup.set(notebook.uri, [
    vscode.NotebookEdit.deleteCells(
      new vscode.NotebookRange(insertAt, insertAt + 1)
    )
  ]);
  await vscode.workspace.applyEdit(cleanup);
}

/**
 * Make sure the Python extension knows about the venv and treats it as the
 * active interpreter for the workspace. Without this step the Jupyter
 * extension never creates a NotebookController for the venv, so
 * `notebook.selectKernel` with any id we construct can't bind to anything.
 */
async function registerVenvWithPythonExt(pythonPath: string): Promise<void> {
  const ext = vscode.extensions.getExtension("ms-python.python");
  if (!ext) {
    throw new Error(
      "ms-python.python extension is not installed in the test VS Code"
    );
  }
  if (!ext.isActive) {
    await ext.activate();
  }
  const api = ext.exports as {
    environments?: {
      updateActiveEnvironmentPath?: (
        path: string,
        scope?: vscode.WorkspaceFolder
      ) => Promise<void>;
      resolveEnvironment?: (
        path: string
      ) => Promise<unknown>;
      known?: { path: string }[];
      refreshEnvironments?: () => Promise<void>;
    };
  };
  if (!api.environments) {
    return;
  }
  try {
    await api.environments.refreshEnvironments?.();
  } catch {
    // best effort
  }
  try {
    await api.environments.resolveEnvironment?.(pythonPath);
  } catch {
    // best effort
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  await api.environments.updateActiveEnvironmentPath?.(pythonPath, folder);
  // eslint-disable-next-line no-console
  console.error(
    `[registerVenvWithPythonExt] active interpreter set to ${pythonPath}`
  );
}
