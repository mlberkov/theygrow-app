# TheyGrow — Инструкции для AI-агента

Этот файл содержит операционные правила для AI-агента (Cursor Agent), работающего над проектом TheyGrow.

---

## 1. Project Overview

**TheyGrow** — приложение для отслеживания развития детей, помогающее родителям фиксировать освоение навыков (milestones), вести дневник наблюдений и получать персонализированные рекомендации.

### Текущий стек

**Frontend:**
- Next.js 14+ (App Router)
- TypeScript (strict mode)
- Tailwind CSS
- React Query (TanStack Query)
- Zustand (client state)

**Backend:**
- FastAPI (Python 3.12+)
- PostgreSQL (реляционные данные: пользователи, профили, дневник)
- Neo4j (граф навыков и зависимостей)
- SQLAlchemy (async ORM)
- Alembic (миграции)

**Infrastructure:**
- Docker + docker-compose (локальная разработка)
- GCP Cloud Run (staging + production)
- GCP Cloud SQL (PostgreSQL в проде)
- Neo4j Aura (граф в проде)

### Структура проекта

```
they_grow/
├── backend/              # FastAPI backend
│   ├── src/
│   │   ├── main.py       # FastAPI app
│   │   ├── api/          # API endpoints
│   │   ├── db/           # Database (PG + Neo4j)
│   │   ├── models/       # SQLAlchemy models
│   │   ├── schemas/      # Pydantic schemas
│   │   ├── services/     # Business logic
│   │   └── utils/        # Helpers
│   ├── tests/            # pytest
│   ├── alembic/          # DB migrations
│   ├── pyproject.toml    # Poetry dependencies
│   └── Dockerfile
├── frontend/             # Next.js frontend
│   ├── src/
│   │   ├── app/          # App Router pages
│   │   ├── components/   # React components
│   │   ├── lib/          # API clients, utils
│   │   └── styles/       # Global CSS
│   ├── public/           # Static assets + PWA
│   │   ├── icons/
│   │   ├── manifest.json
│   │   └── sw.js
│   ├── tests/            # Vitest + RTL
│   ├── package.json
│   └── Dockerfile
├── data/                 # НЕ в git (исключая мастер-план)
│   └── mvp_masterplan.md # Основной план разработки
├── docs/                 # Документация
│   ├── adr/              # Architecture Decision Records
│   ├── api/              # API docs (примеры)
│   ├── schema/           # ER-диаграммы
│   ├── deployment.md     # Деплой инструкции
│   └── operations.md     # Runbook (с Блока 2)
├── .cursor/
│   └── rules/
│       └── masterplan.mdc # Ссылка на мастер-план
├── index.html            # Текущее приложение (монолит, остаётся)
├── docker-compose.yml    # Локальная разработка
├── AGENTS.md             # ★ Этот файл
├── README.md
├── CHANGELOG.md
└── .cursorignore
```

---

## 2. Commands

### Backend

```bash
# Установка зависимостей
cd backend
poetry install

# Запуск dev server
poetry run uvicorn src.main:app --reload --host 0.0.0.0 --port 8000

# Тесты
poetry run pytest
poetry run pytest --cov  # С покрытием

# Линтеры и форматтеры
poetry run black src tests --line-length 100
poetry run isort src tests
poetry run ruff check src tests
poetry run mypy src

# Миграции
poetry run alembic revision --autogenerate -m "description"
poetry run alembic upgrade head
```

### Frontend

```bash
# Установка зависимостей
cd frontend
pnpm install

# Запуск dev server
pnpm dev  # localhost:3000

# Тесты
pnpm test
pnpm test:ui  # Vitest UI

# Линтеры и type-check
pnpm lint
pnpm lint:fix
pnpm type-check  # tsc --noEmit

# Build
pnpm build
```

### Docker Compose (весь стек локально)

```bash
docker compose up         # Запуск всех сервисов
docker compose up -d      # Фоновый режим
docker compose down       # Остановка
docker compose logs -f    # Логи
```

---

## 3. Code Style

### Python (Backend)

- **Форматтер**: Black (line-length 100)
- **Import sort**: isort (profile black)
- **Linter**: Ruff (rules: E, F, I, N, W)
- **Type checker**: mypy (strict mode)
- **Docstrings**: Google style
- **Async**: везде, где возможно (FastAPI + SQLAlchemy + Neo4j)

### TypeScript (Frontend)

- **Форматтер**: Prettier
- **Linter**: ESLint (next/core-web-vitals)
- **Type checker**: tsc --noEmit (strict mode)
- **Import order**: ESLint + prettier-plugin-tailwindcss
- **Naming**: camelCase для переменных/функций, PascalCase для компонентов

