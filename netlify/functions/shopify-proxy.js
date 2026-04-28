const axios = require('axios');

// ============================================================
// 스토어 설정 + 토큰 캐싱
// ============================================================
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
    auth: 'oauth',
    clientId: process.env.SHOPIFY_FLYEURO_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_FLYEURO_CLIENT_SECRET,
    tokenCache: null,
    tokenExpiry: null
  }
};

// ============================================================
// 한국 Province 변환
// ============================================================
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

// ============================================================
// 토큰 발급 (캐싱)
// ============================================================
async function getToken(storeKey) {
  const s = STORES[storeKey];
  if (!s) throw new Error('지원하지 않는 스토어: ' + storeKey);

  // 캐시 유효하면 재사용
  if (s.tokenCache && s.tokenExpiry && Date.now() < s.tokenExpiry) {
    console.log(`[${storeKey}] 캐시된 토큰 사용`);
    return s.tokenCache;
  }

  // 새 토큰 발급
  console.log(`[${storeKey}] 새 토큰 발급 중...`);
  const res = await axios.post(
    `https://${s.domain}/admin/oauth/access_token`,
    {
      client_id: s.clientId,
      client_secret: s.clientSecret,
      grant_type: 'client_credentials'
    }
  );

  s.tokenCache = res.data.access_token;
  // 만료 5분 전까지 유효하게 설정
  s.tokenExpiry = Date.now() + (res.data.expires_in - 300) * 1000;

  console.log(`[${storeKey}] 토큰 저장 완료 (만료: ${new Date(s.tokenExpiry).toISOString()})`);
  return s.tokenCache;
}

// ============================================================
// 주문 조회 (PCCC 포함)
// ============================================================
async function getOrdersWithPCCC(storeKey, limit, fulfillmentStatus) {
  const s = STORES[storeKey];
  const token = await getToken(storeKey);

  // 1개월 전 날짜
  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  // 1) 주문 목록 조회 (fulfillment_status 없음 = 모든 주문)
  let url = `https://${s.domain}/admin/api/2026-01/orders.json?status=any&limit=${limit}&created_at_min=${oneMonthAgo.toISOString()}`;

  console.log(`[${storeKey}] 주문 목록 조회: ${url}`);
  const ordersRes = await axios.get(url, {
    headers: { 'X-Shopify-Access-Token': token }
  });

  let orders = ordersRes.data.orders || [];
  console.log(`[${storeKey}] 주문 ${orders.length}건 조회됨`);

  // 2) 송장번호 없는 주문만 필터링
  orders = orders.filter(o => {
    const fulfillments = o.fulfillments || [];
    // fulfillments 없으면 포함
    if (fulfillments.length === 0) return true;
    // 모든 fulfillment에 tracking_number 없으면 포함
    return fulfillments.every(f => !f.tracking_number);
  });

  console.log(`[${storeKey}] 송장 없는 주문 ${orders.length}건 필터링됨`);

  if (orders.length === 0) return [];

  // 2) PCCC 일괄 조회 (GraphQL)
  const gids = orders.map(o => `"gid://shopify/Order/${o.id}"`).join(',');
  const gqlRes = await axios.post(
    `https://${s.domain}/admin/api/2026-01/graphql.json`,
    {
      query: `{
        nodes(ids: [${gids}]) {
          ... on Order {
            legacyResourceId
            localizationExtensions(first: 5) {
              nodes {
                countryCode
                purpose
                value
              }
            }
          }
        }
      }`
    },
    { headers: { 'X-Shopify-Access-Token': token } }
  );

  // PCCC 매핑
  const pcccMap = {};
  (gqlRes.data.data.nodes || []).forEach(n => {
    if (!n) return;
    const node = n.localizationExtensions.nodes.find(
      x => x.countryCode === 'KR' && x.purpose === 'SHIPPING'
    );
    pcccMap[n.legacyResourceId] = node ? node.value : '';
  });

  console.log(`[${storeKey}] PCCC ${Object.keys(pcccMap).length}건 매핑 완료`);

  // 3) 데이터 가공
  return orders.map(o => {
    const a = o.shipping_address || {};

    // 전화번호 정규화 (+82 제거, 공백 제거)
    let phone = (a.phone || '').toString();
    phone = phone.replace(/^\+?\s*82[-\s]*/, '0').replace(/\s+/g, '');

    // 도시명 (Province + City)
    const cityFull = [toKoreanProvince(a.province), a.city].filter(Boolean).join(' ');

    // 한글 이름 (성+이름)
    const koreanName = (a.last_name || '') + (a.first_name || '');

    return {
      store: storeKey.toUpperCase(),
      order_number: o.order_number,
      id: String(o.id),
      name: koreanName || a.name || '',
      product: o.line_items.map(i => `${i.title} x${i.quantity}`).join(', '),
      total_price: o.total_price,
      created_at: o.created_at,
      financial_status: o.financial_status,
      email: o.email || '',
      phone: phone,
      zip: a.zip || '',
      city: cityFull,
      address1: a.address1 || '',
      address2: a.address2 || '',
      pccc: pcccMap[String(o.id)] || ''
    };
  });
}

