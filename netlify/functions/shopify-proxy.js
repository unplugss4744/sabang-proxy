const axios = require('axios');

const APOEURO = {
  domain: 'y1nnea-w1.myshopify.com',
  clientId: process.env.SHOPIFY_APOEURO_CLIENT_ID,
  clientSecret: process.env.SHOPIFY_APOEURO_CLIENT_SECRET,
  tokenCache: null,
  tokenExpiry: null
};

async function getApoeuroToken() {
  if (APOEURO.tokenCache && APOEURO.tokenExpiry && Date.now() < APOEURO.tokenExpiry) {
    return APOEURO.tokenCache;
  }
  const res = await axios.post(
    `https://${APOEURO.domain}/admin/oauth/access_token`,
    {
      client_id: APOEURO.clientId,
      client_secret: APOEURO.clientSecret,
      grant_type: 'client_credentials'
    }
  );
  APOEURO.tokenCache = res.data.access_token;
  APOEURO.tokenExpiry = Date.now() + (res.data.expires_in - 300) * 1000;
  return APOEURO.tokenCache;
}

// 주문목록 + PCCC를 한 번에 가공해서 반환
async function getOrdersWithPCCC(limit) {
  const token = await getApoeuroToken();

  // 1. 주문 목록 (REST)
  const ordersRes = await axios.get(
    `https://${APOEURO.domain}/admin/api/2024-01/orders.json?status=any&limit=${limit}`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  const orders = ordersRes.data.orders || [];
  if (orders.length === 0) return [];

  // 2. PCCC 일괄 조회 (GraphQL)
  const gids = orders.map(o => `"gid://shopify/Order/${o.id}"`).join(',');
  const gqlRes = await axios.post(
    `https://${APOEURO.domain}/admin/api/2024-01/graphql.json`,
    { query: `{
      nodes(ids: [${gids}]) {
        ... on Order {
          legacyResourceId
          localizationExtensions(first: 5) {
            nodes { countryCode purpose value }
          }
        }
      }
    }` },
    { headers: { 'X-Shopify-Access-Token': token } }
  );

  const pcccMap = {};
  (gqlRes.data.data.nodes || []).forEach(n => {
    if (!n) return;
    const node = n.localizationExtensions.nodes.find(
      x => x.countryCode === 'KR' && x.purpose === 'SHIPPING'
    );
    pcccMap[n.legacyResourceId] = node ? node.value : '';
  });

  // 3. 시트에 필요한 필드만 가공
  return orders.map(o => {
    const a = o.shipping_address || {};
    return {
      order_number:     o.order_number,
      id:               String(o.id),
      name:             a.name     || '',
      product:          o.line_items.map(i => i.title + ' x' + i.quantity).join(', '),
      total_price:      o.total_price,
      created_at:       o.created_at,
      financial_status: o.financial_status,
      email:            o.email    || '',
      phone:            a.phone    || '',
      zip:              a.zip      || '',
      city:             a.city     || '',
      address1:         a.address1 || '',
      address2:         a.address2 || '',
      pccc:             pcccMap[String(o.id)] || ''
    };
  });
}

exports.handler = async (event) => {
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const { action, params = {} } = JSON.parse(event.body || '{}');

    if (action === 'orders_with_pccc') {
      const data = await getOrdersWithPCCC(params.limit || 50);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: '지원하지 않는 액션' }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
