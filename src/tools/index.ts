import { MCPToolDefinition, MCPToolResult } from "../mcp/types";

export interface ToolContext {
  request: Request;
  env: Record<string, any>;
}

export const TOOLS: MCPToolDefinition[] = [
  {
    name: "dns_lookup",
    description: "Perform DNS lookups using Cloudflare 1.1.1.1 DNS over HTTPS (DoH). Resolves A, AAAA, CNAME, MX, TXT, NS records.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Domain name to resolve (e.g. cloudflare.com, google.com)",
        },
        type: {
          type: "string",
          description: "DNS record type (A, AAAA, CNAME, MX, TXT, NS, SOA)",
          enum: ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA"],
          default: "A",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "fetch_web_content",
    description: "Fetch web page content from any public URL, strip HTML tags, and return clean readable text.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full URL of the web page to fetch (http/https)",
        },
        max_length: {
          type: "number",
          description: "Maximum character length of content to return (default: 4000)",
          default: 4000,
        },
      },
      required: ["url"],
    },
  },
  {
    name: "ip_lookup",
    description: "Get IP geolocation and network information. If no IP is provided, returns edge info from the incoming request.",
    inputSchema: {
      type: "object",
      properties: {
        ip: {
          type: "string",
          description: "IPv4 or IPv6 address to lookup (leave empty for caller IP)",
        },
      },
    },
  },
  {
    name: "crypto_utils",
    description: "Cryptographic utilities: SHA-256 / SHA-512 hashing, Base64 encode / decode.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The text to process",
        },
        algorithm: {
          type: "string",
          description: "The operation to perform",
          enum: ["sha256", "sha512", "base64_encode", "base64_decode"],
        },
      },
      required: ["text", "algorithm"],
    },
  },
  {
    name: "http_request",
    description: "Execute a flexible HTTP API request from Cloudflare edge network.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Target URL",
        },
        method: {
          type: "string",
          description: "HTTP method",
          enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
          default: "GET",
        },
        headers: {
          type: "object",
          description: "Optional HTTP headers as key-value pairs",
        },
        body: {
          type: "string",
          description: "Optional request body (for POST, PUT, PATCH)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "json_processor",
    description: "Parse, format, minify, inspect keys, or extract values by dot-notation path from JSON strings.",
    inputSchema: {
      type: "object",
      properties: {
        json_string: {
          type: "string",
          description: "Valid JSON string to process",
        },
        operation: {
          type: "string",
          description: "Operation: 'prettify', 'minify', 'get_keys', or 'query_path'",
          enum: ["prettify", "minify", "get_keys", "query_path"],
          default: "prettify",
        },
        path: {
          type: "string",
          description: "Dot-notation path for 'query_path' operation (e.g., 'data.user.id')",
        },
      },
      required: ["json_string"],
    },
  },
  {
    name: "uuid_generator",
    description: "Generate cryptographically secure RFC 4122 v4 UUIDs.",
    inputSchema: {
      type: "object",
      properties: {
        count: {
          type: "number",
          description: "Number of UUIDs to generate (1 to 20, default: 1)",
          default: 1,
        },
      },
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, any> = {},
  ctx: ToolContext
): Promise<MCPToolResult> {
  try {
    switch (name) {
      case "dns_lookup": {
        const domain = String(args.domain || "").trim();
        const type = String(args.type || "A").toUpperCase();
        if (!domain) {
          return { content: [{ type: "text", text: "Error: domain is required" }], isError: true };
        }

        const dohUrl = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=${encodeURIComponent(type)}`;
        const res = await fetch(dohUrl, {
          headers: { Accept: "application/dns-json" },
        });

        if (!res.ok) {
          return {
            content: [{ type: "text", text: `DoH query failed with HTTP ${res.status}: ${res.statusText}` }],
            isError: true,
          };
        }

        const data = await res.json();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      }

      case "fetch_web_content": {
        const url = String(args.url || "").trim();
        const maxLength = typeof args.max_length === "number" ? Math.min(args.max_length, 20000) : 4000;
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          return { content: [{ type: "text", text: "Error: URL must begin with http:// or https://" }], isError: true };
        }

        const res = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; CloudflareWorkerMCP/1.0)",
            Accept: "text/html,application/xhtml+xml,text/plain,*/*",
          },
        });

        const raw = await res.text();
        const clean = raw
          .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
          .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/\s+/g, " ")
          .trim();

        const truncated = clean.length > maxLength ? `${clean.substring(0, maxLength)}\n...[truncated]` : clean;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  url,
                  status: res.status,
                  statusText: res.statusText,
                  contentType: res.headers.get("content-type"),
                  length: clean.length,
                  content: truncated,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "ip_lookup": {
        const targetIp = String(args.ip || "").trim();

        if (targetIp) {
          const res = await fetch(`https://ipapi.co/${encodeURIComponent(targetIp)}/json/`, {
            headers: { "User-Agent": "CloudflareWorkerMCP/1.0" },
          });
          const data = await res.json();
          return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
        }

        // Return edge info from Cloudflare request
        const cf = (ctx.request as any).cf || {};
        const edgeInfo = {
          clientIp: ctx.request.headers.get("cf-connecting-ip") || ctx.request.headers.get("x-real-ip"),
          country: cf.country || ctx.request.headers.get("cf-ipcountry"),
          city: cf.city,
          region: cf.region,
          postalCode: cf.postalCode,
          timezone: cf.timezone,
          colo: cf.colo,
          asn: cf.asn,
          asOrganization: cf.asOrganization,
          rayId: ctx.request.headers.get("cf-ray"),
        };

        return { content: [{ type: "text", text: JSON.stringify(edgeInfo, null, 2) }] };
      }

      case "crypto_utils": {
        const text = String(args.text || "");
        const algorithm = String(args.algorithm || "").toLowerCase();

        if (algorithm === "base64_encode") {
          const encoded = btoa(unescape(encodeURIComponent(text)));
          return { content: [{ type: "text", text: encoded }] };
        }

        if (algorithm === "base64_decode") {
          try {
            const decoded = decodeURIComponent(escape(atob(text)));
            return { content: [{ type: "text", text: decoded }] };
          } catch (e: any) {
            return { content: [{ type: "text", text: `Base64 decode error: ${e.message}` }], isError: true };
          }
        }

        if (algorithm === "sha256" || algorithm === "sha512") {
          const algoName = algorithm === "sha256" ? "SHA-256" : "SHA-512";
          const msgBuffer = new TextEncoder().encode(text);
          const hashBuffer = await crypto.subtle.digest(algoName, msgBuffer);
          const hashArray = Array.from(new Uint8Array(hashBuffer));
          const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
          return { content: [{ type: "text", text: hashHex }] };
        }

        return {
          content: [{ type: "text", text: `Unsupported algorithm: ${algorithm}` }],
          isError: true,
        };
      }

      case "http_request": {
        const url = String(args.url || "").trim();
        const method = String(args.method || "GET").toUpperCase();
        const headers = typeof args.headers === "object" && args.headers !== null ? args.headers : {};
        const body = args.body ? String(args.body) : undefined;

        if (!url.startsWith("http://") && !url.startsWith("https://")) {
          return { content: [{ type: "text", text: "Error: Invalid URL scheme" }], isError: true };
        }

        const fetchInit: RequestInit = {
          method,
          headers: {
            "User-Agent": "CloudflareWorkerMCP/1.0",
            ...headers,
          },
        };

        if (body && !["GET", "HEAD"].includes(method)) {
          fetchInit.body = body;
        }

        const res = await fetch(url, fetchInit);
        const resText = await res.text();
        let parsedBody: any = resText;
        try {
          parsedBody = JSON.parse(resText);
        } catch {
          // keep as string
        }

        const resHeaders: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          resHeaders[k] = v;
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: res.status,
                  statusText: res.statusText,
                  headers: resHeaders,
                  data: parsedBody,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "json_processor": {
        const jsonStr = String(args.json_string || "");
        const op = String(args.operation || "prettify").toLowerCase();
        const path = String(args.path || "").trim();

        let parsed: any;
        try {
          parsed = JSON.parse(jsonStr);
        } catch (e: any) {
          return { content: [{ type: "text", text: `Invalid JSON: ${e.message}` }], isError: true };
        }

        if (op === "prettify") {
          return { content: [{ type: "text", text: JSON.stringify(parsed, null, 2) }] };
        }

        if (op === "minify") {
          return { content: [{ type: "text", text: JSON.stringify(parsed) }] };
        }

        if (op === "get_keys") {
          const keys = typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : [];
          return { content: [{ type: "text", text: JSON.stringify(keys, null, 2) }] };
        }

        if (op === "query_path") {
          if (!path) {
            return { content: [{ type: "text", text: "Error: 'path' parameter is required for query_path" }], isError: true };
          }
          const parts = path.split(".");
          let current = parsed;
          for (const part of parts) {
            if (current && typeof current === "object" && part in current) {
              current = current[part];
            } else {
              return { content: [{ type: "text", text: `Path '${path}' not found at segment '${part}'` }], isError: true };
            }
          }
          return { content: [{ type: "text", text: JSON.stringify(current, null, 2) }] };
        }

        return { content: [{ type: "text", text: `Unknown operation: ${op}` }], isError: true };
      }

      case "uuid_generator": {
        const count = Math.max(1, Math.min(20, Number(args.count) || 1));
        const uuids = Array.from({ length: count }, () => crypto.randomUUID());
        return { content: [{ type: "text", text: JSON.stringify(uuids, null, 2) }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Tool not found: ${name}` }],
          isError: true,
        };
    }
  } catch (error: any) {
    return {
      content: [{ type: "text", text: `Error executing ${name}: ${error.message}` }],
      isError: true,
    };
  }
}
