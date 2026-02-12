# TheyGrow MVP — Мастер-план разработки

**Источник:** `data/TheyGrow-MVP-Blueprint.md`  
**Дата:** 11 февраля 2026

---

## Исходная точка: что реально есть сейчас

### Работающий продукт (в проде на Cloud Run)

Сейчас TheyGrow — это **монолитная статическая PWA** (~3000 строк `index.html`), развёрнутая на GCP Cloud Run через nginx. Приложение **уже используется** и имеет следующую функциональность:

**Трекер навыков (174 навыка, 256 связей, 6 категорий):**
- Таблица навыков по категориям (Крупная моторика, Мелкая моторика, Когнитивное развитие, Речь и коммуникация, Социально-эмоциональное развитие, Самообслуживание) и месяцам жизни (0–72).
- Чекбоксы для отметки освоенных навыков.
- Детальная модальная карточка навыка: описание, критерии оценки, пререквизиты (кликабельные ссылки на другие навыки), естественное освоение, потенциальные проблемы, активности для родителя, рекомендации по обращению к врачу.
- Навигация между навыками внутри модалки (история переходов).
- Фильтры: скрыть освоенные, показать только возрастные.
- Модальное окно «Активности» — сетка актуальных неосвоенных навыков.
- Мобильный аккордеон для категорий (складывание/раскрытие).
- Скрытие пустых категорий и месяцев при фильтрации.

**Профили детей:**
- Создание нескольких профилей (имя + дата рождения).
- Переключение между профилями (dropdown в хедере).
- Автоматический расчёт возраста (лет + месяцев) и текущего месяца жизни.
- Миграция данных из legacy-формата (старые ID → новые uppercase ID).
- Каждый профиль хранит свой набор `completedSkills`.

**PWA (работает):**
- `manifest.json` (name: TheyGrow, standalone, иконки 192/512).
- `sw.js` (Cache-First для статики, Network-First для API, офлайн-fallback).
- `offline.html` (автопроверка сети каждые 3 сек, автопереход при восстановлении).
- Install Prompt для Android/Desktop (`beforeinstallprompt` + кастомный баннер).
- Install Hint для iOS (с одноразовым dismiss через localStorage).

**Аналитика (GA4):**
- Measurement ID: `G-F5Q0JC691W`, debug-режим через `?dbg=1`.
- Трекаемые события: `skill_complete`, `profile_create`, `profile_click`, `filter_completed_toggle`, `filter_age_toggle`, `skill_view`, `activities_open`, `category_toggle`, `pwa_install_prompt_shown`, `pwa_install_accepted`, `pwa_ios_hint_shown`, `pwa_ios_hint_dismissed`.
- Кастомные dimensions: `ui_locale`, `app_version`.

**Onboarding:**
- Модальное окно для первого визита (dismissible, запоминается в localStorage `onboarding_dismissed`).

**Деплой (работает):**
- `Dockerfile`: nginx:alpine → копирует index.html + PWA-файлы → порт 8080.
- `nginx.conf`: gzip, кэширование статики (30 дней), SW без кэша, manifest 1 час, `/health` endpoint.
- `cloudbuild.yaml`: build → push в Artifact Registry (`europe-west1-docker.pkg.dev/ordinal-avatar-479419-t7/child-tracker-repo/web-app`) → deploy на Cloud Run (`child-tracker-service`, `europe-west1`).

**Данные навыков (встроены в index.html):**
- JSON-блоб внутри `<script>`: 174 навыка × {id, name, category, age_start_months, age_end_months, description, assessment_criteria, prerequisites[], source, additional_info: {natural_acquisition, potential_issues, parent_activities[], medical_consultation, additional_source[]}}.
- 256 рёбер (edges) — зависимости prerequisites.
- Функция `adaptNewDataFormat()` конвертирует в рабочую структуру `DATA`.

**Хранение (только localStorage):**

| Ключ | Тип | Содержимое |
|------|-----|------------|
| `childDevTracker_profiles` | Array | `[{id, name, birthdate, completedSkills: []}]` |
| `childDevTracker_currentProfile` | String | ID активного профиля |
| `childDevTracker_completed` | Array | Legacy-формат (мигрируется автоматически) |
| `milestones_accordion_states` | Object | Состояния аккордеона (open/closed) |
| `milestones_filter_completed` | Boolean | Фильтр «скрыть освоенные» |
| `milestones_filter_age` | Boolean | Фильтр «по возрасту» |
| `onboarding_dismissed` | Boolean | Онбординг закрыт |
| `iosInstallDismissed` | Boolean | iOS-подсказка закрыта |

### Чего НЕТ

- **Нет бэкенда** — вообще никакого серверного кода, никаких API.
- **Нет базы данных** — всё в localStorage, данные живут только на устройстве пользователя.
- **Нет аутентификации** — нет аккаунтов, нет синхронизации между устройствами.
- **Нет дневника** — только отметки чекбоксов «навык освоен», нет свободных текстовых записей.
- **Нет LLM-пайплайнов** — нет извлечения сигналов, нет AI-анализа.
- **Нет графовой БД** — навыки с зависимостями есть, но хранятся как JSON в HTML, нет Neo4j.
- **Нет рекомендаций** — есть «Активности» (список неосвоенных навыков), но нет персонализированных рекомендаций.
- **Нет рефлексий, нет графа родителя, нет Q&A, нет red flags, нет governance.**
- **Нет тестов** — ни одного юнит-теста, ни E2E.
- **Нет линтеров** — код не проверяется статически.
- **Нет AGENTS.md** — нет инструкций для AI-агентов.

### Файлы в репозитории

```
they_grow/                        ← Git root
├── .gitignore                    # Исключает /data/
├── README.md                     # Минимальный: "# TheyGrow"
├── Dockerfile                    # nginx:alpine, порт 8080
├── cloudbuild.yaml               # GCB → Artifact Registry → Cloud Run
├── nginx.conf                    # Gzip, кэширование, /health
├── index.html                    # ★ Весь продукт (~3000 строк HTML/CSS/JS)
├── manifest.json                 # PWA manifest
├── sw.js                         # Service Worker
├── offline.html                  # Офлайн-страница
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
└── data/                         ← НЕ в git (.gitignore)
    ├── child_development_milestones_FULL.json    # Полный датасет навыков
    ├── Граф навыки дополненный.json              # Расширенный граф
    ├── TheyGrow-MVP-Blueprint.md                 # Архитектурный блюпринт
    ├── План развития приложения с синергией функций.md
    ├── mvp_masterplan.md                         # Этот файл
    └── index.html.backup
```

---

## Целевое состояние (MVP по Blueprint)

FastAPI + Next.js 14 PWA + PostgreSQL + Neo4j + LLM — полный цикл ценности:

**Diary → Signal Extraction → Graph Updates → Recommendations → Reflection**

---

## Стратегия перехода

Переход от монолитной статической SPA к full-stack архитектуре происходит **инкрементально**:

1. **Текущее приложение остаётся доступным** на протяжении всего Блока 0. Пользователи не теряют доступ.
2. **Backend строится рядом** — новый стек (FastAPI + PostgreSQL + Neo4j) запускается параллельно.
3. **Frontend переписывается на Next.js**, при этом **всё существующее поведение** трекера навыков воспроизводится 1:1 (не «заново придумывается», а портируется).
4. **Переключение** на новый стек происходит после Блока 1, когда новая версия функционально не уступает текущей.
5. **Миграция данных** пользователей из localStorage: при первом входе в новую версию предлагается импорт существующих профилей и прогресса.

---

## Сквозные процессы (действуют во всех блоках)

### A. Staging-окружение: проверка перед продакшном

Любой деплой сначала попадает на staging, проверяется, и только потом идёт в production.

**Инфраструктура (создаётся в Блоке 0, используется с Блока 1):**

- **Staging Cloud Run service** — `child-tracker-service-staging` в том же GCP-проекте (`ordinal-avatar-479419-t7`, `europe-west1`), отдельный от production-сервиса `child-tracker-service`.
- **Staging Cloud SQL** — отдельная БД `theygrow_staging` на том же Cloud SQL instance (для экономии), изолированная от production-данных.
- **Staging Neo4j** — отдельный проект в Neo4j Aura (free tier позволяет два проекта), либо namespace-изоляция через `family_id` prefix.
- **URL**: staging доступен по отдельному URL (Cloud Run выдаёт уникальный URL для каждого сервиса), либо через custom domain `staging.theygrow.app`.
- **Доступ**: staging доступен только авторизованным пользователям (Cloud Run IAM, не `--allow-unauthenticated`).

**Процесс выкатки (с Блока 2, когда появляется production-деплой нового стека):**

1. **Коммит в main** → CI прогоняет тесты и линтеры.
2. **Автоматический деплой на staging** → Cloud Build собирает образ и деплоит на `child-tracker-service-staging`.
3. **Проверка на staging** → ручная проверка (smoke test основных flow) + автоматические E2E-тесты (когда появятся в Блоке 9).
4. **Промоушен в production** → явная команда (`gcloud run deploy child-tracker-service --image ...`) или отдельный шаг в Cloud Build, запускаемый вручную (manual approval).

**В `cloudbuild.yaml` это означает:**

- Шаг 1–2: build + push (как сейчас).
- Шаг 3: deploy на staging (автоматически).
- Шаг 4: deploy на production (запускается вручную или через отдельный trigger).

### B. Документирование: параллельно разработке

Документация — не отдельная фаза «потом допишем», а артефакт каждого блока. Каждый блок оставляет за собой актуальную документацию.

**Типы документации и где они живут:**

| Тип | Путь | Описание | Когда создаётся |
|-----|------|----------|-----------------|
| **AGENTS.md** | `/AGENTS.md` | Инструкции для AI-агентов: структура, команды, стиль, границы | Блок 0, обновляется в каждом блоке |
| **README.md** | `/README.md` | Описание проекта, быстрый старт, архитектура | Блок 0, расширяется в каждом блоке |
| **API-документация** | Auto-generated (FastAPI `/docs`) + `/docs/api/` | OpenAPI/Swagger (авто), дополнительные примеры и guides — вручную | С Блока 1, расширяется в каждом блоке при добавлении эндпоинтов |
| **ADR (Architecture Decision Records)** | `/docs/adr/` | Ключевые архитектурные решения: почему выбрали X, а не Y | С Блока 0, новые записи при ключевых решениях |
| **Схема данных** | `/docs/schema/` | ER-диаграмма PostgreSQL, граф-схема Neo4j (обновляемые) | С Блока 1, обновляется при каждой миграции |
| **Руководство по деплою** | `/docs/deployment.md` | Как развернуть локально, на staging, в production | Блок 0 (локально), Блок 2 (staging + production) |
| **Changelog** | `/CHANGELOG.md` | Что изменилось в каждом блоке (user-facing) | С Блока 1, обновляется при каждом блоке |

**Конкретные документационные задачи по блокам:**

| Блок | Документационные задачи |
|------|------------------------|
| 0 | Развернуть README.md (описание проекта, prerequisites, quick start). Создать AGENTS.md. Создать `/docs/adr/001-stack-choice.md`. Создать `/docs/deployment.md` (локальный запуск). |
| 1 | Обновить README (auth flow). Задокументировать API auth + skills (примеры в `/docs/api/`). ADR: `002-auth-jwt-strategy.md`, `003-neo4j-graph-model.md`. Схема данных: PG + Neo4j. Начать CHANGELOG. |
| 2 | Задокументировать Graph API, Cascade Predictions (`/docs/api/graph.md`). Обновить `/docs/deployment.md` (staging + production, Cloud SQL, Neo4j Aura). Обновить CHANGELOG. |
| 3 | Задокументировать Recommendation Pipeline, Recommendation API. ADR: `004-recommendation-scoring.md`. |
| 4 | Задокументировать Diary API, Signal Extraction Pipeline. ADR: `005-llm-provider-choice.md`, `006-offline-sync-strategy.md`. Обновить схему данных (diary_entries, signal_confirmations). |
| 5 | Задокументировать Reflection Pipeline + Parent Graph. Обновить CHANGELOG (full value loop). |
| 6 | Задокументировать Safety Pipeline, Constitution, Red Flags routing. ADR: `007-constitutional-ai-approach.md`. |
| 7 | Задокументировать Q&A flow + risk routing + **Q&A Signal Extraction Pipeline** (flow-диаграмма, промпты, типы сигналов, весовые коэффициенты). |
| 8 | Финальная ревизия всей документации. Обновить README до production-ready. Обновить AGENTS.md. |

**Правило: блок не считается завершённым (Definition of Done), пока документация блока не актуализирована.**

### C. Разделение ответственности: агент и разработчик

Мастер-план выполняется **AI-агентом** (Cursor Agent) под контролем **разработчика-архитектора**. Не все задачи агент может выполнить автономно — часть требует ручных действий в веб-интерфейсах, принятия решений или визуальной верификации.

**Соглашение по разметке задач:**

| Маркер | Исполнитель | Описание |
|--------|-------------|----------|
| (без маркера) | 🤖 Агент | Код, конфигурации, тесты, документация — агент выполняет автономно |
| 🧑 | Разработчик | Веб-интерфейсы (GCP Console, Neo4j Aura, GitHub Settings), ToS, credentials, ручные smoke tests, содержательные ревью |
| 🤖→🧑 | Агент готовит → разработчик исполняет | Агент создаёт артефакт (скрипт, gcloud-команду, чеклист для smoke test), разработчик проверяет и запускает |

**Что агент НЕ может делать:**

- Работать в веб-интерфейсах (GCP Console, Cloudflare Dashboard, Neo4j Aura Console, GitHub Settings).
- Принимать Terms of Service, вводить платёжные данные, включать GCP API.
- Создавать и управлять API-ключами сторонних сервисов (Anthropic, OpenAI).
- Настраивать DNS-записи и custom domains.
- Проводить ручной визуальный smoke test (проверка UX, вёрстки, взаимодействия).
- Создавать и настраивать Cloud Build triggers через GCP Console.
- Добавлять GitHub Secrets для CI/CD.

**Что агент МОЖЕТ, но лучше делать вручную (одноразовые инфраструктурные задачи):**

- Создание Cloud Run сервисов (через `gcloud` CLI агент может, но через Console — нагляднее).
- Настройка Cloud SQL инстансов (IAM, networking, connection — Console надёжнее).
- Создание проектов в Neo4j Aura (только через веб-интерфейс).

**Протокол передачи инициативы:**

1. Агент доходит до задачи с маркером 🧑 или 🤖→🧑.
2. Агент **останавливается** и выдаёт чёткие инструкции: что именно нужно сделать, где, какие значения ввести, какие результаты ожидаются.
3. Для 🤖→🧑: агент создаёт артефакт (файл конфигурации, gcloud-команду, чеклист) и просит разработчика проверить и выполнить.
4. Разработчик выполняет, подтверждает завершение (и сообщает результаты: URL, credentials и т.п.).
5. Агент продолжает выполнение следующих задач.

**В каждом блоке** есть секция «🧑 Задачи разработчика в этом блоке», чтобы можно было спланировать ручные действия заранее.

### D. Git-процесс: коммиты, пуши, цикл разработки

Каждый шаг мастер-плана (N.M) — это атомарная единица работы, которая завершается коммитом. Это обеспечивает точки отката, верифицируемость и возможность возобновления при смене сессии агента.

**Цикл разработки одного шага:**

```
┌─────────────────────────────────────────────────────────────────┐
│  1. Написать код (реализация задачи N.M)                        │
│  2. Написать тесты (если задача включает тесты)                 │
│  3. Прогнать lint + typecheck:                                  │
│     - Backend: ruff check + mypy                                │
│     - Frontend: eslint + tsc --noEmit                           │
│     → Если ошибки — исправить, вернуться к п.3                  │
│  4. Прогнать тесты:                                             │
│     - Backend: pytest (затронутые модули)                        │
│     - Frontend: vitest (затронутые модули)                       │
│     → Если тесты падают — ПРОАНАЛИЗИРОВАТЬ ВЫВОД тестов,        │
│       понять причину, доработать код/тесты, вернуться к п.3     │
│  5. Commit (только при зелёных тестах и чистых линтерах)        │
│  6. Повторить для следующего шага                                │
└─────────────────────────────────────────────────────────────────┘
```

**Важно**: на шаге 4, если тесты падают, агент **не игнорирует** провалы и **не переходит** к следующей задаче. Результат тестов — это обратная связь, которая направляет доработку. Агент анализирует вывод тестов, определяет причину (баг в коде, некорректный тест, недостающая зависимость) и исправляет до достижения зелёного состояния.

**Формат коммитов:**

Язык: **английский**. Формат: Conventional Commits с номером задачи из мастер-плана.

```
feat(0.2): init FastAPI backend with healthz endpoint
feat(1.3): implement auth endpoints (register, login, families/me)
test(1.3): add auth endpoint tests (register, login, token, tenant isolation)
feat(2.11): configure Cloud SQL production connection
fix(1.8): correct Neo4j query for skill status update
docs(1.23): add auth API documentation and ADR-002
refactor(4.5): extract signal processing into separate worker module
```

Типы: `feat` (новая функциональность), `test` (тесты), `fix` (исправление), `refactor` (рефакторинг без изменения поведения), `docs` (документация), `chore` (конфигурации, зависимости).

