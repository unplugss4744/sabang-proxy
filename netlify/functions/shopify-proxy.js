const axios = require('axios');

// ============================================
// 설정 (Configuration)
// ============================================
const STORES_CONFIG = {
  flyeuro: {
    domain: '261486-98.myshopify.com',
    getToken: () => process.env.SHOPIFY_FLYEURO_TOKEN,
    authType: 'admin_token'
  },
  apoeuro: {
    domain: 'y1nnea-w1.myshopify.com',
    clientId: '8b34c109177eb239f84b1b5bf60f2f2c',
    clientSecret: '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',
    locationId: '89312952544',
    authType: 'client_credentials',
    tokenCache: null,
    tokenExpiry: null
  }
};

// ============================================
// APOEURO 토큰 발급 함수
// ============================================
async function getApoeuroToken() {
  const config = STORES_CONFIG.apoeuro;
  
  if (config.tokenCache && config.tokenExpiry && Date.now() < config.tokenExpiry) {
    return config.tokenCache;
  }

  try {
    const response = await axios.post(
      `https://${config.domain}/admin/oauth/access_token`,
      {
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'client_credentials'
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000
      }
    );

    const token = response.data.access_token;
    const expiresIn = response.data.expires_in || 86400;
    
    config.tokenCache = token;
    config.tokenExpiry = Date.now() + (expiresIn - 300) * 1000;
    
    return token;
  } catch (error) {
    throw new Error(`APOEURO 토큰 발급 실패: ${error.message}`);
  }
}

