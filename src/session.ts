import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import chalk from 'chalk';
import { type Message, type ToolCall } from './types.js';
import { getHistoryDir, truncate } from './utils.js';

export interface HistoryEntry {
  id: string;
  timestamp: string;
  model: string;
  title: string; // First user message (truncated)
  messages: Message[];
}

// Session holds the active conversation for one CLI invocation
export class Session {
  private messages: Message[] = [];
  private historyId: string;
  model: string;

  constructor(model: string, systemPrompt?: string) {
    this.model = model;
    this.historyId = new Date().toISOString().replace(/[:.]/g, '-');

    if (systemPrompt) {
      this.messages.push({ role: 'system', content: systemPrompt });
    }
  }

  addUser(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  addAssistant(content: string): void {
    this.messages.push({ role: 'assistant', content });
  }

  // Assistant turn that requested one or more tool calls
  addAssistantToolCalls(content: string, toolCalls: ToolCall[]): void {
    this.messages.push({ role: 'assistant', content, tool_calls: toolCalls });
  }

  // Result of executing a tool, answering a specific tool call
  addToolResult(toolCallId: string, name: string, content: string): void {
    this.messages.push({ role: 'tool', content, tool_call_id: toolCallId, name });
  }

  getMessages(): Message[] {
    return this.messages;
  }

  // Number of turns (user + assistant pairs)
  getTurns(): number {
    return this.messages.filter((m) => m.role === 'user').length;
  }

  clear(keepSystem = true): void {
    if (keepSystem) {
      this.messages = this.messages.filter((m) => m.role === 'system');
    } else {
      this.messages = [];
    }
  }

  // Persist current conversation to history directory
  async save(): Promise<void> {
    const dir = getHistoryDir();
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const firstUser = this.messages.find((m) => m.role === 'user');
    if (!firstUser) return; // Nothing to save

    const entry: HistoryEntry = {
      id: this.historyId,
      timestamp: new Date().toISOString(),
      model: this.model,
      title: truncate(firstUser.content.replace(/\n/g, ' '), 80),
      messages: this.messages,
    };

    const file = path.join(dir, `${this.historyId}.json`);
    await writeFile(file, JSON.stringify(entry, null, 2), 'utf-8');
  }

  // Export conversation to a markdown file
  async export(filePath: string): Promise<void> {
    const lines = [`# Conversation export\n`, `_${new Date().toLocaleString()}_\n`];

    for (const m of this.messages) {
      if (m.role === 'system') continue;

      if (m.role === 'tool') {
        lines.push(
          `\n**Tool result** (${m.name ?? 'tool'}):\n\n\`\`\`\n${m.content}\n\`\`\`\n\n---`,
        );
        continue;
      }

      const label = m.role === 'user' ? '**You**' : '**Assistant**';
      let body = m.content;

      // Assistant turn that requested tool calls
      if (m.tool_calls?.length) {
        const calls = m.tool_calls
          .map((tc) => `- \`${tc.function.name}(${tc.function.arguments})\``)
          .join('\n');
        body = body
          ? `${body}\n\n_Tool calls:_\n${calls}`
          : `_Tool calls:_\n${calls}`;
      }

      lines.push(`\n${label}:\n\n${body}\n\n---`);
    }

    await writeFile(filePath, lines.join('\n'), 'utf-8');
  }
}

// Load and display saved history entries
export async function listHistory(limit = 20): Promise<void> {
  const dir = getHistoryDir();
  if (!existsSync(dir)) {
    console.log(chalk.dim('No history yet.'));
    return;
  }

  const { readdir } = await import('fs/promises');
  const files = (await readdir(dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, limit);

  if (files.length === 0) {
    console.log(chalk.dim('No history yet.'));
    return;
  }

  console.log(`\n${chalk.bold('Recent conversations:')}`);
  console.log(chalk.dim('─'.repeat(60)));

  for (const f of files) {
    try {
      const raw = await readFile(path.join(dir, f), 'utf-8');
      const entry: HistoryEntry = JSON.parse(raw);
      const date = new Date(entry.timestamp).toLocaleString();
      const turns = entry.messages.filter((m) => m.role === 'user').length;
      console.log(
        `  ${chalk.dim(date)}  ${chalk.cyan(entry.model)}  ${chalk.dim(`${turns} turns`)}`,
      );
      console.log(`  ${chalk.white(entry.title)}`);
      console.log(chalk.dim('  ' + '─'.repeat(58)));
    } catch {
      // Skip corrupted entries silently
    }
  }
  console.log();
}
