import { MCPToolDefinition, MCPToolResult } from "../mcp/types";
import { ToolContext } from "./general";

export const GITHUB_TOOLS: MCPToolDefinition[] = [
  {
    name: "github_get_user",
    description: "Fetch GitHub profile details for the authenticated user or any specified GitHub username.",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "Optional GitHub username. If omitted, returns the authenticated user profile.",
        },
        access_token: {
          type: "string",
          description: "Optional GitHub PAT / token. If omitted, uses token stored in D1.",
        },
      },
    },
  },
  {
    name: "github_list_repositories",
    description: "List GitHub repositories for the authenticated user or a specific user/organization.",
    inputSchema: {
      type: "object",
      properties: {
        username: {
          type: "string",
          description: "Optional GitHub username or org. If omitted, lists repositories of the authenticated user.",
        },
        sort: {
          type: "string",
          description: "Sort order: 'created', 'updated', 'pushed', or 'full_name'",
          enum: ["created", "updated", "pushed", "full_name"],
          default: "updated",
        },
        limit: {
          type: "number",
          description: "Number of repositories to return (max: 100, default: 20)",
          default: 20,
        },
        access_token: {
          type: "string",
          description: "Optional GitHub PAT / token (if not configured in D1).",
        },
      },
    },
  },
  {
    name: "github_get_repository",
    description: "Get detailed information about a specific GitHub repository (stars, forks, description, default branch, language).",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "GitHub repository owner (username or organization)",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        access_token: {
          type: "string",
          description: "Optional GitHub access token (if repository is private or not configured in D1).",
        },
      },
      required: ["owner", "repo"],
    },
  },
  {
    name: "github_create_issue",
    description: "Create an issue in a GitHub repository and log it to Cloudflare D1 database.",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        title: {
          type: "string",
          description: "Title of the issue",
        },
        body: {
          type: "string",
          description: "Markdown body content of the issue",
        },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of issue label names",
        },
        access_token: {
          type: "string",
          description: "GitHub access token with 'repo' scope (if not configured in D1).",
        },
      },
      required: ["owner", "repo", "title", "body"],
    },
  },
  {
    name: "github_create_gist",
    description: "Create a GitHub Gist (public or secret) with code or notes, and record it in D1 database.",
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "Description of the gist",
        },
        filename: {
          type: "string",
          description: "Filename (e.g. 'snippet.js' or 'solution.md')",
        },
        content: {
          type: "string",
          description: "Text content of the file",
        },
        is_public: {
          type: "boolean",
          description: "Whether the gist is public (true) or secret (false). Default: false.",
          default: false,
        },
        access_token: {
          type: "string",
          description: "GitHub access token with 'gist' scope (if not configured in D1).",
        },
      },
      required: ["description", "filename", "content"],
    },
  },
  {
    name: "github_create_or_update_file",
    description: "Create or update a file in a GitHub repository directly with a commit message.",
    inputSchema: {
      type: "object",
      properties: {
        owner: {
          type: "string",
          description: "Repository owner",
        },
        repo: {
          type: "string",
          description: "Repository name",
        },
        path: {
          type: "string",
          description: "File path in repository (e.g. 'README.md' or 'src/config.json')",
        },
        content: {
          type: "string",
          description: "File text content to commit",
        },
        message: {
          type: "string",
          description: "Commit message",
        },
        branch: {
          type: "string",
          description: "Optional branch name (defaults to repository default branch)",
        },
        sha: {
          type: "string",
          description: "Blob SHA of the file if updating an existing file (required by GitHub when updating).",
        },
        access_token: {
          type: "string",
          description: "GitHub access token with 'repo' scope (if not configured in D1).",
        },
      },
      required: ["owner", "repo", "path", "content", "message"],
    },
  },
];

