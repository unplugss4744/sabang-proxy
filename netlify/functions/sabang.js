const iconv = require("iconv-lite");

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

  // GET → XML 반환
  if (event.httpMethod === "GET") {
    if (!storedXml) {
      return { statusCode: 404, headers, body: "XML not found" };
    }
    const eucKrBuffer = iconv.encode(storedXml, "EUC-KR");
    return {
      statusCode: 200,
      headers: { 
        "Content-Type": "application/xml; charset=EUC-KR",
        "Access-Control-Allow-Origin": "*"
      },
      isBase64Encoded: true,
      body: eucKrBuffer.toString("base64")
    };
  }

  // POST → action 분기
  try {
    const body = JSON.parse(event.body);

    // action=store: XML만 저장
    if (body.action === "store") {
      storedXml = body.xml;
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ result: "stored" })
      };
    }

    // action=send: 사방넷 호출
    if (body.action === "send") {
      const xmlUrl = "https://joyful-cobbler-7e9d22.netlify.app/.netlify/functions/sabang";
      const apiUrl = body.sabangUrl + "?xml_url=" + encodeURIComponent(xmlUrl);
      const response = await fetch(apiUrl);
      const resultBuffer = Buffer.from(await response.arrayBuffer());
      const result = iconv.decode(resultBuffer, "EUC-KR");
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ result: "success", sabangResponse: result })
      };
    }

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ result: "error", message: err.message })
    };
  }
};
