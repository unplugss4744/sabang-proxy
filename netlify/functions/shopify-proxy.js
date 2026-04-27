exports.handler = async function(event) {
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
    const store  = body.store;
    const action = body.action;
    const params = body.params || {};

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

    let token = cfg.token;
    if (store === 'apoeuro') {
      // 환경변수 체크
      if (!cfg.client_id || !cfg.client_secret) {
        return {
          statusCode: 500,
          headers:    corsHeaders,
          body:       JSON.stringify({
            error:    'Missing env vars',
            has_id:   !!cfg.client_id,
            has_sec:  !!cfg.client_secret
          })
        };
      }

      const tokenRes = await fetch(
        `https://${cfg.domain}/admin/oauth/access_token`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body:    `grant_type=client_credentials&client_id=${cfg.client_id}&client_secret=${cfg.client_secret}`
        }
      );

      const tokenText = await tokenRes.text();

      // JSON 파싱 시도
      try {
        const tokenData = JSON.parse(tokenText);
        token = tokenData.access_token;
        if (!token) {
          return {
            statusCode: 500,
            headers:    corsHeaders,
            body:       JSON.stringify({
              error:        'No token in response',
              token_status: tokenRes.status,
              token_data:   tokenData
            })
          };
        }
      } catch(parseErr) {
        return {
          statusCode: 500,
          headers:    corsHeaders,
          body:       JSON.stringify({
            error:        'Token response not JSON',
            status:       tokenRes.status,
            body_preview: tokenText.substring(0, 500)
          })
        };
      }
    }

    // ... 이하 액션 처리는 기존 코드 그대로
    let url    = '';
    let method = 'GET';

    switch (action) {
      case 'shop':
        url = `https://${cfg.domain}/admin/api/2026-01/shop.json`;
        break;
      case 'orders':
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
        url = `https://${cfg.domain}/admin/api/2026-01/orders.json` +
              `?status=any&limit=50&created_at_min=${oneMonthAgo.toISOString()}`;
        break;
      case 'order_detail':
        url = `https://${cfg.domain}/admin/api/2026-01/orders/${params.id}.json`;
        break;
      default:
        return {
          statusCode: 400,
          headers:    corsHeaders,
          body:       JSON.stringify({ error: 'Unknown action: ' + action })
        };
    }

    const res  = await fetch(url, {
      method,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type':           'application/json',
        'User-Agent':             'Mozilla/5.0 (compatible; ShopifyProxy/1.0)'
      }
    });

    const text = await res.text();

    try {
      const data = JSON.parse(text);
      return {
        statusCode: 200,
        headers:    corsHeaders,
        body:       JSON.stringify({ status: 'ok', data: data })
      };
    } catch(e) {
      return {
        statusCode: 500,
        headers:    corsHeaders,
        body:       JSON.stringify({
          error:    'Shopify API returned non-JSON',
          status:   res.status,
          preview:  text.substring(0, 500)
        })
      };
    }

  } catch(e) {
    return {
      statusCode: 500,
      headers:    corsHeaders,
      body:       JSON.stringify({ error: e.message, stack: e.stack })
    };
  }
};

// switch(action) 안에 추가
case 'order_pccc':
  const graphqlQuery = {
    query: `{
      order(id: "gid://shopify/Order/${params.id}") {
        id
        name
        localizedFields(first: 10) {
          nodes {
            keyType
            title
            value
          }
        }
        customAttributes {
          key
          value
        }
      }
    }`
  };

  const gqlRes = await fetch(
    `https://${cfg.domain}/admin/api/2026-01/graphql.json`,
    {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type':           'application/json'
      },
      body: JSON.stringify(graphqlQuery)
    }
  );

  const gqlData = await gqlRes.json();
  return {
    statusCode: 200,
    headers:    corsHeaders,
    body:       JSON.stringify({ status: 'ok', data: gqlData })
  };
