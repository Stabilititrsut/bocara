import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'bocara_onboarding_done';

const OnboardingContext = createContext<{
  onboardingChecked: boolean;
  onboardingDone: boolean;
  completarOnboarding: () => Promise<boolean>;
} | null>(null);

export function OnboardingProvider({ children }: { children: React.ReactNode }) {
  const [onboardingChecked, setChecked] = useState(Platform.OS === 'web');
  const [onboardingDone, setDone] = useState(true);

  useEffect(() => {
    if (Platform.OS === 'web') return;
    let active = true;
    AsyncStorage.getItem(STORAGE_KEY).then(value => {
      if (active) setDone(value === 'true');
    }).catch(() => {
      // Mantener el comportamiento anterior: un fallo de lectura no bloquea la app.
      console.warn('[Onboarding] No se pudo leer la preferencia local.');
    }).finally(() => {
      if (active) setChecked(true);
    });
    return () => { active = false; };
  }, []);

  const completarOnboarding = useCallback(async () => {
    // El guard observa la finalización incluso si falla la persistencia.
    setDone(true);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, 'true');
      return true;
    } catch {
      console.warn('[Onboarding] No se pudo guardar la preferencia; se conserva durante esta sesión.');
      return false;
    }
  }, []);

  return (
    <OnboardingContext.Provider value={{ onboardingChecked, onboardingDone, completarOnboarding }}>
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboarding() {
  const context = useContext(OnboardingContext);
  if (!context) throw new Error('useOnboarding requiere OnboardingProvider');
  return context;
}
