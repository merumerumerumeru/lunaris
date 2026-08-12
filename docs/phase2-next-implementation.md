# LUNARIS Phase 2 NEXT 実装記録

## 実装済み範囲

- `request_id` の第一冪等性キー判定
- 同一 `request_id` + 異なる `record_id` / `content_hash` の `REQUEST_CONFLICT`
- `record_id` の第二重複判定
- `content_hash` の SHA-256 算出
- `record + events + template_version` のキー順正規化
- `PROCESSING` の再送照合
- `PROCESSING` + 正式記録一致時の `IDEMPOTENT`
- `PROCESSING` + 正式記録なし時の自動再登録禁止・PROCESSING維持
- `LockService` による競合区間の排他
- API処理履歴 1論理request=1行
- 既存シートのヘッダーを利用した日次記録・重要イベントへの受け渡し
- 既存データを移行・推測変更しない構造

## 今回実装していないもの

- retry_count
- processing_started_at
- STALE
- 自動タイムアウト
- 自動再処理
- 再送試行履歴
- 詳細通信監査ログ
- 既存39件へのID付与・hash生成・履歴生成
- 新規シート・新規列の自動作成

## 実装上の要確認事項

### 1. GAS Web App の認証

`Code.gs` は Script Properties の `LUNARIS_API_KEY` と `X-Lunaris-API-Key` を前提とする認証アダプタを配置している。

ただし、GAS Web App の `doPost(e)` で任意HTTPヘッダーを確実に取得できるかは、実デプロイ環境で確認が必要。確認前に本番利用へ進めない。

認証方式を変更する必要がある場合は、司令塔で仕様確認を行う。独自にJSON仕様へ認証フィールドを追加しない。

### 2. HTTPステータス

`ContentService` によるJSONレスポンスへ `http_status` を含めているが、GAS Web App の実際のHTTPステータス制御についてはデプロイ環境で受入確認が必要。

`http_status` のJSON値だけをもってHTTPステータスが設定されたとはみなさない。

### 3. Google Sheets列マッピング

既存シートのヘッダーだけを使用する。未確認の列名を新設しない。

日次記録・重要イベントの既存ヘッダーがAPI payloadのフィールド名と対応しない場合、書込みを拒否する。

### 4. 部分書込み

日次記録の書込み後に重要イベント書込みが失敗するなど、Google Sheetsを完全なトランザクションとして扱わない。

この場合も自動削除・自動上書き・推測復旧は行わない。

## データ保護

既存39件への変更は行わない。API処理履歴の過去分も生成しない。
