/**
 * Non-Metro environments (Node/tests) resolve the native implementation;
 * Metro resolves platform-specific variants (.web.ts / .native.ts) first.
 */
export { SqliteStorage } from './sqlite.native';
