import { spawnSync } from 'node:child_process';

/** Kill a process and all of its descendants. Electron spawns GPU/renderer/utility children. */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    // Children were spawned detached into their own process group (pgid === pid).
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** True while a process with this pid exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** How many running processes have this executable name (e.g. to prove a launch left nothing behind). */
export function countProcesses(executableName: string): number {
  if (process.platform === 'win32') {
    const listed = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${executableName}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return listed.stdout.split('\n').filter((line) => line.startsWith(`"${executableName}"`)).length;
  }
  const listed = spawnSync('pgrep', ['-f', executableName], { encoding: 'utf8' });
  return listed.stdout.split('\n').filter((line) => line.trim() !== '').length;
}
