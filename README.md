# 🌐 Cloudflare Workers MCP Server

A high-performance **Model Context Protocol (MCP)** server deployed on **Cloudflare Workers**. Connects AI coding assistants and LLMs (Claude Desktop, Cursor, Antigravity, etc.) to edge tools and web utilities over standard HTTP / SSE transports.

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/smsohagbd/cloudflare-mcp)

---

## 🚀 Features

- **Standard MCP Protocol**: Supports JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`, `resources/list`, `prompts/list`).
- **Dual Transports**:
  - **Live URL**: [https://cloudflare-mcp.sohagbdmt11.workers.dev](https://cloudflare-mcp.sohagbdmt11.workers.dev)
- **MCP Endpoint**: `https://cloudflare-mcp.sohagbdmt11.workers.dev/mcp`
- **SSE Endpoint**: `https://cloudflare-mcp.sohagbdmt11.workers.dev/sse`
- **Health Endpoint**: `https://cloudflare-mcp.sohagbdmt11.workers.dev/health`
- **Global Edge Performance**: Powered by Cloudflare Workers with sub-millisecond cold starts across 300+ data centers worldwide.
- **Built-in Landing Dashboard**: Visually inspect server status, available tools, and edge diagnostics.

---

## 🛠️ Built-in MCP Tools

| Tool | Description | Parameters |
| :--- | :--- | :--- |
| `dns_lookup` | Perform fast DNS queries via Cloudflare 1.1.1.1 DoH (A, AAAA, CNAME, MX, TXT, NS). | `domain` (required), `type` |
| `fetch_web_content` | Fetch readable web page content, stripping HTML tags and scripts. | `url` (required), `max_length` |
| `ip_lookup` | Retrieve geolocation, ASN, and network info for any IP (or caller edge info). | `ip` (optional) |
| `crypto_utils` | Edge cryptographic functions (SHA-256, SHA-512, Base64 encode/decode). | `text` (required), `algorithm` (required) |
| `http_request` | Make flexible HTTP requests (GET, POST, PUT, DELETE, PATCH) directly from the edge. | `url` (required), `method`, `headers`, `body` |
| `json_processor` | Prettify, minify, inspect keys, or extract nested values using dot-notation path. | `json_string` (required), `operation`, `path` |
| `uuid_generator` | Generate cryptographically secure RFC 4122 v4 UUIDs. | `count` (1-20) |

---

## 🔌 Connecting to AI Agents & Clients

### 1. Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cloudflare-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://cloudflare-mcp.<your-subdomain>.workers.dev/mcp"
      ]
    }
  }
}
```

### 2. Cursor / Antigravity / Gemini CLI

Configure the MCP server via the SSE or Streamable HTTP endpoint:

```
Endpoint: https://cloudflare-mcp.<your-subdomain>.workers.dev/mcp
Protocol: Streamable HTTP / JSON-RPC
```

---

## 💻 Local Development

```bash
# Clone the repository
git clone https://github.com/smsohagbd/cloudflare-mcp.git
cd cloudflare-mcp

# Install dependencies
npm install

# Start local development server
npm run dev

# Type check
npm run typecheck
```

---

## 🚢 Deployment to Cloudflare

Deploy directly to your Cloudflare account with Wrangler:

```bash
npm run deploy
```

---

## 📜 License

MIT License © 2026 smsohagbd
