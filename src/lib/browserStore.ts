// Local storage for the browser UI (favourites, history, settings...). Every key is prefixed `br_`, so "Delete data"
// can never touch anything else that lives on this device.
const P = 'br_';

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(P + key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function saveJSON(key: string, value: unknown) {
  try {
    localStorage.setItem(P + key, JSON.stringify(value));
  } catch {
    /* storage full / blocked: the browser still works for this session */
  }
}

export function clearBrowserData(keys: string[]) {
  keys.forEach((k) => {
    try {
      localStorage.removeItem(P + k);
    } catch {
      /* ignore */
    }
  });
}
