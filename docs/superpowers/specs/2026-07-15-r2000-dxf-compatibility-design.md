# AutoCAD 2000 DXF互換性修正 設計

## 背景

`reference`の8つのHPGLをブラウザで変換した`converted.dxf`は、変換画面では正常完了したが、BricsCAD V24.2.07.0で開くと「無効なオブジェクトID: `<object> (0)`」となり、DXF読込後にBricsCADがアクセス違反で停止した。

対象DXFは`EOF`まで存在し、偶数行のgroup code/valueペアとして完結している。一方、53,842個の図形すべてにおいてgroup code 5のhandle、group code 330のowner、group code 100のsubclass markerが欠落していた。`ezdxf audit`でも`missing 'AcDbPolyline' subclass in LWPOLYLINE`として破損DXFと判定された。

現行ライターは`$ACADVER`を`AC1015`に設定しているが、実体はAutoCAD 2000以降に必要なオブジェクト識別・所有関係・subclass構造を省略している。これを根本原因とする。

## 目的と完了条件

`reference`の8ファイルをファイル別レイヤーを持つ1つのAutoCAD 2000互換ASCII DXFへ変換し、次を満たす。

- BricsCAD V24で警告、修復要求、クラッシュなしに開ける。
- 期待する8レイヤーを保持する。
- HPGLのペン番号を各DXF図形のACI色として保持する。
- 40 HPGL単位を1 mmとして保持する。
- 正負の円弧方向、文字、元座標、図形順を変更しない。
- HPGLおよびDXFを外部APIへ送信しない。

## 検討した方法

### JavaScript DXFライブラリ

`dxf-writer`と`@tarikjabiri/dxf`は週1万件以上ダウンロードされているが、安定版の公開が2年以上止まっている。前者は公開APIが主にレイヤー色を扱い、後者は公式説明上AC1021以降を対象としている。今回必須のAC1015と図形単位ACIへ合わせるにはライブラリ内部への依存または改変が必要になり、汎用化よりも互換性リスクが高くなるため採用しない。

### AutoCAD R12への変更

R12では構造を簡略化できるが、`LWPOLYLINE`を`POLYLINE`、`VERTEX`、`SEQEND`へ変換する必要がある。ファイルサイズ増加と既存のAutoCAD 2000要件変更を伴うため採用しない。

### 採用方法

現行の共通図形モデルと`writeDxf({ layers, geometries })`を維持し、DXFライターのみを正しいAC1015オブジェクト構造へ改修する。新規ランタイム依存、CDN、外部APIは追加しない。

## モジュール構成

### `src/dxf/handles.js`

DXFオブジェクトへ一意な大文字16進handleを割り当てる。割り当て順は決定的とし、同じ入力から同じDXFを生成する。次に未使用となるhandleを`$HANDSEED`へ使用する。

### `src/dxf/writer.js`

既存の入力検証、文字エスケープ、図形の座標・ACI検証を維持する。最初に標準テーブル、ブロック、オブジェクト、全図形のhandleと所有関係を割り当ててオブジェクトグラフを確定し、その後に各sectionを直列化する。この2段階処理により、先頭の`$HANDSEED`と後続参照の整合性を保証する。公開関数と戻り値の`string[]`は変更しない。

### `tests/dxf/dxf-tags.js`

テスト専用のASCII DXF tag readerとする。group code/valueペア、section、table、entity、handle参照を検査し、個別テストが文字列の部分一致だけに依存しないようにする。

## R2000ドキュメント構造

出力順を次のとおり固定する。

1. `HEADER`
2. 空の`CLASSES`
3. `TABLES`
4. `BLOCKS`
5. `ENTITIES`
6. `OBJECTS`
7. `EOF`

### HEADER

- `$ACADVER = AC1015`
- `$HANDSEED = 次の未使用handle`
- `$INSUNITS = 4`

### TABLES

次の標準テーブルを出力する。

- `VPORT`: `*ACTIVE`
- `LTYPE`: `ByBlock`、`ByLayer`、`CONTINUOUS`
- `LAYER`: `0`と入力ファイル別レイヤー
- `STYLE`: `STANDARD`
- `VIEW`: 空
- `UCS`: 空
- `APPID`: `ACAD`
- `DIMSTYLE`: 空
- `BLOCK_RECORD`: `*Model_Space`、`*Paper_Space`

各table、table recordにhandle、owner、`AcDbSymbolTable`、`AcDbSymbolTableRecord`およびrecord固有のsubclass markerを設定する。

### BLOCKS

`*Model_Space`と`*Paper_Space`について`BLOCK`と`ENDBLK`を出力する。それぞれを対応する`BLOCK_RECORD`の所有下に置く。