**Стратегия ветвления и пушей:**

- Рабочая ветка: `dev` (или `feature/block-N` для каждого блока — на усмотрение разработчика).
- **Коммит** — после каждого шага (N.M), локально.
- **Push в staging-ветку** — после завершения логической группы задач (подсекция блока или весь блок). Push идёт в staging, **не в main/production**.
- **Мерж в main** — только после прохождения CI на staging-ветке и ручной проверки разработчиком.
- Агент **никогда** не пушит напрямую в main и не выполняет force push.

```
dev (рабочая) ──commit──commit──commit──► push ──► staging ──► [CI + smoke test] ──► merge to main
                 0.1      0.2      0.3           (разработчик проверяет)    (разработчик мержит)
```

**Pre-commit contract — агент НЕ коммитит, если:**

- Тесты не проходят (pytest / vitest).
- Линтеры не чистые (ruff + mypy / eslint + tsc).
- Есть незакоммиченные изменения в файлах, не относящихся к текущей задаче.
- Commit message не содержит номер задачи из мастер-плана.
- Commit message написан не на английском.

**Обязательный коммит перед передачей инициативы:**

Перед задачей с маркером 🧑 или 🤖→🧑 агент обязан закоммитить (и при необходимости запушить) всё, что сделал. Рабочее дерево должно быть чистым (`git status` — nothing to commit) перед передачей.

**Протокол возобновления сессии:**

При начале новой сессии (или после длительной паузы) агент обязан:

1. `git log --oneline -15` — понять, какие задачи уже выполнены.
2. `git status` + `git diff` — убедиться, что рабочее дерево чистое (нет незакоммиченных изменений).
3. Прочитать мастер-план — определить следующую незавершённую задачу.
4. Прогнать тесты + линтеры — убедиться, что текущее состояние здоровое.
5. Только после этого — продолжить работу.

### E. Требования к тестам

Тесты — не формальность для выполнения Definition of Done, а **инструмент качества и обратной связи**. Плохие тесты (проверяющие только что «функция не падает») хуже отсутствия тестов: они создают ложную уверенность.

**Принципы написания тестов:**

**1. Тестировать поведение, а не реализацию.**
Тест должен проверять *что* делает код (входы → выходы, побочные эффекты), а не *как* он это делает (внутренние вызовы, порядок операций). Это позволяет рефакторить код без переписывания тестов.

```python
# ❌ Плохо: тестирует реализацию
def test_register_calls_create_family():
    with patch('src.db.families.create_family') as mock:
        register(...)
        mock.assert_called_once()

# ✅ Хорошо: тестирует поведение
def test_register_creates_family_and_returns_token():
    response = client.post("/api/v1/auth/register", json={...})
    assert response.status_code == 201
    assert "access_token" in response.json()
    # Проверяем, что семья действительно создана
    family = db.query(Family).filter_by(email=...).first()
    assert family is not None
```

**2. Покрывать три категории сценариев:**

| Категория | Что проверяем | Пример |
|-----------|--------------|--------|
| **Happy path** | Основной сценарий работает корректно | Регистрация с валидными данными → 201, токен, семья создана |
| **Edge cases** | Граничные и нетипичные входы | Пустое имя, дата рождения в будущем, Unicode-символы, максимальная длина текста |
| **Error paths** | Ошибки обрабатываются gracefully | Дубль email → 409, невалидный токен → 401, несуществующий child_id → 404, LLM timeout → fallback |

**3. Assertions должны быть содержательными.**

```python
# ❌ Плохо: проверяет только статус
def test_get_skills():
    response = client.get(f"/api/v1/children/{child_id}/skills")
    assert response.status_code == 200

# ✅ Хорошо: проверяет структуру, содержание, полноту
def test_get_skills_returns_all_domain_skills():
    response = client.get(f"/api/v1/children/{child_id}/skills?domain=fine_motor")
    assert response.status_code == 200
    skills = response.json()
    assert len(skills) > 0
    assert all(s["domain"] == "fine_motor" for s in skills)
    assert all({"skill_id", "canonical_name", "status", "readiness"} <= set(s.keys()) for s in skills)
    # Проверяем, что навыки принадлежат именно этому ребёнку (tenant isolation)
    assert all(s["child_id"] == str(child_id) for s in skills) if "child_id" in skills[0] else True
```

**4. Тесты изолированы друг от друга.**
Каждый тест создаёт свои данные и не зависит от порядка выполнения или побочных эффектов других тестов. Использовать fixtures/factories для создания тестовых данных.

**5. Имя теста = спецификация.**
Из имени теста должно быть понятно, *что* проверяется и *какой* ожидаемый результат:

```python
# ❌ Плохо
def test_diary():
def test_auth_1():

# ✅ Хорошо
def test_diary_entry_creation_triggers_async_extraction():
def test_register_with_duplicate_email_returns_409():
def test_signal_confirmation_updates_neo4j_readiness():
def test_offline_draft_syncs_when_online():
```

**6. Мокировать внешние зависимости, не внутреннюю логику.**
Мокировать: LLM API, Neo4j (в юнит-тестах), внешние HTTP-сервисы. Не мокировать: бизнес-логику, валидацию, трансформации данных.

**7. Для API-эндпоинтов — обязательно проверять:**

- Валидацию входных данных (невалидные → 422 с понятным сообщением).
- Авторизацию (без токена → 401, чужие данные → 403 или 404).
- Tenant isolation (семья A не видит данных семьи B).
- Идемпотентность (повторный запрос не создаёт дубликат, где это применимо).

**8. Для пайплайнов (signal extraction, recommendations) — обязательно проверять:**

- Корректный парсинг ответа LLM (валидный JSON → правильная Pydantic-модель).
- Обработку невалидного ответа (битый JSON → JSON Repair → повторная валидация).
- Обработку таймаутов и ошибок LLM (graceful degradation).
- Корректность обновления графа (Neo4j) по результатам пайплайна.

**9. Для фронтенда — тестировать взаимодействие, не рендеринг.**

```typescript
// ❌ Плохо: тестирует только что компонент рендерится
test('renders diary page', () => {
  render(<DiaryPage />);
  expect(screen.getByText('Дневник')).toBeInTheDocument();
});

// ✅ Хорошо: тестирует пользовательский сценарий
test('submitting diary entry shows pending extraction status', async () => {
  render(<DiaryPage />);
  await userEvent.click(screen.getByText('Мелкая моторика'));
  await userEvent.type(screen.getByRole('textbox'), 'Взял чириос двумя пальцами');
  await userEvent.click(screen.getByText('Сохранить'));
  expect(screen.getByText('Анализируем...')).toBeInTheDocument();
});
```

**10. Тесты — первый потребитель API.**
Если тест сложно написать — вероятно, API плохо спроектирован. Сложность теста — сигнал для рефакторинга кода, а не повод писать плохой тест.

### F. Observability & Error Recovery: поддержка работоспособности за пределами тестов

Тесты покрывают предсказуемые сценарии до деплоя. В production возникают ситуации, которые тесты не ловят: data-dependent баги, деградация внешних зависимостей (LLM API, Neo4j, PostgreSQL), edge cases на реальных данных, проблемы конкурентного доступа, сетевые таймауты. Для этих случаев нужна **наблюдаемость** (observability) — способность понять, что произошло, по внешним признакам системы, и **механизм передачи контекста ошибки** агенту для исправления.

**Принцип**: observability — не финальный штрих (не «потом в Блоке 8 настроим»), а **инфраструктура с первого продакшн-кода**. Мониторинг, который появляется после инцидента, бесполезен для предотвращения инцидента.

#### F.1. Error Tracking (с Блока 0)

Каждая необработанная ошибка в production должна автоматически попадать в систему отслеживания с полным контекстом. Инструмент: **Sentry** (self-hosted или cloud, free tier достаточен для MVP) или **Google Cloud Error Reporting** (встроен в GCP, бесплатен).

**Что собирается автоматически при ошибке:**

| Поле | Описание | Зачем агенту |
|------|----------|-------------|
| `error_id` | Уникальный идентификатор | Точная ссылка на инцидент |
| `timestamp` + `environment` | Когда и где (staging/prod) | Корреляция с деплоями |
| `endpoint` + `method` + `status_code` | Какой запрос упал | Локализация проблемы |
| `stack_trace` | Полный стектрейс с файлами и строками | Точка входа для исправления |
| `request_payload` (sanitized) | Входные данные (без PII: email → `***@***.com`, пароли → удалены) | Воспроизведение бага |
| `dependency_status` | Состояние PG / Neo4j / LLM API в момент ошибки | Отличить баг в коде от проблемы инфраструктуры |
| `trace_id` | Сквозной идентификатор запроса | Корреляция логов и спанов |
| `git_commit_sha` | Версия кода | Привязка к конкретному коммиту |
| `breadcrumbs` | Последние N действий до ошибки (логи, HTTP-вызовы, DB-запросы) | Контекст «что произошло перед падением» |

**Правило PII-санитизации**: перед отправкой в error tracker все поля с PII (email, имена детей, тексты дневника) заменяются на хэши или маски. Промпты LLM логируются без user content.

#### F.2. Distributed Tracing (с Блока 1)

Когда запрос проходит через FastAPI → PostgreSQL → Neo4j → LLM API, нужно видеть **единую цепочку** (trace) с временными метками каждого шага (span). Инструмент: **OpenTelemetry** → экспорт в **Google Cloud Trace** (бесплатен в рамках GCP).

**Обязательные спаны:**

- HTTP-запрос (входящий) — метод, URL, статус, длительность.
- SQL-запрос — таблица, операция (SELECT/INSERT/UPDATE), длительность, количество строк.
- Neo4j-запрос — тип запроса (read/write), длительность, количество нод/связей.
- LLM-вызов — провайдер, модель, длительность, токены (input/output), стоимость.
- Background task — тип (signal_extraction, red_flag_check), статус, длительность.

**Каждый HTTP-ответ** содержит заголовок `X-Trace-Id`, чтобы пользователь (или QA) мог сообщить trace ID при баг-репорте.

#### F.3. Deep Health Checks (с Блока 0)

Помимо `GET /healthz` (liveness), реализовать `GET /readyz` (readiness) — проверка всех зависимостей:

```json
// GET /readyz → 200 (всё ок) или 503 (что-то не так)
{
  "status": "degraded",
  "checks": {
    "postgresql": {"status": "healthy", "latency_ms": 3},
    "neo4j": {"status": "healthy", "latency_ms": 12},
    "llm_api": {"status": "unhealthy", "error": "timeout after 5000ms"},
    "background_workers": {"status": "healthy", "pending_tasks": 2, "failed_tasks": 0}
  },
  "version": "0.2.0",
  "commit": "a1b2c3d"
}
```

**Статусы**: `healthy` (всё ок), `degraded` (работает, но с ограничениями — например, LLM недоступен, дневник принимает записи, но extraction не работает), `unhealthy` (критический компонент недоступен).

Cloud Run использует `/readyz` для traffic routing: unhealthy-инстансы не получают трафик.

#### F.4. Structured Error Context для агента

При возникновении ошибки в production (5xx или unhandled exception) система автоматически формирует **структурированный отчёт**, пригодный для передачи AI-агенту:

```
Error Report #{error_id}
─────────────────────────
Environment: production
Timestamp:   2026-03-15T14:23:01Z
Commit:      feat(4.5): extract signal processing (a1b2c3d)
Trace ID:    abc-123-def-456

Endpoint:    POST /api/v1/diary/entries
Status:      500 Internal Server Error

Stack Trace:
  File "src/pipelines/signal_extraction.py", line 87, in extract_signals
    parsed = SignalExtraction.model_validate_json(llm_response)
  pydantic.ValidationError: 1 validation error for SignalExtraction
    signals -> 0 -> skill_id: field required

Request (sanitized):
  {"child_id": "uuid-***", "domain": "fine_motor", "raw_text": "[redacted, 47 chars]"}

Dependency Status:
  PostgreSQL: healthy (3ms)
  Neo4j: healthy (12ms)
  LLM API: healthy (responded in 2341ms)

Breadcrumbs (last 5):
  14:23:00.100  DB   SELECT diary_entry ... → 1 row
  14:23:00.150  Neo4j  MATCH (s:ChildSkill {child_id: $cid, domain: $d}) → 28 nodes
  14:23:00.200  LLM  POST anthropic/messages → 200 (2341ms, 1200 tokens)
  14:23:00.550  Parse  JSON parse → ok
  14:23:00.560  Validate  Pydantic validate → FAILED

Suggested Investigation:
  LLM returned valid JSON but missing 'skill_id' in first signal.
  Check prompt version and LLM response format compliance.
```

Этот отчёт:
- Автоматически сохраняется в Cloud Logging с лейблом `severity=ERROR`, `type=error_report`.
- Доступен через команду `python -m scripts.fetch_error_context <error_id>` (скрипт в репозитории).
- Формат оптимизирован для вставки в контекст AI-агента (plain text, не JSON).

#### F.5. Circuit Breaker для внешних зависимостей (с Блока 4)

Внешние зависимости (LLM API, Neo4j) могут деградировать: отвечать медленно, возвращать ошибки, быть полностью недоступными. **Circuit breaker** предотвращает каскадные отказы:

| Состояние | Условие входа | Поведение |
|-----------|--------------|-----------|
| **Closed** (нормальная работа) | — | Все запросы проходят |
| **Open** (отказ) | N ошибок за M секунд (напр. 5 за 60с) | Запросы не отправляются, сразу fallback |
| **Half-open** (проверка) | Через T секунд (напр. 30с) после Open | 1 пробный запрос; успех → Closed, ошибка → Open |

**Fallback-стратегии:**

| Зависимость | Fallback при Open |
|-------------|------------------|
| LLM API | Запись дневника сохраняется, extraction откладывается (`status='pending'`), batch-retry при восстановлении |
| Neo4j (read) | Кэшированные данные (последний snapshot графа ребёнка) или degraded UI (без графа, только таблица навыков) |
| Neo4j (write) | Операция записывается в PostgreSQL-очередь (`pending_graph_updates`), применяется при восстановлении |
| PostgreSQL | Service unavailable (503) — здесь fallback невозможен, это primary storage |

#### F.6. LLM Observability (с Блока 4)

LLM-вызовы — самый непредсказуемый компонент: модели обновляются провайдером, качество может измениться без изменений в коде. Специальный мониторинг:

| Метрика | Что отслеживаем | Алерт |
|---------|----------------|-------|
| **Latency p50/p95/p99** | Время ответа LLM по типу запроса (signal extraction, red flag, Q&A) | p95 > 20s |
| **Token usage** | Input/output tokens per request, стоимость | Daily cost > бюджет × 1.5 |
| **Parse success rate** | % ответов, прошедших JSON parse + Pydantic validation | < 90% за час |
| **Extraction quality** | % сигналов, подтверждённых родителем (confirmed / total) | < 60% за неделю (деградация модели) |
| **Error rate by type** | Таймауты, 429 (rate limit), 500, невалидный JSON | > 5% за 10 минут |

**Prompt/response logging**: каждый LLM-вызов логируется (prompt template version, sanitized input, raw response, parsed output, validation result). Хранение: Cloud Logging, retention 30 дней. PII в user content заменяется на `[REDACTED]`.

#### F.7. Retry Policy и Dead Letter Queue (с Блока 4)

Для асинхронных пайплайнов (signal extraction, red flag detection, Q&A extraction):

| Параметр | Значение |
|----------|----------|
| **Max retries** | 3 |
| **Backoff** | Exponential: 30s → 2min → 10min |
| **Retry conditions** | LLM timeout, 429 (rate limit), 500, network error |
| **Non-retryable** | 400 (bad request), Pydantic validation error после JSON Repair, неизвестный skill_id |
| **Dead Letter** | После 3 неудачных попыток → `extraction_status='failed'`, запись в таблицу `failed_extractions` с полным контекстом (entry_id, error, attempt_count, last_error_at) |
| **Алерт** | > 5 failed extractions за час → уведомление |
| **Ручной retry** | Admin API: `POST /api/v1/admin/retry-extraction/{entry_id}` — сброс статуса, повторная обработка |

#### F.8. Runbook (с Блока 2, расширяется в каждом блоке)

`/docs/operations.md` создаётся не в Блоке 8, а **с момента появления production** (Блок 2) и расширяется при добавлении новых компонентов.

**Структура runbook:**

```
## 1. Проверка здоровья системы
   GET /readyz — интерпретация статусов

## 2. Типичные инциденты
   ### PostgreSQL недоступен
   ### Neo4j недоступен
   ### LLM API: таймауты / 429 / деградация качества
   ### Высокий error rate после деплоя
   ### Failed extractions накапливаются

## 3. Откат деплоя
   gcloud run services update-traffic ... --to-revisions=REVISION=100

## 4. Передача контекста ошибки агенту
   python -m scripts.fetch_error_context <error_id>
   Формат вывода, что передать в промпт

## 5. Batch-операции
   Retry failed extractions
   Пересчёт графа ребёнка
   Очистка dead letter queue
```

**Обновление**: блок не считается завершённым, пока runbook не дополнен новыми компонентами блока.

#### Распределение задач по блокам

