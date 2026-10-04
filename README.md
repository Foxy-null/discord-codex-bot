# Discord Codex Bot

Discord のスレッドから Codex CLI を動かすための Bot です。

`/start owner/repo` で GitHub
リポジトリごとの作業スレッドを作成し、そのスレッドに投稿されたメッセージを Codex
CLI へ渡します。Codex の途中出力と最終応答は Discord
に返され、同じスレッド内では Codex セッションを継続できます。

## できること

- Discord のスラッシュコマンドから作業スレッドを作成
- `owner/repo` 形式の GitHub リポジトリを clone / update
- スレッドごとに独立した作業ディレクトリと Codex セッションを管理
- 通常メッセージと画像添付を Codex CLI に転送
- Codex の JSON ストリームを Discord 向けに整形して返信
- Codex が成果物として指定した画像・PDF・ZIPなどのファイルを Discord に添付
- 実行中 Codex の中断、プランモード、スレッドのクローズ
- Bot 再起動後のアクティブスレッド復旧
- 応答完了後に作業ブランチのコミットを自動プッシュ

## Codex BOT 使い方

Bot を使う人向けの基本操作だよ。

- `/start repository:<GitHubの名前/レポジトリ名> auto_push:<true|false> language:<言語>`:
  作業用スレッドを作るよ。レポジトリをクローンしてそのスレッド専用の作業用フォルダを作り
  Codex がその中で依頼を実行するよ。
  - 例: `/start repository:pikachu0310/discord-codex-bot`
  - `auto_push` は省略可能で、既定値は `true`。各依頼の正常終了後に、
    コミット済みの変更を自動プッシュするよ。サーバー上の作業内容を別環境で取得して確認できるよ。
  - 自動プッシュを無効にする例:
    `/start repository:pikachu0310/discord-codex-bot auto_push:false`
  - 任意の `language`
    でコミットメッセージ・PRタイトル・PR本文の言語を共通指定できるよ。 例:
    `/start repository:owner/repo language:en`。
    省略した場合は、そのスレッドでやり取りしている言語を使うよ。
  - スレッドにメッセージを投稿: その内容が Codex
    への依頼になるよ。修正や実装、調査や説明依頼などをそのまま書けるよ。
  - スレッドに画像やファイルを添付: 添付ファイルも Codex
    に渡せるよ。送信できない巨大な指示をテキストファイルで送ったり、スクショやファイルなどを渡したい時に使えるよ。
  - スレッド内では `!` から始まるメッセージに Bot
    は反応しないよ。ユーザー同士で会話したい時に使えるよ。
- `/stop`: そのスレッドで実行中の Codex
  を止めるよ。間違えたときや処理を中断したい時に使うよ。
- `/plan`:
  そのスレッドをプランモードにするよ。いきなり実装せず、まず方針や作業計画を出してほしい時に使うよ。
- `/active-threads`:
  まだ生きている作業スレッドを確認するよ。各アクティブスレッドから、コマンドを実行した人宛てに
  silent mention が送られるよ。
- `/close`:
  その作業スレッドを終了するよ。作業コピーを片付けて容量を空け、Discord
  のスレッドもクローズするよ。

## 必須コマンド

Bot を起動・運用するホストには次のコマンドが必要です。

| コマンド | 必須 | 用途                                                                                                         |
| -------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| `deno`   | 必須 | Bot 本体の起動、型チェック、テスト実行に使います。Deno 2 系を想定しています。                                |
| `git`    | 必須 | 対象リポジトリの clone / fetch / checkout / 作業ブランチ作成に使います。                                     |
| `codex`  | 必須 | Discord から受け取った依頼を実行する Codex CLI です。                                                        |
| `gh`     | 任意 | Bot 本体の起動には不要です。リポジトリ管理やこのプロジェクトの PR 作成など、開発・運用補助で使うと便利です。 |

