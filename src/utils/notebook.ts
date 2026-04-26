import * as vscode from "vscode";

export interface NotebookAccessResult {
  allowed: boolean;
  notebook?: vscode.NotebookDocument;
  editor?: vscode.NotebookEditor;
  error?: string;
}

export async function resolveNotebook(
  notebookUri?: string
): Promise<NotebookAccessResult> {
  if (notebookUri) {
    const uri = vscode.Uri.parse(notebookUri);
    const notebook =
      vscode.workspace.notebookDocuments.find(
        (doc) => doc.uri.toString() === uri.toString()
      ) ??
      (await tryOpenNotebook(uri));

    if (!notebook) {
      return {
        allowed: false,
        error: `Notebook not found: ${notebookUri}. Use notebook_list_open to see available notebooks.`
      };
    }
    return {
      allowed: true,
      notebook,
      editor: findVisibleEditor(notebook)
    };
  }

  const editor = vscode.window.activeNotebookEditor;
  if (!editor) {
    return {
      allowed: false,
      error:
        "No active notebook. Open a .ipynb file first, or pass notebook_uri."
    };
  }
  return { allowed: true, notebook: editor.notebook, editor };
}

async function tryOpenNotebook(
  uri: vscode.Uri
): Promise<vscode.NotebookDocument | undefined> {
  try {
    return await vscode.workspace.openNotebookDocument(uri);
  } catch {
    return undefined;
  }
}

function findVisibleEditor(
  notebook: vscode.NotebookDocument
): vscode.NotebookEditor | undefined {
  return vscode.window.visibleNotebookEditors.find(
    (e) => e.notebook.uri.toString() === notebook.uri.toString()
  );
}

export async function insertCells(
  uri: vscode.Uri,
  index: number,
  cells: vscode.NotebookCellData[]
): Promise<void> {
  const edit = vscode.NotebookEdit.insertCells(index, cells);
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(uri, [edit]);
  await vscode.workspace.applyEdit(workspaceEdit);
}

export async function deleteCells(
  uri: vscode.Uri,
  index: number,
  count: number
): Promise<void> {
  const edit = vscode.NotebookEdit.deleteCells(
    new vscode.NotebookRange(index, index + count)
  );
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(uri, [edit]);
  await vscode.workspace.applyEdit(workspaceEdit);
}

export async function editCellContent(
  cell: vscode.NotebookCell,
  newContent: string
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(0, 0, cell.document.lineCount, 0);
  edit.replace(cell.document.uri, fullRange, newContent);
  await vscode.workspace.applyEdit(edit);
}

export function generateCellId(): string {
  return Math.random().toString(36).substring(2, 15);
}

/**
 * Wait for a cell's execution to finish. Polls executionSummary.success
 * because VS Code creates the summary as soon as execution starts but only
 * sets success to a boolean once the kernel reports completion.
 */
export async function waitForCellExecution(
  notebook: vscode.NotebookDocument,
  cellId: string,
  timeoutMs = 60_000
): Promise<vscode.NotebookCell> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const cell = notebook.getCells().find((c) => c.metadata?.id === cellId);
      if (!cell) {
        clearInterval(interval);
        reject(new Error("Cell not found (was it deleted?)"));
        return;
      }
      if (typeof cell.executionSummary?.success === "boolean") {
        clearInterval(interval);
        resolve(cell);
        return;
      }
      if (Date.now() - startTime > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Cell execution timed out after ${timeoutMs}ms`));
      }
    }, 100);
  });
}

export async function waitForCellExecutionByIndex(
  notebook: vscode.NotebookDocument,
  index: number,
  timeoutMs = 60_000
): Promise<vscode.NotebookCell> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const cell = notebook.cellAt(index);
    if (typeof cell.executionSummary?.success === "boolean") {
      return cell;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Cell execution timed out after ${timeoutMs}ms`);
}
