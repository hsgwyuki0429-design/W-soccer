import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, isLocalCandidate, filterSdp, STUN_SERVERS } from '../src/ice.js';

const cand = (addr, type = 'host', extra = '') => `candidate:842163049 1 udp 1677729535 ${addr} 54321 typ ${type}${extra}`;

test('宅内のアドレスと公開アドレスを見分ける', () => {
  for (const a of ['192.168.0.5', '10.1.2.3', '172.16.0.1', '172.31.255.1', '169.254.1.1', '127.0.0.1',
    'abcd1234-aaaa-bbbb-cccc-0123456789ab.local', 'fe80::1', 'fd12:3456::1', '::1']) {
    assert.equal(isPrivateAddress(a), true, a);
  }
  for (const a of ['203.0.113.5', '8.8.8.8', '172.32.0.1', '172.15.0.1', '192.169.0.1', '2001:db8::1', '', null]) {
    assert.equal(isPrivateAddress(a), false, String(a));
  }
});

test('接続候補：宅内の host だけを通し、公開アドレス・srflx・relay は通さない', () => {
  assert.equal(isLocalCandidate(cand('192.168.0.5')), true);
  assert.equal(isLocalCandidate('a=' + cand('x1y2.local')), true);
  assert.equal(isLocalCandidate(cand('203.0.113.5')), false, '公開アドレスの host');
  assert.equal(isLocalCandidate(cand('203.0.113.5', 'srflx', ' raddr 192.168.0.5 rport 54321')), false, 'srflx');
  assert.equal(isLocalCandidate(cand('192.168.0.5', 'srflx')), false, 'srflx は宅内アドレスでも通さない');
  assert.equal(isLocalCandidate(cand('198.51.100.1', 'relay')), false, 'relay');
  assert.equal(isLocalCandidate(''), false);
  assert.equal(isLocalCandidate('garbage'), false);
});

test('SDP：宅内でない接続候補の行だけを取り除く', () => {
  const sdp = ['v=0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=candidate:1 1 udp 2 192.168.0.5 1000 typ host',
    'a=candidate:2 1 udp 2 203.0.113.5 2000 typ srflx raddr 192.168.0.5 rport 1000',
    'a=candidate:3 1 udp 2 abc.local 3000 typ host', 'a=end-of-candidates', ''].join('\r\n');
  const out = filterSdp(sdp);
  assert.ok(out.includes('192.168.0.5 1000'));
  assert.ok(out.includes('abc.local'));
  assert.ok(!out.includes('203.0.113.5'));
  assert.ok(out.includes('a=end-of-candidates') && out.includes('m=application'));
  assert.equal(filterSdp(undefined), undefined);
});

test('STUN サーバーが設定されている', () => {
  assert.ok(STUN_SERVERS[0].urls.every((u) => u.startsWith('stun:')));
});
