'use strict';

const http = require('node:http');
const https = require('node:https');
const { Readable } = require('node:stream');

// Serialize multipart bodies with Request, then use Node's native transport.
// This keeps catalog, streaming chat, and audio requests on the same path.
async function providerRequest(url, options = {}) {
    const serialized = new Request(url, options);
    const body = options.body === undefined ? null : Buffer.from(await serialized.arrayBuffer());
    const headers = Object.fromEntries(serialized.headers);
    if (body) headers['content-length'] = String(body.length);
    const address = new URL(url);
    if (!['https:', 'http:'].includes(address.protocol)) throw new Error('Unsupported provider URL.');
    const transport = address.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
        const request = transport.request(address, {
            method: serialized.method,
            headers,
            signal: options.signal
        }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400) {
                response.resume();
                reject(new Error('Provider redirected the request.'));
                return;
            }
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
                if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
            }
            resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: responseHeaders }));
        });
        request.on('error', reject);
        if (body) request.write(body);
        request.end();
    });
}

function connectionDetail(error) {
    const code = error.cause?.code || error.code;
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'DNS could not resolve the provider address.';
    if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)) {
        return 'TLS certificate verification failed. Check your system clock and network certificate settings.';
    }
    if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(code) || error.name === 'TimeoutError') return 'The provider connection timed out.';
    if (code === 'ECONNREFUSED') return 'The connection was refused.';
    if (code === 'ECONNRESET') return 'The connection was reset.';
    return code ? 'Network error ' + code + '.' : 'Request error: ' + error.message;
}

module.exports = { providerRequest, connectionDetail };
