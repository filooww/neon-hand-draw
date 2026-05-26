#!/usr/bin/env python3
"""Сборка одностраничного standalone HTML из модульного проекта.

Берём modular `neon-air-draw/` и склеиваем:
- CSS из css/styles.css инлайним в <style>
- Все JS-модули из js/ склеиваем в один <script type="module">
  (с удалением `export` / `import from './..js'` строк)
- Внешние CDN-импорты (MediaPipe, Tesseract) оставляем как есть

Результат: один self-contained HTML, который работает через двойной клик
с `file://` URL — без локального сервера.
"""
import re
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / 'neon-air-draw-standalone.html'

# Порядок модулей: листья сначала, main.js в конце.
MODULE_ORDER = [
    'one-euro.js',
    'stroke-draw.js',
    'paper-ball.js',
    'gestures.js',
    'recognition.js',
    'hand-tracker.js',
    'main.js',
]


def strip_imports_exports(src: str) -> str:
    # Удалить `export ` перед declarations: export function/const/let/class/default/{...}
    src = re.sub(r'^export\s+(?=function|const|let|var|class|async|default)', '', src, flags=re.MULTILINE)
    # Удалить `export { ... };` целиком
    src = re.sub(r'^export\s*\{[^}]*\}\s*;?\s*$', '', src, flags=re.MULTILINE)
    # Удалить `import ... from './..';` (относительные импорты).
    src = re.sub(r"^import\s+[^;]*?\s+from\s+['\"]\./[^'\"]+['\"]\s*;\s*$", '', src, flags=re.MULTILINE)
    return src


def main():
    # Читаем CSS
    css = (ROOT / 'css' / 'styles.css').read_text(encoding='utf-8')

    # Читаем и склеиваем JS-модули в правильном порядке
    parts = []
    parts.append(
        '// Standalone build: все ES-модули склеены в один скрипт.\n'
        '// Источники лежат рядом в папке js/ — там модульная версия.\n'
        '// Этот файл — результат сборки скриптом build_standalone.py.\n\n'
    )
    for name in MODULE_ORDER:
        body = (ROOT / 'js' / name).read_text(encoding='utf-8')
        body = strip_imports_exports(body).strip()
        parts.append(f'// ============== js/{name} ==============\n{body}\n\n')
    bundled = ''.join(parts)

    # Читаем index.html и подменяем <link rel="stylesheet"> и <script src="js/main.js">
    html = (ROOT / 'index.html').read_text(encoding='utf-8')
    # Используем lambda, чтобы backslashes в CSS/JS не интерпретировались как regex-backrefs.
    style_block = f'<style>\n{css}\n</style>'
    script_block = f'<script type="module">\n{bundled}</script>'
    html = re.sub(
        r'<link[^>]*href="css/styles.css"[^>]*>',
        lambda _m: style_block,
        html,
    )
    html = re.sub(
        r'<script\s+type="module"\s+src="js/main\.js"\s*></script>',
        lambda _m: script_block,
        html,
    )

    OUT.write_text(html, encoding='utf-8')
    print(f'wrote {OUT} ({OUT.stat().st_size} bytes)')


if __name__ == '__main__':
    main()
