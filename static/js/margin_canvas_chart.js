(function () {
    const containerId = "marginChart";
    const symbolLabelId = "marginPairLabel";
    const priceLabelId = "marginLivePrice";

    const COLOR_BG = "#161a1e";
    const COLOR_GRID = "#2b3139";
    const COLOR_UP = "#2ebd85";
    const COLOR_DOWN = "#f6465d";
    const COLOR_TEXT = "#b7bdc6";

    const BINANCE_API_BASE = "/api/binance";
    const COINGECKO_API_BASE = "/api/coingecko";
    const INTERVAL = "1m";
    const LIMIT = 120;
    const POLL_MS = 2000;

    let canvas;
    let ctx;
    let data = [];
    let activeSymbol = "BTC";
    let pollTimer = null;
    let resizeObserver = null;
    let chartReady = false;
    let lastRender = 0;
    let containerEl = null;
    let statusEl = null;

    function init() {
        const container = document.getElementById(containerId);
        if (!container) return;
        containerEl = container;
        if (container.clientWidth === 0 || container.clientHeight === 0) {
            scheduleInit();
            return;
        }

        container.style.background = COLOR_BG;
        canvas = document.createElement("canvas");
        canvas.style.position = "absolute";
        canvas.style.inset = "0";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.zIndex = "2";
        container.appendChild(canvas);
        statusEl = buildStatus(container);
        ctx = canvas.getContext("2d");
        resizeCanvas();
        observeResize(container);

        const snapshot = window.nexusPortfolioSnapshot;
        const initial = String(snapshot?.selectedCoin?.symbol || "BTC");
        setActiveSymbol(initial);

        chartReady = true;
    }

    function scheduleInit() {
        if (containerEl && containerEl.clientWidth > 0 && containerEl.clientHeight > 0) {
            init();
            return;
        }
        document.addEventListener("nexus:view:change", (event) => {
            if (event.detail?.view === "margin") init();
        }, { once: true });
    }

    function observeResize(container) {
        const resize = () => {
            resizeCanvas();
            render();
        };
        if ("ResizeObserver" in window) {
            resizeObserver = new ResizeObserver(resize);
            resizeObserver.observe(container);
        } else {
            window.addEventListener("resize", resize);
        }
    }

    function resizeCanvas() {
        if (!canvas) return;
        const rect = containerEl ? containerEl.getBoundingClientRect() : canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(rect.width * dpr);
        canvas.height = Math.floor(rect.height * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function setActiveSymbol(symbol) {
        const next = String(symbol || "BTC").toUpperCase();
        if (activeSymbol === next) return;
        activeSymbol = next;
        fetchCandles();
        restartPolling();
    }

    async function fetchCandles() {
        try {
            const provider = window.nexusDataProvider || "binance";
            setStatus(provider === "binance" ? "Loading Binance candles..." : "Loading market candles...", true);
            if (provider === "binance") {
                const response = await fetch(`${BINANCE_API_BASE}/klines/?symbol=${activeSymbol}USDT&interval=${INTERVAL}&limit=${LIMIT}`);
                if (!response.ok) throw new Error("kline fetch failed");
                const rows = await response.json();
                if (!Array.isArray(rows) || !rows.length) throw new Error("empty kline");
                data = rows.map((r) => ({
                    time: Number(r[0]),
                    open: Number(r[1]),
                    high: Number(r[2]),
                    low: Number(r[3]),
                    close: Number(r[4]),
                })).filter((r) => Number.isFinite(r.open) && Number.isFinite(r.close));
            } else {
                const coinId = resolveCoingeckoId(activeSymbol);
                if (!coinId) throw new Error("coin id missing");
                const response = await fetch(`${COINGECKO_API_BASE}/market-chart/?id=${coinId}&vs_currency=usd&days=1&interval=minutely`);
                if (!response.ok) throw new Error("market chart failed");
                const payload = await response.json();
                const prices = Array.isArray(payload?.prices) ? payload.prices : [];
                if (!prices.length) throw new Error("empty prices");
                data = buildOhlcFromPrices(prices.slice(-LIMIT));
            }
            updateHeaderPrice();
            render();
            setStatus("", false);
        } catch (error) {
            if (!data.length) {
                setStatus("Market candles unavailable.", true);
            }
        }
    }

    function restartPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(fetchCandles, POLL_MS);
    }

    function updateHeaderPrice() {
        const el = document.getElementById(priceLabelId);
        if (!el || !data.length) return;
        const last = data[data.length - 1];
        const up = last.close >= last.open;
        el.textContent = `$${formatMoney(last.close)} (${up ? "+" : ""}${formatPct((last.close - last.open) / last.open)})`;
        el.style.color = up ? COLOR_UP : COLOR_DOWN;
    }

    function render() {
        if (!chartReady || !ctx || !canvas) return;
        const now = Date.now();
        if (now - lastRender < 300) return;
        lastRender = now;

        const width = containerEl ? containerEl.clientWidth : canvas.clientWidth;
        const height = containerEl ? containerEl.clientHeight : canvas.clientHeight;
        if (!width || !height) return;

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = COLOR_BG;
        ctx.fillRect(0, 0, width, height);

        if (!data.length) return;

        const highs = data.map((d) => d.high);
        const lows = data.map((d) => d.low);
        let minPrice = Math.min(...lows);
        let maxPrice = Math.max(...highs);
        let range = maxPrice - minPrice || 1;
        maxPrice += range * 0.05;
        minPrice -= range * 0.05;
        range = maxPrice - minPrice || 1;

        drawGrid(width, height);

        const spacing = width / data.length;
        const candleWidth = Math.max(2, spacing * 0.6);

        data.forEach((kline, index) => {
            const isUp = kline.close >= kline.open;
            const color = isUp ? COLOR_UP : COLOR_DOWN;
            const x = (index * spacing) + (spacing / 2);

            const openY = priceToY(kline.open, minPrice, range, height);
            const closeY = priceToY(kline.close, minPrice, range, height);
            const highY = priceToY(kline.high, minPrice, range, height);
            const lowY = priceToY(kline.low, minPrice, range, height);

            ctx.strokeStyle = color;
            ctx.fillStyle = color;
            ctx.lineWidth = 1.5;

            ctx.beginPath();
            ctx.moveTo(x, highY);
            ctx.lineTo(x, lowY);
            ctx.stroke();

            const bodyY = Math.min(openY, closeY);
            let bodyHeight = Math.abs(openY - closeY);
            if (bodyHeight < 1) bodyHeight = 1;
            ctx.fillRect(x - (candleWidth / 2), bodyY, candleWidth, bodyHeight);
        });
    }

    function drawGrid(width, height) {
        ctx.strokeStyle = COLOR_GRID;
        ctx.lineWidth = 1;
        for (let i = 1; i < 5; i += 1) {
            const y = height * (i / 5);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }
    }

    function priceToY(price, minPrice, range, height) {
        return height - ((price - minPrice) / range) * height;
    }

    function formatMoney(value) {
        return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function formatPct(value) {
        const pct = Number(value || 0) * 100;
        return `${pct.toFixed(2)}%`;
    }

    function resolveCoingeckoId(symbol) {
        const list = Array.isArray(window.nexusCoinUniverse) ? window.nexusCoinUniverse : [];
        const found = list.find((c) => String(c.symbol || "").toUpperCase() === String(symbol || "").toUpperCase());
        return found?.id || "";
    }

    function buildOhlcFromPrices(prices) {
        const out = [];
        prices.forEach((p) => {
            const ts = Number(p[0]);
            const price = Number(p[1]);
            if (!Number.isFinite(price)) return;
            out.push({
                time: ts,
                open: price,
                high: price,
                low: price,
                close: price,
            });
        });
        return out;
    }

    function buildStatus(container) {
        const el = document.createElement("div");
        el.className = "chart-status";
        el.textContent = "Loading Binance candles...";
        container.appendChild(el);
        return el;
    }

    function setStatus(text, visible) {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.style.display = visible ? "block" : "none";
    }

    document.addEventListener("DOMContentLoaded", init);
    document.addEventListener("nexus:portfolio:update", (event) => {
        const symbol = String(event.detail?.selectedCoin?.symbol || "").toUpperCase();
        if (symbol && symbol !== activeSymbol) setActiveSymbol(symbol);
    });
})();