起動時のシステムチェックでは `git` と `codex` を検査します。`deno` は
`deno task start` 自体の実行に必要です。

インストール例:

```bash
# Deno
curl -fsSL https://deno.land/install.sh | sh

# Codex CLI
npm install -g @openai/codex
codex --login

# GitHub CLI（任意）
brew install gh
gh auth login
```

`git` は OS のパッケージマネージャ、または https://git-scm.com/downloads
から導入してください。

## Discord 側の準備

1. Discord Developer Portal で Application を作成します。
2. Bot を作成し、Bot Token を取得します。
3. Bot に必要な Intent を有効化します。
   - Server Members Intent は不要です。
   - Message Content Intent はスレッド内メッセージを読むために必要です。
4. OAuth2 URL Generator で `bot` と `applications.commands` scope を選び、Bot
   をサーバーへ招待します。
5. Bot 権限として、少なくとも次を付与します。
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Attach Files
   - Create Public Threads
   - Read Message History
   - Add Reactions
   - Manage Threads（`/close` を使う場合）

## セットアップ

```bash
git clone <this-repository-url>
cd discord-codex-bot

cp .env.example .env
$EDITOR .env

deno task start
```

`.env` には最低限 `DISCORD_TOKEN` と `WORK_BASE_DIR` を設定します。

```dotenv
DISCORD_TOKEN=your_discord_bot_token_here
WORK_BASE_DIR=/absolute/path/to/codex-bot-work
CODEX_STATUS_TIME_ZONE=Asia/Tokyo
CODEX_THREAD_NAMING_MODEL=gpt-5.6-luna
CODEX_THREAD_NAMING_INSTRUCTIONS="threadNameは日本語、branchSlugは英語で作成してください"
```

`WORK_BASE_DIR` は絶対パスを推奨します。`.env` 内の `~`
はシェルのようには展開されないため、`/home/your-user/codex-bot-work`
のように書いてください。

## 環境変数

| 変数                               | 必須 | 説明                                                                      |
| ---------------------------------- | ---- | ------------------------------------------------------------------------- |
| `DISCORD_TOKEN`                    | 必須 | Discord Bot Token。                                                       |
| `WORK_BASE_DIR`                    | 必須 | Bot がリポジトリ、作業コピー、スレッド状態、ログを保存するディレクトリ。  |
| `CODEX_APPEND_SYSTEM_PROMPT`       | 任意 | Codex CLI に渡す追加システムプロンプト。Bot 全体で共通適用されます。      |
| `CODEX_STATUS_TIME_ZONE`           | 任意 | Codex limit reset 時刻の表示タイムゾーン。例: `Asia/Tokyo`。              |
| `CODEX_THREAD_NAMING_MODEL`        | 任意 | 初回応答後のスレッド・ブランチ名生成モデル。既定: `gpt-5.6-luna`。        |
| `CODEX_THREAD_NAMING_INSTRUCTIONS` | 任意 | スレッド名と `/` 以降のブランチ名について、言語や表現を指定する追加指示。 |

## 詳しい使い方

### 1. 作業スレッドを作る

Discord の通常チャンネルで次を実行します。

```text
/start repository:owner/repo
```

コミットメッセージ・PRタイトル・PR本文の言語を指定する場合は、任意の `language`
を追加します。

```text
/start repository:owner/repo language:en
```

`ja`、`en`、`日本語`、`English`
などを自由入力できます。前後の空白を除いた値を保存し、
空白だけの指定は省略扱いにします。指定はスレッドごとに保持し、Bot再起動後も引き継ぎます。
省略した場合は、コードや引用文、Botの通知ではなく、ユーザーの会話から言語を判断します。
会話の言語が変わった場合も、その会話に従います。

この指定はコミット・PRにのみ適用し、Botの応答やスレッド・ブランチ名の言語設定には影響しません。
言語方針は各依頼とともにCodexへ渡します。

引数順は `repository` → `auto_push` → `language` です。 `auto_push` と
`language` はどちらも省略できます。両方を指定する例:

