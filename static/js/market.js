const grid = document.getElementById("marketGrid");
const overlay = document.getElementById("detailOverlay");
const detailContent = document.getElementById("detailContent");
let rangeResizeHandler = null;

const fallbackCoins = buildFallbackCoins(100);

boot();

async function boot() {
    if (!grid || !overlay || !detailContent) {
        console.error("Market page DOM is missing required elements.");
        return;
    }
    let coins = [];
    try {
        coins = await fetchTop100Coins();
    } catch (error) {
        console.warn("Failed to load top 100 coins, using fallback data.", error);
        coins = fallbackCoins;
    }

    renderMarketCards(coins);
}

async function fetchTop100Coins() {
    try {
        const [infoRes, tickerRes] = await Promise.all([
            fetch("/api/binance/exchange-info/"),
            fetch("/api/binance/ticker-24hr/"),
        ]);
        if (!infoRes.ok || !tickerRes.ok) {
            throw new Error(`Binance API failed: ${infoRes.status}/${tickerRes.status}`);
        }

        const info = await infoRes.json();
        const tickers = await tickerRes.json();
        if (!Array.isArray(info?.symbols) || !Array.isArray(tickers)) {
            throw new Error("Binance API returned invalid payload");
        }

        const infoMap = new Map(
            info.symbols
                .filter((s) => s && s.status === "TRADING" && s.quoteAsset === "USDT")
                .map((s) => [String(s.symbol || ""), String(s.baseAsset || "")])
        );

        const coins = tickers
            .filter((t) => infoMap.has(String(t.symbol || "")))
            .map((t) => {
                const symbol = String(t.symbol || "");
                const base = infoMap.get(symbol) || symbol.replace(/USDT$/, "");
                const price = Number(t.lastPrice || 0);
                const change = Number(t.priceChangePercent || 0);
                const quoteVolume = Number(t.quoteVolume || 0);
                const baseVolume = Number(t.volume || 0);
                const high = Number(t.highPrice || 0);
                return {
                    id: symbol,
                    symbol: base.toLowerCase(),
                    name: base,
                    image: "",
                    current_price: price,
                    price_change_percentage_24h: change,
                    market_cap: quoteVolume,
                    total_volume: quoteVolume,
                    circulating_supply: baseVolume,
                    ath: high,
                    sparkline_in_7d: { price: buildSparkline(price, change) },
                };
            })
            .filter((c) => Number.isFinite(c.current_price) && c.current_price > 0);

        coins.sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0));
        return coins.slice(0, 100);
    } catch (error) {
        console.warn("Binance markets failed, falling back to CoinGecko.", error);
        return fetchTop100CoinsFromCoingecko();
    }
}

async function fetchTop100CoinsFromCoingecko() {
    const response = await fetch("/api/coingecko/markets/?vs_currency=usd&per_page=100&page=1&sparkline=true&price_change_percentage=24h");
    if (!response.ok) {
        throw new Error(`CoinGecko API failed: ${response.status}`);
    }
    const rows = await response.json();
    if (!Array.isArray(rows)) {
        throw new Error("CoinGecko API returned invalid payload");
    }
    return rows.map((c) => ({
        id: c.id,
        symbol: String(c.symbol || "").toLowerCase(),
        name: c.name || "",
        image: c.image || "",
        current_price: Number(c.current_price || 0),
        price_change_percentage_24h: Number(c.price_change_percentage_24h || 0),
        market_cap: Number(c.market_cap || 0),
        total_volume: Number(c.total_volume || 0),
        circulating_supply: Number(c.circulating_supply || 0),
        ath: Number(c.ath || 0),
        sparkline_in_7d: c.sparkline_in_7d || { price: buildSparkline(Number(c.current_price || 0), Number(c.price_change_percentage_24h || 0)) },
    })).filter((c) => Number.isFinite(c.current_price) && c.current_price > 0);
}

