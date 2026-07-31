export interface SpawnCommand {
  command: string;
  args: string[];
  shell?: boolean;
}

/**
 * PM2 会把 interpreter 路径中的 `@...` 当成 nvm 版本选择器。Homebrew 的
 * 版本化 Cellar 路径（例如 `node@22`）会因此被误解析成不存在的 Node 版本；
 * macOS 下统一改用稳定的 Homebrew bin 软链接，ecosystem 与本地 PM2 启动共用。
 */
export function resolvePm2NodeInterpreter(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'darwin') return nodePath;
  const match = nodePath.match(/^((?:\/opt\/homebrew|\/usr\/local))\/Cellar\/node(?:@[^/]+)?\/[^/]+\/bin\/node$/);
  return match ? `${match[1]}/bin/node` : nodePath;
}

export function buildPm2SpawnCommand(
  pm2Script: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  nodePath: string = process.execPath,
): SpawnCommand {
  const interpreter = resolvePm2NodeInterpreter(nodePath, platform);
  if (platform === 'win32' && pm2Script !== 'pm2') {
    if (pm2Script.toLowerCase().endsWith('.cmd')) {
      // Node's spawn with `{ shell: true }` does NOT quote the command or args —
      // it joins them verbatim into the cmd.exe command line. Without quoting, a
      // space anywhere (the pm2.cmd path under "C:\Program Files\…", or the
      // ecosystem config path under "C:\Users\First Last\.botmux\…") gets
      // word-split by cmd.exe and pm2 receives a truncated path. Wrap each token
      // in double quotes; cmd.exe (/s) strips them when it re-parses, and the
      // npm .cmd shim forwards the quoted args through %* intact. Windows paths
      // can't contain `"`, so simple wrapping is sufficient here.
      const quote = (s: string): string => `"${s}"`;
      return { command: quote(pm2Script), args: args.map(quote), shell: true };
    }
    return { command: interpreter, args: [pm2Script, ...args] };
  }
  if (pm2Script !== 'pm2') {
    // PM2's package script uses `#!/usr/bin/env node`. GUI apps, launchd and
    // systemd commonly have a deliberately small PATH, so always use the same
    // absolute Node interpreter that is already running botmux.
    return { command: interpreter, args: [pm2Script, ...args] };
  }
  return { command: pm2Script, args };
}
