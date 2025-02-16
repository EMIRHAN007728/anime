const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const SITES = [
    { name: 'DiziWatch', url: 'https://yeniwatch.net' }
];
const JSON_FILE = 'anime_data.json';      // Önceki anime verileri
const USER_FILE = 'user_data.json';         // Takip edilecek animeler
const PHONE_NUMBER = '905343681522';         // Bildirim gönderilecek telefon numarası
const PORT = process.env.PORT || 3000;

// ----------------------
// WhatsApp Client Ayarları
// ----------------------
const client = new Client({ 
    authStrategy: new LocalAuth(),
    puppeteer: { executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' }
});

client.on('qr', qr => {
    console.log('Lütfen bu QR kodunu WhatsApp ile taratın:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp bağlantısı tamamlandı!');
});
client.initialize();

// ----------------------
// Express Sunucusu Ayarları
// ----------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public')); // Statik dosyalar (isteğe bağlı)

// ----------------------
// Yardımcı Fonksiyonlar
// ----------------------
function readOldData() {
    if (fs.existsSync(JSON_FILE)) {
        return JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    }
    return {};
}
function saveNewData(data) {
    fs.writeFileSync(JSON_FILE, JSON.stringify(data, null, 2), 'utf8');
}
function readUserData() {
    if (fs.existsSync(USER_FILE)) {
        return JSON.parse(fs.readFileSync(USER_FILE, 'utf8'));
    }
    return null;
}
function saveUserData(data) {
    fs.writeFileSync(USER_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// Yeni verideki tüm anime nesnelerini oluşturur (kapak, başlık)
function getAllAnimeObjects(newData) {
    const animeMap = {};
    for (const anime in newData['DiziWatch']) {
        animeMap[anime] = { title: anime, cover: newData['DiziWatch'][anime].cover || '' };
    }
    return Object.values(animeMap);
}

// ----------------------
// Veri Çekme Fonksiyonu: DiziWatch
// ----------------------
async function fetchDiziWatch() {
    const response = await fetch(SITES[0].url);
    const text = await response.text();
    const $ = cheerio.load(text);
    let data = {};

    $('.list-episodes .episode-box').each((i, elem) => {
        let title = $(elem).find('.serie-name a').text().trim();
        let episodeInfo = $(elem).find('.episode-name a').text().trim();
        let episodeMatch = episodeInfo.match(/(\d+)\. Sezon (\d+)\. Bölüm/);

        if (title && episodeMatch) {
            let season = parseInt(episodeMatch[1]);
            let episode = parseInt(episodeMatch[2]);
            // Yeni kapak resmi yolu: /html/body/div[2]/div[3]/div[4]/div[1]/div/div[3]/div/a
            // Bu XPath'in CSS eşdeğeri yaklaşık olarak:
            let cover = $(elem).find('a img').attr('data-src') || ''
                .find('div:nth-child(2) > div:nth-child(3) > div:nth-child(4) > div:nth-child(1) > div > div:nth-child(3) > div > a img')
                .attr('src') || '';
            data[title] = { season, episode, cover };
        }
    });
    return data;
}


// ----------------------
// Yeni Bölüm Kontrolü: Takip edilen animeler için
// ----------------------
function checkNewEpisodes(oldData, newData, trackedAnime) {
    let newEpisodes = [];
    for (let site in newData) {
        for (let anime in newData[site]) {
            const newEpisodeData = newData[site][anime];
            if (typeof newEpisodeData.episode === 'undefined') continue;
            if (!trackedAnime.includes(anime)) continue;
            const oldEpisodeData = oldData[site] && oldData[site][anime];
            if (!oldEpisodeData || (oldEpisodeData.episode < newEpisodeData.episode)) {
                newEpisodes.push({ site, name: anime, episode: newEpisodeData });
            }
        }
    }
    return newEpisodes;
}

// ----------------------
// Ana Fonksiyon: Anime Bölümlerini Kontrol Et ve Bildir
// ----------------------
async function fetchAnimeEpisodes() {
    try {
        const oldData = readOldData();
        let newData = {};
        newData['DiziWatch'] = await fetchDiziWatch();

        let userData = readUserData();
        if (!userData || !userData.tracked || userData.tracked.length === 0) {
            console.log("Takip edilecek anime seçilmemiş. Lütfen /select adresinden seçim yapın.");
            saveNewData(newData);
            return;
        }

        const trackedAnime = userData.tracked;
        const newEpisodes = checkNewEpisodes(oldData, newData, trackedAnime);

        if (newEpisodes.length > 0) {
            console.log('Yeni bölümler bulundu:', newEpisodes);
            saveNewData(newData);
            let message = '🎬 *Yeni Anime Bölümleri* 🎬\n\n';
            newEpisodes.forEach((episode, index) => {
                message += `${index + 1}. [${episode.site}]\n`;
                message += `   Anime: ${episode.name}\n`;
                message += `   Bölüm: ${episode.episode.season}. Sezon, ${episode.episode.episode}. Bölüm\n\n`;
            });
            sendWhatsAppMessage(message);
        } else {
            console.log('Takip edilen animeler için yeni bölüm bulunamadı.');
        }
    } catch (error) {
        console.error('Veri çekme hatası:', error);
    }
}

// ----------------------
// WhatsApp Mesajı Gönderme
// ----------------------
async function sendWhatsAppMessage(message) {
    try {
        console.log("WhatsApp mesajı gönderiliyor...");
        const chatId = `${PHONE_NUMBER}@c.us`;
        await client.sendMessage(chatId, message);
        console.log("WhatsApp mesajı başarıyla gönderildi!");
    } catch (error) {
        console.error("WhatsApp gönderme hatası:", error);
    }
}

// ----------------------
// Express Rotaları
// ----------------------

// Anime seçim arayüzünü sunan rota
app.get('/select', async (req, res) => {
    try {
        let newData = {};
        newData['DiziWatch'] = await fetchDiziWatch();
        const animeList = getAllAnimeObjects(newData);
        
        let html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>Anime Takip Seçimi</title>
            <style>
                body {
                    font-family: Arial, sans-serif;
                    background-color: #f0f0f0;
                    padding: 20px;
                    margin: 0;
                }
                h1 {
                    text-align: center;
                    margin-bottom: 20px;
                }
                /* 
                  Grid yapısı: 
                  - 200px minimum sütun genişliği, 
                  - boşluk (gap) 1rem 
                */
                .anime-container {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
                    gap: 1rem;
                    max-width: 1200px;
                    margin: 0 auto; /* Ortaya al */
                }
                .anime-item {
                    background: #fff;
                    border: 1px solid #ddd;
                    padding: 10px;
                    text-align: center;
                }
                .anime-item img {
                    max-width: 100%;
                    height: auto;
                    display: block;
                    margin: 0 auto 10px;
                }
                .submit-btn {
                    margin: 20px auto;
                    display: block;
                    padding: 10px 20px;
                    font-size: 16px;
                    cursor: pointer;
                }
                .anime-title {
                    margin-bottom: 10px;
                }
            </style>
        </head>
        <body>
            <h1>Takip Etmek İstediğiniz Animeleri Seçin</h1>
            <form method="POST" action="/select">
                <div class="anime-container">
        `;

        animeList.forEach(anime => {
            html += `
                <div class="anime-item">
                    <img src="${anime.cover}" alt="${anime.title}">
                    <div class="anime-title">${anime.title}</div>
                    <input type="checkbox" name="tracked" value="${anime.title}">
                </div>
            `;
        });

        html += `
                </div>
                <button type="submit" class="submit-btn">Seçimi Kaydet</button>
            </form>
        </body>
        </html>
        `;

        res.send(html);
    } catch (error) {
        res.status(500).send("Hata: " + error.message);
    }
});


// Seçim formunu işleyen rota
app.post('/select', (req, res) => {
    const tracked = req.body.tracked;
    let trackedAnime = [];
    if (typeof tracked === 'string') {
        trackedAnime = [tracked];
    } else if (Array.isArray(tracked)) {
        trackedAnime = tracked;
    }
    saveUserData({ tracked: trackedAnime });
    res.send("<h1>Seçiminiz kaydedildi!</h1><p>Bu sayfayı kapatabilirsiniz.</p>");
});

// Başlangıç sayfası (seçim yapılmamışsa yönlendirir)
app.get('/', (req, res) => {
    let userData = readUserData();
    if (!userData || !userData.tracked || userData.tracked.length === 0) {
        res.redirect('/select');
    } else {
        res.send("<h1>Anime Takip Uygulaması Çalışıyor!</h1><p>Takip listeniz kaydedildi.</p>");
    }
});

app.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor. Tarayıcınızdan /select adresine giderek animeleri seçebilirsiniz.`);
});

// ----------------------
// Periyodik Kontrol: Her 1 saatte bir yeni bölümleri kontrol et
// ----------------------
setInterval(fetchAnimeEpisodes, 3600000);
// İlk çalışmada da kontrol edelim.
fetchAnimeEpisodes();
