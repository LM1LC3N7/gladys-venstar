// A self-signed certificate made in plain JavaScript (an EC P-256 key, DER by
// hand), for the TLS scenarios on the loopback: no openssl, no network.
// Used by test/http.test.js only (copied from LM1LC3N7/gladys-huum, same author).

import { generateKeyPairSync, sign } from 'node:crypto';

function der(tag, content) {
  const n = content.length;
  const head = n < 0x80 ? [tag, n] : n < 0x100 ? [tag, 0x81, n] : [tag, 0x82, n >> 8, n & 0xff];
  return Buffer.concat([Buffer.from(head), content]);
}
const seq = (...x) => der(0x30, Buffer.concat(x));
const oid = (hex) => der(0x06, Buffer.from(hex, 'hex'));

export function selfSigned(cn, serial) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const alg = seq(oid('2a8648ce3d040302'));
  const name = seq(der(0x31, seq(oid('550403'), der(0x0c, Buffer.from(cn)))));
  const validity = seq(
    der(0x17, Buffer.from('250101000000Z')),
    der(0x17, Buffer.from('350101000000Z')),
  );
  const tbs = seq(
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([serial])),
    alg,
    name,
    validity,
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const cert = seq(
    tbs,
    alg,
    der(0x03, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)])),
  );
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${cert
      .toString('base64')
      .match(/.{1,64}/g)
      .join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}
