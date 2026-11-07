import { MCPToolDefinition, MCPToolResult } from "../mcp/types";
import { ToolContext } from "./general";

export const SOCIAL_TOOLS: MCPToolDefinition[] = [
  {
    name: "linkedin_publish_post",
    description: "Publish a text or media post to LinkedIn. Supports public or connections visibility, and automatically logs the result to D1 database.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Content/caption of the LinkedIn post",
        },
        title: {
          type: "string",
          description: "Optional title or headline for the post / shared link",
        },
        media_url: {
          type: "string",
          description: "Optional URL of an image, video, or link (can be an R2 storage URL: https://mcp.sohag.com.bd/media/...)",
        },
        visibility: {
          type: "string",
          description: "Visibility: 'PUBLIC' or 'CONNECTIONS'",
          enum: ["PUBLIC", "CONNECTIONS"],
          default: "PUBLIC",
        },
        author_urn: {
          type: "string",
          description: "Optional LinkedIn author URN (e.g. 'urn:li:person:12345' or 'urn:li:organization:67890'). If omitted, will be fetched automatically via userinfo.",
        },
        access_token: {
          type: "string",
          description: "LinkedIn OAuth Bearer token (if not stored in D1 database)",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "linkedin_get_profile",
    description: "Fetch authenticated LinkedIn member details (name, email, sub / person URN) to verify connection.",
    inputSchema: {
      type: "object",
      properties: {
        access_token: {
          type: "string",
          description: "Optional access token. If omitted, uses token stored in D1.",
        },
      },
    },
  },
  {
    name: "youtube_upload_video",
    description: "Upload a video to YouTube with title, description, tags, and privacy status. Can take a video file URL from Cloudflare R2.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Video title",
        },
        description: {
          type: "string",
          description: "Video description",
        },
        video_url: {
          type: "string",
          description: "Direct URL of the video file (e.g. R2 media link: https://mcp.sohag.com.bd/media/videos/intro.mp4)",
        },
        tags: {
          type: "string",
          description: "Comma-separated tags or keywords (e.g. 'ai, automation, cloudflare')",
        },
        privacy_status: {
          type: "string",
          description: "Privacy status: 'public', 'private', or 'unlisted'",
          enum: ["public", "private", "unlisted"],
          default: "public",
        },
        access_token: {
          type: "string",
          description: "Google/YouTube OAuth Access Token (if not stored in D1)",
        },
      },
      required: ["title", "description", "video_url"],
    },
  },
  {
    name: "youtube_get_channel_stats",
    description: "Fetch YouTube channel statistics (subscribers, view count, total videos) for analytics.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: {
          type: "string",
          description: "Channel ID (e.g. 'UC...'). If omitted, retrieves the authenticated user's channel ('mine').",
        },
        api_key: {
          type: "string",
          description: "YouTube Data API v3 Key (optional if using access_token)",
        },
        access_token: {
          type: "string",
          description: "OAuth Access Token (optional if using api_key or saved in D1)",
        },
      },
    },
  },
  {
    name: "youtube_list_comments",
    description: "List recent comments and comment threads on a specific YouTube video.",
    inputSchema: {
      type: "object",
      properties: {
        video_id: {
          type: "string",
          description: "YouTube Video ID",
        },
        max_results: {
          type: "number",
          description: "Maximum comments to fetch (default: 20, max: 100)",
          default: 20,
        },
        api_key: {
          type: "string",
          description: "YouTube Data API Key (optional if token is configured)",
        },
        access_token: {
          type: "string",
          description: "OAuth Token (optional if API key is provided or stored in D1)",
        },
      },
      required: ["video_id"],
    },
  },
  {
    name: "youtube_reply_comment",
    description: "Reply to a YouTube comment and record the reply in D1 database.",
    inputSchema: {
      type: "object",
      properties: {
        comment_id: {
          type: "string",
          description: "The parent comment ID to reply to",
        },
        text: {
          type: "string",
          description: "Reply message text",
        },
        access_token: {
          type: "string",
          description: "OAuth Access Token (if not saved in D1)",
        },
      },
      required: ["comment_id", "text"],
    },
  },
];

async function getStoredToken(platform: string, db: any, env: any): Promise<{ token: string | null; extra: any }> {
  if (db) {
    try {
      const row = await db.prepare("SELECT access_token, extra_data FROM social_credentials WHERE platform = ?").bind(platform).first();
      if (row && row.access_token) {
        let extra: any = {};
        try { extra = JSON.parse(row.extra_data || "{}"); } catch {}
        return { token: row.access_token, extra };
      }
    } catch {}
  }

  const envKey = `${platform.toUpperCase()}_ACCESS_TOKEN`;
  if (env[envKey]) {
    return { token: env[envKey], extra: {} };
  }

  return { token: null, extra: {} };
}

