import * as vscode from "vscode";

const PYTHON_EXTENSION_ID = "ms-python.python";

interface PythonEnvironmentsApi {
  updateActiveEnvironmentPath?: (
    path: string,
    scope?: vscode.WorkspaceFolder
  ) => Promise<void>;
  resolveEnvironment?: (path: string) => Promise<unknown>;
  refreshEnvironments?: () => Promise<void>;
  known?: { path: string }[];
}

/**
 * Make the Python extension aware of an interpreter so the Jupyter extension
 * will create a NotebookController for it. Without this, a brand-new venv the
 * user has never selected in VS Code has no controller, so
 * `notebook.selectKernel` with its computed id silently no-ops and no kernel
 * can attach.
 *
 * This is the programmatic equivalent of "Python: Select Interpreter → Enter
 * interpreter path…": refresh discovery, resolve the path, and set it active
 * for the workspace. We then wait (best effort) for the interpreter to appear
 * in the Python extension's known list before returning, since Jupyter creates
 * the controller off the back of that discovery. The controller itself lands a
 * little later still, so callers select with a retry (see selectKernelById).
 *
 * Throws only if the Python extension itself is unavailable; everything else is
 * best effort so callers can still fall back to selecting by id.
 */
export async function registerInterpreter(pythonPath: string): Promise<void> {
  const ext = vscode.extensions.getExtension(PYTHON_EXTENSION_ID);
  if (!ext) {
    throw new Error(
      `Python extension (${PYTHON_EXTENSION_ID}) is not installed; cannot register ${pythonPath}.`
    );
  }
  if (!ext.isActive) {
    await ext.activate();
  }
  const environments = (
    ext.exports as { environments?: PythonEnvironmentsApi }
  ).environments;
  if (!environments) {
    return;
  }

  try {
    await environments.refreshEnvironments?.();
  } catch {
    // best effort — discovery may already be warm
  }
  try {
    await environments.resolveEnvironment?.(pythonPath);
  } catch {
    // best effort — resolution can fail for paths it doesn't recognize yet
  }
  const folder = vscode.workspace.workspaceFolders?.[0];
  await environments.updateActiveEnvironmentPath?.(pythonPath, folder);

  // Give the Jupyter extension a moment to turn the now-known interpreter into
  // a controller before the caller selects it.
  await waitForKnownInterpreter(environments, pythonPath, 10_000);
}

async function waitForKnownInterpreter(
  environments: PythonEnvironmentsApi,
  pythonPath: string,
  timeoutMs: number
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (environments.known?.some((e) => e.path === pythonPath)) {
      return;
    }
    await sleep(200);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
