const iconv = require('iconv-lite');

const SABANG_ID  = 'unplugss';
const SABANG_KEY = 'WA58rdRZGTC1WZ6FYbJ1KB1bHVrVZ1BVBG3';
const NETLIFY_URL = 'https://dales-london.netlify.app';

// 메모리에 XML 임시 저장
let storedOrderXml = null;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // GET: 사방넷이 XML 파일 가져가는 엔드포인트
  if (event.httpMethod === 'GET') {
    if (!storedOrderXml) {
      return { statusCode: 404, headers, body: 'XML not found' };
    }
    const eucKrBuffer = iconv.encode(storedOrderXml, 'EUC-KR');
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml; charset=EUC-KR',
        'Access-Control-Allow-Origin': '*'
      },
      isBase64Encoded: true,
      body: eucKrBuffer.toString('base64')
    };
  }

  // POST: HTML에서 주문조회 요청
  if (event.httpMethod === 'POST') {
    try {
      const body = JSON.parse(event.body);
      const startDate = body.startDate || '';
      const endDate   = body.endDate   || '';
      const status    = body.status    || '001';
      const today     = new Date().toISOString().slice(0,10).replace(/-/g,'');

      const fields = [
        'IDX','ORDER_ID','MALL_ORDER_ID','RECEIVE_NAME',
        'RECEIVE_TEL','RECEIVE_CEL','RECEIVE_ZIPCODE','RECEIVE_ADDR',
        'ORDER_ETC_14','DELV_MSG1','PRODUCT_NAME','P_PRODUCT_NAME',
        'SKU_VALUE','SALE_CNT','ORDER_DATE','ORDER_STATUS'
      ].join('|');

      // 사방넷에 넘길 XML (EUC-KR)
      storedOrderXml =
        '<?xml version="1.0" encoding="EUC-KR"?>\n<SABANG_ORDER_LIST>\n<HEADER>\n' +
        '  <SEND_COMPAYNY_ID><![CDATA[' + SABANG_ID + ']]></SEND_COMPAYNY_ID>\n' +
        '  <SEND_AUTH_KEY><![CDATA[' + SABANG_KEY + ']]></SEND_AUTH_KEY>\n' +
        '  <SEND_DATE><![CDATA[' + today + ']]></SEND_DATE>\n' +
        '</HEADER>\n<DATA>\n' +
        '  <ORD_ST_DATE><![CDATA[' + startDate + ']]></ORD_ST_DATE>\n' +
        '  <ORD_ED_DATE><![CDATA[' + endDate + ']]></ORD_ED_DATE>\n' +
        '  <ORD_FIELD><![CDATA[' + fields + ']]></ORD_FIELD>\n' +
        '  <ORDER_STATUS><![CDATA[\n' + status + ']]></ORDER_STATUS>\n' +
        '  <LANG><![CDATA[UTF-8]]></LANG>\n' +
        '</DATA>\n</SABANG_ORDER_LIST>';

      // 사방넷에 요청 (이 함수의 GET URL을 xml_url로 전달)
      const xmlUrl = NETLIFY_URL + '/.netlify/functions/order-proxy';
      const sabangUrl = 'https://sbadmin13.sabangnet.co.kr/RTL_API/xml_order_info.html?xml_url=' + encodeURIComponent(xmlUrl);

      const response = await fetch(sabangUrl);
      const resultBuffer = Buffer.from(await response.arrayBuffer());
      const resultText = iconv.decode(resultBuffer, 'EUC-KR');

      // XML 파싱
      const orders = parseOrderXml(resultText);

      storedOrderXml = null; // 사용 후 초기화

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ status: 'ok', orders, count: orders.length, raw: resultText.slice(0, 200) })
      };

    } catch(err) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ status: 'error', message: err.message })
      };
    }
  }
};

function parseOrderXml(xmlStr) {
  const orders = [];
  try {
    // DATA 블록 추출
    const dataRegex = /<DATA>([\s\S]*?)<\/DATA>/g;
    let match;
    while ((match = dataRegex.exec(xmlStr)) !== null) {
      const block = match[1];
      const g = (tag) => {
        const m = block.match(new RegExp('<' + tag + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>'));
        return m ? m[1].trim() : '';
      };
      orders.push({
        orderNo:     g('IDX'),
        mallOrderNo: g('ORDER_ID'),
        receiver:    g('RECEIVE_NAME'),
        phone1:      g('RECEIVE_TEL'),
        phone2:      g('RECEIVE_CEL'),
        zipCode:     g('RECEIVE_ZIPCODE'),
        address:     g('RECEIVE_ADDR'),
        addrDetail:  '',
        personalNo:  g('ORDER_ETC_14'),
        memo:        g('DELV_MSG1'),
        productName: g('P_PRODUCT_NAME'),
        collectName: g('PRODUCT_NAME'),
        optionName:  g('SKU_VALUE'),
        qty:         g('SALE_CNT'),
        orderDate:   g('ORDER_DATE'),
        orderStatus: g('ORDER_STATUS')
      });
    }
  } catch(e) {
    console.error('XML parse error:', e.message);
  }
  return orders;
}
