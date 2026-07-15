# HPGL → DXF Converter

複数のHPGLファイルを、ファイルごとのレイヤーを持つ1つのDXFへ変換する静的Webアプリです。変換処理はブラウザ内で完結し、入力ファイルを外部APIへ送信しません。

## 主な特徴

- 複数ファイルをまとめて1つのDXFへ変換
- 入力ファイルごとにDXFレイヤーを作成
- HPGLのペン設定は無視し、DXF図形をByLayerで出力（色・線種・線幅はCAD側のレイヤープロパティで制御）
- 40 HPGL単位を1 mmとして変換
- エラーのある入力をスキップし、変換できた図形を出力

## 対応ファイル

`.hpgl`、`.hpg`、`.plt`、`.h01`〜`.h99`

## 使い方

1. HPGLファイルを選択するか、画面へドラッグ＆ドロップします。
2. 必要に応じて出力ファイル名を変更します。
3. 「DXFに変換」を押します。
4. 結果を確認し、生成されたDXFをダウンロードします。

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
