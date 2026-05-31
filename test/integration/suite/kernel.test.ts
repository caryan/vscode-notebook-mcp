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
