import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { type ToolDefinition } from './types.js';
import { getConfig } from './config.js';
import { getSearchProvider, SearchConfigError } from './search.js';
import { truncate } from './utils.js';

export interface ToolContext {
  signal?: AbortSignal;
  cwd: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  needsConfirmation: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

// Caps to keep tool output from blowing up the context window
const MAX_FILE_BYTES = 100_000;
const MAX_OUTPUT_CHARS = 30_000;
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_FETCH_BYTES = 500_000;

// ── Path sandbox ────────────────────────────────────────────────────────────
// Resolve a user/model-supplied path against cwd and reject anything that
// escapes the working directory. Soft sandbox: symlinks can still escape.
function sandboxPath(ctx: ToolContext, p: string): string {
  if (typeof p !== 'string' || !p) {
    throw new Error('path is required');
  }
  const root = path.resolve(ctx.cwd);
  const resolved = path.resolve(root, p);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path escapes working directory: ${p}`);
  }
  return resolved;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new Error(`${key} must be a string`);
  return v;
}

// ── File tools ──────────────────────────────────────────────────────────────
const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a text file from the working directory and return its contents. Large files are truncated.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the working directory' },
    },
    required: ['path'],
  },
  needsConfirmation: false,
  async execute(args, ctx) {
    const fp = sandboxPath(ctx, requireString(args, 'path'));
    if (!existsSync(fp)) throw new Error(`file not found: ${args['path']}`);
    const info = await stat(fp);
    if (info.isDirectory()) throw new Error(`${args['path']} is a directory, use list_dir`);
    const content = await readFile(fp, 'utf-8');
    if (content.length > MAX_FILE_BYTES) {
      return truncate(content, MAX_FILE_BYTES) + '\n\n[truncated]';
    }
    return content;
  },
};

const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Write text content to a file in the working directory, creating or overwriting it.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the working directory' },
      content: { type: 'string', description: 'The full file content to write' },
    },
    required: ['path', 'content'],
  },
  needsConfirmation: true,
  async execute(args, ctx) {
    const fp = sandboxPath(ctx, requireString(args, 'path'));
    const content = requireString(args, 'content');
    const { mkdir } = await import('fs/promises');
    await mkdir(path.dirname(fp), { recursive: true });
    await writeFile(fp, content, 'utf-8');
    return `Wrote ${content.length} bytes to ${args['path']}`;
  },
};

const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file with a new string. old_string must appear exactly once.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path relative to the working directory' },
      old_string: { type: 'string', description: 'Exact text to find (must be unique)' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  needsConfirmation: true,
  async execute(args, ctx) {
    const fp = sandboxPath(ctx, requireString(args, 'path'));
    const oldStr = requireString(args, 'old_string');
    const newStr = requireString(args, 'new_string');
    if (!existsSync(fp)) throw new Error(`file not found: ${args['path']}`);
    const content = await readFile(fp, 'utf-8');
    const count = content.split(oldStr).length - 1;
    if (count === 0) throw new Error('old_string not found in file');
    if (count > 1) throw new Error(`old_string is not unique (${count} matches)`);
    await writeFile(fp, content.replace(oldStr, newStr), 'utf-8');
    return `Edited ${args['path']}`;
  },
};

const listDirTool: Tool = {
  name: 'list_dir',
  description: 'List files and subdirectories in a directory within the working directory.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to cwd (default ".")' },
    },
  },
  needsConfirmation: false,
  async execute(args, ctx) {
    const rel = typeof args['path'] === 'string' && args['path'] ? (args['path'] as string) : '.';
    const dir = sandboxPath(ctx, rel);
    if (!existsSync(dir)) throw new Error(`directory not found: ${rel}`);
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.length === 0) return '(empty directory)';
    return entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n');
  },
};

// ── Shell tool ────────────────────────────────────────────────────────────
const runCommandTool: Tool = {
  name: 'run_command',
  description:
    'Run a shell command in the working directory and return its stdout, stderr, and exit code.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to execute' },
    },
    required: ['command'],
  },
  needsConfirmation: true,
  execute(args, ctx) {
    const command = requireString(args, 'command');
    return new Promise<string>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        cwd: ctx.cwd,
        signal: ctx.signal,
      });

      let stdout = '';
      let stderr = '';
      let truncated = false;

      const append = (buf: Buffer, which: 'out' | 'err') => {
        const s = buf.toString();
        if (which === 'out') {
          if (stdout.length < MAX_OUTPUT_CHARS) stdout += s;
          else truncated = true;
        } else {
          if (stderr.length < MAX_OUTPUT_CHARS) stderr += s;
          else truncated = true;
        }
      };

      child.stdout?.on('data', (b) => append(b, 'out'));
      child.stderr?.on('data', (b) => append(b, 'err'));

      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`command timed out after ${COMMAND_TIMEOUT_MS}ms`));
      }, COMMAND_TIMEOUT_MS);

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        const parts = [`exit code: ${code ?? 'null'}`];
        if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`);
        if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`);
        if (truncated) parts.push('[output truncated]');
        resolve(parts.join('\n\n'));
      });
    });
  },
};

// ── Web tools ─────────────────────────────────────────────────────────────
// Block requests to loopback / private / link-local ranges to mitigate SSRF.
function isBlockedIp(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true; // link-local + cloud metadata
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true; // 172.16/12
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // unique local v6
  if (ip.startsWith('fe80')) return true; // link-local v6
  return false;
}

async function assertSafeUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('only http and https URLs are allowed');
  }
  // Resolve DNS and re-check the resolved IP to defeat rebinding.
  const host = url.hostname;
  if (isIP(host)) {
    if (isBlockedIp(host)) throw new Error('blocked: private or loopback address');
  } else {
    const { address } = await lookup(host);
    if (isBlockedIp(address)) throw new Error('blocked: resolves to a private address');
  }
  return url;
}

// Minimal HTML → text: strip script/style, drop tags, collapse whitespace.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const webFetchTool: Tool = {
  name: 'web_fetch',
  description: 'Fetch a web page by URL and return its readable text content.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The http(s) URL to fetch' },
    },
    required: ['url'],
  },
  needsConfirmation: false,
  async execute(args, ctx) {
    const url = await assertSafeUrl(requireString(args, 'url'));
    const res = await fetch(url, {
      signal: ctx.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'deepseek-cli/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > MAX_FETCH_BYTES ? buf.slice(0, MAX_FETCH_BYTES) : buf;
    const raw = new TextDecoder().decode(slice);
    const contentType = res.headers.get('content-type') ?? '';
    const text = contentType.includes('html') ? htmlToText(raw) : raw;
    return truncate(text, MAX_OUTPUT_CHARS);
  },
};

const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web for a query and return a list of result titles, URLs, and snippets.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query' },
      max_results: { type: 'number', description: 'Number of results (default 5)' },
    },
    required: ['query'],
  },
  needsConfirmation: false,
  async execute(args, ctx) {
    const query = requireString(args, 'query');
    const maxResults =
      typeof args['max_results'] === 'number' ? (args['max_results'] as number) : 5;
    try {
      const provider = getSearchProvider();
      const results = await provider.search(query, { maxResults, signal: ctx.signal });
      if (results.length === 0) return 'No results found.';
      return results
        .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
        .join('\n\n');
    } catch (err) {
      if (err instanceof SearchConfigError) return `Error: ${err.message}`;
      throw err;
    }
  },
};

// ── Registry ────────────────────────────────────────────────────────────────
const ALL_TOOLS: Tool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  runCommandTool,
  webFetchTool,
  webSearchTool,
];

const TOOL_MAP = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return TOOL_MAP.get(name);
}

// Tools to expose this session (all of them when tools are enabled).
export function getEnabledTools(): Tool[] {
  return ALL_TOOLS;
}

// Convert tools into the OpenAI `tools` array shape for the API.
export function toOpenAITools(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// Execute a tool (thin wrapper to keep a single call site for future logging).
export function executeTool(
  tool: Tool,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  return tool.execute(args, ctx);
}
