import Conf from 'conf';
import chalk from 'chalk';
import { type Config, DEFAULT_CONFIG } from './types.js';

// Persistent config stored in the OS config directory.
// On Windows: %APPDATA%/deepseek-cli-nodejs
// On Linux/macOS/Termux: ~/.config/deepseek-cli-nodejs
const store = new Conf<Config>({
  projectName: 'deepseek-cli',
  defaults: DEFAULT_CONFIG,
  schema: {
    apiKey: { type: 'string' },
    baseUrl: { type: 'string' },
    model: { type: 'string' },
    systemPrompt: { type: 'string' },
    maxTokens: { type: 'number' },
    temperature: { type: 'number' },
    showUsage: { type: 'boolean' },
    theme: { type: 'string', enum: ['dark', 'light'] },
    thinking: { type: 'boolean' },
    reasoningEffort: { type: 'string', enum: ['high', 'max'] },
    toolsEnabled: { type: 'boolean' },
    autoApproveTools: { type: 'boolean' },
    searchProvider: { type: 'string', enum: ['tavily', 'brave'] },
    searchApiKey: { type: 'string' },
    maxToolIterations: { type: 'number' },
  },
});

export function getConfig(): Config {
  return store.store;
}

export function getConfigValue<K extends keyof Config>(key: K): Config[K] {
  return store.get(key);
}

export function setConfigValue<K extends keyof Config>(key: K, value: Config[K]): void {
  store.set(key, value);
}

export function resetConfig(): void {
  store.clear();
}

export function getConfigPath(): string {
  return store.path;
}

// Print all config values, masking the API key
export function printConfig(): void {
  const cfg = getConfig();
  const entries = Object.entries(cfg) as [keyof Config, Config[keyof Config]][];
  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));

  console.log('\n' + chalk.bold('Current configuration:'));
  console.log(chalk.dim('─'.repeat(44)));

  for (const [key, val] of entries) {
    const k = chalk.cyan(key.padEnd(maxKeyLen));
    const isSecret = key === 'apiKey' || key === 'searchApiKey';
    const v = isSecret
      ? val
        ? chalk.green('***' + String(val).slice(-4))
        : chalk.red('(not set)')
      : chalk.white(String(val));
    console.log(`  ${k}  ${v}`);
  }

  console.log(chalk.dim('─'.repeat(44)));
  console.log(chalk.dim(`Config file: ${store.path}\n`));
}