async function getStoredGitHubToken(db: any, env: any): Promise<{ token: string | null; extra: any }> {
  if (db) {
    try {
      const row = await db.prepare("SELECT access_token, extra_data FROM social_credentials WHERE platform = 'github'").first();
      if (row && row.access_token) {
        let extra: any = {};
        try { extra = JSON.parse(row.extra_data || "{}"); } catch {}
        return { token: row.access_token, extra };
      }
    } catch {}
  }

  if (env.GITHUB_ACCESS_TOKEN) {
    return { token: env.GITHUB_ACCESS_TOKEN, extra: {} };
  }

  return { token: null, extra: {} };
}

function getGitHubHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": "Cloudflare-MCP-Hub/1.0",
    "Accept": "application/vnd.github.v3+json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export async function executeGithubTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<MCPToolResult | null> {
  const db = ctx.env.DB as any;

  switch (name) {
    case "github_get_user": {
      const username = args.username ? String(args.username).trim() : "";
      const { token: storedToken } = await getStoredGitHubToken(db, ctx.env);
      const token = String(args.access_token || storedToken || "").trim();

      const url = username
        ? `https://api.github.com/users/${encodeURIComponent(username)}`
        : "https://api.github.com/user";

      if (!username && !token) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "GitHub token required to get authenticated user profile, or specify 'username'.",
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const res = await fetch(url, { headers: getGitHubHeaders(token) });
      const data = await res.json() as any;

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    }

    case "github_list_repositories": {
      const username = args.username ? String(args.username).trim() : "";
      const sort = String(args.sort || "updated");
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
      const { token: storedToken } = await getStoredGitHubToken(db, ctx.env);
      const token = String(args.access_token || storedToken || "").trim();

      let url = username
        ? `https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=${sort}&per_page=${limit}`
        : `https://api.github.com/user/repos?sort=${sort}&per_page=${limit}`;

      if (!username && !token) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: "GitHub token required to list repositories, or provide a public 'username'.",
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const res = await fetch(url, { headers: getGitHubHeaders(token) });
      const data = await res.json() as any;

      if (!res.ok) {
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          isError: true,
        };
      }

      const repos = Array.isArray(data)
        ? data.map((r: any) => ({
            id: r.id,
            name: r.name,
            full_name: r.full_name,
            private: r.private,
            html_url: r.html_url,
            description: r.description,
            fork: r.fork,
            stargazers_count: r.stargazers_count,
            language: r.language,
            updated_at: r.updated_at,
          }))
        : data;

      return {
        content: [{ type: "text", text: JSON.stringify({ count: Array.isArray(repos) ? repos.length : 0, repositories: repos }, null, 2) }],
        isError: false,
      };
    }

    case "github_get_repository": {
      const owner = String(args.owner || "").trim();
      const repo = String(args.repo || "").trim();
      const { token: storedToken } = await getStoredGitHubToken(db, ctx.env);
      const token = String(args.access_token || storedToken || "").trim();

      if (!owner || !repo) {
        return {
          content: [{ type: "text", text: "Error: Both 'owner' and 'repo' are required." }],
          isError: true,
        };
      }

      const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
        headers: getGitHubHeaders(token),
      });
      const data = await res.json() as any;

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    }

    case "github_create_issue": {
      const owner = String(args.owner || "").trim();
      const repo = String(args.repo || "").trim();
      const title = String(args.title || "").trim();
      const body = String(args.body || "").trim();
      const labels = Array.isArray(args.labels)
        ? args.labels
        : typeof args.labels === "string"
        ? args.labels.split(",").map((l: string) => l.trim()).filter(Boolean)
        : undefined;

      const { token: storedToken } = await getStoredGitHubToken(db, ctx.env);
      const token = String(args.access_token || storedToken || "").trim();

      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "GitHub token missing. Please provide 'access_token' or set it in the dashboard (platform='github').",
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const payload: any = { title, body };
      if (labels && labels.length > 0) payload.labels = labels;

      const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, {
        method: "POST",
        headers: {
          ...getGitHubHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json() as any;
      const isSuccess = res.status === 201;
      const issueNumber = data?.number ? String(data.number) : null;
      const issueUrl = data?.html_url || null;

      // Record to D1 Database
      if (db) {
        try {
          const query = `
            INSERT INTO post_logs (platform, post_id, title, content, media_urls, status, published_at, response_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `;
          await db.prepare(query).bind(
            "github",
            issueNumber,
            `[Issue #${issueNumber}] ${title}`,
            body,
            issueUrl,
            isSuccess ? "published" : "failed",
            isSuccess ? new Date().toISOString() : null,
            JSON.stringify(data)
          ).run();
        } catch {}
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: isSuccess,
                platform: "github",
                issueNumber,
                issueUrl,
                response: data,
              },
              null,
              2
            ),
          },
        ],
        isError: !isSuccess,
      };
    }

    case "github_create_gist": {
      const description = String(args.description || "").trim();
      const filename = String(args.filename || "file1.txt").trim();
      const content = String(args.content || "").trim();
      const isPublic = Boolean(args.is_public);

      const { token: storedToken } = await getStoredGitHubToken(db, ctx.env);
      const token = String(args.access_token || storedToken || "").trim();

      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "GitHub token missing. Please configure GitHub credentials in D1 or provide 'access_token'.",
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      const payload = {
        description,
        public: isPublic,
        files: {
          [filename]: { content },
        },
      };

      const res = await fetch("https://api.github.com/gists", {
        method: "POST",
        headers: {
          ...getGitHubHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json() as any;
      const isSuccess = res.status === 201;
      const gistId = data?.id || null;
      const gistUrl = data?.html_url || null;

      if (db) {
        try {
          const query = `
            INSERT INTO post_logs (platform, post_id, title, content, media_urls, status, published_at, response_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `;
          await db.prepare(query).bind(
            "github",
            gistId,
            `[Gist] ${description}`,
            content.length > 200 ? content.substring(0, 200) + "..." : content,
            gistUrl,
            isSuccess ? "published" : "failed",
            isSuccess ? new Date().toISOString() : null,
            JSON.stringify(data)
          ).run();
        } catch {}
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: isSuccess,
                platform: "github",
                gistId,
                gistUrl,
                response: data,
              },
              null,
              2
            ),
          },
        ],
        isError: !isSuccess,
      };
    }

    case "github_create_or_update_file": {
      const owner = String(args.owner || "").trim();
      const repo = String(args.repo || "").trim();
      const path = String(args.path || "").trim().replace(/^\/+/, "");
      const content = String(args.content || "");
      const message = String(args.message || "").trim();
      const branch = args.branch ? String(args.branch).trim() : undefined;
      const sha = args.sha ? String(args.sha).trim() : undefined;

      const { token: storedToken } = await getStoredGitHubToken(db, ctx.env);
      const token = String(args.access_token || storedToken || "").trim();

      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "GitHub token missing. Please configure GitHub credentials in D1.",
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      // Base64 encode content for GitHub API
      const enc = new TextEncoder();
      const bytes = enc.encode(content);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Content = btoa(binary);

      const payload: any = {
        message,
        content: base64Content,
      };
      if (branch) payload.branch = branch;
      if (sha) payload.sha = sha;

      const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path}`, {
        method: "PUT",
        headers: {
          ...getGitHubHeaders(token),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json() as any;
      const isSuccess = res.status === 200 || res.status === 201;
      const commitSha = data?.commit?.sha || null;
      const fileUrl = data?.content?.html_url || null;

      if (db) {
        try {
          const query = `
            INSERT INTO post_logs (platform, post_id, title, content, media_urls, status, published_at, response_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `;
          await db.prepare(query).bind(
            "github",
            commitSha,
            `[Commit] ${message} (${path})`,
            content.length > 200 ? content.substring(0, 200) + "..." : content,
            fileUrl,
            isSuccess ? "published" : "failed",
            isSuccess ? new Date().toISOString() : null,
            JSON.stringify(data)
          ).run();
        } catch {}
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                success: isSuccess,
                platform: "github",
                path,
                commitSha,
                fileUrl,
                response: data,
              },
              null,
              2
            ),
          },
        ],
        isError: !isSuccess,
      };
    }

    default:
      return null;
  }
}
