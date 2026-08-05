#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';

import { loadCliConfig } from '@baton/config';

import { runCli } from './cli.js';
import { createCredentialStore } from './credentials.js';

const config = loadCliConfig(process.env);
const store = createCredentialStore(config.credentialStore === 'file');
const exitCode = await runCli(process.argv.slice(2), {
  apiUrl: config.apiUrl,
  store,
  io: {
    out: (message) => console.log(message),
    error: (message) => console.error(message),
  },
  confirmEnable: async (prompt) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
    const terminal = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return (await terminal.question(prompt)).trim() === 'ENABLE';
    } finally {
      terminal.close();
    }
  },
  nativeSourceOptions: {
    ...(config.statePath === undefined ? {} : { statePath: config.statePath }),
    ...(config.claudeProjectsDirectory === undefined
      ? {}
      : { claudeProjectsDirectory: config.claudeProjectsDirectory }),
    ...(config.codexSessionsDirectory === undefined
      ? {}
      : { codexSessionsDirectory: config.codexSessionsDirectory }),
    ...(config.openCodeDatabase === undefined
      ? {}
      : { openCodeDatabase: config.openCodeDatabase }),
  },
});
process.exitCode = exitCode;
