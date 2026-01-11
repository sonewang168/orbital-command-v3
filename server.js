/**
 * ═══════════════════════════════════════════════════════════════════════════
 * 🛰️ ORBITAL COMMAND - 太空氣象指揮中心 v4.0
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * 完整版後端服務
 * 
 * 功能：
 * ├── 太空氣象 API（NOAA SWPC、NASA DONKI）
 * ├── LINE BOT 整合
 * │   ├── 即時查詢太空氣象
 * │   ├── 定時推播（可自訂時間）
 * │   ├── 極光警報訂閱
 * │   └── CME/閃焰警報
 * ├── Google Sheets 歷史記錄
 * │   ├── 太陽風紀錄
 * │   ├── Kp 指數紀錄
 * │   ├── 太陽閃焰
 * │   ├── CME 事件
 * │   ├── ISS 位置
 * │   ├── 輻射紀錄
 * │   └── 訂閱設定
 * ├── 警報系統
 * │   ├── Kp >= 5 極光警報
 * │   ├── X 級閃焰警報
 * │   ├── CME 地球方向警報
 * │   └── 高輻射警報
 * └── 管理介面
 *     ├── 儀表板統計
 *     ├── 訂閱者管理
 *     └── 推播測試
 * 
 * 部署：Render / Railway
 * 
 * @author Sone Wang
 * @version 4.0.0
 * @date 2025-12-25
 * ═══════════════════════════════════════════════════════════════════════════
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();

// ═══════════════════════════════════════════════════════════════════════════
// 中間件設定
// ═══════════════════════════════════════════════════════════════════════════
app.use(cors());
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.static('public'));

// ═══════════════════════════════════════════════════════════════════════════
// 環境變數
// ═══════════════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

// Google Sheets
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

// LINE BOT
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;

// NASA API
const NASA_API_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

// 管理 API 密鑰（保護廣播端點）
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

// ═══════════════════════════════════════════════════════════════════════════
// 全域變數
// ═══════════════════════════════════════════════════════════════════════════
let doc = null;
let cachedSpaceWeather = null;
let cacheTime = 0;
const CACHE_DURATION = 60 * 1000; // 1 分鐘快取

// 定時任務
const scheduledTasks = new Map();

// 上次警報時間（避免重複發送）
let lastAlerts = {
    kp: 0,
    flare: 0,
    cme: 0,
    radiation: 0
};

// 防止 LINE Webhook 重試造成重複處理
const processedMessages = new Map();
const MESSAGE_EXPIRE_TIME = 30 * 1000; // 30 秒後過期

// ═══════════════════════════════════════════════════════════════════════════
// Google Sheets 初始化
// ═══════════════════════════════════════════════════════════════════════════
async function initGoogleSheets() {
    if (!GOOGLE_SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
        console.log('⚠️ Google Sheets 未設定，使用記憶體模式');
        return;
    }

    try {
        const auth = new JWT({
            email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
            key: GOOGLE_PRIVATE_KEY,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, auth);
        await doc.loadInfo();
        console.log('✅ Google Sheets 已連線:', doc.title);

        // 確保工作表存在
        await ensureSheet('太陽風紀錄', ['時間', '風速', '密度', 'Bz', 'Bt', '溫度']);
        await ensureSheet('Kp指數紀錄', ['時間', 'Kp', '等級', 'G等級']);
        await ensureSheet('太陽閃焰', ['時間', '等級', '類型', '通量', '來源']);
        await ensureSheet('CME事件', ['時間', '速度', '類型', '方向', '備註']);
        await ensureSheet('ISS位置', ['時間', '緯度', '經度', '高度', '速度', '位置描述']);
        await ensureSheet('輻射紀錄', ['時間', '質子通量', '電子通量', 'S等級']);
        await ensureSheet('LINE訂閱', ['用戶ID', '類型', '名稱', '訂閱時間', '推播時間', '狀態', '上次推播']);
        await ensureSheet('推播紀錄', ['時間', '用戶ID', '類型', '內容', '狀態']);
        await ensureSheet('系統設定', ['設定名稱', '設定值', '說明', '更新時間']);

        console.log('📊 所有工作表已就緒');

    } catch (error) {
        console.error('❌ Google Sheets 連線失敗:', error.message);
    }
}

async function ensureSheet(title, headers) {
    if (!doc) return null;
    
    let sheet = doc.sheetsByTitle[title];
    if (!sheet) {
        sheet = await doc.addSheet({ title, headerValues: headers });
        console.log('📄 建立工作表:', title);
    }
    return sheet;
}

// ═══════════════════════════════════════════════════════════════════════════
// LINE BOT 驗證
// ═══════════════════════════════════════════════════════════════════════════
function validateLineSignature(body, signature) {
    if (!LINE_CHANNEL_SECRET) return true; // 未設定則跳過驗證
    
    const hash = crypto
        .createHmac('SHA256', LINE_CHANNEL_SECRET)
        .update(body)
        .digest('base64');
    
    return hash === signature;
}

// ═══════════════════════════════════════════════════════════════════════════
// LINE 推播函數
// ═══════════════════════════════════════════════════════════════════════════
async function linePush(userId, messages) {
    if (!LINE_CHANNEL_ACCESS_TOKEN) {
        console.log('⚠️ LINE Token 未設定，跳過推播');
        return false;
    }

    try {
        const msgArray = Array.isArray(messages) ? messages : [{ type: 'text', text: messages }];
        
        const res = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
                to: userId,
                messages: msgArray.slice(0, 5) // LINE 最多 5 則
            })
        });

        if (!res.ok) {
            const error = await res.json();
            console.error('LINE 推播失敗:', error);
            return false;
        }

        // 記錄推播
        if (doc) {
            const sheet = doc.sheetsByTitle['推播紀錄'];
            if (sheet) {
                await sheet.addRow({
                    '時間': new Date().toISOString(),
                    '用戶ID': userId.substring(0, 10) + '...',
                    '類型': 'push',
                    '內容': msgArray[0]?.text?.substring(0, 50) || 'FlexMessage',
                    '狀態': '成功'
                });
            }
        }

        return true;
    } catch (error) {
        console.error('LINE 推播錯誤:', error.message);
        return false;
    }
}

async function lineReply(replyToken, messages) {
    if (!LINE_CHANNEL_ACCESS_TOKEN) return false;

    try {
        // 處理不同類型的訊息
        let msgArray;
        if (Array.isArray(messages)) {
            // 已經是陣列
            msgArray = messages;
        } else if (typeof messages === 'object' && messages.type) {
            // 單一訊息物件（如 Flex Message）
            msgArray = [messages];
        } else {
            // 純文字
            msgArray = [{ type: 'text', text: String(messages) }];
        }
        
        const response = await fetch('https://api.line.me/v2/bot/message/reply', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`
            },
            body: JSON.stringify({
                replyToken,
                messages: msgArray.slice(0, 5)
            })
        });

        if (!response.ok) {
            const errorData = await response.text();
            console.error('❌ [LINE] 回覆失敗:', response.status, errorData);
            return false;
        }

        return true;
    } catch (error) {
        console.error('❌ [LINE] 回覆錯誤:', error.message);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// NOAA SWPC API
// ═══════════════════════════════════════════════════════════════════════════
const NOAA_BASE = 'https://services.swpc.noaa.gov';

// 即時太陽風
async function fetchSolarWind() {
    try {
        const res = await fetch(`${NOAA_BASE}/products/solar-wind/plasma-7-day.json`);
        const data = await res.json();
        const latest = data[data.length - 1];
        if (!latest) return null;

        return {
            time: latest[0],
            density: parseFloat(latest[1]) || 0,
            speed: parseFloat(latest[2]) || 0,
            temperature: parseFloat(latest[3]) || 0
        };
    } catch (e) {
        console.error('太陽風 API 錯誤:', e.message);
        return null;
    }
}

// 磁場數據
async function fetchMagneticField() {
    try {
        const res = await fetch(`${NOAA_BASE}/products/solar-wind/mag-7-day.json`);
        const data = await res.json();
        const latest = data[data.length - 1];
        if (!latest) return null;

        return {
            time: latest[0],
            bx: parseFloat(latest[1]) || 0,
            by: parseFloat(latest[2]) || 0,
            bz: parseFloat(latest[3]) || 0,
            bt: parseFloat(latest[6]) || 0
        };
    } catch (e) {
        console.error('磁場 API 錯誤:', e.message);
        return null;
    }
}

// Kp 指數
async function fetchKpIndex() {
    try {
        const res = await fetch(`${NOAA_BASE}/products/noaa-planetary-k-index.json`);
        const data = await res.json();
        const latest = data.filter(row => row[0] !== 'time_tag').pop();
        if (!latest) return null;

        const kp = parseFloat(latest[1]) || 0;
        let gLevel = 'G0';
        if (kp >= 9) gLevel = 'G5';
        else if (kp >= 8) gLevel = 'G4';
        else if (kp >= 7) gLevel = 'G3';
        else if (kp >= 6) gLevel = 'G2';
        else if (kp >= 5) gLevel = 'G1';

        let level = 'quiet';
        if (kp > 6) level = 'severe';
        else if (kp > 4) level = 'storm';
        else if (kp > 2) level = 'active';

        return { time: latest[0], kp, level, gLevel };
    } catch (e) {
        console.error('Kp API 錯誤:', e.message);
        return null;
    }
}

// X射線通量
async function fetchXrayFlux() {
    try {
        const res = await fetch(`${NOAA_BASE}/products/goes-primary-xray.json`);
        const data = await res.json();
        const latest = data[data.length - 1];
        if (!latest) return null;

        const flux = parseFloat(latest[1]) || 0;
        let flareClass = 'A';
        let flareLevel = 0;
        
        if (flux >= 1e-4) { flareClass = 'X'; flareLevel = flux / 1e-4; }
        else if (flux >= 1e-5) { flareClass = 'M'; flareLevel = flux / 1e-5; }
        else if (flux >= 1e-6) { flareClass = 'C'; flareLevel = flux / 1e-6; }
        else if (flux >= 1e-7) { flareClass = 'B'; flareLevel = flux / 1e-7; }

        return {
            time: latest[0],
            flux,
            flareClass,
            flareLevel: flareLevel.toFixed(1),
            fullClass: `${flareClass}${flareLevel.toFixed(1)}`
        };
    } catch (e) {
        console.error('X射線 API 錯誤:', e.message);
        return null;
    }
}

// 質子通量
async function fetchProtonFlux() {
    try {
        const res = await fetch(`${NOAA_BASE}/products/goes-proton-flux.json`);
        const data = await res.json();
        const latest = data[data.length - 1];
        if (!latest) return null;

        const flux = parseFloat(latest[1]) || 0;
        let sLevel = 'S0';
        if (flux >= 100000) sLevel = 'S5';
        else if (flux >= 10000) sLevel = 'S4';
        else if (flux >= 1000) sLevel = 'S3';
        else if (flux >= 100) sLevel = 'S2';
        else if (flux >= 10) sLevel = 'S1';

        return { time: latest[0], flux, sLevel };
    } catch (e) {
        console.error('質子 API 錯誤:', e.message);
        return null;
    }
}

// 電子通量
async function fetchElectronFlux() {
    try {
        const res = await fetch(`${NOAA_BASE}/products/goes-electron-flux.json`);
        const data = await res.json();
        const latest = data[data.length - 1];
        if (!latest) return null;

        return {
            time: latest[0],
            flux: parseFloat(latest[1]) || 0
        };
    } catch (e) {
        console.error('電子 API 錯誤:', e.message);
        return null;
    }
}

// NOAA 閃焰事件
async function fetchFlareEvents() {
    try {
        const res = await fetch(`${NOAA_BASE}/products/goes-xray-flux-latest.json`);
        const data = await res.json();
        
        // 過濾 M 級以上
        const events = [];
        let currentFlare = null;
        
        for (const row of data.slice(-200)) {
            const flux = parseFloat(row[1]) || 0;
            if (flux >= 1e-5 && !currentFlare) {
                currentFlare = { start: row[0], peakFlux: flux };
            } else if (currentFlare && flux > currentFlare.peakFlux) {
                currentFlare.peakFlux = flux;
                currentFlare.peakTime = row[0];
            } else if (currentFlare && flux < 1e-6) {
                let flareClass = 'M';
                if (currentFlare.peakFlux >= 1e-4) flareClass = 'X';
                events.push({
                    time: currentFlare.peakTime || currentFlare.start,
                    class: flareClass,
                    flux: currentFlare.peakFlux
                });
                currentFlare = null;
            }
        }

        return events.slice(-10);
    } catch (e) {
        return [];
    }
}

// NASA CME
async function fetchCME() {
    try {
        const endDate = new Date().toISOString().split('T')[0];
        const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        const res = await fetch(`https://api.nasa.gov/DONKI/CME?startDate=${startDate}&endDate=${endDate}&api_key=${NASA_API_KEY}`);
        const data = await res.json();
        
        if (!data || data.length === 0) return [];

        return data.slice(-10).map(cme => ({
            time: cme.startTime,
            speed: cme.cmeAnalyses?.[0]?.speed || 0,
            type: cme.cmeAnalyses?.[0]?.type || 'Unknown',
            halfAngle: cme.cmeAnalyses?.[0]?.halfAngle || 0,
            note: cme.note || '',
            link: cme.link || ''
        }));
    } catch (e) {
        console.error('CME API 錯誤:', e.message);
        return [];
    }
}

// NASA 太陽閃焰
async function fetchNASAFlares() {
    try {
        const endDate = new Date().toISOString().split('T')[0];
        const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        
        const res = await fetch(`https://api.nasa.gov/DONKI/FLR?startDate=${startDate}&endDate=${endDate}&api_key=${NASA_API_KEY}`);
        const data = await res.json();
        
        if (!data || data.length === 0) return [];

        return data.slice(-10).map(flr => ({
            time: flr.beginTime,
            peakTime: flr.peakTime,
            endTime: flr.endTime,
            classType: flr.classType,
            sourceLocation: flr.sourceLocation,
            activeRegion: flr.activeRegionNum,
            link: flr.link || ''
        }));
    } catch (e) {
        console.error('NASA 閃焰 API 錯誤:', e.message);
        return [];
    }
}

// ISS 位置
async function fetchISS() {
    try {
        const res = await fetch('https://api.wheretheiss.at/v1/satellites/25544');
        const data = await res.json();
        
        const lat = data.latitude;
        const lon = data.longitude;
        
        // 判斷位置
        let location = '海洋上空';
        if (lat > 20 && lat < 50 && lon > 120 && lon < 150) location = '日本/台灣上空';
        else if (lat > 30 && lat < 50 && lon > -130 && lon < -60) location = '美國上空';
        else if (lat > 35 && lat < 70 && lon > -10 && lon < 40) location = '歐洲上空';
        else if (lat > -35 && lat < 0 && lon > 110 && lon < 155) location = '澳洲上空';
        else if (lat > 0 && lat < 55 && lon > 60 && lon < 140) location = '亞洲上空';
        else if (lat > -60 && lat < 15 && lon > -80 && lon < -35) location = '南美洲上空';
        else if (lat > -35 && lat < 35 && lon > -20 && lon < 50) location = '非洲上空';
        else if (Math.abs(lat) > 60) location = '極區上空';

        return {
            lat: data.latitude,
            lon: data.longitude,
            altitude: data.altitude,
            velocity: data.velocity,
            visibility: data.visibility,
            location
        };
    } catch (e) {
        console.error('ISS API 錯誤:', e.message);
        return null;
    }
}

// 天氣
async function fetchWeather(lat, lon) {
    try {
        const res = await fetch(
            `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,visibility,cloud_cover&daily=sunrise,sunset&timezone=auto`
        );
        const data = await res.json();

        const weatherCodes = {
            0: { condition: 'Clear', icon: '☀️', desc: '晴天' },
            1: { condition: 'Partly cloudy', icon: '🌤️', desc: '晴時多雲' },
            2: { condition: 'Cloudy', icon: '⛅', desc: '多雲' },
            3: { condition: 'Overcast', icon: '☁️', desc: '陰天' },
            45: { condition: 'Fog', icon: '🌫️', desc: '霧' },
            48: { condition: 'Fog', icon: '🌫️', desc: '霧' },
            51: { condition: 'Drizzle', icon: '🌦️', desc: '毛毛雨' },
            53: { condition: 'Drizzle', icon: '🌦️', desc: '毛毛雨' },
            55: { condition: 'Drizzle', icon: '🌦️', desc: '毛毛雨' },
            61: { condition: 'Rain', icon: '🌧️', desc: '小雨' },
            63: { condition: 'Rain', icon: '🌧️', desc: '中雨' },
            65: { condition: 'Heavy rain', icon: '🌧️', desc: '大雨' },
            71: { condition: 'Snow', icon: '❄️', desc: '小雪' },
            73: { condition: 'Snow', icon: '❄️', desc: '中雪' },
            75: { condition: 'Heavy snow', icon: '❄️', desc: '大雪' },
            80: { condition: 'Rain showers', icon: '🌧️', desc: '陣雨' },
            81: { condition: 'Rain showers', icon: '🌧️', desc: '陣雨' },
            82: { condition: 'Heavy rain', icon: '⛈️', desc: '暴雨' },
            95: { condition: 'Thunderstorm', icon: '⛈️', desc: '雷雨' },
            96: { condition: 'Thunderstorm', icon: '⛈️', desc: '雷雨伴冰雹' },
            99: { condition: 'Thunderstorm', icon: '⛈️', desc: '強雷雨' }
        };

        const code = data.current.weather_code;
        const weather = weatherCodes[code] || { condition: 'Unknown', icon: '🌤️', desc: '未知' };

        return {
            temp: data.current.temperature_2m,
            feelsLike: data.current.apparent_temperature,
            humidity: data.current.relative_humidity_2m,
            windSpeed: data.current.wind_speed_10m,
            visibility: data.current.visibility,
            cloudCover: data.current.cloud_cover,
            condition: weather.condition,
            icon: weather.icon,
            description: weather.desc,
            sunrise: data.daily?.sunrise?.[0]?.split('T')[1] || '',
            sunset: data.daily?.sunset?.[0]?.split('T')[1] || ''
        };
    } catch (e) {
        console.error('天氣 API 錯誤:', e.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 火箭發射資訊 (靜態資料 + 官網連結)
// ═══════════════════════════════════════════════════════════════════════════

// 取得近期發射計畫 - 每月手動更新或導向官網
function getUpcomingLaunches() {
    const now = new Date();
    
    // 2025 年底 ~ 2026 年初 的已知發射計畫
    // 這些是大致計畫，實際時間請查看官網
    const launches = [
        {
            name: 'Starlink Group 衛星發射',
            dateLocal: '每週都有發射',
            details: 'SpaceX 星鏈衛星，幾乎每週發射',
            provider: 'SpaceX',
            status: '🟢 持續進行'
        },
        {
            name: 'Starship Flight 8+',
            dateLocal: '2025 年持續測試',
            details: '星艦軌道測試，預計多次試飛',
            provider: 'SpaceX',
            status: '🟡 待定'
        },
        {
            name: 'Crew-10 載人任務',
            dateLocal: '2025 年 Q1',
            details: 'NASA 國際太空站載人輪替',
            provider: 'SpaceX',
            status: '🟡 計畫中'
        },
        {
            name: 'Artemis II 繞月',
            dateLocal: '2025 年 9 月（暫定）',
            details: 'NASA 重返月球載人飛行',
            provider: 'NASA/SpaceX',
            status: '🟡 計畫中'
        },
        {
            name: '嫦娥七號',
            dateLocal: '2026 年',
            details: '中國月球南極探測',
            provider: 'CNSA',
            status: '🟡 計畫中'
        }
    ];
    
    return launches;
}

// 取得下一個重大發射
function getNextMajorLaunch() {
    const launches = getUpcomingLaunches();
    return launches[0] || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 月相計算
// ═══════════════════════════════════════════════════════════════════════════
function getMoonPhase(date = new Date()) {
    // 計算月相 (0-29.53 天為一個週期)
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    
    // 使用簡化的月相計算公式
    let c, e, jd, b;
    
    if (month < 3) {
        c = year - 1;
        e = month + 12;
    } else {
        c = year;
        e = month;
    }
    
    jd = Math.floor(365.25 * c) + Math.floor(30.6001 * (e + 1)) + day - 694039.09;
    jd /= 29.53058867;
    b = Math.floor(jd);
    jd -= b;
    const phase = Math.round(jd * 8);
    
    const phases = [
        { name: '新月', icon: '🌑', english: 'New Moon', illumination: 0 },
        { name: '眉月', icon: '🌒', english: 'Waxing Crescent', illumination: 12.5 },
        { name: '上弦月', icon: '🌓', english: 'First Quarter', illumination: 25 },
        { name: '盈凸月', icon: '🌔', english: 'Waxing Gibbous', illumination: 37.5 },
        { name: '滿月', icon: '🌕', english: 'Full Moon', illumination: 50 },
        { name: '虧凸月', icon: '🌖', english: 'Waning Gibbous', illumination: 62.5 },
        { name: '下弦月', icon: '🌗', english: 'Last Quarter', illumination: 75 },
        { name: '殘月', icon: '🌘', english: 'Waning Crescent', illumination: 87.5 }
    ];
    
    const currentPhase = phases[phase % 8];
    
    // 計算下一個滿月
    const daysUntilFull = ((4 - phase + 8) % 8) * 3.69;
    const nextFullMoon = new Date(date.getTime() + daysUntilFull * 24 * 60 * 60 * 1000);
    
    // 計算下一個新月
    const daysUntilNew = ((8 - phase) % 8) * 3.69;
    const nextNewMoon = new Date(date.getTime() + daysUntilNew * 24 * 60 * 60 * 1000);
    
    return {
        phase: currentPhase.name,
        icon: currentPhase.icon,
        english: currentPhase.english,
        illumination: Math.round(50 - Math.abs(50 - (phase * 12.5))),
        age: Math.round(jd * 29.53),
        nextFullMoon: nextFullMoon.toLocaleDateString('zh-TW'),
        nextNewMoon: nextNewMoon.toLocaleDateString('zh-TW'),
        isGoodForViewing: phase >= 5 || phase <= 1 // 新月前後適合觀星
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 流星雨預報
// ═══════════════════════════════════════════════════════════════════════════
function getMeteorShowers() {
    const showers = [
        { name: '象限儀座流星雨', english: 'Quadrantids', peak: '01-03', end: '01-04', rate: 120, parent: '小行星 2003 EH1' },
        { name: '天琴座流星雨', english: 'Lyrids', peak: '04-22', end: '04-23', rate: 20, parent: '撒切爾彗星' },
        { name: '寶瓶座η流星雨', english: 'Eta Aquariids', peak: '05-06', end: '05-07', rate: 50, parent: '哈雷彗星' },
        { name: '寶瓶座δ南流星雨', english: 'Delta Aquariids', peak: '07-30', end: '07-31', rate: 25, parent: '乾達彗星' },
        { name: '英仙座流星雨', english: 'Perseids', peak: '08-12', end: '08-13', rate: 100, parent: '斯威夫特-塔特爾彗星' },
        { name: '天龍座流星雨', english: 'Draconids', peak: '10-08', end: '10-09', rate: 10, parent: '賈科比尼-津納彗星' },
        { name: '獵戶座流星雨', english: 'Orionids', peak: '10-21', end: '10-22', rate: 20, parent: '哈雷彗星' },
        { name: '金牛座南流星雨', english: 'S. Taurids', peak: '11-05', end: '11-06', rate: 5, parent: '恩克彗星' },
        { name: '獅子座流星雨', english: 'Leonids', peak: '11-17', end: '11-18', rate: 15, parent: '坦普爾-塔特爾彗星' },
        { name: '雙子座流星雨', english: 'Geminids', peak: '12-14', end: '12-15', rate: 150, parent: '小行星 3200 法厄同' },
        { name: '小熊座流星雨', english: 'Ursids', peak: '12-22', end: '12-23', rate: 10, parent: '塔特爾彗星' }
    ];
    
    const now = new Date();
    const year = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const currentDay = now.getDate();
    const today = `${String(currentMonth).padStart(2, '0')}-${String(currentDay).padStart(2, '0')}`;
    
    // 找出最接近的流星雨
    let upcoming = [];
    let active = null;
    
    for (const shower of showers) {
        const peakParts = shower.peak.split('-');
        const peakMonth = parseInt(peakParts[0]);
        const peakDay = parseInt(peakParts[1]);
        
        // 計算距離今天的天數
        let peakDate = new Date(year, peakMonth - 1, peakDay);
        if (peakDate < now) {
            peakDate = new Date(year + 1, peakMonth - 1, peakDay);
        }
        
        const daysUntil = Math.ceil((peakDate - now) / (1000 * 60 * 60 * 24));
        
        // 檢查是否正在活躍（極大期前後 3 天）
        if (daysUntil >= -3 && daysUntil <= 3) {
            active = { ...shower, daysUntil, peakDate: peakDate.toLocaleDateString('zh-TW') };
        }
        
        if (daysUntil > 0) {
            upcoming.push({ ...shower, daysUntil, peakDate: peakDate.toLocaleDateString('zh-TW') });
        }
    }
    
    // 排序取最近 3 個
    upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
    upcoming = upcoming.slice(0, 3);
    
    // 取得月相判斷觀測條件
    const moon = getMoonPhase();
    const viewingCondition = moon.isGoodForViewing ? '極佳（少月光干擾）' : '一般（有月光干擾）';
    
    return {
        active,
        upcoming,
        viewingCondition,
        moonPhase: moon.phase,
        moonIcon: moon.icon
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 綜合太空氣象數據
// ═══════════════════════════════════════════════════════════════════════════
async function getSpaceWeather(forceRefresh = false) {
    const now = Date.now();
    
    // 使用快取
    if (!forceRefresh && cachedSpaceWeather && (now - cacheTime) < CACHE_DURATION) {
        return cachedSpaceWeather;
    }

    try {
        const [solarWind, magField, kp, xray, proton, electron, cme, nasaFlares, iss] = await Promise.all([
            fetchSolarWind(),
            fetchMagneticField(),
            fetchKpIndex(),
            fetchXrayFlux(),
            fetchProtonFlux(),
            fetchElectronFlux(),
            fetchCME(),
            fetchNASAFlares(),
            fetchISS()
        ]);

        // 計算極光可見機率
        const kpValue = kp?.kp || 2;
        const auroraChances = {
            iceland: Math.min(95, Math.round(kpValue * 15 + 40)),
            norway: Math.min(90, Math.round(kpValue * 15 + 30)),
            finland: Math.min(85, Math.round(kpValue * 15 + 20)),
            canada: Math.min(80, Math.round(kpValue * 15 + 10)),
            alaska: Math.min(75, Math.round(kpValue * 15 + 5)),
            hokkaido: Math.max(5, Math.round(kpValue * 15 - 30)),
            japan: Math.max(5, Math.round(kpValue * 15 - 30)),
            scotland: Math.max(10, Math.round(kpValue * 15 - 20)),
            newZealand: Math.max(5, Math.round(kpValue * 15 - 35))
        };

        // 計算警報等級
        let alertLevel = 'normal';
        let alertMessages = [];

        if (kpValue >= 7) {
            alertLevel = 'severe';
            alertMessages.push(`🔴 強烈地磁風暴 G${kp.gLevel.replace('G', '')}`);
        } else if (kpValue >= 5) {
            alertLevel = 'warning';
            alertMessages.push(`🟠 地磁風暴 ${kp.gLevel}`);
        }

        if (xray?.flareClass === 'X') {
            alertLevel = 'severe';
            alertMessages.push(`🔴 X 級太陽閃焰 ${xray.fullClass}`);
        } else if (xray?.flareClass === 'M') {
            if (alertLevel === 'normal') alertLevel = 'warning';
            alertMessages.push(`🟠 M 級太陽閃焰 ${xray.fullClass}`);
        }

        if (proton?.sLevel && proton.sLevel !== 'S0') {
            if (proton.sLevel >= 'S3') alertLevel = 'severe';
            else if (alertLevel === 'normal') alertLevel = 'warning';
            alertMessages.push(`☢️ 輻射風暴 ${proton.sLevel}`);
        }

        const result = {
            success: true,
            timestamp: new Date().toISOString(),
            alertLevel,
            alertMessages,
            solarWind: solarWind || { speed: 400, density: 4, temperature: 100000 },
            magneticField: magField || { bz: 0, bt: 5, bx: 0, by: 0 },
            kp: kp || { kp: 2, level: 'quiet', gLevel: 'G0' },
            xray: xray || { flux: 1e-7, flareClass: 'B', fullClass: 'B1.0' },
            proton: proton || { flux: 1, sLevel: 'S0' },
            electron: electron || { flux: 10000 },
            cme: cme || [],
            flares: nasaFlares || [],
            iss: iss,
            aurora: auroraChances
        };

        cachedSpaceWeather = result;
        cacheTime = now;

        return result;
    } catch (error) {
        console.error('綜合數據錯誤:', error.message);
        return {
            success: false,
            error: error.message,
            timestamp: new Date().toISOString()
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// LINE 訊息格式化
// ═══════════════════════════════════════════════════════════════════════════
function formatSpaceWeatherMessage(data) {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    
    const kpEmoji = data.kp.kp <= 2 ? '🟢' : data.kp.kp <= 4 ? '🟡' : data.kp.kp <= 6 ? '🟠' : '🔴';
    const kpStatus = data.kp.kp <= 2 ? '平靜' : data.kp.kp <= 4 ? '活躍' : data.kp.kp <= 6 ? '風暴' : '劇烈';

    let message = `🛰️ 太空氣象報告
━━━━━━━━━━━━━━━━

🌌 極光預報
${kpEmoji} Kp 指數：${data.kp.kp.toFixed(1)} (${kpStatus})
📊 地磁警報：${data.kp.gLevel}

🌍 極光可見機率
🇮🇸 冰島：${data.aurora.iceland}%
🇳🇴 挪威：${data.aurora.norway}%
🇫🇮 芬蘭：${data.aurora.finland}%
🇯🇵 北海道：${data.aurora.hokkaido}%

━━━━━━━━━━━━━━━━

☀️ 太陽活動
🔥 閃焰等級：${data.xray.fullClass}
💨 太陽風：${Math.round(data.solarWind.speed)} km/s
🧲 磁場 Bz：${data.magneticField.bz.toFixed(1)} nT
☢️ 輻射等級：${data.proton.sLevel}

━━━━━━━━━━━━━━━━

🚀 ISS 國際太空站
📍 ${data.iss?.location || '計算中'}
🌐 ${data.iss?.lat?.toFixed(2) || '--'}°, ${data.iss?.lon?.toFixed(2) || '--'}°
📡 高度：${Math.round(data.iss?.altitude || 408)} km

━━━━━━━━━━━━━━━━

⏰ 更新時間：${now}

💡 輸入指令查看更多：
「極光」「太陽風」「ISS」「訂閱」`;

    return message;
}

function formatAuroraMessage(data) {
    const kpEmoji = data.kp.kp <= 2 ? '🟢' : data.kp.kp <= 4 ? '🟡' : data.kp.kp <= 6 ? '🟠' : '🔴';
    
    return `🌌 極光預報
━━━━━━━━━━━━━━━━

${kpEmoji} Kp 地磁指數：${data.kp.kp.toFixed(1)}
📊 地磁警報等級：${data.kp.gLevel}

🌍 各地可見機率：

🇮🇸 冰島 雷克雅維克：${data.aurora.iceland}%
🇳🇴 挪威 特羅姆瑟：${data.aurora.norway}%
🇫🇮 芬蘭 羅瓦涅米：${data.aurora.finland}%
🇨🇦 加拿大 黃刀鎮：${data.aurora.canada}%
🇺🇸 阿拉斯加：${data.aurora.alaska}%
🇯🇵 日本 北海道：${data.aurora.hokkaido}%
🏴󠁧󠁢󠁳󠁣󠁴󠁿 蘇格蘭：${data.aurora.scotland}%
🇳🇿 紐西蘭：${data.aurora.newZealand}%

━━━━━━━━━━━━━━━━

📖 Kp 指數說明：
0-2：平靜，僅北極圈可見
3-4：活躍，北歐可見
5-6：風暴，中緯度可見
7+：劇烈，低緯度可能可見

💡 輸入「訂閱極光」可在 Kp≥5 時收到通知`;
}

function formatSolarWindMessage(data) {
    const speedStatus = data.solarWind.speed < 400 ? '🟢 正常' : 
                        data.solarWind.speed < 500 ? '🟡 偏高' : 
                        data.solarWind.speed < 600 ? '🟠 高速' : '🔴 極高速';

    const bzStatus = data.magneticField.bz > 0 ? '🟢 北向（穩定）' : 
                     data.magneticField.bz > -5 ? '🟡 南向（活躍）' : '🔴 強南向（風暴）';

    return `☀️ 太陽風即時數據
━━━━━━━━━━━━━━━━

💨 風速：${Math.round(data.solarWind.speed)} km/s
   ${speedStatus}

📊 密度：${data.solarWind.density.toFixed(1)} p/cm³

🌡️ 溫度：${(data.solarWind.temperature / 1000).toFixed(0)}K

━━━━━━━━━━━━━━━━

🧲 行星際磁場 (IMF)
Bz：${data.magneticField.bz.toFixed(1)} nT
   ${bzStatus}
Bt：${data.magneticField.bt.toFixed(1)} nT

━━━━━━━━━━━━━━━━

🔥 太陽閃焰
目前等級：${data.xray.fullClass}
X射線通量：${data.xray.flux.toExponential(2)} W/m²

☢️ 輻射風暴
質子通量：${data.proton.flux.toFixed(1)} pfu
等級：${data.proton.sLevel}

━━━━━━━━━━━━━━━━

📖 說明：
• 太陽風速 > 500 km/s 可能引發地磁風暴
• Bz 南向（負值）越強，地磁活動越劇烈
• X 級閃焰可能影響無線電通訊

💡 輸入「訂閱閃焰」可在 X 級閃焰時收到通知`;
}

function formatISSMessage(data) {
    if (!data.iss) {
        return '🚀 ISS 資料暫時無法取得，請稍後再試';
    }

    return `🚀 國際太空站 (ISS) 即時位置
━━━━━━━━━━━━━━━━

📍 目前位置：${data.iss.location}

🌐 座標
緯度：${data.iss.lat.toFixed(4)}°
經度：${data.iss.lon.toFixed(4)}°

📡 軌道資訊
高度：${Math.round(data.iss.altitude)} km
速度：${Math.round(data.iss.velocity).toLocaleString()} km/h

━━━━━━━━━━━━━━━━

🔭 ISS 小知識：
• 每 90 分鐘繞地球一圈
• 每天可見 16 次日出日落
• 目前有 7 名太空人駐站
• 軌道傾角 51.6°

━━━━━━━━━━━━━━━━

🌙 觀測提示：
ISS 過境時像一顆明亮的星星快速移動
可用 Spot The Station 查詢過境時間

💡 輸入「訂閱ISS」可在 ISS 過境台灣時收到通知`;
}

function formatSubscriptionMenu() {
    return {
        type: 'flex',
        altText: '訂閱設定選單',
        contents: {
            type: 'bubble',
            size: 'mega',
            header: {
                type: 'box',
                layout: 'vertical',
                contents: [
                    {
                        type: 'text',
                        text: '🔔 訂閱設定',
                        weight: 'bold',
                        size: 'xl',
                        color: '#ffffff'
                    }
                ],
                backgroundColor: '#1a1a2e',
                paddingAll: '15px'
            },
            body: {
                type: 'box',
                layout: 'vertical',
                contents: [
                    {
                        type: 'text',
                        text: '選擇要訂閱的通知類型：',
                        size: 'sm',
                        color: '#666666',
                        margin: 'md'
                    },
                    { type: 'separator', margin: 'lg' },
                    // 定時報告
                    {
                        type: 'box',
                        layout: 'horizontal',
                        contents: [
                            { type: 'text', text: '📅 每日報告', flex: 4, size: 'md' },
                            {
                                type: 'button',
                                action: { type: 'message', label: '08:00', text: '訂閱每日報告 08:00' },
                                style: 'primary',
                                height: 'sm',
                                flex: 2
                            },
                            {
                                type: 'button',
                                action: { type: 'message', label: '20:00', text: '訂閱每日報告 20:00' },
                                style: 'primary',
                                height: 'sm',
                                flex: 2,
                                margin: 'sm'
                            }
                        ],
                        margin: 'lg',
                        alignItems: 'center'
                    },
                    // 極光警報
                    {
                        type: 'box',
                        layout: 'horizontal',
                        contents: [
                            { type: 'text', text: '🌌 極光警報 (Kp≥5)', flex: 5, size: 'md' },
                            {
                                type: 'button',
                                action: { type: 'message', label: '訂閱', text: '訂閱極光警報' },
                                style: 'secondary',
                                height: 'sm',
                                flex: 2
                            }
                        ],
                        margin: 'lg',
                        alignItems: 'center'
                    },
                    // 閃焰警報
                    {
                        type: 'box',
                        layout: 'horizontal',
                        contents: [
                            { type: 'text', text: '🔥 X級閃焰警報', flex: 5, size: 'md' },
                            {
                                type: 'button',
                                action: { type: 'message', label: '訂閱', text: '訂閱閃焰警報' },
                                style: 'secondary',
                                height: 'sm',
                                flex: 2
                            }
                        ],
                        margin: 'lg',
                        alignItems: 'center'
                    },
                    // CME 警報
                    {
                        type: 'box',
                        layout: 'horizontal',
                        contents: [
                            { type: 'text', text: '🌋 CME 地球方向警報', flex: 5, size: 'md' },
                            {
                                type: 'button',
                                action: { type: 'message', label: '訂閱', text: '訂閱CME警報' },
                                style: 'secondary',
                                height: 'sm',
                                flex: 2
                            }
                        ],
                        margin: 'lg',
                        alignItems: 'center'
                    },
                    { type: 'separator', margin: 'xl' },
                    {
                        type: 'button',
                        action: { type: 'message', label: '📋 查看我的訂閱', text: '我的訂閱' },
                        style: 'link',
                        margin: 'lg'
                    },
                    {
                        type: 'button',
                        action: { type: 'message', label: '❌ 取消所有訂閱', text: '取消所有訂閱' },
                        style: 'link',
                        color: '#ff6b6b'
                    }
                ],
                paddingAll: '15px'
            }
        }
    };
}

function formatMainMenu() {
    return {
        type: 'flex',
        altText: '太空氣象指揮中心',
        contents: {
            type: 'bubble',
            size: 'mega',
            header: {
                type: 'box',
                layout: 'vertical',
                contents: [
                    {
                        type: 'text',
                        text: '🛰️ ORBITAL COMMAND',
                        weight: 'bold',
                        size: 'xl',
                        color: '#00f5ff'
                    },
                    {
                        type: 'text',
                        text: '太空氣象指揮中心',
                        size: 'sm',
                        color: '#aaaaaa',
                        margin: 'sm'
                    }
                ],
                backgroundColor: '#0a0a1a',
                paddingAll: '20px'
            },
            body: {
                type: 'box',
                layout: 'vertical',
                contents: [
                    // 第一排按鈕
                    {
                        type: 'box',
                        layout: 'horizontal',
                        contents: [
                            {
                                type: 'button',
                                action: { type: 'message', label: '🌌 極光', text: '極光' },
                                style: 'primary',
                                height: 'sm',
                                flex: 1
                            },
                            {
                                type: 'button',
                                action: { type: 'message', label: '☀️ 太陽風', text: '太陽風' },
                                style: 'primary',
                                height: 'sm',
                                flex: 1,
                                margin: 'sm'
                            },
                            {
                                type: 'button',
                                action: { type: 'message', label: '🚀 ISS', text: 'ISS' },
                                style: 'primary',
                                height: 'sm',
                                flex: 1,
                                margin: 'sm'
                            }
                        ],
                        margin: 'md'
                    },
                    // 第二排按鈕
                    {
                        type: 'box',
                        layout: 'horizontal',
                        contents: [
                            {
                                type: 'button',
                                action: { type: 'message', label: '📊 完整報告', text: '太空氣象' },
                                style: 'secondary',
                                height: 'sm',
                                flex: 1
                            },
                            {
                                type: 'button',
                                action: { type: 'message', label: '🔔 訂閱', text: '訂閱' },
                                style: 'secondary',
                                height: 'sm',
                                flex: 1,
                                margin: 'sm'
                            }
                        ],
                        margin: 'md'
                    },
                    // 第三排按鈕 - 新功能
                    {
                        type: 'box',
                        layout: 'horizontal',
                        contents: [
                            {
                                type: 'button',
                                action: { type: 'message', label: '🛸 發射', text: 'spacex' },
                                style: 'secondary',
                                height: 'sm',
                                flex: 1
                            },
                            {
                                type: 'button',
                                action: { type: 'message', label: '🌙 月相', text: '月相' },
                                style: 'secondary',
                                height: 'sm',
                                flex: 1,
                                margin: 'sm'
                            },
                            {
                                type: 'button',
                                action: { type: 'message', label: '☄️ 流星', text: '流星雨' },
                                style: 'secondary',
                                height: 'sm',
                                flex: 1,
                                margin: 'sm'
                            }
                        ],
                        margin: 'md'
                    },
                    { type: 'separator', margin: 'lg' },
                    // 快速資訊
                    {
                        type: 'box',
                        layout: 'vertical',
                        contents: [
                            {
                                type: 'text',
                                text: '💡 快速指令',
                                size: 'sm',
                                color: '#888888',
                                margin: 'md'
                            },
                            {
                                type: 'text',
                                text: '• 極光 / 太陽風 / ISS / CME',
                                size: 'xs',
                                color: '#aaaaaa',
                                margin: 'sm'
                            },
                            {
                                type: 'text',
                                text: '• 天氣 台北 / 天氣 東京',
                                size: 'xs',
                                color: '#aaaaaa',
                                margin: 'sm'
                            },
                            {
                                type: 'text',
                                text: '• 發射 / 月相 / 流星雨',
                                size: 'xs',
                                color: '#aaaaaa',
                                margin: 'sm'
                            },
                            {
                                type: 'text',
                                text: '• 訂閱 / 取消訂閱',
                                size: 'xs',
                                color: '#aaaaaa',
                                margin: 'sm'
                            }
                        ]
                    }
                ],
                paddingAll: '15px',
                backgroundColor: '#1a1a2e'
            }
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 訂閱管理
// ═══════════════════════════════════════════════════════════════════════════
async function addSubscription(userId, type, name, pushTime = null) {
    if (!doc) {
        console.log('⚠️ Google Sheets 未連線，使用記憶體模式');
        return { success: true, message: '訂閱成功（記憶體模式）' };
    }

    try {
        const sheet = doc.sheetsByTitle['LINE訂閱'];
        const rows = await sheet.getRows();
        
        // 檢查是否已訂閱
        const existing = rows.find(row => 
            row.get('用戶ID') === userId && 
            row.get('類型') === type
        );

        if (existing) {
            // 更新現有訂閱
            existing.set('推播時間', pushTime || '');
            existing.set('狀態', '啟用');
            await existing.save();
            return { success: true, message: '訂閱已更新' };
        }

        // 新增訂閱
        await sheet.addRow({
            '用戶ID': userId,
            '類型': type,
            '名稱': name,
            '訂閱時間': new Date().toISOString(),
            '推播時間': pushTime || '',
            '狀態': '啟用',
            '上次推播': ''
        });

        return { success: true, message: '訂閱成功' };
    } catch (error) {
        console.error('訂閱失敗:', error.message);
        return { success: false, message: '訂閱失敗' };
    }
}

async function removeSubscription(userId, type = null) {
    if (!doc) return { success: true };

    try {
        const sheet = doc.sheetsByTitle['LINE訂閱'];
        const rows = await sheet.getRows();

        for (const row of rows) {
            if (row.get('用戶ID') === userId) {
                if (!type || row.get('類型') === type) {
                    row.set('狀態', '停用');
                    await row.save();
                }
            }
        }

        return { success: true, message: type ? '已取消訂閱' : '已取消所有訂閱' };
    } catch (error) {
        return { success: false, message: '取消失敗' };
    }
}

async function getSubscriptions(userId) {
    if (!doc) return [];

    try {
        const sheet = doc.sheetsByTitle['LINE訂閱'];
        const rows = await sheet.getRows();

        return rows
            .filter(row => row.get('用戶ID') === userId && row.get('狀態') === '啟用')
            .map(row => ({
                type: row.get('類型'),
                name: row.get('名稱'),
                pushTime: row.get('推播時間'),
                subscribedAt: row.get('訂閱時間')
            }));
    } catch (error) {
        return [];
    }
}

async function getSubscribersByType(type) {
    if (!doc) return [];

    try {
        const sheet = doc.sheetsByTitle['LINE訂閱'];
        const rows = await sheet.getRows();

        return rows
            .filter(row => {
                // 'all' 類型返回所有啟用的訂閱者（去重）
                if (type === 'all') {
                    return row.get('狀態') === '啟用';
                }
                return row.get('類型') === type && row.get('狀態') === '啟用';
            })
            .map(row => ({
                userId: row.get('用戶ID'),
                pushTime: row.get('推播時間')
            }))
            // 去除重複的用戶 ID
            .filter((user, index, self) => 
                index === self.findIndex(u => u.userId === user.userId)
            );
    } catch (error) {
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// LINE Webhook
// ═══════════════════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
    console.log('📨 [LINE] 收到 Webhook 請求');
    
    // 檢查 TOKEN 是否設定
    if (!LINE_CHANNEL_ACCESS_TOKEN) {
        console.error('❌ [LINE] LINE_CHANNEL_ACCESS_TOKEN 未設定！無法回覆訊息');
        return res.status(200).send('OK (no token configured)');
    }
    
    // 驗證簽名
    const signature = req.headers['x-line-signature'];
    if (LINE_CHANNEL_SECRET && !validateLineSignature(req.rawBody, signature)) {
        console.error('❌ [LINE] 簽名驗證失敗');
        return res.status(401).send('Invalid signature');
    }

    const events = req.body.events || [];
    console.log(`📬 [LINE] 收到 ${events.length} 個事件`);
    
    for (const event of events) {
        try {
            if (event.type === 'message' && event.message.type === 'text') {
                // 防重複處理
                const msgId = event.message.id;
                if (processedMessages.has(msgId)) {
                    console.log(`⏭️ [LINE] 跳過重複訊息: ${msgId}`);
                    continue;
                }
                processedMessages.set(msgId, Date.now());
                
                // 清理過期的訊息記錄
                const now = Date.now();
                for (const [id, time] of processedMessages) {
                    if (now - time > MESSAGE_EXPIRE_TIME) {
                        processedMessages.delete(id);
                    }
                }
                
                console.log(`💬 [LINE] 用戶訊息: "${event.message.text}"`);
                await handleTextMessage(event);
            } else if (event.type === 'follow') {
                console.log('👋 [LINE] 新用戶加入');
                await handleFollow(event);
            } else if (event.type === 'unfollow') {
                console.log('👋 [LINE] 用戶離開');
                await handleUnfollow(event);
            }
        } catch (error) {
            console.error('❌ [LINE] 處理事件錯誤:', error.message);
        }
    }

    res.status(200).send('OK');
});

async function handleTextMessage(event) {
    const originalText = event.message.text.trim();  // 保留原始大小寫
    const text = originalText.toLowerCase();
    const userId = event.source.userId;
    const replyToken = event.replyToken;

    // ═══════════════════════════════════════════════════════════════
    // 🎯 Rich Menu 指令處理（優先處理）
    // ═══════════════════════════════════════════════════════════════
    const richMenuHandled = await handleRichMenuCommand(event, originalText);
    if (richMenuHandled) return;

    // ═══════════════════════════════════════════════════════════════
    // 快速回應指令（不需要載入太空氣象數據）
    // ═══════════════════════════════════════════════════════════════
    
    // 🛸 火箭發射
    if (text === 'spacex' || text === '發射' || text === '火箭') {
        const launches = getUpcomingLaunches();
        const next = launches[0];
        
        const msg = `🛸 太空發射資訊
━━━━━━━━━━━━━━━━

🚀 ${next.name}
🏢 ${next.provider}
📅 ${next.dateLocal}
${next.status}

📝 ${next.details}

━━━━━━━━━━━━━━━━
🔗 即時資訊請查看：
• spacex.com/launches
• nextspaceflight.com

💡 輸入「發射列表」查看更多`;
        return await lineReply(replyToken, msg);
    }
    
    if (text === '發射列表' || text === 'spacex列表') {
        const launches = getUpcomingLaunches();
        let msg = '🛸 太空發射計畫\n━━━━━━━━━━━━━━━━\n\n';
        
        for (const launch of launches) {
            msg += `${launch.status} ${launch.name}\n`;
            msg += `   🏢 ${launch.provider}\n`;
            msg += `   📅 ${launch.dateLocal}\n\n`;
        }
        
        msg += '━━━━━━━━━━━━━━━━\n';
        msg += '🔗 即時發射資訊：\n';
        msg += '• nextspaceflight.com';
        return await lineReply(replyToken, msg);
    }
    
    // 🌙 月相
    if (text === '月亮' || text === '月相' || text === 'moon') {
        const moon = getMoonPhase();
        const msg = `🌙 今日月相
━━━━━━━━━━━━━━━━

${moon.icon} ${moon.phase}
🔤 ${moon.english}

📊 亮面：${moon.illumination}%
📆 月齡：${moon.age} 天

🌕 下次滿月：${moon.nextFullMoon}
🌑 下次新月：${moon.nextNewMoon}

🔭 觀星條件：${moon.isGoodForViewing ? '極佳 ⭐' : '一般'}

━━━━━━━━━━━━━━━━
💡 新月前後最適合觀星`;
        return await lineReply(replyToken, msg);
    }
    
    // ☄️ 流星雨
    if (text === '流星' || text === '流星雨' || text === 'meteor') {
        const meteors = getMeteorShowers();
        let msg = '☄️ 流星雨預報\n━━━━━━━━━━━━━━━━\n\n';
        
        if (meteors.active) {
            msg += `🔥 現正活躍！\n`;
            msg += `⭐ ${meteors.active.name}\n`;
            msg += `📅 極大期：${meteors.active.peakDate}\n`;
            msg += `💫 每小時流星數：${meteors.active.rate} 顆\n`;
            msg += `☄️ 母體：${meteors.active.parent}\n\n`;
        }
        
        msg += `📅 即將到來：\n\n`;
        for (const shower of meteors.upcoming) {
            msg += `⭐ ${shower.name}\n`;
            msg += `   📅 ${shower.peakDate}（${shower.daysUntil} 天後）\n`;
            msg += `   💫 每小時 ${shower.rate} 顆\n\n`;
        }
        
        msg += `━━━━━━━━━━━━━━━━\n`;
        msg += `${meteors.moonIcon} 當前月相：${meteors.moonPhase}\n`;
        msg += `🔭 觀測條件：${meteors.viewingCondition}`;
        
        return await lineReply(replyToken, msg);
    }
    
    // 訂閱選單
    if (text === '訂閱' || text === '設定' || text === '通知') {
        return await lineReply(replyToken, formatSubscriptionMenu());
    }
    
    // 主選單
    if (text === '選單' || text === '主選單' || text === 'menu' || text === '幫助' || text === 'help') {
        return await lineReply(replyToken, formatMainMenu());
    }

    // ═══════════════════════════════════════════════════════════════
    // 需要太空氣象數據的指令
    // ═══════════════════════════════════════════════════════════════
    const spaceWeather = await getSpaceWeather();

    // 指令判斷
    if (text === '太空氣象' || text === '報告' || text === '完整報告') {
        await lineReply(replyToken, formatSpaceWeatherMessage(spaceWeather));
    }
    else if (text === '極光' || text === 'aurora' || text === 'kp') {
        await lineReply(replyToken, formatAuroraMessage(spaceWeather));
    }
    else if (text === '太陽風' || text === 'solar' || text === '太陽') {
        await lineReply(replyToken, formatSolarWindMessage(spaceWeather));
    }
    else if (text === 'iss' || text === '太空站' || text === '國際太空站') {
        await lineReply(replyToken, formatISSMessage(spaceWeather));
    }
    else if (text === 'cme' || text === '日冕拋射') {
        const cmeList = spaceWeather.cme || [];
        if (cmeList.length === 0) {
            await lineReply(replyToken, '🌋 過去 7 天沒有偵測到 CME 事件');
        } else {
            let msg = '🌋 近期 CME 日冕物質拋射事件\n━━━━━━━━━━━━━━━━\n\n';
            for (const cme of cmeList.slice(-5)) {
                const time = new Date(cme.time).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
                msg += `📅 ${time}\n`;
                msg += `💨 速度：${Math.round(cme.speed)} km/s\n`;
                msg += `📐 類型：${cme.type}\n\n`;
            }
            await lineReply(replyToken, msg);
        }
    }
    else if (text.startsWith('天氣')) {
        const city = text.replace('天氣', '').trim() || '台北';
        const cities = {
            '台北': { lat: 25.033, lon: 121.565 },
            '台中': { lat: 24.147, lon: 120.673 },
            '高雄': { lat: 22.627, lon: 120.301 },
            '台南': { lat: 22.999, lon: 120.227 },
            '東京': { lat: 35.676, lon: 139.650 },
            '首爾': { lat: 37.566, lon: 126.978 },
            '紐約': { lat: 40.712, lon: -74.006 },
            '倫敦': { lat: 51.507, lon: -0.127 }
        };
        const coords = cities[city] || cities['台北'];
        const weather = await fetchWeather(coords.lat, coords.lon);
        
        if (weather) {
            const msg = `🌤️ ${city} 天氣
━━━━━━━━━━━━━━━━

${weather.icon} ${weather.description}

🌡️ 溫度：${Math.round(weather.temp)}°C
🤒 體感：${Math.round(weather.feelsLike)}°C
💧 濕度：${weather.humidity}%
💨 風速：${(weather.windSpeed / 3.6).toFixed(1)} m/s
👁️ 能見度：${(weather.visibility / 1000).toFixed(0)} km
☁️ 雲量：${weather.cloudCover}%

🌅 日出：${weather.sunrise}
🌇 日落：${weather.sunset}`;
            await lineReply(replyToken, msg);
        } else {
            await lineReply(replyToken, '❌ 無法取得天氣資料');
        }
    }
    else if (text.startsWith('訂閱每日報告')) {
        const time = text.includes('08:00') ? '08:00' : text.includes('20:00') ? '20:00' : '08:00';
        const result = await addSubscription(userId, 'daily', '每日太空氣象報告', time);
        await lineReply(replyToken, `✅ ${result.message}\n\n每天 ${time} 將收到太空氣象報告`);
    }
    else if (text === '訂閱極光警報' || text === '訂閱極光') {
        const result = await addSubscription(userId, 'aurora', '極光警報 (Kp≥5)');
        await lineReply(replyToken, `✅ ${result.message}\n\n當 Kp 指數 ≥ 5 時，您將收到極光警報`);
    }
    else if (text === '訂閱閃焰警報' || text === '訂閱閃焰') {
        const result = await addSubscription(userId, 'flare', 'X級太陽閃焰警報');
        await lineReply(replyToken, `✅ ${result.message}\n\n當發生 X 級太陽閃焰時，您將收到警報`);
    }
    else if (text === '訂閱cme警報' || text === '訂閱cme') {
        const result = await addSubscription(userId, 'cme', 'CME 地球方向警報');
        await lineReply(replyToken, `✅ ${result.message}\n\n當偵測到朝向地球的 CME 時，您將收到警報`);
    }
    else if (text === '我的訂閱' || text === '查看訂閱') {
        const subs = await getSubscriptions(userId);
        if (subs.length === 0) {
            await lineReply(replyToken, '📋 您目前沒有任何訂閱\n\n輸入「訂閱」查看可用選項');
        } else {
            let msg = '📋 您的訂閱清單\n━━━━━━━━━━━━━━━━\n\n';
            for (const sub of subs) {
                msg += `✅ ${sub.name}`;
                if (sub.pushTime) msg += ` (${sub.pushTime})`;
                msg += '\n';
            }
            msg += '\n輸入「取消所有訂閱」可停止所有通知';
            await lineReply(replyToken, msg);
        }
    }
    else if (text === '取消所有訂閱' || text === '取消訂閱') {
        await removeSubscription(userId);
        await lineReply(replyToken, '✅ 已取消所有訂閱\n\n如需重新訂閱，請輸入「訂閱」');
    }
    else {
        // 預設回覆主選單
        await lineReply(replyToken, formatMainMenu());
    }
}

async function handleFollow(event) {
    const userId = event.source.userId;
    
    const welcomeMsg = `🛰️ 歡迎加入 ORBITAL COMMAND！

太空氣象指揮中心為您提供：

🌌 即時極光預報
☀️ 太陽活動監測
🚀 ISS 太空站追蹤
⚠️ 太空天氣警報

━━━━━━━━━━━━━━━━

📱 快速開始：
• 輸入「極光」查看極光預報
• 輸入「太陽風」查看太陽活動
• 輸入「訂閱」設定定時通知

祝您觀測愉快！✨`;

    await linePush(userId, welcomeMsg);
}

async function handleUnfollow(event) {
    const userId = event.source.userId;
    await removeSubscription(userId);
    console.log('用戶取消追蹤:', userId.substring(0, 10) + '...');
}

// ═══════════════════════════════════════════════════════════════════════════
// 定時任務
// ═══════════════════════════════════════════════════════════════════════════

// 每日定時推播
async function dailyPush() {
    const now = new Date();
    const currentTime = now.toLocaleTimeString('zh-TW', { 
        timeZone: 'Asia/Taipei', 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false 
    });

    // 只在整點執行
    if (!currentTime.endsWith(':00')) return;

    const hour = currentTime.split(':')[0] + ':00';
    
    // 取得該時間的訂閱者
    const subscribers = await getSubscribersByType('daily');
    const targetUsers = subscribers.filter(s => s.pushTime === hour);

    if (targetUsers.length === 0) return;

    console.log(`📤 執行 ${hour} 定時推播，共 ${targetUsers.length} 位訂閱者`);

    const spaceWeather = await getSpaceWeather(true);
    const message = formatSpaceWeatherMessage(spaceWeather);

    for (const user of targetUsers) {
        await linePush(user.userId, message);
        // 避免太快觸發限制
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

// 警報檢查
async function checkAlerts() {
    const spaceWeather = await getSpaceWeather(true);
    const now = Date.now();
    const ALERT_COOLDOWN = 60 * 60 * 1000; // 1 小時內不重複發送

    // Kp >= 5 極光警報
    if (spaceWeather.kp?.kp >= 5 && (now - lastAlerts.kp) > ALERT_COOLDOWN) {
        const subscribers = await getSubscribersByType('aurora');
        if (subscribers.length > 0) {
            const msg = `🌌 ⚠️ 極光警報！

Kp 指數已達 ${spaceWeather.kp.kp.toFixed(1)}
地磁警報等級：${spaceWeather.kp.gLevel}

${formatAuroraMessage(spaceWeather)}`;

            for (const user of subscribers) {
                await linePush(user.userId, msg);
            }
            lastAlerts.kp = now;
            console.log('🌌 已發送極光警報');
        }
    }

    // X 級閃焰警報
    if (spaceWeather.xray?.flareClass === 'X' && (now - lastAlerts.flare) > ALERT_COOLDOWN) {
        const subscribers = await getSubscribersByType('flare');
        if (subscribers.length > 0) {
            const msg = `🔥 ⚠️ X 級太陽閃焰警報！

偵測到 ${spaceWeather.xray.fullClass} 級太陽閃焰

可能影響：
• 高頻無線電通訊中斷
• GPS 定位精度下降
• 衛星通訊干擾

請密切關注後續發展`;

            for (const user of subscribers) {
                await linePush(user.userId, msg);
            }
            lastAlerts.flare = now;
            console.log('🔥 已發送閃焰警報');
        }
    }
}

// 數據記錄
async function recordData() {
    if (!doc) return;

    try {
        const now = new Date().toISOString();
        const data = await getSpaceWeather(true);

        // 記錄太陽風
        if (data.solarWind) {
            const sheet = doc.sheetsByTitle['太陽風紀錄'];
            await sheet.addRow({
                '時間': now,
                '風速': data.solarWind.speed,
                '密度': data.solarWind.density,
                'Bz': data.magneticField?.bz || 0,
                'Bt': data.magneticField?.bt || 0,
                '溫度': data.solarWind.temperature
            });
        }

        // 記錄 Kp
        if (data.kp) {
            const sheet = doc.sheetsByTitle['Kp指數紀錄'];
            await sheet.addRow({
                '時間': now,
                'Kp': data.kp.kp,
                '等級': data.kp.level,
                'G等級': data.kp.gLevel
            });
        }

        // 記錄 ISS
        if (data.iss) {
            const sheet = doc.sheetsByTitle['ISS位置'];
            await sheet.addRow({
                '時間': now,
                '緯度': data.iss.lat.toFixed(4),
                '經度': data.iss.lon.toFixed(4),
                '高度': data.iss.altitude.toFixed(1),
                '速度': data.iss.velocity.toFixed(0),
                '位置描述': data.iss.location
            });
        }

        // 記錄輻射
        if (data.proton) {
            const sheet = doc.sheetsByTitle['輻射紀錄'];
            await sheet.addRow({
                '時間': now,
                '質子通量': data.proton.flux,
                '電子通量': data.electron?.flux || 0,
                'S等級': data.proton.sLevel
            });
        }

        console.log('📊 數據已記錄:', now);
    } catch (error) {
        console.error('記錄錯誤:', error.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// API 端點
// ═══════════════════════════════════════════════════════════════════════════

// 綜合太空氣象
app.get('/api/space-weather', async (req, res) => {
    const data = await getSpaceWeather(req.query.refresh === 'true');
    res.json(data);
});

// Kp 歷史
app.get('/api/kp-history', async (req, res) => {
    try {
        const response = await fetch(`${NOAA_BASE}/products/noaa-planetary-k-index.json`);
        const data = await response.json();
        
        const history = data
            .filter(row => row[0] !== 'time_tag')
            .slice(-72)
            .map(row => ({
                time: row[0],
                kp: parseFloat(row[1]) || 0
            }));

        res.json({ success: true, data: history });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 太陽風歷史
app.get('/api/solar-wind-history', async (req, res) => {
    try {
        const [plasmaRes, magRes] = await Promise.all([
            fetch(`${NOAA_BASE}/products/solar-wind/plasma-7-day.json`),
            fetch(`${NOAA_BASE}/products/solar-wind/mag-7-day.json`)
        ]);

        const plasma = await plasmaRes.json();
        const mag = await magRes.json();

        const history = [];
        for (let i = Math.max(0, plasma.length - 200); i < plasma.length; i++) {
            const row = plasma[i];
            const magRow = mag[i] || [];
            history.push({
                time: row[0],
                speed: parseFloat(row[2]) || 0,
                density: parseFloat(row[1]) || 0,
                bz: parseFloat(magRow[3]) || 0,
                bt: parseFloat(magRow[6]) || 0
            });
        }

        res.json({ success: true, data: history });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ISS
app.get('/api/iss', async (req, res) => {
    const iss = await fetchISS();
    if (iss) {
        res.json({ success: true, ...iss });
    } else {
        res.json({ success: false, message: 'ISS 數據取得失敗' });
    }
});

// 天氣
app.get('/api/weather', async (req, res) => {
    const { lat = 22.627, lon = 120.301 } = req.query;
    const weather = await fetchWeather(parseFloat(lat), parseFloat(lon));
    
    if (weather) {
        res.json({ success: true, ...weather });
    } else {
        res.json({ success: false, message: '天氣數據取得失敗' });
    }
});

// CME 事件
app.get('/api/cme', async (req, res) => {
    const cme = await fetchCME();
    res.json({ success: true, data: cme });
});

// 太陽閃焰
app.get('/api/flares', async (req, res) => {
    const flares = await fetchNASAFlares();
    res.json({ success: true, data: flares });
});

// 火箭發射
app.get('/api/spacex', (req, res) => {
    const launches = getUpcomingLaunches();
    res.json({ success: true, data: launches });
});

// 下一次發射
app.get('/api/spacex/next', (req, res) => {
    const next = getNextMajorLaunch();
    res.json({ success: true, data: next });
});

// 月相
app.get('/api/moon', (req, res) => {
    const moon = getMoonPhase();
    res.json({ success: true, data: moon });
});

// 流星雨
app.get('/api/meteors', (req, res) => {
    const meteors = getMeteorShowers();
    res.json({ success: true, data: meteors });
});

// 歷史紀錄查詢
app.get('/api/history/:type', async (req, res) => {
    if (!doc) {
        return res.json({ success: false, message: 'Google Sheets 未連線' });
    }

    try {
        const { type } = req.params;
        const { days = 1, limit = 100 } = req.query;
        
        const sheetNames = {
            'solar-wind': '太陽風紀錄',
            'kp': 'Kp指數紀錄',
            'flare': '太陽閃焰',
            'cme': 'CME事件',
            'iss': 'ISS位置',
            'radiation': '輻射紀錄'
        };

        const sheetName = sheetNames[type];
        if (!sheetName) {
            return res.json({ success: false, message: '無效的類型' });
        }

        const sheet = doc.sheetsByTitle[sheetName];
        if (!sheet) {
            return res.json({ success: false, message: '找不到工作表' });
        }

        const rows = await sheet.getRows();
        const cutoff = new Date(Date.now() - parseInt(days) * 24 * 60 * 60 * 1000);

        const data = rows
            .filter(row => new Date(row.get('時間')) > cutoff)
            .slice(-parseInt(limit))
            .map(row => row.toObject());

        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 訂閱統計
app.get('/api/stats/subscriptions', async (req, res) => {
    if (!doc) {
        return res.json({ success: false, message: 'Google Sheets 未連線' });
    }

    try {
        const sheet = doc.sheetsByTitle['LINE訂閱'];
        const rows = await sheet.getRows();

        const stats = {
            total: rows.filter(r => r.get('狀態') === '啟用').length,
            daily: rows.filter(r => r.get('類型') === 'daily' && r.get('狀態') === '啟用').length,
            aurora: rows.filter(r => r.get('類型') === 'aurora' && r.get('狀態') === '啟用').length,
            flare: rows.filter(r => r.get('類型') === 'flare' && r.get('狀態') === '啟用').length,
            cme: rows.filter(r => r.get('類型') === 'cme' && r.get('狀態') === '啟用').length
        };

        res.json({ success: true, data: stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 手動推播（管理用）- 需要 ADMIN_API_KEY
app.post('/api/admin/broadcast', async (req, res) => {
    // 驗證管理密鑰
    const apiKey = req.headers['x-admin-key'];
    if (!ADMIN_API_KEY || apiKey !== ADMIN_API_KEY) {
        return res.status(403).json({ success: false, message: '無權限' });
    }

    const { type, message } = req.body;
    
    if (!type || !message) {
        return res.json({ success: false, message: '缺少必要參數' });
    }

    const subscribers = await getSubscribersByType(type);
    let sent = 0;

    for (const user of subscribers) {
        const success = await linePush(user.userId, message);
        if (success) sent++;
    }

    res.json({ success: true, sent, total: subscribers.length });
});

// 測試推播 - 需要 ADMIN_API_KEY
app.post('/api/admin/test-push', async (req, res) => {
    // 驗證管理密鑰
    const apiKey = req.headers['x-admin-key'];
    if (!ADMIN_API_KEY || apiKey !== ADMIN_API_KEY) {
        return res.status(403).json({ success: false, message: '無權限' });
    }

    const { userId, type = 'space-weather' } = req.body;
    
    if (!userId) {
        return res.json({ success: false, message: '缺少用戶 ID' });
    }

    const spaceWeather = await getSpaceWeather(true);
    let message;

    switch (type) {
        case 'aurora':
            message = formatAuroraMessage(spaceWeather);
            break;
        case 'solar':
            message = formatSolarWindMessage(spaceWeather);
            break;
        case 'iss':
            message = formatISSMessage(spaceWeather);
            break;
        default:
            message = formatSpaceWeatherMessage(spaceWeather);
    }

    const success = await linePush(userId, message);
    res.json({ success, message: success ? '已發送' : '發送失敗' });
});

// 健康檢查
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        googleSheets: doc ? 'connected' : 'not configured',
        lineBot: LINE_CHANNEL_ACCESS_TOKEN ? 'configured' : 'not configured',
        cache: cachedSpaceWeather ? 'valid' : 'empty'
    });
});

// LINE BOT 診斷頁面
app.get('/line-status', (req, res) => {
    const tokenSet = !!LINE_CHANNEL_ACCESS_TOKEN;
    const secretSet = !!LINE_CHANNEL_SECRET;
    const sheetsSet = !!doc;
    
    const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🤖 LINE BOT 診斷</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0a0a1a; color: #fff; padding: 40px 20px; min-height: 100vh; }
        .container { max-width: 600px; margin: 0 auto; }
        h1 { text-align: center; margin-bottom: 30px; color: #00f5ff; }
        .card { background: rgba(255,255,255,0.05); border: 1px solid rgba(0,245,255,0.3); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
        .row { display: flex; justify-content: space-between; align-items: center; padding: 15px 0; border-bottom: 1px solid rgba(255,255,255,0.1); }
        .row:last-child { border-bottom: none; }
        .label { color: rgba(255,255,255,0.7); }
        .ok { color: #00ff88; font-weight: bold; }
        .error { color: #ff3b3b; font-weight: bold; }
        .warn { color: #ff9500; font-weight: bold; }
        .help { background: linear-gradient(135deg, rgba(255,149,0,0.1), transparent); border-left: 4px solid #ff9500; padding: 20px; border-radius: 0 8px 8px 0; margin-top: 20px; }
        .help.success { border-color: #00ff88; background: linear-gradient(135deg, rgba(0,255,136,0.1), transparent); }
        .help h3 { margin-bottom: 10px; }
        .help ol { padding-left: 20px; color: rgba(255,255,255,0.8); }
        .help li { margin: 10px 0; }
        code { background: rgba(0,245,255,0.1); padding: 2px 8px; border-radius: 4px; font-family: monospace; color: #00f5ff; }
        .url-box { background: rgba(0,0,0,0.3); padding: 15px; border-radius: 8px; word-break: break-all; font-family: monospace; color: #00f5ff; margin-top: 10px; }
        .btn { display: block; width: 100%; padding: 15px; background: linear-gradient(135deg, #00f5ff, #0080ff); border: none; border-radius: 8px; color: #000; font-size: 16px; font-weight: bold; cursor: pointer; margin-top: 20px; }
        .result { margin-top: 15px; padding: 15px; border-radius: 8px; display: none; }
        a { color: #00f5ff; }
    </style>
</head>
<body>
    <div class="container">
        <h1>🤖 LINE BOT 診斷</h1>
        
        <div class="card">
            <div class="row">
                <span class="label">📡 伺服器狀態</span>
                <span class="ok">✅ 運行中</span>
            </div>
            <div class="row">
                <span class="label">🔑 LINE Channel Token</span>
                <span class="${tokenSet ? 'ok">✅ 已設定' : 'error">❌ 未設定'}</span>
            </div>
            <div class="row">
                <span class="label">🔐 LINE Channel Secret</span>
                <span class="${secretSet ? 'ok">✅ 已設定' : 'warn">⚠️ 未設定'}</span>
            </div>
            <div class="row">
                <span class="label">📊 Google Sheets</span>
                <span class="${sheetsSet ? 'ok">✅ 已連線' : 'warn">⚠️ 未設定'}</span>
            </div>
        </div>
        
        <div class="card">
            <h3 style="margin-bottom: 15px; color: #00f5ff;">📌 Webhook URL</h3>
            <p style="color: rgba(255,255,255,0.7); margin-bottom: 10px;">請將以下網址填入 LINE Developers Console：</p>
            <div class="url-box" id="webhookUrl">載入中...</div>
        </div>
        
        <button class="btn" onclick="testWebhook()">🧪 測試 Webhook 連線</button>
        <div class="result" id="testResult"></div>

        ${!tokenSet ? `
        <div class="help">
            <h3 style="color: #ff9500;">⚠️ LINE BOT 尚未設定</h3>
            <p style="margin-bottom: 15px;">請依照以下步驟設定：</p>
            <ol>
                <li>前往 <a href="https://developers.line.biz/console/" target="_blank">LINE Developers Console</a></li>
                <li>建立 Messaging API Channel</li>
                <li>在 Messaging API 頁面，取得 <strong>Channel Access Token</strong>（點 Issue）</li>
                <li>在 Basic settings 頁面，取得 <strong>Channel Secret</strong></li>
                <li>在 Render Dashboard → 您的服務 → Environment<br>
                    新增環境變數：<br>
                    <code>LINE_CHANNEL_ACCESS_TOKEN</code> = 您的 Token<br>
                    <code>LINE_CHANNEL_SECRET</code> = 您的 Secret
                </li>
                <li>儲存後會自動重新部署</li>
                <li>部署完成後，回到 LINE Developers Console<br>
                    Messaging API → Webhook URL 填入上方網址<br>
                    開啟「Use webhook」</li>
            </ol>
        </div>
        ` : `
        <div class="help success">
            <h3 style="color: #00ff88;">✅ LINE BOT 已設定</h3>
            <p style="margin-bottom: 15px;">如果仍無法收到回應，請確認：</p>
            <ol>
                <li>Webhook URL 已正確填入 LINE Developers Console</li>
                <li>「Use webhook」已開啟（綠色）</li>
                <li>點擊 Verify 按鈕測試連線</li>
                <li>加入 BOT 好友後，發送「訂閱」測試</li>
            </ol>
        </div>
        `}
    </div>
    
    <script>
        document.getElementById('webhookUrl').textContent = window.location.origin + '/webhook';
        
        async function testWebhook() {
            const r = document.getElementById('testResult');
            r.style.display = 'block';
            r.style.background = 'rgba(255,255,255,0.05)';
            r.innerHTML = '⏳ 測試中...';
            
            try {
                const res = await fetch('/webhook', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ events: [] })
                });
                
                if (res.ok) {
                    r.style.background = 'rgba(0,255,136,0.1)';
                    r.innerHTML = '✅ Webhook 端點正常！';
                } else {
                    r.style.background = 'rgba(255,59,59,0.1)';
                    r.innerHTML = '❌ 錯誤：' + res.status;
                }
            } catch (e) {
                r.style.background = 'rgba(255,59,59,0.1)';
                r.innerHTML = '❌ 連線失敗：' + e.message;
            }
        }
    </script>
</body>
</html>`;
    res.send(html);
});

// 首頁
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ═══════════════════════════════════════════════════════════════════════════
// Rich Menu 指令處理（Flex Message）
// ═══════════════════════════════════════════════════════════════════════════

async function handleRichMenuCommand(event, text) {
    const replyToken = event.replyToken;
    const userId = event.source.userId;
    const cmd = text.trim();
    const cmdLower = cmd.toLowerCase();
    
    // ═══════════════════════════════════════════════════════════════════
    // 1️⃣ 極光
    // ═══════════════════════════════════════════════════════════════════
    if (cmd === '極光' || cmd === '極光預報' || cmdLower === 'aurora') {
        let kp = 3;
        try {
            const data = await Promise.race([
                getSpaceWeather(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
            ]);
            kp = data?.kpIndex || 3;
        } catch (e) {
            console.log('極光 API 超時，使用預設值');
        }
        
        const getProb = (base, kp) => Math.min(98, base + kp * 6);
        
        let level, levelColor;
        if (kp >= 7) { level = '🔴 極強'; levelColor = '#ff3b3b'; }
        else if (kp >= 5) { level = '🟠 強烈'; levelColor = '#ff9500'; }
        else if (kp >= 4) { level = '🟡 活躍'; levelColor = '#ffd700'; }
        else { level = '🟢 平靜'; levelColor = '#00ff88'; }
        
        const flex = {
            type: 'flex',
            altText: `🌌 極光預報 Kp=${kp}`,
            contents: {
                type: 'bubble',
                styles: { header: { backgroundColor: '#1a2744' }, body: { backgroundColor: '#0d1b2a' }, footer: { backgroundColor: '#0d1b2a' } },
                header: {
                    type: 'box', layout: 'vertical', paddingAll: '15px',
                    contents: [
                        { type: 'text', text: '🌌 極光預報', size: 'xl', weight: 'bold', color: '#00ff88' },
                        { type: 'text', text: 'Aurora Forecast', size: 'xs', color: '#888888' }
                    ]
                },
                body: {
                    type: 'box', layout: 'vertical', spacing: 'lg', paddingAll: '20px',
                    contents: [
                        {
                            type: 'box', layout: 'horizontal', alignItems: 'center',
                            contents: [
                                { type: 'text', text: 'Kp 地磁指數', color: '#aaaaaa', flex: 1 },
                                { type: 'text', text: String(kp), color: levelColor, weight: 'bold', size: '3xl', align: 'end' }
                            ]
                        },
                        {
                            type: 'box', layout: 'horizontal',
                            contents: [
                                { type: 'text', text: '活動等級', color: '#aaaaaa', flex: 1 },
                                { type: 'text', text: level, color: '#ffffff', align: 'end', weight: 'bold' }
                            ]
                        },
                        { type: 'separator', color: '#333333', margin: 'lg' },
                        { type: 'text', text: '🌍 各地可見機率', color: '#00f5ff', size: 'md', margin: 'lg' },
                        {
                            type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md',
                            contents: [
                                { type: 'box', layout: 'horizontal', contents: [
                                    { type: 'text', text: '🇮🇸 冰島', color: '#cccccc', size: 'sm', flex: 1 },
                                    { type: 'text', text: getProb(60, kp) + '%', color: '#00ff88', size: 'sm', align: 'end', weight: 'bold' }
                                ]},
                                { type: 'box', layout: 'horizontal', contents: [
                                    { type: 'text', text: '🇳🇴 挪威', color: '#cccccc', size: 'sm', flex: 1 },
                                    { type: 'text', text: getProb(55, kp) + '%', color: '#00ff88', size: 'sm', align: 'end', weight: 'bold' }
                                ]},
                                { type: 'box', layout: 'horizontal', contents: [
                                    { type: 'text', text: '🇫🇮 芬蘭', color: '#cccccc', size: 'sm', flex: 1 },
                                    { type: 'text', text: getProb(50, kp) + '%', color: '#00ff88', size: 'sm', align: 'end', weight: 'bold' }
                                ]},
                                { type: 'box', layout: 'horizontal', contents: [
                                    { type: 'text', text: '🇯🇵 北海道', color: '#cccccc', size: 'sm', flex: 1 },
                                    { type: 'text', text: Math.max(5, kp * 4) + '%', color: '#ffaa00', size: 'sm', align: 'end', weight: 'bold' }
                                ]}
                            ]
                        },
                        { type: 'separator', color: '#333333', margin: 'lg' },
                        { type: 'text', text: kp >= 5 ? '✨ 現在是觀測極光的好時機！' : '💡 Kp ≥ 5 時極光較為活躍', color: '#666666', size: 'xs', margin: 'md', wrap: true }
                    ]
                },
                footer: {
                    type: 'box', layout: 'vertical', paddingAll: '15px',
                    contents: [
                        { type: 'button', action: { type: 'uri', label: '🔗 NOAA 極光地圖', uri: 'https://www.swpc.noaa.gov/products/aurora-30-minute-forecast' }, style: 'primary', color: '#00ff88', height: 'sm' }
                    ]
                }
            }
        };
        await lineReply(replyToken, flex);
        return true;
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // 2️⃣ 太陽風
    // ═══════════════════════════════════════════════════════════════════
    if (cmd === '太陽風' || cmdLower === 'solar' || cmdLower === 'solar wind') {
        let sw = {};
        try {
            const data = await Promise.race([
                getSpaceWeather(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
            ]);
            sw = data?.solarWind || {};
        } catch (e) {
            console.log('太陽風 API 超時，使用預設值');
        }
        const speed = sw.speed || 425;
        const density = sw.density || 4.2;
        const bz = sw.bz || -2.1;
        const bt = sw.bt || 5.5;
        
        let speedLevel, speedColor;
        if (speed >= 700) { speedLevel = '極高'; speedColor = '#ff3b3b'; }
        else if (speed >= 500) { speedLevel = '偏高'; speedColor = '#ff9500'; }
        else { speedLevel = '正常'; speedColor = '#00ff88'; }
        
        const flex = {
            type: 'flex',
            altText: `☀️ 太陽風 ${speed} km/s`,
            contents: {
                type: 'bubble',
                styles: { header: { backgroundColor: '#1a2744' }, body: { backgroundColor: '#0d1b2a' } },
                header: {
                    type: 'box', layout: 'vertical', paddingAll: '15px',
                    contents: [
                        { type: 'text', text: '☀️ 太陽風數據', size: 'xl', weight: 'bold', color: '#ff9500' },
                        { type: 'text', text: 'Solar Wind', size: 'xs', color: '#888888' }
                    ]
                },
                body: {
                    type: 'box', layout: 'vertical', spacing: 'lg', paddingAll: '20px',
                    contents: [
                        {
                            type: 'box', layout: 'horizontal', alignItems: 'center',
                            contents: [
                                { type: 'box', layout: 'vertical', flex: 1, contents: [
                                    { type: 'text', text: '🌬️ 風速', color: '#aaaaaa', size: 'sm' },
                                    { type: 'text', text: speed + ' km/s', color: '#00f5ff', weight: 'bold', size: 'xl' }
                                ]},
                                { type: 'box', layout: 'vertical', flex: 1, contents: [
                                    { type: 'text', text: '📊 密度', color: '#aaaaaa', size: 'sm' },
                                    { type: 'text', text: density + ' p/cm³', color: '#00ff88', weight: 'bold', size: 'xl' }
                                ]}
                            ]
                        },
                        { type: 'separator', color: '#333333' },
                        {
                            type: 'box', layout: 'horizontal',
                            contents: [
                                { type: 'box', layout: 'vertical', flex: 1, contents: [
                                    { type: 'text', text: '🧲 磁場 Bz', color: '#aaaaaa', size: 'sm' },
                                    { type: 'text', text: bz + ' nT', color: bz < 0 ? '#ff6b6b' : '#00ff88', weight: 'bold', size: 'lg' }
                                ]},
                                { type: 'box', layout: 'vertical', flex: 1, contents: [
                                    { type: 'text', text: '🔋 磁場 Bt', color: '#aaaaaa', size: 'sm' },
                                    { type: 'text', text: bt + ' nT', color: '#ffaa00', weight: 'bold', size: 'lg' }
                                ]}
                            ]
                        },
                        { type: 'separator', color: '#333333' },
                        {
                            type: 'box', layout: 'horizontal',
                            contents: [
                                { type: 'text', text: '狀態評估', color: '#aaaaaa', flex: 1 },
                                { type: 'text', text: speedLevel, color: speedColor, weight: 'bold', align: 'end' }
                            ]
                        },
                        { type: 'text', text: '💡 Bz 為負值時有利於極光生成', color: '#666666', size: 'xs', margin: 'md', wrap: true }
                    ]
                }
            }
        };
        await lineReply(replyToken, flex);
        return true;
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // 3️⃣ ISS 國際太空站
    // ═══════════════════════════════════════════════════════════════════
    if (cmdLower === 'iss' || cmd.includes('太空站') || cmd.includes('國際太空站')) {
        let lat = 25.0 + Math.random() * 20 - 10;  // 模擬軌道
        let lon = 121.0 + Math.random() * 100 - 50;
        let location = '地球上空';
        let isLive = false;
        
        try {
            // 3 秒超時，失敗就用模擬值
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            
            const res = await fetch('http://api.open-notify.org/iss-now.json', {
                signal: controller.signal
            });
            clearTimeout(timeout);
            
            const data = await res.json();
            lat = parseFloat(data.iss_position.latitude);
            lon = parseFloat(data.iss_position.longitude);
            isLive = true;
            
            // 位置判斷
            if (lat > 60) location = '北極圈附近';
            else if (lat < -60) location = '南極圈附近';
            else if (lon >= 100 && lon <= 150 && lat >= 20 && lat <= 50) location = '亞洲東部上空';
            else if (lon >= -130 && lon <= -60 && lat >= 25 && lat <= 50) location = '北美洲上空';
            else if (lon >= -10 && lon <= 40 && lat >= 35 && lat <= 70) location = '歐洲上空';
            else if (Math.abs(lat) <= 30 && ((lon >= -180 && lon <= -100) || (lon >= 150))) location = '太平洋上空';
            else if (Math.abs(lat) <= 30 && lon >= -80 && lon <= 0) location = '大西洋上空';
            else if (lon >= 60 && lon <= 100 && lat >= 5 && lat <= 40) location = '印度洋上空';
            else location = '地球上空';
        } catch (e) {
            console.error('ISS API 錯誤:', e);
        }
        
        const flex = {
            type: 'flex',
            altText: `🛸 ISS 位置 ${lat.toFixed(2)}°, ${lon.toFixed(2)}°`,
            contents: {
                type: 'bubble',
                styles: { header: { backgroundColor: '#1a2744' }, body: { backgroundColor: '#0d1b2a' }, footer: { backgroundColor: '#0d1b2a' } },
                header: {
                    type: 'box', layout: 'vertical', paddingAll: '15px',
                    contents: [
                        { type: 'text', text: '🛸 國際太空站 ISS', size: 'xl', weight: 'bold', color: '#00f5ff' },
                        { type: 'text', text: 'International Space Station', size: 'xs', color: '#888888' }
                    ]
                },
                body: {
                    type: 'box', layout: 'vertical', spacing: 'lg', paddingAll: '20px',
                    contents: [
                        {
                            type: 'box', layout: 'horizontal',
                            contents: [
                                { type: 'box', layout: 'vertical', flex: 1, contents: [
                                    { type: 'text', text: '📍 緯度', color: '#aaaaaa', size: 'sm' },
                                    { type: 'text', text: lat.toFixed(4) + '°', color: '#00f5ff', weight: 'bold', size: 'lg' }
                                ]},
                                { type: 'box', layout: 'vertical', flex: 1, contents: [
                                    { type: 'text', text: '📍 經度', color: '#aaaaaa', size: 'sm' },
                                    { type: 'text', text: lon.toFixed(4) + '°', color: '#00f5ff', weight: 'bold', size: 'lg' }
                                ]}
                            ]
                        },
                        { type: 'separator', color: '#333333' },
                        {
                            type: 'box', layout: 'horizontal',
                            contents: [
                                { type: 'box', layout: 'vertical', flex: 1, contents: [
                                    { type: 'text', text: '🛫 高度', color: '#aaaaaa', size: 'sm' },
                                    { type: 'text', text: '408 km', color: '#00ff88', weight: 'bold', size: 'lg' }
                                ]},
                                { type: 'box', layout: 'vertical', flex: 1, contents: [
                                    { type: 'text', text: '🚀 速度', color: '#aaaaaa', size: 'sm' },
                                    { type: 'text', text: '27,600 km/h', color: '#ffaa00', weight: 'bold', size: 'lg' }
                                ]}
                            ]
                        },
                        { type: 'separator', color: '#333333' },
                        {
                            type: 'box', layout: 'vertical', backgroundColor: '#1a3050', cornerRadius: 'md', paddingAll: '12px', margin: 'md',
                            contents: [
                                { type: 'text', text: '📍 目前位置', color: '#00f5ff', size: 'sm' },
                                { type: 'text', text: location, color: '#ffffff', size: 'md', weight: 'bold', margin: 'sm' }
                            ]
                        },
                        { type: 'text', text: '🌍 ISS 每 90 分鐘繞地球一圈', color: '#666666', size: 'xs', margin: 'md' }
                    ]
                },
                footer: {
                    type: 'box', layout: 'vertical', paddingAll: '15px',
                    contents: [
                        { type: 'button', action: { type: 'uri', label: '🗺️ ISS 即時追蹤', uri: 'https://isstracker.pl/en' }, style: 'primary', color: '#00f5ff', height: 'sm' }
                    ]
                }
            }
        };
        await lineReply(replyToken, flex);
        return true;
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // 4️⃣ CME 日冕拋射
    // ═══════════════════════════════════════════════════════════════════
    if (cmdLower === 'cme' || cmd === '日冕拋射' || cmd === '日冕') {
        let events = [];
        
        try {
            const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
            const apiKey = process.env.NASA_API_KEY || 'DEMO_KEY';
            
            // 4 秒超時
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);
            
            const res = await fetch(`https://api.nasa.gov/DONKI/CME?startDate=${startDate}&api_key=${apiKey}`, {
                signal: controller.signal
            });
            clearTimeout(timeout);
            
            if (!res.ok) throw new Error('API error');
            const data = await res.json();
            events = (data || []).slice(0, 3).map(cme => ({
                time: cme.startTime?.substring(0, 16).replace('T', ' ') || '未知',
                speed: cme.cmeAnalyses?.[0]?.speed || '?',
                type: cme.cmeAnalyses?.[0]?.type || 'N/A'
            }));
        } catch (e) {
            console.error('CME API 錯誤:', e);
        }
        
        const eventContents = events.length === 0 
            ? [{ type: 'text', text: '✅ 近 7 天無重大 CME 事件', color: '#00ff88', margin: 'lg' }]
            : events.map((cme, i) => ({
                type: 'box', layout: 'vertical', margin: 'lg', backgroundColor: '#1a3050', cornerRadius: 'md', paddingAll: '12px',
                contents: [
                    { type: 'text', text: `#${i + 1} ${cme.time}`, color: '#00f5ff', size: 'sm', weight: 'bold' },
                    { type: 'box', layout: 'horizontal', margin: 'sm', contents: [
                        { type: 'text', text: '速度:', color: '#aaaaaa', size: 'sm', flex: 1 },
                        { type: 'text', text: cme.speed + ' km/s', color: '#ff6b6b', size: 'sm', weight: 'bold', align: 'end' }
                    ]},
                    { type: 'box', layout: 'horizontal', contents: [
                        { type: 'text', text: '類型:', color: '#aaaaaa', size: 'sm', flex: 1 },
                        { type: 'text', text: cme.type, color: '#ffffff', size: 'sm', align: 'end' }
                    ]}
                ]
            }));
        
        const flex = {
            type: 'flex',
            altText: `🌋 CME 事件 (${events.length} 筆)`,
            contents: {
                type: 'bubble',
                styles: { header: { backgroundColor: '#1a2744' }, body: { backgroundColor: '#0d1b2a' }, footer: { backgroundColor: '#0d1b2a' } },
                header: {
                    type: 'box', layout: 'vertical', paddingAll: '15px',
                    contents: [
                        { type: 'text', text: '🌋 CME 日冕拋射', size: 'xl', weight: 'bold', color: '#ff6b6b' },
                        { type: 'text', text: 'Coronal Mass Ejection', size: 'xs', color: '#888888' }
                    ]
                },
                body: {
                    type: 'box', layout: 'vertical', paddingAll: '20px',
                    contents: [
                        { type: 'text', text: `📅 近 7 天事件 (${events.length} 筆)`, color: '#ffffff', size: 'md' },
                        ...eventContents,
                        { type: 'text', text: '💡 CME 可能導致地磁風暴與極光', color: '#666666', size: 'xs', margin: 'lg', wrap: true }
                    ]
                },
                footer: {
                    type: 'box', layout: 'vertical', paddingAll: '15px',
                    contents: [
                        { type: 'button', action: { type: 'uri', label: '🔗 NASA DONKI', uri: 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/' }, style: 'primary', color: '#ff6b6b', height: 'sm' }
                    ]
                }
            }
        };
        await lineReply(replyToken, flex);
        return true;
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // 5️⃣ 天氣查詢
    // ═══════════════════════════════════════════════════════════════════
    if (cmd === '天氣' || cmdLower === 'weather') {
        const flex = {
            type: 'flex',
            altText: '🌤️ 天氣查詢',
            contents: {
                type: 'bubble',
                styles: { header: { backgroundColor: '#1a2744' }, body: { backgroundColor: '#0d1b2a' }, footer: { backgroundColor: '#0d1b2a' } },
                header: {
                    type: 'box', layout: 'vertical', paddingAll: '15px',
                    contents: [
                        { type: 'text', text: '🌤️ 天氣查詢', size: 'xl', weight: 'bold', color: '#ffd700' },
                        { type: 'text', text: 'Weather Query', size: 'xs', color: '#888888' }
                    ]
                },
                body: {
                    type: 'box', layout: 'vertical', spacing: 'lg', paddingAll: '20px',
                    contents: [
                        { type: 'text', text: '輸入城市名稱即可查詢天氣', color: '#ffffff', wrap: true },
                        { type: 'separator', color: '#333333', margin: 'lg' },
                        { type: 'text', text: '📝 輸入格式範例：', color: '#00f5ff', margin: 'lg' },
                        {
                            type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md', backgroundColor: '#1a3050', cornerRadius: 'md', paddingAll: '12px',
                            contents: [
                                { type: 'text', text: '天氣 台北', color: '#ffffff', size: 'md' },
                                { type: 'text', text: '天氣 東京', color: '#ffffff', size: 'md' },
                                { type: 'text', text: '天氣 New York', color: '#ffffff', size: 'md' }
                            ]
                        },
                        { type: 'text', text: '🌏 支援全球城市中英文查詢', color: '#666666', size: 'xs', margin: 'lg' }
                    ]
                },
                footer: {
                    type: 'box', layout: 'horizontal', paddingAll: '15px', spacing: 'md',
                    contents: [
                        { type: 'button', action: { type: 'message', label: '🇹🇼 台北', text: '天氣 台北' }, style: 'secondary', height: 'sm', flex: 1 },
                        { type: 'button', action: { type: 'message', label: '🇯🇵 東京', text: '天氣 東京' }, style: 'secondary', height: 'sm', flex: 1 },
                        { type: 'button', action: { type: 'message', label: '🇰🇷 首爾', text: '天氣 首爾' }, style: 'secondary', height: 'sm', flex: 1 }
                    ]
                }
            }
        };
        await lineReply(replyToken, flex);
        return true;
    }
    
    // ═══════════════════════════════════════════════════════════════════
    // 6️⃣ 我的訂閱
    // ═══════════════════════════════════════════════════════════════════
    if (cmd === '我的訂閱' || cmd === '訂閱' || cmdLower === 'subscription') {
        let subs = { daily: null, aurora: false, flare: false, cme: false };
        
        if (doc) {
            try {
                const sheet = doc.sheetsByTitle['LINE訂閱'];
                const rows = await sheet.getRows();
                const userRows = rows.filter(r => r.get('用戶ID') === userId && r.get('狀態') === '啟用');
                
                userRows.forEach(row => {
                    const type = row.get('類型');
                    if (type === 'daily') subs.daily = row.get('推播時間') || '08:00';
                    else if (type === 'aurora') subs.aurora = true;
                    else if (type === 'flare') subs.flare = true;
                    else if (type === 'cme') subs.cme = true;
                });
            } catch (e) {
                console.error('查詢訂閱錯誤:', e);
            }
        }
        
        const flex = {
            type: 'flex',
            altText: '🔔 我的訂閱',
            contents: {
                type: 'bubble',
                styles: { header: { backgroundColor: '#1a2744' }, body: { backgroundColor: '#0d1b2a' }, footer: { backgroundColor: '#0d1b2a' } },
                header: {
                    type: 'box', layout: 'vertical', paddingAll: '15px',
                    contents: [
                        { type: 'text', text: '🔔 我的訂閱', size: 'xl', weight: 'bold', color: '#a855f7' },
                        { type: 'text', text: 'My Subscription', size: 'xs', color: '#888888' }
                    ]
                },
                body: {
                    type: 'box', layout: 'vertical', spacing: 'lg', paddingAll: '20px',
                    contents: [
                        { type: 'text', text: '📋 目前訂閱狀態', color: '#ffffff', size: 'md', weight: 'bold' },
                        {
                            type: 'box', layout: 'vertical', spacing: 'md', margin: 'lg', backgroundColor: '#1a3050', cornerRadius: 'md', paddingAll: '15px',
                            contents: [
                                { type: 'box', layout: 'horizontal', contents: [
                                    { type: 'text', text: '📅 每日推播', color: '#ffffff', flex: 2 },
                                    { type: 'text', text: subs.daily ? `✅ ${subs.daily}` : '❌ 未訂閱', color: subs.daily ? '#00ff88' : '#888888', align: 'end', flex: 1 }
                                ]},
                                { type: 'box', layout: 'horizontal', contents: [
                                    { type: 'text', text: '🌌 極光警報', color: '#ffffff', flex: 2 },
                                    { type: 'text', text: subs.aurora ? '✅ 已訂閱' : '❌ 未訂閱', color: subs.aurora ? '#00ff88' : '#888888', align: 'end', flex: 1 }
                                ]},
                                { type: 'box', layout: 'horizontal', contents: [
                                    { type: 'text', text: '☀️ 太陽閃焰', color: '#ffffff', flex: 2 },
                                    { type: 'text', text: subs.flare ? '✅ 已訂閱' : '❌ 未訂閱', color: subs.flare ? '#00ff88' : '#888888', align: 'end', flex: 1 }
                                ]},
                                { type: 'box', layout: 'horizontal', contents: [
                                    { type: 'text', text: '🌋 CME 警報', color: '#ffffff', flex: 2 },
                                    { type: 'text', text: subs.cme ? '✅ 已訂閱' : '❌ 未訂閱', color: subs.cme ? '#00ff88' : '#888888', align: 'end', flex: 1 }
                                ]}
                            ]
                        },
                        { type: 'separator', color: '#333333', margin: 'lg' },
                        { type: 'text', text: '📝 訂閱指令：', color: '#00f5ff', margin: 'md' },
                        { type: 'text', text: '• 訂閱 08:00（每日推播）', color: '#aaaaaa', size: 'xs' },
                        { type: 'text', text: '• 訂閱極光 / 取消極光', color: '#aaaaaa', size: 'xs' },
                        { type: 'text', text: '• 訂閱閃焰 / 取消閃焰', color: '#aaaaaa', size: 'xs' },
                        { type: 'text', text: '• 訂閱CME / 取消CME', color: '#aaaaaa', size: 'xs' }
                    ]
                },
                footer: {
                    type: 'box', layout: 'horizontal', paddingAll: '15px', spacing: 'md',
                    contents: [
                        { type: 'button', action: { type: 'message', label: '📅 訂閱08:00', text: '訂閱 08:00' }, style: 'primary', color: '#a855f7', height: 'sm', flex: 1 },
                        { type: 'button', action: { type: 'message', label: '🌌 訂閱極光', text: '訂閱極光' }, style: 'secondary', height: 'sm', flex: 1 }
                    ]
                }
            }
        };
        await lineReply(replyToken, flex);
        return true;
    }
    
    return false; // 不是 Rich Menu 指令
}


// ═══════════════════════════════════════════════════════════════════════════
// 啟動伺服器
// ═══════════════════════════════════════════════════════════════════════════
async function start() {
    console.log('');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('🛰️  ORBITAL COMMAND - 太空氣象指揮中心 v4.0');
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('');

    await initGoogleSheets();
    
    // 定時任務
    setInterval(dailyPush, 60 * 1000);       // 每分鐘檢查定時推播
    setInterval(checkAlerts, 5 * 60 * 1000); // 每 5 分鐘檢查警報
    setInterval(recordData, 5 * 60 * 1000);  // 每 5 分鐘記錄數據

    // 首次執行
    setTimeout(async () => {
        await getSpaceWeather(true);
        if (doc) await recordData();
        console.log('✅ 首次數據已載入');
    }, 5000);

    app.listen(PORT, () => {
        console.log(`🚀 伺服器啟動於 http://localhost:${PORT}`);
        console.log('');
        console.log('📡 API 端點:');
        console.log('   GET  /api/space-weather     綜合太空氣象');
        console.log('   GET  /api/kp-history        Kp 指數歷史');
        console.log('   GET  /api/solar-wind-history 太陽風歷史');
        console.log('   GET  /api/iss               ISS 即時位置');
        console.log('   GET  /api/weather           地面天氣');
        console.log('   GET  /api/cme               CME 事件');
        console.log('   GET  /api/flares            太陽閃焰');
        console.log('   GET  /api/spacex            SpaceX 發射');
        console.log('   GET  /api/moon              月相');
        console.log('   GET  /api/meteors           流星雨');
        console.log('   GET  /api/history/:type     歷史紀錄');
        console.log('   GET  /api/stats/subscriptions 訂閱統計');
        console.log('   POST /webhook               LINE Webhook');
        console.log('');
        console.log('📊 定時任務:');
        console.log('   每 1 分鐘  檢查定時推播');
        console.log('   每 5 分鐘  檢查警報條件');
        console.log('   每 5 分鐘  記錄數據到 Google Sheets');
        console.log('');
        console.log('═══════════════════════════════════════════════════════════════');
    });
}

start();
