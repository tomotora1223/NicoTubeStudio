# NicoTube Studio

YouTube および Twitch（VOD・クリップ）の配信アーカイブ・切り抜きを高速ダウンロードし、ニコニコ動画公式準拠の流れるコメント（弾幕）・スパチャ・メンバーカラー・チャンネル固有スタンプ・Twitchエモート・Unicode絵文字を GPU ハードウェアエンコード（NVENC / Intel QSV / AMD AMF）で合成できる Windows 向けデスクトップアプリです。

---

## ダウンロード方法（Windows）

### 一番かんたんな手順

1. 下のリンクから最新のリリースページを開きます  
   **[最新リリースをダウンロード (GitHub Releases)](https://github.com/tomotora1223/NicoTubeStudio/releases/latest)**
2. ページ下部の **Assets** から、お好みのファイルをクリックしてダウンロードします

| ファイル名 | おすすめ対象 | 自動アップデート対応 |
| --- | --- | --- |
| **`NicoTube-Studio-Setup-X.X.X.exe`**（おすすめ） | 通常のインストール版。スタートメニューに登録されます | **全自動更新に対応**（起動時に自動DL＆再起動適用） |
| **`NicoTubeStudio-X.X.X-Portable.exe`** | インストール不要・USBメモリ等に置きたい方向け | 更新通知のみ（手動で再DL） |

> [!TIP]
> Windows で「Windows によって PC が保護されました（SmartScreen）」が出た場合は、**「詳細情報」→「実行」** をクリックして起動できます。

---

## 自動アップデートについて

NicoTube Studio は **アプリ本体** と **内部ツール (`yt-dlp` / `FFmpeg` / `Deno`)** の両方を自動で最新化します。

- **アプリ本体のサイレント自動アップデート**
  - GitHub Releases (`tomotora1223/NicoTubeStudio`) を参照し、起動時・設定画面の「アプリ更新を確認」から最新版を自動チェックします。
  - **Setup (NSIS) 版** を使っている場合はバックグラウンドで更新データを自動ダウンロードし、次回起動時または「再起動して適用（サイレント）」ボタンからインストーラー画面を出さずにそのまま更新できます。
- **yt-dlp / FFmpeg / Deno のバックグラウンド更新**
  - アプリ起動時にバックグラウンドで最新版チェック・更新が行われるため、YouTube の仕様変更があっても意識せず最新の取得エンジンを利用できます（設定画面から手動確認も可能）。

---

## 主な機能

- **取り込み・区間切り抜き（YouTube & Twitch VOD/クリップ対応）**
  - URL解析により利用可能な解像度・FPS・チャット有無・プラットフォームを自動判定
  - プレビュー動画（HLS含む）を確認しながら開始〜終了時刻を指定して部分切り抜き（YouTubeライブチャット / Twitchコメント時刻も自動シフト）
  - 複数フラグメント並列ダウンロード＋チャット同時取得＋サムネイル同時保存（任意チェック、`aria2c` 導入環境では自動併用）
  - 出力モード：「コメント合成あり」「動画のみ」「両方出力」
  - GPU ハードウェアエンコード（NVIDIA NVENC / Intel QSV / AMD AMF 高速プリセット対応）＆コーデック選択（H.264 / H.265 / AV1）
- **みんなのスタイル（コミュニティギャラリー＆共有）**
  - GitHub (`community-styles/index.json`) および共有リレーサーバー上のコメントスタイルを **リアルタイム弾幕プレビュー付き** で閲覧し、ワンクリック適用・プリセット保存が可能
  - GitHub Issue 送信 / GitHub Gist 自動公開（任意トークン）/ 共有リレーサーバー (`server/style_relay_worker.js`・`server/style_relay.py`) による自動共有
  - Web URL（GitHub Raw・Gist URL）・共有コード (`NTS1:...`)・`.nicostyle.json` からの即時プレビュー＆インポート
- **コメント演出スタジオ（60fps リアルタイムプレビュー）**
  - **端末フォント全対応**：PCにインストール済みの全フォントを日本語プレビュー付きで検索・比較でき、新しく追加したフォントも再起動不要の「再スキャン」で即時利用可能
  - **文字装飾・二重縁取り・ドロップシャドウ**：文字色・不透明度・第1/第2縁取りの色・太さ・不透明度・シャドウぼかし/オフセットを細かく調整
  - **YouTube チャット完全対応**：
    - メンバー色分け・モデレーター強調（通常扱い/非表示も可）・配信者強調（上部固定可）
    - スーパーチャット配色ソース切替（**YouTube公式色** / **7段階カスタム色** / **配信ログ元色**）＆速度調整
    - カード背景の不透明度・角丸・枠線強度、スーパーステッカー、メンバー新規加入、ギフト通知
    - チャンネル固有スタンプ・Unicodeカラー絵文字・NGワード除外
  - **全画面テストプレビュー**：Escキーおよび画面上の「閉じる」ボタンからいつでも復帰可能
- **スタイル共有・インポート**
  - `.nicostyle.json` ファイル書き出し / 読み込み
  - コピペで共有できるテキストコード (`NTS1:...`)
  - Web URL (GitHub Raw など) からの直接インポート
  - 共有ライブラリ（ローカル保存＋外部スタイル共有サーバー URL 接続対応）
- **アプリ内 Google ログイン＆処理キュー**
  - 内蔵ブラウザによる YouTube/Google ログイン（メンバー限定配信向けCookie保存）および `cookies.txt` インポート
  - 複数ジョブのキュー管理（進捗・FPS・速度・残り時間表示・即時キャンセル対応）

---

## 開発・ローカルビルド方法

### 開発モードで起動

```powershell
# Python バックエンド環境の準備
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
cd ..

# Node 依存関係インストール & 開発サーバー起動
npm install
npm run dev
```

### Windows リリースビルド

```powershell
# PyInstaller バックエンド + Vite UI + Electron インストーラー生成
powershell -ExecutionPolicy Bypass -File .\build_release.ps1
```

GitHub に `v*` タグ（例: `v0.1.0`）をプッシュすると、`.github/workflows/release.yml` が自動で Windows 向けインストーラー・ポータブル版・`latest.yml` をビルドし、GitHub Releases に公開します。
