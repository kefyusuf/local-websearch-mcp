# My Web Search MCP Server

Bu proje, dış API bağımlılığı olmadan çalışan, yüksek performanslı ve yapay zeka destekli bir MCP (Model Context Protocol) sunucusudur.

## Özellikler

- **Browser Context Pooling:** Tarayıcı arka planda sıcak tutulur, her aramada sıfırdan açılmaz.
- **Yerel Vektör İndeksleme (sqlite-vec):** On binlerce kayıt arasında anlamsal arama C-level performansıyla yapılır.
- **Search Intent Classification:** Sorgunun niyetini (Haber, Teknik, Genel) yerel modelle anlar ve cache stratejisini buna göre ayarlar.
- **Cross-lingual Search:** Teknik İngilizce olmayan sorguları otomatik tespit eder, çevirir ve İngilizce + orijinal dilde paralel arama yaparak sonuçları birleştirir.
- **Hata Toleransı (Fallback):** Brave Search → Google → DuckDuckGo Lite sırasıyla otomatik fallback.
- **Güvenlik (SSRF Protection):** Yerel/private ağ kaynaklarına erişimi engelleyen güvenlik filtresi.
- **Rate Limiting:** Token bucket tabanlı rate limiting (web_search: 10/dk, fetch_content: 20/dk, env var ile ayarlanabilir).
- **Encoding Detection:** Meta charset tag'inden otomatik karakter kodlaması tespiti (ISO-8859-9, Windows-1254 vb.).

## Kurulum

```bash
npm install
npx playwright install chromium
npm run build
```

## Araçlar

1. `web_search` — Akıllı sıralama, niyet algılama, cross-lingual arama ve semantic re-ranking ile web'de arama yapar.
2. `fetch_content` — URL içeriğini temiz Markdown olarak getirir (akıllı TTL, encoding detection ve cache desteğiyle).

## Test

```bash
npm test            # Tek seferlik
npm run test:watch  # Watch mode
npm run test:coverage # Coverage raporu
```

## Teknik Altyapı

- **Embedding:** `Xenova/paraphrase-multilingual-MiniLM-L12-v2`
- **Intent:** `Xenova/nli-deberta-v3-xsmall`
- **Lang Detect:** `onnx-community/language_detection-ONNX`
- **Translation:** `Xenova/opus-mt-tr-en` (on-demand, yeni diller için genişletilebilir registry)
- **Database:** SQLite + `sqlite-vec` extension
- **Scraper:** Playwright (persistent instance)
- **Test:** vitest

## Rate Limiting

| Araç | Default | Çevre Değişkeni |
|------|---------|-----------------|
| web_search | 10/dk | `RATE_LIMIT_SEARCH_PER_MIN` |
| fetch_content | 20/dk | `RATE_LIMIT_FETCH_PER_MIN` |
