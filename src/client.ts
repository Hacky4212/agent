import OpenAI from 'openai';
import { getConfig } from './config.js';
import {
  type Message,
  type ChatOptions,
  type Usage,
  THINKING_CAPABLE_MODELS,
} from './types.js';

// Callback signature for streaming chunks
export type StreamCallback = (text: string) => void;

export interface StreamResult {
  fullText: string;
  thinkingText: string; // content inside <think>...</think>
  usage: Usage | null;
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

  const requestParams: Record<string, unknown> = {
    model,
    messages,
    max_tokens: opts.maxTokens ?? cfg.maxTokens,
    temperature: opts.temperature ?? cfg.temperature,
    stream: true,
    stream_options: { include_usage: true },
  };

  // reasoning_effort is a top-level param (not inside extra_body)
  if (useThinking) {
    requestParams['reasoning_effort'] = effort;
  }

  const stream = await (client.chat.completions.create as Function)(
    { ...requestParams, ...extraBody },
    { signal },
  ) as AsyncIterable<{
    choices: Array<{
      delta: {
        content?: string | null;
        reasoning_content?: string | null;
      };
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

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;

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

    if (chunk.usage) {
      usage = {
        prompt_tokens: chunk.usage.prompt_tokens,
        completion_tokens: chunk.usage.completion_tokens,
        total_tokens: chunk.usage.total_tokens,
      };
    }
  }

  return { fullText, thinkingText, usage };
}
