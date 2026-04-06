const iconv = require("iconv-lite");

// 메모리에 XML 저장 (같은 인스턴스 내에서만 유효)
let storedXml = null;

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // GET 요청 → XML 반환 (사방넷이 호출)
  if (event.httpMethod === "GET") {
    if (!storedXml) {
      return { statusCode: 404, headers, body: "XML not found" };
    }
    const eucKrBuffer = iconv.encode(storedXml, "EUC-KR");
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/xml; charset=EUC-KR" },
      isBase64Encoded: true,
      body: eucKrBuffer.toString("base64")
    };
  }

  // POST 요청 → XML 저장 후 사방넷 호출
  try {
    const { xml, sabangUrl } = JSON.parse(event.body);
    storedXml = xml;

    const xmlUrl = "https://joyful-cobbler-7e9d22.netlify.app/.netlify/functions/sabang";
    const apiUrl = sabangUrl + "?xml_url=" + encodeURIComponent(xmlUrl);

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
