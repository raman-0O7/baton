import { posix, win32 } from 'node:path';

/**
 * Host effects needed to install the Baton daemon as an OS-managed background
 * service. Injected so the pure planning/rendering logic stays testable.
 */
export interface ServiceHost {
  /** `process.platform` of the machine the service is installed on. */
  os: NodeJS.Platform;
  /** User home directory (service artifacts live under it — no root needed). */
  home: string;
  /** Absolute path to the node binary that should run the daemon. */
  execPath: string;
  /** Absolute path to the Baton CLI entry script (`main.js`). */
  scriptPath: string;
  /** Value baked into the service so the daemon reaches the same API. */
  apiUrl?: string | undefined;
  writeFile(
    path: string,
    contents: string,
    options?: { mode?: number },
  ): Promise<void>;
  removeFile(path: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;
  run(
    command: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

export interface ServiceIo {
  out(message: string): void;
  error(message: string): void;
}

/** Stable identifiers reused across platforms. */
export const SERVICE_LABEL = 'dev.baton.daemon';
const SYSTEMD_UNIT = 'baton-daemon.service';
const WINDOWS_TASK = 'BatonDaemon';

interface ServicePaths {
  /** The unit/plist/script file the platform loads. */
  definition: string;
  /** Where the daemon writes stdout/stderr, when the platform needs a path. */
  log: string;
}

function servicePaths(host: ServiceHost): ServicePaths {
  switch (host.os) {
    case 'darwin':
      return {
        definition: posix.join(
          host.home,
          'Library',
          'LaunchAgents',
          `${SERVICE_LABEL}.plist`,
        ),
        log: posix.join(host.home, 'Library', 'Logs', 'baton-daemon.log'),
      };
    case 'linux':
      return {
        definition: posix.join(
          host.home,
          '.config',
          'systemd',
          'user',
          SYSTEMD_UNIT,
        ),
        log: posix.join(host.home, '.local', 'state', 'baton', 'daemon.log'),
      };
    case 'win32':
      return {
        definition: win32.join(
          host.home,
          'AppData',
          'Local',
          'Baton',
          'baton-daemon.vbs',
        ),
        log: win32.join(
          host.home,
          'AppData',
          'Local',
          'Baton',
          'baton-daemon.log',
        ),
      };
    default:
      throw new Error(
        `Baton service management is not supported on ${host.os}. Run \`baton daemon\` manually or under your own supervisor.`,
      );
  }
}

function parentDirectory(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/';
  const index = path.lastIndexOf(separator);
  return index <= 0 ? path : path.slice(0, index);
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function renderLaunchdPlist(host: ServiceHost): string {
  const { log } = servicePaths(host);
  const environment =
    host.apiUrl === undefined
      ? ''
      : `  <key>EnvironmentVariables</key>
  <dict>
    <key>BATON_API_URL</key>
    <string>${xmlEscape(host.apiUrl)}</string>
  </dict>
`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(host.execPath)}</string>
    <string>${xmlEscape(host.scriptPath)}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
${environment}  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(host: ServiceHost): string {
  const environment =
    host.apiUrl === undefined
      ? ''
      : `Environment=BATON_API_URL=${host.apiUrl}\n`;
  return `[Unit]
Description=Baton conversation capture daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="${host.execPath}" "${host.scriptPath}" daemon
${environment}Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function renderWindowsScript(host: ServiceHost): string {
  const environment =
    host.apiUrl === undefined
      ? ''
      : `shell.Environment("Process")("BATON_API_URL") = "${host.apiUrl.replace(
          /"/g,
          '""',
        )}"\n`;
  // Third Run() arg 0 = hidden window, False = do not wait. Keeps the daemon
  // off-screen with no console flash at logon.
  return `Set shell = CreateObject("WScript.Shell")
${environment}command = Chr(34) & "${host.execPath}" & Chr(34) & " " & Chr(34) & "${host.scriptPath}" & Chr(34) & " daemon"
shell.Run command, 0, False
`;
}

/** Best-effort run that never throws — for teardown steps that may no-op. */
async function runQuietly(
  host: ServiceHost,
  command: string,
  args: string[],
): Promise<void> {
  try {
    await host.run(command, args);
  } catch {
    // ignore — the resource may already be absent
  }
}

async function runOrThrow(
  host: ServiceHost,
  command: string,
  args: string[],
): Promise<string> {
  const result = await host.run(command, args);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(
      `\`${command} ${args.join(' ')}\` failed (exit ${result.code})${
        detail ? `: ${detail}` : ''
      }`,
    );
  }
  return result.stdout;
}

export async function installService(
  host: ServiceHost,
  io: ServiceIo,
): Promise<void> {
  const { definition } = servicePaths(host);
  await host.mkdirp(parentDirectory(definition));

  switch (host.os) {
    case 'darwin': {
      await host.writeFile(definition, renderLaunchdPlist(host), {
        mode: 0o644,
      });
      // Reload cleanly if a previous copy is loaded, then load + enable.
      await runQuietly(host, 'launchctl', ['unload', definition]);
      await runOrThrow(host, 'launchctl', ['load', '-w', definition]);
      break;
    }
    case 'linux': {
      await host.writeFile(definition, renderSystemdUnit(host), {
        mode: 0o644,
      });
      await runOrThrow(host, 'systemctl', ['--user', 'daemon-reload']);
      await runOrThrow(host, 'systemctl', [
        '--user',
        'enable',
        '--now',
        SYSTEMD_UNIT,
      ]);
      break;
    }
    case 'win32': {
      await host.writeFile(definition, renderWindowsScript(host), {
        mode: 0o644,
      });
      await runOrThrow(host, 'schtasks', [
        '/create',
        '/tn',
        WINDOWS_TASK,
        '/tr',
        `wscript.exe "${definition}"`,
        '/sc',
        'onlogon',
        '/rl',
        'limited',
        '/f',
      ]);
      break;
    }
    default:
      throw new Error(
        `Baton service management is not supported on ${host.os}.`,
      );
  }

  io.out('Baton daemon installed as a background service.');
  io.out('It starts automatically at login and restarts if it stops.');
  io.out(`Definition: ${definition}`);
  io.out('Check it with `baton service status`.');
}

export async function uninstallService(
  host: ServiceHost,
  io: ServiceIo,
): Promise<void> {
  const { definition } = servicePaths(host);

  switch (host.os) {
    case 'darwin':
      await runQuietly(host, 'launchctl', ['unload', '-w', definition]);
      break;
    case 'linux':
      await runQuietly(host, 'systemctl', [
        '--user',
        'disable',
        '--now',
        SYSTEMD_UNIT,
      ]);
      break;
    case 'win32':
      await runQuietly(host, 'schtasks', [
        '/delete',
        '/tn',
        WINDOWS_TASK,
        '/f',
      ]);
      break;
    default:
      throw new Error(
        `Baton service management is not supported on ${host.os}.`,
      );
  }

  if (await host.fileExists(definition)) {
    await host.removeFile(definition);
  }
  if (host.os === 'linux') {
    await runQuietly(host, 'systemctl', ['--user', 'daemon-reload']);
  }

  io.out('Baton daemon service removed.');
}

export async function serviceStatus(
  host: ServiceHost,
  io: ServiceIo,
): Promise<void> {
  const { definition } = servicePaths(host);
  const installed = await host.fileExists(definition);
  if (!installed) {
    io.out('Baton daemon service: not installed.');
    io.out('Install it with `baton service install`.');
    return;
  }

  let running = false;
  switch (host.os) {
    case 'darwin': {
      const result = await host.run('launchctl', ['list', SERVICE_LABEL]);
      running = result.code === 0;
      break;
    }
    case 'linux': {
      const result = await host.run('systemctl', [
        '--user',
        'is-active',
        SYSTEMD_UNIT,
      ]);
      running = result.stdout.trim() === 'active';
      break;
    }
    case 'win32': {
      const result = await host.run('schtasks', [
        '/query',
        '/tn',
        WINDOWS_TASK,
      ]);
      running = result.code === 0;
      break;
    }
    default:
      throw new Error(
        `Baton service management is not supported on ${host.os}.`,
      );
  }

  io.out(
    `Baton daemon service: installed, ${running ? 'running' : 'stopped'}.`,
  );
  io.out(`Definition: ${definition}`);
}
