(function () {
    const containerId = "marginChart";
    const BINANCE_API_BASE = "https://api.binance.com/api/v3";
    const candles = [];
    const maxCandles = 200;
    let chart;
    let candleSeries;
    let volumeSeries;
    let ma7Series;
    let ma25Series;
    let ma99Series;
    let lastCandleTime = 0;
    let lastCandle = null;
    let tooltip;
    let activeSymbol = null;
    let pendingPrice = null;
    let libLoading = false;
    let klineSocket = null;
    let currentInterval = "5m"; // Default from UI
    let statusEl = null;
    let chartReady = false;
    let lastLiveUpdate = 0;
    let tickerTimer = null;
    let orderBookTimer = null;

    /** Convert UTC timestamp from Binance to a local timestamp for the chart. */
    function timeToLocal(originalTimeMs) {
        const d = new Date(originalTimeMs);
        return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()) / 1000;
    }

    /** Normalize interval to the format Binance APIs expect (lowercase). */
    function normalizeInterval(interval) {
        return (interval || "5m").toLowerCase();
    }
    
    function formatMoney(value) {
        return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 2 });
    }

    function init() {
        const container = document.getElementById(containerId);
        if (!container) return;
        if (!window.LightweightCharts) {
            loadLibrary(init);
            return;
        }
        if (container.clientWidth === 0 || container.clientHeight === 0) {
            scheduleInit();
            return;
        }
        chart = window.LightweightCharts.createChart(container, {
            layout: { background: { color: "transparent" }, textColor: "#6b7785", attributionLogo: false },
            grid: { vertLines: { color: "rgba(255,255,255,0.018)" }, horzLines: { color: "rgba(255,255,255,0.018)" } },
            timeScale: { borderColor: "rgba(255,255,255,0.04)", timeVisible: true, secondsVisible: false },
            rightPriceScale: { borderColor: "rgba(255,255,255,0.04)" },
            crosshair: { mode: 0, vertLine: { color: "rgba(240, 185, 11, 0.25)", width: 1, style: 2, labelBackgroundColor: "#1a1e26" }, horzLine: { color: "rgba(240, 185, 11, 0.25)", width: 1, style: 2, labelBackgroundColor: "#1a1e26" } },
        });
        if (!chart || typeof chart.addSeries !== "function") {
            chart = null;
            setStatus("Chart library failed to load.", true);
            return;
        }
        chartReady = true;

        candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
            upColor: "#0ecb81",
            downColor: "#f6465d",
            borderVisible: false,
            wickUpColor: "rgba(14, 203, 129, 0.6)",
            wickDownColor: "rgba(246, 70, 93, 0.6)",
        });

        ma7Series = chart.addSeries(LightweightCharts.LineSeries, { color: "rgba(240, 185, 11, 0.6)", lineWidth: 1, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
        ma25Series = chart.addSeries(LightweightCharts.LineSeries, { color: "rgba(240, 98, 146, 0.5)", lineWidth: 1, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
        ma99Series = chart.addSeries(LightweightCharts.LineSeries, { color: "rgba(90, 169, 255, 0.45)", lineWidth: 1, crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });

        tooltip = buildTooltip(container);
        statusEl = buildStatus(container);
        chart.subscribeCrosshairMove((param) => renderTooltip(param, container));

        const resize = () => {
            if (!chart) return;
            chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
        };
        if ("ResizeObserver" in window) {
            const observer = new ResizeObserver(resize);
            observer.observe(container);
        } else {
            window.addEventListener("resize", resize);
        }
        resize();

        initIntervals();
        initTradeButtons();

        const snapshot = window.nexusPortfolioSnapshot;
        const initial = Number(snapshot?.spot?.markPrice || 0);
        if (Number.isFinite(initial) && initial) pendingPrice = initial;
        const initialSymbol = String(snapshot?.selectedCoin?.symbol || "BTC");
        setActiveSymbol(initialSymbol);
    }

    function initIntervals() {
        const btns = document.querySelectorAll(".margin-interval-btn");
        btns.forEach((btn) => {
            btn.addEventListener("click", () => {
                const rawInterval = btn.getAttribute("data-interval");
                if (!rawInterval) return;
                const newInterval = normalizeInterval(rawInterval);
                if (newInterval === currentInterval) return;
                
                btns.forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                currentInterval = newInterval;
                if (activeSymbol) {
                    setStatus("Loading Binance candles...", true);
                    fetchHistoricalCandles(activeSymbol, currentInterval);
                    connectKlineStream(activeSymbol, currentInterval);
                }
            });
        });
    }

    function scheduleInit() {
        if (chart) return;
        const retry = () => {
            requestAnimationFrame(() => {
                const container = document.getElementById(containerId);
                if (!container) return;
                init();
                if (chart) {
                    chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
                }
            });
        };
        document.addEventListener("nexus:view:change", (event) => {
            if (event.detail?.view === "margin") retry();
        });
    }

    function loadLibrary(callback) {
        if (window.LightweightCharts || libLoading) return;
        libLoading = true;
        const primary = document.createElement("script");
        primary.src = "https://unpkg.com/lightweight-charts/dist/lightweight-charts.standalone.production.js";
        primary.async = true;
        primary.onload = () => {
            if (window.LightweightCharts && typeof window.LightweightCharts.createChart === "function") {
                libLoading = false;
                if (typeof callback === "function") callback();
                return;
            }
            loadFallback(callback);
        };
        primary.onerror = () => loadFallback(callback);
        document.head.appendChild(primary);
    }

    function loadFallback(callback) {
        const fallback = document.createElement("script");
        fallback.src = "https://cdn.jsdelivr.net/npm/lightweight-charts@4.1.2/dist/lightweight-charts.standalone.production.js";
        fallback.async = true;
        fallback.onload = () => {
            libLoading = false;
            if (typeof callback === "function") callback();
        };
        fallback.onerror = () => { libLoading = false; };
        document.head.appendChild(fallback);
    }

    function buildTooltip(container) {
        const el = document.createElement("div");
        el.style.position = "absolute";
        el.style.left = "12px";
        el.style.top = "12px";
        el.style.padding = "6px 8px";
        el.style.background = "rgba(14,16,22,0.85)";
        el.style.border = "1px solid rgba(255,255,255,0.06)";
        el.style.borderRadius = "8px";
        el.style.fontSize = "11px";
        el.style.color = "#fff";
        el.style.pointerEvents = "none";
        el.style.display = "none";
        el.style.backdropFilter = "blur(10px)";
        container.appendChild(el);
        return el;
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

    function renderTooltip(param, container) {
        if (!tooltip || !param || !param.time || !param.seriesData) {
            if (tooltip) tooltip.style.display = "none";
            return;
        }
        const candle = param.seriesData.get(candleSeries);
        if (!candle) {
            tooltip.style.display = "none";
            return;
        }
        tooltip.style.display = "block";
        tooltip.innerHTML = `O:${candle.open.toFixed(2)} H:${candle.high.toFixed(2)} L:${candle.low.toFixed(2)} C:${candle.close.toFixed(2)}`;
        const x = Math.min(Math.max(param.point.x + 12, 12), container.clientWidth - tooltip.clientWidth - 12);
        const y = Math.min(Math.max(param.point.y + 12, 12), container.clientHeight - tooltip.clientHeight - 12);
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
    }

    function pushPrice(price) {
        if (!Number.isFinite(price) || !price) return;
        if (!lastCandle) return;
        lastCandle.close = price;
        lastCandle.high = Math.max(lastCandle.high, price);
        lastCandle.low = Math.min(lastCandle.low, price);
        candleSeries.update(lastCandle);
        
        candleSeries.applyOptions({
            upColor: "#0ecb81",
            downColor: "#f6465d",
            wickUpColor: "rgba(14, 203, 129, 0.6)",
            wickDownColor: "rgba(246, 70, 93, 0.6)",
        });
    }

    function updateVolume() {
        if (!volumeSeries) return;
        const vols = candles.map((c, i) => ({
            time: c.time,
            value: 40 + (i % 15) * 3,
            color: c.close >= c.open ? "rgba(14, 203, 129, 0.08)" : "rgba(246, 70, 93, 0.08)",
        }));
        volumeSeries.setData(vols);
    }

    function updateMAs() {
        ma7Series.setData(calcMA(7));
        ma25Series.setData(calcMA(25));
        ma99Series.setData(calcMA(99));
        updateLabel("marginMA7", 7);
        updateLabel("marginMA25", 25);
        updateLabel("marginMA99", 99);
    }

    function calcMA(period) {
        if (candles.length < period) return [];
        const out = [];
        for (let i = period - 1; i < candles.length; i += 1) {
            const slice = candles.slice(i - period + 1, i + 1);
            const avg = slice.reduce((sum, c) => sum + c.close, 0) / period;
            out.push({ time: candles[i].time, value: Number(avg.toFixed(2)) });
        }
        return out;
    }

    function updateLabel(id, period) {
        const el = document.getElementById(id);
        if (!el) return;
        if (candles.length < period) {
            el.textContent = `MA(${period}): 0.00`;
            return;
        }
        const slice = candles.slice(-period);
        const avg = slice.reduce((sum, c) => sum + c.close, 0) / period;
        el.textContent = `MA(${period}): ${avg.toFixed(2)}`;
    }

    async function fetchJson(url) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("fetch failed");
        return resp.json();
    }

    async function loadTicker(symbol) {
        if (!symbol) return;
        try {
            const data = await fetchJson(`${BINANCE_API_BASE}/ticker/24hr?symbol=${symbol}USDT`);
            const price = Number(data.lastPrice);
            if (Number.isFinite(price)) {
                const elLivePrice = document.getElementById("marginLivePrice");
                if (elLivePrice) {
                    const change = Number(data.priceChangePercent || 0);
                    const sign = change >= 0 ? "+" : "";
                    const color = change >= 0 ? "#0ecb81" : "#f6465d";
                    elLivePrice.innerHTML = `<span style="color:${color};">$${formatMoney(price)} (${sign}${change.toFixed(2)}%)</span>`;
                }
                const elMidPrice = document.getElementById("marginMidPrice");
                if (elMidPrice && elMidPrice.textContent === "64,321.00") {
                    elMidPrice.textContent = formatMoney(price);
                    elMidPrice.style.color = Number(data.priceChangePercent) >= 0 ? "#0ecb81" : "#f6465d";
                }
            }
        } catch (error) {
            console.warn("Margin ticker fetch failed");
        }
    }

    async function loadOrderBook(symbol) {
        if (!symbol) return;
        try {
            const data = await fetchJson(`${BINANCE_API_BASE}/depth?symbol=${symbol}USDT&limit=15`);
            renderOrderRows(document.getElementById("marginOrderAsks"), data.asks || [], "ask");
            renderOrderRows(document.getElementById("marginOrderBids"), data.bids || [], "bid");
        } catch (error) {
            console.warn("Margin order book fetch failed");
        }
    }

    function renderOrderRows(container, rows, type) {
        if (!container) return;
        let sum = 0;
        const mapped = rows.slice(0, 15).map((row) => {
            const price = Number(row[0]);
            const size = Number(row[1]);
            sum += size;
            const depth = Math.min(100, (sum / 15) * 100);
            return `<div class="margin-ob-row ${type}" style="--depth: ${depth}%;">
                <span>${formatMoney(price)}</span>
                <span>${size.toFixed(4)}</span>
                <span>${sum.toFixed(4)}</span>
            </div>`;
        });
        
        if (type === "ask") mapped.reverse();
        
        const newHtml = mapped.join("");
        if (container.innerHTML !== newHtml) {
            container.innerHTML = newHtml;
        }
    }

    function initTradeButtons() {
        const buyBtn = document.getElementById("openLongBtn");
        const sellBtn = document.getElementById("openShortBtn");
        
        if (buyBtn) {
            buyBtn.addEventListener("click", () => {
                alert("Wallet Logic: This connects to your NexusCrypto SQLite/PostgreSQL database via the Django Backend. The user's USDT balance is verified on the server before placing a real Trade order.");
            });
        }
        if (sellBtn) {
            sellBtn.addEventListener("click", () => {
                alert("Wallet Logic: Active balance mapping is handled in core/views.py. A POST request would be sent here to deduct margin leverage and open a position.");
            });
        }
    }

    async function setActiveSymbol(symbol) {
        const next = String(symbol || "BTC").toUpperCase();
        if (activeSymbol === next) return;
        activeSymbol = next;
        
        const label = document.getElementById("marginPairLabel");
        if (label) label.textContent = `${activeSymbol}USDT`;
        
        resetSeries();
        setStatus("Loading Binance candles...", true);
        
        const ok = await fetchHistoricalCandles(next, currentInterval);
        connectKlineStream(next, currentInterval);
        
        loadTicker(next);
        loadOrderBook(next);

        if (tickerTimer) clearInterval(tickerTimer);
        if (orderBookTimer) clearInterval(orderBookTimer);
        tickerTimer = setInterval(() => loadTicker(activeSymbol), 2000);
        orderBookTimer = setInterval(() => loadOrderBook(activeSymbol), 2500);

        if (!ok) setStatus("Binance candles unavailable for this pair.", true);
    }

    function resetSeries() {
        candles.length = 0;
        lastCandle = null;
        lastCandleTime = 0;
        if (candleSeries) {
            candleSeries.setData([]);
            ma7Series.setData([]);
            ma25Series.setData([]);
            ma99Series.setData([]);
        }
    }

    async function fetchHistoricalCandles(symbol, interval, attempt = 0) {
        if (!symbol) return false;
        try {
            const response = await fetch(`${BINANCE_API_BASE}/klines?symbol=${symbol}USDT&interval=${interval}&limit=${maxCandles}`);
            if (!response.ok) throw new Error("kline fetch failed");
            const data = await response.json();
            if (!Array.isArray(data) || !data.length) throw new Error("no kline data");
            candles.length = 0;
            data.forEach((k) => {
                candles.push({
                    time: timeToLocal(Number(k[0])),
                    open: Number(k[1]),
                    high: Number(k[2]),
                    low: Number(k[3]),
                    close: Number(k[4]),
                });
            });
            if (candleSeries) candleSeries.setData(candles);
            lastCandle = candles[candles.length - 1] || null;
            updateMAs();
            if (chart) chart.timeScale().fitContent();
            if (Number.isFinite(pendingPrice) && pendingPrice && lastCandle) {
                pushPrice(pendingPrice);
                pendingPrice = null;
            }
            setStatus("", false);
            return true;
        } catch (error) {
            if (attempt < 2) {
                setStatus("Retrying Binance candles...", true);
                const waitMs = 1200 + (attempt * 900);
                await new Promise((resolve) => setTimeout(resolve, waitMs));
                return fetchHistoricalCandles(symbol, interval, attempt + 1);
            }
            return false;
        }
    }

    function connectKlineStream(symbol, interval) {
        if (klineSocket && klineSocket.readyState <= 1) klineSocket.close();
        try {
            const stream = `${symbol.toLowerCase()}usdt@kline_${interval}`;
            klineSocket = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`);
            klineSocket.onmessage = (event) => {
                const payload = JSON.parse(event.data || "{}");
                const k = payload.k;
                if (!k) return;
                const candle = {
                    time: timeToLocal(Number(k.t)),
                    open: Number(k.o),
                    high: Number(k.h),
                    low: Number(k.l),
                    close: Number(k.c),
                };
                lastCandle = candle;
                if (!candleSeries) return;
                const now = Date.now();
                if (k.x) {
                    candles.push(candle);
                    if (candles.length > maxCandles) candles.shift();
                    candleSeries.setData(candles);
                    updateMAs();
                    setStatus("", false);
                    
                    const elMidPrice = document.getElementById("marginMidPrice");
                    if (elMidPrice) {
                        elMidPrice.textContent = formatMoney(candle.close);
                        elMidPrice.style.color = candle.close >= candle.open ? "#0ecb81" : "#f6465d";
                    }
                } else {
                    if (now - lastLiveUpdate > 1000) {
                        candleSeries.update(candle);
                        lastLiveUpdate = now;
                        if (!candles.length) setStatus("", false);
                    }
                }
                
                candleSeries.applyOptions({
                    upColor: "#0ecb81",
                    downColor: "#f6465d",
                    wickUpColor: "rgba(14, 203, 129, 0.6)",
                    wickDownColor: "rgba(246, 70, 93, 0.6)",
                });
            };
            klineSocket.onclose = () => { klineSocket = null; };
            klineSocket.onerror = () => { setStatus("Binance stream blocked. Check network.", true); };
        } catch (error) {
            klineSocket = null;
            setStatus("Binance stream blocked. Check network.", true);
        }
    }

    document.addEventListener("DOMContentLoaded", init);
    document.addEventListener("nexus:portfolio:update", (event) => {
        const price = Number(event.detail?.spot?.markPrice || 0);
        const symbol = String(event.detail?.selectedCoin?.symbol || "");
        if (!chartReady) pendingPrice = price;
        if (symbol && symbol !== activeSymbol) setActiveSymbol(symbol);
        if (!Number.isFinite(price) || !price) return;
        if (candleSeries) pushPrice(price);
    });
})();
