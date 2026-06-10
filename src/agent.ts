import { streamChat } from './client.js';
import { Session } from './session.js';
import { getConfig } from './config.js';
import { getTool, executeTool } from './tools.js';
import type { Tool } from './tools.js';
import { type ChatOptions, type Usage, type ToolCall } from './types.js';

// What the caller decided about a tool that needs confirmation.
export type ConfirmDecision = 'yes' | 'no' | 'always';

export interface AgentCallbacks {
  // Streamed answer tokens (delta.content)
  onAnswerChunk: (text: string) => void;
  // Streamed thinking tokens (delta.reasoning_content)
  onThinkChunk?: (text: string) => void;
  // A turn finished streaming and we're about to run a tool
  onToolStart?: (call: ToolCall, args: Record<string, unknown>) => void;
  // A tool finished (or failed / was denied)
  onToolResult?: (call: ToolCall, result: string, ok: boolean) => void;
  // Ask the user to confirm a needs-confirmation tool. Only called for tools
  // that require it and aren't already always-allowed.
  confirm: (tool: Tool, args: Record<string, unknown>) => Promise<ConfirmDecision>;
}

function safeParseArgs(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false } {
  if (!raw || !raw.trim()) return { ok: true, args: {} };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return { ok: true, args: parsed };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

// Run a full agentic turn: stream the model, execute any tool calls it makes,
// feed results back, and repeat until the model answers without tools (or the
// iteration guard trips). All conversation state is appended to `session`.
export async function runAgentTurn(
  session: Session,
  opts: ChatOptions,
  cb: AgentCallbacks,
  signal?: AbortSignal,
): Promise<{ usage: Usage | null }> {
  const cfg = getConfig();
  const maxIterations = cfg.maxToolIterations;
  const alwaysAllowed = new Set<string>();
  let usage: Usage | null = null;

  for (let iter = 0; iter < maxIterations; iter++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const result = await streamChat(
      session.getMessages(),
      opts,
      cb.onAnswerChunk,
      cb.onThinkChunk,
      signal,
    );
    if (result.usage) usage = result.usage;

    // No tool calls → the model gave its final answer. Done.
    if (result.toolCalls.length === 0) {
      session.addAssistant(result.fullText);
      return { usage };
    }

    // Record the assistant turn that requested the tools.
    session.addAssistantToolCalls(result.fullText, result.toolCalls);

    // Execute each tool call; every call MUST get a tool result appended so
    // the API constraint (one tool message per tool_call_id) is satisfied.
    for (const call of result.toolCalls) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const tool = getTool(call.function.name);
      if (!tool) {
        const msg = `Error: unknown tool "${call.function.name}"`;
        session.addToolResult(call.id, call.function.name, msg);
        cb.onToolResult?.(call, msg, false);
        continue;
      }

      const parsed = safeParseArgs(call.function.arguments);
      if (!parsed.ok) {
        const msg = 'Error: arguments were not valid JSON';
        session.addToolResult(call.id, tool.name, msg);
        cb.onToolResult?.(call, msg, false);
        continue;
      }
      const args = parsed.args;

      cb.onToolStart?.(call, args);

      // Confirmation gate for destructive tools.
      if (tool.needsConfirmation && !alwaysAllowed.has(tool.name)) {
        const decision = await cb.confirm(tool, args);
        if (decision === 'always') {
          alwaysAllowed.add(tool.name);
        } else if (decision === 'no') {
          const msg = 'Error: user denied execution of this tool.';
          session.addToolResult(call.id, tool.name, msg);
          cb.onToolResult?.(call, 'denied', false);
          continue;
        }
      }

      try {
        const out = await executeTool(tool, args, { signal, cwd: process.cwd() });
        session.addToolResult(call.id, tool.name, out);
        cb.onToolResult?.(call, out, true);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        const msg = `Error: ${err instanceof Error ? err.message : String(err)}`;
        session.addToolResult(call.id, tool.name, msg);
        cb.onToolResult?.(call, msg, false);
      }
    }
    // Loop: next streamChat call sees the tool results.
  }

  // Iteration guard tripped.
  const msg = '(stopped: reached max tool iterations)';
  session.addAssistant(msg);
  cb.onAnswerChunk('\n' + msg + '\n');
  return { usage };
}
