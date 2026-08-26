# Используем супер-легкий веб-сервер Nginx
FROM nginx:alpine

# Build context is the /app subtree (self-contained per-app build, M2-P3).
# nginx.conf ships as a TEMPLATE (A3-P1): the same-origin /api upstream is a live
# identifier that never enters the repo, so app/docker-entrypoint.sh renders this
# file to /etc/nginx/nginx.conf at container start. The repo-side filename stays
# `nginx.conf` deliberately — it is enumerated as a live-deploy path in AGENTS.md §7,
# in scripts/check-contract-integrity.sh and in docs/RUNBOOK.md, and it is what the
# delivery-contract drift guard parses.
COPY nginx.conf /etc/nginx/nginx.conf.template

# Копируем файл index.html в папку, откуда Nginx раздает файлы
COPY index.html /usr/share/nginx/html/index.html

# Копируем kb-артефакт (VDK-P3: данные приложения — immutable static)
COPY kb-v1.json /usr/share/nginx/html/kb-v1.json

# Копируем версионированный монтаж модулей (A1-DL-004: версия в пути,
# copy-forward — опубликованная версия никогда не перезаписывается на месте).
# Копируется корень монтажа целиком, поэтому новая версия /m/v{N}/ не требует
# правки этого файла — в отличие от kb-артефакта с версией в имени файла.
COPY m/ /usr/share/nginx/html/m/

# Копируем PWA manifest и иконки
COPY manifest.json /usr/share/nginx/html/manifest.json
COPY icons/ /usr/share/nginx/html/icons/

# Копируем Service Worker и офлайн страницу
COPY sw.js /usr/share/nginx/html/sw.js
COPY offline.html /usr/share/nginx/html/offline.html

# Политика конфиденциальности (PPR-P1). Статический документ, который отдаётся
# по адресу /privacy — точное совпадение location в nginx.conf, а не откат
# try_files на оболочку. Файл ничего не грузит: ни скрипта, ни стилей
# монтажа /m/v{N}/ — поэтому он не участвует ни в OFFLINE_URLS, ни в графе
# модулей и переживает любой бамп поколения. Плоская двухаргументная форма
# COPY — единственная, которую разбирает ship-list-гард (прежде здесь стояла
# ссылка на transfer.html как на образец такой строки; страницу переноса убрал
# PPR-P2 вместе с самим механизмом).
COPY privacy.html /usr/share/nginx/html/privacy.html

# Копируем entrypoint (A3-P1): рендерит конфиг, минтит ID-токен для /api-прокси,
# обновляет его и передаёт управление nginx. Плоская двухаргументная форма COPY —
# без --chmod/--from, без wildcard: ship-list-гард в app/tests/delivery-contract.spec.js
# падает (fail closed) на любой форме COPY, которую он не разбирает полностью.
COPY docker-entrypoint.sh /docker-entrypoint.sh

# Открываем порт 8080 (стандарт для Cloud Run)
EXPOSE 8080

# Запускаем Nginx через entrypoint. Вызов идёт через /bin/sh, поэтому образ не
# зависит от бита исполнения на закоммиченном файле; ENTRYPOINT базового образа
# намеренно замещается целиком (см. шапку docker-entrypoint.sh).
ENTRYPOINT ["/bin/sh", "/docker-entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]
