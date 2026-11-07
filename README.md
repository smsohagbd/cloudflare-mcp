# 🌐 Cloudflare MCP Agent Hub (`mcp.sohag.com.bd`)

A universal **Model Context Protocol (MCP)** server deployed on **Cloudflare Workers** with custom domain **`mcp.sohag.com.bd`**. Designed as an AI Agent hub for **Muse AI**, Cursor, Claude Desktop, and Antigravity to automate **LinkedIn**, **YouTube**, and **Facebook**, backed by Cloudflare **D1 SQL Database** for persistence and **R2 Object Storage** for media assets.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/smsohagbd/cloudflare-mcp)

---

## 🚀 Live Endpoints

- **Live URL / Dashboard**: [https://mcp.sohag.com.bd](https://mcp.sohag.com.bd)
- **MCP Endpoint (Streamable HTTP)**: `https://mcp.sohag.com.bd/mcp`
- **MCP Endpoint (SSE)**: `https://mcp.sohag.com.bd/sse`
- **Public Media Storage**: `https://mcp.sohag.com.bd/media/<filename>`
- **Health Check**: `https://mcp.sohag.com.bd/health`
- **Fallback URL**: `https://cloudflare-mcp.sohagbdmt11.workers.dev`

---

## 🤖 Connecting Muse AI or External AI Agents

In **Muse AI** (or any MCP client):
1. **Tool / MCP URL**: `https://mcp.sohag.com.bd/mcp`
2. **Protocol**: HTTP POST (Streamable HTTP JSON-RPC 2.0)
3. Muse AI can generate the social media plan, request user confirmation, and call:
   - `linkedin_publish_post` to publish posts or articles to LinkedIn.
   - `youtube_upload_video` to upload videos stored in R2 to YouTube.
   - `youtube_reply_comment` to reply to comments.
   - `r2_upload_file` to upload media assets.
   - `db_get_post_logs` to review past post logs and status.

---

## 🗄️ Database & Storage Architecture

### 1. Cloudflare D1 Database (`cloudflare-mcp-db`)
- **`post_logs`**: Stores all publication history (`id`, `platform`, `post_id`, `title`, `content`, `media_urls`, `status`, `published_at`, `response_data`).
- **`comments_log`**: Records incoming comments and automated replies (`id`, `platform`, `post_id`, `comment_id`, `author`, `comment_text`, `reply_text`, `status`).
- **`social_credentials`**: Stores OAuth access and refresh tokens for LinkedIn, YouTube, and Facebook securely.

### 2. Cloudflare R2 Storage (`cloudflare-mcp-media`)
- Stores images, video clips, thumbnails, and audio files.
- Automatically served with public edge caching at `https://mcp.sohag.com.bd/media/<filename>`.

---

## 🛠️ Complete MCP Tools Catalog (21 Tools)

### 📢 Social Media Automation (LinkedIn & YouTube)
| Tool | Description |
| :--- | :--- |
| `linkedin_publish_post` | Publish text or media posts to LinkedIn. Automatically saves logs in D1. |
| `linkedin_get_profile` | Retrieve authenticated member info (name, email, person URN). |
| `youtube_upload_video` | Resumable video upload from R2 media URL to YouTube. Logs to D1. |
| `youtube_get_channel_stats` | Query subscriber count, total views, and video counts. |
| `youtube_list_comments` | Fetch recent comments and replies on YouTube videos. |
| `youtube_reply_comment` | Post replies to top-level comments and record them in D1. |

### 🗄️ D1 Database & R2 Storage Management
| Tool | Description |
| :--- | :--- |
| `db_save_post_log` | Save social media post status and details into D1. |
| `db_get_post_logs` | Query post logs by platform, status, or date from D1. |
| `db_save_comment_log` | Record comment interactions and replies in D1. |
| `db_get_comment_logs` | Query comment logs from D1. |
| `r2_upload_file` | Upload base64 media to R2 and get public URL (`/media/...`). |
| `r2_list_files` | List files and assets stored in the R2 bucket. |
| `manage_social_credentials` | Save or retrieve OAuth access tokens in D1 (`linkedin`, `youtube`, `facebook`). |

### ⚡ Edge Utilities & Diagnostics (Preserved)
| Tool | Description |
| :--- | :--- |
| `dns_lookup` | Perform fast DNS lookups via Cloudflare 1.1.1.1 DoH (A, AAAA, CNAME, MX, TXT). |
| `fetch_web_content` | Fetch readable text from any URL with HTML tags stripped. |
| `ip_lookup` | Get edge geolocation, ASN, and network info. |
| `crypto_utils` | SHA-256 / SHA-512 hashing, Base64 encode / decode. |
| `http_request` | Make flexible HTTP requests from Cloudflare edge. |
| `json_processor` | Prettify, minify, inspect keys, or query nested dot-paths. |
| `uuid_generator` | Generate cryptographically secure RFC 4122 v4 UUIDs. |
| `ask_ai` | Run serverless LLMs (Llama 3.1) directly on Cloudflare Workers AI. |

---

## 🔐 Configuring Social Media Credentials

You can configure LinkedIn and YouTube tokens directly using the MCP tool `manage_social_credentials`:

```json
{
  "name": "manage_social_credentials",
  "arguments": {
    "action": "set",
    "platform": "linkedin",
    "access_token": "YOUR_LINKEDIN_OAUTH_TOKEN"
  }
}
```

Or pass `access_token` directly in tool calls (`linkedin_publish_post`, `youtube_upload_video`).

---

## 💻 Local Development & Deployment

```bash
# Clone
git clone https://github.com/smsohagbd/cloudflare-mcp.git
cd cloudflare-mcp

# Install
npm install

# Type check
npm run typecheck

# Deploy to Cloudflare
npm run deploy
```

---

## 📜 License

MIT License © 2026 smsohagbd
