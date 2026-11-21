# Herdr setup

Моя настройка [Herdr](https://herdr.dev): раскладка окна, моды, темы и два скрипта. Herdr читает настройку из папки `~/.config/herdr-app` и подхватывает правку файла примерно через секунду, поэтому этот репозиторий клонируется прямо туда. Всё, что относится к конкретным машинам, аккаунтам и сетям, вынесено в файлы, которых в git нет: их создаёт `install.sh` из примеров, а заполняешь ты сам.

## Установка на свежий Herdr

Herdr при первом запуске сам создаёт `~/.config/herdr-app` со своими встроенными модами и раскладками. Они перечислены в `.gitignore` и с репозиторием не пересекаются, поэтому репозиторий кладётся поверх:

```sh
cd ~/.config/herdr-app
git init -b main
git remote add origin https://github.com/bulbetski/herdr-setup.git
git fetch origin
git checkout -t origin/main
./install.sh
```

Если в папке уже есть свои `keys.json`, `settings.json` или раскладки с теми же именами, `git checkout` откажется их перезаписывать. Тогда сначала перенеси их в сторону.

`install.sh` можно запускать сколько угодно раз, существующие файлы он не трогает. Что он делает:

- ставит ссылки `~/.local/bin/herdr-task`, `~/.local/bin/ssh-browser` и `~/.local/bin/ssh-add-host` на скрипты из `bin/`;
- ставит ссылки на темы Claude Code из `claude-themes/` в `~/.claude/themes/`;
- создаёт из примеров свои настройки: `programs.json`, `mods/tasks/config.json`, `~/.config/ssh-browser/config`;
- проверяет, есть ли программы, которые нужны модам (`python3`, `git`, `node`, `mmdc`, `sips`, `claude`, `codex`).

Потом остаётся заполнить настройки (см. ниже), включить раскладку `main-copy` (`cmd-shift-l`) и проверить `herdr-app status`: в ответе не должно быть `errors`.

Часть модов рассчитана на macOS: картинки и PDF в Explorer рисуются через `sips` и PDFKit, «Открыть в приложении» в Tasks идёт через `open`.

## Что в репозитории

- `layouts/main-copy.json`: раскладка окна. Это клон встроенной `main`, где часть мест заняли моды отсюда.
- `mods/`: моды, таблица ниже.
- `bin/herdr-task`: задачи для команды агентов, на нём работает мод Tasks.
- `bin/ssh-browser`: Chrome, который ходит на выбранные сайты через SSH-туннель.
- `bin/ssh-add-host`: вход на машину по ключу вместо пароля, на нём работает диалог Add machine.
- `themes/whitby-*.json`: светлая и тёмная темы окна из [herdr-whitby](https://github.com/shellscape/herdr-whitby). `themes/atom-one-dark.json`: палитра One Dark.
- `claude-themes/whitby-*.json`: темы Claude Code в цветах Whitby (`"theme": "custom:whitby-light"` в `~/.claude/settings.json`).
- `keys.json`, `settings.json`: клавиши и настройки окна. `minimum_contrast: 2` нужен светлой теме, иначе бледный текст агентов на белом фоне не виден.
- `programs.example.json`: агенты в меню новой вкладки.
- `install.sh`, `LICENSE`, этот README.

## Раскладка

| Место | Мод |
|---|---|
| Сайдбар | `space-folders`: спейсы по папкам, в шапке Spaces кнопки «+ssh» (Add machine), New folder, New space; сверху и снизу `workspace-chrome-plus` (внизу только Settings) |
| Колонка слева | `file-preview` с `mode: "tree"`: Explorer |
| Панель вкладок | `tabs-plus`: вкладки и кнопки Explorer, Tasks (и MRs, Worklog, если эти моды установлены) |
| Статус-бар слева | `workspace-status-plus`: машина спейса и состояние связи с ней |
| Статус-бар справа | `tps`, `ssh-browser`, `usage-limits` |

Если раскладка сломалась, `ctrl-alt-shift-escape` возвращает окно к встроенной, а `cmd-shift-l` обратно к своей.

## Моды

| Мод | Откуда | Что делает |
|---|---|---|
| `file-preview`, `file-preview-panel` | [bborrero14/herdr-file-preview](https://github.com/bborrero14/herdr-file-preview), сильно переделан | Explorer: дерево файлов, просмотр и правка во вкладке |
| `space-folders` | [jankeesvw/herdr-space-folders](https://github.com/jankeesvw/herdr-space-folders), доработан | Папки спейсов в сайдбаре, кнопка ↻ у машины без связи |
| `herdr-md` | [ryanthedev/herdr-md](https://github.com/ryanthedev/herdr-md), без правок | `mdh open файл.md`: Markdown с Mermaid |
| `usage-limits` | [nozikov/herdr-usage-limits](https://github.com/nozikov/herdr-usage-limits), без правок | Лимиты Claude и Codex |
| `auto-title` | [kryptamine/herdr-auto-title](https://github.com/kryptamine/herdr-auto-title), без правок | Называет вкладки по тому, что в них происходит; свой сервис ставится из его окна |
| `tabs-plus` | клон встроенного `tabs` | Кнопки Explorer, Tasks, MRs, Worklog; спрятанные вкладки не показываются |
| `new-menu-plus` | клон встроенного `new-menu` | Меню «+» без встроенных Claude Code и Codex: остаются свои обёртки из `programs.json` |
| `workspace-status-plus` | клон встроенного `workspace-status` | Состояние связи с машиной спейса и ↻ Reconnect |
| `machine-add-plus` | переписанный встроенный `machine-add` | Диалог Add machine: список машин и форма, вход по ключу вместо пароля, см. «Новая машина по ключу» |
| `workspace-chrome-plus` | клон встроенного `workspace-chrome` | Шапка и низ сайдбара; строки Add machine внизу нет, она переехала в шапку Spaces |
| `conn-details` | свой | Полный текст последней ошибки связи: Copy, ↻ Reconnect |
| `tasks` | свой | Задачи для команды агентов, доска YouTrack |
| `ssh-browser` | свой | Состояние `ssh-browser` в статус-баре |
| `tps` | свой | Токены в секунду у агента в фокусе |

### Explorer

Файлы как в IDE: дерево в колонке слева, открытый файл во вкладке спейса. Колонка прячется кнопкой Explorer или `cmd-e`, `cmd-shift-e` открывает мод целиком поверх окна. Папка колонки следует за терминалом в фокусе, в том числе на другой машине.

- Вкладки колонки: Files и Changes (только в git-репозитории). Справа текущая ветка: клик показывает ветки, выбор делает `git switch`.
- Клик по файлу открывает его во вкладке; если файл уже открыт, кнопка переходит в его вкладку.
- Показывает Markdown, подсветку кода, Mermaid (`.mmd`), SVG, картинки (png, jpg, gif, webp, heic и другие), PDF (первые 150 страниц) и HTML (снимок страницы шириной 1280 px). У Markdown, HTML, SVG, Mermaid и PDF есть переключатель Preview | Source.
- Любой текстовый файл правится прямо во вкладке, правка пишется в файл примерно через секунду после того, как перестал печатать. Если файл в это время поменялся на диске, появляется «Changed on disk» с Reload и Overwrite.
- В git-репозитории слева от номеров строк видно изменённые строки, в дереве цветом помечены изменённые, новые и неотслеживаемые файлы.
- Поиск: лупа в шапке, `⌘F` или `/` в дереве. Ищет файлы и папки по нечёткому совпадению с путём. Файл из результатов открывается во вкладке, папка раскрывается в дереве. Правый клик по результату открывает то же меню, что и в дереве, а результат можно перетащить на найденную папку.
- Правый клик в дереве: New file, New folder, Rename, Duplicate, Copy, Cut, Paste, Open in terminal, Copy path, Insert path into terminal, Reveal in Finder, Move to Trash. Open in terminal открывает в спейсе новую вкладку-терминал в этой папке (у файла в его папке), на удалённой машине тоже. Клавиши F2, ⌘C, ⌘X, ⌘V, ⌘⌫, ⌘D, ⌘Z (отмена до 50 операций). Удаление идёт в корзину, ничего не перезаписывается.
- Перетаскивание строки на папку переносит файл, с ⌥ копирует. Файлы из Finder копируются в папку, на другую машину через `scp`.
- Mermaid рисует `mmdc` (`npm install -g @mermaid-js/mermaid-cli`), SVG и HTML рисует headless Chrome. Готовые картинки лежат в `mods/file-preview/.cache/`.

### Tasks: задачи для команды агентов

Кнопка Tasks в панели вкладок. Задача получает свою папку, ветку в нужных репозиториях (git worktree) и отдельный спейс, где работают агенты. Те же задачи заводит агент в чате командой `herdr-task start`.

Как устроено:

- Неймспейс это группа репозиториев на одной машине: своя папка с клонами, своя папка задач, свои обёртки агентов и агенты для ролей по умолчанию. Неймспейсы задаются в `mods/tasks/config.json`, окно показывает их переключателем в шапке.
- «+ Новая задача»: название, ключ (пусто: `T-<дата>`), задание агенту, репозитории (угаданные по тексту отмечены •), команда и материалы для чтения. «Взять в работу» создаёт папку задачи с `TASK.md`, worktree ветки `KEY/название` в каждом репозитории и спейс с агентами.
- Пресеты команды: `solo` (исполнитель), `pair` (исполнитель и ревьюер), `trio` (исполнитель, ревьюер, тестировщик). У каждой роли Claude или Codex и своя модель. Агенты пишут друг другу через `hc send`, адреса лежат в `team.json` задачи. Брифы ролей в `mods/tasks/roles/`.
- Агентам нельзя пушить и открывать MR. Агенты запускаются без песочницы и подтверждений (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`), учитывай это.
- Заведённая задача показывает команду, репозитории и все разговоры агентов. Идущий разговор открывает свою вкладку, закончившийся продолжается в новой. «Новый чат» открывает ещё одного агента в папке задачи.
- YouTrack (по желанию): у одного неймспейса может быть доска, текущий спринт которой показывается таблицей. Задачу с доски можно взять в работу: описание, комментарии и выбранные вложения уходят агентам, картинки приходят с первым сообщением. YouTrack только читается, запросов кроме GET нет.

Всё делает `bin/herdr-task` (Python 3, хватает системного 3.9): `start`, `open`, `edit` (добавить или убрать репозиторий и контекст у заведённой задачи: worktree, `meta.json`, списки в `TASK.md`, агентам уходит сообщение), `ls`, `sessions`, `chat`, `board`, `issue`, `files`, `repos`, `presets`. Если неймспейс на другой машине, скрипт передаёт сам себя в `hc exec --on <машина> python3 -`, так что ставить там ничего не нужно.

### ssh-browser

Отдельный профиль Chrome, в котором выбранные домены и подсети идут через SSH SOCKS-туннель на другую машину, а всё остальное идёт как обычно. Это нужно, когда внутренние сайты открываются только с машины внутри сети (за корпоративным VPN), а на своём компьютере VPN держать не хочется. На удалённой машине ничего настраивать не нужно, root не нужен.

- `ssh-browser [url]` открывает профиль и поднимает туннель (`ssh -D`), туннель живёт, пока профиль открыт.
- `--status` печатает `off`, `down`, `nocorp` (туннель есть, а проверочная страница не отвечает) или `up`; `--tunnel` поднимает лежащий туннель, `--reconnect` переподнимает.
- Мод `ssh-browser` в статус-баре раз в 15 секунд спрашивает `--status`, сам поднимает упавший туннель и по клику чинит или открывает браузер.

### Новая машина по ключу

Кнопка «+ssh» в шапке Spaces (рядом с New folder и New space) открывает диалог `machine-add-plus`. От встроенного диалога Herdr в нём осталось только чтение `~/.ssh/config`, остальное написано заново.

- Слева список: New machine, машины, которые уже есть в Herdr (с точкой состояния: зелёная, если связь есть), и хосты из `~/.ssh/config`, которых в Herdr ещё нет. Справа форма для выбранного.
- New machine: адрес (можно сразу `user@host:port`), порт, пользователь, имя. Пустое имя берётся из адреса. Ниже три способа входа. «Make a key»: пароль один раз, дальше вход по ключу; под паролем видно блок, который уйдёт в `~/.ssh/config`. «Password only»: ключ не создаётся и ничего не сохраняется, пароль уходит в `hc machine add` через `SSH_ASKPASS` (`ssh-add-host herdr-add`), а при каждом переподключении Herdr спросит его снова. «Already set up»: ssh уже пускает, машина просто добавляется (`hc machine add ... --install`). Подсказки в полях диалог рисует сам, бледным цветом: встроенная подсказка поля берёт цвет текста.
- Хост из `~/.ssh/config`: те же карточки. При входе по ключу в его запись добавляется только `IdentityFile`.
- Машина из Herdr: состояние, версия hc там, кнопка «New space on <имя>».
- После Connect справа идут шаги, каждый со своим состоянием: ключ хоста, ключ на Mac, публичный ключ на машине, `~/.ssh/config`, вход без пароля, добавление в Herdr. Если машину этот компьютер ещё не видел, на первом шаге показывается отпечаток ED25519 и кнопки «Trust and continue» и «Not this one». Сверить его можно с `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` на самой машине. Если шаг упал, под ним текст ошибки (у шага Herdr ещё команда с кнопками Copy и «In a terminal», которая открывает её во вкладке, где пароль вводится руками), а внизу «Back to the form» и «Try again» (повтор продолжает с упавшего шага). В конце «<имя> is ready» и «New space on <имя>».
- Шаги делает `bin/ssh-add-host setup --step <шаг>`. Ключ создаётся в `~/.ssh/keys/id_ed25519_<имя>` (в `~/.ssh/`, если папки `keys` нет; готовый ключ с таким именем берётся как есть). Публичный ключ дописывается в `~/.ssh/authorized_keys` на машине один раз, с правами 700/600. `Host <имя>` с `IdentityFile` и `IdentitiesOnly yes` встаёт в `~/.ssh/config` перед первым `Host`. Проверка: `ssh -o BatchMode=yes <имя> true`. Herdr добавляет машину с `--install`, то есть копирует туда herdr-core, если его нет.
- Перед правкой `~/.ssh/config` старая версия копируется в `~/.backups/ssh-config-before-ssh-add-host-<дата>`.
- Пароль нигде не сохраняется. Диалог пишет его во временную папку с правами 700, скрипт сразу удаляет файл и отдаёт пароль `ssh` через переменную окружения своего помощника `SSH_ASKPASS` (`SSH_ASKPASS_REQUIRE=force`, OpenSSH 8.4+), так что `sshpass` не нужен.
- Если машина пароли не принимает (`Permission denied (publickey)`), шаг так и пишет: ключ туда должен положить её администратор.
- Из терминала: `ssh-add-host setup --name vps --host root@203.0.113.5 [-p 2222] [--add-machine]` сам спросит пароль и подтверждение ключа хоста; `ssh-add-host scan <хост>` показывает отпечатки.

## Настройка

### `mods/tasks/config.json`

Пример лежит в `mods/tasks/config.example.json`. Главное в нём:

```json
{
  "namespaces": {
    "work": {
      "label": "Work",
      "machine": "",
      "repos": "~/src/work",
      "tasks": "~/src/work/.tasks",
      "wrappers": { "claude": "claude", "codex": "codex" },
      "roles": { "impl": "claude", "review": "codex", "qa": "claude" },
      "docs": { "clone": "docs", "always": [], "per_repo": "services/{repo}" }
    }
  }
}
```

- `machine`: пусто для этого компьютера, иначе имя машины в Herdr (как в `hc exec --on`).
- `repos`: папка, где искать git-клоны (до трёх уровней вглубь). `tasks`: куда класть папки задач.
- `wrappers`: чем запускать агентов. Это может быть голый `claude` или своя обёртка, которая подставляет аккаунт, прокси или окружение неймспейса.
- `roles`: агент роли по умолчанию, строка `"claude"` или `{"agent": "codex", "model": "...", "effort": "high"}`.
- `docs` (необязательно): клон с документацией. Страницы `always` и `per_repo` (с `{repo}` вместо имени репозитория) уходят агентам как материалы, если в задаче выбраны репозитории.
- `models`: списки моделей для выбора в окне. `presets`: составы команды и файлы хода работы.
- `open_with`: какие ссылки открывать не в браузере по умолчанию, например `[{"domains": ["corp.example.com"], "run": "~/.local/bin/ssh-browser"}]`.

YouTrack включается секцией `youtrack`:

```json
{
  "youtrack": {
    "ns": "work",
    "board": "83-123",
    "env": "~/.config/youtrack-cli/.env",
    "fields": { "state": "State", "dev": "Assignee", "priority": "Priority", "type": "Type", "products": "" },
    "done": ["Fixed", "Verified", "Done"],
    "products": {}
  }
}
```

- `ns`: неймспейс доски; токен и запросы работают на его машине. `board`: id agile-доски (из её адреса).
- `env`: файл с `YOUTRACK_BASE_URL` и `YOUTRACK_TOKEN`, по умолчанию тот же, что у [youtrack-cli](https://pypi.org/project/youtrack-cli/) (`yt auth login`). Токен создаётся в YouTrack: Profile → Account Security → Tokens.
- `fields`: имена своих полей доски, если они называются не как по умолчанию в YouTrack.
- `done`: статусы, которые прячутся за «Показать завершённые».
- `products`: для каждого значения поля `products` список репозиториев; по нему угадываются репозитории задачи.

### `~/.config/ssh-browser/config`

Пример в `bin/ssh-browser.example.conf`: SSH-хост из `~/.ssh/config`, подпись в статус-баре, домены и подсети для туннеля, проверочная страница, куда отправлять остальное (`DIRECT` или локальный прокси), порт и имя профиля Chrome.

### `programs.json`

Агенты в меню новой вкладки. Пример запускает голые `claude` и `codex`, сюда же добавляются свои обёртки.

## Redline и Worklog

Кнопки MRs и Worklog в панели вкладок появляются, только если в `mods/` есть моды `redline` и `worklog`. В репозитории их нет:

- [Redline](https://github.com/iampedii/herdr-redline), ревью MR и PR рядом с агентом, у меня сильно доработан, но у исходного репозитория нет лицензии, поэтому доработки не публикуются. Поставить можно из исходного репозитория по его инструкции. Если Redline стоит, `herdr-task` кладёт над исполнителем задачи его панель (репозитории, Create MRs).
- Worklog, сводка сделанного агентами, завязан на мои личные инструменты.

## Как менять

1. Свежая справка Herdr: `herdr-app --skill`, `hc --skill`, `AGENTS.md` в этой папке (его переписывает сам Herdr).
2. Встроенные моды и раскладки Herdr заменяет при каждом запуске. Их не правят, а клонируют (`herdr-app do mod.clone --name X --as X-plus`) и подключают клон в `layouts/main-copy.json`.
3. После правки мода: `herdr-app check mods/<мод>`, `herdr-app status` (без `errors`), `herdr-app shot` для скриншота.

## Лицензии

Моё в этом репозитории под MIT, см. `LICENSE`. У взятого чужого своя лицензия, текст лежит рядом:

- `file-preview`, `file-preview-panel`, `space-folders`, `herdr-md`, `usage-limits`, `auto-title`: MIT, `LICENSE` в папке мода, с копирайтом автора.
- `tabs-plus`, `new-menu-plus`, `workspace-status-plus`, `machine-add-plus`, `workspace-chrome-plus`: клоны модов Herdr, Apache-2.0, `LICENSE` в папке мода, в начале `main.js` отмечено, что файл изменён.
- Темы Whitby (`themes/whitby-*.json`, `claude-themes/whitby-*.json`): MPL-2.0, `LICENSE-whitby` рядом.
- `herdr-md/marked.js`: библиотека marked, её лицензия в `marked.LICENSE.md`.

## Sources

- [herdr.dev](https://herdr.dev): Herdr, его моды и раскладки; app и herdr-core под Apache-2.0 ([herdrdev/herdr-app](https://github.com/herdrdev/herdr-app)).
- `AGENTS.md`, `herdr-app --skill`, `hc --skill`: устройство модов, команды `herdr-app do`, `hc exec`, `hc send`.
- Репозитории модов из таблицы выше: исходный код и лицензии.
- [ssh(1)](https://man.openbsd.org/ssh), [ssh-keyscan(1)](https://man.openbsd.org/ssh-keyscan): `SSH_ASKPASS_REQUIRE`, `-G`, формат `known_hosts`.
- [shellscape/herdr-whitby](https://github.com/shellscape/herdr-whitby): темы, MPL-2.0.
- [YouTrack REST API](https://www.jetbrains.com/help/youtrack/devportal/youtrack-rest-api.html): `/api/agiles`, `/api/issues`, `/api/issues/<KEY>/comments`, только чтение.
- [youtrack-cli](https://pypi.org/project/youtrack-cli/): формат файла с токеном.
