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
  selectVenvKernel
} from "./helpers";

suite("plotly rendering", () => {
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

  // Skipped for now: the extension's `initPlotlyRenderer` runs in the bundled
  // dist/extension.js module instance, while the test's in-memory MCP server
  // imports plotly.ts from out/src/... — different module instances, so the
  // extensionUri the renderer needs isn't visible from the test server.
  // Fixing this requires either a) hitting the extension's HTTP server
  // directly so the same module instance handles the request, or b) sharing
  // state via a globalThis key. Re-enable once one of those is in place.
  test.skip("plotly figure is rendered to a PNG image content block", async () => {
    const tmpPath = copyFixtureToTmp("empty.ipynb");
    const open = await callTool(mcp.client, "notebook_open", {
      path: tmpPath,
      show: true,
      response_format: "json"
    });
    const uri = JSON.parse(open.text).uri as string;
    await selectVenvKernel(vscode.Uri.parse(uri));

    const code = [
      "import plotly.graph_objects as go",
      "fig = go.Figure(data=[go.Scatter(x=[1, 2, 3], y=[4, 5, 6])])",
      "fig"
    ].join("\n");

    const result = await callTool(mcp.client, "notebook_insert_cell", {
      notebook_uri: uri,
      content: code,
      type: "code",
      execute: true,
      response_format: "json"
    });

    assert.strictEqual(result.isError, false, result.text);
    const parsed = JSON.parse(result.text);
    assert.strictEqual(parsed.execution.success, true, result.text);

    const image = parsed.execution.outputs.find(
      (o: { type: string }) => o.type === "image"
    );
    assert.ok(
      image,
      `expected an image output from the plotly figure, got ${JSON.stringify(
        parsed.execution.outputs
      )}`
    );
    assert.strictEqual(image.mimeType, "image/png");
    assert.ok(image.data.length > 1000, "rendered PNG looks too small");
    assert.ok(
      result.imageCount >= 1,
      "MCP response should include the rendered image as a content block"
    );
  });
});
