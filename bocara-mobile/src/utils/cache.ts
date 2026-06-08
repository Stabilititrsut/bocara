import AsyncStorage from '@react-native-async-storage/async-storage';

const TTL_MS = 5 * 60 * 1000; // 5 minutos

interface Entry<T> { data: T; ts: number }

export async function getCache<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(`bocara_cache_${key}`);
    if (!raw) return null;
    const e: Entry<T> = JSON.parse(raw);
    if (Date.now() - e.ts > TTL_MS) return null;
    return e.data;
  } catch { return null; }
}

export async function setCache<T>(key: string, data: T): Promise<void> {
  try {
    const e: Entry<T> = { data, ts: Date.now() };
    await AsyncStorage.setItem(`bocara_cache_${key}`, JSON.stringify(e));
  } catch {}
}

export async function clearCache(key: string): Promise<void> {
  try { await AsyncStorage.removeItem(`bocara_cache_${key}`); } catch {}
}
