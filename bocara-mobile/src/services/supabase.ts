import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const supabaseUrl = 'https://tbbjrethcgjxkfazntaa.supabase.co';

const supabaseAnonKey =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRiYmpyZXRoY2dqeGtmYXpudGFhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMDY4NjgsImV4cCI6MjA5Mjg4Mjg2OH0.x-ifkm2M9vnI1oefWquwX3BgH6N7s2Lodd2iuoC3J2Y';


if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('[Supabase] Falta URL o anon key');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: Platform.OS !== 'web' ? AsyncStorage : undefined,
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // PKCE: el redirect de OAuth llega con ?code= en la URL (querystring), no con
    // tokens en el hash fragment (#access_token=...). El flow implícito depende
    // de que window.location.hash sobreviva hasta que el código lo lea, y en web
    // (Expo Router) el router puede tocar la URL antes de eso — con PKCE el
    // intercambio de sesión es determinista (exchangeCodeForSession) y nunca deja
    // el access_token expuesto en la URL. No mezclar con el flow implícito.
    flowType: 'pkce',
  },
});

