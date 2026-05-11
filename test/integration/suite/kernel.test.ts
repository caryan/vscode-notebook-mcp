import * as assert from "assert";
import * as vscode from "vscode";
import {
  TestMcpClient,
  callTool,
  createTestMcpClient
} from "./mcpClient";
import {
  closeAllEditors,
  copyFixtureToTmp,
  ensureJupyterActivated,
  selectVenvKernel,
  startKernel
} from "./helpers";

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
});
