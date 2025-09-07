const CACHE_NAME = 'solana-monitor-v1';
const CHECK_INTERVAL = 60000; // 1 minute
const SOLANA_API_URL = 'https://api.dexscreener.com/latest/dex/search?q=SOL&rankBy=createdAt&order=desc&limit=50';

let monitoringInterval = null;
let processedTokens = new Set();
let foundCount = 0;

// Install event
self.addEventListener('install', event => {
    self.skipWaiting();
    console.log('Service Worker installed');
});

// Activate event
self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
    console.log('Service Worker activated');
});

// Message event (from main page)
self.addEventListener('message', event => {
    const data = event.data;
    
    switch (data.type) {
        case 'START_MONITORING':
            startMonitoring(data.config);
            break;
            
        case 'STOP_MONITORING':
            stopMonitoring();
            break;
    }
});

async function startMonitoring(config) {
    console.log('Starting background monitoring');
    stopMonitoring();
    
    // Store config
    self.monitoringConfig = config;
    
    // Run immediately
    await runSolanaCheck();
    
    // Set up interval
    monitoringInterval = setInterval(runSolanaCheck, CHECK_INTERVAL);
    
    // Notify all clients
    notifyClients({
        type: 'STATUS_UPDATE',
        tokensFound: foundCount
    });
}

function stopMonitoring() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }
    console.log('Monitoring stopped');
}

async function runSolanaCheck() {
    if (!self.monitoringConfig) return;
    
    try {
        const response = await fetch(SOLANA_API_URL);
        const data = await response.json();
        
        const solanaPairs = (data.pairs || [])
            .filter(pair => pair.chainId === 'solana')
            .sort((a, b) => new Date(b.pairCreatedAt || 0) - new Date(a.pairCreatedAt || 0))
            .slice(0, 20);
        
        for (const pair of solanaPairs) {
            const tokenAddress = pair.baseToken?.address;
            if (!tokenAddress || processedTokens.has(tokenAddress)) continue;
            
            if (quickSafetyCheck(pair)) {
                processedTokens.add(tokenAddress);
                foundCount++;
                
                // Send Telegram alert
                await sendTelegramAlert(pair, self.monitoringConfig);
                
                // Notify clients
                notifyClients({
                    type: 'NEW_TOKEN',
                    symbol: pair.baseToken.symbol,
                    address: tokenAddress
                });
                
                notifyClients({
                    type: 'STATUS_UPDATE',
                    tokensFound: foundCount
                });
            }
        }
        
    } catch (error) {
        console.error('Background check failed:', error);
    }
}

function quickSafetyCheck(pair) {
    const liquidity = pair.liquidity?.usd || 0;
    const volume = pair.volume?.h24 || 0;
    const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : null;
    const now = new Date();
    const ageMinutes = createdAt ? (now - createdAt) / (1000 * 60) : 999;
    
    if (liquidity < 25000) return false;
    if (volume === 0) return false;
    if (liquidity / volume > 8) return false;
    if (ageMinutes > 30) return false;
    
    return true;
}

async function sendTelegramAlert(pair, config) {
    const createdAt = pair.pairCreatedAt ? new Date(pair.pairCreatedAt) : new Date();
    const ageMinutes = Math.floor((new Date() - createdAt) / (1000 * 60));
    const ageText = ageMinutes < 1 ? 'Just now' : `${ageMinutes}m ago`;
    
    const message = `
🚀 <b>NEW SOLANA TOKEN</b> 🚀

<b>Token:</b> ${pair.baseToken.symbol} (${pair.baseToken.name})
<b>Price:</b> $${parseFloat(pair.priceUsd).toFixed(8)}
<b>Liquidity:</b> $${(pair.liquidity?.usd || 0).toLocaleString()}
<b>Volume:</b> $${(pair.volume?.h24 || 0).toLocaleString()}
<b>Age:</b> ${ageText}

<b>Contract Address:</b>
<code>${pair.baseToken.address}</code>

<b>Links:</b>
🔗 <a href="https://dexscreener.com/solana/${pair.baseToken.address}">DexScreener Chart</a>
📊 <a href="${pair.url || `https://dexscreener.com/solana/${pair.baseToken.address}`}">Trade Now</a>

✅ <i>Passed safety checks</i>
    `.trim();
    
    try {
        const response = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: config.chatId,
                text: message,
                parse_mode: 'HTML'
            })
        });
        
        return response.ok;
    } catch (error) {
        console.error('Telegram alert failed:', error);
        return false;
    }
}

function notifyClients(message) {
    self.clients.matchAll().then(clients => {
        clients.forEach(client => {
            client.postMessage(message);
        });
    });
}

// Background sync event (for periodic checks)
self.addEventListener('periodicsync', event => {
    if (event.tag === 'solana-check') {
        event.waitUntil(runSolanaCheck());
    }
});

// Push notification event (if you want browser notifications)
self.addEventListener('push', event => {
    const data = event.data.json();
    const options = {
        body: data.body,
        icon: '/icon-192.png',
        badge: '/icon-72.png',
        vibrate: [200, 100, 200],
        tag: 'solana-alert'
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});