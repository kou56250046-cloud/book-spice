#!/usr/bin/env node
// scripts/fetch-books.js
// 楽天ブックスAPIから書籍ランキングを取得し books.json を生成するスクリプト
// 必須環境変数: RAKUTEN_APP_ID, RAKUTEN_ACCESS_KEY

'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const APP_ID     = process.env.RAKUTEN_APP_ID;
const ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY;

if (!APP_ID || !ACCESS_KEY) {
  console.error('エラー: RAKUTEN_APP_ID と RAKUTEN_ACCESS_KEY の両方が必要です');
  process.exit(1);
}

const ROOT            = path.join(__dirname, '..');
const BOOKS_PER_GENRE = 20;
const API_BASE        = 'https://openapi.rakuten.co.jp/services/api/BooksTotal/Search/20170404';

const GENRES = [
  { id: 'self',   name: '自己啓発',       keyword: '自己啓発'               },
  { id: 'phil',   name: '哲学',           keyword: '哲学 思想'              },
  { id: 'habit',  name: '習慣',           keyword: '習慣 ライフハック'      },
  { id: 'spirit', name: 'スピリチュアル', keyword: 'スピリチュアル 精神世界' },
  { id: 'sci',    name: '科学',           keyword: '科学 サイエンス'        },
];

// ------- ユーティリティ -------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  {
        'User-Agent': 'Mozilla/5.0 (compatible; book-spice/1.0)',
        'Referer':    'https://kou56250046-cloud.github.io/book-spice/',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode} | ${data}`));
        } else {
          try   { resolve(JSON.parse(data)); }
          catch { reject(new Error(`JSONパースエラー: ${data.slice(0, 200)}`)); }
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// スパイス度算出（1〜5、0.5刻み）
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
    format:        'json',
    applicationId: APP_ID,
    accessKey:     ACCESS_KEY,
    keyword:       genre.keyword,
    booksGenreId:  '001',
    hits:          String(Math.min(BOOKS_PER_GENRE, 30)),
    page:          '1',
    sort:          'sales',
  });

  const url = `${API_BASE}?${params}`;
  console.log(`[${genre.id}] "${genre.keyword}" を取得中...`);

  const data = await httpsGet(url);

  if (data.error || data.errors) {
    const err = data.error_description || JSON.stringify(data.errors);
    throw new Error(`API エラー: ${err}`);
  }
  if (!data.Items || data.Items.length === 0) {
    console.warn(`[${genre.id}] 結果が0件でした`);
    return [];
  }

  const today = new Date().toISOString().slice(0, 10);
  // 楽天APIのレスポンスは data.Items[i].Item の構造
  return data.Items.slice(0, BOOKS_PER_GENRE).map((wrapper, i) => {
    const item = wrapper.Item;
    return {
      isbn:          item.isbn            || '',
      title:         item.title           || '',
      author:        item.author          || '',
      publisher:     item.publisherName   || '',
      genre:         genre.id,
      imageUrl:      item.largeImageUrl   || item.mediumImageUrl || '',
      price:         parseInt(item.itemPrice)       || 0,
      reviewAverage: parseFloat(item.reviewAverage) || 0,
      reviewCount:   parseInt(item.reviewCount)     || 0,
      itemUrl:       item.itemUrl         || '',
      salesRank:     i + 1,
      spiceScore:    calcSpiceScore(item.reviewAverage, item.reviewCount, i + 1),
      fetchedAt:     today,
      reason:        '',
      view:          '',
    };
  });
}

// ------- メイン -------

async function main() {
  console.log('楽天ブックスAPIからデータを取得します...');

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
      for (const book of books) {
        const c = comments[book.isbn];
        if (c) { book.reason = c.reason || ''; book.view = c.view || ''; }
      }
      allBooks.push(...books);
      console.log(`[${genre.id}] ${books.length} 件完了`);
    } catch (err) {
      console.error(`[${genre.id}] 取得失敗:`, err.message);
    }
    await sleep(1000);
  }

  if (allBooks.length === 0) {
    console.error('1件もデータを取得できませんでした。終了します。');
    process.exit(1);
  }

  const featured = allBooks.reduce((best, b) =>
    !best || b.spiceScore > best.spiceScore ? b : best, null
  );

  const output = {
    updatedAt: new Date().toISOString().slice(0, 10),
    featured:  featured?.isbn || allBooks[0].isbn,
    books:     allBooks,
  };

  fs.writeFileSync(path.join(ROOT, 'books.json'), JSON.stringify(output, null, 2), 'utf8');
  console.log(`books.json を書き出しました（${allBooks.length} 件）`);
  console.log(`今週のひと匙: 『${featured?.title}』（スパイス度 ${featured?.spiceScore}）`);
}

main().catch(err => {
  console.error('致命的エラー:', err);
  process.exit(1);
});