### ENTITIES

全図形を`*Model_Space`の`BLOCK_RECORD`に所属させる。共通tagは次のとおりとする。

- group 5: 一意なhandle
- group 330: Model Space block recordのhandle
- group 100: `AcDbEntity`
- group 8: ファイル別レイヤー
- group 62: ペン由来のACI色

図形固有のsubclass markerは次のとおりとする。

- `LINE`: `AcDbLine`
- `LWPOLYLINE`: `AcDbPolyline`
- `CIRCLE`: `AcDbCircle`
- `ARC`: `AcDbCircle`、`AcDbArc`
- `TEXT`: `AcDbText`。R2000のTEXT定義に従い後半の`AcDbText` markerも出力する。

既存の座標、半径、角度、文字高、回転、頂点数、ACI検証は変更しない。

### OBJECTS

root `DICTIONARY`に`ACAD_GROUP`と`ACAD_LAYOUT`の子dictionaryを登録し、両方のgroup 330 ownerをrootへ接続する。`ACAD_LAYOUT` dictionaryには`Model`と`Layout1`の2つの`LAYOUT` objectを登録し、各`LAYOUT`の先頭group 330 ownerを`ACAD_LAYOUT` dictionaryへ接続する。

`*Model_Space`と`*Paper_Space`の各`BLOCK_RECORD`はgroup 340で対応する`LAYOUT`を参照し、各`LAYOUT`は`AcDbLayout`内の末尾group 330で対応する`BLOCK_RECORD`を参照する。この双方向参照を含むself-contained layout graphを出力し、root dictionaryのowner以外に未使用または不明なobject ID 0を出力しない。

## エラー処理

- geometry入力が不正な場合は、現行と同様にDXF生成前に例外とする。
- handleの重複、未割当owner、存在しない参照は内部構造エラーとして例外にする。
- 内部構造エラーがある場合は、破損DXFをダウンロード可能にせず変換失敗としてUIへ返す。
- HPGL命令単位の回復動作と、正常図形を残す現在の方針は変更しない。

## テスト

### 単体テスト

- handleが一意な大文字16進数として決定的に増える。
- `$HANDSEED`が割当済みhandleより後を指す。
- 必須sectionと標準tableが1回ずつ存在する。
- raw tagで各TABLEのgroup 70件数が実record数と一致し、各table recordのgroup 330 ownerが所属TABLEを指すことを検査する。
- raw tagでroot dictionaryの`ACAD_LAYOUT`登録、`ACAD_LAYOUT` dictionaryのowner、`Model` / `Layout1`の`LAYOUT` objectとowner、および各`BLOCK_RECORD`のgroup 340と対応`LAYOUT`末尾group 330の相互参照を検査する。
- block、dictionary、layout、entityを含む全handle参照先が存在する。
- 全entityにhandle、owner、`AcDbEntity`、図形固有subclass markerがある。
- 空DXFにも有効なVPORT、Model/Paper Space、root dictionaryがある。
- 既存のレイヤー、Unicode、ACI、座標、円弧、TEXT、入力検証テストを維持する。

### 結合テスト

- `reference`の8ファイルからDXFを生成し、8ファイル、53,842図形、エラー0件、警告0件であることを検査する。
- 外部パーサへ渡す前にraw tagを解析し、全handleの一意性、group 330/340/350/360参照の解決、TABLE件数とowner、および`ACAD_LAYOUT` / `LAYOUT`のself-contained graphを検査する。
- 53,842件の全entityを入力HPGLの期待図形と同じ順序でcanonical化し、type、layer、ACI、および型固有のgeometryまたはtextを全件比較する。
- raw graphと全entityのcanonical比較が完了した後に、生成した代表DXFを`ezdxf audit`へ渡し、破損判定および修復項目が0件であることを確認する。
- 全VitestとVite本番ビルドを実行する。

### BricsCAD V24

代表DXFを`reference/20260715-log/converted.dxf`とは別名で生成し、`docs/bricscad-v24-checklist.md`を更新して次を確認する。

- 警告、修復要求、クラッシュなしに開ける。
- 8レイヤーを単独表示できる。
- entityのACI色を確認できる。
- 40 HPGL単位区間が`1.000 mm`である。
- 正負の円弧方向が維持される。

BricsCADでのみ確認できる項目はユーザーが実施し、結果をチェックリストへ記録する。

## 変更しない範囲

- HPGLパーサーと座標変換
- UIとWorkerの公開契約
- レイヤー命名規則
- SP0をACI 1として扱う規則
- LBのTEXT変換
- 出力ファイル名とダウンロード動作
