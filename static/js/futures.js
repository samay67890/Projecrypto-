(function () {
    const BINANCE_API_BASE = "/api/binance";
    const COINGECKO_API_BASE = "/api/coingecko";
    const SYMBOL = "BTCUSDT";

    const priceEls = () => document.querySelectorAll(".live-price");
    const axisPriceEl = () => document.getElementById("axis-price");
    const inputPriceEl = () => document.getElementById("input-price");
    const inputSizeEl = () => document.getElementById("input-size");
    const asksContainer = () => document.getElementById("asks-container");
    const bidsContainer = () => document.getElementById("bids-container");
    const slider = () => document.getElementById("size-slider");
    const sliderFill = () => document.getElementById("slider-fill");
    const sliderThumb = () => document.getElementById("slider-thumb");
    const btnBuy = () => document.getElementById("btn-buy");
    const btnSell = () => document.getElementById("btn-sell");
    const statChange = () => document.getElementById("stat-change");
    const statMark = () => document.getElementById("stat-mark");
    const statIndex = () => document.getElementById("stat-index");
    const statFunding = () => document.getElementById("stat-funding");
    const statHigh = () => document.getElementById("stat-high");
    const statLow = () => document.getElementById("stat-low");
    const statVolBtc = () => document.getElementById("stat-vol-btc");
    const statVolUsdt = () => document.getElementById("stat-vol-usdt");
    const fiatEls = () => document.querySelectorAll(".ticker-price .fiat");
    const tpToggle = () => document.getElementById("tp-sl-toggle");
    const tpFields = () => document.getElementById("tp-sl-fields");
    const inputTp = () => document.getElementById("input-tp");
    const inputSl = () => document.getElementById("input-sl");

    let chart = null;
    let candleSeries = null;
    let lastPrice = 0;
    let lastChange = 0;
    let lastCandles = [];
    let tickerTimer = null;
    let currentInterval = "5m";
    let isDrawingHLine = false;
    let drawnLines = [];
    let fundingTimer = null;

    function init() {
        initChart();
        initIntervals();
        initDrawingTools();
        initActions();
        initSlider();
        initTpSlToggle();
        initTabs();
        loadCandles();
        loadTicker();
        loadOrderBook();
        loadRecentTrades();
        loadFundingInfo();
        if (window.nexusTradeApi && typeof window.nexusTradeApi.renderFuturesPositions === "function") {
            window.nexusTradeApi.renderFuturesPositions();
        }
        tickerTimer = setInterval(loadTicker, 1500);
        setInterval(loadOrderBook, 2000);
        setInterval(loadFundingInfo, 30000);
        connectLiveTradeStream();
        window.addEventListener("resize", resizeChart);
        document.addEventListener("nexus:view:change", (event) => {
            if (event?.detail?.view === "futures") {
                requestAnimationFrame(resizeChart);
            }
        });
        const container = document.getElementById("candles-container");
        if (container && "ResizeObserver" in window) {
            new ResizeObserver(() => resizeChart()).observe(container);
        }
    }

    function initChart() {
        const container = document.getElementById("candles-container");
        if (!container || !window.LightweightCharts) return;
        chart = window.LightweightCharts.createChart(container, {
            layout: { background: { color: "#0b0e11" }, textColor: "#b7bdc6", attributionLogo: false },
            grid: { vertLines: { color: "rgba(255,255,255,0.06)" }, horzLines: { color: "rgba(255,255,255,0.06)" } },
            rightPriceScale: { borderColor: "#2b3139" },
            timeScale: { borderColor: "#2b3139", timeVisible: true, secondsVisible: false },
        });
        candleSeries = chart.addSeries(LightweightCharts.CandlestickSeries, {
            upColor: "#0ecb81",
            downColor: "#f6465d",
            borderVisible: false,
            wickUpColor: "#0ecb81",
            wickDownColor: "#f6465d",
        });
        resizeChart();
    }

    function resizeChart() {
        if (!chart) return;
        const container = document.getElementById("candles-container");
        if (!container) return;
        const width = container.clientWidth;
        const height = container.clientHeight;
        if (width > 0 && height > 0) {
            chart.applyOptions({ width, height });
        }
    }

    async function fetchJson(url) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error("fetch failed");
        return resp.json();
    }

    /** Normalize interval to the format Binance APIs expect (lowercase). */
    function normalizeInterval(interval) {
        return (interval || "5m").toLowerCase();
    }

    /** Convert UTC timestamp from Binance to a local timestamp for the chart. */
    function timeToLocal(originalTimeMs) {
        const d = new Date(originalTimeMs);
        return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()) / 1000;
    }

    function initIntervals() {
        const btns = document.querySelectorAll(".futures-shell .chart-toolbar .interval-btn");
        btns.forEach((btn) => {
            btn.addEventListener("click", () => {
                const rawInterval = btn.getAttribute("data-interval");
                if (!rawInterval) return;
                const newInterval = normalizeInterval(rawInterval);
                if (newInterval === currentInterval) return;
                
                btns.forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                currentInterval = newInterval;
                loadCandles();
            });
        });
    }

    function initDrawingTools() {
        const btnHline = document.getElementById("btn-draw-hline");
        const btnClear = document.getElementById("btn-clear-lines");
        
        if (btnHline) {
            btnHline.addEventListener("click", () => {
                isDrawingHLine = !isDrawingHLine;
                btnHline.classList.toggle("active", isDrawingHLine);
            });
        }
        
        if (btnClear) {
            btnClear.addEventListener("click", () => {
                drawnLines.forEach(line => {
                    if (candleSeries) candleSeries.removePriceLine(line);
                });
                drawnLines = [];
                isDrawingHLine = false;
                if (btnHline) btnHline.classList.remove("active");
            });
        }
        
        if (chart) {
            chart.subscribeClick((param) => {
                if (!param.point || !isDrawingHLine || !candleSeries) return;
                const price = candleSeries.coordinateToPrice(param.point.y);
                if (price !== null) {
                    const line = candleSeries.createPriceLine({
                        price: price,
                        color: '#2962FF',
                        lineWidth: 2,
                        lineStyle: LightweightCharts.LineStyle.Solid,
                        axisLabelVisible: true,
                        title: 'Draw',
                    });
                    drawnLines.push(line);
                    isDrawingHLine = false;
                    if (btnHline) btnHline.classList.remove("active");
                }
            });
        }
    }

    async function loadCandles() {
        try {
            const interval = currentInterval;
            const limit = ["1d", "1w"].includes(interval) ? 1000 : 500;
            const rows = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`);
            const candles = Array.isArray(rows)
                ? rows.map((r) => ({
                    time: timeToLocal(Number(r[0])),
                    open: Number(r[1]),
                    high: Number(r[2]),
                    low: Number(r[3]),
                    close: Number(r[4]),
                })).filter((c) => Number.isFinite(c.close))
                : [];
            if (candles.length) {
                lastCandles = candles;
                if (candleSeries) {
                    candleSeries.setData(candles);
                    connectKlineStream();
                }
                const last = candles[candles.length - 1];
                updatePrice(last.close, lastChange);
            }
        } catch (error) {
            console.error("Futures REST API kline fetch failed", error);
        }
    }

    let klineSocket = null;
    function connectKlineStream() {
        if (klineSocket) klineSocket.close();
        const interval = currentInterval;
        const stream = `${SYMBOL.toLowerCase()}@kline_${interval}`;
        klineSocket = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`);
        klineSocket.onmessage = (event) => {
            const payload = JSON.parse(event.data || "{}");
            const k = payload.k;
            if (!k || !candleSeries) return;
            const candle = {
                time: timeToLocal(k.t),
                open: Number(k.o),
                high: Number(k.h),
                low: Number(k.l),
                close: Number(k.c),
            };
            candleSeries.update(candle);
            updatePrice(candle.close, lastChange);
        };
        klineSocket.onerror = (err) => {
            console.error("Kline WebSocket error", err);
        };
    }

    async function loadTicker() {
        try {
            const data = await fetchJson(`${BINANCE_API_BASE}/ticker-24hr/?symbol=${SYMBOL}`);
            if (Number.isFinite(Number(data.lastPrice))) {
                lastChange = Number(data.priceChangePercent || 0);
                updatePrice(Number(data.lastPrice), lastChange);
                updateStats(data);
                return;
            }
        } catch (error) {
            // ignore
        }
        if (lastCandles.length) {
            const last = lastCandles[lastCandles.length - 1];
            updatePrice(last.close, lastChange);
            updateStats({ price: last.close });
        }
    }

    /**
     * Fetch funding rate, mark price, index price from Binance Futures API.
     * This populates the Funding/Countdown, Mark, and Index ticker stats.
     */
    async function loadFundingInfo() {
        try {
            const data = await fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${SYMBOL}`);

            // Mark price
            const markEl = statMark();
            if (markEl && data.markPrice) {
                markEl.textContent = formatMoney(Number(data.markPrice));
            }

            // Index price
            const indexEl = statIndex();
            if (indexEl && data.indexPrice) {
                indexEl.textContent = formatMoney(Number(data.indexPrice));
            }

            // Funding rate + countdown
            const fundingEl = statFunding();
            if (fundingEl) {
                const rate = Number(data.lastFundingRate || 0);
                const ratePercent = (rate * 100).toFixed(4);
                const nextFundingMs = Number(data.nextFundingTime || 0);

                if (nextFundingMs > 0) {
                    startFundingCountdown(fundingEl, ratePercent, nextFundingMs);
                } else {
                    fundingEl.textContent = `${ratePercent}% / --`;
                }
            }
        } catch (error) {
            console.error("Failed to load funding info", error);
        }
    }

    /**
     * Start a live countdown timer for the next funding time.
     */
    function startFundingCountdown(element, ratePercent, nextFundingMs) {
        if (fundingTimer) clearInterval(fundingTimer);

        function tick() {
            const now = Date.now();
            const diff = nextFundingMs - now;

            if (diff <= 0) {
                element.textContent = `${ratePercent}% / 00:00:00`;
                clearInterval(fundingTimer);
                fundingTimer = null;
                // Refresh funding info after countdown expires
                setTimeout(loadFundingInfo, 2000);
                return;
            }

            const hours = Math.floor(diff / 3600000);
            const mins = Math.floor((diff % 3600000) / 60000);
            const secs = Math.floor((diff % 60000) / 1000);
            const hh = String(hours).padStart(2, "0");
            const mm = String(mins).padStart(2, "0");
            const ss = String(secs).padStart(2, "0");
            element.textContent = `${ratePercent}% / ${hh}:${mm}:${ss}`;
        }

        tick();
        fundingTimer = setInterval(tick, 1000);
    }

    async function loadOrderBook() {
        try {
            const data = await fetchJson(`${BINANCE_API_BASE}/depth/?symbol=${SYMBOL}&limit=20`);
            updateOrderBook(data);
        } catch (error) {
            renderSyntheticOrderBook(lastPrice || 64000);
        }
    }

    function updatePrice(price, change = 0) {
        lastPrice = price;
        const formatted = formatMoney(price);
        const isUp = change >= 0;
        
        if (candleSeries) {
            candleSeries.applyOptions({
                upColor: "#0ecb81",
                downColor: "#f6465d",
                wickUpColor: "#0ecb81",
                wickDownColor: "#f6465d",
            });
        }
        
        priceEls().forEach((el) => {
            el.textContent = formatted;
            el.style.color = isUp ? "var(--color-up)" : "var(--color-down)";
        });
        fiatEls().forEach((el) => {
            el.textContent = `$${formatted}`;
        });
        updateAccountPanel();
        updatePositionsTab();
        const axis = axisPriceEl();
        if (axis) {
            axis.textContent = formatted;
            axis.style.background = isUp ? "var(--color-up)" : "var(--color-down)";
        }
        const input = inputPriceEl();
        if (input) input.value = Number(price).toFixed(2);
        fiatEls().forEach((el) => { el.textContent = `$${formatted}`; });
    }

    function updateStats(data) {
        const changeEl = statChange();
        if (changeEl) {
            const change = Number(data.change || data.priceChangePercent || 0);
            changeEl.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
            changeEl.classList.toggle("up", change >= 0);
            changeEl.classList.toggle("down", change < 0);
        }
        // Mark & Index are updated by loadFundingInfo() with real data.
        // Only use ticker data as fallback if funding info hasn't loaded yet.
        const mark = statMark();
        if (mark && mark.textContent === "--") {
            mark.textContent = formatMoney(data.lastPrice || data.price || 0);
        }
        const index = statIndex();
        if (index && index.textContent === "--") {
            index.textContent = formatMoney(data.lastPrice || data.price || 0);
        }
        // Funding is handled by loadFundingInfo(), don't overwrite here
        const high = statHigh();
        if (high) high.textContent = formatMoney(data.highPrice || data.high || 0);
        const low = statLow();
        if (low) low.textContent = formatMoney(data.lowPrice || data.low || 0);
        const volBtc = statVolBtc();
        if (volBtc) volBtc.textContent = Number(data.volume || 0).toFixed(3);
        const volUsdt = statVolUsdt();
        if (volUsdt) volUsdt.textContent = formatMoney(data.quoteVolume || 0);
    }

    function updateOrderBook(data) {
        const asks = Array.isArray(data?.asks) ? data.asks : [];
        const bids = Array.isArray(data?.bids) ? data.bids : [];
        renderOrderRows(asksContainer(), asks, "ask");
        renderOrderRows(bidsContainer(), bids, "bid");
    }

    function renderOrderRows(container, rows, type) {
        if (!container) return;
        container.innerHTML = "";
        let sum = 0;
        rows.slice(0, 12).forEach((row) => {
            const price = Number(row[0]);
            const size = Number(row[1]);
            sum += size;
            const depth = Math.min(100, (sum / 15) * 100);
            const div = document.createElement("div");
            div.className = `ob-row ${type}`;
            div.innerHTML = `
                <div class="depth-bar" style="width: ${depth}%"></div>
                <span>${formatMoney(price)}</span>
                <span>${size.toFixed(3)}</span>
                <span>${sum.toFixed(3)}</span>
            `;
            div.addEventListener("click", () => {
                const input = inputPriceEl();
                if (input) input.value = price.toFixed(2);
            });
            container.appendChild(div);
        });
    }

    function renderSyntheticOrderBook(basePrice) {
        const asks = [];
        const bids = [];
        for (let i = 1; i <= 16; i += 1) {
            asks.push([basePrice + i * (0.5 + Math.random() * 1.5), (Math.random() * 2).toFixed(3)]);
            bids.push([basePrice - i * (0.5 + Math.random() * 1.5), (Math.random() * 2).toFixed(3)]);
        }
        renderOrderRows(asksContainer(), asks, "ask");
        renderOrderRows(bidsContainer(), bids, "bid");
    }

    async function loadRecentTrades() {
        try {
            const data = await fetchJson(`https://api.binance.com/api/v3/aggTrades?symbol=${SYMBOL}&limit=20`);
            if (!Array.isArray(data)) return;
            const container = document.getElementById("futuresTrades");
            if (!container) return;
            container.innerHTML = "";
            data.reverse().forEach((t) => {
                const price = Number(t.p);
                const qty = Number(t.q);
                const time = new Date(t.T);
                const isBuy = !t.m;
                renderTradeRow(container, time, price, qty, isBuy);
            });
        } catch (error) {
            console.error("Failed to load recent trades", error);
        }
    }

    let liveTradeSocket = null;
    function connectLiveTradeStream() {
        try {
            liveTradeSocket = new WebSocket(`wss://stream.binance.com:9443/ws/${SYMBOL.toLowerCase()}@aggTrade`);
            liveTradeSocket.onmessage = (event) => {
                const t = JSON.parse(event.data || "{}");
                const price = Number(t.p);
                const qty = Number(t.q);
                if (!Number.isFinite(price)) return;
                const time = new Date(t.T);
                const isBuy = !t.m;
                const container = document.getElementById("futuresTrades");
                if (!container) return;
                renderTradeRow(container, time, price, qty, isBuy);
                while (container.children.length > 25) container.removeChild(container.lastChild);
            };
            liveTradeSocket.onclose = () => { liveTradeSocket = null; };
            liveTradeSocket.onerror = () => { liveTradeSocket = null; };
        } catch (error) {
            liveTradeSocket = null;
        }
    }

    function renderTradeRow(container, time, price, qty, isBuy) {
        const row = document.createElement("div");
        row.className = `future-trade-row ${isBuy ? "buy" : "sell"}`;
        const h = String(time.getHours()).padStart(2, "0");
        const m = String(time.getMinutes()).padStart(2, "0");
        const s = String(time.getSeconds()).padStart(2, "0");
        row.innerHTML = `<span>${h}:${m}:${s}</span><span>${formatMoney(price)}</span><span>${qty.toFixed(5)}</span>`;
        container.prepend(row);
    }

    function initActions() {
        const buy = btnBuy();
        const sell = btnSell();
        if (buy) buy.addEventListener("click", () => placeOrder("long"));
        if (sell) sell.addEventListener("click", () => placeOrder("short"));
    }

    function initTabs() {
        document.querySelectorAll(".futures-shell .tabs .tab").forEach((tab) => {
            tab.addEventListener("click", () => {
                document.querySelectorAll(".futures-shell .tabs .tab").forEach((el) => el.classList.remove("active"));
                tab.classList.add("active");
            });
        });
        document.querySelectorAll(".futures-shell .oe-type-tabs span").forEach((tab) => {
            tab.addEventListener("click", () => {
                document.querySelectorAll(".futures-shell .oe-type-tabs span").forEach((el) => el.classList.remove("active"));
                tab.classList.add("active");
            });
        });
    }

    function placeOrder(side) {
        const price = Number((inputPriceEl() || {}).value || 0);
        const size = Number((inputSizeEl() || {}).value || 0);
        if (!price || !size) {
            alert("Please enter both price and size.");
            return;
        }
        const leverage = 20;
        const tp = Number((inputTp() || {}).value || 0);
        const sl = Number((inputSl() || {}).value || 0);
        if (window.nexusTradeApi && typeof window.nexusTradeApi.openFuturesPosition === "function") {
            window.nexusTradeApi.openFuturesPosition(side, {
                amount: size,
                entry: price,
                leverage,
                tp,
                sl,
            });
            window.nexusTradeApi.renderFuturesPositions();
            updateAccountPanel();
            updatePositionsTab();
        } else {
            alert("Trading system is not ready. Please refresh the page.");
        }
        const sizeInput = inputSizeEl();
        if (sizeInput) sizeInput.value = "";
    }

    function updateAccountPanel() {
        const api = window.nexusTradeApi;
        if (!api) return;
        const positions = typeof api.getFuturesPositions === "function" ? api.getFuturesPositions() : [];
        const locked = positions.reduce((s, p) => s + Number(p.margin || 0), 0);
        const usdtBalance = typeof api.getWalletBalance === "function" ? api.getWalletBalance("USDT") : 0;
        const marginBalance = usdtBalance + locked;
        const maintenance = locked * 0.005;
        const ratio = typeof api.getMarginRatio === "function" ? api.getMarginRatio() : 0;

        const rows = document.querySelectorAll(".futures-shell .acc-row .val");
        if (rows.length >= 3) {
            rows[0].textContent = ratio.toFixed(2) + "%";
            rows[0].className = "val " + (ratio < 50 ? "green" : "red");
            rows[1].textContent = formatMoney(maintenance) + " USDT";
            rows[2].textContent = formatMoney(marginBalance) + " USDT";
        }
    }

    function updatePositionsTab() {
        const api = window.nexusTradeApi;
        if (!api) return;
        const count = typeof api.getFuturesCount === "function" ? api.getFuturesCount() : 0;
        const tab = document.getElementById("futuresPositionsTab");
        if (tab) tab.textContent = `Positions(${count})`;
    }

    function initSlider() {
        const container = slider();
        const thumb = sliderThumb();
        const fill = sliderFill();
        const sizeInput = inputSizeEl();
        if (!container || !thumb || !fill || !sizeInput) return;

        const setPercent = (pct) => {
            const clamped = Math.max(0, Math.min(100, pct));
            fill.style.width = `${clamped}%`;
            thumb.style.left = `${clamped}%`;
            const size = ((clamped / 100) * 1).toFixed(3);
            sizeInput.value = size;
        };

        container.addEventListener("click", (event) => {
            const rect = container.getBoundingClientRect();
            const pct = ((event.clientX - rect.left) / rect.width) * 100;
            setPercent(pct);
        });

        const marks = [0, 25, 50, 75, 100];
        container.querySelectorAll(".slider-marks span").forEach((el, idx) => {
            el.addEventListener("click", () => setPercent(marks[idx]));
        });
    }

    function initTpSlToggle() {
        const toggle = tpToggle();
        const fields = tpFields();
        if (!toggle || !fields) return;
        toggle.addEventListener("change", () => {
            fields.classList.toggle("hidden", !toggle.checked);
        });
    }

    function formatMoney(value) {
        return Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    }

    document.addEventListener("DOMContentLoaded", init);
})();
