import OpenAI from 'openai';
import { getConfig } from './config.js';
import {
  type Message,
  type ChatOptions,
  type Usage,
  type ToolCall,
  THINKING_CAPABLE_MODELS,
} from './types.js';

// Callback signature for streaming chunks
export type StreamCallback = (text: string) => void;

export interface StreamResult {
  fullText: string;
  thinkingText: string; // content inside <think>...</think>
  usage: Usage | null;
  toolCalls: ToolCall[]; // tool calls the model requested this turn
  finishReason: string | null;
}

// Build an OpenAI client pointed at DeepSeek's endpoint
function createClient(): OpenAI {
  const cfg = getConfig();
  if (!cfg.apiKey) {
    throw new Error(
      'API key not set. Run: dsk config set api-key <your-key>',
    );
  }
  return new OpenAI({
    apiKey: cfg.apiKey,
    baseURL: cfg.baseUrl,
  });
}

// Detect if the model supports thinking mode
function supportsThinking(model: string): boolean {
  return THINKING_CAPABLE_MODELS.has(model);
}

// When tools are exposed, the model needs to know it has REAL agentic
// capabilities on the user's machine — otherwise a conservative system prompt
// makes it refuse ("I can't operate your computer") instead of calling a tool.
function buildAgentSystemPrompt(): string {
  const platform =
    process.platform === 'win32'
      ? 'Windows'
      : process.platform === 'darwin'
        ? 'macOS'
        : 'Linux';
  return [
    `You are running inside a command-line tool on the user's ${platform} machine, and you have REAL tools that act on this machine right now:`,
    `read_file, write_file, edit_file, list_dir (filesystem), run_command (run shell commands), web_fetch and web_search (internet).`,
    `When a request can be accomplished with these tools, USE them. Do NOT tell the user to do it manually, and do NOT claim you cannot access or operate their computer — you can.`,
    `For example: to open an application, run a program, inspect or change files, check system state, or look something up online, call the appropriate tool instead of explaining how the user could do it.`,
    `Shell commands execute on ${platform}; use that OS's correct command syntax (e.g. on Windows, "calc" opens the calculator).`,
    `Only describe manual steps when no available tool can do the job, or when the user has declined a tool action.`,
  ].join(' ');
}

// Merge the agent capability prompt into the message list without mutating the
// caller's array. Prepends to the existing system message, or adds one.
function withAgentSystemPrompt(messages: Message[]): Message[] {
  const agentPrompt = buildAgentSystemPrompt();
  const result = [...messages];
  const sysIdx = result.findIndex((m) => m.role === 'system');
  if (sysIdx >= 0) {
    result[sysIdx] = {
      ...result[sysIdx]!,
      content: `${agentPrompt}\n\n${result[sysIdx]!.content}`,
    };
  } else {
    result.unshift({ role: 'system', content: agentPrompt });
  }
  return result;
}

