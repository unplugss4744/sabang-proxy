

const SABANG_ID  = 'unplugss';
const SABANG_KEY = 'WA58rdRZGTC1WZ6FYbJ1KB1bHVrVZ1BVBG3';
const GAS_URL    = 'https://script.google.com/macros/s/AKfycbxjJdKOAun4fTtg7E76v7HwtF5_UTRblh77_HHCPWEN-vussFFn1PLpTwUksn5sfajYHQ/exec';

exports.handler = async (event) => {
    const headers = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode:200, headers, body:'' };

    if (event.httpMethod === 'POST') {
          try {
                  const body = JSON.parse(event.body);
                  const startDate = body.startDate || '';
                  const endDate   = body.endDate   || '';
                  const status    = body.status    || '';
                  const today     = new Date().toISOString().slice(0,10).replace(/-/g,'');

            const fields = 'IDX|ORDER_ID|MALL_ORDER_ID|RECEIVE_NAME|RECEIVE_TEL|RECEIVE_CEL|RECEIVE_ZIPCODE|RECEIVE_ADDR|ORDER_ETC_14|DELV_MSG1|PRODUCT_NAME|P_PRODUCT_NAME|SKU_VALUE|SALE_CNT|ORDER_DATE|ORDER_STATUS';

            const statusPart = status ? '  ' + '<ORDER_STATUS>' + '<![CDATA[\n' + status + ']]>' + '</ORDER_STATUS>' + '\n' : '';

            const xml =
                      '<?xml version="1.0" encoding="EUC-KR"?>\n<SABANG_ORDER_LIST>\n<HEADER>\n' +
                      '  <SEND_COMPAYNY_ID><![CDATA[' + SABANG_ID + ']]></SEND_COMPAYNY_ID>\n' +
                      '  <SEND_AUTH_KEY><![CDATA[' + SABANG_KEY + ']]></SEND_AUTH_KEY>\n' +
                      '  <SEND_DATE><![CDATA[' + today + ']]></SEND_DATE>\n' +
                      '</HEADER>\n<DATA>\n' +
                      '  <ORD_ST_DATE><![CDATA[' + startDate + ']]></ORD_ST_DATE>\n' +
                      '  <ORD_ED_DATE><![CDATA[' + endDate + ']]></ORD_ED_DATE>\n' +
                      '  <ORD_FIELD><![CDATA[' + fields + ']]></ORD_FIELD>\n' +
                      statusPart +
                      '  <LANG><![CDATA[UTF-8]]></LANG>\n' +
                      '</DATA>\n</SABANG_ORDER_LIST>';

            await fetch(GAS_URL, {
                      method: 'POST',
                      headers: {'Content-Type': 'application/json'},
                      body: JSON.stringify({ secret:'0426', action:'storeOrderXml', xml })
            });

            const xmlUrl = GAS_URL + '?xml=1&type=order';
                  const sabangUrl = 'https://sbadmin13.sabangnet.co.kr/RTL_API/xml_order_info.html?xml_url=' + encodeURIComponent(xmlUrl);

            const response = await fetch(sabangUrl);
                  const resultBuffer = Buffer.from(await response.arrayBuffer());
                  const resultText = resultBuffer.toString('utf-8');
                  const orders = parseOrderXml(resultText);

            return {
                      statusCode: 200,
                      headers,
                      body: JSON.stringify({ status:'ok', orders, count:orders.length })
            };

          } catch(err) {
                  return { statusCode:500, headers, body: JSON.stringify({ status:'error', message:err.message }) };
          }
    }
};

function parseOrderXml(xmlStr) {
    const orders = [];
    try {
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
          console.error('parse error:', e.message);
    }
    return orders;
}
