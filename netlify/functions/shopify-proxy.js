const axios = require('axios');

const STORES = {
  apoeuro: {
    domain: 'y1nnea-w1.myshopify.com',
    auth: 'oauth',
    clientId: process.env.SHOPIFY_APOEURO_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_APOEURO_CLIENT_SECRET,
    tokenCache: null,
    tokenExpiry: null
  },
  flyeuro: {
    domain: '261486-98.myshopify.com',
    auth: 'token',
    token: process.env.SHOPIFY_FLYEURO_TOKEN
  }
};

function toKoreanProvince(p) {
  const map = {
    'Seoul': '서울특별시', 'Busan': '부산광역시', 'Daegu': '대구광역시',
    'Incheon': '인천광역시', 'Gwangju': '광주광역시', 'Daejeon': '대전광역시',
    'Ulsan': '울산광역시', 'Sejong': '세종특별자치시', 'Gyeonggi': '경기도',
    'Gangwon': '강원특별자치도', 'Chungbuk': '충청북도', 'Chungnam': '충청남도',
    'Jeonbuk': '전북특별자치도', 'Jeonnam': '전라남도', 'Gyeongbuk': '경상북도',
    'Gyeongnam': '경상남도', 'Jeju': '제주특별자치도'
  };
  return map[p] || p || '';
}

async function getToken(storeKey) {
  const s = STORES[storeKey];
  if (!s) throw new Error('지원하지 않는 스토어: ' + storeKey);
  
  if (s.auth === 'token') return s.token;

  // OAuth 토큰 캐시
  if (s.tokenCache && s.tokenExpiry && Date.now() < s.tokenExpiry) return s.tokenCache;
  
  const res = await axios.post(
    `https://${s.domain}/admin/oauth/access_token`,
    {
      client_id: s.clientId,
      client_secret: s.clientSecret,
      grant_type: 'client_credentials'
    }
  );
  s.tokenCache = res.data.access_token;
  s.tokenExpiry = Date.now() + (res.data.expires_in - 300) * 1000;
  return s.tokenCache;
}

async function getOrdersWithPCCC(storeKey, limit, fulfillmentStatus) {
  const s = STORES[storeKey];
  const token = await getToken(storeKey);

  // 1. 주문 목록
  let url = `https://${s.domain}/admin/api/2024-01/orders.json?status=any&limit=${limit}`;
  if (fulfillmentStatus) url += `&fulfillment_status=${fulfillmentStatus}`;

  const ordersRes = await axios.get(url, {
    headers: { 'X-Shopify-Access-Token': token }
  });
  const orders = ordersRes.data.orders || [];
  if (orders.length === 0) return [];

  // 2. PCCC 일괄 조회
  const gids = orders.map(o => `"gid://shopify/Order/${o.id}"`).join(',');
  const gqlRes = await axios.post(
    `https://${s.domain}/admin/api/2024-01/graphql.json`,
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

  // 3. 가공
  return orders.map(o => {
    const a = o.shipping_address || {};

    let phone = (a.phone || '').toString();
    phone = phone.replace(/^\+?\s*82[-\s]*/, '0').replace(/\s+/g, '');

    const cityFull   = [toKoreanProvince(a.province), a.city].filter(Boolean).join(' ');
    const koreanName = (a.last_name || '') + (a.first_name || '');

    return {
      store:            storeKey.toUpperCase(),
      order_number:     o.order_number,
      id:               String(o.id),
      name:             koreanName || a.name || '',
      product:          o.line_items.map(i => i.title + ' x' + i.quantity).join(', '),
      total_price:      o.total_price,
      created_at:       o.created_at,
      financial_status: o.financial_status,
      email:            o.email    || '',
      phone:            phone,
      zip:              a.zip      || '',
      city:             cityFull,
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
    const { store, action, params = {} } = JSON.parse(event.body || '{}');

    if (action === 'orders_with_pccc') {
      const data = await getOrdersWithPCCC(
        store,
        params.limit || 50,
        params.fulfillment_status
      );
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ success: false, error: '지원하지 않는 액션' }) };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
