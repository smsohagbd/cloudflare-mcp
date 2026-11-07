import { handleMCPRequest } from "./mcp/handler";
import { TOOLS } from "./tools";

export interface Env {
  DB: D1Database;
  MEDIA_BUCKET: R2Bucket;
  AI: any;
  ADMIN_USER?: string;
  ADMIN_PASS?: string;
  JWT_SECRET?: string;
  MCP_API_KEY?: string;
  LINKEDIN_ACCESS_TOKEN?: string;
  YOUTUBE_ACCESS_TOKEN?: string;
  YOUTUBE_API_KEY?: string;
}

const DEFAULT_SECRET = "smsohag-cloudflare-mcp-secret-2026-auth";

async function createToken(username: string, secret: string): Promise<string> {
  const expiry = Date.now() + 14 * 24 * 60 * 60 * 1000; // 14 days
  const data = `${username}:${expiry}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const sigHex = Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${data}:${sigHex}`;
}

async function verifyToken(token: string, secret: string): Promise<boolean> {
  try {
    const parts = token.split(":");
    if (parts.length !== 3) return false;
    const [username, expiryStr, sigHex] = parts;
    if (Date.now() > Number(expiryStr)) return false;
    const data = `${username}:${expiryStr}`;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const match = sigHex.match(/.{1,2}/g);
    if (!match) return false;
    const sigBytes = new Uint8Array(match.map((byte) => parseInt(byte, 16)));
    return await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(data));
  } catch {
    return false;
  }
}

function extractToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/mcp_session=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-mcp-version",
    };

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
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

    // Auth endpoint: POST /api/login
    if (url.pathname === "/api/login" && request.method === "POST") {
      let body: any = {};
      try { body = await request.json(); } catch {}
      const targetUser = env.ADMIN_USER || "smsohag";
      const targetPass = env.ADMIN_PASS || "SOhag@#";

      if (body.username === targetUser && body.password === targetPass) {
        const secret = env.JWT_SECRET || DEFAULT_SECRET;
        const token = await createToken(body.username, secret);
        return new Response(JSON.stringify({ success: true, user: body.username, token }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": `mcp_session=${encodeURIComponent(token)}; Path=/; Max-Age=1209600; SameSite=Lax; Secure`,
            ...corsHeaders,
          },
        });
      }

      return new Response(JSON.stringify({ success: false, error: "Invalid username or password" }), {
        status: 401,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Auth endpoint: POST /api/logout
    if (url.pathname === "/api/logout" && request.method === "POST") {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Set-Cookie": "mcp_session=; Path=/; Max-Age=0; SameSite=Lax; Secure",
          ...corsHeaders,
        },
      });
    }

    // Auth check: GET /api/admin/check
    if (url.pathname === "/api/admin/check") {
      const token = extractToken(request);
      const secret = env.JWT_SECRET || DEFAULT_SECRET;
      const isValid = token ? await verifyToken(token, secret) : false;
      return new Response(JSON.stringify({ authenticated: isValid, user: isValid ? "smsohag" : null }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Live Admin Logs endpoint: GET /api/admin/logs
    if (url.pathname === "/api/admin/logs") {
      const token = extractToken(request);
      const secret = env.JWT_SECRET || DEFAULT_SECRET;
      const isValid = token ? await verifyToken(token, secret) : false;

      if (!isValid) {
        return new Response(JSON.stringify({ error: "Unauthorized. Please log in." }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let posts: any[] = [];
      let comments: any[] = [];
      let credentials: any[] = [];
      let media: any[] = [];
      let stats = { totalPosts: 0, published: 0, failed: 0, pending: 0, totalComments: 0, totalMedia: 0 };

      if (env.DB) {
        try {
          const postRows = await env.DB.prepare("SELECT * FROM post_logs ORDER BY id DESC LIMIT 50").all();
          posts = postRows.results || [];

          const commentRows = await env.DB.prepare("SELECT * FROM comments_log ORDER BY id DESC LIMIT 50").all();
          comments = commentRows.results || [];

          const credRows = await env.DB.prepare("SELECT platform, token_type, expires_at, updated_at FROM social_credentials").all();
          credentials = credRows.results || [];

          // Compute stats
          stats.totalPosts = posts.length;
          stats.published = posts.filter((p: any) => p.status === "published").length;
          stats.failed = posts.filter((p: any) => p.status === "failed").length;
          stats.pending = posts.filter((p: any) => p.status === "pending_approval" || p.status === "draft").length;
          stats.totalComments = comments.length;
        } catch {}
      }

      if (env.MEDIA_BUCKET) {
        try {
          const r2List = await env.MEDIA_BUCKET.list({ limit: 30 });
          media = (r2List.objects || []).map((o: any) => ({
            key: o.key,
            size: o.size,
            uploaded: o.uploaded,
            url: `${url.origin}/media/${o.key}`,
          }));
          stats.totalMedia = media.length;
        } catch {}
      }

      return new Response(
        JSON.stringify({
          success: true,
          stats,
          posts,
          comments,
          media,
          credentials,
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
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
          version: "2.1.0",
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
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // Tools discovery endpoint
    if (url.pathname === "/tools" || url.pathname === "/api/tools") {
      return new Response(JSON.stringify({ count: TOOLS.length, tools: TOOLS }, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // SSE endpoint
    if (url.pathname === "/sse") {
      const sessionId = crypto.randomUUID();
      const messageEndpoint = `${url.origin}/message?sessionId=${sessionId}`;

      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          controller.enqueue(enc.encode(`event: endpoint\ndata: ${messageEndpoint}\n\n`));
          const interval = setInterval(() => {
            try { controller.enqueue(enc.encode(`: ping\n\n`)); } catch { clearInterval(interval); }
          }, 15000);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          ...corsHeaders,
        },
      });
    }

    if (url.pathname === "/message") {
      return handleMCPRequest(request, env as any);
    }

    if (request.method === "POST" && url.pathname === "/") {
      return handleMCPRequest(request, env as any);
    }

    // Landing Dashboard (GET /)
    const cf = (request as any).cf || {};
    return new Response(renderDashboard(url.origin, cf, env), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...corsHeaders,
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
      --card-hover: #1c283f;
      --border: #26334d;
      --accent: #f38020;
      --accent-glow: rgba(243, 128, 32, 0.2);
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --green: #22c55e;
      --blue: #38bdf8;
      --purple: #a855f7;
      --red: #ef4444;
      --yellow: #eab308;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      padding: 1.5rem 1rem 3rem;
    }
    .container { max-width: 1100px; margin: 0 auto; }
    
    /* Top Navigation bar */
    .nav-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 0.75rem 1.25rem;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 2rem;
    }
    .nav-brand {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      font-weight: 700;
      font-size: 1.1rem;
      color: var(--text);
    }
    .nav-brand span { color: var(--accent); }
    .nav-actions { display: flex; align-items: center; gap: 0.75rem; }

    .btn {
      padding: 0.5rem 1rem;
      border-radius: 8px;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
    }
    .btn-primary { background: var(--accent); color: white; }
    .btn-primary:hover { opacity: 0.9; }
    .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
    .btn-outline:hover { background: var(--card-hover); border-color: var(--blue); }
    .btn-danger { background: rgba(239, 68, 68, 0.2); color: var(--red); border: 1px solid var(--red); }
    .btn-danger:hover { background: var(--red); color: white; }
    .btn-sm { padding: 0.35rem 0.7rem; font-size: 0.8rem; }

    /* Header */
    header { text-align: center; margin-bottom: 2.5rem; }
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
      width: 8px; height: 8px; background: var(--green);
      border-radius: 50%; box-shadow: 0 0 8px var(--green);
    }
    h1 {
      font-size: 2.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, #f38020 0%, #38bdf8 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      margin-bottom: 0.5rem;
    }
    p.lead { color: var(--text-muted); font-size: 1.1rem; }

    /* Grid & Cards */
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.25rem; margin-bottom: 2rem; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .card h2 { font-size: 1.25rem; margin-bottom: 1rem; color: var(--blue); display: flex; align-items: center; gap: 0.5rem; }
    
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
      background: var(--accent); color: white; border: none;
      border-radius: 6px; padding: 0.4rem 0.8rem; font-size: 0.8rem;
      font-weight: 600; cursor: pointer; margin-left: 0.5rem;
    }
    .copy-btn:hover { opacity: 0.85; }

    /* Admin Live Console Section */
    #admin-panel { display: none; }
    .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .stat-box {
      background: #0d1424;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem;
      text-align: center;
    }
    .stat-number { font-size: 1.8rem; font-weight: 800; color: var(--blue); }
    .stat-label { font-size: 0.8rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }

    .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; flex-wrap: wrap; }
    .tab-btn {
      background: transparent; border: none; color: var(--text-muted);
      padding: 0.5rem 1rem; font-size: 0.9rem; font-weight: 600; cursor: pointer;
      border-radius: 6px;
    }
    .tab-btn.active { background: var(--border); color: var(--text); }

    .table-container { overflow-x: auto; max-height: 450px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.85rem; text-align: left; }
    th { background: #080d17; padding: 0.75rem; border-bottom: 1px solid var(--border); color: var(--text-muted); position: sticky; top: 0; }
    td { padding: 0.75rem; border-bottom: 1px solid var(--border); vertical-align: middle; }
    tr:hover { background: rgba(255,255,255,0.02); }

    .badge-status {
      display: inline-block; padding: 0.2rem 0.5rem; border-radius: 4px;
      font-size: 0.75rem; font-weight: 700; text-transform: uppercase;
    }
    .badge-published { background: rgba(34, 197, 94, 0.2); color: var(--green); border: 1px solid var(--green); }
    .badge-failed { background: rgba(239, 68, 68, 0.2); color: var(--red); border: 1px solid var(--red); }
    .badge-pending { background: rgba(234, 179, 8, 0.2); color: var(--yellow); border: 1px solid var(--yellow); }

    .tool-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .tool-card { background: #0e1524; border: 1px solid var(--border); border-radius: 10px; padding: 1.2rem; }
    .tool-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
    .tool-name { font-weight: 700; color: var(--text); font-family: monospace; }
    .badge { font-size: 0.7rem; background: var(--accent-glow); color: var(--accent); border: 1px solid var(--accent); padding: 0.15rem 0.5rem; border-radius: 4px; font-weight: bold; }
    .tool-desc { color: var(--text-muted); font-size: 0.85rem; margin-bottom: 0.75rem; }
    .tool-params { font-size: 0.8rem; color: var(--text-muted); }
    .tool-params code { background: #06090e; color: var(--blue); padding: 0.2rem 0.4rem; border-radius: 4px; }

    /* Modal for Login */
    .modal-overlay {
      display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7);
      backdrop-filter: blur(4px); justify-content: center; align-items: center; z-index: 1000;
    }
    .modal {
      background: var(--card); border: 1px solid var(--border); border-radius: 12px;
      width: 100%; max-width: 380px; padding: 2rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    }
    .modal h3 { font-size: 1.3rem; margin-bottom: 1rem; text-align: center; color: var(--accent); }
    .form-group { margin-bottom: 1.2rem; }
    .form-group label { display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.4rem; }
    .form-control {
      width: 100%; padding: 0.65rem 0.9rem; background: #080d18; border: 1px solid var(--border);
      border-radius: 8px; color: var(--text); font-size: 0.9rem; outline: none;
    }
    .form-control:focus { border-color: var(--accent); }
    .error-msg { color: var(--red); font-size: 0.8rem; margin-top: 0.5rem; display: none; }

    pre { background: #06090e; border: 1px solid var(--border); padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; color: #e2e8f0; }
    footer { text-align: center; margin-top: 3rem; color: var(--text-muted); font-size: 0.85rem; }
  </style>
</head>
<body>
  <div class="container">
    <!-- Top Navigation -->
    <div class="nav-bar">
      <div class="nav-brand">
        <span>⚡</span> Cloudflare MCP Agent Hub
      </div>
      <div class="nav-actions">
        <div id="auth-logged-out">
          <button class="btn btn-primary btn-sm" onclick="openLoginModal()">🔒 Admin Login</button>
        </div>
        <div id="auth-logged-in" style="display: none; align-items: center; gap: 0.75rem;">
          <span style="font-size: 0.85rem; color: var(--green);">👤 <strong id="admin-username-display">smsohag</strong></span>
          <button class="btn btn-outline btn-sm" onclick="refreshAdminLogs()">🔄 Refresh</button>
          <button class="btn btn-danger btn-sm" onclick="logoutAdmin()">🚪 Logout</button>
        </div>
      </div>
    </div>

    <!-- Header -->
    <header>
      <div class="status-pill">
        <span class="pulse-dot"></span>
        MCP Agent Hub Active & Healthy
      </div>
      <h1>mcp.sohag.com.bd</h1>
      <p class="lead">Universal Model Context Protocol server for Social Automation (LinkedIn, YouTube, Facebook)</p>
    </header>

    <!-- LIVE ADMIN CONSOLE (Shown after Login) -->
    <div id="admin-panel">
      <div class="card" style="border-color: var(--accent);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.25rem;">
          <h2>📊 Live Control Console & Activity Logs</h2>
          <div style="display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem;">
            <label style="cursor: pointer; display: flex; align-items: center; gap: 0.35rem; color: var(--text-muted);">
              <input type="checkbox" id="auto-refresh-toggle" onchange="toggleAutoRefresh(this.checked)" checked>
              Auto-refresh (5s)
            </label>
            <span id="last-updated" style="color: var(--text-muted); font-size: 0.75rem;"></span>
          </div>
        </div>

        <!-- Stats Counter Row -->
        <div class="stats-row">
          <div class="stat-box">
            <div class="stat-number" id="stat-total-posts">0</div>
            <div class="stat-label">Total Posts</div>
          </div>
          <div class="stat-box">
            <div class="stat-number" id="stat-published" style="color: var(--green);">0</div>
            <div class="stat-label">Published</div>
          </div>
          <div class="stat-box">
            <div class="stat-number" id="stat-pending" style="color: var(--yellow);">0</div>
            <div class="stat-label">Pending / Draft</div>
          </div>
          <div class="stat-box">
            <div class="stat-number" id="stat-failed" style="color: var(--red);">0</div>
            <div class="stat-label">Failed</div>
          </div>
          <div class="stat-box">
            <div class="stat-number" id="stat-comments">0</div>
            <div class="stat-label">Comments</div>
          </div>
          <div class="stat-box">
            <div class="stat-number" id="stat-media" style="color: var(--purple);">0</div>
            <div class="stat-label">R2 Media Files</div>
          </div>
        </div>

        <!-- Tabs Navigation -->
        <div class="tabs">
          <button class="tab-btn active" onclick="switchTab('posts-tab')">📝 Post Logs (D1)</button>
          <button class="tab-btn" onclick="switchTab('comments-tab')">💬 Comments Log (D1)</button>
          <button class="tab-btn" onclick="switchTab('media-tab')">📦 R2 Media Files</button>
          <button class="tab-btn" onclick="switchTab('credentials-tab')">🔑 Social Credentials</button>
        </div>

        <!-- Tab 1: Post Logs -->
        <div id="posts-tab" class="tab-content">
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th style="width: 40px;">#</th>
                  <th>Platform</th>
                  <th>Title / Content</th>
                  <th>Media</th>
                  <th>Status</th>
                  <th>Published Time</th>
                  <th>Response / Details</th>
                </tr>
              </thead>
              <tbody id="posts-table-body">
                <tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Loading live logs...</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Tab 2: Comments Log -->
        <div id="comments-tab" class="tab-content" style="display: none;">
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th style="width: 40px;">#</th>
                  <th>Platform</th>
                  <th>Post ID</th>
                  <th>Author</th>
                  <th>Comment Text</th>
                  <th>Reply Sent</th>
                  <th>Status</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody id="comments-table-body">
                <tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No comments recorded yet.</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Tab 3: R2 Media Files -->
        <div id="media-tab" class="tab-content" style="display: none;">
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>File Key</th>
                  <th>Size</th>
                  <th>Uploaded At</th>
                  <th>Direct Public URL</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="media-table-body">
                <tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No media files in R2.</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <!-- Tab 4: Social Credentials -->
        <div id="credentials-tab" class="tab-content" style="display: none;">
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Platform</th>
                  <th>Token Type</th>
                  <th>Expires At</th>
                  <th>Last Updated</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody id="credentials-table-body">
                <tr><td colspan="5" style="text-align: center; color: var(--text-muted);">Loading credentials...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <!-- PUBLIC MCP CONNECTION & INFO SECTION -->
    <div class="grid">
      <div class="card">
        <h2>🔌 Connect with AI Agents (Muse AI)</h2>
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
        <ul style="list-style: none; font-size: 0.9rem; color: var(--text-muted);">
          <li style="margin-bottom: 0.4rem;">🗄️ <strong>D1 Database:</strong> <span style="color: var(--green);">${env.DB ? "Connected (cloudflare-mcp-db)" : "Pending"}</span></li>
          <li style="margin-bottom: 0.4rem;">📦 <strong>R2 Storage:</strong> <span style="color: var(--green);">${env.MEDIA_BUCKET ? "Connected (cloudflare-mcp-media)" : "Pending"}</span></li>
          <li style="margin-bottom: 0.4rem;">🤖 <strong>Workers AI:</strong> <span style="color: var(--green);">${env.AI ? "Connected (Llama 3.1 & Distill)" : "Pending"}</span></li>
          <li style="margin-bottom: 0.4rem;">📍 <strong>Data Center:</strong> <span style="color: var(--blue);">${cf.colo || "Global"} (${cf.country || "Edge"})</span></li>
          <li style="margin-bottom: 0.4rem;">⚡ <strong>Tools Registered:</strong> <span style="color: var(--accent); font-weight: bold;">${TOOLS.length} Active Tools</span></li>
        </ul>
      </div>
    </div>

    <!-- Muse AI instructions -->
    <div class="card" style="margin-bottom: 2rem;">
      <h2>🤖 Muse AI Quick Connection Guide</h2>
      <p style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 0.75rem;">
        In Muse AI or any MCP-compatible agent, add a Remote MCP tool using this endpoint:
      </p>
      <pre><code>Server URL: ${mcpEndpoint}
Transport: HTTP POST (Streamable HTTP / JSON-RPC 2.0)
Key Automation Tools:
- linkedin_publish_post  → Publishes posts/articles to LinkedIn and saves logs in D1
- youtube_upload_video   → Uploads videos stored in R2 directly to YouTube
- youtube_reply_comment  → Replies to YouTube comments
- db_get_post_logs       → Muse AI can check recent post logs and approval status
- r2_upload_file         → Uploads media assets to https://mcp.sohag.com.bd/media/...</code></pre>
    </div>

    <!-- Tools Catalog -->
    <div class="card">
      <h2>🛠️ Registered MCP Tools (${TOOLS.length})</h2>
      <div class="tool-grid">
        ${toolsHtml}
      </div>
    </div>

    <footer>
      <p>Cloudflare MCP Agent Hub • mcp.sohag.com.bd • Built for Muse AI Social Automation</p>
    </footer>
  </div>

  <!-- Login Modal -->
  <div class="modal-overlay" id="login-modal">
    <div class="modal">
      <h3>🔒 Admin Dashboard Login</h3>
      <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1.25rem; text-align: center;">
        Sign in to view live post logs, comments, and R2 media.
      </p>
      <form onsubmit="handleLoginSubmit(event)">
        <div class="form-group">
          <label>Username</label>
          <input type="text" id="login-username" class="form-control" placeholder="smsohag" required autofocus>
        </div>
        <div class="form-group">
          <label>Password</label>
          <input type="password" id="login-password" class="form-control" placeholder="••••••••" required>
        </div>
        <div id="login-error" class="error-msg"></div>
        <div style="display: flex; gap: 0.5rem; margin-top: 1.5rem;">
          <button type="button" class="btn btn-outline" style="flex: 1;" onclick="closeLoginModal()">Cancel</button>
          <button type="submit" class="btn btn-primary" style="flex: 1;">Login</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    let pollInterval = null;

    // Check login status on page load
    window.addEventListener("DOMContentLoaded", async () => {
      await checkAuthStatus();
    });

    async function checkAuthStatus() {
      try {
        const res = await fetch("/api/admin/check");
        const data = await res.json();
        if (data.authenticated) {
          showAdminPanel(data.user || "smsohag");
        } else {
          hideAdminPanel();
        }
      } catch (err) {
        hideAdminPanel();
      }
    }

    function showAdminPanel(username) {
      document.getElementById("auth-logged-out").style.display = "none";
      document.getElementById("auth-logged-in").style.display = "flex";
      document.getElementById("admin-username-display").textContent = username;
      document.getElementById("admin-panel").style.display = "block";
      refreshAdminLogs();
      toggleAutoRefresh(true);
    }

    function hideAdminPanel() {
      document.getElementById("auth-logged-out").style.display = "block";
      document.getElementById("auth-logged-in").style.display = "none";
      document.getElementById("admin-panel").style.display = "none";
      toggleAutoRefresh(false);
    }

    function openLoginModal() {
      document.getElementById("login-modal").style.display = "flex";
      document.getElementById("login-error").style.display = "none";
      document.getElementById("login-username").focus();
    }

    function closeLoginModal() {
      document.getElementById("login-modal").style.display = "none";
    }

    async function handleLoginSubmit(e) {
      e.preventDefault();
      const username = document.getElementById("login-username").value.trim();
      const password = document.getElementById("login-password").value;
      const errorDiv = document.getElementById("login-error");

      try {
        const res = await fetch("/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success) {
          closeLoginModal();
          showAdminPanel(data.user);
        } else {
          errorDiv.textContent = data.error || "Login failed";
          errorDiv.style.display = "block";
        }
      } catch (err) {
        errorDiv.textContent = "Network error. Please try again.";
        errorDiv.style.display = "block";
      }
    }

    async function logoutAdmin() {
      try {
        await fetch("/api/logout", { method: "POST" });
      } catch {}
      hideAdminPanel();
    }

    async function refreshAdminLogs() {
      try {
        const res = await fetch("/api/admin/logs");
        if (res.status === 401) {
          hideAdminPanel();
          return;
        }
        const data = await res.json();
        if (!data.success) return;

        // Update stats
        document.getElementById("stat-total-posts").textContent = data.stats.totalPosts || 0;
        document.getElementById("stat-published").textContent = data.stats.published || 0;
        document.getElementById("stat-pending").textContent = data.stats.pending || 0;
        document.getElementById("stat-failed").textContent = data.stats.failed || 0;
        document.getElementById("stat-comments").textContent = data.stats.totalComments || 0;
        document.getElementById("stat-media").textContent = data.stats.totalMedia || 0;
        document.getElementById("last-updated").textContent = "Updated: " + new Date().toLocaleTimeString();

        // Render Posts Table
        renderPostsTable(data.posts || []);

        // Render Comments Table
        renderCommentsTable(data.comments || []);

        // Render Media Table
        renderMediaTable(data.media || []);

        // Render Credentials Table
        renderCredentialsTable(data.credentials || []);
      } catch (err) {
        console.error("Error refreshing logs:", err);
      }
    }

    function renderPostsTable(posts) {
      const tbody = document.getElementById("posts-table-body");
      if (posts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No posts recorded in D1 yet.</td></tr>';
        return;
      }

      tbody.innerHTML = posts.map(p => {
        let badgeClass = "badge-pending";
        if (p.status === "published") badgeClass = "badge-published";
        if (p.status === "failed") badgeClass = "badge-failed";

        const mediaLink = p.media_urls
          ? '<a href="' + p.media_urls + '" target="_blank" style="color: var(--blue);">View Media</a>'
          : '<span style="color: var(--text-muted);">-</span>';

        const rawResponse = p.response_data ? JSON.stringify(JSON.parse(p.response_data), null, 2) : "None";
        const contentSnippet = (p.content || "").length > 80 ? (p.content.substring(0, 80) + "...") : p.content;

        return '<tr>' +
          '<td>' + p.id + '</td>' +
          '<td><strong style="text-transform: capitalize; color: var(--accent);">' + (p.platform || "unknown") + '</strong></td>' +
          '<td>' + (p.title ? '<strong>' + escapeHtml(p.title) + '</strong><br>' : '') + '<span style="color: var(--text-muted);">' + escapeHtml(contentSnippet) + '</span></td>' +
          '<td>' + mediaLink + '</td>' +
          '<td><span class="badge-status ' + badgeClass + '">' + p.status + '</span></td>' +
          '<td style="font-size: 0.8rem; color: var(--text-muted);">' + (p.published_at || p.created_at || "-") + '</td>' +
          '<td><button class="btn btn-outline btn-sm" onclick=\\'alert(' + JSON.stringify(rawResponse) + ')\\'>View Details</button></td>' +
        '</tr>';
      }).join("");
    }

    function renderCommentsTable(comments) {
      const tbody = document.getElementById("comments-table-body");
      if (comments.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No comments recorded yet.</td></tr>';
        return;
      }
      tbody.innerHTML = comments.map(c => {
        return '<tr>' +
          '<td>' + c.id + '</td>' +
          '<td><strong style="text-transform: capitalize; color: var(--accent);">' + c.platform + '</strong></td>' +
          '<td><code>' + (c.post_id || "-") + '</code></td>' +
          '<td>' + escapeHtml(c.author || "Anonymous") + '</td>' +
          '<td>' + escapeHtml(c.comment_text || "") + '</td>' +
          '<td>' + (c.reply_text ? '<span style="color: var(--green);">' + escapeHtml(c.reply_text) + '</span>' : '<span style="color: var(--text-muted);">None</span>') + '</td>' +
          '<td><span class="badge-status badge-published">' + c.status + '</span></td>' +
          '<td style="font-size: 0.8rem; color: var(--text-muted);">' + (c.created_at || "-") + '</td>' +
        '</tr>';
      }).join("");
    }

    function renderMediaTable(media) {
      const tbody = document.getElementById("media-table-body");
      if (media.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No media files in R2 storage.</td></tr>';
        return;
      }
      tbody.innerHTML = media.map(m => {
        const sizeKb = (m.size / 1024).toFixed(1) + " KB";
        return '<tr>' +
          '<td><code>' + m.key + '</code></td>' +
          '<td>' + sizeKb + '</td>' +
          '<td style="font-size: 0.8rem; color: var(--text-muted);">' + (m.uploaded ? new Date(m.uploaded).toLocaleString() : "-") + '</td>' +
          '<td><a href="' + m.url + '" target="_blank" style="color: var(--blue); word-break: break-all;">' + m.url + '</a></td>' +
          '<td><button class="btn btn-outline btn-sm" onclick="navigator.clipboard.writeText(\\'' + m.url + '\\'); alert(\\'URL copied!\\')">Copy Link</button></td>' +
        '</tr>';
      }).join("");
    }

    function renderCredentialsTable(creds) {
      const tbody = document.getElementById("credentials-table-body");
      const platforms = ["linkedin", "youtube", "facebook"];
      tbody.innerHTML = platforms.map(plat => {
        const item = creds.find(c => c.platform === plat);
        const configured = !!item;
        return '<tr>' +
          '<td><strong style="text-transform: capitalize; color: var(--accent);">' + plat + '</strong></td>' +
          '<td>' + (configured ? (item.token_type || "Bearer") : "-") + '</td>' +
          '<td style="font-size: 0.8rem; color: var(--text-muted);">' + (configured && item.expires_at ? item.expires_at : "N/A") + '</td>' +
          '<td style="font-size: 0.8rem; color: var(--text-muted);">' + (configured && item.updated_at ? item.updated_at : "Never") + '</td>' +
          '<td><span class="badge-status ' + (configured ? "badge-published" : "badge-failed") + '">' + (configured ? "Configured" : "Not Set") + '</span></td>' +
        '</tr>';
      }).join("");
    }

    function switchTab(tabId) {
      document.querySelectorAll(".tab-content").forEach(el => el.style.display = "none");
      document.querySelectorAll(".tab-btn").forEach(el => el.classList.remove("active"));
      document.getElementById(tabId).style.display = "block";
      event.target.classList.add("active");
    }

    function toggleAutoRefresh(enabled) {
      if (pollInterval) clearInterval(pollInterval);
      if (enabled) {
        pollInterval = setInterval(refreshAdminLogs, 5000);
      }
    }

    function escapeHtml(str) {
      return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
  </script>
</body>
</html>`;
}
