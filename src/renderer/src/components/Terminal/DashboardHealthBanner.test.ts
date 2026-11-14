import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { DashboardAlertIssue } from '@shared/dashboard';
import { DashboardHealthBanner } from './DashboardHealthBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${String(options.value)}` : key
  })
}));

type TestElement = ReactElement<{
  children?: ReactNode;
  'aria-label'?: string;
  onClick?: () => void;
}>;

function findButtons(node: ReactNode, matches: (element: TestElement) => boolean): TestElement[] {
  if (Array.isArray(node)) return node.flatMap((child) => findButtons(child, matches));
  if (!isValidElement(node)) return [];
  const element = node as TestElement;
  const own = element.type === 'button' && matches(element) ? [element] : [];
  return [...own, ...findButtons(element.props.children, matches)];
}

const closeButtons = (node: ReactNode) =>
  findButtons(node, (element) => element.props['aria-label'] === 'common.close');
const dismissButtons = (node: ReactNode) =>
  findButtons(node, (element) => element.props.children === 'dashboard.healthBanner.dismissIssue');

describe('DashboardHealthBanner', () => {
  it('закрывает только выбранную находку без персистентного мьюта', () => {
    const onCloseIssue = vi.fn<(issue: DashboardAlertIssue) => void>();
    const onDismissIssue = vi.fn<(issue: DashboardAlertIssue) => void>();
    const props = {
      alert: { issues: ['cpu', 'rebootRequired'] as DashboardAlertIssue[] },
      metrics: undefined,
      onCloseIssue,
      onDismissIssue
    };

    const markup = renderToStaticMarkup(createElement(DashboardHealthBanner, props));
    expect(markup.match(/role="alert"/g)).toHaveLength(2);

    const buttons = closeButtons(DashboardHealthBanner(props));
    expect(buttons).toHaveLength(2);
    buttons[0]?.props.onClick?.();
    expect(onCloseIssue).toHaveBeenCalledExactlyOnceWith('cpu');
    expect(onDismissIssue).not.toHaveBeenCalled();
  });

  it('оставляет действия четырёх находок независимыми', () => {
    const onCloseIssue = vi.fn<(issue: DashboardAlertIssue) => void>();
    const onDismissIssue = vi.fn<(issue: DashboardAlertIssue) => void>();
    const root = DashboardHealthBanner({
      alert: { issues: ['cpu', 'ram', 'disk', 'rebootRequired'] },
      metrics: undefined,
      onCloseIssue,
      onDismissIssue
    });

    const closes = closeButtons(root);
    const dismisses = dismissButtons(root);
    expect(closes).toHaveLength(4);
    expect(dismisses).toHaveLength(4);

    closes[1]?.props.onClick?.();
    dismisses[0]?.props.onClick?.();
    expect(onCloseIssue).toHaveBeenCalledExactlyOnceWith('ram');
    expect(onDismissIssue).toHaveBeenCalledExactlyOnceWith('cpu');
  });

  it('у Quick Connect оставляет крестики, но не показывает персистентный мьют', () => {
    const props = {
      alert: { issues: ['cpu', 'rebootRequired'] as DashboardAlertIssue[] },
      metrics: undefined,
      onCloseIssue: vi.fn(),
      onDismissIssue: undefined
    };

    const markup = renderToStaticMarkup(createElement(DashboardHealthBanner, props));
    expect(markup).not.toContain('dashboard.healthBanner.dismissIssue');
    expect(closeButtons(DashboardHealthBanner(props))).toHaveLength(2);
  });
});
