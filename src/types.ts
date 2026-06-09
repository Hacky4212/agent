// Core message types (OpenAI-compatible)
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
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
};

// Options passed to the client for a single request
export interface ChatOptions {
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
}

// Models known to support the thinking/reasoning_effort parameters
export const THINKING_CAPABLE_MODELS = new Set([
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-reasoner',
]);