```text
/start repository:owner/repo auto_push:false language:en
```

Bot は対象リポジトリを `WORK_BASE_DIR/repositories/` に clone
します。すでに存在する場合は fetch
してデフォルトブランチへ更新します。その後、Discord
スレッドを作成し、スレッド専用の作業コピーを `WORK_BASE_DIR/worktrees/`
に用意します。

第 2 引数の `auto_push` は省略可能な boolean で、既定値は `true` です。
設定はスレッドごとに保存され、Bot の再起動後も維持されます。
この機能の追加前に作成したスレッドは、自動プッシュ無効のまま復旧します。

自動プッシュが有効な場合、初回のブランチ改名後を含め、各依頼の正常終了後に
作業ブランチを `origin`
へプッシュします。既定ブランチへのプッシュや強制プッシュは行わず、 Codex
の失敗・中断・プランモードでは自動プッシュを実行しません。
送信先リポジトリへの書き込み権限が必要です。

自動コミットは行いません。未コミットの変更は別環境に反映されないため、 Discord
に通知します。プッシュに失敗した場合も通知し、作業内容はローカルに残します。

### 2. スレッドへ依頼を書く

作成されたスレッドに通常の Discord メッセージを投稿します。Bot はその内容を
Codex CLI に渡し、進捗と応答を同じスレッドへ返します。
初回応答の送信後、会話内容を要約して Discord スレッド名と作業ブランチ名を
自動更新します。

画像添付がある場合、Bot は添付ファイルを `WORK_BASE_DIR/attachments/`
に保存し、対応する画像パスを Codex CLI の `--image` として渡します。

Codexが成果物として指定したファイルは、応答本文の後に同じスレッドへ添付します。
画像に限らず、PDFやZIPなども受け取れます。複数ファイルは1件ずつ送信します。
添付元はそのスレッドの作業コピー内に限定し、通常のソースコード参照リンクは添付対象にしません。
容量超過、ファイル不存在、添付権限不足などで添付できなかった場合も、本文と送れるファイルを返し、
失敗したファイル名と理由を通知します。

### 3. 継続して会話する

同じスレッドへの次の投稿は、前回の Codex セッションを `resume`
して実行されます。スレッドごとにセッションと作業コピーが分かれるため、別スレッドの作業と混ざりません。

`!` から始まるメッセージは Bot
が無視するため、同じスレッド内でユーザー同士の会話に使えます。

## スラッシュコマンド

| コマンド                                      | 実行場所       | 説明                                                                                             |
| --------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------ |
| `/start repository:owner/repo auto_push:true` | 通常チャンネル | リポジトリを準備し、新しい作業スレッドを作ります。`auto_push` は省略可能で既定値は `true` です。 |
| `/stop`                                       | 作業スレッド   | 実行中の Codex プロセスを中断します。                                                            |
| `/plan`                                       | 作業スレッド   | 次回以降の依頼で、実装前に計画を返すよう Codex へ指示します。                                    |
| `/status`                                     | どこでも       | Codex の 5h / Weekly limit を確認します。                                                        |
| `/active-threads`                             | どこでも       | 現在アクティブな作業スレッドから、実行者宛てに silent mention を送ります。                       |
| `/close`                                      | 作業スレッド   | Worker を終了し、Discord スレッドをクローズします。Manage Threads 権限が必要です。               |

`/start` の repository 入力は、すでに Bot
が取得済みのローカルリポジトリを候補としてオートコンプリートします。

## 作業ディレクトリ

`WORK_BASE_DIR` 配下には次のデータが作られます。

```text
WORK_BASE_DIR/
├── repositories/   # clone した GitHub リポジトリ
├── worktrees/      # スレッドごとの作業コピー
├── threads/        # Discord スレッド情報
├── workers/        # Worker 状態
├── admin/          # Admin 状態
├── sessions/       # Codex の生 JSONL 出力
├── attachments/    # Discord 添付ファイル
├── temp/           # Codex CLI に渡す一時ファイル
└── audit/          # 監査ログ
```