function buildFallbackCoins(count) {
    const coins = [];
    for (let i = 1; i <= count; i += 1) {
        const basePrice = Math.max(0.01, 70000 / (i + 1));
        const drift = (Math.sin(i * 0.7) * 4.8);
        const price = Number((basePrice + (i % 7) * 0.37).toFixed(2));
        const symbol = `C${i}`;
        const sparkline = Array.from({ length: 60 }, (_, idx) => {
            const wave = Math.sin((idx / 8) + i) * (price * 0.015);
            const noise = Math.cos((idx / 5) + i * 0.3) * (price * 0.01);
            return Math.max(0.01, price + wave + noise);
        });
        coins.push({
            id: `coin_${i}`,
            symbol: symbol.toLowerCase(),
            name: `Coin ${i}`,
            image: "",
            current_price: price,
            price_change_percentage_24h: Number(drift.toFixed(2)),
            market_cap: Math.round(price * 5000000 * (1 + i / 10)),
            total_volume: Math.round(price * 1000000 * (1 + i / 25)),
            circulating_supply: Math.round(10000 + i * 1500),
            ath: Number((price * 1.2).toFixed(2)),
            sparkline_in_7d: { price: sparkline },
        });
    }
    return coins;
}

function renderMarketCards(coins) {
    grid.innerHTML = "";
    coins.forEach((coin) => {
        const card = document.createElement("div");
        card.className = "coin-card";
        const isUp = Number(coin.price_change_percentage_24h || 0) >= 0;
        const price = Number(coin.current_price || 0);
        const change = Number(coin.price_change_percentage_24h || 0);
        const sparklinePoints = (coin.sparkline_in_7d && Array.isArray(coin.sparkline_in_7d.price))
            ? coin.sparkline_in_7d.price
            : [];
        const iconHtml = coin.image
            ? `<img src="${coin.image}" alt="${coin.symbol || ""}" width="24" height="24" style="border-radius:50%;">`
            : `<span style="font-size:12px;font-weight:700;">${String(coin.symbol || "?").slice(0, 3).toUpperCase()}</span>`;

        card.innerHTML = `
            <div class="card-header">
                <div class="symbol-box">
                    <div class="icon-circle">
                        ${iconHtml}
                    </div>
                    <div>
                        <div style="font-weight: 700;">${escapeHtml(coin.name || "")}</div>
                        <div style="color: var(--text-secondary); font-size: 12px;">${String(coin.symbol || "").toUpperCase()}</div>
                    </div>
                </div>
            </div>
            <div class="price-large">$${fmtMoney(price)}</div>
            <div class="stat-line" style="color: ${isUp ? "var(--green)" : "var(--red)"}">
                <i class="fas fa-caret-${isUp ? "up" : "down"}"></i> ${change.toFixed(2)}%
            </div>
            <svg class="sparkline-svg" viewBox="0 0 150 60">
                <path d="${toSparklinePath(sparklinePoints)}" stroke="${isUp ? "var(--green)" : "var(--red)"}"></path>
            </svg>
        `;

        card.onclick = () => showDetail(coin);
        grid.appendChild(card);
    });
}

