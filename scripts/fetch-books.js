#!/usr/bin/env node
// scripts/fetch-books.js
// 楽天ブックスAPIから書籍ランキングを取得し books.json を生成するスクリプト
// 実行: node scripts/fetch-books.js
// 必須環境変数: RAKUTEN_APP_ID

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_ID = process.env.RAKUTEN_APP_ID;
if (!APP_ID) {
  console.error('エラー: 環境変数 RAKUTEN_APP_ID が設定されていません');
  console.error('  GitHub Secrets に RAKUTEN_APP_ID を登録してください');
  process.exit(1);
}

const ROOT           = path.join(__dirname, '..');
const BOOKS_PER_GENRE = 20;
const API_BASE       = 'https://app.rakuten.co.jp/services/api/BooksBook/Search/20130522';

// ジャンル定義とAPIキーワード
const GENRES = [
  { id: 'self',   name: '自己啓発',       keyword: '自己啓発'              },
  { id: 'phil',   name: '哲学',           keyword: '哲学 思想'             },
  { id: 'habit',  name: '習慣',           keyword: '習慣 ライフハック'     },
  { id: 'spirit', name: 'スピリチュアル', keyword: 'スピリチュアル 精神世界'},
  { id: 'sci',    name: '科学',           keyword: '科学 サイエンス'       },
];

// ------- ユーティリティ -------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// スパイス度算出（1〜5、0.5刻み）
// 要件定義: レビュー平均×0.5 ＋ レビュー件数（対数正規化）×0.3 ＋ ランキング補正×0.2
function calcSpiceScore(reviewAverage, reviewCount, salesRank) {
  const ratingScore = (parseFloat(reviewAverage) / 5) * 5;
  const reviewScore = Math.min(
    Math.log10((parseInt(reviewCount) || 0) + 1) / Math.log10(5000), 1
  ) * 5;
  const rankScore = ((BOOKS_PER_GENRE - salesRank + 1) / BOOKS_PER_GENRE) * 5;
  const raw = ratingScore * 0.5 + reviewScore * 0.3 + rankScore * 0.2;
  return Math.max(1, Math.min(5, Math.round(raw * 2) / 2));
}

// ------- API取得 -------

async function fetchGenreBooks(genre) {
  const params = new URLSearchParams({
    applicationId:  APP_ID,
    keyword:        genre.keyword,
    sort:           'standard',      // 楽天の総合ランキング（売上ベース）
    hits:           String(Math.min(BOOKS_PER_GENRE, 30)),
    page:           '1',
    formatVersion:  '2',
    elements:       'isbn,title,author,publisherName,largeImageUrl,mediumImageUrl,itemPrice,reviewAverage,reviewCount,itemUrl',
  });

  const url = `${API_BASE}?${params}`;
  console.log(`[${genre.id}] "${genre.keyword}" を取得中...`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const data = await res.json();
  if (data.error) {
    throw new Error(`API エラー: ${data.error} - ${data.error_description}`);
  }
  if (!data.Items || data.Items.length === 0) {
    console.warn(`[${genre.id}] 結果が0件でした`);
    return [];
  }

  const today = new Date().toISOString().slice(0, 10);

  return data.Items.slice(0, BOOKS_PER_GENRE).map((item, i) => ({
    isbn:          item.isbn,
    title:         item.title,
    author:        item.author,
    publisher:     item.publisherName,
    genre:         genre.id,
    imageUrl:      item.largeImageUrl || item.mediumImageUrl || '',
    price:         parseInt(item.itemPrice) || 0,
    reviewAverage: parseFloat(item.reviewAverage) || 0,
    reviewCount:   parseInt(item.reviewCount)   || 0,
    itemUrl:       item.itemUrl,
    salesRank:     i + 1,
    spiceScore:    calcSpiceScore(item.reviewAverage, item.reviewCount, i + 1),
    fetchedAt:     today,
    reason:        '',
    view:          '',
  }));
}

// ------- メイン -------

async function main() {
  console.log('楽天ブックスAPIからデータを取得します...');

  // comments.json を読み込む（なくてもエラーにしない）
  const commentsPath = path.join(ROOT, 'comments.json');
  let comments = {};
  try {
    comments = JSON.parse(fs.readFileSync(commentsPath, 'utf8'));
    console.log(`コメント ${Object.keys(comments).length} 件を読み込みました`);
  } catch {
    console.warn('comments.json が見つかりません。コメントなしで続行します。');
  }

  const allBooks = [];

  for (const genre of GENRES) {
    try {
      const books = await fetchGenreBooks(genre);
      // コメントをISBNで紐づけてマージ
      for (const book of books) {
        const c = comments[book.isbn];
        if (c) {
          book.reason = c.reason || '';
          book.view   = c.view   || '';
        }
      }
      allBooks.push(...books);
      console.log(`[${genre.id}] ${books.length} 件完了`);
    } catch (err) {
      console.error(`[${genre.id}] 取得失敗:`, err.message);
    }

    await sleep(600); // レート制限対策（ジャンル間インターバル）
  }

  if (allBooks.length === 0) {
    console.error('1件もデータを取得できませんでした。終了します。');
    process.exit(1);
  }

  // 今週のひと匙: スパイス度最高の本を自動選出
  const featured = allBooks.reduce((best, b) =>
    !best || b.spiceScore > best.spiceScore ? b : best, null
  );

  const output = {
    updatedAt: new Date().toISOString().slice(0, 10),
    featured:  featured?.isbn || allBooks[0].isbn,
    books:     allBooks,
  };

  const outPath = path.join(ROOT, 'books.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  console.log(`books.json を書き出しました（${allBooks.length} 件）`);
  console.log(`今週のひと匙: 『${featured?.title}』（スパイス度 ${featured?.spiceScore}）`);
}

main().catch(err => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
