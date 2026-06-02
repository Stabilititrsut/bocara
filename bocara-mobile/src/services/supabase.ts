import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const supabaseUrl = 'https://tbbjrethcgjxkfazntaa.supabase.co';

const supabaseAnonKey =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRiYmpyZXRoY2dqeGtmYXpudGFhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMDY4NjgsImV4cCI6MjA5Mjg4Mjg2OH0.x-ifkm2M9vnI1oefWquwX3BgH6N7s2Lodd2iuoC3J2Y';

console.log('[Supabase DEBUG] URL:', supabaseUrl);
console.log('[Supabase DEBUG] key exists:', !!supabaseAnonKey);
console.log('[Supabase DEBUG] key prefix:', supabaseAnonKey.slice(0, 25));

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('[Supabase] Falta URL o anon key');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: Platform.OS !== 'web' ? AsyncStorage : undefined,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});