function showDetail(coin) {
    overlay.style.display = "block";
    setTimeout(() => {
        overlay.style.opacity = "1";
        document.body.style.overflow = "hidden";
    }, 10);

    const change = Number(coin.price_change_percentage_24h || 0);
    const isUp = change >= 0;
    const symbol = String(coin.symbol || "").toUpperCase();
    const price = Number(coin.current_price || 0);
    const sparklinePoints = (coin.sparkline_in_7d && Array.isArray(coin.sparkline_in_7d.price))
        ? coin.sparkline_in_7d.price
        : [];
    const chartSeriesByRange = buildChartSeriesByRange(sparklinePoints);
    const gradientId = `grad-${String(coin.id || "coin").replace(/[^a-zA-Z0-9_-]/g, "_")}`;

    detailContent.innerHTML = `
        <div class="detail-header">
            <div>
                <div class="detail-pair">${escapeHtml(coin.name || "")} / USDT</div>
                <h2 class="detail-price">$${fmtMoney(price)}</h2>
                <div class="stat-line detail-daily-change" style="color: ${isUp ? "var(--green)" : "var(--red)"}">
                    ${change >= 0 ? "+" : ""}${change.toFixed(2)}% today
                </div>
            </div>
            <button class="btn-close" id="closeDetailBtn"><i class="fas fa-times"></i></button>
        </div>

        <div class="chart-range-nav" id="chartRangeNav" aria-label="Chart time ranges">
            <button class="range-item active" data-range="1D">1D</button>
            <div class="range-divider"></div>
            <button class="range-item" data-range="5D">5D</button>
            <div class="range-divider"></div>
            <button class="range-item" data-range="1M">1M</button>
            <div class="range-divider"></div>
            <button class="range-item" data-range="6M">6M</button>
            <div class="range-divider"></div>
            <button class="range-item" data-range="YTD">YTD</button>
            <div class="range-divider"></div>
            <button class="range-item" data-range="1Y">1Y</button>
            <div class="range-divider"></div>
            <button class="range-item" data-range="5Y">5Y</button>
            <div class="range-divider"></div>
            <button class="range-item" data-range="MAX">Max</button>
            <div class="range-indicator" id="rangeIndicator"></div>
        </div>

        <div class="main-chart-box">
            <svg width="100%" height="100%" viewBox="0 0 1000 300" preserveAspectRatio="none">
                <defs>
                    <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" style="stop-color:${isUp ? "var(--green)" : "var(--red)"};stop-opacity:0.2"></stop>
                        <stop offset="100%" style="stop-color:transparent;stop-opacity:0"></stop>
                    </linearGradient>
                </defs>
                <path id="detailAreaPath" d="${toAreaPath(chartSeriesByRange["1D"])}" fill="url(#${gradientId})"></path>
                <path id="detailLinePath" d="${toLinePath(chartSeriesByRange["1D"])}"
                    stroke="${isUp ? "var(--green)" : "var(--red)"}"
                    stroke-width="4" fill="none"
                    style="stroke-dasharray: 2000; stroke-dashoffset: 2000; animation: drawLine 2s forwards ease-out;"></path>
            </svg>
        </div>

        <div class="advanced-stats">
            <div class="stat-card"><label>Quote Volume (24h)</label><div>$${fmtMoney(coin.market_cap || 0)}</div></div>
            <div class="stat-card"><label>Volume (24h)</label><div>$${fmtMoney(coin.total_volume || 0)}</div></div>
            <div class="stat-card"><label>Base Volume (24h)</label><div>${fmtMoney(coin.circulating_supply || 0)} ${symbol}</div></div>
            <div class="stat-card"><label>24h High</label><div>$${fmtMoney(coin.ath || 0)}</div></div>
        </div>

        <div class="detail-actions">
            <button class="action-btn buy">Buy ${symbol}</button>
            <button class="action-btn trade">Trade Options</button>
        </div>
    `;

    const closeButton = document.getElementById("closeDetailBtn");
    if (closeButton) closeButton.addEventListener("click", closeDetail);
    initRangeSelector(chartSeriesByRange);
}

function closeDetail() {
    overlay.style.opacity = "0";
    document.body.style.overflow = "auto";
    if (rangeResizeHandler) {
        window.removeEventListener("resize", rangeResizeHandler);
        rangeResizeHandler = null;
    }
    setTimeout(() => {
        overlay.style.display = "none";
    }, 500);
}

overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDetail();
});

function toSparklinePath(points) {
    const path = normalizePoints(points, 150, 60);
    return path.length ? path : "M0,30 L150,30";
}

function toLinePath(points) {
    const path = normalizePoints(points, 1000, 300);
    return path.length ? path : "M0,150 L1000,150";
}

function toAreaPath(points) {
    const linePath = toLinePath(points);
    return `${linePath} L1000,300 L0,300 Z`;
}

