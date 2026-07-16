import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

function getLogFilePath(): string {
  return process.env.LOG_FILE_PATH ?? 'data/events.log';
}

export async function logEvent(level: 'info' | 'warn' | 'error', payload: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), level, ...payload });

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
