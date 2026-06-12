import assert from 'node:assert/strict';
import { executeTool, getTool } from '../dist/tools.js';

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

await testWebFetchBlocksRedirectsToLoopbackAddresses();
await testWebFetchAllowsSafeRedirects();
console.log('PASS tools-web-fetch');
