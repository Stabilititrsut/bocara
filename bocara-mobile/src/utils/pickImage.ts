import { Platform } from 'react-native';

export interface PickedImage {
  base64: string;
  mimeType: string;
}

export async function pickImage(): Promise<PickedImage | null> {
  if (Platform.OS === 'web') {
    return pickImageWeb();
  }
  return pickImageNative();
}

function pickImageWeb(): Promise<PickedImage | null> {
  return new Promise((resolve) => {
    const doc = (global as any).document as Document | undefined;
    if (!doc) { resolve(null); return; }

    const input = doc.createElement('input') as HTMLInputElement;
    input.type = 'file';
    input.accept = 'image/*';
    input.style.cssText = 'position:fixed;top:-9999px;opacity:0;pointer-events:none;';
    doc.body.appendChild(input);

    const cleanup = () => { try { doc.body.removeChild(input); } catch {} };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      cleanup();
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(',')[1];
        resolve({ base64, mimeType: file.type || 'image/jpeg' });
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    }, { once: true });

    // Modern browsers fire 'cancel' when user dismisses the dialog
    input.addEventListener('cancel', () => { cleanup(); resolve(null); }, { once: true });

    input.click();
  });
}

async function pickImageNative(): Promise<PickedImage | null> {
  let ImagePicker: any;
  try { ImagePicker = require('expo-image-picker'); } catch { return null; }

  const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (status !== 'granted') return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ImagePicker.MediaTypeOptions.Images,
    allowsEditing: true,
    quality: 0.8,
    base64: true,
  });

  if (result.canceled || !result.assets?.length) return null;
  const asset = result.assets[0];
  if (!asset.base64) return null;

  return { base64: asset.base64, mimeType: 'image/jpeg' };
}
