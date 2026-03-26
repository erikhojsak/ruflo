/**
 * Core Event Bus - Stub for V3 event bus implementation
 */

export class EventBus {
  private handlers = new Map<string, Set<Function>>();

  emit(type: string, data?: unknown): void {
    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        handler(data);
      }
    }
  }

  on(type: string, handler: Function): void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
  }

  off(type: string, handler: Function): void {
    this.handlers.get(type)?.delete(handler);
  }
}

export function createEventBus(): EventBus {
  return new EventBus();
}
