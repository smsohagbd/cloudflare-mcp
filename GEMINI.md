# Cloudflare MCP Agent Hub - Project Knowledge & Rules

## 📌 Project Overview
This project is a high-performance **Model Context Protocol (MCP)** server deployed on Cloudflare Workers at **`mcp.sohag.com.bd`**.
It connects external AI agents (such as **Muse AI**, Claude Desktop, Cursor, Antigravity) to social media & developer automation tools (GitHub, LinkedIn, YouTube, Facebook), edge diagnostics, Cloudflare D1 SQL database, and Cloudflare R2 media storage.

## 🌐 Endpoints & Domains
- **Live Custom Domain**: `https://mcp.sohag.com.bd`
- **Fallback URL**: `https://cloudflare-mcp.sohagbdmt11.workers.dev`
- **MCP JSON-RPC Endpoint**: `POST https://mcp.sohag.com.bd/mcp`
- **MCP SSE Endpoint**: `GET https://mcp.sohag.com.bd/sse`
- **Public R2 Media Serving**: `GET https://mcp.sohag.com.bd/media/<key>`
- **Health Check**: `GET https://mcp.sohag.com.bd/health`
- **Tools List**: `GET https://mcp.sohag.com.bd/tools`
- **Credentials Management**:
  - `POST /api/admin/credentials` (save/update token, auto-detects profile)
  - `DELETE /api/admin/credentials?platform=<name>` (delete social/developer link)
- **1-Click OAuth**:
  - LinkedIn: `GET /auth/linkedin` & `GET /auth/linkedin/callback`
  - GitHub: `GET /auth/github` & `GET /auth/github/callback`

## 🗄️ Infrastructure & Cloudflare Resources
- **Cloudflare Account ID**: `c536a0894f98715228542fb0a4d39135` (`Sohagbdmt11@gmail.com's Account`)
- **D1 Database**: `cloudflare-mcp-db` (ID: `99538b63-c3b1-4e80-9b02-7a56408c64af`, binding: `DB`)
  - `post_logs`: stores platform, content, title, status, media_urls, published_at, response_data.
  - `comments_log`: stores platform, post_id, comment_id, author, comment_text, reply_text, status.
  - `social_credentials`: stores access_token, refresh_token, extra_data for GitHub, LinkedIn, YouTube, Facebook, custom.
- **R2 Storage**: `cloudflare-mcp-media` (binding: `MEDIA_BUCKET`)
  - Stores uploaded images, video clips, thumbnails, audio.
  - Served publicly via `/media/*`.
- **Workers AI**: binding `AI` (Llama 3.1 & Qwen/DeepSeek models).

## 📁 Codebase Directory Structure
```
├── src/
│   ├── index.ts           # Worker entry point, routing (/mcp, /sse, /media, /health, /api/admin/*, /)
│   ├── mcp/
│   │   ├── handler.ts     # JSON-RPC 2.0 processor (initialize, tools/list, tools/call)
│   │   └── types.ts       # MCP & JSON-RPC TypeScript interfaces
│   └── tools/
│       ├── index.ts       # Unified tools registry (exports TOOLS & executeTool)
│       ├── general.ts     # General edge tools (dns, ip, fetch, crypto, http, json, uuid, ai)
│       ├── storage.ts     # D1 database & R2 bucket tools, credential management
│       ├── social.ts      # LinkedIn & YouTube publishing & comment tools
│       └── github.ts      # GitHub tools (get_user, repos, issues, gists, file commits)
├── schema.sql             # D1 database schema
├── wrangler.jsonc         # Cloudflare Worker configuration & bindings
└── package.json           # Dependencies & build scripts
```

## 🛠️ Key Commands
- **Typecheck**: `npm run typecheck`
- **Deploy**: `npm run deploy`
- **Local Dev**: `npm run dev`
- **D1 Migrations**: `CLOUDFLARE_ACCOUNT_ID=c536a0894f98715228542fb0a4d39135 wrangler d1 execute cloudflare-mcp-db --remote --file=./schema.sql`

## 💡 Guidelines for Agents
- Do NOT re-scan the whole codebase when working in this directory. Refer to this document and `src/tools/index.ts`.
- When adding a new tool, define the schema in `general.ts`, `storage.ts`, `social.ts`, or `github.ts`, and register the execution handler.
- Always run `npm run typecheck` before `npm run deploy`.

