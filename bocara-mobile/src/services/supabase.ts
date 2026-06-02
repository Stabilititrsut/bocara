import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

console.log('[Supabase] URL:', supabaseUrl);
console.log('[Supabase] key exists:', !!supabaseAnonKey);
console.log('[Supabase] key prefix:', supabaseAnonKey?.slice(0, 20));

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(`Missing Supabase env vars — URL: ${!!supabaseUrl}, KEY: ${!!supabaseAnonKey}`);
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: Platform.OS !== 'web' ? AsyncStorage : undefined,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