// ============================================
// Shopify API 호출 헬퍼
// ============================================
async function callShopifyAPI(store, endpoint, method = 'GET', data = null) {
  const config = STORES_CONFIG[store];
  if (!config) {
    throw new Error(`지원하지 않는 스토어: ${store}`);
  }

  let token;
  if (config.authType === 'admin_token') {
    token = config.getToken();
    if (!token) {
      throw new Error(`${store} 토큰이 환경변수에 설정되지 않았습니다`);
    }
  } else if (config.authType === 'client_credentials') {
    token = await getApoeuroToken();
  }

  const url = `https://${config.domain}/admin/api/2024-01${endpoint}`;
  
  try {
    const response = await axios({
      method,
      url,
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
      throw new Error(
        `Shopify API 오류 [${error.response.status}]: ${JSON.stringify(error.response.data)}`
      );
    }
    throw new Error(`네트워크 오류: ${error.message}`);
  }
}

// ============================================
// 액션 핸들러
// ============================================
const actionHandlers = {
  // 주문 목록 조회
  'orders/list': async (store, params) => {
    const { status = 'any', limit = 50, created_at_min, created_at_max } = params;
    
    const queryParams = new URLSearchParams({
      status,
      limit: Math.min(limit, 250)
    });
    
    if (created_at_min) queryParams.append('created_at_min', created_at_min);
    if (created_at_max) queryParams.append('created_at_max', created_at_max);
    
    return await callShopifyAPI(
      store,
      `/orders.json?${queryParams.toString()}`
    );
  },

  // 주문 상세 조회 (고객정보 포함)
  'orders/detail': async (store, params) => {
    const { orderId } = params;
    
    if (!orderId) {
      throw new Error('orderId는 필수 파라미터입니다');
    }
    
    return await callShopifyAPI(
      store,
      `/orders/${orderId}.json`
    );
  },

  // 송장번호 등록 (Fulfillment 생성)
  'orders/fulfill': async (store, params) => {
    const { orderId, trackingNumber, trackingCompany = 'DHL', notifyCustomer = true } = params;
    
    if (!orderId || !trackingNumber) {
      throw new Error('orderId와 trackingNumber는 필수 파라미터입니다');
    }

    const fulfillmentOrders = await callShopifyAPI(
      store,
      `/orders/${orderId}/fulfillment_orders.json`
    );

    if (!fulfillmentOrders.fulfillment_orders || fulfillmentOrders.fulfillment_orders.length === 0) {
      throw new Error('Fulfillment order를 찾을 수 없습니다');
    }

    const fulfillmentOrderId = fulfillmentOrders.fulfillment_orders[0].id;
    const lineItems = fulfillmentOrders.fulfillment_orders[0].line_items.map(item => ({
      id: item.id,
      quantity: item.quantity
    }));

    const fulfillmentData = {
      fulfillment: {
        line_items_by_fulfillment_order: [
          {
            fulfillment_order_id: fulfillmentOrderId,
            fulfillment_order_line_items: lineItems
          }
        ],
        tracking_info: {
          number: trackingNumber,
          company: trackingCompany,
          url: `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`
        },
        notify_customer: notifyCustomer
      }
    };

    return await callShopifyAPI(
      store,
      '/fulfillments.json',
      'POST',
      fulfillmentData
    );
  },

  // ============================================
  // PCCC 조회 (GraphQL) - 신규 추가
  // ============================================
  'order_pccc': async (store, params) => {
    const { orderId } = params;
    
    if (!orderId) {
      throw new Error('orderId는 필수 파라미터입니다');
    }

    const config = STORES_CONFIG[store];
    if (!config) {
      throw new Error(`지원하지 않는 스토어: ${store}`);
    }

    // 토큰 가져오기
    let token;
    if (config.authType === 'admin_token') {
      token = config.getToken();
      if (!token) {
        throw new Error(`${store} 토큰이 환경변수에 설정되지 않았습니다`);
      }
    } else if (config.authType === 'client_credentials') {
      token = await getApoeuroToken();
    }

    // GraphQL 쿼리
    const graphqlQuery = {
      query: `{
        order(id: "gid://shopify/Order/${orderId}") {
          id
          name
          legacyResourceId
          customAttributes {
            key
            value
          }
          shippingAddress {
            address1
            address2
            city
            zip
            phone
          }
          note
          tags
        }
      }`
    };

    try {
      const response = await axios({
        method: 'POST',
        url: `https://${config.domain}/admin/api/2024-01/graphql.json`,
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        data: graphqlQuery,
        timeout: 30000
      });

      if (response.data.errors) {
        throw new Error(`GraphQL 오류: ${JSON.stringify(response.data.errors)}`);
      }

      return response.data;

    } catch (error) {
      if (error.response) {
        throw new Error(
          `GraphQL API 오류 [${error.response.status}]: ${JSON.stringify(error.response.data)}`
        );
      }
      throw new Error(`네트워크 오류: ${error.message}`);
    }
  },

  // ============================================
  // 주문 PCCC 일괄 조회 - 신규 추가
  // ============================================
  'orders_with_pccc': async (store, params) => {
    const { orderIds } = params;
    
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      throw new Error('orderIds 배열은 필수 파라미터입니다');
    }

    const config = STORES_CONFIG[store];
    let token;
    if (config.authType === 'admin_token') {
      token = config.getToken();
    } else if (config.authType === 'client_credentials') {
      token = await getApoeuroToken();
    }

    const orderIdsGql = orderIds.slice(0, 100).map(id => `"gid://shopify/Order/${id}"`).join(',');
    
    const graphqlQuery = {
      query: `{
        nodes(ids: [${orderIdsGql}]) {
          ... on Order {
            id
            legacyResourceId
            name
            customAttributes {
              key
              value
            }
          }
        }
      }`
    };

    try {
      const response = await axios({
        method: 'POST',
        url: `https://${config.domain}/admin/api/2024-01/graphql.json`,
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json'
        },
        data: graphqlQuery,
        timeout: 30000
      });

      if (response.data.errors) {
        throw new Error(`GraphQL 오류: ${JSON.stringify(response.data.errors)}`);
      }

      return response.data;

    } catch (error) {
      if (error.response) {
        throw new Error(
          `GraphQL API 오류 [${error.response.status}]: ${JSON.stringify(error.response.data)}`
        );
      }
      throw new Error(`네트워크 오류: ${error.message}`);
    }
  }
};

// ============================================
// Main Handler
// ============================================
exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'POST 메서드만 허용됩니다' })
    };
  }

  try {
    const { store, action, params = {} } = JSON.parse(event.body || '{}');

    if (!store || !action) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ 
          error: 'store와 action은 필수 파라미터입니다',
          received: { store, action }
        })
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
      body: JSON.stringify({
        success: true,
        store,
        action,
        data: result
      })
    };

  } catch (error) {
    console.error('Shopify Proxy Error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      })
    };
  }
};
