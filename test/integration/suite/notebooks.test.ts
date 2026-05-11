import * as assert from "assert";
import * as vscode from "vscode";
import {
  TestMcpClient,
  callTool,
  createTestMcpClient
} from "./mcpClient";
import { closeAllEditors, copyFixtureToTmp } from "./helpers";

suite("notebook discovery tools", () => {
  let mcp: TestMcpClient;

  suiteSetup(async () => {
    mcp = await createTestMcpClient();
  });

  suiteTeardown(async () => {
    await mcp.dispose();
  });

  setup(async () => {
    await closeAllEditors();
  });

  test("notebook_list_open returns a notebooks array", async () => {
    // We don't assert length 0: VS Code keeps NotebookDocuments alive in
    // workspace.notebookDocuments after their editor closes, so other suites
    // running before this one leave entries behind. The contract we care
    // about is just "the response is well-formed".
    const result = await callTool(mcp.client, "notebook_list_open", {
      response_format: "json"
    });
    assert.strictEqual(result.isError, false);
    const parsed = JSON.parse(result.text);
    assert.ok(Array.isArray(parsed.notebooks));
  });

  test("notebook_open opens a file by absolute path", async () => {
    const tmpPath = copyFixtureToTmp("with-cells.ipynb");
    const result = await callTool(mcp.client, "notebook_open", {
      path: tmpPath,
      show: true,
      response_format: "json"
    });
    assert.strictEqual(result.isError, false, result.text);
    const parsed = JSON.parse(result.text);
    assert.strictEqual(parsed.cellCount, 3);
    assert.strictEqual(parsed.shown, true);
    assert.match(parsed.uri, /with-cells\.ipynb$/);
  });

  test("notebook_open accepts a file:// URI", async () => {
    const tmpPath = copyFixtureToTmp("empty.ipynb");
    const fileUri = vscode.Uri.file(tmpPath).toString();
    const result = await callTool(mcp.client, "notebook_open", {
      path: fileUri,
      show: false,
      response_format: "json"
    });
    assert.strictEqual(result.isError, false, result.text);
    const parsed = JSON.parse(result.text);
    assert.strictEqual(parsed.cellCount, 0);
    assert.strictEqual(parsed.shown, false);
  });

  test("notebook_list_open includes a freshly opened notebook", async () => {
    const tmpPath = copyFixtureToTmp("with-cells.ipynb");
    const open = await callTool(mcp.client, "notebook_open", {
      path: tmpPath,
      show: true,
      response_format: "json"
    });
    const expectedUri = JSON.parse(open.text).uri as string;
    const result = await callTool(mcp.client, "notebook_list_open", {
      response_format: "json"
    });
    const parsed = JSON.parse(result.text);
    const entry = parsed.notebooks.find(
      (n: { uri: string }) => n.uri === expectedUri
    );
    assert.ok(entry, `expected notebook ${expectedUri} in ${result.text}`);
    assert.strictEqual(entry.cellCount, 3);
    assert.strictEqual(entry.isActive, true);
  });

  test("notebook_open errors on non-existent file", async () => {
    const result = await callTool(mcp.client, "notebook_open", {
      path: "/definitely/does/not/exist.ipynb"
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.text, /failed to open notebook/i);
  });
});
