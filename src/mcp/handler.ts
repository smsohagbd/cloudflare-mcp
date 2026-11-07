import { JSONRPCRequest, JSONRPCResponse } from "./types";
import { TOOLS, executeTool, ToolContext } from "../tools";

const SERVER_INFO = {
  name: "cloudflare-mcp",
  version: "1.0.0",
};

const PROMPTS = [
  {
    name: "inspect_domain",
    description: "Inspect a domain's DNS records, web content, and health",
    arguments: [
      {
        name: "domain",
        description: "Target domain name",
        required: true,
      },
    ],
  },
  {
    name: "network_diagnostics",
    description: "Run IP and DNS diagnostics",
    arguments: [
      {
        name: "target",
        description: "Target IP or host",
        required: true,
      },
    ],
  },
];

const RESOURCES = [
  {
    uri: "cloudflare://system/info",
    name: "Cloudflare Edge Info",
    description: "Information about the Cloudflare Worker runtime and edge location",
    mimeType: "application/json",
  },
];

export async function handleMCPRequest(
  request: Request,
  env: Record<string, any>
): Promise<Response> {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-mcp-version",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed. Use POST." }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: any;
  try {
    body = await request.json();
  } catch (e: any) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: Invalid JSON" },
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Handle single request or batch requests
  if (Array.isArray(body)) {
    const responses = await Promise.all(
      body.map((req) => processSingleRPC(req, { request, env }))
    );
    return new Response(JSON.stringify(responses), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const response = await processSingleRPC(body, { request, env });

  // Notifications (requests without an ID) do not receive a JSON-RPC response
  if (body.id === undefined) {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function processSingleRPC(
  req: JSONRPCRequest,
  ctx: ToolContext
): Promise<JSONRPCResponse> {
  const id = req.id ?? null;

  if (!req.method) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid Request: method is required" },
    };
  }

  switch (req.method) {
    case "initialize": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: SERVER_INFO,
          capabilities: {
            tools: {
              listChanged: false,
            },
            resources: {
              subscribe: false,
              listChanged: false,
            },
            prompts: {
              listChanged: false,
            },
          },
        },
      };
    }

    case "notifications/initialized": {
      return {
        jsonrpc: "2.0",
        id,
        result: {},
      };
    }

    case "ping": {
      return {
        jsonrpc: "2.0",
        id,
        result: {},
      };
    }

    case "tools/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS,
        },
      };
    }

    case "tools/call": {
      const toolName = req.params?.name;
      const toolArgs = req.params?.arguments || {};

      if (!toolName) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Missing tool name in params" },
        };
      }

      const result = await executeTool(toolName, toolArgs, ctx);
      return {
        jsonrpc: "2.0",
        id,
        result,
      };
    }

    case "resources/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          resources: RESOURCES,
        },
      };
    }

    case "resources/read": {
      const uri = req.params?.uri;
      if (uri === "cloudflare://system/info") {
        const cf = (ctx.request as any).cf || {};
        return {
          jsonrpc: "2.0",
          id,
          result: {
            contents: [
              {
                uri,
                mimeType: "application/json",
                text: JSON.stringify(
                  {
                    server: SERVER_INFO,
                    edge: {
                      colo: cf.colo,
                      country: cf.country,
                      timezone: cf.timezone,
                      asn: cf.asn,
                    },
                    timestamp: new Date().toISOString(),
                  },
                  null,
                  2
                ),
              },
            ],
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32002, message: `Resource not found: ${uri}` },
      };
    }

    case "prompts/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          prompts: PROMPTS,
        },
      };
    }

    case "prompts/get": {
      const promptName = req.params?.name;
      const targetPrompt = PROMPTS.find((p) => p.name === promptName);

      if (!targetPrompt) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Prompt not found: ${promptName}` },
        };
      }

      const args = req.params?.arguments || {};
      let promptText = "";

      if (promptName === "inspect_domain") {
        promptText = `Please inspect the domain "${args.domain || "example.com"}" using dns_lookup and fetch_web_content tools. Provide a complete analysis of its DNS records and reachable homepage content.`;
      } else if (promptName === "network_diagnostics") {
        promptText = `Run diagnostics for target "${args.target || "1.1.1.1"}" using ip_lookup and dns_lookup tools.`;
      }

      return {
        jsonrpc: "2.0",
        id,
        result: {
          description: targetPrompt.description,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: promptText,
              },
            },
          ],
        },
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      };
  }
}
