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
  },
  myapo: {
    domain: '6vg850-x4.myshopify.com',
    auth: 'oauth',
    clientId: process.env.SHOPIFY_MYAPO_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_MYAPO_CLIENT_SECRET,
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

  if (s.tokenCache && s.tokenExpiry && Date.now() < s.tokenExpiry) {
    console.log(`[${storeKey}] 캐시된 토큰 사용`);
    return s.tokenCache;
  }

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
  s.tokenExpiry = Date.now() + (res.data.expires_in - 300) * 1000;
  console.log(`[${storeKey}] 토큰 저장 완료`);
  return s.tokenCache;
}

// ============================================================
// 비회원 배송조회 — 이메일 + 주문번호 둘 다 일치해야만 반환
// ============================================================
async function trackOrder(storeKey, email, orderNumber) {
  const s = STORES[storeKey];
  if (!s) return { success: false, error: '지원하지 않는 스토어' };
  if (!email || !orderNumber) return { success: false, error: '이메일과 주문번호를 모두 입력해 주세요.' };

  const token = await getToken(storeKey);
  const num = String(orderNumber).replace(/^#/, '').trim();

  // 주문번호(name)로 조회 — status=any (취소/미결제 포함)
  const url = `https://${s.domain}/admin/api/2026-01/orders.json`
    + `?status=any&name=${encodeURIComponent('#' + num)}`
    + `&fields=id,name,order_number,email,contact_email,created_at,financial_status,`
    + `fulfillment_status,cancelled_at,fulfillments,line_items,order_status_url`;

  let orders = [];
  try {
    const r = await axios.get(url, { headers: { 'X-Shopify-Access-Token': token } });
    orders = r.data.orders || [];
  } catch (e) { orders = []; }

  // name 파라미터가 안 먹는 경우 대비 — 번호 숫자 매칭 폴백
  const emailNorm = String(email).trim().toLowerCase();
  const match = orders.find(o => {
    const oe = String(o.email || o.contact_email || '').trim().toLowerCase();
    const on = String(o.order_number || '').replace(/^#/, '');
    return oe === emailNorm && (on === num || String(o.name).replace(/^#/, '') === num);
  });

  // 무단조회 방지: 이메일 불일치 시 존재 여부도 노출하지 않음
  if (!match) {
    return { success: false, error: '일치하는 주문을 찾을 수 없습니다. 이메일과 주문번호를 확인해 주세요.' };
  }

  const fuls = (match.fulfillments || []).filter(f => f.status !== 'cancelled');
  const tracks = [];
  fuls.forEach(f => {
    (f.tracking_numbers && f.tracking_numbers.length
      ? f.tracking_numbers
      : (f.tracking_number ? [f.tracking_number] : [])
    ).forEach((tn, i) => {
      const urls = f.tracking_urls || (f.tracking_url ? [f.tracking_url] : []);
      tracks.push({
        company: f.tracking_company || '',
        number: tn,
        url: urls[i] || urls[0] || ''
      });
    });
  });

  // 상태 한글화
  let statusKr;
  if (match.cancelled_at) statusKr = '주문취소';
  else if (match.fulfillment_status === 'fulfilled') statusKr = tracks.length ? '배송중' : '출고완료';
  else if (match.fulfillment_status === 'partial') statusKr = '부분출고';
  else if (match.financial_status === 'refunded') statusKr = '환불완료';
  else if (match.financial_status === 'paid') statusKr = '결제완료 · 상품준비중';
  else statusKr = '주문접수';

  return {
    success: true,
    order: {
      name: match.name,
      created_at: match.created_at,
      status: statusKr,
      financial_status: match.financial_status,
      fulfillment_status: match.fulfillment_status || 'unfulfilled',
      items: (match.line_items || []).map(li => `${li.title} × ${li.quantity}`),
      tracks,
      order_status_url: match.order_status_url || ''
    }
  };
}

// ============================================================
// 취소/반품 클레임 조회 — 취소·전액환불·부분환불 판정
// ============================================================
async function getShopifyClaims(storeKey, days) {
  const s = STORES[storeKey];
  if (!s) throw new Error('지원하지 않는 스토어: ' + storeKey);
  const token = await getToken(storeKey);

  const since = new Date();
  since.setDate(since.getDate() - (days || 30));
  const url = `https://${s.domain}/admin/api/2026-01/orders.json`
    + `?status=any&limit=250&updated_at_min=${since.toISOString()}&order=updated_at+desc`
    + `&fields=id,order_number,name,financial_status,cancelled_at,created_at,total_price,refunds,line_items`;

  const r = await axios.get(url, { headers: { 'X-Shopify-Access-Token': token } });
  const orders = r.data.orders || [];

  const claims = [];
  orders.forEach(o => {
    const fs = o.financial_status || '';
    const cs = o.cancelled_at;
    const refs = o.refunds || [];
    let claimType = null, status = null;
    if (cs) { claimType = '취소'; status = '취소완료'; }
    else if (fs === 'refunded' || fs === 'voided') { claimType = '반품'; status = '반품완료'; }
    else if (fs === 'partially_refunded' || refs.length > 0) { claimType = '반품'; status = '반품신청'; }
    if (!claimType) return;

    claims.push({
      key: `SHOPIFY_${storeKey}_${o.id}`,
      store: storeKey,
      order_number: String(o.order_number || o.id),
      claim_type: claimType,
      status,
      financial_status: fs,
      product: (o.line_items || []).slice(0, 3).map(li => (li.title || '').slice(0, 40)).join(', '),
      total_price: o.total_price || '0'
    });
  });
  return claims;
}

// ============================================================
// 주문 조회 (PCCC 포함)
// ============================================================
async function getOrdersWithPCCC(storeKey, limit) {
  const s = STORES[storeKey];
  const token = await getToken(storeKey);

  const oneMonthAgo = new Date();
  oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);

  const url = `https://${s.domain}/admin/api/2026-01/orders.json?status=any&limit=${limit}&created_at_min=${oneMonthAgo.toISOString()}`;
  console.log(`[${storeKey}] 주문 조회: ${url}`);

  const ordersRes = await axios.get(url, {
    headers: { 'X-Shopify-Access-Token': token }
  });

  let orders = ordersRes.data.orders || [];
  console.log(`[${storeKey}] ${orders.length}건 조회`);

  orders = orders.filter(o => {
    const fulfillments = o.fulfillments || [];
    if (fulfillments.length === 0) return true;
    return fulfillments.every(f => !f.tracking_number);
  });
  console.log(`[${storeKey}] 송장 없는 주문 ${orders.length}건`);

  if (orders.length === 0) return [];

  const gids = orders.map(o => `"gid://shopify/Order/${o.id}"`).join(',');
  const gqlRes = await axios.post(
    `https://${s.domain}/admin/api/2026-01/graphql.json`,
    {
      query: `{
        nodes(ids: [${gids}]) {
          ... on Order {
            legacyResourceId
            localizationExtensions(first: 5) {
              nodes { countryCode purpose value }
            }
          }
        }
      }`
    },
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

  return orders.map(o => {
    const a = o.shipping_address || {};
    let phone = (a.phone || '').toString();
    phone = phone.replace(/^\+?\s*82[-\s]*/, '0').replace(/\s+/g, '');
    const cityFull = [toKoreanProvince(a.province), a.city].filter(Boolean).join(' ');
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
      phone,
      zip: a.zip || '',
      city: cityFull,
      address1: a.address1 || '',
      address2: a.address2 || '',
      pccc: pcccMap[String(o.id)] || ''
    };
  });
}

// ============================================================
// 주문내역 export (상품코드 포함 + 기간 조회 + 페이지네이션)
// ⚠ orders_with_pccc 와 별개. 매일 주문수집/송장/스캔앱과 무관.
// ============================================================
async function getOrdersExport(storeKey, months) {
  const s = STORES[storeKey];
  const token = await getToken(storeKey);

  const since = new Date();
  since.setMonth(since.getMonth() - (months || 3));

  let url = `https://${s.domain}/admin/api/2026-01/orders.json`
          + `?status=any&limit=250&created_at_min=${since.toISOString()}`;
  const out = [];

  while (url) {   // Link 헤더 커서 페이지네이션 (3개월 전체 수집)
    const res = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const orders = res.data.orders || [];
    for (const o of orders) {
      for (const i of (o.line_items || [])) {
        out.push({
          store: storeKey.toUpperCase(),
          order_number: o.order_number,
          order_id: String(o.id),
          created_at: o.created_at,
          financial_status: o.financial_status,
          fulfillment_status: o.fulfillment_status || '',
          product_id:    i.product_id ? String(i.product_id) : '',
          variant_id:    i.variant_id ? String(i.variant_id) : '',
          sku:           i.sku || '',
          title:         i.title,
          variant_title: i.variant_title || '',
          quantity:      i.quantity,
          price:         i.price
        });
      }
    }
    const link = res.headers['link'] || res.headers['Link'] || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }

  console.log(`[${storeKey}] export ${out.length} line items (${months || 3}개월)`);
  return out;
}

// ============================================================
// 상품 목록 (id → handle 매핑용). 읽기 전용, 추가 액션.
// ============================================================
async function listProducts(storeKey) {
  const s = STORES[storeKey];
  const token = await getToken(storeKey);
  let url = `https://${s.domain}/admin/api/2026-01/products.json`
          + `?limit=250&fields=id,handle,title,status`;
  const out = [];
  while (url) {
    const res = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    for (const p of (res.data.products || [])) {
      out.push({ id: String(p.id), handle: p.handle, title: p.title, status: p.status });
    }
    const link = res.headers['link'] || res.headers['Link'] || '';
    const m = link.match(/<([^>]+)>;\s*rel="next"/);
    url = m ? m[1] : null;
  }
  console.log(`[${storeKey}] list_products ${out.length}건`);
  return out;
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

    // ── 주문 수집 ────────────────────────────────────────────
    if (action === 'orders_with_pccc') {
      const data = await getOrdersWithPCCC(store, params.limit || 50);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, data })
      };
    }

    // ── 비회원 배송조회 (이메일+주문번호 일치해야만 공개) ─────
    if (action === 'track_order') {
      const data = await trackOrder(store, params.email, params.order_number);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // ── 취소/반품 클레임 조회 (최근 N일, 취소·전액환불·부분환불 판정) ──
    if (action === 'claims') {
      const data = await getShopifyClaims(store, params.days || 30);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, data }) };
    }

    // ── 주문내역 export (상품코드 포함, 기간 조회) ───────────
    if (action === 'orders_export') {
      const data = await getOrdersExport(store, params.months || 3);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, count: data.length, data })
      };
    }

    // ── 상품 목록 (id→handle) ────────────────────────────────
    if (action === 'list_products') {
      const data = await listProducts(store);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, count: data.length, data })
      };
    }

    // ── 상품 등록 ────────────────────────────────────────────
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
        body: JSON.stringify({ success: true, product: createRes.data.product })
      };
    }

    // ── 컬렉션 연결 ──────────────────────────────────────────
    if (action === 'add_to_collection') {
      const s = STORES[store];
      const token = await getToken(store);
      await axios.post(
        `https://${s.domain}/admin/api/2026-01/collects.json`,
        { collect: { product_id: params.product_id, collection_id: params.collection_id } },
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── 재고 설정 ────────────────────────────────────────────
    if (action === 'set_inventory') {
      const s = STORES[store];
      const token = await getToken(store);
      await axios.post(
        `https://${s.domain}/admin/api/2026-01/inventory_levels/connect.json`,
        { location_id: params.location_id, inventory_item_id: params.inventory_item_id },
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      await axios.post(
        `https://${s.domain}/admin/api/2026-01/inventory_levels/set.json`,
        { location_id: params.location_id, inventory_item_id: params.inventory_item_id, available: params.available },
        { headers: { 'X-Shopify-Access-Token': token } }
      );
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // ── 상품 배치 등록 ───────────────────────────────────────
    if (action === 'batch_create_products') {
      const s = STORES[store];
      const token = await getToken(store);
      const products = params.products || [];
      const results = [];
      console.log(`[${store}] 배치 등록 시작: ${products.length}건`);

      for (const prod of products) {
        try {
          const createRes = await axios.post(
            `https://${s.domain}/admin/api/2026-01/products.json`,
            { product: prod.product },
            { headers: { 'X-Shopify-Access-Token': token } }
          );
          const productId = createRes.data.product.id;
          const inventoryItemId = createRes.data.product.variants[0].inventory_item_id;

          if (prod.collection_id) {
            await axios.post(
              `https://${s.domain}/admin/api/2026-01/collects.json`,
              { collect: { product_id: productId, collection_id: prod.collection_id } },
              { headers: { 'X-Shopify-Access-Token': token } }
            );
          }

          if (prod.location_id && inventoryItemId) {
            await axios.post(
              `https://${s.domain}/admin/api/2026-01/inventory_levels/connect.json`,
              { location_id: prod.location_id, inventory_item_id: inventoryItemId },
              { headers: { 'X-Shopify-Access-Token': token } }
            );
            await axios.post(
              `https://${s.domain}/admin/api/2026-01/inventory_levels/set.json`,
              { location_id: prod.location_id, inventory_item_id: inventoryItemId, available: prod.available || 999 },
              { headers: { 'X-Shopify-Access-Token': token } }
            );
          }

          results.push({ row_index: prod.row_index, success: true, product_id: productId, title: prod.product.title });
          console.log(`✅ [${prod.row_index + 1}] ${prod.product.title} → ${productId}`);
          await new Promise(resolve => setTimeout(resolve, 500));

        } catch (err) {
          results.push({ row_index: prod.row_index, success: false, error: err.message, title: prod.product.title });
          console.log(`❌ [${prod.row_index + 1}] ${prod.product.title} → ${err.message}`);
        }
      }

      const successCount = results.filter(r => r.success).length;
      const failCount    = results.filter(r => !r.success).length;
      console.log(`[${store}] 배치 완료: 성공 ${successCount} / 실패 ${failCount}`);

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          results,
          summary: { total: products.length, success: successCount, fail: failCount }
        })
      };
    }

    // ── 송장 전송 (Fulfillment 생성 또는 tracking 업데이트) ──
    if (action === 'create_fulfillment') {
      const s = STORES[store];
      if (!s) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ success: false, error: '지원하지 않는 스토어: ' + store })
        };
      }

      const token = await getToken(store);
      const {
        order_id,
        tracking_number,
        tracking_company = 'ACI EXPRESS',
        tracking_url = '',
        notify_customer = true
      } = params;

      if (!order_id || !tracking_number) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ success: false, error: 'order_id, tracking_number 필수' })
        };
      }

      // fulfillment_orders 조회
      const foRes = await axios.get(
        `https://${s.domain}/admin/api/2026-01/orders/${order_id}/fulfillment_orders.json`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );

      const fulfillmentOrders = foRes.data.fulfillment_orders || [];
      const openFOs = fulfillmentOrders.filter(fo => fo.status === 'open');
      console.log(`[${store}] order ${order_id} — open: ${openFOs.length} / 전체: ${fulfillmentOrders.length}`);

      // Case A: open fulfillment_order 있음 → 신규 fulfillment 생성
      if (openFOs.length > 0) {
        const fulfillRes = await axios.post(
          `https://${s.domain}/admin/api/2026-01/fulfillments.json`,
          {
            fulfillment: {
              message: '발송 처리',
              notify_customer,
              tracking_info: { company: tracking_company, number: tracking_number, url: tracking_url },
              line_items_by_fulfillment_order: openFOs.map(fo => ({
                fulfillment_order_id: fo.id,
                fulfillment_order_line_items: (fo.line_items || []).map(li => ({
                  id: li.id,
                  quantity: li.fulfillable_quantity
                }))
              }))
            }
          },
          { headers: { 'X-Shopify-Access-Token': token } }
        );

        const created = fulfillRes.data.fulfillment;
        console.log(`[${store}] fulfillment 생성 완료: id=${created.id}`);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            mode: 'created',
            fulfillment_id: created.id,
            fulfillment_status: created.status,
            tracking_number: created.tracking_number
          })
        };
      }

      // Case B: closed → 기존 fulfillment에 tracking 업데이트
      const orderRes = await axios.get(
        `https://${s.domain}/admin/api/2026-01/orders/${order_id}.json?fields=id,fulfillments`,
        { headers: { 'X-Shopify-Access-Token': token } }
      );

      const existingFulfillments = (orderRes.data.order && orderRes.data.order.fulfillments) || [];
      const targetFulfillment =
        existingFulfillments.find(f => !f.tracking_number) ||
        existingFulfillments[0];

      if (!targetFulfillment) {
        const statuses = fulfillmentOrders.map(fo => fo.status).join(', ') || '없음';
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: false,
            error: `처리 가능한 fulfillment 없음 (상태: ${statuses})`
          })
        };
      }

      console.log(`[${store}] tracking 업데이트 → fulfillment_id: ${targetFulfillment.id}`);
      const updateRes = await axios.post(
        `https://${s.domain}/admin/api/2026-01/fulfillments/${targetFulfillment.id}/update_tracking.json`,
        {
          fulfillment: {
            tracking_info: { company: tracking_company, number: tracking_number, url: tracking_url },
            notify_customer
          }
        },
        { headers: { 'X-Shopify-Access-Token': token } }
      );

      const updated = updateRes.data.fulfillment;
      console.log(`[${store}] tracking 업데이트 완료: ${updated.tracking_number}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          mode: 'tracking_updated',
          fulfillment_id: updated.id,
          fulfillment_status: updated.status,
          tracking_number: updated.tracking_number
        })
      };
    }

    // ── 지원하지 않는 액션 ───────────────────────────────────
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
