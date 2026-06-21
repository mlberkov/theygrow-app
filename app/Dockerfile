# Используем супер-легкий веб-сервер Nginx
FROM nginx:alpine

# Build context is the /app subtree (self-contained per-app build, M2-P3).
# Копируем файл nginx.conf
COPY nginx.conf /etc/nginx/nginx.conf

# Копируем файл index.html в папку, откуда Nginx раздает файлы
COPY index.html /usr/share/nginx/html/index.html

# Копируем PWA manifest и иконки
COPY manifest.json /usr/share/nginx/html/manifest.json
COPY icons/ /usr/share/nginx/html/icons/

# Копируем Service Worker и офлайн страницу
COPY sw.js /usr/share/nginx/html/sw.js
COPY offline.html /usr/share/nginx/html/offline.html

# Открываем порт 8080 (стандарт для Cloud Run)
EXPOSE 8080

# Запускаем Nginx
CMD ["nginx", "-g", "daemon off;"]
