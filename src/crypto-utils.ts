import { initCrypto } from './crypto.js';

let _cryptoInit = false;

export async function ensureCrypto(): Promise<void> {
  if (!_cryptoInit) {
    await initCrypto();
    _cryptoInit = true;
  }
}
