import * as vscode from "vscode";
import { startMCPServer, ServerHandle } from "./mcp/server.js";

let serverHandle: ServerHandle | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let lastError: string | undefined;

export async function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "notebook-mcp.showInfo";
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("notebook-mcp.restartServer", async () => {
      await stopServer();
      await startServer();
    }),
    vscode.commands.registerCommand("notebook-mcp.showInfo", () => showInfo())
  );

  await startServer();
}

export async function deactivate() {
  await stopServer();
}

async function startServer() {
  const preferredPort = vscode.workspace
    .getConfiguration("notebook-mcp")
    .get<number>("port", 49777);

  try {
    serverHandle = await startMCPServer(preferredPort);
    lastError = undefined;
    updateStatusBar();
    if (serverHandle.port !== preferredPort) {
      vscode.window.showInformationMessage(
        `Notebook MCP: port ${preferredPort} was busy, started on ${serverHandle.port} instead. Update your MCP client config: http://127.0.0.1:${serverHandle.port}/mcp`
      );
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
    serverHandle = undefined;
    updateStatusBar();
    vscode.window.showErrorMessage(`Notebook MCP: ${lastError}`);
  }
}

async function stopServer() {
  if (serverHandle) {
    await serverHandle.stop();
    serverHandle = undefined;
    updateStatusBar();
  }
}

function updateStatusBar() {
  if (!statusBarItem) return;
  if (serverHandle) {
    statusBarItem.text = `🪐 :${serverHandle.port}`;
    statusBarItem.tooltip = `Notebook MCP\nhttp://127.0.0.1:${serverHandle.port}/mcp\n\nClick for info`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `🪐 ✗`;
    statusBarItem.tooltip = `Notebook MCP: not running\n${lastError ?? ""}\n\nClick for info`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.errorBackground"
    );
  }
  statusBarItem.show();
}

async function showInfo() {
  if (serverHandle) {
    const url = `http://127.0.0.1:${serverHandle.port}/mcp`;
    const choice = await vscode.window.showInformationMessage(
      `Notebook MCP running at ${url}`,
      "Copy URL",
      "Restart"
    );
    if (choice === "Copy URL") {
      await vscode.env.clipboard.writeText(url);
    } else if (choice === "Restart") {
      await vscode.commands.executeCommand("notebook-mcp.restartServer");
    }
  } else {
    const choice = await vscode.window.showErrorMessage(
      `Notebook MCP not running: ${lastError ?? "unknown error"}`,
      "Restart"
    );
    if (choice === "Restart") {
      await vscode.commands.executeCommand("notebook-mcp.restartServer");
    }
  }
}
