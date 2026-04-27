const axios = require('axios');

const APOEURO = {
  domain: 'y1nnea-w1.myshopify.com',
  clientId: process.env.SHOPIFY_APOEURO_CLIENT_ID,
  clientSecret: process.env.SHOPIFY_APOEURO_CLIENT_SECRET,
  tokenCache: null,
  tokenExpiry: null
};

// 영문 시/도 → 한글
function toKoreanProvince(p) {
  const map = {
    'Seoul': '서울특별시',
    'Busan': '부산광역시',
    'Daegu': '대구광역시',
    'Incheon': '인천광역시',
    'Gwangju': '광주광역시',
    'Daejeon': '대전광역시',
    'Ulsan': '울산광역시',
    'Sejong': '세종특별자치시',
    'Gyeonggi': '경기도',
    'Gangwon': '강원특별자치도',
    'Chungbuk': '충청북도',
    'Chungnam': '충청남도',
    'Jeonbuk': '전북특별자치도',
    'Jeonnam': '전라남도',
    'Gyeongbuk': '경상북도',
    'Gyeongnam': '경상남도',
    'Jeju': '제주특별자치도'
  };
  return map[p] || p || '';
}

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

async function getOrdersWithPCCC(limit) {
  const token = await getApoeuroToken();

  // 1. 주문 목록
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

  // 3. 시트용 데이터 가공
  return orders.map(o => {
    const a = o.shipping_address || {};

    // 전화번호: "+82 10-4628-0164" → "010-4628-0164"
    let phone = (a.phone || '').toString();
    phone = phone.replace(/^\+?\s*82[-\s]*/, '0').replace(/\s+/g, '');

    // 시/도 한글 변환 + city 합치기
    const cityFull = [toKoreanProvince(a.province), a.city].filter(Boolean).join(' ');

    return {
      order_number:     o.order_number,
      id:               String(o.id),
      name:             a.name     || '',
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
