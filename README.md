# Project LUNARIS

地下鉄観察データ管理・自動記録システムの実装・設定・テスト資産を管理するリポジトリです。

## リポジトリの目的

Project LUNARISにおけるGoogle Apps Script、API、Google Sheets連携、およびテスト関連資産を管理します。

## 現在のフェーズ

Phase 2 NEXT の実装準備段階です。

現時点では実装コードを含めず、正式な実装先と最小限のディレクトリ構成を整備しています。

## 実装対象

- Google Apps Script
- API
- Google Sheets連携
- テスト関連資産

## 仕様管理

正式仕様は、Project LUNARISの司令塔で承認されたもののみ採用します。
未承認の仕様変更や先行実装は行いません。

## データ保護

本リポジトリの初期構築では、Google Sheets上の既存データにはアクセス・変更を行いません。
既存データ、API処理履歴、識別子等を推測して作成・移行することもありません。

## 初期構成

```text
/
├─ README.md
├─ gas/
├─ docs/
└─ tests/
```

各ディレクトリには、今後の実装・文書・テスト資産を配置します。
