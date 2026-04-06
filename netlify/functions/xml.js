const iconv = require("iconv-lite");

exports.handler = async (event) => {
  const xmlBuffer = global.pendingXml || Buffer.from("");
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/xml; charset=EUC-KR"
    },
    isBase64Encoded: true,
    body: xmlBuffer.toString("base64")
  };
};
