import { describe, expect, it } from 'vitest';

import {
  installService,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsScript,
  serviceStatus,
  uninstallService,
  type ServiceHost,
  type ServiceIo,
} from '../src/service.js';

interface RunCall {
  command: string;
  args: string[];
}

class FakeHost implements ServiceHost {
  readonly writes = new Map<string, string>();
  readonly runs: RunCall[] = [];
  readonly removed: string[] = [];
  present = new Set<string>();
  apiUrl: string | undefined = 'http://localhost:4000';
  runResult: { code: number; stdout: string; stderr: string } = {
    code: 0,
    stdout: '',
    stderr: '',
  };

  constructor(
    readonly os: NodeJS.Platform,
    readonly home: string,
    readonly execPath = '/usr/bin/node',
    readonly scriptPath = '/opt/baton/main.js',
  ) {}

  async writeFile(path: string, contents: string): Promise<void> {
    this.writes.set(path, contents);
    this.present.add(path);
  }
  async removeFile(path: string): Promise<void> {
    this.removed.push(path);
    this.present.delete(path);
  }
  async mkdirp(): Promise<void> {}
  async fileExists(path: string): Promise<boolean> {
    return this.present.has(path);
  }
  async run(
    command: string,
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    this.runs.push({ command, args });
    return this.runResult;
  }
}

function collectingIo(sink: string[]): ServiceIo {
  return { out: (m) => sink.push(m), error: (m) => sink.push(m) };
}

describe('baton service', () => {
  it('renders a launchd plist that runs the daemon at load with the API url', () => {
    const host = new FakeHost('darwin', '/Users/dev');
    const plist = renderLaunchdPlist(host);
    expect(plist).toContain('<string>dev.baton.daemon</string>');
    expect(plist).toContain('<string>/opt/baton/main.js</string>');
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<string>http://localhost:4000</string>');
  });

  it('renders a systemd unit with restart and the daemon exec', () => {
    const host = new FakeHost('linux', '/home/dev');
    const unit = renderSystemdUnit(host);
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/opt/baton/main.js" daemon',
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('Environment=BATON_API_URL=http://localhost:4000');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('renders a hidden-window Windows launcher', () => {
    const host = new FakeHost('win32', 'C:\\Users\\dev');
    const vbs = renderWindowsScript(host);
    expect(vbs).toContain('shell.Run command, 0, False');
    expect(vbs).toContain('BATON_API_URL');
    expect(vbs).toContain('daemon');
  });

  it('omits environment blocks when no API url is set', () => {
    const host = new FakeHost('darwin', '/Users/dev');
    host.apiUrl = undefined;
    expect(renderLaunchdPlist(host)).not.toContain('EnvironmentVariables');
    const linux = new FakeHost('linux', '/home/dev');
    linux.apiUrl = undefined;
    expect(renderSystemdUnit(linux)).not.toContain('Environment=');
  });

  it('installs and loads the launchd agent on macOS', async () => {
    const host = new FakeHost('darwin', '/Users/dev');
    const out: string[] = [];
    await installService(host, collectingIo(out));
    const plistPath = '/Users/dev/Library/LaunchAgents/dev.baton.daemon.plist';
    expect(host.writes.has(plistPath)).toBe(true);
    expect(host.runs).toContainEqual({
      command: 'launchctl',
      args: ['load', '-w', plistPath],
    });
    expect(out.join('\n')).toContain('installed');
  });

  it('installs and enables the systemd user unit on Linux', async () => {
    const host = new FakeHost('linux', '/home/dev');
    await installService(host, collectingIo([]));
    const unitPath = '/home/dev/.config/systemd/user/baton-daemon.service';
    expect(host.writes.has(unitPath)).toBe(true);
    expect(host.runs).toContainEqual({
      command: 'systemctl',
      args: ['--user', 'daemon-reload'],
    });
    expect(host.runs).toContainEqual({
      command: 'systemctl',
      args: ['--user', 'enable', '--now', 'baton-daemon.service'],
    });
  });

  it('registers a logon scheduled task on Windows', async () => {
    const host = new FakeHost('win32', 'C:\\Users\\dev');
    await installService(host, collectingIo([]));
    const vbsPath = 'C:\\Users\\dev\\AppData\\Local\\Baton\\baton-daemon.vbs';
    expect(host.writes.has(vbsPath)).toBe(true);
    const create = host.runs.find((r) => r.command === 'schtasks');
    expect(create?.args).toEqual([
      '/create',
      '/tn',
      'BatonDaemon',
      '/tr',
      `wscript.exe "${vbsPath}"`,
      '/sc',
      'onlogon',
      '/rl',
      'limited',
      '/f',
    ]);
  });

  it('uninstall unloads and removes the definition', async () => {
    const host = new FakeHost('darwin', '/Users/dev');
    const plistPath = '/Users/dev/Library/LaunchAgents/dev.baton.daemon.plist';
    host.present.add(plistPath);
    await uninstallService(host, collectingIo([]));
    expect(host.runs).toContainEqual({
      command: 'launchctl',
      args: ['unload', '-w', plistPath],
    });
    expect(host.removed).toContain(plistPath);
  });

  it('reports not-installed when the definition is absent', async () => {
    const host = new FakeHost('linux', '/home/dev');
    const out: string[] = [];
    await serviceStatus(host, collectingIo(out));
    expect(out.join('\n')).toContain('not installed');
  });

  it('reports running when the unit is active', async () => {
    const host = new FakeHost('linux', '/home/dev');
    host.present.add('/home/dev/.config/systemd/user/baton-daemon.service');
    host.runResult = { code: 0, stdout: 'active\n', stderr: '' };
    const out: string[] = [];
    await serviceStatus(host, collectingIo(out));
    expect(out.join('\n')).toContain('running');
  });

  it('throws a clear error on unsupported platforms', async () => {
    const host = new FakeHost('aix' as NodeJS.Platform, '/home/dev');
    await expect(installService(host, collectingIo([]))).rejects.toThrow(
      /not supported/,
    );
  });
});