| Блок | Задачи observability |
|------|---------------------|
| **0** | Error tracking (Sentry SDK / GCP Error Reporting). Deep health check (`/readyz`). Базовый structured logging (structlog + trace_id). |
| **1** | Distributed tracing (OpenTelemetry → Cloud Trace). `X-Trace-Id` в HTTP-ответах. Трейсинг SQL и Neo4j-запросов. |
| **2** | Structured Error Context (middleware + скрипт `fetch_error_context`). Начальный runbook (`/docs/operations.md`). Production alerting: error rate, latency p95, `/readyz` failures. |
| **4** | Circuit breaker для LLM API. LLM observability (latency, tokens, parse success, quality). Retry policy + dead letter queue для extraction pipeline. |
| **7** | Расширить circuit breaker и retry policy на Q&A extraction pipeline. |
| **8** | Финальная ревизия observability: полнота метрик, алертов, runbook. Canary deployment (опционально). |

### G. Privacy, Legal & Data Governance

TheyGrow хранит **персональные данные детей** (имена, даты рождения, записи о развитии, медицинские сигналы). Это налагает юридические и этические обязательства, которые должны быть выполнены **до допуска реальных пользователей с аккаунтами** (т.е. до завершения Блока 1).

**Принцип**: privacy — не фича, а **предусловие запуска**. Блок 1 не считается завершённым без реализации прав пользователя и размещения правовых документов.

#### G.1. Правовые документы (до регистрации первого пользователя)

| Документ | Содержание | Когда | Исполнитель |
|----------|-----------|-------|-------------|
| **Privacy Policy** | Какие данные собираются, зачем, как хранятся, кому передаются (LLM API), права пользователя (удаление, экспорт), контакт | Блок 1 | 🧑 Разработчик (текст) → 🤖 Агент (размещение на `/privacy`) |
| **Terms of Service / Disclaimer** | Условия использования. **Явно**: TheyGrow — не медицинское устройство, не диагноз, не замена консультации специалиста. Ограничение ответственности | Блок 1 | 🧑 Разработчик (текст) → 🤖 Агент (размещение на `/terms`) |

Пользователь видит ссылки на оба документа **до регистрации** (на странице `/register`). При регистрации фиксируется согласие в `consent_log`.

#### G.2. Права пользователя

| Право | API | Поведение | Блок |
|-------|-----|-----------|------|
| **Удаление данных** | `DELETE /api/v1/families/me` | Каскадное удаление: PG (families, parents, children, diary_entries, signal_confirmations, qa_questions, reflections, recommendations) + Neo4j (все ChildSkill- и ParentSkill-ноды семьи). Governance log: **анонимизация** (family_id → SHA-256 hash), не удаление — для аудита без привязки к личности | 1 |
| **Экспорт данных** | `GET /api/v1/families/me/export` | JSON со всеми данными семьи: profiles, children, skills + statuses, diary entries, signal confirmations. Без внутренних ID — human-readable | 1 |

#### G.3. Политика хранения данных (Retention Policy)

| Класс данных | Срок хранения | Действие по истечении | Реализация |
|-------------|---------------|----------------------|------------|
| Профили, навыки, дневник | Пока аккаунт активен + 90 дней после удаления | Каскадное удаление | `DELETE /api/v1/families/me` |
| LLM prompt/response logs | 30 дней | Автоудаление | Cleanup cron (Cloud Scheduler) |
| Failed extractions | 90 дней | Автоудаление | Cleanup cron |
| Governance log | Бессрочно (анонимизированный) | — | Хранится с hashed family_id |
| GA4 данные | Определяется GA4 (14 мес по умолчанию) | — | Настройка в GA4 Console |

Cleanup cron создаётся в Блоке 4 (когда появляются LLM logs) — задача для Cloud Scheduler (🧑).

#### G.4. Third-party Processing Disclosure

При регистрации пользователь информируется: «Тексты дневника и вопросов обрабатываются с помощью AI (внешний LLM-провайдер) для извлечения сигналов о развитии ребёнка. Тексты передаются в обезличенном виде.»

Согласие фиксируется в `consent_log` как отдельная запись (`consent_type: 'llm_processing'`).

#### G.5. PII Threat Model

| Точка утечки | Контрмера | Где реализовано |
|-------------|-----------|-----------------|
| **Error tracking** (Sentry / GCP Error Reporting) | PII-санитизация: email → маска, имена → `[REDACTED]`, тексты дневника → `[REDACTED]` | Секция F.1 (Блок 0) |
| **Structured logs** (Cloud Logging) | Никаких PII в log fields. `raw_text` не логируется. Только `entry_id`, `child_id`, `domain` | Секция F (Блок 0) |
| **LLM API** | Тексты передаются, но промпты содержат инструкцию не хранить. В логах LLM-вызовов user content заменяется на `[REDACTED]` | Секция F.6 (Блок 4) |
| **GA4** | **Запрет PII** в event parameters: никаких имён, email, текстов. Только численные/категориальные dimensions | Секция H (Блок 1) |
| **Backups** | Бэкапы Cloud SQL шифруются at rest (Google-managed keys). Neo4j Aura dumps — в private GCS bucket с IAM | Секция K (Блок 2) |

#### Распределение задач privacy по блокам

| Блок | Задачи privacy |
|------|---------------|
| **0** | PII-санитизация в error tracking и логах (уже в F.1). |
| **1** | Privacy Policy + ToS (🧑). DELETE + Export API. Consent log расширен (LLM processing). Запрет PII в GA4. UI: страница настроек с кнопками удаления/экспорта. |
| **4** | Third-party disclosure consent (при первом LLM-вызове, если не было при регистрации). Retention cleanup cron для LLM logs. |
| **8** | Финальная ревизия: все права реализованы, все точки утечки закрыты, документы актуальны. |

### H. Product Measurement Plan

Аналитика — не «перенести GA4-события», а **инструмент принятия продуктовых решений**. Без формальных метрик невозможно понять, работает ли продукт, где пользователи «отваливаются», и какие фичи создают ценность.

#### H.1. North Star Metric

**Количество семей с ≥1 подтверждённым сигналом в неделю** — показывает, что full value loop (дневник → extraction → подтверждение → граф) работает и используется.

#### H.2. KPI

| KPI | Определение | Цель (MVP) |
|-----|------------|------------|
| **Activation rate** | % зарегистрировавшихся, отметивших ≥5 навыков в первую сессию | ≥ 60% |
| **D1 / D7 / D30 retention** | % семей, вернувшихся на день 1 / 7 / 30 | D1 ≥ 40%, D7 ≥ 25%, D30 ≥ 15% |
| **Time-to-value** | Время от регистрации до первого `signal_confirm` | < 5 минут (для дневника — Блок 4) |
| **Weekly engagement** | Diary entries + signal confirmations per active family per week | ≥ 2 entries/week |
| **LLM cost per family per day** | Средняя стоимость LLM-вызовов на одну активную семью в день | ≤ $0.05 |

#### H.3. Формальная воронка

```
Registration → First Skill Marked → First Diary Entry → First Signal Confirmed →
→ First Recommendation Accepted → First Reflection → Weekly Active User
```

Каждый шаг воронки — отдельное GA4-событие. Дашборд визуализирует конверсию между шагами.

#### H.4. GA4-события по блокам

| Блок | Новые события |
|------|-------------|
| **1** | `account_delete_request`, `data_export_request`, `onboarding_step_{1..N}`, `onboarding_complete`, `activation_achieved` |
| **2** | `graph_view`, `graph_node_click`, `prediction_view` |
| **3** | `recommendation_view`, `recommendation_accept`, `recommendation_complete`, `recommendation_skip` |
| **4** | `diary_entry_create`, `signal_confirm`, `signal_correct`, `signal_reject` |
| **5** | `reflection_submit`, `parent_graph_view` |
| **7** | `qa_question_submit`, `qa_answer_viewed`, `qa_signal_confirm` |

**Правило**: каждая задача, добавляющая пользовательское действие, включает соответствующее GA4-событие. Агент добавляет `trackEvent()` вызов в том же PR, что и фича.

#### H.5. Custom Dimensions (без PII)

| Dimension | Тип | Описание |
|-----------|-----|----------|
| `child_age_months` | Number | Возраст активного ребёнка в месяцах |
| `completed_skills_count` | Number | Количество освоенных навыков |
| `diary_entries_count` | Number | Количество записей в дневнике |
| `active_feature_set` | String | Используемые фичи: `tracker_only`, `tracker+diary`, `full_loop` |
| `days_since_registration` | Number | Дней с момента регистрации |

**Жёсткий запрет**: никаких имён, email, текстов дневника, дат рождения в GA4-событиях или dimensions.

#### H.6. Аналитическая инфраструктура (Блок 8)

- **GA4 → BigQuery export**: для сложных запросов (retention cohorts, funnel analysis по сегментам).
- **5 стандартных дашбордов** (Looker Studio):
  1. Activation funnel (регистрация → activation).
  2. Retention cohorts (D1/D7/D30).
  3. Feature adoption (% семей, использующих каждую фичу).
  4. LLM quality (extraction confidence, confirmation rate).
  5. LLM cost (daily total, per family, per extraction type).

#### H.7. Обратная связь от пользователей

GA4 показывает *что* делают пользователи, но не *почему* уходят или *чего* не хватает.

| Инструмент | Описание | Когда |
|-----------|----------|-------|
| **In-app feedback** | Кнопка «Сообщить о проблеме / предложить идею» в профиле. Авто-прикрепление `X-Trace-Id`, app version, `child_age_months` (без PII). Отправка в Telegram-бот или email | Блок 2 |
| **NPS micro-survey** | 1 вопрос, dismissible, для активных семей (≥7 дней, ≥3 diary entries). Не чаще раза в месяц | Блок 8 |
| **User interviews** | 🧑 3–5 интервью с ранними пользователями после production switch | Блок 2 (🧑) |

### I. Performance Budget & Core Web Vitals

Текущее приложение — ~3000 строк HTML, загружается моментально. Переход на Next.js + React + графовые библиотеки создаёт риск регрессии производительности. Performance budget — защита от этого.

**Принцип**: новая версия **не должна быть медленнее** текущей PWA. Регрессия производительности = failing build.

#### I.1. Бюджеты

| Метрика | Цель | Измерение |
|---------|------|-----------|
| **LCP** (Largest Contentful Paint) | < 2.5s (mobile 4G) | Lighthouse CI |
| **INP** (Interaction to Next Paint) | < 200ms | Lighthouse CI |
| **CLS** (Cumulative Layout Shift) | < 0.1 | Lighthouse CI |
| **JS bundle** (initial load) | < 200KB gzipped | `next build` output |
| **Lighthouse Performance score** | ≥ 90 (mobile) | Lighthouse CI |

#### I.2. Lighthouse CI в CI Pipeline (Блок 0)

Добавить в CI (рядом с линтерами и тестами): `@lhci/cli` прогон на каждый push. Бюджеты как assertion — при нарушении build fails.

Конфигурация: mobile profile, throttled 4G, стартовая страница (Блок 0), расширять URL-ы по мере появления страниц.

#### I.3. Тактические правила (для AGENTS.md)

Агент обязан соблюдать при написании фронтенд-кода:

1. **Dynamic import** для тяжёлых компонентов: граф (`react-force-graph`), модалки, rich-text editors. `next/dynamic` с `{ ssr: false }` где применимо.
2. **Code splitting** по роутам — Next.js App Router делает это автоматически, но агент не должен импортировать тяжёлые зависимости в layout/shared компонентах.
3. **Optimistic updates** на чекбоксах навыков и подтверждениях сигналов — UI реагирует мгновенно, API-запрос в фоне. При ошибке — откат с уведомлением.
4. **Skeleton screens** для асинхронных данных (навыки, граф, рекомендации, дневник). Не spinner, а layout-placeholder.
5. **next/image** для всех изображений (иконки, аватары). Lazy loading по умолчанию.

#### Распределение задач performance по блокам

| Блок | Задачи performance |
|------|-------------------|
| **0** | Lighthouse CI в CI pipeline. Bundle size check в `next build`. |
| **1** | Optimistic updates на чекбоксах навыков. Skeleton screens для таблицы навыков и модалок. |
| **2** | Dynamic import для графовой библиотеки. Skeleton для дашборда. Lighthouse-прогон `/milestones` и `/growth` на staging. |
| **4** | Skeleton для дневника и карточек сигналов. Optimistic updates на подтверждениях. |
| **8** | Финальный Lighthouse-аудит всех страниц на staging. |

### J. Accessibility Baseline

TheyGrow — приложение для родителей. Часто используется одной рукой (вторая держит ребёнка), в тёмной комнате (ребёнок засыпает), на ходу. Accessibility — не формальность, а **условие удобства** для целевой аудитории.

**Принцип**: a11y-чеклист — часть Definition of Done для **каждой UI-задачи** начиная с Блока 1.

#### J.1. Минимальный чеклист (DoD для UI-задач)

| Критерий | Стандарт | Проверка |
|----------|---------|----------|
| **Touch targets** | ≥ 44×44px | Визуальная проверка + axe-core |
| **Цветовой контраст** | WCAG AA: 4.5:1 (text), 3:1 (large text/UI) | axe-core + Lighthouse |
| **Семантический HTML** | Headings (h1–h6), landmarks (nav, main, aside), labels для input, alt для img | axe-core |
| **Keyboard navigation** | Tab, Enter, Escape для модалок и dropdown. Focus management при открытии/закрытии | Ручная проверка |
| **Информация не только цветом** | Для графа: дополнительные иконки/паттерны для статусов навыков (не только зелёный/серый) | Визуальная проверка |

#### J.2. Автоматическая проверка (axe-core)

В Блоке 0: подключить `vitest-axe` / `jest-axe` для автоматической проверки рендеренных компонентов. В CI: a11y-тест стартовой страницы. Расширять по мере появления страниц.

#### J.3. Альтернативное представление графа (Блок 2)

Интерактивный граф (react-force-graph) недоступен для: screen readers, пользователей с нарушениями зрения, low-end устройств. Обязательно: **табличный/списковый вид** с теми же данными (навык, статус, readiness, зависимости, «открывает путь к»). Toggle «Граф / Список».

#### J.4. Dark mode

Отложить на post-MVP, но **заложить основу с Блока 1**: использовать Tailwind `dark:` классы, CSS-переменные для цветов. Это позволит добавить dark mode без рефакторинга.

#### Распределение задач a11y по блокам

| Блок | Задачи a11y |
|------|------------|
| **0** | axe-core в Vitest. a11y-тест стартовой страницы. |
| **1** | a11y-чеклист в DoD всех UI-задач. Tailwind `dark:` classes. |
| **2** | Альтернативный табличный вид графа. Иконки/паттерны для статусов (не только цвет). |
| **8** | Финальный a11y-аудит: axe-core на всех страницах, ручная проверка keyboard nav. |

### K. Backup & Disaster Recovery

С момента переключения production на новый стек (Блок 2) данные пользователей хранятся в Cloud SQL и Neo4j Aura. Потеря данных = потеря доверия. Backup и DR — обязательны **с первого дня production**.

#### K.1. Cloud SQL (PostgreSQL)

| Аспект | Решение |
|--------|--------|
| **Automated backups** | Включены по умолчанию в Cloud SQL. Проверить: retention ≥ 7 дней, PITR (Point-in-Time Recovery) включён |
| **Manual backup** | Перед каждой Alembic-миграцией: `gcloud sql backups create --instance=INSTANCE_ID`. Скрипт в `scripts/` |
| **Restore** | Процедура задокументирована в runbook: `gcloud sql backups restore BACKUP_ID --restore-instance=INSTANCE_ID` |

#### K.2. Neo4j Aura

| Аспект | Решение |
|--------|--------|
| **Регулярный dump** | Скрипт `scripts/neo4j_backup.py`: Cypher export всех нод и связей → JSON → GCS bucket. Расписание: ежедневно (Cloud Scheduler) |
| **Restore** | Процедура в runbook: загрузить dump из GCS → Cypher LOAD → проверка количества нод/связей |
| **Особенность free tier** | Neo4j Aura free tier не гарантирует сохранность данных при неактивности. Регулярный dump — страховка |

#### K.3. RTO / RPO для MVP

| Параметр | Значение | Обоснование |
|----------|---------|-------------|
| **RPO** (Recovery Point Objective) | 24 часа | Для 10–50 семей потеря данных за сутки допустима. Cloud SQL PITR обеспечивает RPO < 1 часа; Neo4j dump — RPO = 24 часа |
| **RTO** (Recovery Time Objective) | 2 часа | Время от обнаружения инцидента до восстановления сервиса |

#### K.4. Secrets Inventory

Документировать в `/docs/operations.md` все секреты в Secret Manager:

| Секрет | Сервис | Создаётся в блоке |
|--------|--------|-------------------|
| `db-connection-string` | Cloud SQL | 2 |
| `neo4j-uri`, `neo4j-user`, `neo4j-password` | Neo4j Aura | 2 |
| `llm-api-key` | Anthropic / OpenAI | 4 |
| `sentry-dsn` | Sentry | 0 |
| `vapid-keys` | Push Notifications | 8 |

#### Распределение задач backup/DR по блокам

