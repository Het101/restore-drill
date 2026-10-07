// Read-only S3 client: list a prefix, download one object. Enough for R2, S3, B2, MinIO.
// Hand-rolled Signature V4 (no SDK) so the agent stays one small, auditable dependency tree.
const crypto = require('crypto');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding, which SigV4 requires (encodeURIComponent leaves !'()* alone).
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const EMPTY_HASH = sha256('');

// Sorted, encoded query string: the same string goes into the URL and the signature.
function query(params) {
  return Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&');
}

function signV4({ method, url, headers, payloadHash, accessKeyId, secretAccessKey, region, service, amzDate }) {
  const u = new URL(url);
  const date = amzDate.slice(0, 8);
  const h = Object.fromEntries(Object.entries({ ...headers, host: u.host, 'x-amz-date': amzDate }).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const names = Object.keys(h).sort();
  const canonicalHeaders = names.map((k) => `${k}:${h[k]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalPath = u.pathname.split('/').map((s) => enc(decodeURIComponent(s))).join('/');
  const canonicalQuery = [...u.searchParams].map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`, signature };
}

const tag = (xml, name) => (xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1] || '';
const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function createStore({ endpoint, bucket, region = 'auto', accessKeyId, secretAccessKey }, fetchImpl = fetch) {
  const base = `${endpoint.replace(/\/+$/, '')}/${bucket}`;

  async function request(key, params) {
    const url = (key ? `${base}/${key.split('/').map(enc).join('/')}` : base) + (params ? `?${query(params)}` : '');
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const { signature, host, ...headers } = signV4({
      method: 'GET', url, headers: { 'x-amz-content-sha256': EMPTY_HASH }, payloadHash: EMPTY_HASH,
      accessKeyId, secretAccessKey, region, service: 's3', amzDate,
    });
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`storage ${key ? `GET ${key}` : 'list'} failed: HTTP ${res.status}`);
    return res;
  }

  return {
    // Every object under a prefix, following pagination.
    async list(prefix) {
      const out = [];
      let token = '';
      do {
        const params = { 'list-type': '2', prefix };
        if (token) params['continuation-token'] = token;
        const xml = await (await request('', params)).text();
        for (const [, c] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          out.push({ key: unxml(tag(c, 'Key')), size: Number(tag(c, 'Size')), modified: new Date(tag(c, 'LastModified')) });
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml(tag(xml, 'NextContinuationToken')) : '';
      } while (token);
      return out;
    },
    async get(key) {
      return Buffer.from(await (await request(key)).arrayBuffer());
    },
  };
}

module.exports = { createStore, signV4, query, EMPTY_HASH };
