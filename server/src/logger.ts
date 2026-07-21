import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { logHub, type LogEntry } from './logHub.js';

function getLogFilePath(): string {
  return process.env.LOG_FILE_PATH ?? 'data/events.log';
}

export async function logEvent(level: 'info' | 'warn' | 'error', payload: Record<string, unknown>): Promise<void> {
  // timestamp/level lead the line (output unchanged from before). The cast is
  // needed because spreading a Record<string, unknown> widens the leading
  // keys' types; no call site overrides timestamp/level.
  const entry = { timestamp: new Date().toISOString(), level, ...payload } as LogEntry;

  // Fan out to live log subscribers first; push is synchronous and never
  // throws, so viewers see the entry even if the file write below fails.
  logHub.push(entry);

  const line = JSON.stringify(entry);
  if (level === 'info') {
    console.log(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.error(line);
  }

  const filePath = getLogFilePath();
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line + '\n', 'utf-8');
  } catch (error) {
    console.error('Failed to write to log file:', error);
  }
}