| Блок | Задачи backup/DR |
|------|-----------------|
| **2** | Проверить Cloud SQL automated backups + PITR. Скрипт manual backup перед миграциями. Скрипт Neo4j dump → GCS. Процедура restore в runbook. Secrets inventory в operations.md. |
| **4** | Добавить cleanup cron для LLM logs и failed extractions (retention policy из G.3). |
| **8** | Финальная ревизия: backup-скрипты работают, restore протестирован, runbook актуален. |

---

## Блок 0: Фундамент — бэкенд-скелет и новый фронтенд рядом с текущим приложением

> Текущее приложение продолжает работать в проде. Рядом разворачивается новый стек: FastAPI + PostgreSQL + Neo4j + Next.js. Пользователь пока ничего нового не видит.

### 🧑 Задачи разработчика в этом блоке

| # | Задача | Тип | Что именно |
|---|--------|-----|------------|
| 0.9 | Настройка CI | 🤖→🧑 | Агент пишет `.github/workflows/*.yml` / `cloudbuild.yaml`. Разработчик: создать Cloud Build trigger в GCP Console, добавить GitHub Secrets (GCP credentials), включить Cloud Build API |
| 0.10 | Staging на GCP | 🧑 | Создать Cloud Run service `child-tracker-service-staging` в GCP Console (тот же проект, `europe-west1`, **не** `--allow-unauthenticated`). Настроить IAM |

### TODO

- [ ] **0.1** Создать структуру каталогов **внутри существующего репозитория**:
  ```
  they_grow/
  ├── backend/
  │   ├── src/
  │   │   ├── api/           # FastAPI routers
  │   │   ├── db/            # SQLAlchemy models + Alembic
  │   │   ├── graph/         # Neo4j queries + logic
  │   │   ├── llm/           # LLM extraction (будущее)
  │   │   ├── pipelines/     # Signal, Recommendation (будущее)
  │   │   └── main.py        # FastAPI entry point
  │   ├── tests/
  │   └── pyproject.toml
  ├── frontend/
  │   ├── app/               # Next.js 14 App Router
  │   ├── components/
  │   ├── lib/
  │   ├── public/            # ← сюда переедут icons/, manifest.json, sw.js, offline.html
  │   └── package.json
  ├── docker-compose.yml      # Локальная разработка: backend + frontend + PG + Neo4j
  ├── index.html              # ★ Текущее приложение (остаётся)
  ├── Dockerfile              # ★ Текущий деплой (остаётся)
  ├── cloudbuild.yaml         # ★ Текущий CI/CD (остаётся)
  ├── nginx.conf              # ★ Текущий nginx (остаётся)
  └── AGENTS.md
  ```
- [ ] **0.2** Инициализировать **backend** (Poetry + Python 3.12):
  - Зависимости: FastAPI, Uvicorn, SQLAlchemy[asyncio], asyncpg, Alembic, neo4j, python-jose[cryptography], passlib[bcrypt], pydantic-settings, structlog, httpx (для тестов), pytest, pytest-asyncio.
  - `src/main.py`: FastAPI app с `GET /healthz` → 200 и пустым роутером `/api/v1`.
  - Тест: `tests/test_health.py` → GET /healthz → 200 OK.
- [ ] **0.3** Настроить **PostgreSQL** для локальной разработки:
  - `docker-compose.yml`: Postgres 16 (порт 5432).
  - SQLAlchemy async engine + session factory (`src/db/session.py`).
  - Alembic init с async-драйвером.
  - Тест: `tests/test_db_connection.py` → подключение, создание/чтение записи в test-таблице.
- [ ] **0.4** Настроить **Neo4j** для локальной разработки:
  - Добавить Neo4j 5 в `docker-compose.yml` (порт 7687/7474).
  - Async-драйвер `neo4j` (`src/graph/driver.py`).
  - Тест: `tests/test_neo4j_connection.py` → подключение, создание ноды, чтение.
- [ ] **0.5** Инициализировать **frontend** (Next.js 14 + App Router):
  - pnpm + TypeScript strict + Tailwind CSS.
  - ESLint (next/core-web-vitals) + Prettier.
  - Перенести PWA-ресурсы из корня: `icons/`, `manifest.json`, `sw.js`, `offline.html` → `frontend/public/`.
  - Стартовая страница `/` — заглушка «TheyGrow — новая версия в разработке».
  - Тест: Vitest + React Testing Library → рендер стартовой страницы.
- [ ] **0.6** Создать **`AGENTS.md`** в корне репозитория — **операционный файл для AI-агента**, который Cursor автоматически подхватывает при старте сессии.

  **Важно**: это должна быть первая задача, выполняемая после 0.1 (структура каталогов). Все последующие задачи агент выполняет уже руководствуясь AGENTS.md.

  Базовый шаблон — Blueprint §7.2, но AGENTS.md должен включать **все** операционные правила из мастер-плана:

  **Обязательные секции:**

  1. **Project Overview** — стек, структура каталогов (из Blueprint §7.2).
  2. **Commands** — как запускать тесты, линтеры, dev server, миграции (из Blueprint §7.2).
  3. **Code Style** — Python (Black, isort, Ruff, mypy) и TypeScript (Prettier, ESLint, tsc) (из Blueprint §7.2).
  4. **Masterplan Reference** — ссылка на `data/mvp_masterplan.md` как основной источник задач. Инструкция: «При начале работы прочитай мастер-план и определи текущую задачу».
  5. **Development Cycle** (из секции D мастер-плана) — полный цикл: код → lint → тесты → анализ результатов → доработка при провале → коммит. Явное указание: результат тестов — обратная связь, не коммитить при красных тестах.
  6. **Commit Convention** (из секции D) — английский язык, Conventional Commits с номером задачи (`feat(N.M): description`). Pre-commit contract (5 условий).
  7. **Branching & Push Strategy** (из секции D) — коммит локально после каждого шага, push в staging-ветку (не в main!) после логической группы. Никогда не push в main, никогда не force push.
  8. **Session Resumption Protocol** (из секции D) — git log → git status → мастер-план → тесты → продолжение.
  9. **Handoff Protocol** (из секции C) — маркеры 🧑 / 🤖→🧑, когда останавливаться, что передавать разработчику. Обязательный коммит перед передачей.
  10. **Testing Requirements** (из секции E) — ключевые принципы: поведение не реализация, happy/edge/error paths, содержательные assertions, изоляция, имя = спецификация. Обязательные проверки для API (валидация, auth, tenant isolation) и пайплайнов (LLM parsing, graceful degradation).
  11. **Observability & Error Recovery** (из секции F) — error tracking (Sentry / GCP Error Reporting), structured logging с trace_id, deep health checks (`/readyz`), distributed tracing (OpenTelemetry), structured error context для AI-агента, circuit breaker для внешних зависимостей, LLM observability, retry policy / dead letter queue. Ключевое: при ошибке в production формируется отчёт, пригодный для передачи агенту (`fetch_error_context`).
  12. **Boundaries** (из Blueprint §7.2) — что агент не должен менять без ревью (safety rules, DB migrations, установочные документы).
  13. **AI-Specific Hints** (из Blueprint §7.2) — tenant isolation в SQL/Cypher, structured logging, ссылки на промпты.
  14. **Privacy & Data Governance** (из секции G) — правила обработки PII: что не логировать, PII-санитизация, как работает `DELETE /api/v1/families/me` (каскадное удаление PG + Neo4j + governance log), `GET /api/v1/families/me/export`, запрет PII в GA4 events. Жёсткий запрет: никаких имён, email, текстов дневника в логах, аналитике, error tracking.
  15. **Performance** (из секции I) — бюджеты Core Web Vitals (LCP < 2.5s, INP < 200ms, CLS < 0.1, bundle < 200KB). Тактические правила: dynamic import для тяжёлых компонентов, code splitting по роутам, optimistic updates, skeleton screens, next/image.
  16. **Accessibility** (из секции J) — a11y-чеклист для каждой UI-задачи: touch targets ≥44×44px, WCAG AA контраст, семантический HTML, keyboard navigation, информация не только цветом. axe-core в тестах.

  **Доступ к мастер-плану**: `data/` находится в `.gitignore`. Чтобы агент мог читать мастер-план, добавить исключение в `.gitignore`:
  ```
  /data/
  !/data/mvp_masterplan.md
  ```
  Это позволит закоммитить мастер-план, оставив остальные файлы в `data/` вне git.

  **Обновление**: AGENTS.md обновляется в каждом блоке при изменении структуры, команд или процессов.
- [ ] **0.7** Настроить **линтеры и форматтеры**:
  - Backend: Black (line-length 100), isort, Ruff (rules E,F,I,N,W), mypy strict.
  - Frontend: ESLint + Prettier + tsc --noEmit.
- [ ] **0.7.1** **Lighthouse CI** в CI pipeline (секция I мастер-плана): `@lhci/cli`, mobile profile, throttled 4G. Бюджеты: LCP < 2.5s, INP < 200ms, CLS < 0.1, Performance score ≥ 90. При нарушении — build fails. На старте — проверка стартовой страницы; расширять URL-ы по мере появления страниц.
- [ ] **0.7.2** **axe-core** в Vitest (секция J мастер-плана): подключить `vitest-axe` для автоматической a11y-проверки рендеренных компонентов. Тест: стартовая страница проходит axe без critical violations.
- [ ] **0.8** `docker-compose.yml`: backend (FastAPI :8000) + frontend (Next.js :3000) + PostgreSQL (:5432) + Neo4j (:7687). Health-check для каждого сервиса.
- [ ] **0.9** 🤖→🧑 Настроить **CI** (GitHub Actions или расширить Cloud Build): backend (pytest + ruff + mypy) + frontend (vitest + eslint + tsc). При каждом push в main.
  - 🤖 Агент: написать CI-конфигурацию (`.github/workflows/ci.yml` или `cloudbuild.yaml`).
  - 🧑 Разработчик: создать Cloud Build trigger в GCP Console (или включить GitHub Actions), добавить secrets/credentials.
- [ ] **0.10** 🧑 Настроить **staging-окружение** на GCP:
  - 🧑 Разработчик: создать Cloud Run service `child-tracker-service-staging` в GCP Console (тот же проект, тот же регион, **не** `--allow-unauthenticated`). Настроить IAM.
  - 🤖 Агент: обновить `cloudbuild.yaml` (авто-деплой на staging после успешной сборки; production-деплой — отдельным ручным шагом/trigger).
  - 🤖 Агент: задокументировать процесс staging → production промоушена в `/docs/deployment.md`.
- [ ] **0.11** **Observability: базовый уровень** (секция F мастер-плана):
  - Подключить **error tracking**: Sentry SDK (Python + Next.js) или GCP Error Reporting. Автоматический сбор необработанных исключений с stack trace, request context, environment.
  - Реализовать **deep health check** `GET /readyz`: проверка подключения к PostgreSQL, Neo4j (latency + connectivity). Возврат JSON с `status` (healthy/degraded/unhealthy) и деталями по каждому компоненту. Тест.
  - Настроить **structured logging** (structlog): JSON-формат, обязательные поля `trace_id`, `request_id`, `environment`. Middleware для автоматической генерации `trace_id` на каждый входящий запрос. Тест: логи содержат нужные поля.
  - Добавить заголовок `X-Trace-Id` в HTTP-ответы (middleware). Тест.
  - Настроить **PII-санитизацию** в error tracking: email → маска, пароли → удаление, тексты дневника → `[REDACTED]`.
- [ ] **0.12** **Документация блока**:
  - Развернуть `README.md`: описание проекта, prerequisites (Docker, Poetry, pnpm), quick start (`docker compose up`), ссылки на Blueprint.
  - Верифицировать `AGENTS.md` (создан в 0.6) — убедиться, что все секции актуальны после выполнения 0.1–0.11.
  - Создать `/docs/adr/001-stack-choice.md`: обоснование выбора FastAPI + Next.js + PostgreSQL + Neo4j.
  - Создать `/docs/deployment.md`: локальный запуск (docker compose), staging (Cloud Run), production (процедура промоушена).

### Definition of Done

- `docker compose up` поднимает 4 сервиса: backend, frontend, PostgreSQL, Neo4j.
- `GET localhost:8000/healthz` → 200 OK.
- `GET localhost:8000/readyz` → 200 JSON с проверками PostgreSQL и Neo4j.
- `localhost:3000` → Next.js заглушка открывается.
- `poetry run pytest` — 5+ тестов проходят (healthz, readyz, PG connection, Neo4j connection, structured logging).
- `pnpm test` (frontend) — 2+ теста проходят (стартовая страница + axe-core a11y).
- Линтеры и type-check на обоих стеках проходят без ошибок.
- **Lighthouse CI** в pipeline: стартовая страница проходит бюджеты (LCP < 2.5s, Performance ≥ 90).
- **axe-core** в тестах: стартовая страница без critical a11y violations.
- **Error tracking** подключён: необработанные исключения автоматически отправляются в Sentry / GCP Error Reporting.
- **Structured logging** работает: каждый запрос логируется с `trace_id`, ответы содержат `X-Trace-Id`.
- **Staging-окружение** создано: `child-tracker-service-staging` на Cloud Run, деплой при push в main.
- **Текущее приложение** (`index.html`) по-прежнему работает в production — ничего не сломано.
- CI прогоняет все проверки (тесты + линтеры + type-check + Lighthouse + axe-core).
- **Документация**: README.md развёрнут, ADR-001 написан, `/docs/deployment.md` описывает все окружения.
- **AGENTS.md** создан и содержит все 16 секций (project overview, commands, code style, masterplan reference, development cycle, commit convention, branching strategy, session resumption, handoff protocol, testing requirements, observability & error recovery, boundaries, AI hints, privacy & data governance, performance, accessibility).
- **Мастер-план в git**: `data/mvp_masterplan.md` закоммичен (`.gitignore` обновлён с исключением).

**⏸ СТОП — Проверка перед переходом к Блоку 1.**

---

## Блок 1: «Я вхожу и вижу то же самое, но лучше» — Auth, профили, трекер навыков в новом стеке

> Ключевой блок миграции. Всё, что пользователь имел в текущем приложении, появляется в новой версии: профили детей, трекер 174 навыков, фильтры, модалки навыков. Добавляется аутентификация (вход/регистрация) и серверное хранение данных. При первом входе — импорт данных из localStorage старой версии.

### 🧑 Задачи разработчика в этом блоке

| # | Задача | Тип | Что именно |
|---|--------|-----|------------|
| 1.9.4 | Privacy Policy + ToS | 🧑 | Разработчик создаёт тексты Privacy Policy и ToS/Disclaimer. Агент размещает на `/privacy` и `/terms` |
| 1.25 | Проверка на staging | 🤖→🧑 | Агент деплоит и готовит чеклист smoke test. Разработчик: пройти smoke test вручную (регистрация → вход → трекер → отметка навыка → профили) |

### TODO

#### Backend: схема и API

- [ ] **1.1** Создать **Alembic-миграции** для таблиц `families`, `parents`, `children`, `consent_log` (по схеме из Blueprint §3.2). Тест: миграция применяется, таблицы создаются.
- [ ] **1.2** Создать **SQLAlchemy-модели** и **Pydantic-схемы** для families, parents, children.
- [ ] **1.3** Реализовать **auth-эндпоинты**:
  - `POST /api/v1/auth/register` — email, password, parent_name, child_name, child_birthdate → создание family + parent + child, возврат JWT.
  - `POST /api/v1/auth/login` — email, password → access_token + refresh_token.
  - `GET /api/v1/families/me` — данные семьи (parents, children).
  - Тесты: регистрация → токен → /families/me; дубль email → 409; невалидные данные → 422; невалидный токен → 401.
- [ ] **1.4** Реализовать **CRUD профилей детей**:
  - `POST /api/v1/children` — добавить ребёнка.
  - `PATCH /api/v1/children/{child_id}` — обновить (имя, дата рождения, характеристики).
  - `DELETE /api/v1/children/{child_id}`.
  - Тесты: CRUD + tenant isolation (семья A не видит детей семьи B).
- [ ] **1.5** Реализовать **consent_log** (INSERT-ONLY): при регистрации → записи о согласии на Privacy Policy, ToS и third-party LLM processing (секция G.4). UPDATE/DELETE запрещены (PostgreSQL rules). Ссылки на Privacy Policy и ToS на странице регистрации. Тест.
- [ ] **1.6** **Загрузить граф навыков** (174 навыка, 256 связей) из `data/child_development_milestones_FULL.json` в **Neo4j** как шаблонные ноды (`child_id: 'TEMPLATE'`):
  - Скрипт `backend/src/graph/seed_template.py`.
  - Маппинг: skill.id → ChildSkill.canonical_name, skill.category → domain, skill.age_start/end → age metadata, prerequisites → ENABLES edges.
  - Тест: все 174 ноды созданы, все 256 ENABLES-связей существуют.
- [ ] **1.7** При регистрации ребёнка → **инстанцировать персональный граф** из шаблона: копия ChildSkill-нод с конкретным `child_id`/`family_id`, status='NOT_OBSERVED', readiness=0. Тест.
- [ ] **1.8** Реализовать **API трекера навыков**:
  - `GET /api/v1/children/{child_id}/skills` — все навыки ребёнка из Neo4j (с фильтрацией по domain, status). Возврат: [{skill_id, canonical_name, name_ru, category, age_start, age_end, status, description, prerequisites, additional_info}].
  - `POST /api/v1/children/{child_id}/skills/{skill_id}/complete` — отметка навыка как освоенного (status → MASTERED, evidence_count += 1).
  - `DELETE /api/v1/children/{child_id}/skills/{skill_id}/complete` — снятие отметки (status → NOT_OBSERVED).
  - Тесты: получение, фильтрация, отметка/снятие, tenant isolation.
