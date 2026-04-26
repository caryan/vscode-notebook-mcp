import * as http from "http";
import * as crypto from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools } from "./tools/index.js";

const PORT_SCAN_RANGE = 100;

export interface ServerHandle {
  port: number;
  stop: () => Promise<void>;
}

export async function startMCPServer(preferredPort: number): Promise<ServerHandle> {
  const port = await findFreePort(preferredPort, preferredPort + PORT_SCAN_RANGE);

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();

  const createMcpServer = (): McpServer => {
    const mcp = new McpServer({
      name: "vscode-notebook-mcp",
      version: "0.1.0"
    });
    registerAllTools(mcp);
    return mcp;
  };

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ status: "ok", server: "vscode-notebook-mcp", port })
      );
      return;
    }

    if (req.url === "/mcp" || req.url?.startsWith("/mcp?")) {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      try {
        if (sessionId && transports.has(sessionId)) {
          await transports.get(sessionId)!.handleRequest(req, res);
          return;
        }
        if (req.method === "POST") {
          const newSessionId = crypto.randomUUID();
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            enableJsonResponse: true
          });
          const mcp = createMcpServer();
          transports.set(newSessionId, transport);
          servers.set(newSessionId, mcp);
          transport.onclose = () => {
            transports.delete(newSessionId);
            servers.delete(newSessionId);
          };
          await mcp.connect(transport);
          await transport.handleRequest(req, res);
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing session ID" }));
      } catch (err) {
        console.error("MCP request error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  console.log(`Notebook MCP: listening on http://127.0.0.1:${port}/mcp`);

  return {
    port,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const t of transports.values()) {
          t.close();
        }
        transports.clear();
        servers.clear();
        httpServer.close(() => resolve());
      })
  };
}

async function findFreePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(
    `No free port found in range ${start}-${end}. Configure notebook-mcp.port to a different value.`
  );
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = http.createServer();
    tester.once("error", () => resolve(false));
    tester.listen(port, "127.0.0.1", () => {
      tester.close(() => resolve(true));
    });
  });
}
