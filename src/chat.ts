import readline from 'readline';
import chalk from 'chalk';
import { streamChat } from './client.js';
import { StreamRenderer, printUsage, printThinkingBlock } from './renderer.js';
import { Session } from './session.js';
import { getConfig, getConfigValue, setConfigValue } from './config.js';
import { readFileContexts } from './utils.js';
import { type ChatOptions, type ReasoningEffort, THINKING_CAPABLE_MODELS } from './types.js';

function buildBanner(model: string, thinking: boolean, effort: ReasoningEffort): string {
  const thinkTag = THINKING_CAPABLE_MODELS.has(model)
    ? thinking
      ? chalk.green(`think:${effort}`)
      : chalk.dim('think:off')
    : chalk.dim('think:n/a');

  return (
    '\n' +
    chalk.bold.cyan('DeepSeek CLI') +
    chalk.dim('  ') +
    chalk.dim('model:') + chalk.cyan(model) +
    '  ' + thinkTag +
    chalk.dim('  — /help for commands') +
    '\n'
  );
}

const HELP_TEXT = `
${chalk.bold('Slash commands:')}
  ${chalk.cyan('/help')}                Show this help
  ${chalk.cyan('/clear')}               Clear conversation history
  ${chalk.cyan('/history')}             Show recent conversations
  ${chalk.cyan('/model <name>')}        Switch model mid-session
  ${chalk.cyan('/system <prompt>')}     Change system prompt
  ${chalk.cyan('/file <path>')}         Attach a file to the next message
  ${chalk.cyan('/save <file>')}         Export conversation to Markdown
  ${chalk.cyan('/think [on|off]')}      Toggle thinking mode (V4 Pro / R1)
  ${chalk.cyan('/effort [high|max]')}   Set reasoning depth
  ${chalk.cyan('/usage')}               Toggle token usage display
  ${chalk.cyan('/exit')}                Exit  (also Ctrl+C or Ctrl+D)

${chalk.bold('Keyboard shortcuts:')}
  ${chalk.cyan('Ctrl+C')}   Cancel current generation
  ${chalk.cyan('Ctrl+D')}   Exit
  ${chalk.cyan('↑ / ↓')}   Browse input history
`;

