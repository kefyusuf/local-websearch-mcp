# My Web Search MCP Server (Pro Version)

Bu proje, dış API bağımlılığı olmadan çalışan, yüksek performanslı ve yapay zeka destekli bir MCP (Model Context Protocol) sunucusudur.

## İleri Seviye Özellikler

- **Browser Context Pooling:** Tarayıcı arka planda sıcak tutulur, her aramada sıfırdan açılmaz (Yıldırım hızında yanıt).
- **Yerel Vektör İndeksleme (sqlite-vec):** On binlerce kayıt arasında anlamsal arama C-level performansıyla yapılır.
- **Search Intent Classification:** Sorgunun niyetini (Haber, Teknik, Genel) yerel modelle anlar ve cache stratejisini buna göre ayarlar.
- **Cross-lingual Embeddings:** Türkçe sorguların İngilizce içeriklerle olan alakasını otomatik olarak algılar.
- **Hata Toleransı (Fallback):** Brave Search engellenirse otomatik olarak Google Web-only moduna geçer.
- **Güvenlik (SSRF Protection):** Yerel ağ kaynaklarına erişimi engelleyen güvenlik filtresine sahiptir.

## Kurulum

1. Bağımlılıkları yükleyin:
   ```bash
   npm install
   ```

2. Tarayıcıyı kurun:
   ```bash
   npx playwright install chromium
   ```

3. Derleyin:
   ```bash
   npm run build
   ```

## Araçlar

1.  `web_search`: Akıllı sıralama ve niyet algılama ile web'de arama yapar.
2.  `fetch_content`: URL içeriğini temiz Markdown olarak getirir (Akıllı TTL ve önbellek desteğiyle).

## Teknik Altyapı
- **Embedding:** `Xenova/paraphrase-multilingual-MiniLM-L12-v2`
- **Intent:** `Xenova/nli-deberta-v3-xsmall`
- **Database:** SQLite + `sqlite-vec` extension
- **Scraper:** Playwright (Persistent instance)
