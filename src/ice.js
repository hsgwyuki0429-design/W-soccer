// ice.js — 直結（WebRTC）で、どの接続候補を使うか。
//
// 直結には2つの範囲がある（設定で選ぶ）：
//   どこでも   … STUN サーバーに自分の公開アドレスを教えてもらい、違うネットワークの
//                相手とも直接つなぐ。そのかわり、相手には自分のIPアドレスが見える
//   同じWi-Fiだけ … STUN を使わず、端末自身のアドレス（宅内のアドレス）だけを出す。
//                相手が出してくる公開アドレスは使わない（使うと、こちらの公開アドレスが
//                相手に見えてしまうため）
//
// 直結できなかったときは、どちらでもサーバー経由で試合を続ける。

/** STUN サーバー。公開アドレスを教えてもらうだけで、ゲームの通信は通らない。 */
export const STUN_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
];

/** 宅内・端末自身のアドレスか（mDNS の .local も含む）。公開アドレスなら false。 */
export function isPrivateAddress(addr) {
  const a = String(addr || '').toLowerCase();
  if (!a) return false;
  if (a.endsWith('.local')) return true;                    // mDNS（ブラウザが宅内アドレスを隠すための名前）
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(a);
  if (v4) {
    const x = Number(v4[1]), y = Number(v4[2]);
    return x === 10 || x === 127 || (x === 192 && y === 168) ||
      (x === 172 && y >= 16 && y <= 31) || (x === 169 && y === 254);
  }
  if (a.includes(':')) return a === '::1' || a.startsWith('fe80:') || /^f[cd][0-9a-f]{2}:/.test(a);   // IPv6: ループバック・リンクローカル・ULA
  return false;
}

/** 接続候補（'candidate:… typ host' や 'a=candidate:…'）が、端末自身の宅内アドレスのものか。 */
export function isLocalCandidate(line) {
  const f = String(line || '').replace(/^a=/, '').trim().split(/\s+/);
  // candidate:<foundation> <component> <protocol> <priority> <address> <port> typ <type> …
  if (f.length < 8 || !f[0].startsWith('candidate:') || f[6] !== 'typ') return false;
  return f[7] === 'host' && isPrivateAddress(f[4]);
}

/** SDP から、宅内のものでない接続候補の行を取り除く。 */
export function filterSdp(sdp) {
  if (typeof sdp !== 'string') return sdp;
  return sdp.split(/\r?\n/)
    .filter((l) => !l.startsWith('a=candidate:') || isLocalCandidate(l))
    .join('\r\n');
}
