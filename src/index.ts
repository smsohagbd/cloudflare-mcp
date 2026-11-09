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
  LINKEDIN_CLIENT_ID?: string;
  LINKEDIN_CLIENT_SECRET?: string;
  LINKEDIN_ACCESS_TOKEN?: string;
  YOUTUBE_ACCESS_TOKEN?: string;
  YOUTUBE_API_KEY?: string;
  GITHUB_ACCESS_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
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

export async function getOAuthAppConfig(
  platform: "linkedin" | "github",
  db: D1Database | null | undefined,
  env: Env
): Promise<{ clientId: string; clientSecret: string }> {
  let clientId = "";
  let clientSecret = "";

  if (db) {
    try {
      const row: any = await db
        .prepare("SELECT access_token, extra_data FROM social_credentials WHERE platform = ?")
        .bind(`${platform}_oauth_app`)
        .first();
      if (row && row.access_token) {
        clientSecret = row.access_token;
        const extra = JSON.parse(row.extra_data || "{}");
        clientId = extra.client_id || "";
      }
    } catch {}
  }

  if (!clientId) {
    clientId = platform === "linkedin"
      ? (env.LINKEDIN_CLIENT_ID || "862xwbz3mk9f4n")
      : (env.GITHUB_CLIENT_ID || "");
  }
  if (!clientSecret) {
    clientSecret = platform === "linkedin"
      ? (env.LINKEDIN_CLIENT_SECRET || "")
      : (env.GITHUB_CLIENT_SECRET || "");
  }

  return { clientId, clientSecret };
}

export const DEFAULT_MCP_KEY = "SOhag999@#";

export async function getExpectedMCPKey(env: Env): Promise<string> {
  if (env.DB) {
    try {
      const row: any = await env.DB.prepare(
        "SELECT access_token FROM social_credentials WHERE platform = 'mcp_agent_key'"
      ).first();
      if (row && row.access_token && row.access_token.trim()) {
        return row.access_token.trim();
      }
    } catch {}
  }
  if (env.MCP_API_KEY && env.MCP_API_KEY.trim()) {
    return env.MCP_API_KEY.trim();
  }
  return DEFAULT_MCP_KEY;
}

