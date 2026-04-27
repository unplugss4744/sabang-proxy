// netlify/functions/shopify-proxy.js
// Shopify API 프록시 — GAS bandwidth 우회용

exports.handler = async function(event) {
  // CORS 헤더
  const corsHeaders = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  try {
    const body   = JSON.parse(event.body || '{}');
    const store  = body.store;   // 'flyeuro' or 'apoeuro'
    const action = body.action;  // 'orders' / 'order_detail' / 'shop'
    const params = body.params || {};

    // 스토어 설정
    const STORES = {
      flyeuro: {
        domain: '261486-98.myshopify.com',
        token:  process.env.FLYEURO_TOKEN
      },
      apoeuro: {
        domain:        'y1nnea-w1.myshopify.com',
        client_id:     process.env.APOEURO_CLIENT_ID,
        client_secret: process.env.APOEURO_CLIENT_SECRET
      }
    };

    const cfg = STORES[store];
    if (!cfg) {
      return {
        statusCode: 400,
        headers:    corsHeaders,
        body:       JSON.stringify({ error: 'Unknown store: ' + store })
      };
    }

    // ── 토큰 결정 ──────────────────────────
    let token = cfg.token;
    if (store === 'apoeuro') {
      // Client Credentials로 토큰 자동 발급
      const tokenRes = await fetch(
        `https://${cfg.domain}/admin/oauth/access_token`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    `grant_type=client_credentials&client_id=${cfg.client_id}&client_secret=${cfg.client_secret}`
        }
      );
      const tokenData = await tokenRes.json();
      token = tokenData.access_token;
    }

    // ── 액션별 처리 ────────────────────────
    let url     = '';
    let method  = 'GET';
    let payload = null;

    switch (action) {
      case 'shop':
        url = `https://${cfg.domain}/admin/api/2026-01/shop.json`;
        break;

      case 'orders':
        // 주문 목록 (최근 1개월, 50건)
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        url = `https://${cfg.domain}/admin/api/2026-01/orders.json` +
              `?status=any&limit=50&created_at_min=${oneMonthAgo.toISOString()}`;
        break;

      case 'order_detail':
        // 단일 주문 상세 (PII 포함)
        url = `https://${cfg.domain}/admin/api/2026-01/orders/${params.id}.json`;
        break;

      case 'order_fulfill':
        // 송장 등록 (2단계)
        const foRes = await fetch(
          `https://${cfg.domain}/admin/api/2026-01/orders/${params.id}/fulfillment_orders.json`,
          {
            method:  'GET',
            headers: { 'X-Shopify-Access-Token': token }
          }
        );
        const foData = await foRes.json();
        const foId   = foData.fulfillment_orders[0].id;

        const fulfillRes = await fetch(
          `https://${cfg.domain}/admin/api/2026-01/fulfillments.json`,
          {
            method:  'POST',
            headers: {
              'X-Shopify-Access-Token': token,
              'Content-Type':           'application/json'
            },
            body: JSON.stringify({
              fulfillment: {
                line_items_by_fulfillment_order: [{ fulfillment_order_id: foId }],
                tracking_info: {
                  number:  params.tracking_number,
                  company: '우체국택배',
                  url:     'https://service.epost.go.kr/trace.RetrieveEmsRigiTraceList.comm?POST_CODE=' + params.tracking_number
                },
                notify_customer: true
              }
            })
          }
        );
        const fulfillData = await fulfillRes.json();

        return {
          statusCode: 200,
          headers:    corsHeaders,
          body:       JSON.stringify({ status: 'ok', data: fulfillData })
        };

      default:
        return {
          statusCode: 400,
          headers:    corsHeaders,
          body:       JSON.stringify({ error: 'Unknown action: ' + action })
        };
    }

    // ── API 호출 ──────────────────────────
    const fetchOpts = {
      method,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type':           'application/json',
        'User-Agent':             'Mozilla/5.0 (compatible; ShopifyProxy/1.0)'
      }
    };
    if (payload) fetchOpts.body = payload;

    const res  = await fetch(url, fetchOpts);
    const data = await res.json();

    return {
      statusCode: 200,
      headers:    corsHeaders,
      body:       JSON.stringify({ status: 'ok', data: data })
    };

  } catch(e) {
    return {
      statusCode: 500,
      headers:    corsHeaders,
      body:       JSON.stringify({ error: e.message })
    };
  }
};