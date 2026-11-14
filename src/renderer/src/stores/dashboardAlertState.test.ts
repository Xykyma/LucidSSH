import { describe, expect, it } from 'vitest';
import { alertAfterEvent, closedAfterDismiss, visibleAlertIssues } from './dashboardAlertState';

describe('dashboardAlertState — закрытие находок до конца Соединения (тикет 02)', () => {
  it('событие с находками заменяет видимый набор', () => {
    expect(alertAfterEvent(['cpu', 'rebootRequired'])).toEqual({ issues: ['cpu', 'rebootRequired'] });
  });

  it('пустое событие от main снимает уведомления целиком — пустого контейнера нет', () => {
    expect(alertAfterEvent([])).toBeUndefined();
  });

  it('крестик закрывает находку; повторное закрытие не дублирует', () => {
    const closed = closedAfterDismiss(undefined, 'cpu');
    expect(closed).toEqual(['cpu']);
    expect(closedAfterDismiss(closed, 'cpu')).toBe(closed); // тот же массив, не копия
  });

  it('закрытая находка не возвращается, когда main присылает её снова (null → ≥90%)', () => {
    const closed = closedAfterDismiss(undefined, 'cpu');
    const alert = alertAfterEvent(['cpu']); // повторное событие от main
    expect(visibleAlertIssues(alert, closed)).toEqual([]);
  });

  it('незакрытые находки показываются независимо от закрытых', () => {
    const closed = closedAfterDismiss(undefined, 'cpu');
    const alert = alertAfterEvent(['cpu', 'ram', 'rebootRequired']);
    expect(visibleAlertIssues(alert, closed)).toEqual(['ram', 'rebootRequired']);
  });

  it('без закрытий виден весь набор; без alert — пусто', () => {
    expect(visibleAlertIssues({ issues: ['disk'] }, undefined)).toEqual(['disk']);
    expect(visibleAlertIssues(undefined, ['cpu'])).toEqual([]);
  });
});
