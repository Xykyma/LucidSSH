/**
 * Может ли breadcrumb «на промпте» вернуть сессию из режима пароля (TERM-09).
 * Из режима пароля выводит только настоящий маркер шелла; синтетический
 * (таймер эха вставки) — догадка main, и ошибка стоит открытого пароля в
 * эхо и истории стрелок. Вне режима пароля источник не важен. Сессию без
 * маркеров вообще из режима пароля выводит не breadcrumb, а prompt-guess из
 * main (тикет 25, markPromptGuess в XtermView).
 */
export function mayEndPasswordMode(inPasswordMode: boolean, synthetic: boolean): boolean {
  return !(inPasswordMode && synthetic);
}