// ============================================================
// Netlify Handler
// ============================================================
exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { store, action, params = {} } = JSON.parse(event.body || '{}');

    if (action === 'orders_with_pccc') {
      const data = await getOrdersWithPCCC(
        store,
        params.limit || 50,
        params.fulfillment_status
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, data })
      };
    }

    if (action === 'create_product') {
      const s = STORES[store];
      const token = await getToken(store);
      
      const createRes = await axios.post(
        `https://${s.domain}/admin/api/2026-01/products.json`,
        { product: params.product },
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          product: createRes.data.product
        })
      };
    }

    if (action === 'add_to_collection') {
      const s = STORES[store];
      const token = await getToken(store);
      
      await axios.post(
        `https://${s.domain}/admin/api/2026-01/collects.json`,
        {
          collect: {
            product_id: params.product_id,
            collection_id: params.collection_id
          }
        },
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true })
      };
    }

    if (action === 'set_inventory') {
      const s = STORES[store];
      const token = await getToken(store);
      
      // Step 1: connect
      await axios.post(
        `https://${s.domain}/admin/api/2026-01/inventory_levels/connect.json`,
        {
          location_id: params.location_id,
          inventory_item_id: params.inventory_item_id
        },
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      
      // Step 2: set quantity
      await axios.post(
        `https://${s.domain}/admin/api/2026-01/inventory_levels/set.json`,
        {
          location_id: params.location_id,
          inventory_item_id: params.inventory_item_id,
          available: params.available
        },
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true })
      };
    }

    if (action === 'batch_create_products') {
      const s = STORES[store];
      const token = await getToken(store);
      const products = params.products || [];
      const results = [];

      console.log(`[${store}] 배치 등록 시작: ${products.length}건`);

      for (const prod of products) {
        try {
          // 1. 상품 등록
          const createRes = await axios.post(
            `https://${s.domain}/admin/api/2026-01/products.json`,
            { product: prod.product },
            { headers: { 'X-Shopify-Access-Token': token } }
          );

          const productId = createRes.data.product.id;
          const inventoryItemId = createRes.data.product.variants[0].inventory_item_id;

          // 2. 컬렉션 연결
          if (prod.collection_id) {
            await axios.post(
              `https://${s.domain}/admin/api/2026-01/collects.json`,
              {
                collect: {
                  product_id: productId,
                  collection_id: prod.collection_id
                }
              },
              { headers: { 'X-Shopify-Access-Token': token } }
            );
          }

          // 3. 재고 설정
          if (prod.location_id && inventoryItemId) {
            await axios.post(
              `https://${s.domain}/admin/api/2026-01/inventory_levels/connect.json`,
              {
                location_id: prod.location_id,
                inventory_item_id: inventoryItemId
              },
              { headers: { 'X-Shopify-Access-Token': token } }
            );

            await axios.post(
              `https://${s.domain}/admin/api/2026-01/inventory_levels/set.json`,
              {
                location_id: prod.location_id,
                inventory_item_id: inventoryItemId,
                available: prod.available || 999
              },
              { headers: { 'X-Shopify-Access-Token': token } }
            );
          }

          results.push({
            row_index: prod.row_index,
            success: true,
            product_id: productId,
            title: prod.product.title
          });

          console.log(`✅ [${prod.row_index + 1}] ${prod.product.title} → ${productId}`);

          // Rate limit 방어 (500ms 대기)
          await new Promise(resolve => setTimeout(resolve, 500));

        } catch (err) {
          results.push({
            row_index: prod.row_index,
            success: false,
            error: err.message,
            title: prod.product.title
          });

          console.log(`❌ [${prod.row_index + 1}] ${prod.product.title} → ${err.message}`);
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount = results.filter(r => !r.success).length;

      console.log(`[${store}] 배치 완료: 성공 ${successCount}건 / 실패 ${failCount}건`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          results: results,
          summary: {
            total: products.length,
            success: successCount,
            fail: failCount
          }
        })
      };
    }

    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ success: false, error: '지원하지 않는 액션: ' + action })
    };

  } catch (err) {
    console.error('Error:', err.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
