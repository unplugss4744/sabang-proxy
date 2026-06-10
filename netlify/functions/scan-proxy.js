exports.handler = async (event) => {
  // CORS preflight 대응
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  var GAS_URL = 'https://script.google.com/macros/s/AKfycbxudgtX5VbLnqqBG9uvO6Xg31jYZk1Ix7SSbxzBmHmc64UTuddn3CSltRD4-g_GsSHcdA/exec';

  try {
    var res = await fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: event.body,          // 클라이언트가 보낸 그대로 GAS에 전달
      redirect: 'follow'
    });
    var text = await res.text();

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: text
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ success: false, error: 'proxy: ' + e.message })
    };
  }
};