import { closeSync, openSync, readSync } from 'node:fs';

/** PE optional-header `Subsystem` values (winnt.h). */
const WINDOWS_CUI = 3;

/**
 * Whether a Windows executable is a console program (subsystem CUI), read from its PE header. Only
 * those need `windowsHide`: started detached, they open a console window of their own. A GUI program
 * (Electron) must not get it — Windows then applies the hidden show state to the first window the
 * app shows, and an app that shows its window once stays invisible. Files that cannot be read (a
 * bare name found through PATH) count as console programs, as before; other non-PE files as GUI.
 */
export function isConsoleProgram(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const header = Buffer.alloc(1024);
    const read = readSync(fd, header, 0, header.length, 0);
    if (read < 0x40 || header.toString('latin1', 0, 2) !== 'MZ') return false;
    const pe = header.readUInt32LE(0x3c);
    // Signature (4) + COFF header (20) + Subsystem's offset in the optional header (68, PE32 and PE32+).
    const subsystem = pe + 92;
    if (subsystem + 2 > read || header.toString('latin1', pe, pe + 4) !== 'PE\0\0') return false;
    return header.readUInt16LE(subsystem) === WINDOWS_CUI;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