- [ ] **1.9** Реализовать **API импорта из localStorage**:
  - `POST /api/v1/import/local-profiles` — body: {profiles: [{name, birthdate, completedSkills}]} → создание children + отметка навыков в Neo4j.
  - Маппинг legacy skill IDs → canonical names.
  - Тест: импорт профиля с completedSkills → навыки отмечены в Neo4j.

#### Privacy & Data Governance (секция G мастер-плана)

- [ ] **1.9.1** Реализовать **`DELETE /api/v1/families/me`** (секция G.2) — каскадное удаление: PG (families, parents, children, consent_log записи) + Neo4j (все ChildSkill-ноды семьи) + производные данные. Governance log: **анонимизация** (family_id → SHA-256 hash), не удаление. Тест: после DELETE → 404 на все эндпоинты семьи, данные отсутствуют в PG и Neo4j, governance log содержит hashed записи.
- [ ] **1.9.2** Реализовать **`GET /api/v1/families/me/export`** (секция G.2) — JSON со всеми данными семьи: profiles, children, skills + statuses. Human-readable, без внутренних UUID. Тест: экспорт содержит корректные данные, tenant isolation (семья A не может экспортировать данные семьи B).
- [ ] **1.9.3** Фронтенд: страница **«Профиль / Настройки»** — кнопки «Экспортировать данные» и «Удалить аккаунт» (с подтверждением). Ссылки на Privacy Policy и ToS. Тест.
- [ ] **1.9.4** 🧑 **Privacy Policy + ToS/Disclaimer** — разработчик создаёт тексты Privacy Policy (какие данные, зачем, права) и ToS/Disclaimer (не мед. устройство, не диагноз, ограничение ответственности). Агент размещает на `/privacy` и `/terms`.

#### Frontend: миграция текущего UI на Next.js

- [ ] **1.10** Фронтенд: страницы **регистрации** (`/register`) и **входа** (`/login`):
  - Регистрация: имя родителя, email, пароль, имя ребёнка, дата рождения. Валидация форм.
  - Вход: email + пароль. JWT в httpOnly cookie.
  - Тест: рендер, валидация, отправка.
- [ ] **1.11** Фронтенд: **middleware защиты маршрутов** — неавторизованные → `/login`. Тест.
- [ ] **1.12** Фронтенд: **портирование трекера навыков** (`/milestones`):
  - Таблица навыков по категориям и месяцам (данные из API, не из встроенного JSON).
  - Чекбоксы для отметки освоенных (отправка на API).
  - Те же 6 категорий, тот же диапазон 0–72 месяца.
  - Сохранить текущую визуализацию: цветовая индикация возрастных периодов, стилизация освоенных навыков.
  - Тест: рендер таблицы с mock-данными, отметка навыка.
- [ ] **1.13** Фронтенд: **модальная карточка навыка** (портирование текущего `openSkillModal`):
  - Название, описание, период, критерии оценки.
  - Пререквизиты (кликабельные — навигация к другому навыку, как сейчас).
  - Естественное освоение, потенциальные проблемы, активности для родителя, медицинская консультация.
  - История навигации между модалками (skillModalHistory, как в текущем коде).
  - Тест.
- [ ] **1.14** Фронтенд: **фильтры** (портирование):
  - «Скрыть освоенные» — toggle, состояние сохраняется.
  - «По возрасту» — показывать только навыки, релевантные текущему возрасту ребёнка.
  - Автоматическое скрытие пустых категорий и месяцев (как `hideEmptyCategories()` и `hideEmptyMonthColumns()` в текущем коде).
  - Тест.
- [ ] **1.15** Фронтенд: **мобильный аккордеон** для категорий (портирование `initMobileAccordion`): на мобильных — только заголовки категорий, раскрытие по тапу. Состояние персистентно. Тест.
- [ ] **1.16** Фронтенд: **модалка «Активности»** (портирование `openActivitiesModal`): сетка актуальных неосвоенных навыков. Тест.
- [ ] **1.17** Фронтенд: **профили детей**:
  - Хедер: кнопка с именем текущего ребёнка → dropdown со списком + «Добавить профиль».
  - Переключение между профилями (данные из API).
  - Создание нового профиля (модальное окно с именем + дата рождения).
  - Отображение возраста ребёнка.
  - Тест.
- [ ] **1.18** Фронтенд: **импорт данных из старой версии**:
  - При первом входе проверить localStorage на наличие `childDevTracker_profiles`.
  - Если есть — предложить «Импортировать ваши данные из предыдущей версии?»
  - При подтверждении — отправить на `POST /api/v1/import/local-profiles`, очистить localStorage.
  - Тест.
- [ ] **1.19** Фронтенд: **нижняя навигация** (bottom tab bar, thumb-friendly):
  - Навыки (активная) | Рост (заглушка «Скоро») | Профиль.
  - Тест.
- [ ] **1.20** Фронтенд: **GA4-трекинг** (секция H мастер-плана):
  - Перенести все существующие события (`skill_complete`, `profile_create`, `skill_view`, `filter_*_toggle`, `category_toggle`, `activities_open`, PWA-события). Measurement ID из env-переменной.
  - Добавить **новые события**: `account_delete_request`, `data_export_request`, `onboarding_step_{1..N}`, `onboarding_complete`, `activation_achieved`.
  - Добавить **custom dimensions** (без PII): `child_age_months`, `completed_skills_count`, `days_since_registration`.
  - **Жёсткий запрет PII** в event parameters: никаких имён, email, текстов в GA4-событиях.
  - Тест: вызов trackEvent не падает, custom dimensions передаются корректно.
- [ ] **1.21** Фронтенд: **guided first experience** (онбординг, секция H мастер-плана):
  - Линейный flow: «Добавьте ребёнка → Отметьте 3–5 навыков → Готово, вы видите прогресс!»
  - **Activation metric**: отметил ≥5 навыков в первую сессию → событие `activation_achieved`.
  - Событие `onboarding_step_{N}` на каждом шаге, `onboarding_complete` при завершении.
  - Dismissible, но с мягким encouragement вернуться.
  - В Блоке 4 расширить: «Сделайте первую запись в дневнике». В Блоке 8 — полировка/оптимизация на основе GA4-данных.
  - Тест.
- [ ] **1.22** Фронтенд: **Telegram-кнопка** (ссылка из хедера, как в текущем приложении). Тест.
- [ ] **1.23** **Observability: distributed tracing** (секция F мастер-плана):
  - Подключить **OpenTelemetry SDK** (Python): автоинструментация FastAPI, SQLAlchemy, httpx.
  - Настроить **трейсинг Neo4j-запросов**: кастомные спаны для каждого Cypher-запроса (тип, длительность, количество результатов).
  - Экспорт трейсов в **Cloud Trace** (OTLP exporter) или в stdout (JSON) для локальной разработки.
  - Фронтенд: подключить Sentry SDK (Next.js) с трассировкой клиентских ошибок и performance monitoring.
  - Тест: при обработке запроса создаётся trace с корректными спанами (HTTP → DB → Neo4j).
- [ ] **1.24** **Документация блока**:
  - Обновить README.md (auth flow, как запустить, API-примеры).
  - Задокументировать API: auth, children, skills — примеры запросов/ответов в `/docs/api/auth.md`, `/docs/api/skills.md`.
  - ADR: `/docs/adr/002-auth-jwt-strategy.md`, `/docs/adr/003-neo4j-graph-model.md`.
  - Схема данных: ER-диаграмма PostgreSQL + граф-схема Neo4j в `/docs/schema/`.
  - Начать `CHANGELOG.md` (Блок 1: auth, profiles, milestone tracker).
- [ ] **1.25** 🤖→🧑 **Проверка на staging**: задеплоить на `child-tracker-service-staging`, провести ручной smoke test (регистрация → вход → трекер → отметка навыка → профили).
  - 🤖 Агент: выполнить деплой, подготовить чеклист smoke test.
  - 🧑 Разработчик: пройти smoke test вручную, подтвердить результат.

### Definition of Done

- Пользователь может зарегистрироваться, войти, увидеть свой профиль с данными ребёнка.
- **Трекер навыков полностью воспроизводит текущую функциональность**: 174 навыка, 6 категорий, чекбоксы, модалки, фильтры, аккордеон, активности — всё работает так же, но данные хранятся в PostgreSQL + Neo4j, а не в localStorage.
- При первом входе предлагается импорт данных из старой версии.
- Все маршруты защищены JWT-авторизацией.
- Consent log ведётся с первого действия.
- Tenant isolation: данные одной семьи недоступны другой.
- GA4-аналитика работает: перенесены старые события + новые (onboarding, delete, export). Custom dimensions без PII.
- **Privacy**: `DELETE /api/v1/families/me` и `GET /api/v1/families/me/export` работают. Privacy Policy и ToS размещены. Consent log фиксирует согласие на PP, ToS, LLM processing.
- **Guided onboarding**: линейный flow «ребёнок → навыки → прогресс», activation metric определён.
- **a11y baseline**: все UI-компоненты проходят чеклист (touch targets, контраст, семантика, keyboard).
- **Distributed tracing** работает: запросы прослеживаются через FastAPI → PostgreSQL → Neo4j, трейсы экспортируются в Cloud Trace.
- Все тесты проходят (backend ≥ 26, frontend ≥ 17).
- Линтеры и type-check чистые.
- **Проверено на staging** — smoke test пройден.
- **Документация актуальна**: API docs, ADR, схема данных, CHANGELOG.
- **Старое приложение** (`index.html`) всё ещё доступно в production как fallback.

**⏸ СТОП — Проверка перед переходом к Блоку 2.**

---

## Блок 2: «Я вижу, как растёт мой ребёнок» — Граф развития + переключение продакшна

> Граф уже заполнен (174 навыка, 256 связей, статусы от ручных чекбоксов из Блока 1). Родитель получает наглядную обратную связь: интерактивный граф навыков с цветовой кодировкой, прогресс по доменам, прогнозы «что может появиться дальше». В этом же блоке — переключение production на новый стек: это первое видимое улучшение относительно старого приложения, оправдывающее переезд.

### 🧑 Задачи разработчика в этом блоке

**Это самый «инфраструктурный» блок — здесь больше всего ручной работы.**

| # | Задача | Тип | Что именно |
|---|--------|-----|------------|
| 2.11 | Cloud SQL в production | 🧑 | Создать Cloud SQL инстанс (или БД) в GCP Console. Настроить networking, IAM. Сохранить credentials в Secret Manager |
| 2.12 | Neo4j Aura в production | 🧑 | Создать проект в Neo4j Aura Console (free tier). Получить credentials (URI, user, password). Сохранить в Secret Manager |
| 2.3.4 | Production alerting | 🤖→🧑 | Агент пишет конфигурации алертов. Разработчик: создать notification channel в Cloud Monitoring (email/Slack), привязать alert policies |
| 2.14 | Полная проверка на staging | 🤖→🧑 | Агент деплоит и готовит чеклист. Разработчик: полный smoke test перед переключением прода |
| — | Промоушен в production | 🧑 | Осознанное решение: запуск production-деплоя после успешного staging |
| — | User interviews | 🧑 | После production switch: 3–5 интервью с ранними пользователями (секция H.7) |

### TODO

#### Backend: граф API

- [ ] **2.1** Реализовать **API графа ребёнка** (расширение 1.8):
  - `GET /api/v1/children/{child_id}/graph?domain={optional}` — полный граф: {nodes: [{skill_id, name, name_ru, domain, status, readiness, confidence, evidence_count}], edges: [{from, to, weight}]}.
  - `GET /api/v1/children/{child_id}/readiness-summary` — {domains: [{domain, skills_total, skills_emerging, skills_solid, skills_mastered, avg_readiness}]}.
  - Тесты: данные, фильтрация по домену, tenant isolation.
- [ ] **2.2** Реализовать **Cascade Prediction** (Cypher-запрос из Blueprint §4.4):
  - `GET /api/v1/children/{child_id}/predictions` — навыки, для которых ≥70% prerequisites SOLID/MASTERED, с ориентировочными сроками.
  - Тест.
- [ ] **2.3** Backend: **обогащение structured logging** — расширить базовый structlog (из Блока 0) контекстными полями `family_id`, `child_id` во всех операциях. Log-контекст автоматически привязывается к текущему authenticated user через middleware. Тест: логи содержат tenant-specific поля.

#### Observability: production readiness (секция F мастер-плана)

- [ ] **2.3.1** Реализовать **Structured Error Context middleware** (секция F.4): при 5xx автоматически формировать отчёт (endpoint, stack trace, sanitized request, dependency status, breadcrumbs, commit SHA). Сохранение в Cloud Logging с лейблом `type=error_report`. Тест.
- [ ] **2.3.2** Создать скрипт **`scripts/fetch_error_context.py`**: по `error_id` или `trace_id` собирает полный контекст ошибки из Cloud Logging в plain-text формате, оптимизированном для передачи AI-агенту. Тест.
- [ ] **2.3.3** Создать начальный **runbook** (`/docs/operations.md`): проверка здоровья (`/readyz`), типичные инциденты (PG/Neo4j недоступен, высокий error rate после деплоя), откат деплоя (`gcloud run services update-traffic`), передача контекста ошибки агенту.
- [ ] **2.3.4** Настроить **production alerting**: error rate > 1% за 5 мин, latency p95 > 500ms, `/readyz` возвращает `unhealthy`. Алерты через Cloud Monitoring → notification channel (настраивается разработчиком в 🧑 задаче).

#### Frontend: визуализация графа

- [ ] **2.4** Фронтенд: **дашборд развития** (`/growth`):
  - Прогресс-бары по каждому из 6 доменов (% освоенных навыков).
  - Суммарная статистика: всего навыков / освоено / в процессе.
  - Тест.
- [ ] **2.5** Фронтенд: **интерактивный граф** (библиотека: react-force-graph, d3-force или vis-network):
  - Ноды = навыки, рёбра = зависимости.
  - Цветовая кодировка: NOT_OBSERVED (серый), EMERGING (жёлтый), DEVELOPING (оранжевый), SOLID (зелёный), MASTERED (ярко-зелёный).
  - Зум, перетаскивание, touch-friendly.
  - Фильтр по доменам.
  - **Dynamic import** (`next/dynamic`, `{ ssr: false }`) для графовой библиотеки (секция I.3).
  - Тест.
- [ ] **2.5.1** Фронтенд: **альтернативное представление графа** (секция J.3 мастер-плана) — табличный/списковый вид навыков с теми же данными: навык, статус, readiness, зависимости, «открывает путь к». Toggle «Граф / Список». Необходим для a11y (screen readers, low-end устройства). Дополнительно: иконки/паттерны для статусов навыков (не только цвет). Тест.
- [ ] **2.6** Фронтенд: **детальная карточка навыка** (расширение модалки из Блока 1):
  - Добавить: readiness, confidence, evidence_count.
  - Связи: «зависит от» и «открывает путь к» (визуально).
  - (Ссылки на записи дневника появятся в Блоке 4, когда дневник будет создан.)
  - Тест.
- [ ] **2.7** Фронтенд: секция **«Что может появиться дальше»**:
  - Карточки навыков из cascade prediction.
  - «Вашему ребёнку осталось немного до [навык] — обычно это происходит через [N] недель после [навык-B]».
  - Тест.
- [ ] **2.8** Обновить **нижнюю навигацию**: вкладка «Рост» теперь активна (ведёт на `/growth`). Тест.

#### Переключение прода (через staging)

- [ ] **2.9** Обновить **Dockerfile**: собирать и раздавать Next.js вместо index.html. Backend — отдельный контейнер или тот же (мультистейдж).
- [ ] **2.10** Обновить **cloudbuild.yaml**: сборка нового стека → авто-деплой на staging → ручной промоушен в production. Сохранить GCP-проект (`ordinal-avatar-479419-t7`), регион (`europe-west1`), порт 8080.
- [ ] **2.11** 🧑 Добавить **Cloud SQL (PostgreSQL)** в production (отдельная БД от staging). Настроить подключение через Secret Manager.
  - 🧑 Разработчик: создать Cloud SQL инстанс (или production-БД на существующем инстансе) в GCP Console. Настроить networking (VPC connector / Cloud SQL Auth Proxy), IAM. Сохранить connection string в Secret Manager.
  - 🤖 Агент: обновить backend config для чтения credentials из Secret Manager; применить Alembic-миграции.
- [ ] **2.12** 🧑 Добавить **Neo4j Aura** (free tier) в production. Настроить credentials через Secret Manager.
  - 🧑 Разработчик: создать проект в Neo4j Aura Console, получить URI + credentials. Сохранить в Secret Manager.
  - 🤖 Агент: обновить backend config; загрузить шаблонный граф навыков в production Neo4j.
