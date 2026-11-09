import { MCPToolDefinition, MCPToolResult } from "../mcp/types";
import { GENERAL_TOOLS, executeGeneralTool, ToolContext } from "./general";
import { STORAGE_TOOLS, executeStorageTool } from "./storage";
import { SOCIAL_TOOLS, executeSocialTool } from "./social";
import { GITHUB_TOOLS, executeGithubTool } from "./github";

export type { ToolContext };

export const TOOLS: MCPToolDefinition[] = [
  ...GENERAL_TOOLS,
  ...STORAGE_TOOLS,
  ...SOCIAL_TOOLS,
  ...GITHUB_TOOLS,
];

export async function executeTool(
  name: string,
  args: Record<string, any> = {},
  ctx: ToolContext
): Promise<MCPToolResult> {
  try {
    // 1. Try General Tools
    const generalRes = await executeGeneralTool(name, args, ctx);
    if (generalRes) return generalRes;

    // 2. Try Storage & D1 / R2 Tools
    const storageRes = await executeStorageTool(name, args, ctx);
    if (storageRes) return storageRes;

    // 3. Try Social Automation Tools (LinkedIn, YouTube)
    const socialRes = await executeSocialTool(name, args, ctx);
    if (socialRes) return socialRes;

    // 4. Try GitHub Tools
    const githubRes = await executeGithubTool(name, args, ctx);
    if (githubRes) return githubRes;

    return {
      content: [{ type: "text", text: `Tool '${name}' not found` }],
      isError: true,
    };
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `Execution error in '${name}': ${err.message}` }],
      isError: true,
    };
  }
}
