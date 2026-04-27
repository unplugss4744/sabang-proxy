const axios = require('axios');

// ============================================
// 설정 (Configuration)
// ============================================
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

// ============================================
// APOEURO 토큰 발급 함수
// ============================================
async function getApoeuroToken(config) {
  if (config.tokenCache && config.tokenExpiry && Date.now() < config.tokenExpiry) {
    return config.tokenCache;
  }

  if (!config.clientId || !config.clientSecret) {
    throw new Error(
      'APOEURO 환경변수가 설정되지 않았습니다. ' +
      'SHOPIFY_APOEURO_CLIENT_ID와 SHOPIFY_APOEURO_CLIENT_SECRET을 확인하세요.'
    );
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
  const STORES_CONFIG = getStoresConfig();
  const config = STORES_CONFIG[store];
  
  if (!config) {
    throw new Error(`지원하지 않는 스토어: ${store}`);
  }

  let token;
  if (config.authType === 'admin_token') {
    token = config.getToken();
    if (!token) {
      throw new Error(`${store} 토큰이 환경변수(SHOPIFY_FLYEURO_TOKEN)에 설정되지 않았습니다`);
    }
  } else if (config.authType === 'client_credentials') {
    token = await getApoeuroToken(config);
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
// GraphQL 호출 헬퍼
// ============================================
async function callShopifyGraphQL(store, query) {
  const STORES_CONFIG = getStoresConfig();
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
    token = await getApoeuroToken(config);
  }

  try {
    const response = await axios({
      method: 'POST',
      url: `https://${config.domain}/admin/api/2024-01/graphql.json`,
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      data: { query },
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

  // 주문 상세 조회
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

  // 송장번호 등록
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

  // PCCC 조회 (GraphQL - 전체)
  'order_pccc': async (store, params) => {
    const { orderId } = params;
    
    if (!orderId) {
      throw new Error('orderId는 필수 파라미터입니다');
    }

    const query = `{
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
    }`;

    return await callShopifyGraphQL(store, query);
  },

  // 주문 PCCC 일괄 조회
  'orders_with_pccc': async (store, params) => {
    const { orderIds } = params;
    
    if (!orderIds || !Array.isArray(orderIds) || orderIds.length === 0) {
      throw new Error('orderIds 배열은 필수 파라미터입니다');
    }

    const orderIdsGql = orderIds.slice(0, 100).map(id => `"gid://shopify/Order/${id}"`).join(',');
    
    const query = `{
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
    }`;

    return await callShopifyGraphQL(store, query);
  },

  // PCCC만 추출 (경량화)
  'get_pccc_only': async (store, params) => {
    const { orderId } = params;
    if (!orderId) throw new Error('orderId는 필수 파라미터입니다');

    const STORES_CONFIG = getStoresConfig();
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
      token = await getApoeuroToken(config);
    }

    const query = `{
      order(id: "gid://shopify/Order/${orderId}") {
        customAttributes {
          key
          value
        }
        note
      }
    }`;

    try {
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

      const order = response.data.data.order;
      let pccc = '';
      
      // customAttributes에서 찾기
      if (order.customAttributes) {
        const pcccAttr = order.customAttributes.find(attr => 
          attr.key.toLowerCase().includes('pccc') || 
          attr.key.toLowerCase().includes('customs') ||
          attr.key.toLowerCase().includes('personal')
        );
        if (pcccAttr) pccc = pcccAttr.value;
      }
      
      // note에서 찾기
      if (!pccc && order.note) {
        const match = order.note.match(/P\d{12,13}/);
        if (match) pccc = match[0];
      }
      
      return {
        orderId: orderId,
        pccc: pccc || null,
        found: !!pccc
      };

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
const actionHandlers = {
  // ... 기존 액션들 ...

  // PCCC 필드 찾기 (패턴 매칭)
  'find_pccc_field': async (store, params) => {
    const { orderId } = params;
    if (!orderId) throw new Error('orderId는 필수 파라미터입니다');

    const response = await callShopifyAPI(store, `/orders/${orderId}.json`);
    const order = response.order;
    
    // PCCC 패턴 (P + 12-13자리 숫자)
    const pcccPattern = /P\d{12,13}/g;
    const fullJson = JSON.stringify(order);
    const matches = fullJson.match(pcccPattern);
    
    if (!matches || matches.length === 0) {
      return {
        found: false,
        message: 'PCCC를 찾을 수 없습니다',
        checkedFields: {
          note: order.note,
          note_attributes: order.note_attributes,
          customer_note: order.customer?.note,
          tags: order.tags
        }
      };
    }
    
    const pccc = matches[0];
    const pcccIndex = fullJson.indexOf(pccc);
    
    // PCCC 주변 컨텍스트 (어느 필드에 있는지 확인)
    const contextStart = Math.max(0, pcccIndex - 300);
    const contextEnd = Math.min(fullJson.length, pcccIndex + 100);
    const context = fullJson.substring(contextStart, contextEnd);
    
    return {
      found: true,
      pccc: pccc,
      allMatches: matches,
      context: context,
      fields: {
        note: order.note,
        note_attributes: order.note_attributes,
        shipping_address: order.shipping_address,
        customer_note: order.customer?.note,
        tags: order.tags
      }
    };
  }
};
