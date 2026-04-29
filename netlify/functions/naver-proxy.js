// ============================================================
// netlify/functions/naver-proxy.js
// Netlify Functions - 네이버 커머스 API 중계 서버
// bcrypt 서명 생성 + API 호출 IP 고정
// ============================================================
// 설치: npm install bcryptjs node-fetch
// ============================================================

const bcrypt  = require('bcryptjs');
const fetch   = require('node-fetch');

exports.handler = async function(event, context) {
  // CORS 헤더
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type':                 'application/json'
  };

  // OPTIONS (preflight)
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let data;
  try {
    data = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // ── 1. bcrypt 서명 생성 ──────────────────────────────────
  if (data.action === 'sign') {
    try {
      const { clientId, secret, timestamp } = data;
      if (!clientId || !secret || !timestamp) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing params' }) };
      }
      const password  = `${clientId}_${timestamp}`;
      const hashed    = bcrypt.hashSync(password, secret);
      const signature = Buffer.from(hashed).toString('base64');

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ signature })
      };
    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── 2. 토큰 발급 ────────────────────────────────────────
  if (data.action === 'token') {
    try {
      const { client_id, timestamp, client_secret_sign, grant_type, type } = data;

      const res = await fetch('https://api.commerce.naver.com/external/v1/oauth2/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          client_id,
          timestamp,
          client_secret_sign,
          grant_type: grant_type || 'client_credentials',
          type:       type       || 'SELF'
        }).toString()
      });

      const result = await res.json();
      return { statusCode: res.status, headers, body: JSON.stringify(result) };

    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── 3. 네이버 API 프록시 ─────────────────────────────────
  if (data.action === 'api') {
    try {
      const { token, endpoint, method, body: apiBody } = data;
      const url = 'https://api.commerce.naver.com/external' + endpoint;

      const fetchOptions = {
        method:  method || 'GET',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type':  'application/json',
        }
      };
      if (apiBody) fetchOptions.body = JSON.stringify(apiBody);

      const res    = await fetch(url, fetchOptions);
      const result = await res.json();
      return { statusCode: res.status, headers, body: JSON.stringify(result) };

    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  // ── 4. 이미지 업로드 ─────────────────────────────────────
  if (data.action === 'uploadImage') {
    try {
      const { token, imageUrl } = data;

      // 이미지 다운로드
      const imgRes    = await fetch(imageUrl);
      const imgBuffer = await imgRes.arrayBuffer();
      const imgBase64 = Buffer.from(imgBuffer).toString('base64');
      const mimeType  = imgRes.headers.get('content-type') || 'image/jpeg';

      // 네이버 이미지 업로드 API
      const boundary = '----FormBoundary' + Date.now();
      const body =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="imageFiles"; filename="product.jpg"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`;

      const bodyBuffer = Buffer.concat([
        Buffer.from(body),
        Buffer.from(imgBuffer),
        Buffer.from(`\r\n--${boundary}--\r\n`)
      ]);

      const uploadRes = await fetch(
        'https://api.commerce.naver.com/external/v1/product-images/upload',
        {
          method:  'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type':  `multipart/form-data; boundary=${boundary}`,
          },
          body: bodyBuffer
        }
      );

      const result = await uploadRes.json();
      return { statusCode: uploadRes.status, headers, body: JSON.stringify(result) };

    } catch(e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
    }
  }

  return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
};