---

## 4. Masterplan Reference

**Основной источник задач:** [`data/mvp_masterplan.md`](data/mvp_masterplan.md)

Мастер-план разбит на **8 блоков** (Блок 0–8), каждый блок содержит пронумерованные задачи (например, 0.1, 0.2, ...).

**При начале работы:**
1. Прочитай мастер-план (`data/mvp_masterplan.md`).
2. Определи текущую задачу (проверь чеклисты в мастер-плане).
3. Выполни задачу, следуя Definition of Done.
4. Обнови чеклист (отметь `[x]`).

**Структура мастер-плана:**
- Секция A: Исходная точка (что есть сейчас)
- Секция B: Документация и инструментация
- Секция C: Разделение ответственности (агент 🤖 / разработчик 🧑)
- Секция D: Development Cycle (полный цикл разработки)
- Секции E–K: Специальные темы (Privacy, Observability, Performance, Accessibility, Backup/DR)
- Блоки 0–8: Задачи по блокам (с чеклистами)

---

## 5. Development Cycle

**Полный цикл для каждой задачи:**

1. **Код**: Реализуй задачу (следуя стилю, соглашениям, тестируемости).
2. **Lint**: Запусти линтеры и форматтеры (Black, isort, Ruff, mypy для backend; Prettier, ESLint, tsc для frontend).
3. **Тесты**: Запусти все тесты (`pytest` / `pnpm test`).
4. **Анализ результатов**: 
   - Если тесты/линтеры красные → прочитай вывод, разбери ошибки, доработай код.
   - Повтори шаги 2–3 до зелёного.
5. **Коммит**: Только если всё зелёное (см. §6).

**Важно**: Результат тестов — это обратная связь. Красные тесты означают, что задача не завершена. Не коммить при красных тестах.

---

## 6. Commit Convention

**Язык**: Английский.

