import { MCPToolDefinition, MCPToolResult } from "../mcp/types";
import { ToolContext } from "./general";

export const STORAGE_TOOLS: MCPToolDefinition[] = [
  {
    name: "db_save_post_log",
    description: "Save a social media post log into Cloudflare D1 database (platform, content, media_urls, status, response_data).",
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          description: "Target platform (linkedin, youtube, facebook, system)",
          enum: ["linkedin", "youtube", "facebook", "system"],
        },
        content: {
          type: "string",
          description: "The body / text content of the post",
        },
        title: {
          type: "string",
          description: "Optional post title or video title",
        },
        post_id: {
          type: "string",
          description: "Optional ID returned by the platform API",
        },
        media_urls: {
          type: "string",
          description: "Optional URL or JSON string array of media files",
        },
        status: {
          type: "string",
          description: "Status of the post (draft, pending_approval, published, failed)",
          enum: ["draft", "pending_approval", "published", "failed"],
          default: "published",
        },
        response_data: {
          type: "string",
          description: "Optional JSON string or notes from the publishing API",
        },
      },
      required: ["platform", "content"],
    },
  },
  {
    name: "db_get_post_logs",
    description: "Query social media post logs from Cloudflare D1 database with optional platform and status filters.",
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          description: "Filter by platform (linkedin, youtube, facebook, system)",
        },
        status: {
          type: "string",
          description: "Filter by status (draft, pending_approval, published, failed)",
        },
        limit: {
          type: "number",
          description: "Maximum number of records to return (default: 20)",
          default: 20,
        },
      },
    },
  },
  {
    name: "db_save_comment_log",
    description: "Record a received comment or automated reply in Cloudflare D1 database.",
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          description: "Platform: linkedin, youtube, facebook",
          enum: ["linkedin", "youtube", "facebook"],
        },
        post_id: {
          type: "string",
          description: "Target post or video ID",
        },
        comment_text: {
          type: "string",
          description: "The incoming comment text",
        },
        author: {
          type: "string",
          description: "Comment author name / username",
        },
        comment_id: {
          type: "string",
          description: "Platform comment ID",
        },
        reply_text: {
          type: "string",
          description: "Automated reply text (if replied)",
        },
        status: {
          type: "string",
          description: "Status: received, replied, ignored",
          enum: ["received", "replied", "ignored"],
          default: "received",
        },
      },
      required: ["platform", "post_id", "comment_text"],
    },
  },
  {
    name: "db_get_comment_logs",
    description: "Retrieve comment logs from Cloudflare D1 database.",
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          description: "Filter by platform",
        },
        post_id: {
          type: "string",
          description: "Filter by post_id",
        },
        status: {
          type: "string",
          description: "Filter by status",
        },
        limit: {
          type: "number",
          description: "Max records (default: 20)",
          default: 20,
        },
      },
    },
  },
  {
    name: "r2_upload_file",
    description: "Upload media files (images, video clips, thumbnails, assets) directly to Cloudflare R2 storage bucket.",
    inputSchema: {
      type: "object",
      properties: {
        filename: {
          type: "string",
          description: "Filename or path in bucket (e.g. 'posts/banner.png' or 'videos/intro.mp4')",
        },
        content_base64: {
          type: "string",
          description: "Base64 encoded file content",
        },
        content_type: {
          type: "string",
          description: "MIME type (e.g. 'image/png', 'image/jpeg', 'video/mp4')",
          default: "application/octet-stream",
        },
      },
      required: ["filename", "content_base64"],
    },
  },
  {
    name: "r2_list_files",
    description: "List stored media and assets in the Cloudflare R2 bucket.",
    inputSchema: {
      type: "object",
      properties: {
        prefix: {
          type: "string",
          description: "Optional filename prefix filter (e.g. 'posts/' or 'videos/')",
        },
        limit: {
          type: "number",
          description: "Maximum number of files to return (default: 50)",
          default: 50,
        },
      },
    },
  },
  {
    name: "manage_social_credentials",
    description: "Store, retrieve, or list API tokens and credentials for social media platforms (LinkedIn, YouTube, Facebook) in D1.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Action: 'get', 'set', or 'list'",
          enum: ["get", "set", "list"],
        },
        platform: {
          type: "string",
          description: "Platform: 'linkedin', 'youtube', or 'facebook'",
          enum: ["linkedin", "youtube", "facebook"],
        },
        access_token: {
          type: "string",
          description: "OAuth access token (required for 'set')",
        },
        refresh_token: {
          type: "string",
          description: "Optional refresh token (for 'set')",
        },
        extra_data: {
          type: "string",
          description: "Optional JSON metadata like channel_id, page_id, or organization_urn (for 'set')",
        },
      },
      required: ["action"],
    },
  },
];

