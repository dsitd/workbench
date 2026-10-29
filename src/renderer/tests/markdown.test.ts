import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

Object.defineProperty(globalThis, 'window', { value: { workbench: {} }, configurable: true });

export const markdownRegressionFixture = `- **Парность tool call.** На каждый вызов всегда пишется один результат: при остановке, ошибке и недоступном инструменте. Незавершённые группы не попадают в запрос.
- **Защита от выхода за папку.** Я проверил случай с висячим symlink, где \`canonicalTarget\` возвращает путь «внутри» корня. Он безопасен: чтение идёт с \`O_NOFOLLOW\`, а запись делает \`rename\` поверх ссылки и не пишет через неё.
- **Запись.** Запись атомарна, а undo отказывается перезаписывать чужие правки.
- **Сеть.** Адрес пиннится после DNS-проверки, редиректы проверяются заново, размеры ограничены.

| Режим | Правки |
| --- | --- |
| План | Отключены |
| Auto-edit | Разрешены |

\`\`\`typescript
const value = 1;
\`\`\`
`;

test('Markdown lists keep bold and inline code in the same semantic list item', async () => {
  const { Markdown } = await import('../components/Common');
  const html = renderToStaticMarkup(createElement(Markdown, { text: markdownRegressionFixture }));
  assert.match(html, /<ul>/);
  assert.equal((html.match(/<li>/g) || []).length, 4);
  assert.match(html, /<li><strong>Защита от выхода за папку\.<\/strong> Я проверил случай с висячим symlink, где <code>canonicalTarget<\/code>/);
  assert.match(html, /<table>/);
  assert.match(html, /class="code-block"/);
  assert.match(html, /Скопировать код/);
});

test('Markdown escapes raw HTML and only opens explicit HTTP(S) links', async () => {
  const { Markdown } = await import('../components/Common');
  const html = renderToStaticMarkup(createElement(Markdown, { text: '<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [local](file:///tmp/example) [safe](https://example.com)' }));
  assert.doesNotMatch(html, /<script>|href="javascript:|href="file:/);
  assert.match(html, /href="https:\/\/example\.com"/);
  assert.match(html, /rel="noreferrer"/);
});
