/** MCP tool annotations: a client can require confirmation before writes. */
export const READ_ONLY = { readOnlyHint: true } as const
export const WRITES = { readOnlyHint: false } as const
export const WRITES_PERSISTENTLY = { readOnlyHint: false, destructiveHint: true } as const
