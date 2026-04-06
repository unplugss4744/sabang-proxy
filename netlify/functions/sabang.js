const iconv = require("iconv-lite");

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const { xml, sabangUrl } = JSON.parse(event.body);

    // UTF-8 → EUC-KR 변환
    const eucKrBuffer = iconv.encode(xml, "EUC-KR");

    // Netlify Function URL (자기 자신)
    const selfUrl = "https://joyful-cobbler-7e9d22.netlify.app/.netlify/functions/xml";

    // 사방넷에 XML URL 전달
    const apiUrl = sabangUrl + "?xml_url=" + encodeURIComponent(selfUrl);

    // XML을 임시 저장 (global 변수)
    global.pendingXml = eucKrBuffer;

    const response = await fetch(apiUrl);
    const resultBuffer = Buffer.from(await response.arrayBuffer());
    const result = iconv.decode(resultBuffer, "EUC-KR");

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ result: "success", sabangResponse: result })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ result: "error", message: err.message })
    };
  }
};
