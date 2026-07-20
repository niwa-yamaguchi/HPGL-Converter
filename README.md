# HPGL → DXF Converter

複数のHPGLファイルを、ファイルごとのレイヤーを持つ1つのDXFへ変換する静的Webアプリです。変換処理はブラウザ内で完結し、入力ファイルを外部APIへ送信しません。

## 主な特徴

- 通常のHPGLファイルとZIPアーカイブを入力可能
- 複数ファイルをまとめて1つのDXFへ変換
- ZIP内のサブフォルダを再帰検索し、対応するHPGLファイルだけを追加
- 入力ファイルごとにDXFレイヤーを作成
- HPGLのペン設定は無視し、DXF図形をByLayerで出力（色・線種・線幅はCAD側のレイヤープロパティで制御）
- 40 HPGL単位を1 mmとして変換
- エラーのある入力をスキップし、変換できた図形を出力
- 最初に追加できた元ファイル名をDXFの既定名として一度だけ自動設定
- 変換完了時にDXFを自動ダウンロードし、結果欄から再ダウンロードも可能

## 対応ファイル

通常ファイルは `.hpgl`、`.hpg`、`.plt`、`.plt1`〜`.plt99`、`.pltl`、`.pltl1`〜`.pltl99`、`.h01`〜`.h99` に対応しています。

`.zip` は次の上限で展開します。

- ZIP本体: 50 MiB以下
- 対応するHPGLファイル: 100件以下
- 展開後の1ファイル: 20 MiB以下
- 展開後の対応ファイル合計: 100 MiB以下

ZIP内のサブフォルダも再帰的に検索します。対応していないファイル、入れ子のZIP、ディレクトリ項目、安全でないパスは追加せず、種類別の件数を画面に表示します。

## 使い方

1. ZIPまたはHPGLファイルを選択するか、画面へドラッグ＆ドロップします。
2. 最初に追加できた元ファイル名からDXFの既定名が一度だけ自動設定されます。たとえば `drawings.zip` なら `drawings.dxf` になります。必要に応じて出力ファイル名を変更できます。その後ファイルを追加しても、既定名や変更した名前は自動変更されません。
3. 「DXFに変換」を押します。
4. 変換完了時に生成されたDXFの自動ダウンロードが始まります。
5. 変換結果を確認できます。自動ダウンロードを開始できなかった場合や、もう一度取得したい場合は、結果欄のボタンから再ダウンロードできます。

## ローカル開発

Node.js 22.12以降を使用してください。

```bash
npm ci
npm run dev
```

```bash
npm test
npm run build
```

ビルド結果は `dist` に生成されます。

## Cloudflare Pages

GitHubリポジトリをCloudflare Pagesへ接続し、次の値を設定します。

| 設定 | 値 |
|---|---|
| Production branch | `main` |
| Framework preset | `None` |
| Build command | `npm run build` |
| Build output directory | `dist` |

環境変数、Functions、外部APIは使用しません。

## ドキュメント

- [現行実装設計書](docs/superpowers/specs/2026-07-15-bylayer-ignore-hpgl-pens-design.md)
- [BricsCAD V24確認チェックリスト](docs/bricscad-v24-checklist.md)

## ライセンス

[MIT License](LICENSE)
