import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**', 'docs/**', 'Design backup/**', 'private/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md §2: без any без явной причины в комментарии
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-ignore': true }]
    }
  },
  {
    // Только renderer — main/preload не React. Берём вручную только два
    // классических правила плагина: остальные (react-hooks/purity,
    // set-state-in-effect, immutability и т.п.) — из набора для React Compiler,
    // рассчитаны на кодовую базу, уже приведённую под них, и на существующем
    // коде дают ~100 несвязанных срабатываний.
    //
    // rules-of-hooks: 'error' ловит вызов хука после условного return
    // (найдено 22.07.2026, NewConnectionDrawer — валило всё приложение чёрным
    // экраном на любое открытие/закрытие дровера).
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn'
    }
  },
  {
    // ADR-0010 (docs/agent/adr/0010-esc-stack-not-overlay-module.md): Esc
    // маршрутизируется только через escStack/useEscapeClose, не точечными
    // `if (e.key === 'Escape')`. Ловит копипасту синтаксически, не обход
    // через константу — большего от синтаксического правила не ждём.
    files: ['src/renderer/**/*.{ts,tsx}'],
    ignores: [
      'src/renderer/src/stores/escStack.ts',
      'src/renderer/src/stores/escStack.test.ts',
      'src/renderer/src/hooks/useEscapeClose.ts',
      // hotkeyBus не обрабатывает Esc, а наоборот — обязан пропустить его мимо
      // себя нетронутым (ADR-0012); тест это и проверяет, диспетчеризуя 'Escape'
      // на фальшивое окно. Сам модуль сравнивает с ESCAPE_KEY из escStack, но
      // ignores держим на паре файлов, чтобы тест не пришлось писать окольно.
      'src/renderer/src/stores/hotkeyBus.ts',
      'src/renderer/src/stores/hotkeyBus.test.ts'
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value='Escape']",
          message:
            "Не обрабатывайте 'Escape' точечно — регистрируйте вход через useEscapeClose (ADR-0010, docs/agent/adr/0010-esc-stack-not-overlay-module.md)."
        }
      ]
    }
  },
  {
    // ADR-0011 (docs/agent/adr/0011-typed-renderer-events.md): две «единственные
    // двери» IPC в main. Оба селектора обязаны жить в одном блоке — во flat
    // config правило из последующего блока перезаписывает одноимённое, а не
    // дополняет его.
    //
    // Тесты исключены намеренно: `win.webContents.send.mock.calls` — законная
    // проверка мока, а не отправка события.
    files: ['src/main/**/*.ts'],
    ignores: ['src/main/ipc/events.ts', 'src/main/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Отправка события мимо emit() теряет и проверку isDestroyed(), и
          // привязку к контракту RendererEvents. Ровно так разошлись три точки
          // в mainWindow.ts до ADR-0011.
          selector: "MemberExpression[property.name='send'][object.property.name='webContents']",
          message:
            'Не зовите webContents.send напрямую — отправляйте через emit() из src/main/ipc/events.ts (ADR-0011, docs/agent/adr/0011-typed-renderer-events.md).'
        },
        {
          // Граница правила (записана в ADR-0011): проверяется наличие вызова в
          // теле хендлера, но НЕ то, что он первый — `:first-child`/`:nth-child(1)`
          // дают ложные срабатывания на всех 85 хендлерах. Ловит «забыл
          // написать», пропускает «написал после работы».
          selector:
            "CallExpression[callee.object.name='ipcMain'] > ArrowFunctionExpression > BlockStatement:not(:has(ExpressionStatement > CallExpression[callee.name='assertSenderIsMainWindow']))",
          message:
            'IPC-хендлер обязан вызвать assertSenderIsMainWindow(event) — иначе канал принимает сообщения от любого отправителя (SEC-05, ADR-0011).'
        }
      ]
    }
  },
  {
    // ADR-0008 (docs/agent/adr/0008-guard-seam-at-ipc-boundary.md) + ADR-0018:
    // запись в SSH-канал мимо Стража. Единственный законный вызывающий
    // sendInput/sendCommandLine — guard/manager.ts; тест канала
    // (src/main/ipc/boundary.test.ts, «пункт 2») ловит «IPC не дошёл до
    // Стража», это правило — «кто-то в main пишет в провод сам».
    // Проверено на ESLint 10.6: `import * as sm from '../ssh/sessionManager'`
    // тоже ловится (весь namespace-импорт помечается ошибкой, даже без
    // обращения к sm.sendInput) — второе правило не нужно. Не видит только
    // динамический import()/require — остаток компромисса ADR-0008.
    files: ['src/main/**/*.ts'],
    ignores: ['src/main/guard/manager.ts', 'src/main/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/sessionManager'],
              importNames: ['sendInput', 'sendCommandLine'],
              message:
                'sendInput/sendCommandLine пишут в SSH-канал без Стража — зовите submitCommand/submitRawInput из guard/manager (ADR-0008).'
            }
          ]
        }
      ]
    }
  }
);
