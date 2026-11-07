export interface JSONRPCRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface MCPToolProperty {
  type: string;
  description: string;
  enum?: string[];
  default?: any;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, MCPToolProperty>;
    required?: string[];
  };
}

export interface MCPToolContent {
  type: "text";
  text: string;
}

export interface MCPToolResult {
  content: MCPToolContent[];
  isError?: boolean;
}