export async function executeStorageTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<MCPToolResult | null> {
  const db = ctx.env.DB as any;
  const bucket = ctx.env.MEDIA_BUCKET as any;

  switch (name) {
    case "db_save_post_log": {
      if (!db) {
        return { content: [{ type: "text", text: "Error: D1 database binding 'DB' not configured" }], isError: true };
      }
      const platform = String(args.platform || "").toLowerCase();
      const content = String(args.content || "");
      const title = args.title ? String(args.title) : null;
      const postId = args.post_id ? String(args.post_id) : null;
      const mediaUrls = args.media_urls ? String(args.media_urls) : null;
      const status = String(args.status || "published");
      const responseData = args.response_data ? String(args.response_data) : null;
      const publishedAt = status === "published" ? new Date().toISOString() : null;

      const query = `
        INSERT INTO post_logs (platform, post_id, title, content, media_urls, status, published_at, response_data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;

      const result = await db.prepare(query).bind(platform, postId, title, content, mediaUrls, status, publishedAt, responseData).run();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Post log saved successfully to D1 database",
              id: result.meta?.last_row_id,
              platform,
              status,
            }, null, 2),
          },
        ],
      };
    }

    case "db_get_post_logs": {
      if (!db) {
        return { content: [{ type: "text", text: "Error: D1 database binding 'DB' not configured" }], isError: true };
      }
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
      let query = "SELECT * FROM post_logs";
      const params: any[] = [];
      const conditions: string[] = [];

      if (args.platform) {
        conditions.push("platform = ?");
        params.push(String(args.platform).toLowerCase());
      }
      if (args.status) {
        conditions.push("status = ?");
        params.push(String(args.status).toLowerCase());
      }
      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY id DESC LIMIT ?";
      params.push(limit);

      const rows = await db.prepare(query).bind(...params).all();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: rows.results?.length || 0, posts: rows.results }, null, 2),
          },
        ],
      };
    }

    case "db_save_comment_log": {
      if (!db) {
        return { content: [{ type: "text", text: "Error: D1 database binding 'DB' not configured" }], isError: true };
      }
      const platform = String(args.platform || "").toLowerCase();
      const postId = String(args.post_id || "");
      const commentText = String(args.comment_text || "");
      const author = args.author ? String(args.author) : null;
      const commentId = args.comment_id ? String(args.comment_id) : null;
      const replyText = args.reply_text ? String(args.reply_text) : null;
      const status = String(args.status || "received");

      const query = `
        INSERT INTO comments_log (platform, post_id, comment_id, author, comment_text, reply_text, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `;
      const result = await db.prepare(query).bind(platform, postId, commentId, author, commentText, replyText, status).run();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              id: result.meta?.last_row_id,
              platform,
              postId,
              status,
            }, null, 2),
          },
        ],
      };
    }

    case "db_get_comment_logs": {
      if (!db) {
        return { content: [{ type: "text", text: "Error: D1 database binding 'DB' not configured" }], isError: true };
      }
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 20));
      let query = "SELECT * FROM comments_log";
      const params: any[] = [];
      const conditions: string[] = [];

      if (args.platform) {
        conditions.push("platform = ?");
        params.push(String(args.platform).toLowerCase());
      }
      if (args.post_id) {
        conditions.push("post_id = ?");
        params.push(String(args.post_id));
      }
      if (args.status) {
        conditions.push("status = ?");
        params.push(String(args.status));
      }
      if (conditions.length > 0) {
        query += " WHERE " + conditions.join(" AND ");
      }
      query += " ORDER BY id DESC LIMIT ?";
      params.push(limit);

      const rows = await db.prepare(query).bind(...params).all();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: rows.results?.length || 0, comments: rows.results }, null, 2),
          },
        ],
      };
    }

    case "r2_upload_file": {
      if (!bucket) {
        return { content: [{ type: "text", text: "Error: R2 bucket binding 'MEDIA_BUCKET' not configured" }], isError: true };
      }
      const filename = String(args.filename || "").trim().replace(/^\/+/, "");
      const base64Data = String(args.content_base64 || "");
      const contentType = String(args.content_type || "application/octet-stream");

      if (!filename || !base64Data) {
        return { content: [{ type: "text", text: "Error: filename and content_base64 are required" }], isError: true };
      }

      try {
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }

        await bucket.put(filename, bytes, {
          httpMetadata: { contentType },
          customMetadata: { uploadedAt: new Date().toISOString() },
        });

        const url = new URL(ctx.request.url);
        const publicMediaUrl = `${url.origin}/media/${filename}`;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                filename,
                sizeBytes: bytes.length,
                contentType,
                mediaUrl: publicMediaUrl,
              }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return { content: [{ type: "text", text: `R2 upload error: ${err.message}` }], isError: true };
      }
    }

    case "r2_list_files": {
      if (!bucket) {
        return { content: [{ type: "text", text: "Error: R2 bucket binding 'MEDIA_BUCKET' not configured" }], isError: true };
      }
      const prefix = args.prefix ? String(args.prefix) : undefined;
      const limit = Math.max(1, Math.min(100, Number(args.limit) || 50));

      const listed = await bucket.list({ prefix, limit });
      const url = new URL(ctx.request.url);

      const objects = (listed.objects || []).map((obj: any) => ({
        key: obj.key,
        sizeBytes: obj.size,
        uploaded: obj.uploaded,
        url: `${url.origin}/media/${obj.key}`,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: objects.length, truncated: listed.truncated, files: objects }, null, 2),
          },
        ],
      };
    }

    case "manage_social_credentials": {
      if (!db) {
        return { content: [{ type: "text", text: "Error: D1 database binding 'DB' not configured" }], isError: true };
      }
      const action = String(args.action || "list").toLowerCase();
      const platform = args.platform ? String(args.platform).toLowerCase() : "";

      if (action === "list") {
        const rows = await db.prepare("SELECT platform, token_type, expires_at, updated_at FROM social_credentials").all();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ platforms: rows.results || [] }, null, 2),
            },
          ],
        };
      }

      if (action === "get") {
        if (!platform) {
          return { content: [{ type: "text", text: "Error: platform is required for 'get'" }], isError: true };
        }
        const row = await db.prepare("SELECT platform, token_type, expires_at, extra_data, updated_at FROM social_credentials WHERE platform = ?").bind(platform).first();
        if (!row) {
          return {
            content: [{ type: "text", text: JSON.stringify({ platform, configured: false, message: `No credentials configured for ${platform}` }) }],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ platform, configured: true, details: row }, null, 2),
            },
          ],
        };
      }

      if (action === "set") {
        if (!platform || !args.access_token) {
          return { content: [{ type: "text", text: "Error: platform and access_token are required for 'set'" }], isError: true };
        }
        const accessToken = String(args.access_token);
        const refreshToken = args.refresh_token ? String(args.refresh_token) : null;
        const extraData = args.extra_data ? String(args.extra_data) : null;
        const now = new Date().toISOString();

        await db.prepare(`
          INSERT INTO social_credentials (platform, access_token, refresh_token, token_type, extra_data, updated_at)
          VALUES (?, ?, ?, 'Bearer', ?, ?)
          ON CONFLICT(platform) DO UPDATE SET
            access_token = excluded.access_token,
            refresh_token = COALESCE(excluded.refresh_token, social_credentials.refresh_token),
            extra_data = COALESCE(excluded.extra_data, social_credentials.extra_data),
            updated_at = excluded.updated_at
        `).bind(platform, accessToken, refreshToken, extraData, now).run();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `Credentials for '${platform}' saved successfully in D1 database`,
                updatedAt: now,
              }, null, 2),
            },
          ],
        };
      }

      return { content: [{ type: "text", text: `Unknown action: ${action}` }], isError: true };
    }

    default:
      return null;
  }
}
