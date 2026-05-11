import * as assert from "assert";
import * as vscode from "vscode";
import {
  TestMcpClient,
  callTool,
  createTestMcpClient
} from "./mcpClient";
import { closeAllEditors, copyFixtureToTmp } from "./helpers";

async function openFixture(
  mcp: TestMcpClient,
  name: string
): Promise<string> {
  const tmpPath = copyFixtureToTmp(name);
  const open = await callTool(mcp.client, "notebook_open", {
    path: tmpPath,
    show: true,
    response_format: "json"
  });
  assert.strictEqual(open.isError, false, open.text);
  return JSON.parse(open.text).uri as string;
}

suite("cell tools (no execution)", () => {
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

  test("notebook_list_cells returns the fixture's three cells", async () => {
    const uri = await openFixture(mcp, "with-cells.ipynb");
    const result = await callTool(mcp.client, "notebook_list_cells", {
      notebook_uri: uri,
      response_format: "json"
    });
    const parsed = JSON.parse(result.text);
    assert.strictEqual(parsed.total, 3);
    assert.strictEqual(parsed.cells[0].kind, "markdown");
    assert.strictEqual(parsed.cells[1].kind, "code");
    assert.strictEqual(parsed.cells[1].language, "python");
  });

  test("notebook_get_cell_content returns the source", async () => {
    const uri = await openFixture(mcp, "with-cells.ipynb");
    const result = await callTool(mcp.client, "notebook_get_cell_content", {
      notebook_uri: uri,
      index: 1,
      response_format: "json"
    });
    const parsed = JSON.parse(result.text);
    assert.strictEqual(parsed.kind, "code");
    assert.match(parsed.content, /x = 21 \+ 21/);
  });

  test("notebook_get_cell_content errors on out-of-range index", async () => {
    const uri = await openFixture(mcp, "with-cells.ipynb");
    const result = await callTool(mcp.client, "notebook_get_cell_content", {
      notebook_uri: uri,
      index: 99
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.text, /out of range/);
  });

  test("notebook_insert_cell appends a new cell at the end by default", async () => {
    const uri = await openFixture(mcp, "with-cells.ipynb");
    const result = await callTool(mcp.client, "notebook_insert_cell", {
      notebook_uri: uri,
      content: "z = 99",
      type: "code",
      response_format: "json"
    });
    const parsed = JSON.parse(result.text);
    assert.strictEqual(parsed.cellIndex, 3);
    assert.strictEqual(parsed.executed, false);

    const list = await callTool(mcp.client, "notebook_list_cells", {
      notebook_uri: uri,
      response_format: "json"
    });
    assert.strictEqual(JSON.parse(list.text).total, 4);
  });

  test("notebook_insert_cell honors explicit index", async () => {
    const uri = await openFixture(mcp, "with-cells.ipynb");
    const result = await callTool(mcp.client, "notebook_insert_cell", {
      notebook_uri: uri,
      content: "# inserted",
      type: "markdown",
      index: 0,
      response_format: "json"
    });
    const parsed = JSON.parse(result.text);
    assert.strictEqual(parsed.cellIndex, 0);

    const first = await callTool(mcp.client, "notebook_get_cell_content", {
      notebook_uri: uri,
      index: 0,
      response_format: "json"
    });
    const firstParsed = JSON.parse(first.text);
    assert.strictEqual(firstParsed.kind, "markdown");
    assert.match(firstParsed.content, /^# inserted/);
  });

  test("notebook_edit_cell replaces source", async () => {
    const uri = await openFixture(mcp, "with-cells.ipynb");
    const edit = await callTool(mcp.client, "notebook_edit_cell", {
      notebook_uri: uri,
      index: 1,
      content: "x = 7\nprint(x)",
      response_format: "json"
    });
    assert.strictEqual(edit.isError, false, edit.text);

    const get = await callTool(mcp.client, "notebook_get_cell_content", {
      notebook_uri: uri,
      index: 1,
      response_format: "json"
    });
    assert.strictEqual(JSON.parse(get.text).content, "x = 7\nprint(x)");
  });

  test("notebook_delete_cell removes a cell", async () => {
    const uri = await openFixture(mcp, "with-cells.ipynb");
    const del = await callTool(mcp.client, "notebook_delete_cell", {
      notebook_uri: uri,
      index: 0,
      response_format: "json"
    });
    assert.strictEqual(del.isError, false);
    assert.strictEqual(JSON.parse(del.text).newCellCount, 2);
  });

  test("notebook_clear_all_outputs reports the cell count", async () => {
    const uri = await openFixture(mcp, "with-cells.ipynb");
    const clear = await callTool(mcp.client, "notebook_clear_all_outputs", {
      notebook_uri: uri,
      response_format: "json"
    });
    assert.strictEqual(clear.isError, false);
    assert.strictEqual(JSON.parse(clear.text).cellCount, 3);
  });

  test("active-editor fallback: tools work without notebook_uri", async () => {
    const uri = await openFixture(mcp, "with-cells.ipynb");
    // Make sure the just-opened notebook is the active editor.
    const doc = vscode.workspace.notebookDocuments.find(
      (d) => d.uri.toString() === uri
    );
    assert.ok(doc, "notebook document not found");
    await vscode.window.showNotebookDocument(doc!);

    const result = await callTool(mcp.client, "notebook_list_cells", {
      response_format: "json"
    });
    assert.strictEqual(result.isError, false, result.text);
    assert.strictEqual(JSON.parse(result.text).total, 3);
  });

  test("no-active-editor: tools error helpfully when no notebook is open", async () => {
    await closeAllEditors();
    const result = await callTool(mcp.client, "notebook_list_cells", {
      response_format: "json"
    });
    assert.strictEqual(result.isError, true);
    assert.match(result.text, /No active notebook/);
  });
});
