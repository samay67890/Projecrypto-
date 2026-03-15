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

    function init() {
        initChart();
        initActions();
        initSlider();
        initTpSlToggle();
        initTabs();
        loadCandles();
        loadTicker();
        loadOrderBook();
        if (window.nexusTradeApi && typeof window.nexusTradeApi.renderFuturesPositions === "function") {
            window.nexusTradeApi.renderFuturesPositions();
        }
        tickerTimer = setInterval(loadTicker, 1500);
        setInterval(loadOrderBook, 2000);
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

    async function loadCandles() {
        try {
            const rows = await fetchJson(`https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=5m&limit=100`);
            const candles = Array.isArray(rows)
                ? rows.map((r) => ({
                    time: Math.floor(Number(r[0]) / 1000),
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
        const stream = `${SYMBOL.toLowerCase()}@kline_5m`;
        klineSocket = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`);
        klineSocket.onmessage = (event) => {
            const payload = JSON.parse(event.data || "{}");
            const k = payload.k;
            if (!k || !candleSeries) return;
            const candle = {
                time: Math.floor(k.t / 1000),
                open: Number(k.o),
                high: Number(k.h),
                low: Number(k.l),
                close: Number(k.c),
            };
            candleSeries.update(candle);
            updatePrice(candle.close, lastChange);
        };
    }

    // synthetic candles removed completely

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
        const mark = statMark();
        if (mark) mark.textContent = formatMoney(data.lastPrice || data.price || 0);
        const index = statIndex();
        if (index) index.textContent = formatMoney(data.lastPrice || data.price || 0);
        const funding = statFunding();
        if (funding) funding.textContent = "0.0000% / --";
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
        if (!price || !size) return;
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
        }
        const sizeInput = inputSizeEl();
        if (sizeInput) sizeInput.value = "";
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
