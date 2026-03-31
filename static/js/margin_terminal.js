(function () {
    const containerId = "marginChart";
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
    let currentInterval = "1m";
    let statusEl = null;
    let chartReady = false;
    let lastLiveUpdate = 0;

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
            layout: { background: { color: "#080b10" }, textColor: "#6b7785", attributionLogo: false },
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

        // Volume bars disabled for cleaner chart
        // volumeSeries = chart.addSeries(LightweightCharts.HistogramSeries, {
        //     color: "rgba(14, 203, 129, 0.08)",
        //     priceFormat: { type: "volume" },
        //     priceScaleId: "",
        //     scaleMargins: { top: 0.88, bottom: 0 },
        // });

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

        const snapshot = window.nexusPortfolioSnapshot;
        const initial = Number(snapshot?.spot?.markPrice || 0);
        if (Number.isFinite(initial) && initial) pendingPrice = initial;
        const initialSymbol = String(snapshot?.selectedCoin?.symbol || "BTC");
        setActiveSymbol(initialSymbol);
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
        el.style.background = "rgba(24,26,32,0.85)";
        el.style.border = "1px solid #20252c";
        el.style.borderRadius = "8px";
        el.style.fontSize = "11px";
        el.style.color = "#fff";
        el.style.pointerEvents = "none";
        el.style.display = "none";
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

    async function setActiveSymbol(symbol) {
        const next = String(symbol || "BTC").toUpperCase();
        if (activeSymbol === next) return;
        activeSymbol = next;
        resetSeries();
        setStatus("Loading Binance candles...", true);
        const ok = await fetchHistoricalCandles(next, currentInterval);
        connectKlineStream(next, currentInterval);
        if (!ok) setStatus("Binance candles unavailable for this pair.", true);
    }

    function resetSeries() {
        candles.length = 0;
        lastCandle = null;
        lastCandleTime = 0;
        if (candleSeries) {
            candleSeries.setData([]);
            volumeSeries.setData([]);
            ma7Series.setData([]);
            ma25Series.setData([]);
            ma99Series.setData([]);
        }
    }

    async function fetchHistoricalCandles(symbol, interval, attempt = 0) {
        if (!symbol) return false;
        try {
            const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${maxCandles}`);
            if (!response.ok) throw new Error("kline fetch failed");
            const data = await response.json();
            if (!Array.isArray(data) || !data.length) throw new Error("no kline data");
            candles.length = 0;
            data.forEach((k) => {
                candles.push({
                    time: Math.floor(k[0] / 1000),
                    open: Number(k[1]),
                    high: Number(k[2]),
                    low: Number(k[3]),
                    close: Number(k[4]),
                });
            });
            if (candleSeries) candleSeries.setData(candles);
            lastCandle = candles[candles.length - 1] || null;
            updateVolume();
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
                    time: Math.floor(k.t / 1000),
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
                    updateVolume();
                    updateMAs();
                    setStatus("", false);
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