- [ ] **2.13** Сохранить **`index.html`** в репозитории как fallback. Маршрут `/legacy` → старое приложение (через nginx).
- [ ] **2.14** 🤖→🧑 **Полная проверка на staging** перед переключением production:
  - 🤖 Агент: выполнить деплой на staging, подготовить чеклист smoke test.
  - 🧑 Разработчик: пройти smoke test вручную (регистрация → вход → трекер навыков → граф → импорт из localStorage; проверка Service Worker и GA4-событий).
  - 🧑 Разработчик: только после успешной проверки — промоушен на production (осознанное решение).
- [ ] **2.15** **Документация блока**:
  - Задокументировать Graph API, Cascade Predictions (`/docs/api/graph.md`).
  - Обновить `/docs/deployment.md` (staging → production workflow для нового стека, Cloud SQL + Neo4j Aura setup).
  - Обновить CHANGELOG.md.

#### Backup & Disaster Recovery (секция K мастер-плана)

- [ ] **2.15.1** Настроить **Cloud SQL backup** (секция K.1): проверить automated backups (retention ≥ 7 дней, PITR включён). Скрипт `scripts/pg_backup_before_migration.sh` для manual backup перед Alembic-миграциями (`gcloud sql backups create`). Задокументировать процедуру restore в runbook (`/docs/operations.md`). Secrets inventory — задокументировать все секреты в Secret Manager.
- [ ] **2.15.2** Настроить **Neo4j Aura dump** (секция K.2): скрипт `scripts/neo4j_backup.py` — Cypher export всех нод и связей → JSON → GCS bucket. Задокументировать restore в runbook. Добавить секцию «Disaster Recovery» в `/docs/operations.md`.
- [ ] **2.15.3** In-app **«Сообщить о проблеме / предложить идею»** (секция H.7): кнопка в профиле, авто-прикрепление `X-Trace-Id` + app version + `child_age_months` (без PII). Отправка: в Telegram-бот или email (не требует бэкенда для feedback). Тест.

### 🧑 Задачи разработчика (дополнительные)

| # | Задача | Тип | Что именно |
|---|--------|-----|------------|
| — | User interviews | 🧑 | Провести 3–5 интервью с ранними пользователями после production switch. Зафиксировать инсайты |

### Definition of Done

- Родитель видит дашборд прогресса по доменам и интерактивный граф навыков.
- Граф отображает текущее состояние (статусы, связи) — цветовая кодировка.
- **Альтернативный табличный вид графа** доступен (toggle «Граф / Список»), иконки/паттерны для статусов.
- Детальная карточка навыка показывает readiness, confidence, связи.
- Секция «Что дальше» — прогнозы ближайших навыков.
- Граф работает на мобильных (touch-zoom, перетаскивание). Dynamic import для графовой библиотеки.
- **Structured Error Context** работает: при 5xx автоматически формируется отчёт с полным контекстом, доступен через `fetch_error_context`.
- **Production alerting** настроен: error rate, latency p95, health check failures → уведомления.
- **Runbook** создан: `/docs/operations.md` описывает проверку здоровья, типичные инциденты, откат деплоя, передачу контекста ошибки агенту, **Disaster Recovery** (restore PG + Neo4j).
- **Backup настроен**: Cloud SQL automated backups + PITR, Neo4j dump → GCS, скрипт manual backup.
- **Feedback-кнопка** работает: «Сообщить о проблеме» с авто-прикреплением контекста.
- **Проверено на staging**: все ключевые flow работают.
- **Промоушен в production выполнен**: новая версия развёрнута на Cloud Run. Старое приложение доступно по `/legacy`.
- Cloud SQL и Neo4j Aura работают в production.
- Все тесты проходят (backend ≥ 12 новых, frontend ≥ 10 новых).
- **Документация актуальна**: Graph API, deployment guide обновлён, runbook (включая DR), secrets inventory, CHANGELOG.

**⏸ СТОП — Проверка перед переходом к Блоку 3.**

---

## Блок 3: «Что делать дальше?» — Персональные рекомендации активностей

> Граф ребёнка уже отображается, статусы навыков известны из ручных чекбоксов. Система анализирует граф и предлагает 1–3 активности в неделю по готовности ребёнка. Дневник для этого не нужен — рекомендации строятся на текущем состоянии графа. Каждая активность объясняет «почему сейчас» и имеет трёхслойное описание (Surface / Embedded Learning / Reflection). Используются данные `parent_activities` из существующего датасета навыков как начальная база шаблонов.

### 🧑 Задачи разработчика в этом блоке

| # | Задача | Тип | Что именно |
|---|--------|-----|------------|
| 3.10 | Проверка на staging | 🤖→🧑 | Агент деплоит и готовит чеклист. Разработчик: проверить генерацию рекомендаций, accept, complete, weekly cap |

### TODO

- [ ] **3.1** Создать **Alembic-миграцию** для таблицы `activity_recommendations` (Blueprint §3.2).
- [ ] **3.2** Создать **систему шаблонов активностей**:
  - Начальная база: **автоматическая генерация** из существующего поля `additional_info.parent_activities` в данных навыков (у каждого навыка уже есть 2–5 активностей для родителя).
  - Формат: {template_id, target_skill_id, domain, surface_description, embedded_learning, reflection_prompts, materials_needed, duration_minutes, age_range}.
  - На MVP: 20–30 доработанных вручную шаблонов для ключевых навыков.
  - Тест: загрузка шаблонов.
- [ ] **3.3** Реализовать **Readiness Check** (Blueprint §4.4):
  - Cypher: навыки с ≥70% prerequisites в SOLID/MASTERED → top-5 по readiness ASC.
  - Тест с тестовым графом.
- [ ] **3.4** Реализовать **Scoring Model**:
  - readiness_score (из графа) × context_fit (возраст, предыдущие активности).
  - Top-3 рекомендации.
  - Weekly cap: ≤3 новых рекомендаций в неделю.
  - Тест.
- [ ] **3.5** Реализовать **Recommendation API**:
  - `GET /api/v1/recommendations?child_id={id}&limit=3`.
  - `POST /api/v1/recommendations/{id}/accept`.
  - `POST /api/v1/recommendations/{id}/complete` — body: {reflection_text?}.
  - `POST /api/v1/recommendations/{id}/skip`.
  - Тесты: генерация, accept, complete, skip, weekly cap.
- [ ] **3.6** Фронтенд: страница **«Рекомендации»** (`/recommendations`):
  - Карточки: название, «почему сейчас», описание, материалы, длительность.
  - Кнопки «Попробовать» / «Пропустить».
  - Weekly cap indicator: «2 из 3 на этой неделе».
  - Тест.
- [ ] **3.7** Фронтенд: **детальная страница активности** (`/recommendations/[id]`):
  - Surface (что делать с ребёнком).
  - Embedded Learning (чему учится ребёнок — скрыто, но доступно).
  - Reflection (вопросы для размышления после).
  - Кнопка «Завершить» (→ короткая рефлексия или сразу complete).
  - Тест.
- [ ] **3.8** Обновить **навигацию**: добавить вкладку «Активности». Тест.
- [ ] **3.9** **Документация блока**: Recommendation Pipeline (`/docs/pipelines/recommendations.md`), Recommendation API (`/docs/api/recommendations.md`), ADR: `/docs/adr/004-recommendation-scoring.md`. Обновить CHANGELOG.
- [ ] **3.9.1** **Экспорт отчёта ребёнка** (секция H мастер-плана): `GET /api/v1/children/{id}/report?format=json` — JSON-отчёт со всеми навыками, статусами, рекомендациями. Фронтенд: кнопка «Поделиться с врачом» → JSON-экспорт + share link (read-only, TTL 72h). PDF — post-MVP. GA4-событие: `child_report_export`. Тест: отчёт содержит корректные данные, share link работает и истекает через 72h, tenant isolation.
- [ ] **3.10** 🤖→🧑 **Проверка на staging**: генерация рекомендаций, accept, complete, weekly cap.
  - 🤖 Агент: деплой + чеклист smoke test.
  - 🧑 Разработчик: пройти smoke test вручную.

### Definition of Done

- Родитель видит 1–3 персональных рекомендации, подобранных по готовности ребёнка (из графа).
- Каждая рекомендация объясняет «почему сейчас» и описывает активность.
- Можно принять, пропустить, завершить активность.
- Weekly cap работает (≤3/неделю).
- Все тесты проходят (backend ≥ 10 новых, frontend ≥ 8 новых).
- **Проверено на staging**.
- **Документация актуальна**: pipeline docs, API docs, ADR-004, CHANGELOG.

**⏸ СТОП — Проверка перед переходом к Блоку 4.**

---

## Блок 4: «Я записываю, и система понимает» — Дневник + извлечение сигналов + подтверждение

> Единый смысловой блок: дневник появляется сразу с LLM-анализом. Родитель пишет «Взял чириос двумя пальцами» → через ~15 сек видит распознанный навык «пинцетный захват» → подтверждает → граф ребёнка обновляется. Дневник без этой цепочки не имеет ценности в контексте развития; цепочка без дневника невозможна. Поэтому они появляются вместе.

### 🧑 Задачи разработчика в этом блоке

**Первое использование LLM — нужны API-ключи.**

| # | Задача | Тип | Что именно |
|---|--------|-----|------------|
| 4.0 | LLM API ключи | 🧑 | Получить API-ключ Anthropic (Claude) и/или OpenAI (GPT-4). Сохранить в Secret Manager (production) и `.env` (локально) |
| 4.18 | Проверка на staging | 🤖→🧑 | Агент деплоит. Разработчик: end-to-end smoke test (diary → extraction → signals → confirmation → graph update). Проверить оффлайн-режим |

### TODO

#### Backend: дневник + extraction pipeline

- [ ] **4.0** 🧑 **LLM API ключи**: получить API-ключ Anthropic (Claude) и/или OpenAI (GPT-4). Сохранить в Secret Manager (production) и `.env` (локально). Убедиться, что billing настроен. Сообщить агенту имя секрета в Secret Manager.

- [ ] **4.1** Создать **Alembic-миграции** для таблиц `diary_entries` и `signal_confirmations` (по схемам из Blueprint §3.2).
- [ ] **4.2** Реализовать **Diary API**:
  - `POST /api/v1/diary/entries` — {child_id, domain, raw_text, created_at?}. Возврат: {entry_id, extraction_status: 'pending'}. Side effect: запуск async extraction.
  - `GET /api/v1/diary/entries?child_id={id}&limit=20&offset=0` — список записей с пагинацией.
  - `GET /api/v1/diary/entries/{entry_id}` — конкретная запись.
  - Тесты: CRUD, пагинация, фильтрация по child_id, tenant isolation, оффлайн-sync (created_at из прошлого).
- [ ] **4.3** Реализовать **LLM Signal Extraction Pipeline**:
  - Промпт с Chain-of-Thought (Blueprint §9.1): на вход — текст записи + домен + список навыков домена из Neo4j (с русскими названиями, описаниями, критериями — **всё это уже есть** в наших данных) → на выход — JSON: [{skill_id, canonical_name, confidence, reasoning}].
  - Pydantic-модель `SignalExtraction` для валидации.
  - JSON Repair fallback.
  - Тесты: парсинг корректного ответа, невалидный JSON, валидация Pydantic.
- [ ] **4.4** Реализовать **Context Builder** (`build_signal_extraction_context`):
  - Загружать из Neo4j только навыки релевантного домена.
  - Включать name_ru, description, assessment_criteria, age_start/end — чтобы LLM имел полный контекст.
  - Тест.
- [ ] **4.5** Реализовать **асинхронную обработку** записей дневника:
  - При создании diary_entry → BackgroundTasks FastAPI (на MVP; Cloud Pub/Sub — на Stage 1).
  - Worker: загрузить запись → context builder → LLM → валидация → UPDATE diary_entries (status='completed', signals_extracted).
  - **Выбор модели по complexity** (секция H мастер-плана, задача 4.8.5): дешёвая модель (Haiku / GPT-4o-mini) для стандартных extractions (один домен, текст <500 символов). Дорогая (Sonnet / GPT-4o) — для длинных текстов с несколькими доменами.
  - **Retry policy** (секция F.7): max 3 попытки, exponential backoff (30s → 2min → 10min). Retryable: LLM timeout, 429, 500, network error. Non-retryable: Pydantic validation error после JSON Repair, неизвестный skill_id.
  - **Dead letter**: после 3 неудачных попыток → `extraction_status='failed'`, запись в таблицу `failed_extractions` (entry_id, error, attempt_count, last_error_at).
  - Тесты: полный пайплайн (mock LLM), обработка ошибок, retry logic, dead letter.
- [ ] **4.6** Реализовать **API подтверждения сигналов**:
  - `POST /api/v1/signals/confirm` — {entry_id, skill_id, parent_response: confirmed|corrected|rejected, parent_comment?}.
  - Side effect: обновление ChildSkill в Neo4j.
  - Тесты: все три сценария (confirmed/corrected/rejected) → проверка Neo4j.
- [ ] **4.7** Реализовать **обновление Neo4j при подтверждении**:
  - `confirmed` → readiness += weighted increment, evidence_count++, переход статусов (NOT_OBSERVED → EMERGING → DEVELOPING → SOLID → MASTERED).
  - `rejected` → лог для анализа точности, без изменений графа.
  - `corrected` → обновить указанный навык вместо предложенного.
  - Тесты: каждый сценарий + пороги перехода.
- [ ] **4.8** Backend: **Prompt versioning** — промпты как файлы в `backend/src/llm/prompts/v1/`. PromptManager (Blueprint §9.2). Тест.

#### Observability: LLM и pipeline resilience (секция F мастер-плана)

- [ ] **4.8.1** Реализовать **Circuit Breaker для LLM API** (секция F.5): при 5 ошибках за 60с → состояние Open (запросы не отправляются, extraction откладывается как `pending`). Half-open через 30с (пробный запрос). Тест: переход Closed → Open → Half-open → Closed.
- [ ] **4.8.2** Реализовать **LLM observability** (секция F.6): логирование каждого LLM-вызова (prompt version, sanitized input, response, tokens in/out, latency, parse result, validation result). Метрики: latency p50/p95, parse success rate, token usage per request. Тест: лог содержит все обязательные поля.
- [ ] **4.8.3** Реализовать **Admin API для failed extractions**: `GET /api/v1/admin/failed-extractions?limit=20` (список), `POST /api/v1/admin/retry-extraction/{entry_id}` (ручной retry). Тест.
- [ ] **4.8.4** Обновить **runbook** (`/docs/operations.md`): добавить секции «LLM API: таймауты / 429 / деградация качества», «Failed extractions накапливаются», «Circuit breaker в Open-состоянии».
- [ ] **4.8.5** **LLM cost management** (секции G/H мастер-плана):
  - **Бюджет**: target ≤ $0.01 per extraction (при Haiku / GPT-4o-mini). Алерт при daily cost > пороговое значение.
  - **Модельная маршрутизация**: дешёвая модель (Haiku / GPT-4o-mini) для стандартных extractions. Дорогая (Sonnet / GPT-4o) — только для red flags Self-Consistency (Блок 6) и complex Q&A (Блок 7). Выбор по complexity: длина текста, наличие нескольких доменов.
  - **Оптимизация токенов**: компактификация контекста (только навыки текущего домена, не все 174), кэширование контекста на уровне child+domain (TTL 1 час).
  - Добавить **cost tracking** в LLM observability (F.6): cost per call, cost per family per day, daily total.
  - **Retention cleanup cron** (секция G.3): Cloud Scheduler задача для автоудаления LLM logs старше 30 дней и failed extractions старше 90 дней.
  - Тест: cost tracking записывается корректно, cleanup удаляет только просроченные данные.

#### Frontend: дневник + сигналы + оффлайн

- [ ] **4.9** Фронтенд: **DiaryQuickEntry** — компонент быстрого ввода:
  - Шаг 1: выбор домена (6 категорий).
  - Шаг 2: свободный текст (textarea) + кнопка «Сохранить».
  - Large touch targets (≥44×44px), readable font (≥16px).
  - Фиксированная панель внизу экрана (как описано в Blueprint §6.3).
  - Тест: рендер, выбор домена, отправка.
- [ ] **4.10** Фронтенд: страница **«Дневник»** (`/diary`):
  - Хронологическая лента записей (дата, домен, текст, статус обработки, кол-во сигналов).
  - Бесконечная прокрутка или пагинация.
  - Пустое состояние: «Напишите первое наблюдение о вашем ребёнке».
  - Кнопка «+» для создания новой записи.
  - Тест.
- [ ] **4.11** Фронтенд: **просмотр записи + карточки сигналов** (`/diary/[entryId]`):
  - Полный текст, домен, дата/время.
  - **Индикация статуса**: `pending` → «Анализируем...» (spinner); `completed` → карточки сигналов; `failed` → «Не удалось обработать».
  - **Карточки сигналов**: список извлечённых навыков с confidence-индикатором.
  - Кнопки «Подтвердить» / «Не совсем» / «Нет» для каждого навыка.
  - Поле для комментария при коррекции.
  - Анимация подтверждения.
  - Polling каждые 5 сек пока pending.
  - Тест.
- [ ] **4.12** Реализовать **оффлайн-хранение черновиков** (IndexedDB через `idb`):
  - `saveDraftEntry(draft)` — UUID-ключ, сохранение в IndexedDB.
  - `syncDrafts()` — при появлении сети → POST каждого черновика на API → удаление из IndexedDB.
  - Автоматический вызов при событии `online`.
  - Тесты: сохранение, чтение, синхронизация (mock API).
