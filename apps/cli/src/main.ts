#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import { loadCliConfig } from '@baton/config';

import { runCli } from './cli.js';
import { createCredentialStore } from './credentials.js';
import type { ServiceHost } from './service.js';

const config = loadCliConfig(process.env);
const store = createCredentialStore(config.credentialStore === 'file');

const serviceHost: ServiceHost = {
  os: process.platform,
  home: homedir(),
  execPath: process.execPath,
  scriptPath: fileURLToPath(import.meta.url),
  apiUrl: process.env.BATON_API_URL,
  writeFile: (path, contents, options) =>
    writeFile(path, contents, { encoding: 'utf8', ...options }),
  removeFile: (path) => rm(path, { force: true }),
  mkdirp: async (path) => {
    await mkdir(path, { recursive: true });
  },
  fileExists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  run: (command, args) =>
    new Promise((resolveRun, rejectRun) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', rejectRun);
      child.on('close', (code) =>
        resolveRun({ code: code ?? 0, stdout, stderr }),
      );
    }),
};
const exitCode = await runCli(process.argv.slice(2), {
  apiUrl: config.apiUrl,
  store,
  io: {
    out: (message) => console.log(message),
    error: (message) => console.error(message),
  },
  serviceHost,
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
