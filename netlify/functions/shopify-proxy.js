const axios = require('axios');

function getStoresConfig() {
  return {
    flyeuro: {
      domain: '261486-98.myshopify.com',
      getToken: () => process.env.SHOPIFY_FLYEURO_TOKEN,
      authType: 'admin_token'
    },
    apoeuro: {
      domain: 'y1nnea-w1.myshopify.com',
      clientId: process.env.SHOPIFY_APOEURO_CLIENT_ID,
      clientSecret: process.env.SHOPIFY_APOEURO_CLIENT_SECRET,
      locationId: '89312952544',
      authType: 'client_credentials',
      tokenCache: null,
      tokenExpiry: null
    }
  };
}

async function getApoeuroToken(config) {
  if (config.tokenCache && config.tokenExpiry && Date.now() < config.tokenExpiry) {
    return config.tokenCache;
  }
  if (!config.clientId || !config.clientSecret) {
    throw new Error('APOEURO 환경변수가 설정되지 않았습니다.');
  }
  const response = await axios.post(
    `https://${config.domain}/admin/oauth/access_token`,
    {
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'client_credentials'
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
  );
  const token = response.data.access_token;
  const expiresIn = response.data.expires_in || 86400;
  config.tokenCache = token;
  config.tokenExpiry = Date.now() + (expiresIn - 300) * 1000;
  return token;
}

async function callShopifyAPI(store, endpoint, method = 'GET', data = null) {
  const config = getStoresConfig()[store];
  if (!config) throw new Error(`지원하지 않는 스토어: ${store}`);

  let token;
  if (config.authType === 'admin_token') {
    token = config.getToken();
    if (!token) throw new Error(`${store} 토큰이 환경변수에 설정되지 않았습니다`);
  } else {
    token = await getApoeuroToken(config);
  }

  try {
    const response = await axios({
      method,
      url: `https://${config.domain}/admin/api/2024-01${endpoint}`,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      data,
      timeout: 30000
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`Shopify API 오류 [${error.response.status}]: ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`네트워크 오류: ${error.message}`);
  }
}

async function callShopifyGraphQL(store, query) {
  const config = getStoresConfig()[store];
  if (!config) throw new Error(`지원하지 않는 스토어: ${store}`);

  let token;
  if (config.authType === 'admin_token') {
    token = config.getToken();
    if (!token) throw new Error(`${store} 토큰이 환경변수에 설정되지 않았습니다`);
  } else {
    token = await getApoeuroToken(config);
  }

  const response = await axios.post(
    `https://${config.domain}/admin/api/2024-01/graphql.json`,
    { query },
    {
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    }
  );

  if (response.data.errors) {
    throw new Error(`GraphQL 오류: ${JSON.stringify(response.data.errors)}`);
  }

  return response.data;
}

const actionHandlers = {

  'orders/list': async (store, params) => {
    const { status = 'any', limit = 50, created_at_min, created_at_max } = params;
    const queryParams = new URLSearchParams({ status, limit: Math.min(limit, 250) });
    if (created_at_min) queryParams.append('created_at_min', created_at_min);
    if (created_at_max) queryParams.append('created_at_max', created_at_max);
    return await callShopifyAPI(store, `/orders.json?${queryParams.toString()}`);
  },

  'orders/detail': async (store, params) => {
    const { orderId } = params;
    if (!orderId) throw new Error('orderId는 필수 파라미터입니다');
    return await callShopifyAPI(store, `/orders/${orderId}.json`);
  },

  'orders/fulfill': async (store, params) => {
    const { orderId, trackingNumber, trackingCompany = 'DHL', notifyCustomer = true } = params;
    if (!orderId || !trackingNumber) throw new Error('orderId와 trackingNumber는 필수 파라미터입니다');

    const fulfillmentOrders = await callShopifyAPI(store, `/orders/${orderId}/fulfillment_orders.json`);
    if (!fulfillmentOrders.fulfillment_orders || fulfillmentOrders.fulfillment_orders.length === 0) {
      throw new Error('Fulfillment order를 찾을 수 없습니다');
    }

    const fulfillmentOrderId = fulfillmentOrders.fulfillment_orders[0].id;
    const lineItems = fulfillmentOrders.fulfillment_orders[0].line_items.map(item => ({
      id: item.id,
      quantity: item.quantity
    }));

    return await callShopifyAPI(store, '/fulfillments.json', 'POST', {
      fulfillment: {
        line_items_by_fulfillment_order: [{
          fulfillment_order_id: fulfillmentOrderId,
          fulfillment_order_line_items: lineItems
        }],
        tracking_info: {
          number: trackingNumber,
          company: trackingCompany,
          url: `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`
        },
        notify_customer: notifyCustomer
      }
    });
  },

  // PCCC 조회 - GraphQL localizationExtensions 사용
  'orders/pccc': async (store, params) => {
    const { orderId } = params;
    if (!orderId) throw new Error('orderId는 필수 파라미터입니다');

    const result = await callShopifyGraphQL(store, `{
      order(id: "gid://shopify/Order/${orderId}") {
        name
        localizationExtensions(first: 10) {
          nodes {
            purpose
            countryCode
            title
            value
          }
        }
      }
    }`);

    const extensions = result.data.order.localizationExtensions.nodes;
    const pcccNode = extensions.find(n => n.countryCode === 'KR' && n.purpose === 'SHIPPING');

    return {
      orderId,
      pccc: pcccNode ? pcccNode.value : null,
      found: !!pcccNode
    };
  }

};

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST 메서드만 허용됩니다' }) };
  }

  try {
    const { store, action, params = {} } = JSON.parse(event.body || '{}');

    if (!store || !action) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'store와 action은 필수 파라미터입니다' })
      };
    }

    const handler = actionHandlers[action];
    if (!handler) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: `지원하지 않는 액션: ${action}`,
          availableActions: Object.keys(actionHandlers)
        })
      };
    }

    const result = await handler(store, params);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, store, action, data: result })
    };

  } catch (error) {
    console.error('Shopify Proxy Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: error.message, timestamp: new Date().toISOString() })
    };
  }
};