このディレクトリは Bot が直接読み書きします。複数環境で同じ `WORK_BASE_DIR`
を共有しないでください。

## Codex CLI の実行形式

Bot は概ね次の形式で Codex CLI を実行します。

新規セッション:

```text
codex --search exec --json --color never --dangerously-bypass-approvals-and-sandbox --output-last-message <path> "<prompt>"
```

継続セッション:

```text
codex --search exec --json --color never --dangerously-bypass-approvals-and-sandbox resume --output-last-message <path> <session_id> "<prompt>"
```

画像添付がある場合は `--image <path>`
が追加されます。`CODEX_APPEND_SYSTEM_PROMPT` を設定している場合は
`--append-system-prompt` も追加されます。

Bot は `--model` や `model_reasoning_effort` を指定しません。モデル、reasoning
effort、profile などの Codex CLI 設定は、Bot を起動するユーザーの Codex CLI
設定に従います。通常は `$CODEX_HOME/config.toml` または `~/.codex/config.toml`
を確認してください。

この Bot は Codex を自動実行するため、Bot
専用の実行ユーザーと作業ディレクトリを用意することを推奨します。

## 開発

### 成果物添付の指定

Botは各依頼に、成果物を最終回答の独立した行で指定する指示を追加します。

```text
[[attachment:reports/result.pdf]]
[[attachment:output/archive.zip]]
```

パスは作業コピーからの相対パスで指定します。作業コピー外で生成したファイルは、
Codexに作業コピーへコピーさせてから指定します。コードブロック内の指定は例示として扱い、
添付しません。添付指定行は進捗と最終返信の本文から除き、ファイルの送信は最終返信時だけ行います。
同じ実ファイルを複数指定した場合は、1回だけ送信します。

Discordの[Create Messageの容量制限](https://docs.discord.com/developers/resources/message#create-message)
に基づき、25 MiB以上のファイルは読み込む前に拒否します。それより小さくても、
Discord側のファイル容量制限などで拒否される場合は、添付失敗として通知します。

### 開発コマンド

よく使うコマンド:

```bash
deno task fmt
deno task lint
deno task check
deno task test
```

開発中にファイル変更を監視して起動する場合:

```bash
deno task dev
```

pre-commit hook を設定する場合:

```bash
deno task setup-hooks
```

## トラブルシュート

### `DISCORD_TOKEN is not set`

`.env` が存在するか、`DISCORD_TOKEN` が設定されているか確認してください。

### `WORK_BASE_DIR is not set`

`.env` に `WORK_BASE_DIR=/absolute/path/to/workdir`
を設定してください。相対パスや `~` より絶対パスを推奨します。

### `git` または `codex` が見つからない

Bot 起動時のシステムチェックに失敗しています。Bot を起動するユーザーの `PATH`
から `git --version` と `codex --version` が実行できるようにしてください。

### Codex が認証エラーになる

Bot を起動するユーザーで `codex --login` を完了してください。systemd
などで別ユーザーとして起動する場合、その実行ユーザー側で認証が必要です。

### private repository を使いたい

現行実装は `git clone https://github.com/owner/repo.git` を使います。private
repository を扱う場合は、Bot 実行ユーザーの Git
認証情報を事前に設定してください。

## 関連ドキュメント

- `CONTEXT.md`: 作業スレッド、自動プッシュ、コミット・PR言語の用語
- `docs/discord.md`: Discord.js 連携メモ
- `docs/autocomplete.md`: `/start` オートコンプリート調査メモ
- `docs/CODEX.md`: 過去のアーキテクチャメモ
- `docs/rearchitecture-spec-v2.md`: 再設計仕様メモ
- `docs/adr/0001-default-auto-push.md`: 自動プッシュの既定値と送信範囲の判断
