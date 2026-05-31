import * as assert from "assert";
import * as path from "path";
import * as vscode from "vscode";
import {
  TestMcpClient,
  callTool,
  createTestMcpClient
} from "./mcpClient";
import {
  REPO_ROOT,
  closeAllEditors,
  copyFixtureToTmp,
  ensureJupyterActivated,
  selectVenvKernel,
  startKernel
} from "./helpers";

// A venv that nothing else in the suite registers with the Python extension.
// Pointing notebook_select_kernel at it exercises the tool's own interpreter
// registration — without this the Jupyter extension never creates a controller
// for the env and the kernel can't attach.
const UNREGISTERED_VENV_PYTHON = path.join(
  REPO_ROOT,
  "test/fixtures/python-unregistered/.venv/bin/python"
);

suite("kernel tools", () => {
  let mcp: TestMcpClient;

  suiteSetup(async () => {
    await ensureJupyterActivated();
    mcp = await createTestMcpClient();
  });

  suiteTeardown(async () => {
    await mcp.dispose();
  });

  setup(async () => {
    await closeAllEditors();
  });

  test("notebook_get_kernel_info reports the attached kernel", async () => {
    const tmpPath = copyFixtureToTmp("with-cells.ipynb");
    const open = await callTool(mcp.client, "notebook_open", {
      path: tmpPath,
      show: true,
      response_format: "json"
    });
    const uri = JSON.parse(open.text).uri as string;
    await selectVenvKernel(vscode.Uri.parse(uri));
    await startKernel(vscode.Uri.parse(uri));

    const info = await callTool(mcp.client, "notebook_get_kernel_info", {
      notebook_uri: uri,
      response_format: "json"
    });
    assert.strictEqual(info.isError, false, info.text);
    const parsed = JSON.parse(info.text);
    assert.strictEqual(parsed.connected, true);
    assert.strictEqual(parsed.language, "python");
  });

  // NOTE on coverage: we deliberately do NOT assert that the restart wiped the
  // kernel's in-memory state here. The headless @vscode/test-electron host does
  // not honor `jupyter.restartkernel` against the live ipykernel session — the
  // command dispatches without error but the kernel never actually restarts
  // (verified empirically: variables survive and the execution count keeps
  // climbing, with no "restarting" status transition ever emitted). Real
  // state-wipe is exercised by the manual SOP in CLAUDE.md (row 20), which runs
  // against the real Jupyter UI command path in the dev host. This test pins the
  // tool's wiring: notebook resolution, kernel detection, command dispatch, the
  // bounded restart wait, and the response shape.
  test("notebook_restart_kernel issues a restart against a connected kernel", async () => {
    const tmpPath = copyFixtureToTmp("empty.ipynb");
    const open = await callTool(mcp.client, "notebook_open", {
      path: tmpPath,
      show: true,
      response_format: "json"
    });
    const uri = JSON.parse(open.text).uri as string;
    await selectVenvKernel(vscode.Uri.parse(uri));
    await startKernel(vscode.Uri.parse(uri));

    const restart = await callTool(mcp.client, "notebook_restart_kernel", {
      notebook_uri: uri,
      response_format: "json"
    });
    assert.strictEqual(restart.isError, false, restart.text);
    const parsed = JSON.parse(restart.text);
    assert.strictEqual(parsed.restarted, true, restart.text);
    assert.strictEqual(parsed.connected, true, restart.text);
    assert.strictEqual(parsed.language, "python", restart.text);

    // The kernel must remain usable afterward (whether or not the harness truly
    // restarted it, the tool must leave a working session attached).
    const after = await callTool(mcp.client, "notebook_insert_cell", {
      notebook_uri: uri,
      content: "print(2 + 2)",
      type: "code",
      execute: true,
      response_format: "json"
    });
    assert.strictEqual(after.isError, false, after.text);
    assert.strictEqual(JSON.parse(after.text).execution.success, true, after.text);
  });

  test("notebook_restart_kernel errors when no kernel is connected", async () => {
    const tmpPath = copyFixtureToTmp("with-cells.ipynb");
    const open = await callTool(mcp.client, "notebook_open", {
      path: tmpPath,
      show: true,
      response_format: "json"
    });
    const uri = JSON.parse(open.text).uri as string;

    // No kernel selected/started: the tool should refuse rather than throw.
    const restart = await callTool(mcp.client, "notebook_restart_kernel", {
      notebook_uri: uri,
      response_format: "json"
    });
    assert.strictEqual(restart.isError, true, restart.text);
    assert.match(restart.text, /no kernel connected/i);
  });

  test("notebook_select_kernel registers an unknown interpreter by python_path", async () => {
    const tmpPath = copyFixtureToTmp("with-cells.ipynb");
    const open = await callTool(mcp.client, "notebook_open", {
      path: tmpPath,
      show: true,
      response_format: "json"
    });
    const uri = JSON.parse(open.text).uri as string;

    // The whole point: only the tool touches the Python extension here. No
    // selectVenvKernel / registerVenvWithPythonExt priming for this venv.
    const sel = await callTool(mcp.client, "notebook_select_kernel", {
      notebook_uri: uri,
      python_path: UNREGISTERED_VENV_PYTHON,
      response_format: "json"
    });
    assert.strictEqual(sel.isError, false, sel.text);

    await startKernel(vscode.Uri.parse(uri));

    const info = await callTool(mcp.client, "notebook_get_kernel_info", {
      notebook_uri: uri,
      response_format: "json"
    });
    assert.strictEqual(info.isError, false, info.text);
    const parsed = JSON.parse(info.text);
    assert.strictEqual(parsed.connected, true, info.text);
    assert.strictEqual(parsed.language, "python");
  });
});
