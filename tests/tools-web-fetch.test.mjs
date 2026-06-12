import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeTool, getTool } from '../dist/tools.js';
import { recoverLeakedToolCallsForTest } from '../dist/client.js';
import { resolveToolsEnabled } from '../dist/chat.js';

async function testWebFetchBlocksRedirectsToLoopbackAddresses() {
  const tool = getTool('web_fetch');
  assert.ok(tool, 'web_fetch tool should exist');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    if (options.redirect === 'manual') {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:3000/private' },
      });
    }

    return new Response('local secret', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  };

  try {
    await assert.rejects(
      () =>
        executeTool(
          tool,
          { url: 'http://93.184.216.34/start' },
          { cwd: process.cwd() },
        ),
      /private|loopback|redirect/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testWebFetchAllowsSafeRedirects() {
  const tool = getTool('web_fetch');
  assert.ok(tool, 'web_fetch tool should exist');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    if (options.redirect === 'manual' && href.includes('/start')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'http://93.184.216.34/final' },
      });
    }

    return new Response('public page', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  };

  try {
    const result = await executeTool(
      tool,
      { url: 'http://93.184.216.34/start' },
      { cwd: process.cwd() },
    );
    assert.equal(result, 'public page');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testToolCallRecoveryKeepsExampleJson() {
  const knownNames = new Set(['read_file']);
  const text = [
    'Example:',
    '```json',
    '{"name":"read_file","arguments":{"path":"foo.txt"}}',
    '```',
  ].join('\n');

  const recovered = recoverLeakedToolCallsForTest(text, knownNames);
  assert.equal(recovered.calls.length, 0);
  assert.equal(recovered.cleanedText, text);
}

async function testReadFileBlocksDirectoryLinksOutsideWorkspace() {
  const tool = getTool('read_file');
  assert.ok(tool, 'read_file tool should exist');

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-outside-'));
  const linkedPath = path.join(root, 'linked');
  await writeFile(path.join(outside, 'secret.txt'), 'outside secret', 'utf-8');

  try {
    try {
      if (process.platform === 'win32') {
        await symlink(outside, linkedPath, 'junction');
      } else {
        await mkdir(linkedPath, { recursive: true });
        await rm(linkedPath, { recursive: true, force: true });
        await symlink(outside, linkedPath, 'dir');
      }
    } catch {
      console.log('SKIP directory link sandbox test');
      return;
    }

    assert.ok(existsSync(path.join(linkedPath, 'secret.txt')));
    await assert.rejects(
      () =>
        executeTool(
          tool,
          { path: 'linked/secret.txt' },
          { cwd: root },
        ),
      /escapes working directory|outside workspace/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

async function testSearchContentFindsMatchesWithLineNumbers() {
  const tool = getTool('search_content');
  assert.ok(tool, 'search_content tool should exist');

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-search-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'one.ts'), 'alpha\nneedle value\nomega\n', 'utf-8');
  await writeFile(path.join(root, 'src', 'two.md'), 'needle in docs\n', 'utf-8');

  try {
    const result = await executeTool(
      tool,
      { path: '.', pattern: 'needle\\s+value', include: '*.ts' },
      { cwd: root },
    );

    assert.match(result, /src[\\/]one\.ts:2:needle value/);
    assert.doesNotMatch(result, /two\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function testSearchContentSkipsDirectoryLinksOutsideWorkspace() {
  const tool = getTool('search_content');
  assert.ok(tool, 'search_content tool should exist');

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-search-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'agent-search-outside-'));
  const linkedPath = path.join(root, 'linked');
  await writeFile(path.join(root, 'inside.txt'), 'needle inside\n', 'utf-8');
  await writeFile(path.join(outside, 'secret.txt'), 'needle outside\n', 'utf-8');

  try {
    try {
      if (process.platform === 'win32') {
        await symlink(outside, linkedPath, 'junction');
      } else {
        await mkdir(linkedPath, { recursive: true });
        await rm(linkedPath, { recursive: true, force: true });
        await symlink(outside, linkedPath, 'dir');
      }
    } catch {
      console.log('SKIP search directory link sandbox test');
      return;
    }

    const result = await executeTool(
      tool,
      { path: '.', pattern: 'needle' },
      { cwd: root },
    );

    assert.match(result, /inside\.txt:1:needle inside/);
    assert.doesNotMatch(result, /secret\.txt/);
    assert.doesNotMatch(result, /needle outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

async function testWriteFileCreatesMissingParentDirectories() {
  const tool = getTool('write_file');
  assert.ok(tool, 'write_file tool should exist');

  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-write-'));
  try {
    const result = await executeTool(
      tool,
      { path: 'newdir/file.txt', content: 'created file' },
      { cwd: root },
    );

    assert.match(result, /Wrote 12 bytes/);
    assert.equal(
      await import('node:fs/promises').then((fs) =>
        fs.readFile(path.join(root, 'newdir', 'file.txt'), 'utf-8'),
      ),
      'created file',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await testWebFetchBlocksRedirectsToLoopbackAddresses();
await testWebFetchAllowsSafeRedirects();
await testToolCallRecoveryKeepsExampleJson();
await testReadFileBlocksDirectoryLinksOutsideWorkspace();
await testSearchContentFindsMatchesWithLineNumbers();
await testSearchContentSkipsDirectoryLinksOutsideWorkspace();
await testWriteFileCreatesMissingParentDirectories();

assert.equal(resolveToolsEnabled({ toolsEnabled: false }, true), false);
assert.equal(resolveToolsEnabled({ toolsEnabled: true, tools: [] }, true), false);
assert.equal(resolveToolsEnabled({}, true), true);

console.log('PASS tools-web-fetch');