- [ ] **4.13** Фронтенд: **индикатор оффлайн-режима**:
  - Плашка «Оффлайн — записи сохраняются локально» при отсутствии сети.
  - «Синхронизация...» при восстановлении.
  - Тест.
- [ ] **4.14** Обновить **Service Worker**: добавить кэширование страниц дневника (Network-First для API, Cache-First для статики). Тест.
- [ ] **4.15** Обновить **нижнюю навигацию**: добавить вкладку «Дневник». Тест.
- [ ] **4.16** Фронтенд: расширить **детальную карточку навыка** (из Блока 2): добавить ссылки на записи дневника, в которых навык был зафиксирован. Тест.
- [ ] **4.16.1** Фронтенд: **GA4-события для дневника и сигналов** (секция H.4): `diary_entry_create`, `signal_confirm`, `signal_correct`, `signal_reject`. Skeleton screens для дневника и карточек сигналов. Optimistic updates на подтверждениях сигналов.
- [ ] **4.17** **Документация блока**:
  - Задокументировать Diary API (`/docs/api/diary.md`).
  - Задокументировать Signal Extraction Pipeline: flow-диаграмма, промпты, error handling (`/docs/pipelines/signal-extraction.md`).
  - Задокументировать Signals API (`/docs/api/signals.md`).
  - ADR: `/docs/adr/005-llm-provider-choice.md`, `/docs/adr/006-offline-sync-strategy.md`.
  - Обновить схему данных (diary_entries, signal_confirmations).
  - Обновить CHANGELOG.md.
- [ ] **4.18** 🤖→🧑 **Проверка на staging**: diary → extraction → signals → confirmation → graph update end-to-end. Оффлайн-режим.
  - 🤖 Агент: деплой + чеклист smoke test.
  - 🧑 Разработчик: пройти end-to-end smoke test вручную, включая проверку оффлайн-режима (отключить сеть → записать → включить → проверить синхронизацию).

### Definition of Done

- Родитель создаёт запись дневника за 2 тапа (домен → текст → отправить).
- Через ~15 сек появляются карточки распознанных навыков.
- Родитель может подтвердить, скорректировать или отклонить каждый сигнал.
- Подтверждённые сигналы обновляют граф ребёнка (readiness, status, evidence_count), что сразу видно в дашборде и графе (из Блока 2).
- При отсутствии сети запись сохраняется в IndexedDB и синхронизируется при восстановлении.
- Ошибки LLM → graceful degradation (запись сохранена, обработка повторится позже).
- **Circuit breaker** для LLM API работает: при каскадных ошибках запросы автоматически приостанавливаются, recovery через half-open.
- **LLM observability**: каждый вызов логируется (latency, tokens, parse result, **cost**), метрики доступны.
- **LLM cost management**: модельная маршрутизация по complexity, cost tracking (per call, per family, daily total), бюджет ≤ $0.01/extraction.
- **Retention cleanup**: cron удаляет LLM logs >30 дней, failed extractions >90 дней.
- **Retry policy + dead letter queue**: failed extractions отслеживаются, доступен ручной retry через Admin API.
- **GA4-события**: `diary_entry_create`, `signal_confirm`, `signal_correct`, `signal_reject`.
- Pipeline end-to-end: Diary → Extraction → Signals → Confirmation → Graph Update.
- Все тесты проходят (backend ≥ 28 новых, frontend ≥ 14 новых).
- **Проверено на staging** end-to-end.
- **Документация актуальна**: Diary API, Signals API, pipeline docs, ADR-005, ADR-006, runbook обновлён (LLM-инциденты), CHANGELOG.

**⏸ СТОП — Проверка перед переходом к Блоку 5.**

---

## Блок 5: «Я расту вместе с ребёнком» — Рефлексия + граф родителя

> Замыкание петли ценности: активность (из Блока 3) → рефлексия → извлечение сигналов о навыках родителя → граф родителя → рекомендации учитывают и ребёнка, и родителя.

### 🧑 Задачи разработчика в этом блоке

| # | Задача | Тип | Что именно |
|---|--------|-----|------------|
| 5.12 | Проверка на staging | 🤖→🧑 | Агент деплоит. Разработчик: end-to-end smoke test полного value loop |

### TODO

- [ ] **5.1** Создать **Alembic-миграцию** для таблицы `reflection_entries` (Blueprint §3.2).
- [ ] **5.2** Инициализировать **Parent Graph в Neo4j** (Blueprint §4.3):
  - Шаблонные ноды ParentSkill: foundational (presence, observation, co_regulation).
  - Связи BUILDS_ON с весами.
  - Скрипт + тест.
- [ ] **5.3** При регистрации родителя → **инстанцировать персональный граф** из шаблона. Тест.
- [ ] **5.4** Реализовать **Reflection API**:
  - `POST /api/v1/reflections` — {activity_id, raw_text}.
  - `GET /api/v1/reflections?parent_id={id}`.
  - Тесты.
- [ ] **5.5** Реализовать **Parent Signal Extraction Pipeline**:
  - Промпт: текст рефлексии + foundational parent skills → JSON навыков + confidence.
  - Обновление ParentSkill в Neo4j (competence, practice_count).
  - Тесты.
- [ ] **5.6** Реализовать **Parent Graph API**:
  - `GET /api/v1/parents/{parent_id}/graph`.
  - Тесты.
- [ ] **5.7** Фронтенд: **форма рефлексии** (после завершения активности):
  - Направляющие вопросы из шаблона активности.
  - Свободный текст.
  - Тест.
- [ ] **5.8** Фронтенд: **«Мой рост»** (`/parent-growth` или секция в профиле):
  - Прогресс foundational skills (presence, observation, co-regulation).
  - Список последних рефлексий.
  - Тест.
- [ ] **5.9** Обновить **Scoring Model** рекомендаций (Блок 3): добавить parent_learning_value. Тест.
- [ ] **5.10** Обновить навигацию: ссылка на «Мой рост». Тест.
- [ ] **5.11** **Документация блока**: Reflection Pipeline + Parent Graph (`/docs/pipelines/reflection.md`), Parent Graph API (`/docs/api/parent-graph.md`). Обновить CHANGELOG (full value loop достигнут).
- [ ] **5.12** 🤖→🧑 **Проверка на staging**: полный цикл end-to-end.
  - 🤖 Агент: деплой + чеклист smoke test.
  - 🧑 Разработчик: пройти полный value loop вручную (Дневник → Сигналы → Граф ребёнка → Рекомендации → Активность → Рефлексия → Граф родителя).

### Definition of Done

- Полный цикл: Дневник → Сигналы → Граф ребёнка → Рекомендации → Активность → Рефлексия → Граф родителя → Улучшенные рекомендации.
- Родитель видит свой прогресс по foundational skills.
- Рекомендации учитывают и готовность ребёнка, и навыки родителя.
- Все тесты проходят (backend ≥ 10 новых, frontend ≥ 6 новых).
- **Проверено на staging**: полный value loop работает end-to-end.
- **Документация актуальна**: pipeline docs, Parent Graph API, CHANGELOG.

**⏸ СТОП — Проверка перед переходом к Блоку 6.**

---

## Блок 6: «Мне спокойно и безопасно» — Safety, Red Flags, Governance

> Делает систему пригодной для реального ежедневного использования с семьёй: автоматическая детекция тревожных сигналов, AI Constitution во всех LLM-промптах, аудит-логи.

### 🧑 Задачи разработчика в этом блоке

| # | Задача | Тип | Что именно |
|---|--------|-----|------------|
| 6.10 | Ревью Constitution | 🧑 | Содержательный ревью AI Constitution и safety rules — это архитектурное решение, не код. Агент создаёт черновик, разработчик утверждает |
| 6.11 | Проверка на staging | 🤖→🧑 | Агент деплоит. Разработчик: проверить red flag detection, severity routing, governance log |

### TODO

- [ ] **6.1** Создать **Alembic-миграции** для `red_flags` и `governance_log` (Blueprint §3.2, §8.3).
- [ ] **6.2** Реализовать **Red Flags Detection Pipeline**:
  - Вызывается после signal extraction (интеграция в пайплайн Блока 4).
  - CoT-промпт: паттерны → возраст → контекст → severity triage.
  - Self-Consistency для CRITICAL (n=5, мажоритарный severity).
  - Тесты: LOW/MEDIUM/CRITICAL сценарии.
- [ ] **6.3** Реализовать **маршрутизацию**: LOW → лог, MEDIUM → уведомление, CRITICAL → немедленный обзор. Тесты.
- [ ] **6.4** Реализовать **Constitution Check** (Blueprint §8.3): LLM self-critique для всех ответов. Тесты.
- [ ] **6.5** Реализовать **Governance Log** (INSERT-only). Тест.
- [ ] **6.6** Реализовать **Admin API для red flags**:
  - `GET /api/v1/admin/red-flags?severity={level}&reviewed=false`.
  - `POST /api/v1/admin/red-flags/{id}/review` — {action_taken}.
  - Тесты.
- [ ] **6.7** Интегрировать Red Flags Detection в Signal Extraction Pipeline (Блок 4). Тест интеграции.
- [ ] **6.8** Фронтенд: **мягкое уведомление** при MEDIUM+ red flag (без паники, с ресурсами). Тест.
- [ ] **6.9** Добавить **Constitution** во все LLM system prompts (signal extraction из Блока 4, parent extraction из Блока 5). Тест.
- [ ] **6.10** 🤖→🧑 **Документация блока**: Safety Pipeline, Constitution, Red Flags routing (`/docs/pipelines/safety.md`), TheyGrow AI Constitution (`/docs/constitution.md`). ADR: `/docs/adr/007-constitutional-ai-approach.md`. Обновить CHANGELOG.
  - 🤖 Агент: создать черновики всех документов, включая AI Constitution.
  - 🧑 Разработчик: **содержательный ревью AI Constitution** — это ключевой документ, определяющий границы поведения системы. Утвердить или скорректировать.
- [ ] **6.11** 🤖→🧑 **Проверка на staging**: red flag detection, severity routing, governance log.
  - 🤖 Агент: деплой + чеклист smoke test.
  - 🧑 Разработчик: проверить вручную red flag detection (тестовые сценарии LOW/MEDIUM/CRITICAL), severity routing, governance log.

### Definition of Done

- Red flags детектируются при каждой записи дневника, severity routing работает.
- Constitution check для всех LLM-ответов.
- Governance log ведётся.
- Мягкое уведомление родителю при тревожных сигналах.
- Все тесты проходят (backend ≥ 15 новых, frontend ≥ 3 новых).
- **Проверено на staging**.
- **Документация актуальна**: Safety pipeline, Constitution, ADR-007, CHANGELOG.

**⏸ СТОП — Проверка перед переходом к Блоку 7.**

---

## Блок 7: «Могу спросить» — Q&A с экспертной проверкой + извлечение сигналов из вопросов

> Родитель может задать вопрос — система генерирует ответ через LLM с Constitution Check, ответ проходит review архитектора перед отправкой. SLA: 24 часа. **Дополнительно**: каждый вопрос проходит через пайплайн извлечения сигналов — упоминания навыков ребёнка, фактические детали, темы беспокойства, паттерны уточняющих вопросов — всё это обогащает картину развития, полученную из дневниковых записей (Блок 4) и рефлексий (Блок 5). Вопросы — третий (наряду с дневником и рефлексиями) источник сигналов в системе.

### 🧑 Задачи разработчика в этом блоке

| # | Задача | Тип | Что именно |
|---|--------|-----|------------|
| 7.15 | Проверка на staging | 🤖→🧑 | Агент деплоит. Разработчик: end-to-end smoke test (вопрос → ответ + сигналы → подтверждение → граф) |

### Почему это важно

Вопросы родителя — **богатый имплицитный источник сигналов**, отличающийся от дневниковых записей:

| | Дневник (Блок 4) | Рефлексия (Блок 5) | Вопрос (Блок 7) |
|---|---|---|---|
| **Формат** | Наблюдение-нарратив | Свободная рефлексия после активности | Вопрос / запрос помощи |
| **Сигналы о ребёнке** | Прямые наблюдения навыков | Косвенные (через описание активности) | Фактические упоминания + зоны беспокойства |
| **Сигналы о родителе** | — | Навыки родителя (observation, co-regulation) | Качество наблюдения, уровень тревожности, темы интереса |
| **Надёжность** | Высокая (наблюдение) | Средняя (рефлексия) | Пониженная (упоминание, не наблюдение) |
| **Пример** | «Взял чириос двумя пальцами» | «Заметила, как сын сосредоточился» | «Ему 14 мес, ползает и стоит у опоры — это нормально?» |

Из последнего примера извлекаются: навыки `crawling` (can_do, high conf), `stands_with_support` (can_do, high conf), `walks_independently` (concern, moderate conf); домен `gross_motor`; parent concern level — moderate; observation quality — good.

### TODO

#### Backend: Q&A API + ответы

- [ ] **7.1** Создать **Alembic-миграцию** для `qa_questions` (Blueprint §3.2), расширив схему полями для сигнального пайплайна:
  - Базовые поля из Blueprint: `question_id`, `parent_id`, `question_text`, `created_at`, `risk_level`, `llm_response`, `architect_reviewed`, `architect_notes`, `response_sent_at`.
  - **Новые поля** для извлечения сигналов:
    - `extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending', 'processing', 'completed', 'failed'))` — статус извлечения сигналов.
    - `signals_extracted JSONB` — структурированные сигналы (топики, навыки, детали, тип вопроса).
    - `extracted_at TIMESTAMPTZ` — время завершения извлечения.
  - Индекс на `extraction_status` для batch-retry failed.
  - Тест: миграция применяется, таблица создаётся с корректной структурой.
- [ ] **7.2** Реализовать **Q&A API**: submit, get, list. При submit — side effect: запуск async extraction (параллельно с генерацией ответа). Тесты.
- [ ] **7.3** Реализовать **LLM Response Generation** с risk-level routing: LOW/MEDIUM/CRITICAL. Тесты.
- [ ] **7.4** Реализовать **Admin Q&A Review API**: pending list, approve, revise. Тесты.

#### Backend: извлечение сигналов из вопросов

- [ ] **7.5** Реализовать **Q&A Signal Extraction Pipeline** — извлечение структурированных сигналов из текста вопроса:
  - **Промпт** (Chain-of-Thought): на вход — текст вопроса + возраст ребёнка + контекст из графа (текущие статусы навыков релевантных доменов) → на выход — JSON:
    ```json
    {
      "topic_domains": ["gross_motor"],
      "mentioned_skills": [
        {"skill_id": "WALKS_WITH_SUPPORT", "mention_type": "can_do", "confidence": 0.85, "reasoning": "прямое упоминание 'стоит у опоры'"},
        {"skill_id": "WALKS_INDEPENDENTLY", "mention_type": "concern", "confidence": 0.70, "reasoning": "вопрос 'нормально ли' подразумевает ожидание этого навыка"}
      ],
      "factual_details": [
        {"detail": "ребёнок ползает", "inferred_skill": "CRAWLING", "confidence": 0.90},
        {"detail": "стоит у опоры", "inferred_skill": "STANDS_WITH_SUPPORT", "confidence": 0.85}
      ],
      "question_type": "developmental_concern",
      "parent_signals": {
        "concern_level": "moderate",
        "observation_quality": "good",
        "knowledge_level": "basic",
        "topics_of_interest": ["gross_motor_milestones", "walking_timeline"]
      }
    }
    ```
  - Pydantic-модель `QASignalExtraction` для валидации (с вложенными моделями `MentionedSkill`, `FactualDetail`, `ParentSignals`).
  - JSON Repair fallback (аналогично diary extraction из Блока 4).
  - Промпт хранится в `backend/src/llm/prompts/v1/qa_signal_extraction.txt` (Prompt Versioning из Блока 4).
  - Тесты: парсинг корректного ответа, невалидный JSON, различные типы вопросов (`developmental_concern`, `how_to`, `factual`, `emotional`, `medical_redirect`).
- [ ] **7.6** Реализовать **Context Builder для Q&A** (`build_qa_extraction_context`):
  - Загрузить из Neo4j **полный граф ребёнка** (все домены — в отличие от diary extraction, где грузится один домен, вопрос может затрагивать несколько доменов).
  - Включить: возраст ребёнка, последние 5 записей дневника (для контекста), последние 3 вопроса (для выявления паттернов повторяющихся тем).
  - Компактификация: передавать только навыки с `readiness > 0` и навыки текущего возрастного периода (±3 месяца).
  - Тест.
- [ ] **7.7** Реализовать **асинхронную обработку Q&A-сигналов**:
  - При создании `qa_question` → **параллельно** с генерацией ответа (7.3) запускается extraction pipeline.
  - Worker: загрузить вопрос → context builder → LLM → валидация → UPDATE `qa_questions` (`extraction_status='completed'`, `signals_extracted`, `extracted_at`).
  - При ошибке → `extraction_status='failed'`, batch-retry (аналогично diary extraction).
  - Extraction pipeline **не блокирует** генерацию ответа — это два параллельных процесса.
  - Тесты: полный пайплайн (mock LLM), обработка ошибок, параллельность с response generation.
