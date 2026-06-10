// A tool call requested by the assistant (OpenAI-compatible shape).
// `arguments` is a JSON string the model produced; parse before use.
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

// Core message types (OpenAI-compatible)
export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  // assistant turn that requested one or more tools
  tool_calls?: ToolCall[];
  // role:'tool' result — which call it answers
  tool_call_id?: string;
  // role:'tool' result — the tool's name (for serialization/debug)
  name?: string;
}

// OpenAI-shape tool definition sent to the API in the `tools` array
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

// Usage stats returned by the API
export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

// DeepSeek V4 thinking mode configuration
export type ReasoningEffort = 'high' | 'max';

export interface ThinkingConfig {
  enabled: boolean;
  effort: ReasoningEffort;
}

// Persistent user configuration
export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  showUsage: boolean;
  theme: 'dark' | 'light';
  thinking: boolean;
  reasoningEffort: ReasoningEffort;
  // ── Agentic tool-use ──────────────────────────────────────────────
  toolsEnabled: boolean;          // master switch for tool calling
  autoApproveTools: boolean;      // skip y/N confirmation (dangerous)
  searchProvider: 'tavily' | 'brave';
  searchApiKey: string;           // key for the web_search provider
  maxToolIterations: number;      // loop guard for the agentic turn
}

export const DEFAULT_CONFIG: Config = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-pro',
  systemPrompt: 'You are a helpful assistant.',
  maxTokens: 8192,
  temperature: 1.0,
  showUsage: true,
  theme: 'dark',
  thinking: true,         // thinking mode on by default
  reasoningEffort: 'max', // max = deepest reasoning, equivalent to Claude xhigh
  toolsEnabled: true,     // tool calling on by default
  autoApproveTools: false,
  searchProvider: 'tavily',
  searchApiKey: '',
  maxToolIterations: 10,
};

// Options passed to the client for a single request
export interface ChatOptions {
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  tools?: ToolDefinition[]; // tool definitions exposed to the model
}

// Models known to support the thinking/reasoning_effort parameters
export const THINKING_CAPABLE_MODELS = new Set([
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-reasoner',
]);
