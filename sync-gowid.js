// Vercel Cron이 매일 자정(KST)에 호출하는 자동 고위드 동기화 함수.
// 브라우저를 안 열어놔도 서버에서 실행되며, 클라이언트의 syncGowid()와 동일한 로직을 사용한다.

const SUPABASE_URL = 'https://rqkkvpugddndzgcbaaqo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_rD4o24OUdMM3OIZxYNKIuA_2cMY_tDV';
const GAS_PROXY = 'https://script.google.com/macros/s/AKfycbyNd8r2v7ZxURA3eHQtGlAtHVciGGb33jiNqE_QLpeIZ1NA0KKWXdrFpsskKu-W4z1t/exec';

async function gasFetch(path, qs) {
  const bust = `_cb=${Date.now()}`;
  const fullQs = (qs ? qs + '&' : '') + bust;
  const url = `${GAS_PROXY}?path=${encodeURIComponent(path)}&qs=${encodeURIComponent(fullQs)}&${bust}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`GAS 오류 ${res.status}`);
  return res.json();
}

function extractLast4FromShortCard(s) {
  if (!s) return '';
  const m = String(s).match(/(\d{4})$/);
  return m ? m[1] : '';
}
function gowidDateToISO(d) {
  if (!d || d.length !== 8) return '';
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}
function gowidDatetime(d, t) {
  const date = gowidDateToISO(d);
  if (!date) return '';
  if (!t || t.length < 6) return date;
  return `${date}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
}

async function sbFetch(table, method, body, query) {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query || ''}`;
  const res = await fetch(url, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
}

module.exports = async (req, res) => {
  try {
    const year = new Date().getFullYear();
    const dateQs = `startDate=${year}0101&endDate=${year}1231`;
    const first = await gasFetch('/v2/expenses', `page=0&size=100&${dateQs}`);
    const body = first.body || first;
    if (body?.result?.code && body.result.code !== 20000000) {
      throw new Error('Gowid 오류 코드: ' + body.result.code);
    }
    const totalPages = body?.data?.totalPages || 1;
    let allItems = [...(body?.data?.content || [])];
    for (let p = 1; p < totalPages; p++) {
      const r = await gasFetch('/v2/expenses', `page=${p}&size=100&${dateQs}`);
      const rb = r.body || r;
      allItems.push(...(rb?.data?.content || []));
    }

    const cardsRes = await fetch(`${SUPABASE_URL}/rest/v1/cards_shared?select=*`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    const cards = await cardsRes.json();

    const payload = allItems.map((item) => {
      const last4 = extractLast4FromShortCard(item.shortCardNumber) || '';
      const matchCard = cards.find((c) => c.last4 === last4);
      return {
        id: `gowid_${item.expenseId}`,
        source: 'gowid',
        card_name: matchCard ? matchCard.name : item.cardAlias || (item.shortCardNumber ? `신한 ${last4}` : ''),
        last4,
        date: gowidDateToISO(item.expenseDate),
        datetime: gowidDatetime(item.expenseDate, item.expenseTime),
        merchant: item.storeName || '',
        amount: item.krwAmount || item.useAmount || 0,
        category: '',
        memo: item.memo || '',
      };
    });

    // id 기준 중복 제거 (같은 배치 안 upsert 충돌 방지)
    const deduped = [...new Map(payload.map((p) => [p.id, p])).values()];
    for (let i = 0; i < deduped.length; i += 500) {
      await sbFetch('tx_shared', 'POST', deduped.slice(i, i + 500), '?on_conflict=id');
    }

    res.status(200).json({ ok: true, synced: deduped.length, at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
