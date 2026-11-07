---
name: cloudflare-mcp
description: >-
  Expert guide, architecture, and workflow for the Cloudflare Workers MCP Agent Hub deployed at mcp.sohag.com.bd.
  Use when maintaining, adding tools, or integrating external AI agents (Muse AI, Cursor) with LinkedIn, YouTube,
  Cloudflare D1 database, and R2 media storage.
---

# Cloudflare MCP Agent Hub Skill

## Overview
This skill guides maintenance and extension of the Cloudflare Workers MCP Server at `https://mcp.sohag.com.bd`.
External agents like **Muse AI** connect to this MCP server to plan and automate LinkedIn, YouTube, and Facebook actions with D1 persistence and R2 media storage.

## Architecture & Bindings
* **Worker Domain**: `https://mcp.sohag.com.bd` (fallback: `https://cloudflare-mcp.sohagbdmt11.workers.dev`)
* **Account**: `c536a0894f98715228542fb0a4d39135` (`Sohagbdmt11@gmail.com's Account`)
* **D1 Binding**: `env.DB` (`cloudflare-mcp-db`, ID: `99538b63-c3b1-4e80-9b02-7a56408c64af`)
* **R2 Binding**: `env.MEDIA_BUCKET` (`cloudflare-mcp-media`, served publicly at `/media/*`)
* **AI Binding**: `env.AI` (Cloudflare Workers AI)

## Available MCP Tools Summary
1. **Social Automation**:
   - `linkedin_publish_post`: Publish post/article with media to LinkedIn. Automatically logs to D1.
   - `linkedin_get_profile`: Query authenticated member profile.
   - `youtube_upload_video`: Resumable upload of video from R2 URL to YouTube. Automatically logs to D1.
   - `youtube_get_channel_stats`: Query subscriber, view, and video analytics.
   - `youtube_list_comments`: List comments and replies on any video.
   - `youtube_reply_comment`: Post replies to comments and log to D1.
2. **Database & Storage**:
   - `db_save_post_log`: Save post log in D1 `post_logs`.
   - `db_get_post_logs`: Filter and read post logs from D1.
   - `db_save_comment_log`: Record received comments / replies in D1 `comments_log`.
   - `db_get_comment_logs`: Query comment logs from D1.
   - `r2_upload_file`: Upload base64 media to R2, get immediate `https://mcp.sohag.com.bd/media/...` URL.
   - `r2_list_files`: List objects stored in R2.
   - `manage_social_credentials`: Store and retrieve OAuth tokens in D1 securely.
3. **Edge Utilities**:
   - `dns_lookup`: Cloudflare 1.1.1.1 DoH resolution.
   - `fetch_web_content`: Strip HTML and extract clean readable text.
   - `ip_lookup`: Edge geolocation, ASN, and network info.
   - `crypto_utils`: SHA-256, SHA-512, Base64 encode/decode.
   - `http_request`: Flexible fetch requests from edge.
   - `json_processor`: Format, minify, dot-path extraction.
   - `uuid_generator`: Cryptographically secure RFC 4122 v4 UUIDs.
   - `ask_ai`: Run serverless LLMs (Llama 3.1) directly on edge.

## File Organization
* `src/index.ts`: Routing (`/mcp`, `/sse`, `/media/*`, `/health`, `/`)
* `src/mcp/handler.ts`: Protocol processor for JSON-RPC 2.0
* `src/tools/index.ts`: Tool aggregator and router
* `src/tools/general.ts`: Edge utilities
* `src/tools/storage.ts`: D1 and R2 operations
* `src/tools/social.ts`: LinkedIn and YouTube API calls
* `schema.sql`: D1 database schema
* `wrangler.jsonc`: Cloudflare configuration
