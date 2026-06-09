#!/usr/bin/env node
import { Command } from 'commander';
import chalk from 'chalk';
import { runChat } from './chat.js';
import {
  getConfig,
  getConfigValue,
  setConfigValue,
  resetConfig,
  printConfig,
  getConfigPath,
} from './config.js';
import { streamChat } from './client.js';
import { StreamRenderer, printUsage, printThinkingBlock } from './renderer.js';
import { Session, listHistory } from './session.js';
import { readFileContexts, readStdin } from './utils.js';
import { DEFAULT_CONFIG, type ReasoningEffort } from './types.js';

const program = new Command();

program
  .name('dsk')
  .description('DeepSeek CLI — interactive AI in your terminal')
  .version('1.0.0')
  // Root-level options: dsk [-m model] [-s system] [-f file] [--no-think] [--effort high]
  // Running `dsk` with no subcommand starts the interactive REPL.
  .option('-m, --model <model>', 'Model to use (default: deepseek-v4-pro)')
  .option('-s, --system <prompt>', 'System prompt')
  .option('-f, --file <paths...>', 'Pre-attach files to the session')
  .option('-t, --temperature <n>', 'Sampling temperature (0-2)', parseFloat)
  .option('--max-tokens <n>', 'Max tokens per response', parseInt)
  .option('--think', 'Enable thinking mode')
  .option('--no-think', 'Disable thinking mode')
  .option('--effort <level>', 'Reasoning effort: high or max')
  .action(async (options) => {
    const cfg = getConfig();

    // ── Pipe mode: stdin is not a TTY ─────────────────────────────────
    if (!process.stdin.isTTY) {
      const piped = await readStdin();
      if (piped) {
        const session = new Session(cfg.model, cfg.systemPrompt);
        session.addUser(piped);
        let thinkingBuffer = '';
        const renderer = new StreamRenderer();
        const result = await streamChat(
          session.getMessages(),
          {},
          (chunk) => renderer.write(chunk),
          (tc) => { thinkingBuffer += tc; },
        );
        if (thinkingBuffer) {
          process.stdout.write('\r\x1b[K');
          printThinkingBlock(thinkingBuffer);
        }
        renderer.finish();
        if (cfg.showUsage && result.usage) printUsage(result.usage);
        return;
      }
    }

    // ── Interactive REPL ──────────────────────────────────────────────
    const thinking: boolean =
      options.think !== undefined ? (options.think as boolean) : cfg.thinking;
    const effort: ReasoningEffort =
      ((options.effort as string | undefined) as ReasoningEffort | undefined) ??
      cfg.reasoningEffort;

    let fileContext = '';
    if (options.file?.length) {
      fileContext = await readFileContexts(options.file as string[]);
    }

    await runChat({
      model: (options.model as string | undefined) ?? cfg.model,
      systemPrompt: fileContext
        ? `${(options.system as string | undefined) ?? cfg.systemPrompt}\n\n${fileContext}`
        : (options.system as string | undefined) ?? cfg.systemPrompt,
      maxTokens: (options.maxTokens as number | undefined) ?? cfg.maxTokens,
      temperature: (options.temperature as number | undefined) ?? cfg.temperature,
      thinking,
      reasoningEffort: effort,
    });
  });

