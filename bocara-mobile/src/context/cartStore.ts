import { publicacionVencida } from '../utils/horarioRecogida';
import { campoDisponibilidad } from '../utils/stock';
import type { Bolsa, CartItem } from '../types';

export type ResultadoAgregar =
  | { ok: true }
  | { ok: false; motivo: 'vencido' | 'no_cargado' | 'otro_negocio' | 'agotado' | 'stock_invalido' | 'producto_invalido' }
  | { ok: false; motivo: 'limite_stock'; stockDisponible: number };

interface Storage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<unknown>;
}

export interface CartSnapshot {
  items: CartItem[];
  loaded: boolean;
  storageError: 'lectura' | 'escritura' | null;
}

// Cada clave espera sus escrituras anteriores, incluso si su provider se remontó.
export function createCartPersistence(storage: Storage) {
  const writes = new Map<string, Promise<void>>();
  return {
    async read(key: string) {
      await writes.get(key);
      return storage.getItem(key);
    },
    write(key: string, items: CartItem[], done: (failed: boolean) => void) {
      const value = JSON.stringify(items);
      const pending = (writes.get(key) ?? Promise.resolve())
        .then(() => storage.setItem(key, value))
        .then(() => { done(false); }, () => {
          console.warn('[Carrito] No se pudo guardar el carrito local.');
          done(true);
        });
      writes.set(key, pending);
      void pending.then(() => { if (writes.get(key) === pending) writes.delete(key); });
    },
  };
}

export function stockLocal(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function productoValido(bolsa: Bolsa): boolean {
  return !!bolsa && typeof bolsa.id === 'string' && !!bolsa.id &&
    typeof bolsa.negocio_id === 'string' && !!bolsa.negocio_id &&
    typeof bolsa.precio_descuento === 'number' && Number.isFinite(bolsa.precio_descuento) && bolsa.precio_descuento >= 0;
}

function restaurar(stored: string | null): CartItem[] {
  if (!stored) return [];
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed)) throw new Error('Formato de carrito inválido');
  const items: CartItem[] = [];
  for (const item of parsed) {
    if (!item || !productoValido(item.bolsa) || !Number.isSafeInteger(item.cantidad) || item.cantidad <= 0) continue;
    if (items.length && items[0].bolsa.negocio_id !== item.bolsa.negocio_id) continue;
    if (items.some(i => i.bolsa.id === item.bolsa.id)) continue;
    // El stock persistido es metadata histórica, no disponibilidad actual.
    items.push({ bolsa: item.bolsa, cantidad: item.cantidad });
  }
  return items;
}

export function createCartStore(key: string, persistence: ReturnType<typeof createCartPersistence>) {
  let snapshot: CartSnapshot = { items: [], loaded: false, storageError: null };
  let active = false;
  let generation = 0;
  let revision = 0;
  let pendingClear = false;
  const listeners = new Set<() => void>();
  const publish = (next: CartSnapshot) => {
    snapshot = next;
    listeners.forEach(listener => listener());
  };
  const save = (items: CartItem[]) => {
    const currentRevision = ++revision;
    persistence.write(key, items, failed => {
      if (!active || currentRevision !== revision) return;
      publish({ ...snapshot, storageError: failed ? 'escritura' : null });
    });
  };
  const change = (items: CartItem[]) => {
    publish({ ...snapshot, items });
    save(items);
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    activate() {
      active = true;
      const currentGeneration = ++generation;
      if (!snapshot.loaded) {
        void (async () => {
          let items: CartItem[] = [];
          let storageError: CartSnapshot['storageError'] = null;
          try { items = restaurar(await persistence.read(key)); }
          catch {
            storageError = 'lectura';
            console.warn('[Carrito] No se pudo recuperar el carrito local.');
          }
          if (!active || currentGeneration !== generation) return;
          const clear = pendingClear;
          pendingClear = false;
          publish({ items: clear ? [] : items, loaded: true, storageError: snapshot.storageError ?? storageError });
        })();
      }
      return () => { active = false; generation++; };
    },
    agregar(bolsa: Bolsa): ResultadoAgregar {
      if (!active || !snapshot.loaded) return { ok: false, motivo: 'no_cargado' };
      if (publicacionVencida(bolsa || {})) return { ok: false, motivo: 'vencido' };
      if (!productoValido(bolsa)) return { ok: false, motivo: 'producto_invalido' };
      if (snapshot.items.length && snapshot.items[0].bolsa.negocio_id !== bolsa.negocio_id) {
        return { ok: false, motivo: 'otro_negocio' };
      }
      // Validación local del campo existente; no representa una reserva de inventario.
      // Prioriza cantidad_disponible_real (DB - reservas pendientes) sobre el
      // histórico de DB, que solo se usa si el backend no mandó el campo real.
      const stock = stockLocal(campoDisponibilidad(bolsa));
      if (stock === null) return { ok: false, motivo: 'stock_invalido' };
      const existing = snapshot.items.find(i => i.bolsa.id === bolsa.id);
      if (existing && existing.cantidad >= stock) {
        // Una ficha recién cargada puede tener menos stock que el carrito persistido.
        change(stock === 0 ? snapshot.items.filter(i => i.bolsa.id !== bolsa.id) :
          snapshot.items.map(i => i.bolsa.id === bolsa.id ? { bolsa, cantidad: stock } : i));
        if (stock === 0) return { ok: false, motivo: 'agotado' };
        return { ok: false, motivo: 'limite_stock', stockDisponible: stock };
      }
      if (stock === 0) return { ok: false, motivo: 'agotado' };
      change(existing
        ? snapshot.items.map(i => i.bolsa.id === bolsa.id ? { bolsa, cantidad: i.cantidad + 1 } : i)
        : [...snapshot.items, { bolsa, cantidad: 1 }]);
      return { ok: true };
    },
    quitar(bolsaId: string) {
      if (!active || !snapshot.loaded) return;
      if (!snapshot.items.some(i => i.bolsa.id === bolsaId)) return;
      change(snapshot.items.flatMap(i => i.bolsa.id !== bolsaId ? [i] :
        i.cantidad > 1 ? [{ ...i, cantidad: i.cantidad - 1 }] : []));
    },
    limpiar() {
      if (!active) return;
      // Conservar una limpieza válida aunque se cambie de cuenta durante la lectura.
      if (!snapshot.loaded) { pendingClear = true; save([]); return; }
      change([]);
    },
    // Aplica disponibilidad real recién consultada al backend (carrito antes de
    // checkout, o tras un 409 en pago). Nunca borra el item en 0: lo deja
    // marcado como agotado para que la UI ofrezca quitar o reintentar, y recorta
    // la cantidad guardada si excede el stock real (incluida una cantidad
    // resucitada por hidratación con stock más viejo que el actual).
    sincronizarDisponibilidad(actualizaciones: Record<string, number>) {
      if (!active || !snapshot.loaded) return;
      let cambio = false;
      const items = snapshot.items.map(i => {
        const real = actualizaciones[i.bolsa.id];
        if (real === undefined || !Number.isFinite(real)) return i;
        const realClamp = Math.max(0, real);
        const cantidad = realClamp > 0 ? Math.min(i.cantidad, realClamp) : i.cantidad;
        if (i.bolsa.cantidad_disponible_real === realClamp && cantidad === i.cantidad) return i;
        cambio = true;
        return { ...i, bolsa: { ...i.bolsa, cantidad_disponible_real: realClamp }, cantidad };
      });
      if (cambio) change(items);
    },
  };
}
