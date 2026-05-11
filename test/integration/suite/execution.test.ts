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

async function openWithKernel(
  mcp: TestMcpClient,
  fixture: string
): Promise<string> {
  const tmpPath = copyFixtureToTmp(fixture);
  const open = await callTool(mcp.client, "notebook_open", {
    path: tmpPath,
    show: true,
    response_format: "json"
  });
  assert.strictEqual(open.isError, false, open.text);
  const uri = JSON.parse(open.text).uri as string;
  await selectVenvKernel(vscode.Uri.parse(uri));
  return uri;
}

suite("cell execution", () => {
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

  test("notebook_run_cell executes a code cell and captures stdout", async () => {
    const uri = await openWithKernel(mcp, "with-cells.ipynb");
    const result = await callTool(mcp.client, "notebook_run_cell", {
      notebook_uri: uri,
      index: 1,
      response_format: "json"
    });
    assert.strictEqual(result.isError, false, result.text);
    const parsed = JSON.parse(result.text);
    assert.strictEqual(parsed.success, true);
    assert.ok(
      parsed.outputs.some(
        (o: { type: string; text?: string }) =>
          o.type === "text" && (o.text ?? "").includes("42")
      ),
      `expected stdout to contain "42", got ${JSON.stringify(parsed.outputs)}`
    );
  });

  test("notebook_run_cell rejects markdown cells", async () => {
    const uri = await openWithKernel(mcp, "with-cells.ipynb");
    const result = await callTool(mcp.client, "notebook_run_cell", {
      notebook_uri: uri,
      index: 0,
      response_format: "json"
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.text, /markdown/i);
  });

  test("notebook_insert_cell with execute=true returns the new cell's output", async () => {
    const uri = await openWithKernel(mcp, "empty.ipynb");
    const result = await callTool(mcp.client, "notebook_insert_cell", {
      notebook_uri: uri,
      content: "print('hello-from-test')",
      type: "code",
      execute: true,
      response_format: "json"
    });
    assert.strictEqual(result.isError, false, result.text);
    const parsed = JSON.parse(result.text);
    assert.strictEqual(parsed.executed, true);
    assert.strictEqual(parsed.execution.success, true);
    const text = parsed.execution.outputs
      .filter((o: { type: string }) => o.type === "text")
      .map((o: { text: string }) => o.text)
      .join("");
    assert.match(text, /hello-from-test/);
  });

  test("notebook_run_cell surfaces python errors", async () => {
    const uri = await openWithKernel(mcp, "empty.ipynb");
    await callTool(mcp.client, "notebook_insert_cell", {
      notebook_uri: uri,
      content: "raise ValueError('boom')",
      type: "code"
    });
    const result = await callTool(mcp.client, "notebook_run_cell", {
      notebook_uri: uri,
      index: 0,
      response_format: "json"
    });
    const parsed = JSON.parse(result.text);
    assert.strictEqual(parsed.success, false);
    const errorOutput = parsed.outputs.find(
      (o: { type: string }) => o.type === "error"
    );
    assert.ok(errorOutput, "expected an error output");
    assert.strictEqual(errorOutput.name, "ValueError");
    assert.match(errorOutput.message, /boom/);
  });

  test("matplotlib figure produces an image output", async () => {
    const uri = await openWithKernel(mcp, "empty.ipynb");
    const result = await callTool(mcp.client, "notebook_insert_cell", {
      notebook_uri: uri,
      // %matplotlib inline forces ipykernel to embed figures as PNG outputs;
      // without it the kernel returns the figure repr as plain text.
      content:
        "%matplotlib inline\nimport matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([1,2,3],[4,5,6])\nfig",
      type: "code",
      execute: true,
      response_format: "json"
    });
    assert.strictEqual(result.isError, false, result.text);
    const parsed = JSON.parse(result.text);
    assert.strictEqual(parsed.execution.success, true, JSON.stringify(parsed));
    const image = parsed.execution.outputs.find(
      (o: { type: string }) => o.type === "image"
    );
    assert.ok(image, `expected an image output, got ${JSON.stringify(parsed.execution.outputs)}`);
    assert.match(image.mimeType, /^image\//);
    assert.ok(image.data.length > 100, "image data looks too small");
  });

  test("matplotlib image surfaces as MCP image content block in markdown mode", async () => {
    const uri = await openWithKernel(mcp, "empty.ipynb");
    const result = await callTool(mcp.client, "notebook_insert_cell", {
      notebook_uri: uri,
      content:
        "%matplotlib inline\nimport matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nax.plot([1,2,3],[4,5,6])\nfig",
      type: "code",
      execute: true
      // default response_format is "markdown" → image arrives as a separate
      // MCP image content block, not embedded in the JSON text payload.
    });
    assert.strictEqual(result.isError, false, result.text);
    assert.ok(
      result.imageCount >= 1,
      "expected at least one image content block in the MCP response"
    );
  });

  test("inserting cells while another cell is executing does not lose track of the inserted cell", async () => {
    const uri = await openWithKernel(mcp, "empty.ipynb");

    // Kick off a slow execution; do NOT await its completion before inserting.
    const slowInsert = callTool(mcp.client, "notebook_insert_cell", {
      notebook_uri: uri,
      content: "import time\ntime.sleep(2)\nprint('slow done')",
      type: "code",
      execute: true,
      response_format: "json"
    });

    // While the above is mid-flight, insert and execute a fast cell at index 0,
    // which shifts the slow cell's index.
    // Tiny delay so the slow cell starts executing first.
    await new Promise((r) => setTimeout(r, 200));
    const fastResult = await callTool(mcp.client, "notebook_insert_cell", {
      notebook_uri: uri,
      content: "print('fast')",
      type: "code",
      index: 0,
      execute: true,
      response_format: "json"
    });

    const slowResult = await slowInsert;

    const slow = JSON.parse(slowResult.text);
    const fast = JSON.parse(fastResult.text);

    assert.strictEqual(slow.execution.success, true, slowResult.text);
    assert.strictEqual(fast.execution.success, true, fastResult.text);
    assert.match(
      slow.execution.outputs
        .filter((o: { type: string }) => o.type === "text")
        .map((o: { text: string }) => o.text)
        .join(""),
      /slow done/
    );
  });
});