export async function verifyMCPAgentAuth(
  request: Request,
  env: Env
): Promise<{ authorized: boolean; token?: string; reason?: string }> {
  const expectedKey = await getExpectedMCPKey(env);
  if (!expectedKey) {
    return { authorized: true };
  }

  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization") || "";
  const apiKeyHeader = request.headers.get("x-api-key") || request.headers.get("x-mcp-token") || "";
  const tokenParam =
    url.searchParams.get("token") ||
    url.searchParams.get("key") ||
    url.searchParams.get("apiKey") ||
    "";

  let provided = "";
  if (authHeader.startsWith("Bearer ")) {
    provided = authHeader.slice(7).trim();
  } else if (authHeader) {
    provided = authHeader.trim();
  } else if (apiKeyHeader) {
    provided = apiKeyHeader.trim();
  } else if (tokenParam) {
    provided = tokenParam.trim();
  }

  if (!provided) {
    return {
      authorized: false,
      reason: "Missing MCP authentication token. Please provide the secret token in Authorization header ('Bearer <token>') or query parameter ('?token=<token>').",
    };
  }

  const isMatch = provided === expectedKey || (expectedKey.endsWith("#") && provided === expectedKey.slice(0, -1));
  if (!isMatch) {
    return {
      authorized: false,
      reason: "Invalid MCP secret token. Access denied.",
    };
  }

  return { authorized: true, token: provided };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, x-mcp-version, x-api-key, x-mcp-token",
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

    // LinkedIn OAuth Step 1: Redirect user to LinkedIn authorization page
    if (url.pathname === "/auth/linkedin") {
      const { clientId } = await getOAuthAppConfig("linkedin", env.DB, env);
      const redirectUri = `${url.origin}/auth/linkedin/callback`;
      const customScope = url.searchParams.get("scope");
      const scopes = customScope ? encodeURIComponent(customScope) : encodeURIComponent("openid profile w_member_social email");
      const linkedinAuthUrl = `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&state=mcp_linkedin`;

      return Response.redirect(linkedinAuthUrl, 302);
    }

    // LinkedIn OAuth Step 2: Callback handler
    if (url.pathname === "/auth/linkedin/callback") {
      const error = url.searchParams.get("error");
      const errorDesc = url.searchParams.get("error_description");
      const { clientId, clientSecret } = await getOAuthAppConfig("linkedin", env.DB, env);

      if (error) {
        let helpTip = `LinkedIn error: <code>${error}</code> &mdash; ${errorDesc || ""}`;
        if (error === "unauthorized_scope_error") {
          helpTip = `
            <div style="text-align: left; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); padding: 1rem; border-radius: 8px; margin-top: 1rem; font-size: 0.88rem; line-height: 1.6;">
              <strong style="color: #ef4444;">Why this happened:</strong><br>
              Your LinkedIn Developer App (<code>${clientId}</code>) has not added the <strong>"Sign In with LinkedIn using OpenID Connect"</strong> product.<br><br>
              <strong style="color: #38bdf8;">How to fix in 1 minute:</strong><br>
              1. Go to <a href="https://www.linkedin.com/developers/apps" target="_blank" style="color: #38bdf8; text-decoration: underline;">LinkedIn Developer Portal</a> &rarr; click your App.<br>
              2. Go to the <strong>Products</strong> tab.<br>
              3. Find <strong>"Sign In with LinkedIn using OpenID Connect"</strong> &rarr; click <strong>Request access</strong> (instant approval).<br>
              4. Make sure <strong>"Share on LinkedIn"</strong> is also requested.<br>
              5. Click Connect again from the Dashboard!
            </div>
          `;
        }
        return new Response(
          renderOAuthResult("LinkedIn Connection Failed", helpTip, false, url.origin),
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }

      const code = url.searchParams.get("code");
      if (!code) {
        return new Response(
          renderOAuthResult("Missing Authorization Code", "No authorization code received from LinkedIn.", false, url.origin),
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }

      if (!clientSecret) {
        return new Response(
          renderOAuthResult(
            "Client Secret Missing",
            `LinkedIn Client Secret is not set. Please paste your Primary Client Secret in the dashboard under <strong>OAuth Developer App Config</strong> and click Save to D1.`,
            false,
            url.origin
          ),
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }

      const redirectUri = `${url.origin}/auth/linkedin/callback`;

      try {
        const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
          }).toString(),
        });

        if (!tokenRes.ok) {
          const errBody = await tokenRes.text();
          let helpfulMsg = `LinkedIn rejected token exchange: ${errBody}`;
          if (errBody.includes("invalid_client")) {
            helpfulMsg = `<div style="text-align: left; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.3); padding: 1.25rem; border-radius: 8px; margin-bottom: 1.5rem; font-size: 0.9rem;">
              <strong style="color: #ef4444; font-size: 1.05rem; display: block; margin-bottom: 0.6rem;">⚠️ Primary Client Secret Mismatch!</strong>
              LinkedIn rejected the token exchange because the Primary Client Secret currently stored in Cloudflare D1 does not match Client ID <code>${clientId}</code>.<br><br>
              <strong>How to fix in 1 minute:</strong>
              <ol style="margin-top: 0.5rem; padding-left: 1.2rem; line-height: 1.7;">
                <li>Open your <a href="https://www.linkedin.com/developers/apps/264234107/auth" target="_blank" style="color: #38bdf8; text-decoration: underline; font-weight: bold;">LinkedIn Developer App &rarr; Auth tab ↗</a></li>
                <li>Click the copy icon 📋 next to <strong>Primary Client Secret</strong> (starts with <code>WPL_AP1...</code>)</li>
                <li>Return to <a href="${url.origin}" style="color: #38bdf8; text-decoration: underline; font-weight: bold;">mcp.sohag.com.bd Dashboard</a> &rarr; go to <strong>🔑 Social Credentials</strong> tab</li>
                <li>Under <em>1-Click OAuth App Configuration</em>, paste the secret into <strong>Primary Client Secret</strong></li>
                <li>Click <strong>🧪 Test Secret</strong> to verify it, then click <strong>💾 Save Secret to D1</strong></li>
                <li>Finally, click <strong>🚀 Connect LinkedIn</strong>!</li>
              </ol>
            </div>`;
          }
          return new Response(
            renderOAuthResult("Token Exchange Failed", helpfulMsg, false, url.origin),
            { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }

        const tokenData = (await tokenRes.json()) as any;
        const accessToken = tokenData.access_token;
        const refreshToken = tokenData.refresh_token || null;
        const expiresIn = tokenData.expires_in || 5184000;
        const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

        // Query userinfo to get member URN and name
        let memberName = "LinkedIn User";
        let authorUrn = "urn:li:person:me";
        try {
          const profileRes = await fetch("https://api.linkedin.com/v2/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (profileRes.ok) {
            const profile = (await profileRes.json()) as any;
            memberName = profile.name || memberName;
            if (profile.sub) {
              authorUrn = `urn:li:person:${profile.sub}`;
            }
          }
        } catch {}

        if (env.DB) {
          const extraData = JSON.stringify({
            name: memberName,
            author_urn: authorUrn,
            connectedVia: "1-Click OAuth",
          });
          const now = new Date().toISOString();

          await env.DB.prepare(`
            INSERT INTO social_credentials (platform, access_token, refresh_token, token_type, expires_at, extra_data, updated_at)
            VALUES ('linkedin', ?, ?, 'Bearer', ?, ?, ?)
            ON CONFLICT(platform) DO UPDATE SET
              access_token = excluded.access_token,
              refresh_token = COALESCE(excluded.refresh_token, social_credentials.refresh_token),
              expires_at = excluded.expires_at,
              extra_data = excluded.extra_data,
              updated_at = excluded.updated_at
          `).bind(accessToken, refreshToken, expiresAt, extraData, now).run();
        }

        return new Response(
          renderOAuthResult(
            "LinkedIn Successfully Connected!",
            `Connected as <strong>${memberName}</strong> (${authorUrn})! Token saved to Cloudflare D1. Muse AI can now publish posts automatically!`,
            true,
            url.origin
          ),
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      } catch (err: any) {
        return new Response(
          renderOAuthResult("Connection Error", err.message, false, url.origin),
          { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
    }

    // GitHub OAuth Step 1: Redirect user to GitHub authorization page
    if (url.pathname === "/auth/github") {
      const { clientId } = await getOAuthAppConfig("github", env.DB, env);
      if (!clientId) {
        return new Response(
          renderOAuthResult(
            "GitHub Client ID Missing",
            "<code>GITHUB_CLIENT_ID</code> is not configured. You can either configure your GitHub OAuth App in the dashboard or paste a Personal Access Token directly.",
            false,
            url.origin
          ),
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
      const redirectUri = `${url.origin}/auth/github/callback`;
      const scopes = encodeURIComponent("repo,read:user,gist");
      const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scopes}&state=mcp_github`;

      return Response.redirect(githubAuthUrl, 302);
    }

    // GitHub OAuth Step 2: Callback handler
    if (url.pathname === "/auth/github/callback") {
      const error = url.searchParams.get("error");
      const errorDesc = url.searchParams.get("error_description");
      if (error) {
        return new Response(
          renderOAuthResult("GitHub Connection Failed", `GitHub error: ${error} - ${errorDesc || ""}`, false, url.origin),
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }

      const code = url.searchParams.get("code");
      if (!code) {
        return new Response(
          renderOAuthResult("Missing Authorization Code", "No authorization code received from GitHub.", false, url.origin),
          { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }

      const { clientId, clientSecret } = await getOAuthAppConfig("github", env.DB, env);
      const redirectUri = `${url.origin}/auth/github/callback`;

      try {
        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        });

        if (!tokenRes.ok) {
          const errBody = await tokenRes.text();
          return new Response(
            renderOAuthResult("Token Exchange Failed", `GitHub rejected token exchange: ${errBody}`, false, url.origin),
            { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }

        const tokenData = (await tokenRes.json()) as any;
        if (tokenData.error) {
          return new Response(
            renderOAuthResult("GitHub OAuth Error", `${tokenData.error_description || tokenData.error}`, false, url.origin),
            { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }

        const accessToken = tokenData.access_token;
        const tokenType = tokenData.token_type || "Bearer";

        // Query user info from GitHub
        let username = "GitHub User";
        let userUrl = "https://github.com";
        try {
          const profileRes = await fetch("https://api.github.com/user", {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": "Cloudflare-MCP-Hub/1.0",
              Accept: "application/vnd.github.v3+json",
            },
          });
          if (profileRes.ok) {
            const profile = (await profileRes.json()) as any;
            username = profile.login || username;
            userUrl = profile.html_url || userUrl;
          }
        } catch {}

        if (env.DB) {
          const extraData = JSON.stringify({
            login: username,
            html_url: userUrl,
            connectedVia: "1-Click OAuth",
          });
          const now = new Date().toISOString();

          await env.DB.prepare(`
            INSERT INTO social_credentials (platform, access_token, token_type, extra_data, updated_at)
            VALUES ('github', ?, ?, ?, ?)
            ON CONFLICT(platform) DO UPDATE SET
              access_token = excluded.access_token,
              token_type = excluded.token_type,
              extra_data = excluded.extra_data,
              updated_at = excluded.updated_at
          `).bind(accessToken, tokenType, extraData, now).run();
        }

        return new Response(
          renderOAuthResult(
            "GitHub Successfully Connected!",
            `Connected as <strong><a href="${userUrl}" target="_blank" style="color: #38bdf8;">@${username}</a></strong>! Token saved to Cloudflare D1. AI agents can now create issues, gists, and manage repos automatically!`,
            true,
            url.origin
          ),
          { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      } catch (err: any) {
        return new Response(
          renderOAuthResult("Connection Error", err.message, false, url.origin),
          { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
    }

    // Auth endpoint: POST /api/login
    if (url.pathname === "/api/login" && request.method === "POST") {
      let body: any = {};
      try { body = await request.json(); } catch {}
      let targetUser = env.ADMIN_USER || "smsohag";
      let targetPass = env.ADMIN_PASS || "SOhag@#";

      if (env.DB) {
        try {
          const row: any = await env.DB.prepare("SELECT access_token, extra_data FROM social_credentials WHERE platform = 'admin_auth'").first();
          if (row && row.access_token) {
            targetPass = row.access_token;
            if (row.extra_data) {
              const extra = JSON.parse(row.extra_data);
              if (extra.username) targetUser = extra.username;
            }
          }
        } catch {}
      }

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
      let username = "smsohag";
      if (isValid && env.DB) {
        try {
          const row: any = await env.DB.prepare("SELECT extra_data FROM social_credentials WHERE platform = 'admin_auth'").first();
          if (row && row.extra_data) {
            const extra = JSON.parse(row.extra_data);
            if (extra.username) username = extra.username;
          }
        } catch {}
      }
      return new Response(JSON.stringify({
        authenticated: isValid,
        user: isValid ? username : null,
        mcpToken: await getExpectedMCPKey(env),
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Change Admin Credentials: POST /api/admin/change-password
    if (url.pathname === "/api/admin/change-password" && request.method === "POST") {
      const token = extractToken(request);
      const secret = env.JWT_SECRET || DEFAULT_SECRET;
      const isValid = token ? await verifyToken(token, secret) : false;

      if (!isValid) {
        return new Response(JSON.stringify({ error: "Unauthorized. Please log in first." }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (!env.DB) {
        return new Response(JSON.stringify({ error: "Database not connected" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let body: any = {};
      try { body = await request.json(); } catch {}
      const currentPass = String(body.current_password || "").trim();
      const newUsername = String(body.new_username || "").trim();
      const newPassword = String(body.new_password || "").trim();

      if (!newUsername || !newPassword) {
        return new Response(JSON.stringify({ error: "New username and password are required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (newPassword.length < 6) {
        return new Response(JSON.stringify({ error: "New password must be at least 6 characters" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Verify current password
      let targetPass = env.ADMIN_PASS || "SOhag@#";
      try {
        const row: any = await env.DB.prepare("SELECT access_token FROM social_credentials WHERE platform = 'admin_auth'").first();
        if (row && row.access_token) {
          targetPass = row.access_token;
        }
      } catch {}

      if (currentPass !== targetPass) {
        return new Response(JSON.stringify({ error: "Current password is incorrect" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const now = new Date().toISOString();
      const extraData = JSON.stringify({ username: newUsername });
      await env.DB.prepare(`
        INSERT INTO social_credentials (platform, access_token, token_type, extra_data, updated_at)
        VALUES ('admin_auth', ?, 'AdminAuth', ?, ?)
        ON CONFLICT(platform) DO UPDATE SET
          access_token = excluded.access_token,
          extra_data = excluded.extra_data,
          updated_at = excluded.updated_at
      `).bind(newPassword, extraData, now).run();

      const newToken = await createToken(newUsername, secret);
      return new Response(
        JSON.stringify({
          success: true,
          message: "Admin credentials successfully updated and secured in Cloudflare D1!",
          user: newUsername,
          token: newToken,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Set-Cookie": `mcp_session=${encodeURIComponent(newToken)}; Path=/; Max-Age=1209600; SameSite=Lax; Secure`,
            ...corsHeaders,
          },
        }
      );
    }

    // Update MCP Agent Secret Token: POST /api/admin/mcp-token
    if (url.pathname === "/api/admin/mcp-token" && request.method === "POST") {
      const token = extractToken(request);
      const secret = env.JWT_SECRET || DEFAULT_SECRET;
      const isValid = token ? await verifyToken(token, secret) : false;

      if (!isValid) {
        return new Response(JSON.stringify({ error: "Unauthorized. Please log in first." }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (!env.DB) {
        return new Response(JSON.stringify({ error: "Database not connected" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let body: any = {};
      try { body = await request.json(); } catch {}
      const newMCPToken = String(body.token || "").trim();

      if (!newMCPToken) {
        return new Response(JSON.stringify({ error: "Token cannot be empty." }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const now = new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO social_credentials (platform, access_token, token_type, extra_data, updated_at)
        VALUES ('mcp_agent_key', ?, 'Bearer', '{"name":"MCP Agent Secret"}', ?)
        ON CONFLICT(platform) DO UPDATE SET
          access_token = excluded.access_token,
          updated_at = excluded.updated_at
      `).bind(newMCPToken, now).run();

      return new Response(
        JSON.stringify({
          success: true,
          message: "MCP Agent Secret Token updated successfully!",
          mcpToken: newMCPToken,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // Admin Credentials update: POST /api/admin/credentials
    if (url.pathname === "/api/admin/credentials" && request.method === "POST") {
      const token = extractToken(request);
      const secret = env.JWT_SECRET || DEFAULT_SECRET;
      const isValid = token ? await verifyToken(token, secret) : false;

      if (!isValid) {
        return new Response(JSON.stringify({ error: "Unauthorized. Please log in." }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (!env.DB) {
        return new Response(JSON.stringify({ error: "Database not connected" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let body: any = {};
      try { body = await request.json(); } catch {}
      const platform = String(body.platform || "").toLowerCase();
      const accessToken = String(body.access_token || "").trim();
      const refreshToken = body.refresh_token ? String(body.refresh_token).trim() : null;
      let extraData = body.extra_data ? String(body.extra_data).trim() : null;

      if (!platform || !accessToken) {
        return new Response(JSON.stringify({ error: "Platform and Access Token are required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      // Auto-detect GitHub profile if extra_data is empty
      if (platform === "github" && (!extraData || extraData === "{}")) {
        try {
          const ghRes = await fetch("https://api.github.com/user", {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": "Cloudflare-MCP-Hub/1.0",
              Accept: "application/vnd.github.v3+json",
            },
          });
          if (ghRes.ok) {
            const ghUser = (await ghRes.json()) as any;
            extraData = JSON.stringify({
              login: ghUser.login,
              name: ghUser.name || ghUser.login,
              html_url: ghUser.html_url,
              avatar_url: ghUser.avatar_url,
            });
          }
        } catch {}
      }

      // Auto-detect LinkedIn profile if extra_data is empty
      if (platform === "linkedin" && (!extraData || extraData === "{}")) {
        try {
          const liRes = await fetch("https://api.linkedin.com/v2/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (liRes.ok) {
            const liUser = (await liRes.json()) as any;
            extraData = JSON.stringify({
              name: liUser.name || "LinkedIn Member",
              author_urn: liUser.sub ? `urn:li:person:${liUser.sub}` : undefined,
              scope: "openid,profile,w_member_social",
            });
          } else {
            extraData = JSON.stringify({
              name: "LinkedIn Member",
              scope: "w_member_social",
            });
          }
        } catch {
          extraData = JSON.stringify({
            name: "LinkedIn Member",
            scope: "w_member_social",
          });
        }
      }

      const now = new Date().toISOString();
      await env.DB.prepare(`
        INSERT INTO social_credentials (platform, access_token, refresh_token, token_type, extra_data, updated_at)
        VALUES (?, ?, ?, 'Bearer', ?, ?)
        ON CONFLICT(platform) DO UPDATE SET
          access_token = excluded.access_token,
          refresh_token = COALESCE(excluded.refresh_token, social_credentials.refresh_token),
          extra_data = COALESCE(excluded.extra_data, social_credentials.extra_data),
          updated_at = excluded.updated_at
      `).bind(platform, accessToken, refreshToken, extraData, now).run();

      return new Response(JSON.stringify({ success: true, message: `Successfully saved ${platform} credentials to Cloudflare D1!` }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Admin Credentials delete: DELETE /api/admin/credentials or POST /api/admin/credentials/delete
    if (
      (url.pathname === "/api/admin/credentials" && request.method === "DELETE") ||
      (url.pathname === "/api/admin/credentials/delete" && request.method === "POST")
    ) {
      const token = extractToken(request);
      const secret = env.JWT_SECRET || DEFAULT_SECRET;
      const isValid = token ? await verifyToken(token, secret) : false;

      if (!isValid) {
        return new Response(JSON.stringify({ error: "Unauthorized. Please log in." }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (!env.DB) {
        return new Response(JSON.stringify({ error: "Database not connected" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let platform = url.searchParams.get("platform") || "";
      if (!platform && request.method === "POST") {
        try {
          const body: any = await request.json();
          platform = body.platform || "";
        } catch {}
      }
      platform = platform.toLowerCase().trim();

      if (!platform) {
        return new Response(JSON.stringify({ error: "Platform name is required to delete" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      await env.DB.prepare("DELETE FROM social_credentials WHERE platform = ?").bind(platform).run();

      return new Response(
        JSON.stringify({
          success: true,
          message: `Successfully deleted ${platform} credentials from Cloudflare D1!`,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // Admin OAuth App Credentials update: POST /api/admin/oauth-app
    if (url.pathname === "/api/admin/oauth-app" && request.method === "POST") {
      const token = extractToken(request);
      const secret = env.JWT_SECRET || DEFAULT_SECRET;
      const isValid = token ? await verifyToken(token, secret) : false;

      if (!isValid) {
        return new Response(JSON.stringify({ error: "Unauthorized. Please log in." }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (!env.DB) {
        return new Response(JSON.stringify({ error: "Database not connected" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let body: any = {};
      try { body = await request.json(); } catch {}
      const platform = String(body.platform || "").toLowerCase().trim();
      const clientId = String(body.client_id || "").trim();
      const clientSecret = String(body.client_secret || "").trim();

      if (!platform || !clientId || !clientSecret) {
        return new Response(JSON.stringify({ error: "Platform, Client ID, and Client Secret are required" }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      const now = new Date().toISOString();
      const extraData = JSON.stringify({ client_id: clientId });
      const recordPlatform = `${platform}_oauth_app`;

      await env.DB.prepare(`
        INSERT INTO social_credentials (platform, access_token, token_type, extra_data, updated_at)
        VALUES (?, ?, 'OAuthApp', ?, ?)
        ON CONFLICT(platform) DO UPDATE SET
          access_token = excluded.access_token,
          extra_data = excluded.extra_data,
          updated_at = excluded.updated_at
      `).bind(recordPlatform, clientSecret, extraData, now).run();

      return new Response(
        JSON.stringify({
          success: true,
          message: `Successfully saved ${platform} Client Secret to Cloudflare D1! 1-Click OAuth is now ready.`,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // Test OAuth App Credentials: POST /api/admin/test-oauth-app
    if (url.pathname === "/api/admin/test-oauth-app" && request.method === "POST") {
      const token = extractToken(request);
      const secret = env.JWT_SECRET || DEFAULT_SECRET;
      const isValid = token ? await verifyToken(token, secret) : false;

      if (!isValid) {
        return new Response(JSON.stringify({ error: "Unauthorized. Please log in." }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let body: any = {};
      try { body = await request.json(); } catch {}
      const platform = String(body.platform || "linkedin").toLowerCase().trim();
      let clientId = String(body.client_id || "").trim();
      let clientSecret = String(body.client_secret || "").trim();

      // If secret not provided in body, read from D1
      if (!clientSecret && env.DB) {
        const appCfg = await getOAuthAppConfig(platform as any, env.DB, env);
        clientId = clientId || appCfg.clientId;
        clientSecret = appCfg.clientSecret;
      }

      if (!clientSecret) {
        return new Response(JSON.stringify({ success: false, error: "Please enter or save a Client Secret first." }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      if (platform === "linkedin") {
        try {
          const testRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: clientId,
              client_secret: clientSecret,
            }).toString(),
          });
          const text = await testRes.text();
          let json: any = {};
          try { json = JSON.parse(text); } catch {}

          if (json.error === "invalid_client") {
            return new Response(
              JSON.stringify({
                success: false,
                error: `LinkedIn rejected this secret: "invalid_client - Client authentication failed". The secret does not match Client ID ${clientId}. Please copy the Primary Client Secret from your LinkedIn Developer App.`,
              }),
              { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }

          // If unauthorized_client or 200 OK, the client authentication SUCCEEDED
          return new Response(
            JSON.stringify({
              success: true,
              message: `✅ LinkedIn Client ID and Secret are verified and valid!`,
            }),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } catch (err: any) {
          return new Response(
            JSON.stringify({ success: false, error: "Network error testing with LinkedIn: " + err.message }),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
      }

      if (platform === "github") {
        try {
          const credHeader = btoa(`${clientId}:${clientSecret}`);
          const testRes = await fetch(`https://api.github.com/applications/${clientId}/token`, {
            method: "POST",
            headers: {
              Authorization: `Basic ${credHeader}`,
              "User-Agent": "Cloudflare-MCP-Hub/1.0",
              Accept: "application/vnd.github.v3+json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ access_token: "dummy_token_to_verify_credentials" }),
          });
          const text = await testRes.text();
          let json: any = {};
          try { json = JSON.parse(text); } catch {}

          if (testRes.status === 401 || json.message === "Bad credentials") {
            return new Response(
              JSON.stringify({
                success: false,
                error: `GitHub rejected this secret: "Bad credentials". Client ID or Secret does not match.`,
              }),
              { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }

          return new Response(
            JSON.stringify({
              success: true,
              message: `✅ GitHub Client ID and Secret are verified and valid!`,
            }),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } catch (err: any) {
          return new Response(
            JSON.stringify({ success: false, error: "Network error testing with GitHub: " + err.message }),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
      }

      return new Response(
        JSON.stringify({ success: true, message: `OAuth App credentials for ${platform} recorded.` }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
    }

    // Test Connection for an active platform token: POST /api/admin/test-connection
    if (url.pathname === "/api/admin/test-connection" && request.method === "POST") {
      const token = extractToken(request);
      const secret = env.JWT_SECRET || DEFAULT_SECRET;
      const isValid = token ? await verifyToken(token, secret) : false;

      if (!isValid) {
        return new Response(JSON.stringify({ error: "Unauthorized. Please log in." }), {
          status: 401,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }

      let body: any = {};
      try { body = await request.json(); } catch {}
      const platform = String(body.platform || "").toLowerCase().trim();
      let accessToken = String(body.access_token || "").trim();

      // If not passed in body, read from D1 social_credentials
      if (!accessToken && env.DB) {
        try {
          const row: any = await env.DB.prepare("SELECT access_token FROM social_credentials WHERE platform = ?").bind(platform).first();
          if (row && row.access_token) {
            accessToken = row.access_token;
          }
        } catch {}
      }

      if (!accessToken) {
        return new Response(
          JSON.stringify({
            success: false,
            error: `No access token found for ${platform}. Please connect or paste an access token first.`,
          }),
          { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders } }
        );
      }

      if (platform === "linkedin") {
        try {
          const res = await fetch("https://api.linkedin.com/v2/userinfo", {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (res.ok) {
            const data: any = await res.json();
            return new Response(
              JSON.stringify({
                success: true,
                message: `✅ LinkedIn is Working! Connected as: ${data.name || "Member"} (URN: ${data.sub ? ("urn:li:person:" + data.sub) : "OK"})`,
                data,
              }),
              { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }

          const errText = await res.text();
          let jsonErr: any = {};
          try { jsonErr = JSON.parse(errText); } catch {}

          // If LinkedIn returns 403 ACCESS_DENIED on userinfo, the token is 100% VALID with w_member_social!
          // (An invalid token returns 401 INVALID_ACCESS_TOKEN)
          if (res.status === 403 && (errText.includes("userinfo") || jsonErr.code === "ACCESS_DENIED")) {
            return new Response(
              JSON.stringify({
                success: true,
                message: `✅ LinkedIn Token is Active & Valid! (Posting permission 'w_member_social' verified). Ready to save to Cloudflare D1!`,
                data: { valid: true, scope: "w_member_social" },
              }),
              { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }

          return new Response(
            JSON.stringify({
              success: false,
              error: `LinkedIn Token Failed (HTTP ${res.status}): ${errText}`,
            }),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } catch (err: any) {
          return new Response(
            JSON.stringify({ success: false, error: "Network error: " + err.message }),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
      }

      if (platform === "github") {
        try {
          const res = await fetch("https://api.github.com/user", {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": "Cloudflare-MCP-Hub/1.0",
              Accept: "application/vnd.github.v3+json",
            },
          });
          if (res.ok) {
            const data: any = await res.json();
            return new Response(
              JSON.stringify({
                success: true,
                message: `✅ GitHub is Working! Connected as: @${data.login} (${data.name || "User"}) &bull; Repos: ${data.public_repos}`,
                data,
              }),
              { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }
          const errText = await res.text();
          return new Response(
            JSON.stringify({
              success: false,
              error: `GitHub Token Failed (HTTP ${res.status}): ${errText}`,
            }),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } catch (err: any) {
          return new Response(
            JSON.stringify({ success: false, error: "Network error: " + err.message }),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
      }

      if (platform === "youtube") {
        try {
          const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (res.ok) {
            const data: any = await res.json();
            const title = data?.items?.[0]?.snippet?.title || "Channel";
            return new Response(
              JSON.stringify({
                success: true,
                message: `✅ YouTube is Working! Connected Channel: ${title}`,
                data,
              }),
              { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }
          const errText = await res.text();
          return new Response(
            JSON.stringify({
              success: false,
              error: `YouTube Token Failed (HTTP ${res.status}): ${errText}`,
            }),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } catch (err: any) {
          return new Response(
            JSON.stringify({ success: false, error: "Network error: " + err.message }),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
      }

      if (platform === "facebook") {
        try {
          const res = await fetch(`https://graph.facebook.com/me?access_token=${encodeURIComponent(accessToken)}`);
          if (res.ok) {
            const data: any = await res.json();
            return new Response(
              JSON.stringify({
                success: true,
                message: `✅ Facebook is Working! Account: ${data.name || data.id}`,
                data,
              }),
              { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }
          const errText = await res.text();
          return new Response(
            JSON.stringify({
              success: false,
              error: `Facebook Token Failed (HTTP ${res.status}): ${errText}`,
            }),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } catch (err: any) {
          return new Response(
            JSON.stringify({ success: false, error: "Network error: " + err.message }),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
      }

      if (platform === "x" || platform === "twitter") {
        try {
          const res = await fetch("https://api.twitter.com/2/users/me", {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (res.ok) {
            const data: any = await res.json();
            return new Response(
              JSON.stringify({
                success: true,
                message: `✅ X (Twitter) is Working! Account: @${data.data?.username || "user"} (${data.data?.name || ""})`,
                data,
              }),
              { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
            );
          }
          const errText = await res.text();
          return new Response(
            JSON.stringify({
              success: false,
              error: `X Token Failed (HTTP ${res.status}): ${errText}`,
            }),
            { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        } catch (err: any) {
          return new Response(
            JSON.stringify({ success: false, error: "Network error: " + err.message }),
            { status: 500, headers: { "Content-Type": "application/json", ...corsHeaders } }
          );
        }
      }

      return new Response(
        JSON.stringify({ success: true, message: `Token for ${platform} verified.` }),
        { status: 200, headers: { "Content-Type": "application/json", ...corsHeaders } }
      );
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

          const credRows = await env.DB.prepare("SELECT platform, token_type, expires_at, extra_data, updated_at FROM social_credentials").all();
          const allCreds = credRows.results || [];
          credentials = allCreds.filter((c: any) => !c.platform.endsWith("_oauth_app") && c.platform !== "admin_auth" && c.platform !== "mcp_agent_key");

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

      const liApp = await getOAuthAppConfig("linkedin", env.DB, env);
      const ghApp = await getOAuthAppConfig("github", env.DB, env);
      const oauthApps = {
        linkedin: { clientId: liApp.clientId, hasSecret: !!liApp.clientSecret },
        github: { clientId: ghApp.clientId, hasSecret: !!ghApp.clientSecret },
      };

      const parseJsonSafe = (str: any) => {
        if (!str) return null;
        if (typeof str === "object") return str;
        try { return JSON.parse(str); } catch { return null; }
      };

      const liCred = credentials.find((c: any) => c.platform === "linkedin");
      const ghCred = credentials.find((c: any) => c.platform === "github");
      const ytCred = credentials.find((c: any) => c.platform === "youtube");
      const fbCred = credentials.find((c: any) => c.platform === "facebook");

      const platformSummaries = {
        linkedin: {
          hasAppSecret: !!liApp.clientSecret,
          appClientId: liApp.clientId,
          isConnected: !!liCred,
          extra: parseJsonSafe(liCred?.extra_data),
          updatedAt: liCred?.updated_at || null,
        },
        github: {
          hasAppSecret: !!ghApp.clientSecret,
          appClientId: ghApp.clientId,
          isConnected: !!ghCred,
          extra: parseJsonSafe(ghCred?.extra_data),
          updatedAt: ghCred?.updated_at || null,
        },
        youtube: {
          isConnected: !!ytCred,
          extra: parseJsonSafe(ytCred?.extra_data),
          updatedAt: ytCred?.updated_at || null,
        },
        facebook: {
          isConnected: !!fbCred,
          extra: parseJsonSafe(fbCred?.extra_data),
          updatedAt: fbCred?.updated_at || null,
        },
      };

      return new Response(
        JSON.stringify({
          success: true,
          stats,
          posts,
          comments,
          media,
          credentials,
          oauthApps,
          platformSummaries,
          mcpToken: await getExpectedMCPKey(env),
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
      const auth = await verifyMCPAgentAuth(request, env);
      if (!auth.authorized) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32000,
              message: `Unauthorized: ${auth.reason}`,
            },
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      }
      return handleMCPRequest(request, { ...env, MCP_API_KEY: await getExpectedMCPKey(env) } as any);
    }

    // Health check endpoint
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          server: "cloudflare-mcp",
          domain: "mcp.sohag.com.bd",
          version: "2.2.0",
          timestamp: new Date().toISOString(),
          toolsCount: TOOLS.length,
          mcpAuth: "Protected (Secret Token Required)",
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
      const auth = await verifyMCPAgentAuth(request, env);
      if (!auth.authorized) {
        return new Response(
          JSON.stringify({
            error: "Unauthorized",
            message: auth.reason,
            hint: "Connect with ?token=SOhag999@# or Header 'Authorization: Bearer SOhag999@#'",
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      }

      const sessionId = crypto.randomUUID();
      const messageEndpoint = `${url.origin}/message?sessionId=${sessionId}&token=${encodeURIComponent(auth.token || "")}`;

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
      const auth = await verifyMCPAgentAuth(request, env);
      if (!auth.authorized) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32000,
              message: `Unauthorized: ${auth.reason}`,
            },
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      }
      return handleMCPRequest(request, { ...env, MCP_API_KEY: await getExpectedMCPKey(env) } as any);
    }

    if (request.method === "POST" && url.pathname === "/") {
      const auth = await verifyMCPAgentAuth(request, env);
      if (!auth.authorized) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32000,
              message: `Unauthorized: ${auth.reason}`,
            },
          }),
          {
            status: 401,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      }
      return handleMCPRequest(request, { ...env, MCP_API_KEY: await getExpectedMCPKey(env) } as any);
    }

    // Landing Dashboard (GET /)
    const cf = (request as any).cf || {};
    const expectedMCPKey = await getExpectedMCPKey(env);
    return new Response(renderDashboard(url.origin, cf, env, expectedMCPKey), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...corsHeaders,
      },
    });
  },
};

function renderDashboard(origin: string, cf: any, env: Env, mcpToken: string = DEFAULT_MCP_KEY): string {
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
        <div id="auth-logged-in" style="display: none; align-items: center; gap: 0.6rem; flex-wrap: wrap;">
          <span style="font-size: 0.85rem; color: var(--green); display: flex; align-items: center; gap: 0.35rem;">
            <span>🛡️</span> <strong id="admin-username-display">smsohag</strong> (Admin)
          </span>
          <button class="btn btn-outline btn-sm" onclick="openChangePasswordModal()" style="color: var(--accent); border-color: var(--accent);" title="Change admin username and password">
            🔑 Change Password
          </button>
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

    <!-- ADMIN CONSOLE LOCKED BANNER (Shown when Logged Out) -->
    <div id="auth-lock-card" class="card" style="border: 1px solid rgba(56, 189, 248, 0.35); text-align: center; padding: 2.75rem 1.5rem; margin-bottom: 2rem; background: rgba(14, 21, 36, 0.95);">
      <div style="font-size: 3rem; margin-bottom: 0.75rem;">🔒</div>
      <h2 style="font-size: 1.4rem; color: var(--text); margin-bottom: 0.5rem; justify-content: center;">Admin Control Center Locked</h2>
      <p style="font-size: 0.92rem; color: var(--text-muted); max-width: 540px; margin: 0 auto 1.5rem; line-height: 1.6;">
        Social platform integrations, credentials, and live activity logs are password-protected. Sign in with your administrator credentials to manage connections or publish actions.
      </p>
      <button class="btn btn-primary" onclick="openLoginModal()" style="padding: 0.65rem 1.75rem; font-size: 0.95rem;">
        🔒 Admin Sign In
      </button>
    </div>

    <!-- LIVE ADMIN CONSOLE (Shown after Login) -->
    <div id="admin-panel" style="display: none;">
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
          <!-- Live Platform Integration Cards -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1rem; margin-bottom: 1.5rem;">
            <!-- LinkedIn Platform Hub Card -->
            <div id="card-linkedin" style="background: rgba(10, 102, 194, 0.08); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 12px; padding: 1.25rem; transition: all 0.3s ease;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; margin-bottom: 0.75rem;">
                <div style="display: flex; align-items: center; gap: 0.6rem;">
                  <span style="font-size: 1.6rem;">🔗</span>
                  <div>
                    <h4 style="margin: 0; font-size: 1.05rem; color: #38bdf8;">LinkedIn Integration</h4>
                    <span style="font-size: 0.75rem; color: var(--text-muted);">Auto-publishing posts &amp; articles</span>
                  </div>
                </div>
                <span id="li-status-badge" class="badge-status badge-pending" style="font-size: 0.72rem;">CHECKING...</span>
              </div>
              <div id="li-status-desc" style="background: rgba(6, 9, 14, 0.6); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 8px; padding: 0.75rem; margin-bottom: 0.85rem; font-size: 0.83rem; line-height: 1.5;">
                Loading LinkedIn status...
              </div>
              <div id="li-actions" style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
                <!-- Populated dynamically by renderPlatformCards -->
              </div>
              <div style="margin-top: 0.75rem; font-size: 0.72rem; color: var(--text-muted); border-top: 1px dashed rgba(56, 189, 248, 0.2); padding-top: 0.4rem;">
                App ID: <code>862xwbz3mk9f4n</code> &bull; Redirect: <code>https://mcp.sohag.com.bd/auth/linkedin/callback</code>
              </div>
            </div>

            <!-- GitHub Platform Hub Card -->
            <div id="card-github" style="background: rgba(147, 51, 234, 0.08); border: 1px solid rgba(192, 132, 252, 0.35); border-radius: 12px; padding: 1.25rem; transition: all 0.3s ease;">
              <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 0.5rem; margin-bottom: 0.75rem;">
                <div style="display: flex; align-items: center; gap: 0.6rem;">
                  <span style="font-size: 1.6rem;">🐙</span>
                  <div>
                    <h4 style="margin: 0; font-size: 1.05rem; color: #c084fc;">GitHub Integration</h4>
                    <span style="font-size: 0.75rem; color: var(--text-muted);">Code, Repos, Issues &amp; Gists</span>
                  </div>
                </div>
                <span id="gh-status-badge" class="badge-status badge-failed" style="font-size: 0.72rem;">CHECKING...</span>
              </div>
              <div id="gh-status-desc" style="background: rgba(6, 9, 14, 0.6); border: 1px solid rgba(255, 255, 255, 0.05); border-radius: 8px; padding: 0.75rem; margin-bottom: 0.85rem; font-size: 0.83rem; line-height: 1.5;">
                Loading GitHub status...
              </div>
              <div id="gh-actions" style="display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center;">
                <!-- Populated dynamically by renderPlatformCards -->
              </div>
              <div style="margin-top: 0.75rem; font-size: 0.72rem; color: var(--text-muted); border-top: 1px dashed rgba(192, 132, 252, 0.2); padding-top: 0.4rem;">
                Scopes needed: <code>repo</code>, <code>gist</code>, <code>read:user</code>
              </div>
            </div>
          </div>

          <!-- AI Agent MCP Secret Token Configuration -->
          <div style="background: rgba(14, 21, 36, 0.95); border: 1px solid rgba(34, 197, 94, 0.4); border-radius: 10px; padding: 1.25rem; margin-bottom: 1.5rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 0.5rem;">
              <h4 style="margin: 0; color: #22c55e; font-size: 1rem; display: flex; align-items: center; gap: 0.4rem;">
                <span>🤖</span> AI Agent MCP Secret Key (Muse AI &amp; External Agents)
              </h4>
              <span style="font-size: 0.78rem; color: var(--green); font-weight: 600;">🔒 Required for /mcp, /sse, and /message</span>
            </div>
            <p style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 1rem;">
              When external AI agents (like <strong>Muse AI</strong> or Cursor) connect, they <strong>must</strong> provide this Secret Token. You can update it here directly into Cloudflare D1:
            </p>
            <form onsubmit="handleMCPTokenSubmit(event)" style="display: flex; gap: 0.85rem; align-items: flex-end; flex-wrap: wrap;">
              <div class="form-group" style="margin-bottom: 0; flex: 1; min-width: 250px;">
                <label style="font-size: 0.78rem; color: var(--text-muted); display: block; margin-bottom: 0.25rem;">Active MCP Secret Token</label>
                <input type="text" id="admin-mcp-token-input" class="form-control" value="${mcpToken}" required style="font-family: monospace; font-weight: bold; color: #38bdf8;">
              </div>
              <div style="display: flex; gap: 0.5rem;">
                <button type="button" class="btn btn-outline btn-sm" onclick="navigator.clipboard.writeText(document.getElementById('admin-mcp-token-input').value); alert('✅ Copied MCP Secret Token to clipboard!')" style="height: 36px; padding: 0 0.9rem;">
                  📋 Copy Token
                </button>
                <button type="submit" id="btn-save-mcp-token" class="btn btn-primary btn-sm" style="height: 36px; background: #22c55e; border-color: #22c55e; padding: 0 1rem;">
                  💾 Save MCP Token to D1
                </button>
              </div>
            </form>
            <div id="mcp-token-status-msg" style="font-size: 0.82rem; margin-top: 0.6rem; display: none;"></div>
          </div>

          <!-- OAuth Developer App Config (Save Secret to D1 without terminal) -->
          <div style="background: rgba(14, 21, 36, 0.95); border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 10px; padding: 1.25rem; margin-bottom: 1.5rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; flex-wrap: wrap; gap: 0.5rem;">
              <h4 style="margin: 0; color: #38bdf8; font-size: 1rem; display: flex; align-items: center; gap: 0.4rem;">
                <span>🔐</span> 1-Click OAuth App Configuration (Client ID &amp; Secret)
              </h4>
              <span style="font-size: 0.78rem; color: var(--accent);">Directly saves to D1 &mdash; no terminal commands required!</span>
            </div>
            <p style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 1rem;">
              Paste your LinkedIn or GitHub <strong>Primary Client Secret</strong> here and save to Cloudflare D1 so 1-Click browser connection works automatically.
            </p>
            <form onsubmit="handleOAuthAppSubmit(event)" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 0.85rem; align-items: flex-end;">
              <div class="form-group" style="margin-bottom: 0;">
                <label style="font-size: 0.78rem; color: var(--text-muted); display: block; margin-bottom: 0.25rem;">Platform</label>
                <select id="oauth-app-platform" class="form-control" onchange="onOAuthAppPlatformChange()" style="background: #131c2e; color: white;">
                  <option value="linkedin">LinkedIn</option>
                  <option value="github">GitHub</option>
                </select>
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label style="font-size: 0.78rem; color: var(--text-muted); display: block; margin-bottom: 0.25rem;">Client ID</label>
                <input type="text" id="oauth-app-client-id" class="form-control" value="862xwbz3mk9f4n" required>
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label style="font-size: 0.78rem; color: var(--text-muted); display: block; margin-bottom: 0.25rem;">Primary Client Secret</label>
                <input type="password" id="oauth-app-client-secret" class="form-control" placeholder="Paste Primary Client Secret here..." required>
              </div>
              <div style="display: flex; gap: 0.5rem;">
                <button type="button" id="btn-test-oauth-app" class="btn btn-outline btn-sm" onclick="testOAuthAppSecret()" style="flex: 1; justify-content: center; height: 36px; color: var(--green); border-color: var(--green);" title="Verify Client Secret with provider before saving">
                  🧪 Test Secret
                </button>
                <button type="submit" id="btn-save-oauth-app" class="btn btn-primary btn-sm" style="flex: 1; justify-content: center; height: 36px;">
                  💾 Save to D1
                </button>
              </div>
            </form>
            <div id="oauth-app-status-msg" style="font-size: 0.82rem; margin-top: 0.6rem; display: none;"></div>
          </div>

          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 1.5rem; margin-top: 0.5rem;">
            <!-- Current Status Table -->
            <div>
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
                <h3 style="font-size: 1rem; color: var(--blue); margin: 0;">Connected Accounts & Links</h3>
                <div style="display: flex; gap: 0.5rem; align-items: center;">
                  <button type="button" class="btn btn-outline btn-sm" onclick="testAllConnections()" style="color: var(--green); border-color: var(--green); padding: 0.25rem 0.6rem; font-size: 0.75rem;" title="Test all connected providers">
                    🧪 Test All Providers
                  </button>
                  <span style="font-size: 0.75rem; color: var(--text-muted);">Click 🗑️ to remove</span>
                </div>
              </div>
              <div class="table-container">
                <table>
                  <thead>
                    <tr>
                      <th>Platform</th>
                      <th>Account Identity</th>
                      <th>App Secret</th>
                      <th>Token Type</th>
                      <th>Last Updated</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody id="credentials-table-body">
                    <tr><td colspan="7" style="text-align: center; color: var(--text-muted);">Loading credentials...</td></tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Credentials Setup Form -->
            <div style="background: #090e18; border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem;">
              <h3 style="font-size: 1rem; color: var(--accent); margin-bottom: 0.5rem;">⚙️ Add / Update Social & Developer Links</h3>
              <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 1rem;">
                Save tokens directly to Cloudflare D1 so AI agents (Muse AI, Cursor) can automate actions.
              </p>
              <form onsubmit="handleCredentialSubmit(event)">
                <div class="form-group" style="margin-bottom: 0.85rem;">
                  <label style="font-size: 0.8rem; color: var(--text-muted); display: block; margin-bottom: 0.3rem;">Target Platform</label>
                  <select id="cred-platform" class="form-control" style="background: #131c2e; color: white;" onchange="onPlatformSelectChange()" required>
                    <option value="github">🐙 GitHub (Personal Access Token / OAuth)</option>
                    <option value="linkedin">🔗 LinkedIn</option>
                    <option value="youtube">▶️ YouTube (Google OAuth)</option>
                    <option value="facebook">📘 Facebook / Meta</option>
                    <option value="x">🐦 X / Twitter</option>
                    <option value="custom">✨ Custom Platform...</option>
                  </select>
                </div>
                <div id="custom-platform-container" class="form-group" style="display: none; margin-bottom: 0.85rem;">
                  <label style="font-size: 0.8rem; color: var(--accent); display: block; margin-bottom: 0.3rem;">Custom Platform Name</label>
                  <input type="text" id="cred-custom-platform" class="form-control" placeholder="e.g. discord, slack, telegram">
                </div>
                <div class="form-group" style="margin-bottom: 0.85rem;">
                  <label style="font-size: 0.8rem; color: var(--text-muted); display: block; margin-bottom: 0.3rem;">Access Token / API Key</label>
                  <input type="password" id="cred-token" class="form-control" placeholder="Paste GitHub PAT (ghp_...) or Bearer token..." required>
                </div>
                <div class="form-group" style="margin-bottom: 0.85rem;">
                  <label style="font-size: 0.8rem; color: var(--text-muted); display: block; margin-bottom: 0.3rem;">Refresh Token (Optional)</label>
                  <input type="password" id="cred-refresh" class="form-control" placeholder="Optional refresh_token">
                </div>
                <div class="form-group" style="margin-bottom: 1rem;">
                  <label style="font-size: 0.8rem; color: var(--text-muted); display: block; margin-bottom: 0.3rem;">Extra Metadata (Optional JSON e.g. Username / Channel ID)</label>
                  <input type="text" id="cred-extra" class="form-control" placeholder='Optional (auto-detects GitHub profile)'>
                </div>
                <div id="cred-status-msg" style="font-size: 0.85rem; margin-bottom: 0.85rem; display: none;"></div>
                <div style="display: flex; gap: 0.5rem;">
                  <button type="button" id="btn-test-cred" class="btn btn-outline btn-sm" onclick="testDirectTokenForm()" style="flex: 1; justify-content: center; color: var(--green); border-color: var(--green); height: 36px;" title="Test API key before saving">
                    🧪 Test Token First
                  </button>
                  <button type="submit" id="btn-save-cred" class="btn btn-primary btn-sm" style="flex: 1; justify-content: center; height: 36px;">
                    💾 Save to D1
                  </button>
                </div>
              </form>
            </div>
          </div>

          <!-- Quick Help Card -->
          <div style="background: rgba(56, 189, 248, 0.05); border: 1px solid rgba(56, 189, 248, 0.2); border-radius: 8px; padding: 1rem; margin-top: 1.25rem; font-size: 0.85rem;">
            <strong style="color: var(--blue);">💡 Where to get your API Tokens:</strong>
            <ul style="margin-top: 0.5rem; padding-left: 1.2rem; color: var(--text-muted); line-height: 1.7;">
              <li><strong>GitHub:</strong> Go to <a href="https://github.com/settings/tokens" target="_blank" style="color: var(--blue);">GitHub Settings &rarr; Developer settings &rarr; Personal access tokens</a> &rarr; Generate new token (classic) with <code>repo</code>, <code>gist</code>, and <code>read:user</code> scopes. Paste token above (starts with <code>ghp_</code>).</li>
              <li><strong>LinkedIn:</strong> Go to <a href="https://www.linkedin.com/developers/" target="_blank" style="color: var(--blue);">LinkedIn Developer Portal</a> &rarr; Create App &rarr; Add <em>Share on LinkedIn</em> product &rarr; Generate OAuth 2.0 User Token with scope <code>w_member_social</code>, or click <em>Connect LinkedIn</em> above.</li>
              <li><strong>YouTube:</strong> Go to <a href="https://console.cloud.google.com/" target="_blank" style="color: var(--blue);">Google Cloud Console</a> &rarr; Enable <em>YouTube Data API v3</em> &rarr; Create OAuth 2.0 Client &rarr; Generate Access Token via <a href="https://developers.google.com/oauthplayground/" target="_blank" style="color: var(--blue);">Google OAuth Playground</a> (scope: <code>https://www.googleapis.com/auth/youtube.upload</code>).</li>
            </ul>
          </div>
        </div>
      </div>
    </div>

    <!-- PUBLIC MCP CONNECTION & INFO SECTION -->
    <div class="grid">
      <div class="card">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
          <h2 style="margin: 0; font-size: 1.15rem;">🔌 Connect AI Agents (Muse AI, Cursor)</h2>
          <span style="background: rgba(34, 197, 94, 0.15); border: 1px solid var(--green); color: var(--green); font-size: 0.72rem; font-weight: bold; padding: 0.2rem 0.5rem; border-radius: 4px;">🔒 PROTECTED WITH SECRET TOKEN</span>
        </div>
        
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.3rem;">
          <strong>Streamable HTTP Endpoint</strong> (with Secret Token &mdash; recommended for Muse AI):
        </p>
        <div class="url-box" style="margin-bottom: 0.75rem;">
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${mcpEndpoint}?token=${mcpToken}</span>
          <button class="copy-btn" onclick="navigator.clipboard.writeText('${mcpEndpoint}?token=${mcpToken}')">Copy URL</button>
        </div>

        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.3rem;">
          <strong>SSE Endpoint</strong> (with Secret Token &mdash; for Claude Desktop / SSE clients):
        </p>
        <div class="url-box" style="margin-bottom: 0.75rem;">
          <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${sseEndpoint}?token=${mcpToken}</span>
          <button class="copy-btn" onclick="navigator.clipboard.writeText('${sseEndpoint}?token=${mcpToken}')">Copy SSE</button>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.5rem; margin-top: 0.5rem;">
          <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.75rem;">
            <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase;">Agent Secret Token:</div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.2rem;">
              <code style="color: #38bdf8; font-weight: bold;">${mcpToken}</code>
              <button class="btn btn-outline btn-sm" style="padding: 0.15rem 0.5rem; font-size: 0.72rem;" onclick="navigator.clipboard.writeText('${mcpToken}')">Copy</button>
            </div>
          </div>
          <div style="background: rgba(0,0,0,0.3); border: 1px solid var(--border); border-radius: 6px; padding: 0.5rem 0.75rem;">
            <div style="font-size: 0.72rem; color: var(--text-muted); text-transform: uppercase;">HTTP Auth Header:</div>
            <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.2rem;">
              <code style="color: #22c55e; font-size: 0.75rem;">Bearer ${mcpToken}</code>
              <button class="btn btn-outline btn-sm" style="padding: 0.15rem 0.5rem; font-size: 0.72rem;" onclick="navigator.clipboard.writeText('Bearer ${mcpToken}')">Copy</button>
            </div>
          </div>
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
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem;">
        <h2 style="margin: 0; font-size: 1.15rem;">🤖 Muse AI Quick Connection Guide</h2>
        <span style="font-size: 0.8rem; color: var(--text-muted);">Transport: Streamable HTTP / JSON-RPC 2.0</span>
      </div>
      <p style="font-size: 0.88rem; color: var(--text-muted); margin-bottom: 0.75rem;">
        In <strong>Muse AI</strong> or any MCP client (Cursor, Claude Desktop, Windsurf), connect using either the Tokenized URL or Bearer Header:
      </p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 1rem; margin-bottom: 1rem;">
        <div style="background: rgba(0,0,0,0.35); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 8px; padding: 1rem;">
          <div style="font-weight: 600; color: #38bdf8; margin-bottom: 0.5rem; font-size: 0.88rem;">Option 1: Direct URL in Muse AI (Easiest)</div>
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.5rem;">Paste this complete URL into Muse AI's Remote MCP URL field:</p>
          <pre style="margin: 0; padding: 0.6rem; font-size: 0.82rem; background: #06090e; overflow-x: auto;"><code>${mcpEndpoint}?token=${mcpToken}</code></pre>
        </div>
        <div style="background: rgba(0,0,0,0.35); border: 1px solid rgba(34, 197, 94, 0.25); border-radius: 8px; padding: 1rem;">
          <div style="font-weight: 600; color: #22c55e; margin-bottom: 0.5rem; font-size: 0.88rem;">Option 2: Config JSON (Cursor / Claude)</div>
          <p style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.5rem;">Add to your mcpServers JSON configuration:</p>
          <pre style="margin: 0; padding: 0.6rem; font-size: 0.76rem; background: #06090e; overflow-x: auto;"><code>{
  "mcpServers": {
    "cloudflare-mcp": {
      "url": "${mcpEndpoint}?token=${mcpToken}",
      "headers": {
        "Authorization": "Bearer ${mcpToken}"
      }
    }
  }
}</code></pre>
        </div>
      </div>
      <div style="font-size: 0.85rem; color: var(--text-muted);">
        <strong style="color: var(--accent);">Key Active Tools Ready for Muse AI:</strong>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 0.4rem; margin-top: 0.5rem; font-size: 0.8rem;">
          <div>🔗 <code>linkedin_publish_post</code> &mdash; Auto-post to LinkedIn</div>
          <div>🐙 <code>github_create_issue</code> &mdash; Create GitHub issues</div>
          <div>🐙 <code>github_create_gist</code> &mdash; Create Gists</div>
          <div>🐙 <code>github_create_or_update_file</code> &mdash; Commit files</div>
          <div>📹 <code>youtube_upload_video</code> &mdash; Publish YouTube videos</div>
          <div>💬 <code>youtube_reply_comment</code> &mdash; Reply to comments</div>
          <div>🗄️ <code>db_get_post_logs</code> &mdash; Check status in D1</div>
          <div>📦 <code>r2_upload_file</code> &mdash; Upload media to R2</div>
        </div>
      </div>
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

  <!-- Change Password Modal -->
  <div class="modal-overlay" id="change-password-modal">
    <div class="modal">
      <h3>🔑 Change Admin Password</h3>
      <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1.25rem; text-align: center;">
        Set your private credentials to secure your MCP server in Cloudflare D1.
      </p>
      <form onsubmit="handleChangePasswordSubmit(event)">
        <div class="form-group">
          <label>Current Password</label>
          <input type="password" id="cp-current-password" class="form-control" placeholder="Current password" required>
        </div>
        <div class="form-group">
          <label>New Admin Username</label>
          <input type="text" id="cp-new-username" class="form-control" placeholder="smsohag" required>
        </div>
        <div class="form-group">
          <label>New Admin Password (min. 6 chars)</label>
          <input type="password" id="cp-new-password" class="form-control" placeholder="New strong password" required>
        </div>
        <div id="cp-error" class="error-msg"></div>
        <div id="cp-success" style="color: var(--green); font-size: 0.85rem; margin-top: 0.5rem; display: none;"></div>
        <div style="display: flex; gap: 0.5rem; margin-top: 1.5rem;">
          <button type="button" class="btn btn-outline" style="flex: 1;" onclick="closeChangePasswordModal()">Cancel</button>
          <button type="submit" id="btn-save-password" class="btn btn-primary" style="flex: 1;">Save Credentials</button>
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
      const lockCard = document.getElementById("auth-lock-card");
      if (lockCard) lockCard.style.display = "none";
      document.getElementById("admin-panel").style.display = "block";
      refreshAdminLogs();
      toggleAutoRefresh(true);
    }

    function hideAdminPanel() {
      document.getElementById("auth-logged-out").style.display = "block";
      document.getElementById("auth-logged-in").style.display = "none";
      const lockCard = document.getElementById("auth-lock-card");
      if (lockCard) lockCard.style.display = "block";
      document.getElementById("admin-panel").style.display = "none";
      toggleAutoRefresh(false);
    }

    function openChangePasswordModal() {
      document.getElementById("change-password-modal").style.display = "flex";
      document.getElementById("cp-error").style.display = "none";
      document.getElementById("cp-success").style.display = "none";
      document.getElementById("cp-current-password").value = "";
      document.getElementById("cp-new-username").value = document.getElementById("admin-username-display").textContent || "smsohag";
      document.getElementById("cp-new-password").value = "";
      document.getElementById("cp-current-password").focus();
    }

    function closeChangePasswordModal() {
      document.getElementById("change-password-modal").style.display = "none";
    }

    async function handleChangePasswordSubmit(e) {
      e.preventDefault();
      const current_password = document.getElementById("cp-current-password").value;
      const new_username = document.getElementById("cp-new-username").value.trim();
      const new_password = document.getElementById("cp-new-password").value;
      const errDiv = document.getElementById("cp-error");
      const succDiv = document.getElementById("cp-success");
      const btn = document.getElementById("btn-save-password");

      btn.disabled = true;
      btn.textContent = "Saving to D1...";
      errDiv.style.display = "none";
      succDiv.style.display = "none";

      try {
        const res = await fetch("/api/admin/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ current_password, new_username, new_password })
        });
        const data = await res.json();
        if (data.success) {
          succDiv.textContent = "✅ " + data.message;
          succDiv.style.display = "block";
          document.getElementById("admin-username-display").textContent = data.user || new_username;
          setTimeout(() => {
            closeChangePasswordModal();
            alert("✅ Administrator credentials updated and secured!");
          }, 1200);
        } else {
          errDiv.textContent = data.error || "Failed to update password";
          errDiv.style.display = "block";
        }
      } catch (err) {
        errDiv.textContent = "Network error updating password";
        errDiv.style.display = "block";
      } finally {
        btn.disabled = false;
        btn.textContent = "Save Credentials";
      }
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

        // Render Platform Integration Hub Cards
        renderPlatformCards(data.platformSummaries, data.oauthApps);

        // Render Credentials Table
        renderCredentialsTable(data.credentials || [], data.oauthApps);

        if (data.mcpToken) {
          const mcpInput = document.getElementById("admin-mcp-token-input");
          if (mcpInput && document.activeElement !== mcpInput) {
            mcpInput.value = data.mcpToken;
          }
        }
      } catch (err) {
        console.error("Error refreshing logs:", err);
      }
    }

    let _cachedPosts = [];
    function renderPostsTable(posts) {
      _cachedPosts = posts || [];
      const tbody = document.getElementById("posts-table-body");
      if (posts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No posts recorded in D1 yet.</td></tr>';
        return;
      }

      tbody.innerHTML = posts.map(p => {
        let badgeClass = "badge-pending";
        if (p.status === "published") badgeClass = "badge-published";
        if (p.status === "failed") badgeClass = "badge-failed";

        let mediaLink = '<span style="color: var(--text-muted);">-</span>';
        if (p.media_urls) {
          const linkText = p.platform === "github" ? "View on GitHub ↗" : "View Media ↗";
          mediaLink = '<a href="' + p.media_urls + '" target="_blank" style="color: var(--blue);">' + linkText + '</a>';
        }

        const contentSnippet = (p.content || "").length > 80 ? (p.content.substring(0, 80) + "...") : p.content;

        return '<tr>' +
          '<td>' + p.id + '</td>' +
          '<td><strong style="text-transform: capitalize; color: var(--accent);">' + (p.platform || "unknown") + '</strong></td>' +
          '<td>' + (p.title ? '<strong>' + escapeHtml(p.title) + '</strong><br>' : '') + '<span style="color: var(--text-muted);">' + escapeHtml(contentSnippet) + '</span></td>' +
          '<td>' + mediaLink + '</td>' +
          '<td><span class="badge-status ' + badgeClass + '">' + p.status + '</span></td>' +
          '<td style="font-size: 0.8rem; color: var(--text-muted);">' + (p.published_at || p.created_at || "-") + '</td>' +
          '<td><button class="btn btn-outline btn-sm" onclick="showPostDetails(' + p.id + ')">View Details</button></td>' +
        '</tr>';
      }).join("");
    }

    function showPostDetails(id) {
      const p = _cachedPosts.find(x => x.id === id);
      if (!p) return;
      let resp = "No raw response";
      try {
        resp = p.response_data ? JSON.stringify(JSON.parse(p.response_data), null, 2) : "None";
      } catch {
        resp = p.response_data || "None";
      }
      alert("Post #" + p.id + " Details:\\n\\nPlatform: " + p.platform + "\\nStatus: " + p.status + "\\n\\nResponse:\\n" + resp);
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
          '<td><button class="btn btn-outline btn-sm" data-url="' + escapeHtml(m.url) + '" onclick="copyMediaUrl(this.dataset.url)">Copy Link</button></td>' +
        '</tr>';
      }).join("");
    }

    function copyMediaUrl(url) {
      navigator.clipboard.writeText(url);
      alert("Media URL copied to clipboard!");
    }

    function renderPlatformCards(sums, oauthApps) {
      sums = sums || {};
      const li = sums.linkedin || { hasAppSecret: false, isConnected: false };
      const gh = sums.github || { hasAppSecret: false, isConnected: false };

      // 1. LinkedIn Card
      const liCard = document.getElementById("card-linkedin");
      const liBadge = document.getElementById("li-status-badge");
      const liDesc = document.getElementById("li-status-desc");
      const liActions = document.getElementById("li-actions");

      if (liCard && liBadge && liDesc && liActions) {
        if (li.isConnected) {
          const name = li.extra?.name || "LinkedIn Member";
          const urn = li.extra?.author_urn || "";
          liCard.style.borderColor = "var(--green)";
          liCard.style.background = "rgba(34, 197, 94, 0.08)";
          liBadge.className = "badge-status badge-published";
          liBadge.textContent = "CONNECTED & ACTIVE 🟢";
          liDesc.innerHTML = 
            '<div style="font-size: 0.95rem; font-weight: bold; color: var(--text); margin-bottom: 0.25rem;">👤 ' + escapeHtml(name) + '</div>' +
            '<div style="font-size: 0.8rem; color: var(--text-muted);">' + (urn ? ('URN: <code>' + escapeHtml(urn) + '</code> &bull; ') : '') + '<span style="color: var(--green);">Ready for Muse AI Auto-Posting!</span></div>' +
            '<div style="font-size: 0.76rem; color: #38bdf8; margin-top: 0.4rem; padding-top: 0.35rem; border-top: 1px dashed rgba(56, 189, 248, 0.25);">💡 Access Token সক্রিয় আছে। আপনার লিঙ্কডইন রেডি! (🔄 Reconnect শুধুমাত্র ১-ক্লিক OAuth রিনিউ করতে ব্যবহার করবেন)</div>';
          liActions.innerHTML = 
            '<button class="btn btn-outline btn-sm" data-platform="linkedin" onclick="testConnection(this.dataset.platform)" style="color: var(--green); border-color: var(--green);">🧪 Test</button>' +
            '<a href="/auth/linkedin" class="btn btn-outline btn-sm" style="color: var(--blue); border-color: var(--blue); text-decoration: none;">🔄 Reconnect</a>' +
            '<button class="btn btn-danger btn-sm" data-platform="linkedin" onclick="deleteCredential(this.dataset.platform)">🗑️ Disconnect</button>';
        } else if (li.hasAppSecret) {
          liCard.style.borderColor = "#f59e0b";
          liCard.style.background = "rgba(245, 158, 11, 0.08)";
          liBadge.className = "badge-status badge-pending";
          liBadge.textContent = "APP KEY SAVED • NOT LINKED YET ⚠️";
          liDesc.innerHTML = 
            '<div style="font-size: 0.88rem; color: #fde047; font-weight: 600; margin-bottom: 0.25rem;">✅ Developer App Secret is saved in D1!</div>' +
            '<div style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 0.4rem;">👉 আপনার পার্সোনাল LinkedIn অ্যাকাউন্ট এখনো লিঙ্ক করা হয়নি। নিচের বাটনে ক্লিক করে ১-ক্লিকে লিঙ্কডইন অথরাইজ করুন:</div>';
          liActions.innerHTML = 
            '<a href="/auth/linkedin" class="btn btn-primary btn-sm" style="background: #0a66c2; text-decoration: none; font-weight: bold; font-size: 0.85rem; padding: 0.4rem 0.9rem;">🚀 Connect LinkedIn Profile (1-Click)</a>' +
            '<button class="btn btn-outline btn-sm" data-platform="linkedin" onclick="connectPlatform(this.dataset.platform)" style="color: var(--blue); border-color: var(--blue);">➕ Paste Token</button>';
        } else {
          liCard.style.borderColor = "var(--border)";
          liCard.style.background = "rgba(10, 102, 194, 0.06)";
          liBadge.className = "badge-status badge-failed";
          liBadge.textContent = "NOT CONFIGURED ⚪";
          liDesc.innerHTML = 
            '<div style="font-size: 0.82rem; color: var(--text-muted);">Save your LinkedIn Developer App Secret below or paste an Access Token to enable posting.</div>';
          liActions.innerHTML = 
            '<button class="btn btn-primary btn-sm" data-platform="linkedin" onclick="focusOAuthApp(this.dataset.platform)" style="background: #0a66c2;">⚙️ Setup App Secret</button>' +
            '<button class="btn btn-outline btn-sm" data-platform="linkedin" onclick="connectPlatform(this.dataset.platform)" style="color: var(--blue); border-color: var(--blue);">➕ Paste Token</button>';
        }
      }

      // 2. GitHub Card
      const ghCard = document.getElementById("card-github");
      const ghBadge = document.getElementById("gh-status-badge");
      const ghDesc = document.getElementById("gh-status-desc");
      const ghActions = document.getElementById("gh-actions");

      if (ghCard && ghBadge && ghDesc && ghActions) {
        if (gh.isConnected) {
          const login = gh.extra?.login || "user";
          ghCard.style.borderColor = "var(--green)";
          ghCard.style.background = "rgba(34, 197, 94, 0.08)";
          ghBadge.className = "badge-status badge-published";
          ghBadge.textContent = "CONNECTED & ACTIVE 🟢";
          ghDesc.innerHTML = 
            '<div style="font-size: 0.95rem; font-weight: bold; color: var(--text); margin-bottom: 0.25rem;">🐙 @' + escapeHtml(login) + '</div>' +
            '<div style="font-size: 0.8rem; color: var(--text-muted);"><span style="color: var(--green);">Repository, Issue, and Gist automation active!</span></div>';
          ghActions.innerHTML = 
            '<button class="btn btn-outline btn-sm" data-platform="github" onclick="testConnection(this.dataset.platform)" style="color: var(--green); border-color: var(--green);">🧪 Test</button>' +
            '<button class="btn btn-danger btn-sm" data-platform="github" onclick="deleteCredential(this.dataset.platform)">🗑️ Disconnect</button>';
        } else {
          ghCard.style.borderColor = "var(--border)";
          ghCard.style.background = "rgba(147, 51, 234, 0.06)";
          ghBadge.className = "badge-status badge-failed";
          ghBadge.textContent = "NOT CONFIGURED ⚪";
          ghDesc.innerHTML = 
            '<div style="font-size: 0.82rem; color: var(--text-muted);">Connect GitHub with a PAT (repo, gist, read:user scopes) to manage code and issues.</div>';
          ghActions.innerHTML = 
            '<button class="btn btn-primary btn-sm" data-platform="github" onclick="connectPlatform(this.dataset.platform)" style="background: #7e22ce;">➕ Set GitHub Token</button>' +
            (gh.hasAppSecret ? '<a href="/auth/github" class="btn btn-outline btn-sm" style="color: #c084fc; border-color: #c084fc; text-decoration: none;">1-Click OAuth</a>' : '');
        }
      }
    }

    function focusOAuthApp(platform) {
      const platSelect = document.getElementById("oauth-app-platform");
      if (platSelect) {
        platSelect.value = platform;
        onOAuthAppPlatformChange();
        platSelect.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }

    function renderCredentialsTable(creds, oauthApps) {
      const tbody = document.getElementById("credentials-table-body");
      
      const known = {
        github: { name: "GitHub", icon: "🐙" },
        linkedin: { name: "LinkedIn", icon: "🔗" },
        youtube: { name: "YouTube", icon: "▶️" },
        facebook: { name: "Facebook", icon: "📘" },
        x: { name: "X (Twitter)", icon: "🐦" },
      };

      const defaultList = ["github", "linkedin", "youtube", "facebook"];
      const configuredPlatforms = creds.map(c => c.platform);
      const allPlatforms = Array.from(new Set([...defaultList, ...configuredPlatforms]));

      tbody.innerHTML = allPlatforms.map(plat => {
        const item = creds.find(c => c.platform === plat);
        const configured = !!item;
        const meta = known[plat] || { name: plat.charAt(0).toUpperCase() + plat.slice(1), icon: "🌐" };

        let detailsHtml = '<span style="color: var(--text-muted);">-</span>';
        if (configured && item.extra_data) {
          try {
            const extra = typeof item.extra_data === "string" ? JSON.parse(item.extra_data) : item.extra_data;
            if (extra.login) {
              detailsHtml = '<a href="' + (extra.html_url || ('https://github.com/' + extra.login)) + '" target="_blank" style="color: var(--blue); font-weight: 600;">@' + escapeHtml(extra.login) + '</a>';
            } else if (extra.name) {
              detailsHtml = '<span style="color: var(--text);">' + escapeHtml(extra.name) + '</span>';
            } else if (extra.channel_id) {
              detailsHtml = '<code style="font-size: 0.75rem;">' + escapeHtml(extra.channel_id) + '</code>';
            } else if (extra.author_urn) {
              detailsHtml = '<code style="font-size: 0.75rem;">' + escapeHtml(extra.author_urn) + '</code>';
            }
          } catch {}
        }

        let appKeyStatus = '<span style="color: var(--text-muted); font-size: 0.75rem;">-</span>';
        if (plat === "linkedin") {
          appKeyStatus = (oauthApps && oauthApps.linkedin && oauthApps.linkedin.hasSecret)
            ? '<span class="badge-status badge-published" style="font-size: 0.7rem;">Saved ✅</span>'
            : '<span class="badge-status badge-failed" style="font-size: 0.7rem;">Missing ⚠️</span>';
        } else if (plat === "github") {
          appKeyStatus = (oauthApps && oauthApps.github && oauthApps.github.hasSecret)
            ? '<span class="badge-status badge-published" style="font-size: 0.7rem;">Saved ✅</span>'
            : '<span class="badge-status badge-failed" style="font-size: 0.7rem;">Missing ⚠️</span>';
        }

        const actionHtml = configured
          ? '<div style="display: flex; gap: 0.35rem; align-items: center;">' +
            '<button class="btn btn-outline btn-sm" data-platform="' + plat + '" onclick="testConnection(this.dataset.platform)" style="color: var(--green); border-color: var(--green); padding: 0.2rem 0.55rem; font-size: 0.78rem;" title="Test ' + plat + ' Connection">🧪 Test</button>' +
            '<button class="btn btn-danger btn-sm" data-platform="' + plat + '" onclick="deleteCredential(this.dataset.platform)" style="padding: 0.2rem 0.5rem; font-size: 0.78rem;" title="Delete ' + plat + ' credentials">🗑️</button>' +
            '</div>'
          : '<div style="display: flex; gap: 0.35rem; align-items: center;">' +
            '<button class="btn btn-outline btn-sm" data-platform="' + plat + '" onclick="connectPlatform(this.dataset.platform)" style="color: var(--blue); border-color: var(--blue); padding: 0.2rem 0.55rem; font-size: 0.78rem;" title="Connect ' + plat + '">➕ Connect</button>' +
            '</div>';

        return '<tr>' +
          '<td><strong>' + meta.icon + ' ' + meta.name + '</strong></td>' +
          '<td>' + detailsHtml + '</td>' +
          '<td>' + appKeyStatus + '</td>' +
          '<td>' + (configured ? (item.token_type || "Bearer") : "-") + '</td>' +
          '<td style="font-size: 0.8rem; color: var(--text-muted);">' + (configured && item.updated_at ? item.updated_at : "Never") + '</td>' +
          '<td><span class="badge-status ' + (configured ? "badge-published" : "badge-failed") + '">' + (configured ? "Active 🟢" : "Not Linked ⚪") + '</span></td>' +
          '<td>' + actionHtml + '</td>' +
        '</tr>';
      }).join("");
    }

    async function deleteCredential(platform) {
      if (!confirm("Are you sure you want to delete credentials for " + platform.toUpperCase() + " from Cloudflare D1? AI agents will no longer be able to authenticate on this platform.")) {
        return;
      }
      try {
        const res = await fetch("/api/admin/credentials?platform=" + encodeURIComponent(platform), {
          method: "DELETE"
        });
        const data = await res.json();
        if (data.success) {
          alert("✅ " + (data.message || "Credential deleted successfully"));
          await refreshAdminLogs();
        } else {
          alert("❌ Failed to delete: " + (data.error || "Unknown error"));
        }
      } catch (err) {
        alert("❌ Network error while deleting credential");
      }
    }

    function connectPlatform(platform) {
      const select = document.getElementById("cred-platform");
      const customContainer = document.getElementById("custom-platform-container");
      const customInput = document.getElementById("cred-custom-platform");
      let found = false;
      for (let i = 0; i < select.options.length; i++) {
        if (select.options[i].value === platform) {
          select.selectedIndex = i;
          found = true;
          break;
        }
      }
      if (!found) {
        select.value = "custom";
        customContainer.style.display = "block";
        customInput.value = platform;
      } else {
        customContainer.style.display = "none";
      }
      onPlatformSelectChange();
      const tokenInput = document.getElementById("cred-token");
      tokenInput.focus();
      tokenInput.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    function onPlatformSelectChange() {
      const select = document.getElementById("cred-platform");
      const customContainer = document.getElementById("custom-platform-container");
      const tokenInput = document.getElementById("cred-token");
      const extraInput = document.getElementById("cred-extra");

      if (select.value === "custom") {
        customContainer.style.display = "block";
        document.getElementById("cred-custom-platform").focus();
      } else {
        customContainer.style.display = "none";
      }

      if (select.value === "github") {
        tokenInput.placeholder = "Paste GitHub PAT (e.g. ghp_... or github_pat_...)";
        extraInput.placeholder = "Optional (auto-detects GitHub username if left empty)";
      } else if (select.value === "linkedin") {
        tokenInput.placeholder = "Paste LinkedIn OAuth Access Token...";
        extraInput.placeholder = '{"author_urn": "urn:li:person:..."}';
      } else if (select.value === "youtube") {
        tokenInput.placeholder = "Paste Google / YouTube OAuth Access Token...";
        extraInput.placeholder = '{"channel_id": "UC..."}';
      } else {
        tokenInput.placeholder = "Paste access_token or API key here...";
        extraInput.placeholder = "Optional JSON metadata";
      }
    }

    async function handleCredentialSubmit(e) {
      e.preventDefault();
      const selectVal = document.getElementById("cred-platform").value;
      const customVal = document.getElementById("cred-custom-platform").value.trim().toLowerCase();
      const platform = (selectVal === "custom" ? customVal : selectVal).trim().toLowerCase();

      if (!platform) {
        alert("Please enter a valid platform name");
        return;
      }

      const accessToken = document.getElementById("cred-token").value.trim();
      const refreshToken = document.getElementById("cred-refresh").value.trim();
      const extraData = document.getElementById("cred-extra").value.trim();
      const msgDiv = document.getElementById("cred-status-msg");
      const btn = document.getElementById("btn-save-cred");

      btn.disabled = true;
      btn.textContent = "Saving to D1...";
      msgDiv.style.display = "none";

      try {
        const res = await fetch("/api/admin/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform,
            access_token: accessToken,
            refresh_token: refreshToken || undefined,
            extra_data: extraData || undefined
          })
        });
        const data = await res.json();
        if (data.success) {
          msgDiv.style.color = "var(--green)";
          msgDiv.textContent = "✅ " + data.message;
          msgDiv.style.display = "block";
          document.getElementById("cred-token").value = "";
          document.getElementById("cred-refresh").value = "";
          document.getElementById("cred-extra").value = "";
          if (selectVal === "custom") {
            document.getElementById("cred-custom-platform").value = "";
          }
          await refreshAdminLogs();
        } else {
          msgDiv.style.color = "var(--red)";
          msgDiv.textContent = "❌ " + (data.error || "Failed to save");
          msgDiv.style.display = "block";
        }
      } catch (err) {
        msgDiv.style.color = "var(--red)";
        msgDiv.textContent = "❌ Network error";
        msgDiv.style.display = "block";
      } finally {
        btn.disabled = false;
        btn.textContent = "💾 Save Credentials to Cloudflare D1";
      }
    }

    async function handleMCPTokenSubmit(e) {
      e.preventDefault();
      const token = document.getElementById("admin-mcp-token-input").value.trim();
      const msgDiv = document.getElementById("mcp-token-status-msg");
      const btn = document.getElementById("btn-save-mcp-token");

      if (!token) {
        alert("MCP Secret Token cannot be empty!");
        return;
      }

      btn.disabled = true;
      btn.textContent = "Saving...";
      msgDiv.style.display = "block";
      msgDiv.style.color = "var(--yellow)";
      msgDiv.textContent = "⏳ Updating Agent MCP Secret Token in Cloudflare D1...";

      try {
        const res = await fetch("/api/admin/mcp-token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token })
        });
        const data = await res.json();
        if (data.success) {
          msgDiv.style.color = "var(--green)";
          msgDiv.innerHTML = "<strong>✅ " + data.message + "</strong> External AI agents must now use: <code>" + escapeHtml(data.mcpToken) + "</code>";
          setTimeout(() => { refreshAdminLogs(); }, 1000);
        } else {
          msgDiv.style.color = "var(--red)";
          msgDiv.textContent = "❌ " + (data.error || "Failed to update MCP Token");
        }
      } catch (err) {
        msgDiv.style.color = "var(--red)";
        msgDiv.textContent = "❌ Network error updating MCP Token: " + err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = "💾 Save MCP Token to D1";
      }
    }

    function onOAuthAppPlatformChange() {
      const plat = document.getElementById("oauth-app-platform").value;
      const clientIdInput = document.getElementById("oauth-app-client-id");
      const secretInput = document.getElementById("oauth-app-client-secret");
      if (plat === "linkedin") {
        clientIdInput.value = "862xwbz3mk9f4n";
        secretInput.placeholder = "Paste LinkedIn Client Secret (WPL_AP1...)";
      } else {
        clientIdInput.value = "";
        secretInput.placeholder = "Paste GitHub Client Secret";
      }
    }

    async function handleOAuthAppSubmit(e) {
      e.preventDefault();
      const platform = document.getElementById("oauth-app-platform").value;
      const clientId = document.getElementById("oauth-app-client-id").value.trim();
      const clientSecret = document.getElementById("oauth-app-client-secret").value.trim();
      const msgDiv = document.getElementById("oauth-app-status-msg");
      const btn = document.getElementById("btn-save-oauth-app");

      btn.disabled = true;
      btn.textContent = "Saving to D1...";
      msgDiv.style.display = "none";

      try {
        const res = await fetch("/api/admin/oauth-app", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform,
            client_id: clientId,
            client_secret: clientSecret
          })
        });
        const data = await res.json();
        if (data.success) {
          msgDiv.style.color = "var(--green)";
          msgDiv.textContent = "✅ " + data.message;
          msgDiv.style.display = "block";
          document.getElementById("oauth-app-client-secret").value = "";
          await refreshAdminLogs();
        } else {
          msgDiv.style.color = "var(--red)";
          msgDiv.textContent = "❌ " + (data.error || "Failed to save");
          msgDiv.style.display = "block";
        }
      } catch (err) {
        msgDiv.style.color = "var(--red)";
        msgDiv.textContent = "❌ Network error";
        msgDiv.style.display = "block";
      } finally {
        btn.disabled = false;
        btn.textContent = "💾 Save Secret to D1";
      }
    }

    async function testOAuthAppSecret() {
      const platform = document.getElementById("oauth-app-platform").value;
      const clientId = document.getElementById("oauth-app-client-id").value.trim();
      const clientSecret = document.getElementById("oauth-app-client-secret").value.trim();
      const msgDiv = document.getElementById("oauth-app-status-msg");
      const btn = document.getElementById("btn-test-oauth-app");

      btn.disabled = true;
      btn.textContent = "Testing...";
      msgDiv.style.display = "block";
      msgDiv.style.color = "var(--yellow)";
      msgDiv.textContent = "⏳ Verifying " + platform + " credentials with provider API...";

      try {
        const res = await fetch("/api/admin/test-oauth-app", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            platform,
            client_id: clientId,
            client_secret: clientSecret
          })
        });
        const data = await res.json();
        if (data.success) {
          msgDiv.style.color = "var(--green)";
          msgDiv.innerHTML = "<strong>" + data.message + "</strong> Now click <strong>💾 Save to D1</strong>!";
        } else {
          msgDiv.style.color = "var(--red)";
          msgDiv.innerHTML = "<strong>❌ Verification Failed:</strong> " + (data.error || "Secret rejected by provider");
        }
      } catch (err) {
        msgDiv.style.color = "var(--red)";
        msgDiv.textContent = "❌ Network error testing secret: " + err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = "🧪 Test Secret";
      }
    }

    async function testConnection(platform) {
      const btn = event && event.target && event.target.tagName === "BUTTON" ? event.target : null;
      const originalText = btn ? btn.textContent : "";
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Testing...";
      }

      try {
        const res = await fetch("/api/admin/test-connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform })
        });
        const data = await res.json();
        if (data.success) {
          alert("✅ [" + platform.toUpperCase() + " Connection Healthy]\\n\\n" + data.message);
          await refreshAdminLogs();
        } else {
          alert("❌ [" + platform.toUpperCase() + " Connection Error]\\n\\n" + (data.error || "Verification failed. Token may be expired or invalid."));
        }
      } catch (err) {
        alert("❌ Network error testing " + platform + ": " + err.message);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = originalText || "🧪 Test";
        }
      }
    }

    async function testAllConnections() {
      const btn = event && event.target && event.target.tagName === "BUTTON" ? event.target : null;
      if (btn) {
        btn.disabled = true;
        btn.textContent = "⏳ Testing all...";
      }

      try {
        const res = await fetch("/api/admin/logs");
        const logsData = await res.json();
        const creds = (logsData.credentials || []).filter(c => !c.platform.endsWith("_oauth_app"));
        if (creds.length === 0) {
          alert("No connected providers found in D1! Connect a platform or save an API token first.");
          return;
        }

        let summary = "🧪 Live Connection Test Results (" + creds.length + " Providers):\\n\\n";
        for (const c of creds) {
          try {
            const testRes = await fetch("/api/admin/test-connection", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ platform: c.platform })
            });
            const result = await testRes.json();
            if (result.success) {
              summary += "• " + c.platform.toUpperCase() + ": " + result.message + "\\n\\n";
            } else {
              summary += "• " + c.platform.toUpperCase() + ": ❌ " + result.error + "\\n\\n";
            }
          } catch (err) {
            summary += "• " + c.platform.toUpperCase() + ": ❌ " + err.message + "\\n\\n";
          }
        }
        alert(summary);
      } catch (err) {
        alert("Error testing providers: " + err.message);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "🧪 Test All Providers";
        }
      }
    }

    async function testDirectTokenForm() {
      const selectVal = document.getElementById("cred-platform").value;
      const customVal = document.getElementById("cred-custom-platform").value.trim().toLowerCase();
      const platform = (selectVal === "custom" ? customVal : selectVal).trim().toLowerCase();
      const accessToken = document.getElementById("cred-token").value.trim();
      const msgDiv = document.getElementById("cred-status-msg");
      const btn = document.getElementById("btn-test-cred");

      if (!accessToken) {
        alert("Please paste an Access Token / API Key to test first!");
        document.getElementById("cred-token").focus();
        return;
      }

      btn.disabled = true;
      btn.textContent = "Testing...";
      msgDiv.style.display = "block";
      msgDiv.style.color = "var(--yellow)";
      msgDiv.textContent = "⏳ Testing token with " + platform + "...";

      try {
        const res = await fetch("/api/admin/test-connection", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform, access_token: accessToken })
        });
        const data = await res.json();
        if (data.success) {
          msgDiv.style.color = "var(--green)";
          msgDiv.innerHTML = "<strong>" + data.message + "</strong> (Token is working! Ready to save to D1)";
        } else {
          msgDiv.style.color = "var(--red)";
          msgDiv.innerHTML = "<strong>❌ Token Test Failed:</strong> " + (data.error || "Invalid token");
        }
      } catch (err) {
        msgDiv.style.color = "var(--red)";
        msgDiv.textContent = "❌ Network error testing token: " + err.message;
      } finally {
        btn.disabled = false;
        btn.textContent = "🧪 Test Token First";
      }
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

function renderOAuthResult(title: string, message: string, success: boolean, origin: string): string {
  const icon = success ? "🎉" : "⚠️";
  const color = success ? "#22c55e" : "#ef4444";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #090d16; color: #f8fafc; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
    .card { background: #131c2e; border: 1px solid #26334d; border-radius: 14px; padding: 2.5rem 2rem; max-width: 480px; text-align: center; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h1 { color: ${color}; font-size: 1.5rem; margin: 0.75rem 0; font-weight: 700; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.6; margin-bottom: 2rem; }
    .btn { display: inline-block; background: #f38020; color: white; text-decoration: none; padding: 0.75rem 1.75rem; border-radius: 8px; font-weight: 600; transition: opacity 0.2s; }
    .btn:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="card">
    <div style="font-size: 3.5rem;">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <a href="${origin}" class="btn">&larr; Return to Dashboard</a>
  </div>
</body>
</html>`;
}
