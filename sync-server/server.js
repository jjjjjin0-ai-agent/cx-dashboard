const express = require('express');
const cors = require('cors');
const { crawlBrand } = require('./crawl');

const app = express();
const PORT = 3355;

app.use(cors());
app.use(express.json());

// POST /sync
// body: { brand, cred: {domain,userId,passwd}, products: [...] }
app.post('/sync', async (req, res) => {
  const { brand, cred, products } = req.body;
  if (!brand || !cred || !products) {
    return res.status(400).json({ error: '브랜드/계정/제품 정보 필요' });
  }
  console.log(`[${new Date().toLocaleTimeString()}] 조회 시작: ${brand} (${products.length}개 제품)`);
  try {
    const rows = await crawlBrand(brand, cred, products);
    // 계산
    const result = rows.map(r => {
      const stockNow = r.stockNow;
      const out7d    = r.out7d;
      const avg1d    = (out7d != null) ? Math.round(out7d / 7 * 10) / 10 : null;
      const out8w    = (out7d != null) ? out7d * 8 : null;
      const stock8w  = (stockNow != null && out8w != null) ? stockNow - out8w : null;
      return { name: r.name, stockNow, out7d, avg1d, out8w, stock8w };
    });
    console.log(`[${new Date().toLocaleTimeString()}] 조회 완료: ${brand}`);
    res.json({ ok: true, brand, rows: result });
  } catch (e) {
    console.error('조회 실패:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/ping', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`CX 동기화 서버: http://localhost:${PORT}`);
});
