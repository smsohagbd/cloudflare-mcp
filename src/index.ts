import { handleMCPRequest } from "./mcp/handler";
import { TOOLS } from "./tools";

export interface Env {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  AI: any;
  MCP_API_KEY?: string;
  LINKEDIN_ACCESS_TOKEN?: string;
  YOUTUBE_ACCESS_TOKEN?: string;
  YOUTUBE_API_KEY?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, x-mcp-version",
        },
      });
    }

    // Public R2 Media serving endpoint: /media/<key>
    if (url.pathname.startsWith("/media/")) {
      if (!env.MEDIA_BUCKET) {
        return new Response("R2 Storage not configured", { status: 500 });
      }
      const key = decodeURIComponent(url.pathname.replace(/^\/media\//, ""));
      const object = await env.MEDIA_BUCKET.get(key);

      if (!object) {
        return new Response("File not found in R2 storage", { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cache-Control", "public, max-age=31536000, immutable");

      return new Response(object.body, { headers });
    }

    // MCP Streamable HTTP JSON-RPC endpoint
    if (url.pathname === "/mcp" || url.pathname === "/api/mcp") {
      return handleMCPRequest(request, env as any);
    }

    // Health check endpoint
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          server: "cloudflare-mcp",
          domain: "mcp.sohag.com.bd",
          version: "2.0.0",
          timestamp: new Date().toISOString(),
          toolsCount: TOOLS.length,
          bindings: {
            d1: !!env.DB,
            r2: !!env.MEDIA_BUCKET,
            ai: !!env.AI,
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Tools discovery endpoint
    if (url.pathname === "/tools" || url.pathname === "/api/tools") {
      return new Response(JSON.stringify({ count: TOOLS.length, tools: TOOLS }, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Server-Sent Events (SSE) Transport endpoint for legacy MCP clients
    if (url.pathname === "/sse") {
      const sessionId = crypto.randomUUID();
      const messageEndpoint = `${url.origin}/message?sessionId=${sessionId}`;

      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`event: endpoint\ndata: ${messageEndpoint}\n\n`));
          const interval = setInterval(() => {
            try {
              controller.enqueue(enc.encode(`: ping\n\n`));
            } catch {
              clearInterval(interval);
            }
          }, 15000);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Message handler for SSE session
    if (url.pathname === "/message") {
      return handleMCPRequest(request, env as any);
    }

    // Fallback: If POST to root '/', treat as MCP request
    if (request.method === "POST" && url.pathname === "/") {
      return handleMCPRequest(request, env as any);
    }

    // Landing Dashboard (GET /)
    const cf = (request as any).cf || {};
    return new Response(renderDashboard(url.origin, cf, env), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};

function renderDashboard(origin: string, cf: any, env: Env): string {
  const mcpEndpoint = `${origin}/mcp`;
  const sseEndpoint = `${origin}/sse`;

  const toolsHtml = TOOLS.map(
    (t) => `
    <div class="tool-card">
      <div class="tool-header">
        <span class="tool-name">${t.name}</span>
        <span class="badge">Tool</span>
      </div>
      <p class="tool-desc">${t.description}</p>
      <div class="tool-params">
        <strong>Parameters:</strong>
        <code>${Object.keys(t.inputSchema.properties).join(", ") || "none"}</code>
      </div>
    </div>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cloudflare MCP Agent Hub - mcp.sohag.com.bd</title>
  <style>
    :root {
      --bg: #090d16;
      --card: #131c2e;
      --card-hover: #1e293b;
      --border: #26334d;
      --accent: #f38020;
      --accent-glow: rgba(243, 128, 32, 0.2);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --green: #22c55e;
      --blue: #38bdf8;
      --purple: #a855f7;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 2.5rem 1.25rem;
    }
    .container {
      max-width: 1000px;
      margin: 0 auto;
    }
    header {
      text-align: center;
      margin-bottom: 2.5rem;
      padding-bottom: 2rem;
      border-bottom: 1px solid var(--border);
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      color: var(--green);
      padding: 0.35rem 0.9rem;
      border-radius: 9999px;
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 1rem;
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background: var(--green);
      border-radius: 50%;
      box-shadow: 0 0 8px var(--green);
    }
    h1 {
      font-size: 2.75rem;
      font-weight: 800;
      background: linear-gradient(135deg, #f38020 0%, #38bdf8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    p.lead {
      color: var(--text-muted);
      font-size: 1.15rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1.25rem;
      margin-bottom: 2rem;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
    }
    .card h2 {
      font-size: 1.25rem;
      margin-bottom: 1rem;
      color: var(--blue);
    }
    .url-box {
      background: #06090e;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-family: monospace;
      color: var(--accent);
      word-break: break-all;
      margin-bottom: 0.75rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .copy-btn {
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 6px;
      padding: 0.4rem 0.8rem;
      font-size: 0.8rem;
      font-weight: 600;
      cursor: pointer;
      margin-left: 0.5rem;
      transition: opacity 0.2s;
    }
    .copy-btn:hover { opacity: 0.85; }
    .features-list {
      list-style: none;
      font-size: 0.9rem;
      color: var(--text-muted);
    }
    .features-list li {
      margin-bottom: 0.5rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .tool-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
      gap: 1rem;
      margin-top: 1rem;
    }
    .tool-card {
      background: #0e1524;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1.2rem;
      transition: border-color 0.2s;
    }
    .tool-card:hover {
      border-color: var(--blue);
    }
    .tool-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 0.5rem;
    }
    .tool-name {
      font-weight: 700;
      color: var(--text);
      font-family: monospace;
      font-size: 0.95rem;
    }
    .badge {
      font-size: 0.7rem;
      background: var(--accent-glow);
      color: var(--accent);
      border: 1px solid var(--accent);
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      text-transform: uppercase;
      font-weight: bold;
    }
    .tool-desc {
      color: var(--text-muted);
      font-size: 0.85rem;
      margin-bottom: 0.75rem;
    }
    .tool-params {
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .tool-params code {
      background: #06090e;
      color: var(--blue);
      padding: 0.2rem 0.4rem;
      border-radius: 4px;
    }
    pre {
      background: #06090e;
      border: 1px solid var(--border);
      padding: 1rem;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 0.85rem;
      color: #e2e8f0;
      margin-top: 0.5rem;
    }
    footer {
      text-align: center;
      margin-top: 3rem;
      padding-top: 2rem;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 0.85rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="status-pill">
        <span class="pulse-dot"></span>
        MCP Agent Hub • Online & Active
      </div>
      <h1>mcp.sohag.com.bd</h1>
      <p class="lead">Universal Model Context Protocol Agent Hub for Social Automation (LinkedIn, YouTube, Facebook)</p>
    </header>

    <div class="grid">
      <div class="card">
        <h2>🔌 Connect with AI Agents (Muse AI, Cursor, etc.)</h2>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.4rem;">Streamable HTTP Endpoint (Recommended):</p>
        <div class="url-box">
          <span>${mcpEndpoint}</span>
          <button class="copy-btn" onclick="navigator.clipboard.writeText('${mcpEndpoint}')">Copy</button>
        </div>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.4rem;">SSE Endpoint:</p>
        <div class="url-box">
          <span>${sseEndpoint}</span>
          <button class="copy-btn" onclick="navigator.clipboard.writeText('${sseEndpoint}')">Copy</button>
        </div>
      </div>

      <div class="card">
        <h2>🗄️ Storage & Edge Infrastructure</h2>
        <ul class="features-list">
          <li>🗄️ <strong>Cloudflare D1:</strong> <span style="color: var(--green);">${env.DB ? "Active (cloudflare-mcp-db)" : "Pending"}</span></li>
          <li>📦 <strong>Cloudflare R2:</strong> <span style="color: var(--green);">${env.MEDIA_BUCKET ? "Active (cloudflare-mcp-media)" : "Pending"}</span></li>
          <li>🤖 <strong>Workers AI:</strong> <span style="color: var(--green);">${env.AI ? "Active (Llama 3.1 & Distill)" : "Pending"}</span></li>
          <li>📍 <strong>Edge Colo:</strong> <span style="color: var(--blue);">${cf.colo || "Global"} (${cf.country || "Edge"})</span></li>
          <li>⚡ <strong>Tools Registered:</strong> <span style="color: var(--accent); font-weight: bold;">${TOOLS.length} Active Tools</span></li>
        </ul>
      </div>
    </div>

    <div class="card" style="margin-bottom: 2rem;">
      <h2>🤖 Muse AI / AI Agent Setup</h2>
      <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.75rem;">
        In Muse AI or any MCP-compatible agent, add a custom Remote MCP tool using this endpoint:
      </p>
      <pre><code>Server URL: ${mcpEndpoint}
Transport: HTTP POST (Streamable HTTP / JSON-RPC 2.0)
Supported Actions:
- Social Publishing: linkedin_publish_post, youtube_upload_video
- Social Engagement: youtube_reply_comment, youtube_list_comments
- Database Logging: db_save_post_log, db_get_post_logs, db_get_comment_logs
- Media Storage: r2_upload_file, r2_list_files (served at /media/*)
- Diagnostics: dns_lookup, ip_lookup, fetch_web_content, ask_ai</code></pre>
    </div>

    <div class="card">
      <h2>🛠️ Registered MCP Tools (${TOOLS.length})</h2>
      <div class="tool-grid">
        ${toolsHtml}
      </div>
    </div>

    <footer>
      <p>Domain: mcp.sohag.com.bd • Built on Cloudflare Workers • Powered by Model Context Protocol</p>
    </footer>
  </div>
</body>
</html>`;
}
