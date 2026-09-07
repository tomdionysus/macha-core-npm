import type { ReadWriteStorageLike } from './storage.js';
import { machaHost } from '../runtime/host.js';

function clampVolume(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
}

export class VolumeStore {
  private readonly key: string;

  constructor(clientId: string, private readonly storage: ReadWriteStorageLike = machaHost().storage) {
    this.key = `macha.volume.v1.${clientId}`;
  }

  load(): number {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return 1;
    const value = Number(raw);
    return Number.isFinite(value) ? clampVolume(value) : 1;
  }

  save(volume: number): number {
    const value = clampVolume(volume);
    this.storage.setItem(this.key, String(value));
    return value;
  }
}
