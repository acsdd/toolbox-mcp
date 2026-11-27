import { z } from 'zod'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { TOOL_CATALOG, TOOL_GROUPS, type ToolAnnotations, type ToolGroupMeta } from './catalog.js'

export interface ToolContractTool {
  name: string
  group: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: ToolAnnotations
}

export interface ToolContract {
  schemaVersion: 1
  service: 'toolbox-mcp'
  version: string
  groups: ToolGroupMeta[]
  tools: ToolContractTool[]
}

export function buildToolContract(version: string): ToolContract {
  return {
    schemaVersion: 1,
    service: 'toolbox-mcp',
    version,
    groups: TOOL_GROUPS,
    tools: TOOL_CATALOG.map((tool) => ({
      name: tool.name,
      group: tool.group,
      description: tool.description,
      // Use the SDK's own conversion so the contract is byte-identical to
      // what tools/list advertises; a different dialect would read as drift.
      inputSchema: toJsonSchemaCompat(z.object(tool.shape), {
        strictUnions: true,
        pipeStrategy: 'input'
      }),
      annotations: tool.annotations
    }))
  }
}
