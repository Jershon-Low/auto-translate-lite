import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { TranscriptBuffer } from './transcriptBuffer.js';
import { TranslationCache } from './translationCache.js';
import type { RoleCaches } from './sermonCache.js';
import type { RoleProviders } from './llmTypes.js';
import type { TranslationFlagDisplayMode } from './translationFlagDisplayStore.js';

const EMPTY_ROLE_CACHES: RoleCaches = {
  transcriptionVerifier: null,
  translation: null,
  translationVerifier: null,
};

export class Session {
  id: string = randomUUID();
  isActive: boolean = false;
  buffer: TranscriptBuffer = new TranscriptBuffer();
  roleCaches: RoleCaches = { ...EMPTY_ROLE_CACHES };
  providers: RoleProviders | null = null;
  translationCache: TranslationCache = new TranslationCache();
  inFlightFills: Map<string, Promise<void>> = new Map();
  mode: 'automatic' | 'manual' = 'automatic';
  translationFlagDisplayMode: TranslationFlagDisplayMode = 'hide';
  captureSocket: WebSocket | null = null;
  ingestQueue: Promise<void> = Promise.resolve();
  publishQueue: Promise<void> = Promise.resolve();
  private viewers: Map<WebSocket, string> = new Map();
  private reviewSockets: Set<WebSocket> = new Set();

  start(): void {
    this.id = randomUUID();
    this.isActive = true;
    this.buffer.clear();
    this.roleCaches = { ...EMPTY_ROLE_CACHES };
    this.providers = null;
    this.translationCache = new TranslationCache();
    this.inFlightFills = new Map();
    this.translationFlagDisplayMode = 'hide';
    this.ingestQueue = Promise.resolve();
    this.publishQueue = Promise.resolve();
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

  getAllViewers(): WebSocket[] {
    return Array.from(this.viewers.keys());
  }

  addReview(socket: WebSocket): void {
    this.reviewSockets.add(socket);
  }

  removeReview(socket: WebSocket): void {
    this.reviewSockets.delete(socket);
  }

  getAllReview(): WebSocket[] {
    return Array.from(this.reviewSockets);
  }

  broadcastToReview(payload: string): void {
    for (const socket of this.reviewSockets) {
      if (socket.readyState === WebSocket.OPEN) socket.send(payload);
    }
  }
}
