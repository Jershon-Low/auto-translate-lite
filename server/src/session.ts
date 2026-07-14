import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import { TranscriptBuffer } from './transcriptBuffer.js';
import type { SermonCacheRef } from './gemini.js';

export class Session {
  id: string = randomUUID();
  isActive: boolean = false;
  buffer: TranscriptBuffer = new TranscriptBuffer();
  sermonCache: SermonCacheRef | null = null;
  private viewers: Map<WebSocket, string> = new Map();

  start(): void {
    this.id = randomUUID();
    this.isActive = true;
    this.buffer.clear();
    this.sermonCache = null;
  }

  stop(): void {
    this.isActive = false;
  }

  addViewer(socket: WebSocket, language: string): void {
    this.viewers.set(socket, language);
  }

  removeViewer(socket: WebSocket): void {
    this.viewers.delete(socket);
  }

  switchViewerLanguage(socket: WebSocket, language: string): void {
    this.viewers.set(socket, language);
  }

  getActiveLanguages(): string[] {
    return Array.from(new Set(this.viewers.values()));
  }

  getViewersForLanguage(language: string): WebSocket[] {
    return Array.from(this.viewers.entries())
      .filter(([, viewerLanguage]) => viewerLanguage === language)
      .map(([socket]) => socket);
  }
}