function initRangeSelector(seriesByRange) {
    const nav = document.getElementById("chartRangeNav");
    const indicator = document.getElementById("rangeIndicator");
    const linePath = document.getElementById("detailLinePath");
    const areaPath = document.getElementById("detailAreaPath");
    if (!nav || !indicator || !linePath || !areaPath) return;

    const items = Array.from(nav.querySelectorAll(".range-item"));

    const moveIndicator = (target) => {
        const rect = target.getBoundingClientRect();
        const parentRect = nav.getBoundingClientRect();
        const pad = 12;
        const width = Math.max(12, rect.width - (pad * 2));
        indicator.style.width = `${width}px`;
        indicator.style.left = `${rect.left - parentRect.left + pad}px`;
    };

    const applyRange = (target) => {
        const range = target.dataset.range;
        const points = seriesByRange[range];
        if (!points) return;

        items.forEach((item) => item.classList.remove("active"));
        target.classList.add("active");
        moveIndicator(target);

        linePath.setAttribute("d", toLinePath(points));
        areaPath.setAttribute("d", toAreaPath(points));
    };

    items.forEach((item) => {
        item.addEventListener("click", () => applyRange(item));
    });

    const activeItem = nav.querySelector(".range-item.active");
    if (activeItem) moveIndicator(activeItem);

    if (rangeResizeHandler) {
        window.removeEventListener("resize", rangeResizeHandler);
    }
    rangeResizeHandler = () => {
        const selected = nav.querySelector(".range-item.active");
        if (selected) moveIndicator(selected);
    };
    window.addEventListener("resize", rangeResizeHandler);
}

function buildChartSeriesByRange(basePoints) {
    const safeBase = Array.isArray(basePoints) && basePoints.length > 1
        ? basePoints
        : [100, 101, 99, 102, 103, 101, 104, 105];

    return {
        "1D": smoothSeries(resampleSeries(safeBase, 24), 2),
        "5D": smoothSeries(resampleSeries(safeBase, 60), 3),
        "1M": smoothSeries(resampleSeries(safeBase, 120), 4),
        "6M": smoothSeries(resampleSeries(safeBase, 180), 5),
        "YTD": smoothSeries(resampleSeries(safeBase, 220), 6),
        "1Y": smoothSeries(resampleSeries(safeBase, 260), 7),
        "5Y": smoothSeries(resampleSeries(safeBase, 320), 8),
        "MAX": smoothSeries(resampleSeries(safeBase, 420), 9),
    };
}

function resampleSeries(points, targetLength) {
    if (!Array.isArray(points) || points.length === 0) return [];
    if (points.length === 1) return Array.from({ length: targetLength }, () => points[0]);
    if (targetLength <= 2) return [points[0], points[points.length - 1]];

    const last = points.length - 1;
    const resampled = [];
    for (let i = 0; i < targetLength; i += 1) {
        const position = (i / (targetLength - 1)) * last;
        const left = Math.floor(position);
        const right = Math.min(last, Math.ceil(position));
        const ratio = position - left;
        const value = points[left] + (points[right] - points[left]) * ratio;
        resampled.push(value);
    }
    return resampled;
}

function smoothSeries(points, windowSize) {
    if (!Array.isArray(points) || points.length < 3 || windowSize <= 1) return points;
    const half = Math.floor(windowSize / 2);
    return points.map((_, index) => {
        let total = 0;
        let count = 0;
        for (let i = Math.max(0, index - half); i <= Math.min(points.length - 1, index + half); i += 1) {
            total += points[i];
            count += 1;
        }
        return total / count;
    });
}

function normalizePoints(points, width, height) {
    if (!Array.isArray(points) || points.length < 2) return "";
    const min = Math.min(...points);
    const max = Math.max(...points);
    const range = max - min || 1;

    return points
        .map((price, index) => {
            const x = (index / (points.length - 1)) * width;
            const y = height - (((price - min) / range) * (height - 10) + 5);
            return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
        })
        .join(" ");
}

function buildSparkline(price, changePct) {
    const points = [];
    const safePrice = Number.isFinite(price) && price > 0 ? price : 1;
    const safeChange = Number.isFinite(changePct) ? changePct : 0;
    const start = safePrice / Math.max(0.01, (1 + safeChange / 100));
    const steps = 60;
    for (let i = 0; i < steps; i += 1) {
        const ratio = i / (steps - 1);
        const base = start + (safePrice - start) * ratio;
        const wobble = Math.sin(ratio * Math.PI * 2) * safePrice * 0.003;
        const jitter = (Math.random() - 0.5) * safePrice * 0.002;
        points.push(Math.max(0.01, base + wobble + jitter));
    }
    return points;
}

function fmtMoney(value) {
    return Number(value || 0).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function escapeHtml(text) {
    return String(text || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
