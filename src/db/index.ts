import type { IDatabase } from './interfaces/repositories.js';
import { InMemoryMockDatabase } from './adapters/mock/index.js';
import { FirestoreDatabase } from './adapters/firestore/index.js';

let activeDatabase: IDatabase | null = null;

export function getDatabase(): IDatabase {
  if (!activeDatabase) {
    const driver = process.env.DB_DRIVER ?? (process.env.NODE_ENV === 'test' ? 'mock' : 'firestore');
    if (driver === 'mock') {
      activeDatabase = new InMemoryMockDatabase();
    } else {
      activeDatabase = new FirestoreDatabase();
    }
  }
  return activeDatabase;
}

export function setDatabaseAdapter(db: IDatabase): void {
  activeDatabase = db;
}

export function resetDatabaseAdapter(): void {
  activeDatabase = null;
}

export * from './interfaces/types.js';
export * from './interfaces/repositories.js';
export * from './adapters/mock/index.js';
export * from './adapters/firestore/index.js';