// Interactive REPL — the main chat loop
export async function runChat(opts: ChatOptions): Promise<void> {
  const cfg = getConfig();
  const model = opts.model ?? cfg.model;
  const systemPrompt = opts.systemPrompt ?? cfg.systemPrompt;
  let thinking = opts.thinking ?? cfg.thinking;
  let effort: ReasoningEffort = opts.reasoningEffort ?? cfg.reasoningEffort;

  const session = new Session(model, systemPrompt);
  let pendingFiles: string[] = [];
  let abortController: AbortController | null = null;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    historySize: 200,
    prompt: chalk.dim('› '),
  });

  const exit = async (code = 0) => {
    if (session.getTurns() > 0) {
      await session.save().catch(() => {});
    }
    rl.close();
    process.exit(code);
  };

  console.log(buildBanner(session.model, thinking, effort));
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // ── Slash commands ────────────────────────────────────────────────
    if (input.startsWith('/')) {
      const [cmd, ...rest] = input.slice(1).split(' ');
      const arg = rest.join(' ').trim();

      switch (cmd?.toLowerCase()) {
        case 'help':
          console.log(HELP_TEXT);
          break;

        case 'exit':
        case 'quit':
        case 'q':
          await exit();
          return;

        case 'clear':
          session.clear();
          console.log(chalk.dim('  Conversation cleared.\n'));
          break;

        case 'history': {
          const { listHistory } = await import('./session.js');
          await listHistory();
          break;
        }

        case 'model':
          if (!arg) {
            console.log(chalk.dim(`  Current model: ${chalk.cyan(session.model)}\n`));
          } else {
            session.model = arg;
            console.log(
              chalk.dim(`  Switched to: ${chalk.cyan(arg)}`) +
                (THINKING_CAPABLE_MODELS.has(arg)
                  ? chalk.dim('  (supports thinking mode)')
                  : '') +
                '\n',
            );
          }
          break;

        case 'think': {
          if (!THINKING_CAPABLE_MODELS.has(session.model)) {
            console.log(chalk.yellow(`  Model ${session.model} does not support thinking mode.\n`));
            break;
          }
          if (!arg || arg === 'on') {
            thinking = true;
          } else if (arg === 'off') {
            thinking = false;
          } else {
            console.log(chalk.dim('  Usage: /think [on|off]\n'));
            break;
          }
          console.log(chalk.dim(`  Thinking mode: ${thinking ? chalk.green('on') : chalk.red('off')}\n`));
          break;
        }

        case 'effort': {
          if (!THINKING_CAPABLE_MODELS.has(session.model)) {
            console.log(chalk.yellow(`  Model ${session.model} does not support reasoning effort.\n`));
            break;
          }
          if (arg === 'high' || arg === 'max') {
            effort = arg;
            console.log(chalk.dim(`  Reasoning effort: ${chalk.cyan(effort)}\n`));
          } else {
            console.log(chalk.dim('  Usage: /effort [high|max]\n'));
          }
          break;
        }

        case 'system':
          if (!arg) {
            console.log(chalk.dim('  Usage: /system <prompt>\n'));
          } else {
            const newSession = new Session(session.model, arg);
            Object.assign(session, newSession);
            console.log(chalk.dim('  System prompt updated.\n'));
          }
          break;

        case 'file':
          if (!arg) {
            console.log(chalk.dim('  Usage: /file <path>\n'));
          } else {
            pendingFiles.push(arg);
            console.log(chalk.dim(`  File queued: ${chalk.cyan(arg)}\n`));
          }
          break;

        case 'save': {
          const filePath = arg || `conversation-${Date.now()}.md`;
          await session.export(filePath);
          console.log(chalk.dim(`  Saved to: ${chalk.cyan(filePath)}\n`));
          break;
        }

        case 'usage':
          setConfigValue('showUsage', !getConfigValue('showUsage'));
          console.log(
            chalk.dim(
              `  Token usage: ${getConfigValue('showUsage') ? 'on' : 'off'}\n`,
            ),
          );
          break;

        default:
          console.log(chalk.red(`  Unknown command: /${cmd}. Try /help.\n`));
      }

      rl.prompt();
      return;
    }

    // ── Build user message ────────────────────────────────────────────
    let userContent = input;

    if (pendingFiles.length > 0) {
      const fileContext = await readFileContexts(pendingFiles);
      userContent = `${fileContext}\n\n${userContent}`;
      pendingFiles = [];
    }

    session.addUser(userContent);

    // ── Stream response ───────────────────────────────────────────────
    rl.pause();
    abortController = new AbortController();

    // Thinking tokens buffer (streamed separately, shown after stream ends)
    let thinkingBuffer = '';
    const renderer = new StreamRenderer();

    // Spinner for thinking phase
    const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinIdx = 0;
    let spinTimer: ReturnType<typeof setInterval> | null = null;

    if (thinking && THINKING_CAPABLE_MODELS.has(session.model)) {
      process.stdout.write('\n');
      spinTimer = setInterval(() => {
        process.stdout.write(
          `\r${chalk.dim(spinFrames[spinIdx++ % spinFrames.length]!)} ${chalk.dim('Thinking…')}`,
        );
      }, 80);
    } else {
      console.log('');
    }

    try {
      const result = await streamChat(
        session.getMessages(),
        {
          model: session.model,
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          thinking,
          reasoningEffort: effort,
        },
        (chunk) => {
          // First answer chunk: print assistant label, then content
          if (!renderer.getBuffer()) {
            process.stdout.write(
              '\n' + chalk.bold.blue('assistant') + chalk.dim(' › \n'),
            );
          }
          renderer.write(chunk);
        },
        (thinkChunk) => {
          thinkingBuffer += thinkChunk;
        },
        abortController.signal,
      );

      // Stop spinner and clear the line
      if (spinTimer) {
        clearInterval(spinTimer);
        spinTimer = null;
        process.stdout.write('\r\x1b[K');
      }

      // Show thinking block if present
      if (thinkingBuffer) {
        process.stdout.write('\r\x1b[K');
        printThinkingBlock(thinkingBuffer);
      }

      renderer.finish();
      session.addAssistant(result.fullText);

      if (getConfigValue('showUsage') && result.usage) {
        printUsage(result.usage);
      }
    } catch (err: unknown) {
      if (spinTimer) { clearInterval(spinTimer); process.stdout.write('\r\x1b[K'); }
      if (err instanceof Error && err.name === 'AbortError') {
        renderer.finish();
        console.log(chalk.dim('\n  (generation cancelled)\n'));
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.log('\n' + chalk.red(`Error: ${msg}\n`));
      }
    }

    abortController = null;
    rl.resume();
    rl.prompt();
  });

  // Ctrl+C: cancel generation if running, else show hint
  rl.on('SIGINT', async () => {
    if (abortController) {
      abortController.abort();
    } else {
      console.log(chalk.dim('\n  Use /exit or Ctrl+D to quit.\n'));
      rl.prompt();
    }
  });

  rl.on('close', async () => {
    console.log(chalk.dim('\n  Goodbye.\n'));
    await exit();
  });
}
