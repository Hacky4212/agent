import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import chalk from 'chalk';

// Read one or more files and format them as context blocks
export async function readFileContexts(filePaths: string[]): Promise<string> {
  const blocks: string[] = [];

  for (const fp of filePaths) {
    const resolved = path.resolve(fp);
    if (!existsSync(resolved)) {
      console.error(chalk.red(`File not found: ${fp}`));
      continue;
    }

    const content = await readFile(resolved, 'utf-8');
    const ext = path.extname(fp).slice(1);
    const relativePath = path.relative(process.cwd(), resolved);

    blocks.push(
      `<file path="${relativePath}">\n\`\`\`${ext}\n${content}\n\`\`\`\n</file>`,
    );
  }

  return blocks.join('\n\n');
}

// Read from stdin if data is being piped in
export async function readStdin(): Promise<string | null> {
  // Skip if stdin is a TTY (interactive terminal)
  if (process.stdin.isTTY) return null;

  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim() || null));
    process.stdin.on('error', reject);
  });
}

// Get a platform-appropriate history file path.
// Works on Termux ($HOME/.config/...), Linux, and Windows.
export function getHistoryDir(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg) return path.join(xdg, 'deepseek-cli', 'history');

  // Termux / Linux / macOS
  if (process.platform !== 'win32') {
    return path.join(os.homedir(), '.config', 'deepseek-cli', 'history');
  }

  // Windows
  const appData = process.env['APPDATA'] ?? os.homedir();
  return path.join(appData, 'deepseek-cli', 'history');
}

// Format bytes into human-readable string
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
}

// Truncate a string to a max length with ellipsis
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}

// Wrap text at a given column width for terminal display
export function wrapText(text: string, width = 80): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length + word.length + 1 > width) {
      if (current) lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);
  return lines.join('\n');
}