// Stream a chat completion.
// For V4 Pro, thinking deltas arrive in delta.reasoning_content;
// the final answer arrives in delta.content as usual.
export async function streamChat(
  messages: Message[],
  opts: ChatOptions = {},
  onChunk: StreamCallback,
  onThinkChunk?: StreamCallback, // optional: called with thinking tokens
  signal?: AbortSignal,
): Promise<StreamResult> {
  const cfg = getConfig();
  const model = opts.model ?? cfg.model;
  const client = createClient();

  const useThinking =
    supportsThinking(model) &&
    (opts.thinking ?? cfg.thinking);

  const effort = opts.reasoningEffort ?? cfg.reasoningEffort;

  // extra_body carries DeepSeek-specific parameters the OpenAI SDK doesn't type
  const extraBody: Record<string, unknown> = {};
  if (useThinking) {
    extraBody['thinking'] = { type: 'enabled' };
  }

  const useTools = !!(opts.tools && opts.tools.length > 0);

  const requestParams: Record<string, unknown> = {
    model,
    // When tools are exposed, inject the agent capability prompt so the model
    // knows it can actually act on this machine instead of refusing.
    messages: useTools ? withAgentSystemPrompt(messages) : messages,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    temperature: opts.temperature ?? cfg.temperature,
    stream: true,
    stream_options: { include_usage: true },
  };

  // reasoning_effort is a top-level param (not inside extra_body)
  if (useThinking) {
    requestParams['reasoning_effort'] = effort;
  }

  // Expose tools to the model when provided
  if (useTools) {
    requestParams['tools'] = opts.tools;
    requestParams['tool_choice'] = 'auto';
  }

  const stream = await (client.chat.completions.create as Function)(
    { ...requestParams, ...extraBody },
    { signal },
  ) as AsyncIterable<{
    choices: Array<{
      delta: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: Array<{
          index: number;
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
      finish_reason?: string | null;
    }>;
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | null;
  }>;

  let fullText = '';
  let thinkingText = '';
  let usage: Usage | null = null;
  let finishReason: string | null = null;

  // tool_calls arrive incrementally, keyed by index. The first delta for an
  // index carries id + function.name; later deltas append arguments fragments.
  const toolCallsByIndex = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta;

    if (choice?.finish_reason) finishReason = choice.finish_reason;

    if (delta) {
      // Thinking tokens (reasoning_content)
      const thinkDelta = delta.reasoning_content ?? '';
      if (thinkDelta) {
        thinkingText += thinkDelta;
        onThinkChunk?.(thinkDelta);
      }

      // Answer tokens (content)
      const answerDelta = delta.content ?? '';
      if (answerDelta) {
        fullText += answerDelta;
        onChunk(answerDelta);
      }

      // Tool call deltas
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let slot = toolCallsByIndex.get(tc.index);
          if (!slot) {
            slot = { id: '', name: '', arguments: '' };
            toolCallsByIndex.set(tc.index, slot);
          }
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.arguments += tc.function.arguments;
        }
      }
    }

    if (chunk.usage) {
      usage = {
        prompt_tokens: chunk.usage.prompt_tokens,
        completion_tokens: chunk.usage.completion_tokens,
        total_tokens: chunk.usage.total_tokens,
      };
    }
  }

  let toolCalls: ToolCall[] = [...toolCallsByIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, v]) => ({
      id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function' as const,
      function: { name: v.name, arguments: v.arguments },
    }))
    .filter((c) => c.function.name);

  // DeepSeek caveat: sometimes a tool call leaks into `content` as plain text
  // instead of the structured field. Recover conservatively if so.
  if (toolCalls.length === 0 && opts.tools && opts.tools.length > 0) {
    const knownNames = new Set(opts.tools.map((t) => t.function.name));
    const recovered = recoverLeakedToolCalls(fullText, knownNames);
    if (recovered.calls.length > 0) {
      toolCalls = recovered.calls;
      fullText = recovered.cleanedText;
    }
  }

  return { fullText, thinkingText, usage, toolCalls, finishReason };
}

// Attempt to recover a tool call the model emitted as plain text in `content`
// (a known DeepSeek bug). Conservative: only fires when a JSON object naming a
// registered tool with parseable arguments is found. Returns the recovered
// calls and the text with the leaked portion stripped out.
function recoverLeakedToolCalls(
  text: string,
  knownNames: Set<string>,
): { calls: ToolCall[]; cleanedText: string } {
  const calls: ToolCall[] = [];
  let cleaned = text;

  // Look for JSON objects (optionally fenced) shaped like a tool call:
  //   {"name": "read_file", "arguments": {...}}
  // or {"function": {"name": "...", "arguments": {...}}}
  const fenceRe = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
  const candidates: { raw: string; json: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    candidates.push({ raw: m[0]!, json: m[1]! });
  }
  // Also try the whole trimmed text as a bare JSON object
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    candidates.push({ raw: text, json: trimmed });
  }

  for (const cand of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(cand.json);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    const fn = (obj['function'] as Record<string, unknown> | undefined) ?? obj;
    const name = fn['name'];
    if (typeof name !== 'string' || !knownNames.has(name)) continue;

    const rawArgs = fn['arguments'] ?? obj['parameters'] ?? {};
    const argString =
      typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
    calls.push({
      id: `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name, arguments: argString },
    });
    cleaned = cleaned.replace(cand.raw, '').trim();
  }

  return { calls, cleanedText: cleaned };
}
