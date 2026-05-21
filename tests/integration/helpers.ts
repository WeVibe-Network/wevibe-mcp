import { clearTestStore, getTestStoreSnapshot, setTestStoreFromSnapshot, getStore } from '../../src/key-store.js';

export class IdentityContext {
  private savedState: Map<string, string> = new Map();
  private name: string;

  constructor(name: string) {
    this.name = name;
  }

  activate(): void {
    clearTestStore();
    for (const [key, value] of this.savedState) {
      this.restoreEntry(key, value);
    }
  }

  save(): void {
    this.savedState = new Map(getTestStoreSnapshot());
  }

  getName(): string {
    return this.name;
  }

  private restoreEntry(key: string, value: string): void {
    const idx = key.indexOf(':');
    const service = key.substring(0, idx);
    const account = key.substring(idx + 1);
    getStore().setPassword(service, account, value);
  }
}

export function switchIdentity(from: IdentityContext, to: IdentityContext): void {
  from.save();
  clearTestStore();
  const snapshot = (to as any).savedState;
  if (snapshot.size > 0) {
    setTestStoreFromSnapshot(snapshot);
  }
}