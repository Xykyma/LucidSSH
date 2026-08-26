/**
 * Слияние сохранённого config.json с дефолтами (чистая функция, без Electron):
 * неизвестные ключи отбрасываются, значения с неверным типом заменяются дефолтом,
 * повреждённый файл не роняет приложение (§18 Security_Guide).
 */
export function mergeWithDefaults<T extends object>(defaults: T, saved: unknown): T {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return defaults;
  const out = { ...defaults } as Record<string, unknown>;
  const savedRec = saved as Record<string, unknown>;
  for (const key of Object.keys(defaults)) {
    const defVal = (defaults as Record<string, unknown>)[key];
    const savVal = savedRec[key];
    if (savVal === undefined) continue;
    if (key === 'shownCounts') {
      // произвольный словарь счётчиков — принимаем только number-значения
      if (typeof savVal === 'object' && savVal !== null && !Array.isArray(savVal)) {
        const counts: Record<string, number> = {};
        for (const [k, v] of Object.entries(savVal)) {
          if (typeof v === 'number' && Number.isFinite(v)) counts[k] = v;
        }
        out[key] = counts;
      }
    } else if (key === 'pendingKeyDeployments') {
      // HM-12: элементы с неверной формой отбрасываются по одному, не всем списком
      if (Array.isArray(savVal)) out[key] = savVal.filter(isValidPendingKeyDeployment);
    } else if (typeof defVal === 'object' && defVal !== null && !Array.isArray(defVal)) {
      out[key] = mergeWithDefaults(defVal as object, savVal);
    } else if (Array.isArray(defVal)) {
      if (Array.isArray(savVal)) out[key] = savVal;
    } else if (typeof savVal === typeof defVal) {
      out[key] = savVal;
    }
  }
  return out as T;
}

function isValidPendingKeyDeployment(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r['keyPath'] === 'string' && typeof r['publicKey'] === 'string';
}