**Формат**: [Conventional Commits](https://www.conventionalcommits.org/) с номером задачи:

```
<type>(N.M): <description>

[optional body]
```

**Примеры:**
- `feat(0.2): init backend with FastAPI and health endpoint`
- `test(0.3): add PostgreSQL connection test`
- `docs(0.12): update README with quick start guide`
- `fix(1.5): handle missing birthdate in profile creation`

**Типы:**
- `feat`: новая функциональность
- `fix`: исправление бага
- `test`: добавление/исправление тестов
- `docs`: документация
- `refactor`: рефакторинг без изменения поведения
- `chore`: инфраструктурные изменения (зависимости, конфигурация)

### Pre-commit Contract (5 условий)

Коммит можно создавать только если:
1. ✅ Все тесты (backend + frontend) проходят.
2. ✅ Все линтеры (Black, isort, Ruff, mypy, ESLint, Prettier) проходят.
3. ✅ Type-check (mypy + tsc) проходит.
4. ✅ Lighthouse CI (если настроен) проходит.
5. ✅ axe-core (если настроен) проходит.

**Если хотя бы одно условие не выполнено — не коммитить.**

---

## 7. Branching & Push Strategy

- **Ветка разработки**: `staging` (или `dev`, см. настройки репо).
- **Ветка production**: `main`.

**Правила:**
1. Коммить локально после каждого логического шага (задача или подзадача).
2. Push в `staging` после завершения логической группы задач (например, задача 0.2 + тесты).
3. **Никогда не push напрямую в `main`.**
4. **Никогда не force push** (исключение: явный запрос разработчика).
5. Слияние `staging` → `main` делается через Pull Request / Merge Request (ручная проверка + CI).

---

## 8. Session Resumption

При возобновлении работы:
1. Прочитай последний коммит (`git log -1`).
2. Проверь состояние: `git status`, запусти тесты (`pytest` / `pnpm test`).
3. Прочитай мастер-план (`data/mvp_masterplan.md`), найди текущую задачу.
4. Продолжай с того места, где остановился.

---

## 9. Handoff Protocol

Если задача требует ручных действий (маркер 🧑 или 🤖→🧑 в мастер-плане):
1. **Обязательный коммит**: закоммить всё сделанное. Рабочее дерево должно быть чистым (`git status` — nothing to commit).
2. Push (если необходимо) в staging-ветку.
3. Останови выполнение.
4. Создай чеклист в коде или документации с описанием шагов для разработчика.
5. Сообщи разработчику: «Задача N.M требует ручных действий: [описание]».
6. После выполнения разработчиком — продолжай со следующей задачи.

---

## 10. Testing Requirements

Тесты — не формальность для Definition of Done, а **инструмент качества и обратной связи**.

### Ключевые принципы

1. **Тестировать поведение, а не реализацию**
   - Проверяй *что* делает код (входы → выходы), а не *как* он это делает
   - Это позволяет рефакторить без переписывания тестов

2. **Покрывать три категории сценариев:**
   - **Happy path**: основной сценарий работает корректно
   - **Edge cases**: граничные и нетипичные входы (пустое имя, Unicode, максимальная длина)
   - **Error paths**: ошибки обрабатываются gracefully (дубль email → 409, невалидный токен → 401, LLM timeout → fallback)

3. **Assertions должны быть содержательными**
   - Не просто статус 200, а структура данных, полнота, корректность

4. **Тесты изолированы друг от друга**
   - Каждый тест создаёт свои данные, не зависит от порядка выполнения

5. **Имя теста = спецификация**
   - ✅ `test_register_with_duplicate_email_returns_409`
   - ❌ `test_auth_1`

6. **Мокировать внешние зависимости, не внутреннюю логику**
   - Мокировать: LLM API, внешние HTTP-сервисы
   - Не мокировать: бизнес-логику, валидацию

### Обязательные проверки для API endpoints

- **Валидация**: невалидные данные → 422 с понятным сообщением
- **Авторизация**: без токена → 401, чужие данные → 403/404
- **Tenant isolation**: семья A не видит данных семьи B (обязательно для всех endpoints с child_id/family_id)

### Обязательные проверки для пайплайнов (LLM)

- **LLM parsing**: успешный парсинг JSON, graceful degradation при невалидном ответе
- **Fallback**: поведение при недоступности LLM (timeout, 500, rate limit)

### Backend (pytest)

- **Покрытие**: стремиться к ≥ 80%
- **Типы тестов**:
  - Unit: бизнес-логика в `services/`, утилиты
  - Integration: API endpoints (TestClient), база данных, Neo4j
  - Fixtures: `conftest.py` для переиспользуемых фикстур (db session, auth tokens, test data)

### Frontend (Vitest + React Testing Library)

- **Покрытие**: стремиться к ≥ 70%
- **Типы тестов**:
  - Component: рендеринг, пропсы, user interactions (RTL + user-event)
  - Hook: кастомные хуки (renderHook)
  - Integration: API mocks (msw), React Query

### E2E (Playwright, Блок 8)

- **Критические сценарии**: регистрация, вход, профили, навыки, дневник, рекомендации
- **Запуск**: перед production-деплоем

---

## 11. Observability & Error Recovery

Observability — не финальный штрих, а **инфраструктура с первого production-кода**.

### Error Tracking (Блок 0)

- **Инструмент**: Sentry SDK или GCP Error Reporting
- **Автоматический сбор**: stack trace, request context, environment, `trace_id`, `git_commit_sha`
- **PII-санитизация**: email → маска, пароли → удалены, тексты дневника → `[REDACTED]`

### Structured Logging (Блок 0)

- **Библиотека**: `structlog` (backend)
- **Формат**: JSON
- **Обязательные поля**: `trace_id`, `request_id`, `environment`, `timestamp`, `level`, `message`
- **Middleware**: автоматическая генерация `trace_id` для каждого входящего запроса
- **HTTP-ответы**: заголовок `X-Trace-Id` в каждом ответе

### Deep Health Checks (Блок 0)

- **Endpoint**: `GET /readyz` (readiness check)
- **Проверяет**: PostgreSQL, Neo4j, LLM API (опционально), background workers
- **Статусы**: `healthy`, `degraded`, `unhealthy`
- **Формат**: JSON с latency и статусом каждого компонента

### Distributed Tracing (Блок 1)

- **Инструмент**: OpenTelemetry → Google Cloud Trace
- **Обязательные спаны**: HTTP-запросы, SQL-запросы, Neo4j-запросы, LLM-вызовы, background tasks
- **trace_id**: сквозной идентификатор через все компоненты

### Structured Error Context для агента (Блок 2)

- При 5xx или unhandled exception формируется отчёт с полным контекстом
- Включает: stack trace, request (sanitized), dependency status, breadcrumbs, suggested investigation
- Скрипт `scripts/fetch_error_context.py` для передачи агенту

### Circuit Breaker (Блок 4)

- Для внешних зависимостей (LLM API)
- Автоматическое отключение при деградации, graceful degradation

### Retry Policy & Dead Letter Queue (Блок 4)

- **Max retries**: 3 с exponential backoff
- **Retry conditions**: LLM timeout, 429, 500, network error
- **Non-retryable**: 400, Pydantic validation error после JSON Repair
- **Dead Letter**: после 3 неудач → таблица `failed_extractions`

### LLM Observability (Блок 4)

- Latency, tokens (input/output), parse success rate, cost tracking
- Трейсинг промптов (без user content для PII)

### Runbook (Блок 2+)

- `/docs/operations.md` создаётся с Блока 2, расширяется в каждом блоке
- Типичные инциденты, откат деплоя, передача контекста агенту

### Error Handling

- **Backend**: централизованный error handler (FastAPI exception handler)
- **Frontend**: React Error Boundary + toast-уведомления
- **Логирование**: все ошибки с `trace_id`

---

## 12. Boundaries

**Агент не может делать:**
1. 🧑 Создавать ресурсы в GCP Console (Cloud SQL, Cloud Run, Artifact Registry)
2. 🧑 Настраивать CI/CD triggers (Cloud Build, GitHub Actions)
3. 🧑 Принимать Terms of Service (Neo4j Aura, OpenAI API)
4. 🧑 Вводить секреты (API keys, database passwords)
5. 🧑 Делать production-деплой (требует ручного промоушена)
6. 🧑 Визуальную верификацию UI (скриншоты, responsive design)

**Агент не должен менять без ревью:**
1. **Safety rules**: промпты для red flag detection, constitution, медицинские критерии
2. **DB migrations**: Alembic-миграции с необратимыми изменениями (DROP TABLE, ALTER COLUMN TYPE)
3. **Установочные документы**: Privacy Policy, Terms of Service (текст пишет разработчик)
4. **Критические бизнес-правила**: скоринг рекомендаций, критерии готовности навыков

**При встрече с такой задачей:**
- Останови выполнение
- Создай чеклист с инструкциями для разработчика
- Сообщи: «Задача N.M требует ручных действий» или «Требуется ревью разработчика»

---

## 13. AI Hints

### Эффективная работа с кодом

- **Читай перед изменением**: всегда используй `Read` перед редактированием файла
- **Инкрементальные изменения**: малые, атомарные коммиты
- **Тестируй сразу**: пиши тесты вместе с кодом (или сразу после)
- **Переиспользуй**: ищи существующие паттерны в коде (fixtures, утилиты, компоненты)

### Tenant Isolation (критически важно!)

**SQL запросы** — всегда включай проверку `family_id`:
```python
# ✅ Правильно
query = select(Child).where(
    Child.id == child_id,
    Child.family_id == current_family_id  # Обязательно!
)

# ❌ Неправильно (утечка данных между семьями)
query = select(Child).where(Child.id == child_id)
```

**Neo4j Cypher** — всегда фильтруй по `family_id`:
```cypher
// ✅ Правильно
MATCH (cs:ChildSkill {child_id: $child_id, family_id: $family_id})
RETURN cs

// ❌ Неправильно
MATCH (cs:ChildSkill {child_id: $child_id})
RETURN cs
```

**Все API endpoints** с child_id/diary_entry_id/recommendation_id должны проверять принадлежность к текущей семье.

### Structured Logging

Всегда логируй с контекстом:
```python
logger.info("skill_status_updated", 
    skill_id=skill_id, 
    child_id=child_id, 
    new_status=status,
    trace_id=trace_id
)
```

Не используй `print()` — только structured logging через `structlog`.

### Промпты LLM

- Промпты хранятся в `backend/src/prompts/` (отдельные файлы по типу: `signal_extraction.txt`, `red_flag_check.txt`)
- Версионирование промптов: при изменении промпта создавай новый файл (например, `signal_extraction_v2.txt`)
- При багах в LLM-выводе сначала проверь промпт, затем код парсинга

### Типичные ошибки

- ❌ Коммитить без запуска тестов
- ❌ Игнорировать вывод линтеров (читай и исправляй)
- ❌ Создавать временные файлы и забывать их удалить
- ❌ Хардкодить секреты (используй environment variables)
- ❌ Дублировать код (ищи существующие функции/компоненты)
- ❌ Забывать про tenant isolation (проверяй family_id!)

---

## 14. Privacy & Data Governance

TheyGrow хранит **персональные данные детей**. Privacy — не фича, а **предусловие запуска**.

### Критические правила

1. **Никогда не коммить секреты**
   - `.env`, `credentials.json`, API keys, database passwords
   - Если нашёл — остановись и предложи безопасный путь

2. **PII (Personally Identifiable Information)**
   - **Что является PII**: email, имя ребёнка, дата рождения, тексты дневника, медицинские наблюдения
   - **Хранение**: только в БД (с шифрованием)
   - **ЗАПРЕЩЕНО логировать**: email (маскировать `u***@example.com`), имена детей, тексты дневника (`[REDACTED]`)
   - **ЗАПРЕЩЕНО в GA4 events**: любые PII (только ID, метрики, категории)

3. **PII-санитизация в error tracking**
   - Email → маска
   - Пароли → полное удаление
   - Тексты дневника → `[REDACTED]`
   - Промпты LLM → без user content

4. **Consent (Блок 1)**
   - Родитель явно соглашается на обработку данных при регистрации
   - Ссылки на Privacy Policy и Terms of Service видны до регистрации
   - Согласие фиксируется в `consent_log`

5. **Data Export (Блок 1)**
   - `GET /api/v1/families/me/export`
   - JSON со всеми данными семьи: profiles, children, skills + statuses, diary entries, signal confirmations
   - Human-readable формат, без внутренних ID

6. **Data Deletion (Блок 1)**
   - `DELETE /api/v1/families/me`
   - **Каскадное удаление**: PostgreSQL (families, parents, children, diary_entries, signal_confirmations, qa_questions, reflections, recommendations) + Neo4j (все ChildSkill- и ParentSkill-ноды семьи)
   - **Governance log**: анонимизация (family_id → SHA-256 hash), не полное удаление — для аудита без привязки к личности
   - Удаление необратимо, пользователь предупреждается

### Правовые документы (Блок 1)

- **Privacy Policy**: `/privacy` (текст пишет разработчик 🧑, размещает агент 🤖)
- **Terms of Service**: `/terms` (явно: TheyGrow — не медицинское устройство, не диагноз, не замена врача)
- Пользователь видит ссылки на оба документа при регистрации

### Что проверять в коде

- ✅ Все SQL/Cypher-запросы с `family_id` (tenant isolation)
- ✅ Логи не содержат PII
- ✅ GA4 events не содержат PII (только event names + метрики)
- ✅ Error tracking санитизирован
- ✅ API для export и delete реализованы

**См. секцию G мастер-плана для полных деталей.**

---

## 15. Performance

**Бюджеты (обязательные):**

**Core Web Vitals:**
- LCP (Largest Contentful Paint) < 2.5s
- INP (Interaction to Next Paint) < 200ms
- CLS (Cumulative Layout Shift) < 0.1

**Bundle size:**
- Initial JS bundle < 200KB (gzipped)

**Lighthouse:**
- Performance score ≥ 90

**Тактические правила:**

1. **Dynamic import** для тяжёлых компонентов (граф, rich-text editor)
2. **Code splitting** по роутам (Next.js делает автоматически)
3. **Optimistic updates** для чекбоксов навыков, подтверждений сигналов
4. **Skeleton screens** вместо спиннеров
5. **next/image** для всех изображений (lazy loading)

**См. секцию I мастер-плана для деталей.**

---

## 16. Accessibility

**a11y-чеклист (для каждой UI-задачи):**

1. **Touch targets**: ≥44×44px для всех интерактивных элементов (кнопки, чекбоксы, ссылки)
2. **Contrast**: WCAG AA (4.5:1 для текста, 3:1 для UI-элементов)
3. **Семантический HTML**: используй правильные теги (`<button>`, `<nav>`, `<main>`, не `<div onclick>`)
4. **Keyboard navigation**: все интерактивные элементы доступны с клавиатуры (Tab, Enter, Space)
5. **ARIA**: добавляй ARIA-атрибуты где нужно (`aria-label`, `aria-expanded`, `role`)
6. **Focus visible**: отчётливые focus-индикаторы (не `outline: none` без замены)
7. **Информация не только цветом**: критические состояния (ошибки, успех) дублируются текстом/иконками
8. **Readable font**: ≥16px для основного текста

**axe-core в тестах (Блок 0):**

Интеграция в Vitest для автоматической проверки при рендере компонентов:

```typescript
import { axe } from 'vitest-axe';

test('HomePage has no a11y violations', async () => {
  const { container } = render(<HomePage />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});
```

**Важно**: a11y-чеклист — часть Definition of Done каждой UI-задачи. Блок не считается завершённым, пока компоненты не проходят axe-core без critical violations.

**См. секцию J мастер-плана для деталей.**

---

## Обновления

Этот файл обновляется при изменении структуры проекта, команд, процессов или появлении новых соглашений. Версия файла соответствует последнему выполненному блоку мастер-плана.

**Текущая версия**: Блок 0 (инициализация)

---

**Последнее обновление**: 2026-02-13
