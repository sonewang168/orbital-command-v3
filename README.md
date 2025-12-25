# 🛰️ ORBITAL COMMAND v3.0

## 太空氣象指揮中心 - LINE BOT 整合版

![Version](https://img.shields.io/badge/version-3.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green)
![License](https://img.shields.io/badge/license-MIT-yellow)

---

## ✨ 功能總覽

### 🌌 太空氣象監測
| 功能 | 說明 | 資料來源 |
|------|------|----------|
| Kp 地磁指數 | 極光活動預報 | NOAA SWPC |
| 太陽風數據 | 風速、密度、磁場 | NOAA SWPC |
| 太陽閃焰 | X/M/C 級分類 | NOAA GOES |
| CME 追蹤 | 日冕物質拋射 | NASA DONKI |
| 輻射監測 | S0-S5 等級 | NOAA SWPC |
| X射線通量 | 即時監測 | NOAA GOES |

### 🤖 LINE BOT 功能
| 指令 | 說明 |
|------|------|
| `極光` | 極光預報與各地可見機率 |
| `太陽風` | 太陽風即時數據 |
| `ISS` | 國際太空站位置 |
| `CME` | 近期 CME 事件 |
| `天氣 城市` | 地面天氣查詢 |
| `訂閱` | 訂閱設定選單 |
| `我的訂閱` | 查看訂閱清單 |

### 🔔 訂閱與推播
| 類型 | 說明 |
|------|------|
| 每日報告 | 可選 08:00 或 20:00 定時推播 |
| 極光警報 | Kp ≥ 5 時自動通知 |
| 閃焰警報 | X 級太陽閃焰時通知 |
| CME 警報 | 偵測到朝向地球的 CME 時通知 |

### 📊 Google Sheets 記錄
| 工作表 | 記錄內容 |
|--------|----------|
| 太陽風紀錄 | 風速、密度、Bz、Bt、溫度 |
| Kp指數紀錄 | Kp 值、等級、G 等級 |
| 太陽閃焰 | 等級、類型、通量 |
| CME事件 | 速度、類型、方向 |
| ISS位置 | 緯度、經度、高度、速度 |
| 輻射紀錄 | 質子通量、電子通量、S 等級 |
| LINE訂閱 | 用戶訂閱設定 |
| 推播紀錄 | 推播歷史 |

---

## 🚀 快速開始

### 方式一：純前端
```bash
# 直接開啟網頁
open public/index.html
```

### 方式二：完整版（含 LINE BOT）

#### 1. 安裝依賴
```bash
npm install
```

#### 2. 設定環境變數
```bash
cp .env.example .env
# 編輯 .env 填入設定
```

#### 3. 啟動伺服器
```bash
npm start
```

---

## 📦 部署到 Render

### Step 1: 上傳 GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/你的帳號/orbital-command.git
git push -u origin main
```

### Step 2: 設定 Google Sheets
1. [Google Cloud Console](https://console.cloud.google.com/) 建立專案
2. 啟用 Google Sheets API
3. 建立服務帳戶，下載 JSON 金鑰
4. 建立 Google Sheets，分享給服務帳戶

### Step 3: 設定 LINE BOT
1. 前往 [LINE Developers](https://developers.line.biz/console/)
2. 建立 Messaging API Channel
3. 取得 Channel Access Token
4. 取得 Channel Secret

### Step 4: 部署 Render
1. [Render Dashboard](https://dashboard.render.com/) → New Web Service
2. 連接 GitHub 儲存庫
3. 設定環境變數：
   ```
   GOOGLE_SHEET_ID = ...
   GOOGLE_SERVICE_ACCOUNT_EMAIL = ...
   GOOGLE_PRIVATE_KEY = ...
   LINE_CHANNEL_ACCESS_TOKEN = ...
   LINE_CHANNEL_SECRET = ...
   NASA_API_KEY = ... (可選)
   ```
4. Deploy!

### Step 5: 設定 LINE Webhook
1. 部署完成後取得網址：`https://xxx.onrender.com`
2. 回到 LINE Developers Console
3. Messaging API → Webhook URL：`https://xxx.onrender.com/webhook`
4. 開啟 Use webhook

---

## 📡 API 端點

### 太空氣象
| 端點 | 說明 |
|------|------|
| `GET /api/space-weather` | 綜合太空氣象 |
| `GET /api/kp-history` | Kp 歷史（72筆） |
| `GET /api/solar-wind-history` | 太陽風歷史（200筆） |
| `GET /api/cme` | CME 事件 |
| `GET /api/flares` | 太陽閃焰 |

### 追蹤
| 端點 | 說明 |
|------|------|
| `GET /api/iss` | ISS 位置 |
| `GET /api/weather?lat=&lon=` | 天氣 |

### 歷史紀錄
| 端點 | 說明 |
|------|------|
| `GET /api/history/solar-wind?days=1` | 太陽風紀錄 |
| `GET /api/history/kp?days=1` | Kp 紀錄 |
| `GET /api/history/iss?days=1` | ISS 紀錄 |
| `GET /api/history/radiation?days=1` | 輻射紀錄 |

### 管理
| 端點 | 說明 |
|------|------|
| `GET /api/stats/subscriptions` | 訂閱統計 |
| `POST /api/admin/broadcast` | 廣播推播 |
| `POST /api/admin/test-push` | 測試推播 |
| `GET /health` | 健康檢查 |

---

## ⏰ 定時任務

| 間隔 | 任務 |
|------|------|
| 每 1 分鐘 | 檢查定時推播（08:00、20:00） |
| 每 5 分鐘 | 檢查警報條件（Kp≥5、X級閃焰） |
| 每 5 分鐘 | 記錄數據到 Google Sheets |

---

## 🔌 資料來源

| 來源 | 用途 | 免費 |
|------|------|------|
| [NOAA SWPC](https://www.swpc.noaa.gov/) | 太陽風、Kp、X射線、輻射 | ✅ |
| [NASA DONKI](https://api.nasa.gov/) | CME、太陽閃焰 | ✅ |
| [Where The ISS At](https://wheretheiss.at/) | ISS 位置 | ✅ |
| [Open-Meteo](https://open-meteo.com/) | 地面天氣 | ✅ |

---

## 📁 檔案結構

```
orbital-command/
├── server.js           # 後端主程式 (~1800 行)
├── package.json        # 依賴設定
├── render.yaml         # Render 部署設定
├── .env.example        # 環境變數範例
├── .gitignore          # Git 忽略清單
├── README.md           # 本文件
└── public/
    └── index.html      # 前端頁面 (~1800 行)
```

---

## 🔧 LINE BOT 指令一覽

### 查詢類
```
太空氣象 / 報告       → 完整太空氣象報告
極光 / aurora / kp    → 極光預報
太陽風 / solar        → 太陽風數據
ISS / 太空站          → ISS 位置
CME / 日冕拋射        → CME 事件
天氣 台北             → 地面天氣
```

### 訂閱類
```
訂閱                  → 訂閱選單
訂閱每日報告 08:00    → 訂閱早報
訂閱每日報告 20:00    → 訂閱晚報
訂閱極光警報          → Kp≥5 通知
訂閱閃焰警報          → X級閃焰通知
訂閱CME警報           → CME 通知
我的訂閱              → 查看訂閱
取消所有訂閱          → 取消訂閱
```

### 其他
```
選單 / menu / 幫助    → 主選單
```

---

## 📝 更新日誌

### v3.0.0 (2025-12-25)
- ✨ 新增 LINE BOT 整合
- ✨ 新增定時推播功能
- ✨ 新增極光/閃焰/CME 警報
- ✨ 新增訂閱管理系統
- ✨ 新增 Flex Message 選單
- 🔧 優化 API 快取機制
- 📊 新增推播紀錄追蹤

### v2.0.0
- ✨ 新增 Google Sheets 歷史記錄
- ✨ 新增 CME 追蹤
- ✨ 新增輻射監測
- 🎨 全新 UI 設計

### v1.0.0
- 🎉 初始版本

---

## 📄 授權

MIT License

---

## 👨‍🏫 作者

**Sone Wang** - 台灣物理教師

專注於教育科技與 AI 整合應用

---

## 🙏 致謝

- NOAA Space Weather Prediction Center
- NASA Open APIs
- LINE Messaging API
- Three.js Community
