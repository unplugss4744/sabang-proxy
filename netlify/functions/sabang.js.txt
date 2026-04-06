const iconv = require("iconv-lite");
const fetch = require("node-fetch");

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

    // UTF-8 XML을 EUC-KR로 변환해서 파일로 저장
    const eucKrBuffer = iconv.encode(xml, "EUC-KR");

    // 사방넷에 EUC-KR XML 직접 POST
    const response = await fetch(sabangUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/xml; charset=EUC-KR"
      },
      body: eucKrBuffer
    });

    const resultBuffer = await response.buffer();
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