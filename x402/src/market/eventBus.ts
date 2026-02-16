import { MarketEvent } from "./types.js";

type EventListener = (event: MarketEvent) => void;

export class MarketEventBus {
  private readonly listeners = new Set<EventListener>();

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: MarketEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