// ── dsk ask ───────────────────────────────────────────────────────────────
program
  .command('ask [prompt]')
  .description('One-shot question, then exit')
  .option('-m, --model <model>', 'Model to use')
  .option('-s, --system <prompt>', 'System prompt')
  .option('-f, --file <paths...>', 'Attach one or more files as context')
  .option('-t, --temperature <n>', 'Sampling temperature (0-2)', parseFloat)
  .option('--max-tokens <n>', 'Max tokens in the response', parseInt)
  .option('--think', 'Enable thinking mode')
  .option('--no-think', 'Disable thinking mode')
  .option('--effort <level>', 'Reasoning effort: high or max')
  .action(async (promptArg: string | undefined, options) => {
    const cfg = getConfig();

    let userPrompt = promptArg ?? '';
    const piped = await readStdin();
    if (piped) {
      userPrompt = userPrompt ? `${piped}\n\n${userPrompt}` : piped;
    }

    if (!userPrompt.trim()) {
      console.error(chalk.red('Error: No prompt provided.'));
      console.error(chalk.dim('Usage: dsk ask "your question"'));
      console.error(chalk.dim('       echo "text" | dsk ask "summarize this"'));
      process.exit(1);
    }

    if (options.file?.length) {
      const fileCtx = await readFileContexts(options.file as string[]);
      userPrompt = `${fileCtx}\n\n${userPrompt}`;
    }

    const model = (options.model as string | undefined) ?? cfg.model;
    const systemPrompt = (options.system as string | undefined) ?? cfg.systemPrompt;
    const thinking: boolean =
      options.think !== undefined ? (options.think as boolean) : cfg.thinking;
    const effort: ReasoningEffort =
      ((options.effort as string | undefined) as ReasoningEffort | undefined) ??
      cfg.reasoningEffort;

    const session = new Session(model, systemPrompt);
    session.addUser(userPrompt);

    let thinkingBuffer = '';
    const renderer = new StreamRenderer();

    // Spinner for thinking phase
    const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinIdx = 0;
    let spinTimer: ReturnType<typeof setInterval> | null = null;
    if (thinking) {
      spinTimer = setInterval(() => {
        process.stdout.write(
          `\r${chalk.dim(spinFrames[spinIdx++ % spinFrames.length]!)} ${chalk.dim('Thinking…')}`,
        );
      }, 80);
    }

    try {
      const result = await streamChat(
        session.getMessages(),
        { model, systemPrompt, maxTokens: options.maxTokens, temperature: options.temperature, thinking, reasoningEffort: effort },
        (chunk) => renderer.write(chunk),
        (thinkChunk) => { thinkingBuffer += thinkChunk; },
      );

      if (spinTimer) { clearInterval(spinTimer); process.stdout.write('\r\x1b[K'); }

      if (thinkingBuffer) {
        printThinkingBlock(thinkingBuffer);
      }

      renderer.finish();

      if (cfg.showUsage && result.usage) {
        printUsage(result.usage);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('\n' + chalk.red(`Error: ${msg}`));
      process.exit(1);
    }
  });

// ── dsk history ───────────────────────────────────────────────────────────
program
  .command('history')
  .description('Show recent conversation history')
  .option('-n, --limit <n>', 'Number of entries to show', parseInt)
  .action(async (options) => {
    await listHistory((options.limit as number | undefined) ?? 20);
  });

// ── dsk config ────────────────────────────────────────────────────────────
const configCmd = program
  .command('config')
  .description('Manage CLI configuration');

configCmd
  .command('list')
  .description('Show all configuration values')
  .action(() => { printConfig(); });

configCmd
  .command('path')
  .description('Show config file location')
  .action(() => { console.log(getConfigPath()); });

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value')
  .addHelpText('after', `
Keys:
  api-key           Your DeepSeek API key
  base-url          API base URL (default: https://api.deepseek.com)
  model             Default model (default: deepseek-v4-pro)
  system-prompt     Default system prompt
  max-tokens        Max tokens per response (default: 8192)
  temperature       Sampling temperature 0-2 (default: 1.0)
  show-usage        Show token usage: true/false
  thinking          Enable thinking mode by default: true/false
  reasoning-effort  Default reasoning depth: high or max
`)
  .action((key: string, value: string) => {
    const camel = key.replace(/-([a-z])/g, (_, l: string) => l.toUpperCase()) as keyof typeof DEFAULT_CONFIG;

    if (!(camel in DEFAULT_CONFIG)) {
      console.error(chalk.red(`Unknown config key: ${key}`));
      console.error(chalk.dim('Run: dsk config set --help'));
      process.exit(1);
    }

    const current = DEFAULT_CONFIG[camel];
    let coerced: string | number | boolean = value;
    if (typeof current === 'number') coerced = Number(value);
    if (typeof current === 'boolean') coerced = value === 'true';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setConfigValue(camel, coerced as any);

    const display = camel === 'apiKey' ? '(hidden)' : value;
    console.log(chalk.green('✓') + ` ${key} = ${chalk.cyan(display)}`);
  });

configCmd
  .command('reset')
  .description('Reset all configuration to defaults')
  .action(() => {
    resetConfig();
    console.log(chalk.green('✓') + ' Configuration reset to defaults.');
  });

program.parse(process.argv);
