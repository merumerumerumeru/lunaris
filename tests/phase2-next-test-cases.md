# LUNARIS Phase 2 NEXT P0 受入テスト項目

## ID・競合

- [ ] 正常な新規 request_id / record_id で登録できる
- [ ] 同一 request_id + 同一 record_id + 同一 content_hash の再送が IDEMPOTENT になる
- [ ] 同一 request_id + 異なる record_id が REQUEST_CONFLICT になる
- [ ] 同一 request_id + 異なる content_hash が REQUEST_CONFLICT になる
- [ ] 異なる request_id + 同一 record_id + 同一 content_hash が DUPLICATE_RECORD になる
- [ ] 異なる request_id + 同一 record_id + 異なる content_hash が RECORD_CONFLICT になる

## PROCESSING

- [ ] PROCESSING + 正式記録あり + request_id/record_id/hash一致で SUCCESS / IDEMPOTENT になる
- [ ] PROCESSING + 正式記録なしの再送で自動新規登録されない
- [ ] PROCESSING + 正式記録なしの再送で PROCESSING が維持される
- [ ] PROCESSING + record_id不一致で REQUEST_CONFLICT になる
- [ ] PROCESSING + content_hash不一致で REQUEST_CONFLICT になる
- [ ] PROCESSING に対して自動タイムアウト・STALE遷移が発生しない

## 同時実行

- [ ] 同一 request_id の同時送信で正式記録が二重登録されない
- [ ] 同一 record_id の同時送信で競合判定が一貫する
- [ ] Lock取得失敗時に新規登録されない

## 障害

- [ ] 日次記録書込み失敗時に既存データが削除・上書きされない
- [ ] 書込み結果不明時に PROCESSING を維持できる
- [ ] API処理履歴更新失敗時に不整合を自動推測修復しない
- [ ] 部分書込み発生時に自動削除・自動再登録されない

## 入力検証

- [ ] 不正JSONを拒否する
- [ ] 必須項目不足を拒否する
- [ ] request_id形式不正を拒否する
- [ ] record_id形式不正を拒否する
- [ ] event_id形式不正を拒否する
- [ ] eventsが配列以外の場合を拒否する

## content_hash

- [ ] JSONキー順だけを変更した同一内容で同一hashになる
- [ ] null / 空文字の違いがhashへ反映される
- [ ] template_versionの違いがhashへ反映される
- [ ] eventsの内容変更がhashへ反映される
- [ ] Unicode文字列をUTF-8として安定してhash化できる

## 既存データ保護

- [ ] 既存39件にrequest_idを生成しない
- [ ] 既存39件にrecord_idを生成しない
- [ ] 既存39件にcontent_hashを生成しない
- [ ] 過去API処理履歴を生成しない
- [ ] 既存統計を変更しない