export async function executeSocialTool(
  name: string,
  args: Record<string, any>,
  ctx: ToolContext
): Promise<MCPToolResult | null> {
  const db = ctx.env.DB as any;

  switch (name) {
    case "linkedin_publish_post": {
      const text = String(args.text || "").trim();
      const title = args.title ? String(args.title) : undefined;
      const mediaUrl = args.media_url ? String(args.media_url) : undefined;
      const visibility = String(args.visibility || "PUBLIC").toUpperCase();

      const { token: storedToken, extra } = await getStoredToken("linkedin", db, ctx.env);
      const token = String(args.access_token || storedToken || "").trim();

      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "LinkedIn access token missing",
                instructions: "Please provide 'access_token' or store it using manage_social_credentials tool (action='set', platform='linkedin', access_token='...').",
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      // Step 1: Find author URN
      let authorUrn = args.author_urn || extra.author_urn || extra.organization_urn;
      if (!authorUrn) {
        try {
          const profileRes = await fetch("https://api.linkedin.com/v2/userinfo", {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (profileRes.ok) {
            const profile = await profileRes.json() as any;
            if (profile.sub) {
              authorUrn = `urn:li:person:${profile.sub}`;
            }
          }
        } catch {}
      }

      if (!authorUrn) {
        authorUrn = "urn:li:person:me";
      }

      // Step 2: Build UGC post body
      const isMedia = !!mediaUrl;
      const ugcBody: any = {
        author: authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text },
            shareMediaCategory: isMedia ? "ARTICLE" : "NONE",
            media: isMedia
              ? [
                  {
                    status: "READY",
                    originalUrl: mediaUrl,
                    title: { text: title || text.substring(0, 50) },
                  },
                ]
              : undefined,
          },
        },
        visibility: {
          "com.linkedin.ugc.MemberNetworkVisibility": visibility,
        },
      };

      let liResponse: any;
      let isSuccess = false;
      let postId: string | null = null;

      try {
        const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Restli-Protocol-Version": "2.0.0",
          },
          body: JSON.stringify(ugcBody),
        });

        const resText = await res.text();
        try {
          liResponse = JSON.parse(resText);
          postId = liResponse.id || null;
        } catch {
          liResponse = resText;
        }

        isSuccess = res.status === 201 || res.status === 200;
      } catch (err: any) {
        liResponse = { error: err.message };
      }

      // Step 3: Record to D1 Database
      if (db) {
        try {
          const query = `
            INSERT INTO post_logs (platform, post_id, title, content, media_urls, status, published_at, response_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `;
          await db.prepare(query).bind(
            "linkedin",
            postId,
            title || null,
            text,
            mediaUrl || null,
            isSuccess ? "published" : "failed",
            isSuccess ? new Date().toISOString() : null,
            JSON.stringify(liResponse)
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
                platform: "linkedin",
                postId,
                visibility,
                author: authorUrn,
                response: liResponse,
              },
              null,
              2
            ),
          },
        ],
        isError: !isSuccess,
      };
    }

    case "linkedin_get_profile": {
      const { token: storedToken } = await getStoredToken("linkedin", db, ctx.env);
      const token = String(args.access_token || storedToken || "").trim();

      if (!token) {
        return {
          content: [{ type: "text", text: "Error: No LinkedIn access token provided or configured in D1." }],
          isError: true,
        };
      }

      const res = await fetch("https://api.linkedin.com/v2/userinfo", {
        headers: { Authorization: `Bearer ${token}` },
      });

      const data = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    }

    case "youtube_upload_video": {
      const title = String(args.title || "").trim();
      const description = String(args.description || "").trim();
      const videoUrl = String(args.video_url || "").trim();
      const tags = args.tags ? String(args.tags).split(",").map((t) => t.trim()) : [];
      const privacy = String(args.privacy_status || "public").toLowerCase();

      const { token: storedToken } = await getStoredToken("youtube", db, ctx.env);
      const token = String(args.access_token || storedToken || "").trim();

      if (!token) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: "YouTube access token missing",
                instructions: "Configure Google/YouTube OAuth token using manage_social_credentials (platform='youtube').",
              }, null, 2),
            },
          ],
          isError: true,
        };
      }

      // Step 1: Create Resumable Upload Session
      const metadata = {
        snippet: {
          title,
          description,
          tags,
          categoryId: "22",
        },
        status: {
          privacyStatus: privacy,
          selfDeclaredMadeForKids: false,
        },
      };

      const sessionRes = await fetch(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": "video/*",
          },
          body: JSON.stringify(metadata),
        }
      );

      if (!sessionRes.ok) {
        const errText = await sessionRes.text();
        return {
          content: [{ type: "text", text: `YouTube upload session creation failed: ${errText}` }],
          isError: true,
        };
      }

      const uploadUrl = sessionRes.headers.get("Location");
      if (!uploadUrl) {
        return {
          content: [{ type: "text", text: "Error: No upload location URL received from YouTube." }],
          isError: true,
        };
      }

      // Step 2: Stream video bytes from videoUrl to YouTube uploadUrl
      const videoFetch = await fetch(videoUrl);
      if (!videoFetch.ok) {
        return {
          content: [{ type: "text", text: `Failed to fetch video file from ${videoUrl}: HTTP ${videoFetch.status}` }],
          isError: true,
        };
      }

      const videoBlob = await videoFetch.blob();
      const uploadRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": videoFetch.headers.get("content-type") || "video/mp4",
          "Content-Length": String(videoBlob.size),
        },
        body: videoBlob,
      });

      const uploadResult = await uploadRes.json() as any;
      const isSuccess = uploadRes.ok;
      const videoId = uploadResult?.id || null;

      // Step 3: Record to D1 Database
      if (db) {
        try {
          const query = `
            INSERT INTO post_logs (platform, post_id, title, content, media_urls, status, published_at, response_data)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `;
          await db.prepare(query).bind(
            "youtube",
            videoId,
            title,
            description,
            videoUrl,
            isSuccess ? "published" : "failed",
            isSuccess ? new Date().toISOString() : null,
            JSON.stringify(uploadResult)
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
                platform: "youtube",
                videoId,
                watchUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : undefined,
                response: uploadResult,
              },
              null,
              2
            ),
          },
        ],
        isError: !isSuccess,
      };
    }

    case "youtube_get_channel_stats": {
      const channelId = args.channel_id ? String(args.channel_id).trim() : "";
      const apiKey = args.api_key ? String(args.api_key).trim() : ctx.env.YOUTUBE_API_KEY || "";
      const { token: storedToken } = await getStoredToken("youtube", db, ctx.env);
      const token = String(args.access_token || storedToken || "").trim();

      let targetUrl = "https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics";
      const headers: Record<string, string> = {};

      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
        if (channelId) {
          targetUrl += `&id=${encodeURIComponent(channelId)}`;
        } else {
          targetUrl += "&mine=true";
        }
      } else if (apiKey && channelId) {
        targetUrl += `&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`;
      } else {
        return {
          content: [
            {
              type: "text",
              text: "Error: Either an access_token or (channel_id + api_key) must be provided.",
            },
          ],
          isError: true,
        };
      }

      const res = await fetch(targetUrl, { headers });
      const data = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    }

    case "youtube_list_comments": {
      const videoId = String(args.video_id || "").trim();
      const maxResults = Math.max(1, Math.min(100, Number(args.max_results) || 20));
      const apiKey = args.api_key ? String(args.api_key).trim() : ctx.env.YOUTUBE_API_KEY || "";
      const { token: storedToken } = await getStoredToken("youtube", db, ctx.env);
      const token = String(args.access_token || storedToken || "").trim();

      let targetUrl = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(videoId)}&maxResults=${maxResults}`;
      const headers: Record<string, string> = {};

      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      } else if (apiKey) {
        targetUrl += `&key=${encodeURIComponent(apiKey)}`;
      } else {
        return {
          content: [{ type: "text", text: "Error: An access_token or api_key is required." }],
          isError: true,
        };
      }

      const res = await fetch(targetUrl, { headers });
      const data = await res.json();
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: !res.ok,
      };
    }

    case "youtube_reply_comment": {
      const commentId = String(args.comment_id || "").trim();
      const text = String(args.text || "").trim();
      const { token: storedToken } = await getStoredToken("youtube", db, ctx.env);
      const token = String(args.access_token || storedToken || "").trim();

      if (!token) {
        return {
          content: [{ type: "text", text: "Error: YouTube OAuth access_token is required to post replies." }],
          isError: true,
        };
      }

      const replyBody = {
        snippet: {
          parentId: commentId,
          textOriginal: text,
        },
      };

      const res = await fetch("https://www.googleapis.com/youtube/v3/comments?part=snippet", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(replyBody),
      });

      const data = await res.json() as any;
      const isSuccess = res.ok;

      if (db) {
        try {
          const query = `
            INSERT INTO comments_log (platform, post_id, comment_id, comment_text, reply_text, status)
            VALUES (?, ?, ?, ?, ?, ?)
          `;
          await db.prepare(query).bind(
            "youtube",
            data?.snippet?.videoId || "unknown",
            commentId,
            "[Replied via API]",
            text,
            isSuccess ? "replied" : "failed"
          ).run();
        } catch {}
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        isError: !isSuccess,
      };
    }

    default:
      return null;
  }
}

