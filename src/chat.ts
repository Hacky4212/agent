import readline from 'readline';
import chalk from 'chalk';
import { runAgentTurn } from './agent.js';
import {
  StreamRenderer,
  printUsage,
  printThinkingBlock,
  printToolCall,
  printToolResult,
} from './renderer.js';
import { Session } from './session.js';
import { getConfig, getConfigValue, setConfigValue } from './config.js';
import { readFileContexts } from './utils.js';
import { getEnabledTools, toOpenAITools, type Tool } from './tools.js';
import { type ChatOptions, type ReasoningEffort, THINKING_CAPABLE_MODELS } from './types.js';

function buildBanner(
  model: string,
  thinking: boolean,
  effort: ReasoningEffort,
  toolsOn: boolean,
): string {
  const thinkTag = THINKING_CAPABLE_MODELS.has(model)
    ? thinking
      ? chalk.green(`think:${effort}`)
      : chalk.dim('think:off')
    : chalk.dim('think:n/a');

  const toolsTag = toolsOn ? chalk.green('tools:on') : chalk.dim('tools:off');

  return (
    '\n' +
    chalk.bold.cyan('DeepSeek CLI') +
    chalk.dim('  ') +
    chalk.dim('model:') + chalk.cyan(model) +
    '  ' + thinkTag +
    '  ' + toolsTag +
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
  ${chalk.cyan('/showthink [on|off]')}  Show or hide the thinking process
  ${chalk.cyan('/tools [on|off]')}      List tools or toggle tool calling
  ${chalk.cyan('/approve [on|off]')}    Auto-approve tool actions this session
  ${chalk.cyan('/usage')}               Toggle token usage display
  ${chalk.cyan('/exit')}                Exit  (also Ctrl+C or Ctrl+D)

${chalk.bold('Keyboard shortcuts:')}
  ${chalk.cyan('Ctrl+C')}   Cancel current generation
  ${chalk.cyan('Ctrl+D')}   Exit
  ${chalk.cyan('↑ / ↓')}   Browse input history
`;

// Interactive arrow-key confirmation menu (Claude Code style). Renders a list
// of options navigable with ↑/↓ (or j/k), chosen with Enter; number keys pick
// directly, Esc/Ctrl+C cancels. Takes over stdin in raw mode for the duration,
// then restores the REPL readline's keypress listeners so the prompt keeps
// working afterwards.
function promptMenu(
  title: string,
  options: { label: string; value: 'yes' | 'no' | 'always' }[],
  signal: AbortSignal,
): Promise<'yes' | 'no' | 'always'> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const canRaw = typeof stdin.setRawMode === 'function';
    const prevRaw = stdin.isRaw; // restore exactly, don't force cooked mode
    let selected = 0;
    let resolved = false;
    let cleanedUp = false;

    // Detach readline's keypress listeners so they don't fight the menu.
    const prevListeners = stdin.listeners('keypress') as ((...a: unknown[]) => void)[];
    stdin.removeAllListeners('keypress');
    readline.emitKeypressEvents(stdin);

    const render = (first: boolean) => {
      if (!first) process.stdout.write(`\x1b[${options.length}A`);
      for (let i = 0; i < options.length; i++) {
        const active = i === selected;
        const pointer = active ? chalk.cyan('❯ ') : '  ';
        const text = active ? chalk.cyan(options[i]!.label) : chalk.dim(options[i]!.label);
        process.stdout.write(`\x1b[2K  ${pointer}${text}\n`);
      }
    };

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      stdin.removeListener('keypress', onKey);
      if (canRaw) {
        try {
          stdin.setRawMode(prevRaw);
        } catch {
          // Best-effort cleanup: the stream may already be closing after Ctrl+C.
        }
      }
      for (const l of prevListeners) stdin.on('keypress', l);
    };

    const finish = (value: 'yes' | 'no' | 'always') => {
      if (resolved) return;
      resolved = true;
      signal.removeEventListener('abort', onAbort);
      cleanup();
      resolve(value);
    };

    const onAbort = () => finish('no');

    function onKey(str: string, key: { name?: string; ctrl?: boolean }): void {
      if (!key) return;
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        process.stdout.write('\n');
        finish('no');
      } else if (key.name === 'up' || key.name === 'k') {
        selected = (selected - 1 + options.length) % options.length;
        render(false);
      } else if (key.name === 'down' || key.name === 'j') {
        selected = (selected + 1) % options.length;
        render(false);
      } else if (key.name === 'return' || key.name === 'enter') {
        process.stdout.write('\n');
        finish(options[selected]!.value);
      } else if (str && str >= '1' && str <= String(options.length)) {
        selected = Number(str) - 1;
        render(false);
        process.stdout.write('\n');
        finish(options[selected]!.value);
      }
    }

    signal.addEventListener('abort', onAbort, { once: true });
    console.log(chalk.yellow(`  ${title}`) + chalk.dim('  (↑/↓ then Enter)'));
    if (canRaw) stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    render(true);
  });
}

// Interactive REPL — the main chat loop
export function resolveToolsEnabled(opts: Pick<ChatOptions, 'tools' | 'toolsEnabled'>, configToolsEnabled: boolean): boolean {
  if (opts.toolsEnabled === false) return false;
  if (opts.toolsEnabled === true) return (opts.tools?.length ?? 1) > 0;
  return configToolsEnabled && (opts.tools?.length ?? 1) > 0;
}

export async function runChat(opts: ChatOptions): Promise<void> {
  const cfg = getConfig();
  const model = opts.model ?? cfg.model;
  const systemPrompt = opts.systemPrompt ?? cfg.systemPrompt;
  let thinking = opts.thinking ?? cfg.thinking;
  let effort: ReasoningEffort = opts.reasoningEffort ?? cfg.reasoningEffort;
  let showThinking = false; // thinking process hidden by default
  let toolsOn = resolveToolsEnabled(opts, cfg.toolsEnabled);
  let autoApprove = cfg.autoApproveTools; // skip confirmations this session

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

  console.log(buildBanner(session.model, thinking, effort, toolsOn));
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

        case 'showthink': {
          if (!arg || arg === 'on') {
            showThinking = true;
          } else if (arg === 'off') {
            showThinking = false;
          } else {
            console.log(chalk.dim('  Usage: /showthink [on|off]\n'));
            break;
          }
          console.log(chalk.dim(`  Show thinking: ${showThinking ? chalk.green('on') : chalk.red('off')}\n`));
          break;
        }

        case 'tools': {
          if (!arg) {
            console.log(
              chalk.dim(`  Tool calling: ${toolsOn ? chalk.green('on') : chalk.red('off')}`),
            );
            for (const t of getEnabledTools()) {
              const tag = t.needsConfirmation ? chalk.yellow('confirm') : chalk.dim('auto');
              console.log(`    ${chalk.cyan(t.name.padEnd(14))} ${tag}  ${chalk.dim(t.description)}`);
            }
            console.log();
            break;
          }
          if (arg === 'on') {
            toolsOn = true;
          } else if (arg === 'off') {
            toolsOn = false;
          } else {
            console.log(chalk.dim('  Usage: /tools [on|off]\n'));
            break;
          }
          console.log(chalk.dim(`  Tool calling: ${toolsOn ? chalk.green('on') : chalk.red('off')}\n`));
          break;
        }

        case 'approve': {
          if (!arg || arg === 'on') {
            autoApprove = true;
          } else if (arg === 'off') {
            autoApprove = false;
          } else {
            console.log(chalk.dim('  Usage: /approve [on|off]\n'));
            break;
          }
          console.log(
            chalk.dim(`  Auto-approve tools: ${autoApprove ? chalk.green('on') : chalk.red('off')}`) +
              (autoApprove ? chalk.yellow('  (commands run without asking)') : '') +
              '\n',
          );
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

    // ── Stream response (agentic loop) ────────────────────────────────
    rl.pause();
    abortController = new AbortController();
    const signal = abortController.signal;

    // Thinking tokens buffer (streamed separately, shown after stream ends)
    let thinkingBuffer = '';
    let renderer = new StreamRenderer();
    let labelPrinted = false;

    // Spinner for thinking phase
    const spinFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let spinIdx = 0;
    let spinTimer: ReturnType<typeof setInterval> | null = null;

    const startSpinner = () => {
      if (spinTimer || !(thinking && THINKING_CAPABLE_MODELS.has(session.model))) return;
      spinIdx = 0;
      spinTimer = setInterval(() => {
        process.stdout.write(
          `\r${chalk.dim(spinFrames[spinIdx++ % spinFrames.length]!)} ${chalk.dim('Thinking…')}`,
        );
      }, 80);
    };

    // Stop the spinner and erase its line. Safe to call multiple times.
    const stopSpinner = () => {
      if (spinTimer) {
        clearInterval(spinTimer);
        spinTimer = null;
        process.stdout.write('\r\x1b[K');
      }
    };

    startSpinner();

    // Confirmation prompt for needs-confirmation tools. Briefly resumes the
    // readline to read one line, racing against Ctrl+C abort.
    const confirm = (tool: Tool, args: Record<string, unknown>): Promise<'yes' | 'no' | 'always'> => {
      if (autoApprove) return Promise.resolve('yes');
      stopSpinner();
      // Show a concrete summary of what will run
      if (tool.name === 'run_command') {
        console.log(chalk.dim('    $ ') + chalk.white(String(args['command'] ?? '')));
      } else if (tool.name === 'write_file') {
        const content = String(args['content'] ?? '');
        console.log(chalk.dim(`    write ${args['path']} (${content.length} bytes)`));
      } else if (tool.name === 'edit_file') {
        console.log(chalk.dim(`    edit ${args['path']}`));
        console.log(chalk.red('    - ' + String(args['old_string'] ?? '').split('\n')[0]));
        console.log(chalk.green('    + ' + String(args['new_string'] ?? '').split('\n')[0]));
      }
      // Arrow-key menu: Yes / Yes, always / No (Claude Code style).
      // rl is paused during streaming; the menu takes over stdin then restores
      // readline's keypress listeners when done.
      return promptMenu(
        `Run ${tool.name}?`,
        [
          { label: 'Yes', value: 'yes' },
          { label: `Yes, and don't ask again for ${tool.name}`, value: 'always' },
          { label: 'No', value: 'no' },
        ],
        signal,
      );
    };

    const tools =
      cfg.toolsEnabled && toolsOn ? toOpenAITools(getEnabledTools()) : undefined;

    try {
      const { usage } = await runAgentTurn(
        session,
        {
          model: session.model,
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          thinking,
          reasoningEffort: effort,
          tools,
        },
        {
          onAnswerChunk: (chunk) => {
            // First answer chunk: stop spinner, print the assistant label.
            if (!labelPrinted) {
              stopSpinner();
              process.stdout.write(
                '\n' + chalk.bold.blue('assistant') + chalk.dim(' ›') + '\n',
              );
              labelPrinted = true;
            }
            renderer.write(chunk);
          },
          onThinkChunk: (chunk) => {
            thinkingBuffer += chunk;
          },
          onToolStart: (call, args) => {
            stopSpinner();
            renderer.finish();
            printToolCall(call.function.name, args);
          },
          onToolResult: (call, result, ok) => {
            printToolResult(call.function.name, result, ok);
            // Reset for the next streamed turn in the loop
            renderer = new StreamRenderer();
            labelPrinted = false;
            startSpinner();
          },
          confirm,
        },
        signal,
      );

      stopSpinner();

      // Show thinking block only if user toggled /showthink on
      if (showThinking && thinkingBuffer) {
        printThinkingBlock(thinkingBuffer);
      }

      renderer.finish();

      if (getConfigValue('showUsage') && usage) {
        printUsage(usage);
      }
    } catch (err: unknown) {
      stopSpinner();
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
