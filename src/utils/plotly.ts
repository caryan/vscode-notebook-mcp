import * as vscode from "vscode";

const PLOTLY_MIME_PREFIX = "application/vnd.plotly.v1+json";
const VIEW_ID = "notebook-mcp.plotlyRenderer";
const RENDER_TIMEOUT_MS = 15_000;
const RESOLVE_TIMEOUT_MS = 5_000;
const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 500;

export interface PlotlyFigure {
  data: unknown[];
  layout?: { width?: number; height?: number; [key: string]: unknown };
  [key: string]: unknown;
}

let extensionUri: vscode.Uri | undefined;
let view: vscode.WebviewView | undefined;
let viewReady: Promise<void> | undefined;
const pending = new Map<
  string,
  { resolve: (b64: string) => void; reject: (err: Error) => void }
>();

class PlotlyRendererProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(webviewView: vscode.WebviewView): void {
    view = webviewView;

    const distUri = vscode.Uri.joinPath(extensionUri!, "dist");
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [distUri]
    };

    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    viewReady = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    webviewView.webview.onDidReceiveMessage((msg: unknown) => {
      if (!msg || typeof msg !== "object") return;
      const m = msg as Record<string, unknown>;
      if (m.type === "ready") {
        resolveReady();
        return;
      }
      if (typeof m.id !== "string") return;
      const entry = pending.get(m.id);
      if (!entry) return;
      pending.delete(m.id);
      if (m.type === "rendered" && typeof m.dataUrl === "string") {
        entry.resolve(stripDataUrlPrefix(m.dataUrl));
      } else if (m.type === "error") {
        entry.reject(
          new Error(typeof m.message === "string" ? m.message : "Plotly render error")
        );
      }
    });

    webviewView.onDidDispose(() => {
      view = undefined;
      viewReady = undefined;
      rejectReady(new Error("Plotly renderer view was disposed"));
      for (const { reject } of pending.values()) {
        reject(new Error("Plotly renderer view was disposed"));
      }
      pending.clear();
    });

    const plotlyJsUri = webviewView.webview.asWebviewUri(
      vscode.Uri.joinPath(distUri, "plotly.min.js")
    );
    webviewView.webview.html = renderHtml(
      plotlyJsUri.toString(),
      webviewView.webview.cspSource
    );
  }
}

export function initPlotlyRenderer(context: vscode.ExtensionContext): void {
  extensionUri = context.extensionUri;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      VIEW_ID,
      new PlotlyRendererProvider(),
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
}

export function isPlotlyMime(mime: string): boolean {
  return mime.startsWith(PLOTLY_MIME_PREFIX);
}

export async function renderPlotlyToPng(figure: PlotlyFigure): Promise<string> {
  if (!extensionUri) {
    throw new Error("Plotly renderer not initialized");
  }
  const v = await ensureView();
  const id = randomId();
  const width =
    typeof figure.layout?.width === "number" ? figure.layout.width : DEFAULT_WIDTH;
  const height =
    typeof figure.layout?.height === "number"
      ? figure.layout.height
      : DEFAULT_HEIGHT;

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        reject(new Error(`Plotly render timed out after ${RENDER_TIMEOUT_MS}ms`));
      }
    }, RENDER_TIMEOUT_MS);
    pending.set(id, {
      resolve: (b64) => { clearTimeout(timer); resolve(b64); },
      reject: (err) => { clearTimeout(timer); reject(err); }
    });
    v.webview.postMessage({
      type: "render",
      id,
      figure: { data: figure.data, layout: figure.layout ?? {} },
      width,
      height
    });
  });
}

async function ensureView(): Promise<vscode.WebviewView> {
  if (view && viewReady) {
    await viewReady;
    return view;
  }

  // resolveWebviewView only fires when the view becomes visible, so reveal once.
  await vscode.commands.executeCommand(`${VIEW_ID}.focus`);

  const start = Date.now();
  while (!view || !viewReady) {
    if (Date.now() - start > RESOLVE_TIMEOUT_MS) {
      throw new Error("Plotly renderer view failed to resolve");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  await viewReady;

  // Hide the panel area; the webview persists thanks to retainContextWhenHidden.
  vscode.commands.executeCommand("workbench.action.closePanel").then(
    undefined,
    () => undefined
  );

  return view;
}

function renderHtml(plotlyJsUri: string, cspSource: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${cspSource} 'unsafe-inline' 'unsafe-eval'; style-src ${cspSource} 'unsafe-inline'; img-src ${cspSource} data: blob:; font-src ${cspSource} data:; connect-src 'none';" />
    <style>
      html, body { margin: 0; padding: 0; background: white; }
      #graph { width: ${DEFAULT_WIDTH}px; height: ${DEFAULT_HEIGHT}px; }
    </style>
  </head>
  <body>
    <div id="graph"></div>
    <script src="${plotlyJsUri}"></script>
    <script>
      const vscode = acquireVsCodeApi();
      const div = document.getElementById('graph');
      window.addEventListener('message', async (event) => {
        const msg = event.data;
        if (!msg || msg.type !== 'render') return;
        try {
          div.style.width = msg.width + 'px';
          div.style.height = msg.height + 'px';
          const layout = Object.assign({}, msg.figure.layout, { width: msg.width, height: msg.height });
          await Plotly.newPlot(div, msg.figure.data, layout, { staticPlot: true, displayModeBar: false });
          const dataUrl = await Plotly.toImage(div, { format: 'png', width: msg.width, height: msg.height });
          vscode.postMessage({ type: 'rendered', id: msg.id, dataUrl });
        } catch (err) {
          vscode.postMessage({ type: 'error', id: msg.id, message: (err && err.message) ? err.message : String(err) });
        } finally {
          try { Plotly.purge(div); } catch (_) {}
        }
      });
      vscode.postMessage({ type: 'ready' });
    </script>
  </body>
</html>`;
}

function stripDataUrlPrefix(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.substring(idx + 1) : dataUrl;
}

function randomId(): string {
  return Math.random().toString(36).substring(2, 15);
}
