export const MAX_BODY_BYTES = 1_048_576;

export function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendEmpty(res, statusCode, extraHeaders = {}) {
  res.writeHead(statusCode, extraHeaders);
  res.end();
}

export function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) {
        return;
      }

      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settled = true;
        const err = new Error("Request body too large");
        err.statusCode = 413;
        req.destroy();
        reject(err);
        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(raw));
      } catch {
        const err = new Error("Parse error");
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}
