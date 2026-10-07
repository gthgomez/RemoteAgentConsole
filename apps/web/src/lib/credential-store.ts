import type { DeviceCredentialStore } from "@remote-agent-console/client-sdk";

const DATABASE_NAME = "rac-device-credentials";
const STORE_NAME = "credentials";
const DEVICE_KEY = "device";
const DATABASE_VERSION = 1;

export class IndexedDbCredentialStore implements DeviceCredentialStore {
  async get(): Promise<string | null> {
    const database = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).get(DEVICE_KEY);
        request.onsuccess = () =>
          resolve(typeof request.result === "string" ? request.result : null);
        request.onerror = () =>
          reject(request.error ?? new Error("Could not read device credential"));
      });
    } finally {
      database.close();
    }
  }

  async set(credential: string): Promise<void> {
    const database = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).put(credential, DEVICE_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Could not save device credential"));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("Could not save device credential"));
      });
    } finally {
      database.close();
    }
  }

  async clear(): Promise<void> {
    const database = await this.open();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        transaction.objectStore(STORE_NAME).delete(DEVICE_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Could not clear device credential"));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("Could not clear device credential"));
      });
    } finally {
      database.close();
    }
  }

  async clearIfMatches(credential: string): Promise<boolean> {
    const database = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(DEVICE_KEY);
        let removed = false;
        request.onsuccess = () => {
          if (request.result === credential) {
            store.delete(DEVICE_KEY);
            removed = true;
          }
        };
        request.onerror = () =>
          reject(request.error ?? new Error("Could not check device credential"));
        transaction.oncomplete = () => resolve(removed);
        transaction.onerror = () =>
          reject(transaction.error ?? new Error("Could not clear device credential"));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error("Could not clear device credential"));
      });
    } finally {
      database.close();
    }
  }

  private open(): Promise<IDBDatabase> {
    if (!globalThis.indexedDB)
      return Promise.reject(new Error("Secure browser storage is unavailable"));
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("Could not open secure browser storage"));
      request.onblocked = () => reject(new Error("Secure browser storage is busy"));
    });
  }
}