- [ ] **7.8** Реализовать **обновление графов по Q&A-сигналам**:
  - **Child Graph**: фактические упоминания навыков (`mention_type: 'can_do'`) → обновление readiness с **пониженным весом** (Q&A-mention = 0.5× от diary confirmation, т.к. упоминание в вопросе менее надёжно, чем целенаправленное наблюдение в дневнике). `mention_type: 'concern'` → не обновляет readiness, но логируется как interest signal для recommendation pipeline.
  - **Parent Graph**: `observation_quality` → обновление ParentSkill `'observation'` (competence). `concern_level` → метрика для recommendation pipeline (если высокая тревожность — снизить интенсивность рекомендаций).
  - Автоматическое обновление **без подтверждения** для сигналов с `confidence ≥ 0.85` и `mention_type: 'can_do'` (high-confidence factual mentions). Остальные — через confirmation flow (7.11).
  - Тесты: обновление child graph (can_do vs concern), обновление parent graph, корректность весов (0.5× diary), пороги автоподтверждения.
- [ ] **7.9** Реализовать **API для Q&A-сигналов**:
  - `GET /api/v1/qa/questions/{id}/signals` — извлечённые сигналы конкретного вопроса.
  - `POST /api/v1/qa/signals/confirm` — {question_id, skill_id, parent_response: confirmed|corrected|rejected} (аналогично diary signal confirmation из Блока 4).
  - Расширить `GET /api/v1/qa/questions/{id}` — добавить `signals_extracted` и `extraction_status` в ответ.
  - Тесты: получение сигналов, подтверждение/коррекция/отклонение, обновление графа по подтверждению.

#### Frontend: Q&A + отображение сигналов

- [ ] **7.10** Фронтенд: **страница Q&A** (`/qa`): форма вопроса, история, статусы, ответы. Тест.
- [ ] **7.11** Фронтенд: **отображение извлечённых сигналов** на странице ответа:
  - Секция «Что мы узнали из вашего вопроса» — показывается **после ответа**, ненавязчиво (collapsible, не мешает основному flow).
  - Карточки упомянутых навыков (аналогично карточкам сигналов в дневнике из Блока 4): название навыка, тип упоминания (can_do / concern), confidence-индикатор.
  - Кнопки «Подтвердить» / «Не совсем» / «Нет» для каждого навыка (confirmation flow).
  - Polling каждые 5 сек пока `extraction_status = 'pending'`.
  - Тест.

#### Общее

- [ ] **7.12** Backend: **entitlement check** — Q&A только при `families.entitlements.qa = true`. Тест.
- [ ] **7.13** **Observability: расширение на Q&A pipeline** (секция F мастер-плана):
  - Расширить **circuit breaker** на Q&A extraction pipeline (общий circuit breaker с diary extraction — один LLM API).
  - Расширить **retry policy и dead letter queue** на Q&A-сигналы (аналогично diary extraction из Блока 4).
  - Расширить **LLM observability**: отдельные метрики для Q&A extraction (latency, parse success, quality).
  - Обновить **runbook**: добавить секцию «Q&A extraction failures».
- [ ] **7.14** **Документация блока**:
  - Q&A flow + risk routing (`/docs/pipelines/qa.md`).
  - **Q&A Signal Extraction Pipeline** (`/docs/pipelines/qa-signal-extraction.md`): flow-диаграмма, промпты, типы сигналов, весовые коэффициенты, error handling.
  - Q&A API + Signals API (`/docs/api/qa.md`).
  - Обновить CHANGELOG.
- [ ] **7.15** 🤖→🧑 **Проверка на staging**: submit question → LLM response + signal extraction (параллельно) → signals display → confirmation → graph update → review → delivery.
  - 🤖 Агент: деплой + чеклист smoke test.
  - 🧑 Разработчик: пройти end-to-end вручную.

### Definition of Done

- Родитель задаёт вопрос → LLM генерирует ответ → Constitution Check → review → отправка.
- **Параллельно** из вопроса извлекаются сигналы: упомянутые навыки, фактические детали, темы интересов, паттерны тревожности.
- Фактические упоминания навыков (`can_do`, high confidence) автоматически обновляют граф ребёнка с пониженным весом (0.5× от дневниковых записей).
- Остальные сигналы предлагаются родителю для подтверждения (confirmation flow аналогичен Блоку 4).
- Паттерны вопросов обогащают граф родителя (observation quality, concern level → влияет на recommendation pipeline).
- Risk-level routing: CRITICAL приоритизируются.
- Pipeline end-to-end: Question → Answer Generation ∥ Signal Extraction → Signals Display → Confirmation → Graph Update.
- **Circuit breaker и retry/DLQ** расширены на Q&A extraction pipeline. LLM observability покрывает Q&A-вызовы.
- Все тесты проходят (backend ≥ 20 новых, frontend ≥ 6 новых).
- **Проверено на staging**.
- **Документация актуальна**: Q&A pipeline, Q&A signal extraction pipeline, API docs, runbook обновлён (Q&A failures), CHANGELOG.

**⏸ СТОП — Проверка перед переходом к Блоку 8.**

---

## Блок 8: «Готово к масштабу» — Entitlements, мониторинг, admin panel, onboarding

> Система готова принять 10–50 семей: структурированный онбординг, admin panel для управления, мониторинг, rate limiting.

### 🧑 Задачи разработчика в этом блоке

| # | Задача | Тип | Что именно |
|---|--------|-----|------------|
| 8.4 | Cloud Scheduler | 🧑 | Создать Cloud Scheduler job для weekly edge weight update в GCP Console |
| 8.7 | Финальная ревизия observability | 🤖→🧑 | Агент пишет конфигурации бизнес-метрик и дашбордов. Разработчик: создать Slack webhook, подключить Slack notification channel в Cloud Monitoring |
| 8.8 | Push Notifications | 🧑 | Сгенерировать VAPID keys, сохранить в Secret Manager |

### TODO

- [ ] **8.1** Реализовать **Entitlements System**: JSONB в families, middleware-проверка, admin-эндпоинт обновления. Тесты.
- [ ] **8.2** Реализовать **Rate Limiting** (soft limits): API 100 req/min, LLM 20 extractions/day. Тесты.
- [ ] **8.3** Реализовать **Feature Flags**: env-based, флаги ENABLE_QA, ENABLE_PARENT_GRAPH, ENABLE_RECOMMENDATIONS, LLM_PROVIDER. Тест.
- [ ] **8.4** 🤖→🧑 Реализовать **Weekly Edge Weight Update** (batch job, Blueprint §4.4): Cypher-запрос обновления весов ENABLES-связей по агрегированным данным. Cron/Cloud Scheduler. Тест.
  - 🤖 Агент: написать Cypher-запрос, endpoint `/api/v1/admin/update-weights`, скрипт для cron.
  - 🧑 Разработчик: создать Cloud Scheduler job в GCP Console (расписание, target URL, auth).
- [ ] **8.5** Фронтенд: **Оптимизация Onboarding Flow** (секция H мастер-плана):
  - Guided onboarding уже создан в Блоке 1 (задача 1.21). В этом блоке — **оптимизация на основе GA4-данных**: анализ воронки `onboarding_step_1..N`, корректировка шагов, текстов, порядка.
  - A/B тестирование вариантов (если объём пользователей позволяет).
  - Тесты.
- [ ] **8.6** Фронтенд: **Admin Panel** (`/admin`):
  - Дашборд (семьи, записи, сигналы).
  - Очередь Red Flags.
  - Очередь Q&A.
  - Управление семьями (entitlements).
  - Тесты.
- [ ] **8.7** 🤖→🧑 **Финальная ревизия observability** (секция F мастер-плана):
  - Проверить полноту: error tracking (Блок 0), distributed tracing (Блок 1), error context + alerting + runbook (Блок 2), circuit breaker + LLM observability + retry/DLQ (Блок 4), Q&A observability (Блок 7) — всё на месте и работает.
  - Добавить **бизнес-метрики**: signal confidence avg > 0.70, extraction quality (% confirmed), daily active families, diary entries per day.
  - Настроить **Slack-интеграцию** для алертов (помимо email из Блока 2).
  - 🤖 Агент: написать конфигурации дополнительных метрик и алертов, дашборд-конфигурацию.
  - 🧑 Разработчик: создать Slack webhook (Slack UI), подключить notification channels в GCP Console (Cloud Monitoring → Alerting → Notification Channels), настроить alert policies.
  - Опционально: **canary deployment** — новая ревизия получает 5% трафика, при spike error rate → авто-откат.
- [ ] **8.7.1** **GA4 → BigQuery export** (секция H.6 мастер-плана): настроить streaming export GA4-событий в BigQuery. Создать 5 дашбордов в Looker Studio: (1) Activation funnel, (2) Retention cohorts (D1/D7/D30), (3) Feature adoption, (4) LLM quality (confidence, confirmation rate), (5) LLM cost (daily total, per family, per extraction). Документация: `/docs/analytics.md`.
- [ ] **8.7.2** **NPS micro-survey** (секция H.7 мастер-плана): in-app опрос (1 вопрос, dismissible) для активных семей (≥7 дней, ≥3 diary entries). Не чаще раза в месяц. Результаты в PG + дашборд. GA4-событие: `nps_survey_response`. Тест.
  - Тест.
- [ ] **8.8** 🧑 Реализовать **Push Notifications** (опционально, для Confirmation Flow): VAPID keys, subscription API. Только для подтверждения сигналов, не маркетинг.
  - 🧑 Разработчик: сгенерировать VAPID keys (`web-push generate-vapid-keys`), сохранить в Secret Manager.
  - 🤖 Агент: реализовать subscription API и push-отправку. Тест.
- [ ] **8.9** **E2E-тесты** (Playwright):
  - Регистрация → Вход → Граф → Рекомендации → Дневник → Сигналы.
  - Рекомендация → Принять → Завершить → Рефлексия.
- [ ] **8.10** **Финальная документация**:
  - Полная ревизия всей документации: README, AGENTS.md, API docs, pipeline docs, ADRs, deployment guide.
  - README.md → production-ready (описание, архитектура, быстрый старт, ссылки).
  - AGENTS.md → обновлён под финальную структуру проекта (включая секции Observability, Privacy, Performance, Accessibility).
  - Финальная ревизия privacy (секция G): все права реализованы, все точки утечки закрыты, правовые документы актуальны.
  - Финальный Lighthouse-аудит (секция I): все страницы проходят бюджеты.
  - Финальный a11y-аудит (секция J): axe-core на всех страницах, ручная проверка keyboard nav.
  - Финальная ревизия backup/DR (секция K): скрипты работают, restore протестирован.
  - Финальная запись в CHANGELOG.md: «MVP complete — Full Value Loop».
  - Финальная ревизия **`/docs/operations.md`** (runbook, ведётся с Блока 2): полнота инцидент-секций, актуальность команд, покрытие всех компонентов, DR-секция.

### Definition of Done

- Новая семья проходит полный onboarding за 3 минуты. Onboarding оптимизирован на основе GA4-данных воронки.
- Admin panel управляет семьями, red flags, Q&A.
- **Observability полная** (секция F): error tracking, distributed tracing, error context, circuit breaker, LLM observability, retry/DLQ, alerting (email + Slack), бизнес-метрики, runbook.
- **Product analytics** полная (секция H): GA4 → BigQuery export, 5 дашбордов (activation, retention, feature adoption, LLM quality, LLM cost). NPS micro-survey.
- **Privacy** полная (секция G): все права реализованы, все точки утечки закрыты, документы актуальны, retention cleanup работает.
- **Performance** подтверждена (секция I): финальный Lighthouse-аудит всех страниц.
- **a11y** подтверждена (секция J): axe-core на всех страницах, ручная проверка keyboard nav.
- **Backup & DR** подтверждены (секция K): backup-скрипты работают, restore протестирован, runbook актуален.
- Rate limiting работает (soft limits).
- E2E-тесты проходят **на staging** перед каждым production-деплоем.
- Система готова принять 10–50 семей.
- Все тесты: backend total ≥ 130, frontend total ≥ 75.
- CI/CD: push → tests → staging → manual promotion → production.
- Линтеры, type-check — зелёные.
- **Документация полная**: README, AGENTS.md, все API docs, все pipeline docs, все ADR, deployment guide, operations runbook (финальная ревизия), analytics docs, CHANGELOG.

**⏸ СТОП — MVP достигнут. Переход к Stage 1 по мере набора пользователей.**

---

## Сводка

| Блок | Название | Backend тесты | Frontend тесты | Ключевая ценность |
|------|----------|:---:|:---:|---|
| 0 | Фундамент | ~5 | ~2 | Рельсы для разработки + базовая observability + Lighthouse CI + axe-core |
| 1 | Auth + Профили + Трекер | ≥26 | ≥17 | Аккаунт + трекер + privacy (DELETE/export) + guided onboarding + GA4 с custom dimensions |
| 2 | Граф развития + Прод | ≥12 | ≥10 | «Я вижу, как растёт мой ребёнок» + альтернативный вид графа + backup/DR + feedback + production |
| 3 | Рекомендации | ≥12 | ≥9 | «Что делать дальше?» + экспорт отчёта ребёнка |
| 4 | Дневник + Сигналы | ≥28 | ≥14 | «Я записываю, и система понимает» + LLM cost management + retention cleanup |
| 5 | Рефлексия + Граф родителя | ≥10 | ≥6 | «Я расту вместе с ребёнком» |
| 6 | Safety + Governance | ≥15 | ≥3 | «Мне спокойно и безопасно» |
| 7 | Q&A + сигналы из вопросов | ≥20 | ≥6 | «Могу спросить эксперта» + сигналы обогащают графы + Q&A resilience |
| 8 | Масштабирование | ≥8 | ≥12 | Onboarding-оптимизация, admin, GA4→BigQuery, NPS, финальные ревизии (observability, privacy, performance, a11y, backup) |
| **Итого** | | **≥136** | **≥79** | **Full Value Loop MVP** |

---

## Принципы работы с планом

1. **Инкрементальная миграция**: текущее приложение остаётся доступным, пока новая версия не воспроизведёт всю его функциональность (Блок 1).
2. **Портирование, не пересоздание**: существующие UX-паттерны (модалки навыков, фильтры, аккордеон, навигация по prerequisites) переносятся 1:1, не изобретаются заново.
3. **Данные навыков — готовый актив**: 174 навыка с описаниями, критериями, активностями, связями — уже есть. Это основа для Neo4j-графа, LLM-контекста и рекомендаций.
4. **GA4-аналитика сохраняется**: все существующие события переносятся в новый фронтенд для непрерывности данных.
5. **GCP-инфраструктура расширяется**: существующий Cloud Run + Cloud Build дополняется Cloud SQL и Neo4j Aura, не заменяется.
6. **Тесты идут с кодом и направляют разработку**: каждая задача включает тесты. Результат тестов — обратная связь: если тесты падают, агент анализирует вывод, дорабатывает код и повторяет, пока не станет зелёным. Тесты должны быть содержательными (поведение, edge cases, error paths), а не формальными. См. секцию E.
7. **Атомарные коммиты**: каждый шаг (N.M) завершается коммитом при зелёных тестах и чистых линтерах. Push — в staging-ветку после логической группы задач, не в main. Commit messages — на английском, в формате Conventional Commits с номером задачи. См. секцию D.
8. **Остановка после блока**: ожидание проверки человеком.
9. **Graceful degradation**: дневник работает, даже если LLM упал; трекер работает, даже если Neo4j медленный. Circuit breaker и fallback-стратегии для каждой внешней зависимости. См. секцию F.
10. **Tenant isolation с первого дня**: family_id/child_id в каждом запросе.
11. **Staging перед production**: каждый деплой сначала идёт на staging, проверяется (вручную + автотесты), и только потом промоутится в production.
12. **Документация — параллельный артефакт**: каждый блок оставляет за собой актуальные README, API docs, ADR, CHANGELOG. Блок не считается завершённым без актуальной документации.
13. **Разделение ответственности агент/разработчик**: задачи размечены маркерами (🧑 / 🤖→🧑). Агент останавливается на задачах, требующих ручных действий (веб-интерфейсы, credentials, smoke tests), передаёт инструкции и ждёт подтверждения. См. секцию C.
14. **Observability с первого продакшн-кода**: error tracking, structured logging, distributed tracing, deep health checks — не финальный штрих, а инфраструктура, которая строится инкрементально начиная с Блока 0. При ошибке в production система автоматически формирует структурированный контекст, пригодный для передачи AI-агенту. См. секцию F.
15. **Privacy by design**: PII не попадает в логи, аналитику, LLM-ответы (кроме целевой обработки). Права пользователя (удаление, экспорт) реализованы с первого блока, где есть аккаунты (Блок 1). Правовые документы (Privacy Policy, ToS) доступны до регистрации. Согласие фиксируется в consent_log. См. секцию G.
16. **Performance не хуже текущей PWA**: Lighthouse CI в CI pipeline, bundle budget < 200KB, optimistic updates, skeleton screens. Регрессия производительности = failing build. Финальный аудит на staging в каждом блоке. См. секцию I.
17. **Accessibility baseline**: WCAG AA контраст, touch targets ≥44×44px, семантический HTML, keyboard navigation, альтернативные представления для визуализаций. a11y-чеклист — часть Definition of Done каждой UI-задачи. axe-core в CI. См. секцию J.
