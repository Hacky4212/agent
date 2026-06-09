import chalk from 'chalk';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { type Usage } from './types.js';

// Configure marked to use the terminal renderer
marked.use(new TerminalRenderer({
  code: (code: string, lang: string) => renderCodeBlock(code, lang),
  codespan: (text: string) => chalk.bgGray.white(` ${text} `),
  heading: (text: string, level: number) => {
    const colors = [
      chalk.bold.magenta,
      chalk.bold.cyan,
      chalk.bold.blue,
      chalk.bold,
      chalk.bold,
      chalk.bold,
    ];
    return '\n' + (colors[level - 1] ?? chalk.bold)(text) + '\n';
  },
  strong: (text: string) => chalk.bold(text),
  em: (text: string) => chalk.italic(text),
  link: (_href: string, _title: string, text: string) =>
    chalk.cyan.underline(text),
  hr: () => chalk.dim('─'.repeat(process.stdout.columns ?? 80)) + '\n',
  blockquote: (text: string) =>
    text
      .split('\n')
      .map((l) => chalk.dim('│ ') + chalk.italic(l))
      .join('\n'),
  list: (body: string, _ordered: boolean) => body,
  listitem: (text: string) => `  ${chalk.cyan('•')} ${text}\n`,
  paragraph: (text: string) => text + '\n\n',
}));

// Syntax highlight code blocks using ANSI colors.
// Language-aware coloring is intentionally minimal to stay dependency-free.
function renderCodeBlock(code: string, lang: string): string {
  const width = process.stdout.columns ?? 80;
  const border = chalk.dim('─'.repeat(width));
  const header = lang ? chalk.dim.bgBlack(` ${lang} `) + '\n' : '';
  const highlighted = colorizeCode(code, lang ?? '');
  return `\n${border}\n${header}${highlighted}\n${border}\n\n`;
}

// Basic syntax coloring (keywords, strings, numbers, comments)
function colorizeCode(code: string, lang: string): string {
  const jsLike = ['js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx'];
  const pyLike = ['py', 'python'];

  if (!jsLike.includes(lang) && !pyLike.includes(lang)) {
    return chalk.green(code);
  }

  return code
    .split('\n')
    .map((line) => {
      // Comments
      if (/^\s*(\/\/|#)/.test(line)) return chalk.dim.italic(line);
      // Strings
      line = line.replace(/(["'`])(?:(?!\1)[^\\]|\\.)*\1/g, (m) =>
        chalk.yellow(m),
      );
      // Numbers
      line = line.replace(/\b\d+\.?\d*\b/g, (m) => chalk.cyan(m));
      // JS/TS keywords
      const keywords =
        'const let var function return if else for while class import export default async await new this typeof null undefined true false void try catch finally throw';
      keywords.split(' ').forEach((kw) => {
        const re = new RegExp(`\\b(${kw})\\b`, 'g');
        line = line.replace(re, chalk.magenta('$1'));
      });
      return line;
    })
    .join('\n');
}

// Render a completed markdown string to the terminal
export function renderMarkdown(text: string): string {
  return marked(text) as string;
}

// Stream renderer: prints chunks as they arrive.
// finish() adds a trailing newline. Markdown re-render is intentionally
// skipped — the raw streamed text is readable enough and avoids cursor
// arithmetic bugs when the assistant label is printed outside this class.
export class StreamRenderer {
  private buffer = '';

  write(chunk: string): void {
    this.buffer += chunk;
    process.stdout.write(chunk);
  }

  finish(): void {
    // Always end with a newline so the next prompt starts on a fresh line
    if (!this.buffer.endsWith('\n')) {
      process.stdout.write('\n');
    }
  }

  getBuffer(): string {
    return this.buffer;
  }
}

// Print the thinking block in a dimmed, bordered box.
// Called after thinking tokens are fully collected.
export function printThinkingBlock(thinkingText: string): void {
  if (!thinkingText.trim()) return;

  const width = Math.min(process.stdout.columns ?? 80, 100);
  const border = chalk.dim('·'.repeat(width));

  console.log('\n' + border);
  console.log(chalk.dim.italic('  💭 Thinking…'));
  console.log(border);

  // Print each line of the thinking block, dimmed
  const lines = thinkingText.trim().split('\n');
  for (const line of lines) {
    console.log(chalk.dim('  ' + line));
  }

  console.log(border + '\n');
}

// Print token usage stats in a compact format
export function printUsage(usage: Usage): void {
  const line = [
    chalk.dim('tokens:'),
    chalk.dim(`↑${usage.prompt_tokens}`),
    chalk.dim(`↓${usage.completion_tokens}`),
    chalk.dim(`Σ${usage.total_tokens}`),
  ].join(' ');
  console.log('\n' + line);
}
