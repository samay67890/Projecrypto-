(function () {
    const bootstrap = window.nexusBootstrap || {};
    const userIdScope = String(bootstrap.userId || "").trim();
    const userLabelScope = String(bootstrap.userLabel || "guest")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "guest";
    const userScope = userIdScope || userLabelScope;
    const STORAGE_KEY = `nexus.paper.state.v4.${userScope}`;
    const VIEW_STORAGE_KEY = `nexus.view.v1.${userScope}`;
    const STARTING_USDT = Number(bootstrap.initialUSDT || 1000000);
    const BINANCE_API_BASE = "/api/binance";
    const COINGECKO_API_BASE = "/api/coingecko";
    const state = loadState();
    const USE_SIM_MARKET = false;
    let dataProvider = "binance";
    let selectedCoin = {
        name: "Bitcoin",
        symbol: "BTC",
        image: "https://cryptologos.cc/logos/bitcoin-btc-logo.png",
        marketSymbol: "BTCUSDT",
    };
    let coinUniverse = [];
    let lastPrice = 64321;
    let lastChangePct = 0;
    let openingEquity = STARTING_USDT;
    let tradeSocket = null;
    let tradeFlushTimer = null;
    let pendingTradePrice = null;
    let pendingTradeQty = null;
    let marketLoops = { ticker: null, depth: null, sim: null };
    let chart = null;
    let futuresChart = null;
    let earnState = { tab: "flex", sort: "apy_desc", page: 1, pageSize: 9 };
    let earnProducts = buildEarnProducts();
    let earnSelection = null;
    const statusState = {
        lastKey: "",
        lastAt: 0,
        live: false,
    };

    initDebugGuards();
    initViews();
    restoreActiveView();
    initMenu();
    initToggleButtons();
    initIdentificationView();
    initSearch();
    initSpotTerminal();
    initMarginTerminal();
    initFuturesTerminal();
    initEarnHub();
    initHistoryView();
    initDepositNavigation();
    initCharts();
    initDataProvider();
    updateCoinHeader();
    updateUi();
    document.addEventListener("nexus:view:change", handleViewChange);

    function initDebugGuards() {
        window.addEventListener("error", (event) => {
            reportError("window.error", event?.error || event?.message || "Unknown error");
        });
        window.addEventListener("unhandledrejection", (event) => {
            reportError("unhandledrejection", event?.reason || "Unhandled promise rejection");
        });
    }

    function ensureStatusBadge() {
        let badge = document.getElementById("nexusStatusBadge");
        if (badge) return badge;
        const host = document.querySelector(".header-right");
        if (!host) return null;
        badge = document.createElement("div");
        badge.id = "nexusStatusBadge";
        badge.className = "nexus-status-badge";
        badge.textContent = "LIVE";
        host.prepend(badge);
        return badge;
    }

    function setStatusBadge(state, detail) {
        const badge = ensureStatusBadge();
        if (!badge) return;
        badge.classList.toggle("warn", state !== "live");
        badge.textContent = state === "live" ? "LIVE" : "DELAYED";
        if (detail) badge.setAttribute("title", detail);
    }

    function reportError(source, error, context = {}) {
        const message = error instanceof Error ? error.message : String(error || "Unknown error");
        const key = `${source}:${message}`;
        const now = Date.now();
        if (statusState.lastKey === key && now - statusState.lastAt < 4000) return;
        statusState.lastKey = key;
        statusState.lastAt = now;
        statusState.live = false;
        console.error(`[Nexus] ${source}`, error, context);
        setStatusBadge("delayed", message);
    }

    function markLive(detail) {
        statusState.live = true;
        setStatusBadge("live", detail || "Market data live");
    }

    async function initDataProvider() {
        dataProvider = await detectProvider();
        window.nexusDataProvider = dataProvider;
        await seedCoinUniverse();
        window.nexusCoinUniverse = [...coinUniverse];
        if (coinUniverse.length) {
            earnProducts = buildEarnProductsFromCoins(coinUniverse);
            renderEarnProducts();
        }
        updateSearchResults("");
        renderMarginMarkets();
        loadHistoricalData();
        if (USE_SIM_MARKET) {
            startSimMarket();
        } else {
            refreshMarketDataNow();
            restartMarketStreams();
        }
    }

    async function detectProvider() {
        try {
            const resp = await fetch(`${BINANCE_API_BASE}/ping/`);
            if (resp.ok) return "binance";
            reportError("binance.ping", `HTTP ${resp.status}`);
        } catch (error) {
            reportError("binance.ping", error);
        }
        return "coingecko";
    }

    function loadState() {
        const fallback = {
            usdt: STARTING_USDT,
            asset: 0,
            wallet: { USDT: STARTING_USDT, BTC: 0 },
            positions: [],
            futuresPositions: [],
            marginOpenOrders: [],
            history: { orders: [], trades: [], transactions: [] },
            earn: { positions: [], claimedTotal: 0 },
        };
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return fallback;
        try {
            const parsed = JSON.parse(raw);
            const parsedUsdt = Number(parsed.usdt);
            const walletRaw = (parsed && typeof parsed.wallet === "object" && parsed.wallet !== null) ? parsed.wallet : {};
            const wallet = {};
            Object.entries(walletRaw).forEach(([symbol, amount]) => {
                const key = String(symbol || "").toUpperCase().trim();
                const num = Number(amount);
                if (!key || !Number.isFinite(num)) return;
                wallet[key] = Math.max(0, num);
            });
            if (!Number.isFinite(wallet.USDT)) {
                wallet.USDT = Number.isFinite(parsedUsdt) ? Math.max(0, parsedUsdt) : STARTING_USDT;
            }
            if (!Number.isFinite(wallet.BTC)) {
                wallet.BTC = Math.max(0, Number(parsed.asset || 0));
            }

            const parsedHistory = {
                orders: Array.isArray(parsed?.history?.orders) ? parsed.history.orders : [],
                trades: Array.isArray(parsed?.history?.trades) ? parsed.history.trades : [],
                transactions: Array.isArray(parsed?.history?.transactions) ? parsed.history.transactions : [],
            };
            const noActivity = !parsedHistory.orders.length
                && !parsedHistory.trades.length
                && !parsedHistory.transactions.length
                && !(Array.isArray(parsed.positions) && parsed.positions.length)
                && !(Array.isArray(parsed.futuresPositions) && parsed.futuresPositions.length)
                && wallet.USDT === 0
                && Object.entries(wallet).every(([k, v]) => (k === "USDT" ? v === 0 : v === 0));
            if (noActivity) {
                wallet.USDT = STARTING_USDT;
            }

            return {
                usdt: wallet.USDT,
                asset: wallet.BTC,
                wallet,
                positions: Array.isArray(parsed.positions) ? parsed.positions : [],
                futuresPositions: Array.isArray(parsed.futuresPositions) ? parsed.futuresPositions : [],
                marginOpenOrders: Array.isArray(parsed.marginOpenOrders) ? parsed.marginOpenOrders : [],
                history: parsedHistory,
                earn: normalizeEarnState(parsed?.earn),
            };
        } catch (error) {
            return fallback;
        }
    }

    function normalizeEarnState(raw) {
        const fallback = { positions: [], claimedTotal: 0 };
        if (!raw || typeof raw !== "object") return fallback;
        const positions = Array.isArray(raw.positions) ? raw.positions : [];
        const safePositions = positions.map((p) => ({
            id: String(p?.id || `earn_${Date.now()}_${Math.random()}`),
            category: String(p?.category || "flex"),
            asset: String(p?.asset || "").toUpperCase(),
            name: String(p?.name || ""),
            apy: Number(p?.apy || 0),
            lockDays: Math.max(0, Number(p?.lockDays || 0)),
            amount: Math.max(0, Number(p?.amount || 0)),
            startedAt: Number(p?.startedAt || Date.now()),
            claimed: Math.max(0, Number(p?.claimed || 0)),
            status: String(p?.status || "active"),
        })).filter((p) => Number.isFinite(p.amount) && p.amount > 0);
        return {
            positions: safePositions,
            claimedTotal: Math.max(0, Number(raw.claimedTotal || 0)),
        };
    }

    function ensureEarnState() {
        if (!state.earn || typeof state.earn !== "object") {
            state.earn = { positions: [], claimedTotal: 0 };
            return;
        }
        if (!Array.isArray(state.earn.positions)) state.earn.positions = [];
        if (!Number.isFinite(Number(state.earn.claimedTotal))) state.earn.claimedTotal = 0;
    }

    function saveState() {
        ensureWallet();
        state.usdt = getWalletBalance("USDT");
        state.asset = getWalletBalance(selectedCoin.symbol);
        if (!Number.isFinite(state.usdt) || state.usdt < 0) state.usdt = 0;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function qs(id) {
        return document.getElementById(id);
    }

    function fmtMoney(value) {
        return Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtAsset(value) {
        return Number(value).toFixed(6);
    }

    function ensureWallet() {
        if (!state.wallet || typeof state.wallet !== "object") {
            state.wallet = {};
        }
        if (!Number.isFinite(Number(state.wallet.USDT))) {
            state.wallet.USDT = Number.isFinite(Number(state.usdt)) ? Math.max(0, Number(state.usdt)) : STARTING_USDT;
        }
    }

    function getWalletBalance(symbol) {
        ensureWallet();
        const key = String(symbol || "").toUpperCase().trim();
        return Math.max(0, Number(state.wallet[key] || 0));
    }

    function setWalletBalance(symbol, amount) {
        ensureWallet();
        const key = String(symbol || "").toUpperCase().trim();
        if (!key) return;
        const safeAmount = Math.max(0, Number(amount || 0));
        state.wallet[key] = safeAmount;
        if (key === "USDT") state.usdt = safeAmount;
        if (key === selectedCoin.symbol) state.asset = safeAmount;
    }

    function getAssetMarkPrice(symbol) {
        if (symbol === selectedCoin.symbol) return lastPrice;
        const coin = coinUniverse.find((x) => String(x.symbol || "").toUpperCase() === symbol);
        return Number(coin?.price || 0);
    }

    function initViews() {
        const navButtons = document.querySelectorAll("[data-view]");
        navButtons.forEach((btn) => {
            btn.addEventListener("click", (event) => {
                if (btn.tagName === "A") event.preventDefault();
                const view = btn.getAttribute("data-view");
                if (view) activateView(view);
            });
        });
    }

    function activateView(viewName) {
        document.querySelectorAll(".dashboard-view").forEach((el) => el.classList.remove("active"));
        document.querySelectorAll(".side-link, .nav-item").forEach((el) => el.classList.remove("active"));
        const view = qs(`view-${viewName}`);
        if (view) view.classList.add("active");
        document.querySelectorAll(`[data-view="${viewName}"]`).forEach((el) => el.classList.add("active"));
        const content = document.querySelector(".content-area");
        if (content) content.scrollTop = 0;
        saveActiveView(viewName);
        document.dispatchEvent(new CustomEvent("nexus:view:change", { detail: { view: viewName } }));
    }

    function saveActiveView(viewName) {
        try {
            if (!viewName) return;
            localStorage.setItem(VIEW_STORAGE_KEY, viewName);
        } catch (error) {
            // ignore storage failures
        }
    }

    function restoreActiveView() {
        try {
            const saved = localStorage.getItem(VIEW_STORAGE_KEY);
            if (!saved) return;
            const view = qs(`view-${saved}`);
            if (!view) return;
            activateView(saved);
        } catch (error) {
            // ignore storage failures
        }
    }

    function handleViewChange(event) {
        const view = event?.detail?.view || "overview";
        if (view === "trade" && chart) {
            requestAnimationFrame(() => chart.resize());
        }
        if (view === "futures") {
            renderFuturesPositions();
        }
    }

    function initMenu() {
        const trigger = qs("profileTrigger");
        const menu = qs("profileMenu");
        if (!trigger || !menu) return;
        trigger.addEventListener("click", () => menu.classList.toggle("show"));
        window.addEventListener("click", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            if (!target.closest("#profileTrigger") && !target.closest("#profileMenu")) menu.classList.remove("show");
        });
    }

    function initToggleButtons() {
        const groups = [
            { container: ".trade-tabs", item: ".tab" },
            { container: ".trade-mode", item: ".pill" },
            { container: ".margin-chart-tabs .tabs-left", item: ".tab" },
        ];
        groups.forEach(({ container, item }) => {
            document.querySelectorAll(container).forEach((group) => {
                const items = group.querySelectorAll(item);
                items.forEach((btn) => {
                    btn.addEventListener("click", () => {
                        items.forEach((el) => el.classList.remove("active"));
                        btn.classList.add("active");
                    });
                });
            });
        });
    }

    function initDepositNavigation() {
        const primaryBtn = document.querySelector(".deposit-btn[data-deposit-url]");
        const actionLinks = document.querySelectorAll(".deposit-link[data-deposit-url]");

        const navigate = (url) => {
            if (!url) return;
            window.location.href = url;
        };

        if (primaryBtn) {
            primaryBtn.addEventListener("click", () => {
                navigate(primaryBtn.getAttribute("data-deposit-url"));
            });
        }

        actionLinks.forEach((el) => {
            el.addEventListener("click", () => navigate(el.getAttribute("data-deposit-url")));
            el.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    navigate(el.getAttribute("data-deposit-url"));
                }
            });
        });
    }

    function initIdentificationView() {
        const modal = qs("identificationUploadModal");
        const openBtn = qs("openIdentificationUpload");
        const closeBtn = qs("closeIdentificationUpload");
        const confirmBtn = qs("confirmIdentificationUpload");

        if (!modal) return;

        const openModal = () => {
            modal.classList.add("show");
            modal.setAttribute("aria-hidden", "false");
        };
        const closeModal = () => {
            modal.classList.remove("show");
            modal.setAttribute("aria-hidden", "true");
        };

        if (openBtn) openBtn.addEventListener("click", openModal);
        if (closeBtn) closeBtn.addEventListener("click", closeModal);

        modal.addEventListener("click", (event) => {
            if (event.target === modal) closeModal();
        });

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && modal.classList.contains("show")) closeModal();
        });

        if (confirmBtn) {
            confirmBtn.addEventListener("click", () => {
                closeModal();
                alert("File upload started. Your document status will update once processing is complete.");
            });
        }
    }

    async function seedCoinUniverse() {
        try {
            if (dataProvider === "binance") {
                const [infoRes, tickerRes] = await Promise.all([
                    fetch(`${BINANCE_API_BASE}/exchange-info/`),
                    fetch(`${BINANCE_API_BASE}/ticker-24hr/`),
                ]);
                if (!infoRes.ok || !tickerRes.ok) throw new Error("binance api failed");
                const info = await infoRes.json();
                const tickers = await tickerRes.json();
                if (!Array.isArray(info?.symbols) || !Array.isArray(tickers)) throw new Error("binance data invalid");

                const allowed = info.symbols
                    .filter((s) => s && s.status === "TRADING" && s.quoteAsset === "USDT")
                    .map((s) => ({ symbol: String(s.symbol || ""), baseAsset: String(s.baseAsset || "") }));

                const tickerMap = new Map(tickers.map((t) => [String(t.symbol || ""), t]));

                const merged = allowed.map((s) => {
                    const t = tickerMap.get(s.symbol) || {};
                    return {
                        name: s.baseAsset || s.symbol.replace(/USDT$/, ""),
                        symbol: s.baseAsset || s.symbol.replace(/USDT$/, ""),
                        image: "",
                        marketSymbol: s.symbol,
                        price: Number(t.lastPrice || 0),
                        change24h: Number(t.priceChangePercent || 0),
                        quoteVolume: Number(t.quoteVolume || 0),
                    };
                }).filter((c) => Number.isFinite(c.price) && c.price > 0);

                merged.sort((a, b) => (b.quoteVolume || 0) - (a.quoteVolume || 0));
                coinUniverse = merged.slice(0, 120).map(({ quoteVolume, ...rest }) => rest);
                markLive("Binance markets");
                return;
            }

            const response = await fetch(`${COINGECKO_API_BASE}/markets/?vs_currency=usd&per_page=120&page=1&sparkline=false&price_change_percentage=24h`);
            if (!response.ok) throw new Error("coingecko api failed");
            const rows = await response.json();
            if (!Array.isArray(rows) || rows.length < 10) throw new Error("coingecko data invalid");
            coinUniverse = rows.map((c) => ({
                id: c.id,
                name: c.name,
                symbol: String(c.symbol || "").toUpperCase(),
                image: c.image || "",
                marketSymbol: `${String(c.symbol || "").toUpperCase()}USDT`,
                price: Number(c.current_price || 0),
                change24h: Number(c.price_change_percentage_24h || 0),
            }));
            markLive("CoinGecko markets");
        } catch (error) {
            reportError("markets.seed", error);
            coinUniverse = buildFallbackCoins(120);
        }
    }

    function buildFallbackCoins(count) {
        const out = [];
        out.push({ name: "Bitcoin", symbol: "BTC", image: "", marketSymbol: "BTCUSDT", price: 64000 });
        for (let i = 2; i <= count; i += 1) {
            out.push({
                name: `Coin ${i}`,
                symbol: `C${i}`,
                image: "",
                marketSymbol: `C${i}USDT`,
                price: Number((70000 / (i + 1)).toFixed(2)),
                change24h: 0,
            });
        }
        return out;
    }

    function initSearch() {
        const searchInput = qs("globalCoinSearch");
        const results = qs("searchResults");
        if (!searchInput || !results) return;

        searchInput.addEventListener("input", () => updateSearchResults(searchInput.value));
        searchInput.addEventListener("focus", () => updateSearchResults(searchInput.value));
        document.addEventListener("click", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            if (!target.closest("#coinSearchContainer")) results.classList.remove("show");
        });
    }

    function updateSearchResults(keyword) {
        const results = qs("searchResults");
        if (!results) return;
        const term = String(keyword || "").trim().toLowerCase();
        const matches = coinUniverse
            .filter((coin) => !term || coin.symbol.toLowerCase().includes(term) || coin.name.toLowerCase().includes(term))
            .slice(0, 14);

        results.innerHTML = "";
        matches.forEach((coin) => {
            const btn = document.createElement("button");
            btn.className = "search-item";
            btn.type = "button";
            btn.innerHTML = `
                <span class="search-item-left">
                    <span class="coin-badge">${coin.symbol.slice(0, 3)}</span>
                    <span>${coin.symbol} <span class="search-item-meta">${coin.name}</span></span>
                </span>
                <span>$${fmtMoney(coin.price || 0)}</span>
            `;
            btn.addEventListener("click", () => selectCoin(coin));
            results.appendChild(btn);
        });
        results.classList.toggle("show", matches.length > 0);
    }

    function selectCoin(coin) {
        selectedCoin = coin;
        lastPrice = Number(coin.price || lastPrice);
        updateCoinHeader();
        renderMarginMarkets();
        loadHistoricalData();
        if (USE_SIM_MARKET) {
            startSimMarket();
        } else {
            refreshMarketDataNow();
            restartMarketStreams();
        }
        const results = qs("searchResults");
        if (results) results.classList.remove("show");
    }

    function updateCoinHeader() {
        setText("pairSymbolText", `${selectedCoin.symbol} / USDT`);
        setText("pairNameText", selectedCoin.name);
        setText("walletCoinSymbol", selectedCoin.symbol);
        setText("spotAmountSymbol", selectedCoin.symbol);
        setText("spotUnitSymbol", selectedCoin.symbol);
        setText("fiatCoinSymbol", selectedCoin.symbol);
        setText("assetCoinSymbol", selectedCoin.symbol);
        setText("assetCoinSymbol2", selectedCoin.symbol);
        setText("assetCoinSymbol3", selectedCoin.symbol);
        setText("assetCoinName", selectedCoin.name);
        setText("marginPairLabel", `${selectedCoin.symbol}USDT`);
        setText("marginAssetSymbol", selectedCoin.symbol);
        setText("marginAssetSymbol2", selectedCoin.symbol);
        setText("futuresPairLabel", `${selectedCoin.symbol}USDT Perpetual`);
        const logo = qs("pairLogo");
        if (logo && selectedCoin.image) logo.src = selectedCoin.image;
        state.asset = getWalletBalance(selectedCoin.symbol);
    }

    function setText(id, text) {
        const el = qs(id);
        if (el) el.textContent = text;
    }

    function initSpotTerminal() {
        const range = qs("spotRange");
        const amountInput = qs("spotAmountInput");
        const buyBtn = qs("buyBtn");
        const sellBtn = qs("sellBtn");

        if (range && amountInput) {
            range.addEventListener("input", () => {
                const ratio = Number(range.value) / 100;
                amountInput.value = ((getWalletBalance("USDT") * ratio) / Math.max(lastPrice, 1)).toFixed(6);
            });
        }
        if (buyBtn) buyBtn.addEventListener("click", () => executeSpotTrade("buy"));
        if (sellBtn) sellBtn.addEventListener("click", () => executeSpotTrade("sell"));
    }

    function executeSpotTrade(side) {
        const amountInput = qs("spotAmountInput");
        const priceInput = qs("spotPriceInput");
        if (!amountInput || !priceInput) return;
        const amount = Number(amountInput.value);
        const price = Math.max(Number(priceInput.value) || lastPrice, 0);
        if (!amount || amount <= 0 || !price) return;

        const total = amount * price;
        const usdtBalance = getWalletBalance("USDT");
        const coinBalance = getWalletBalance(selectedCoin.symbol);
        if (side === "buy") {
            if (usdtBalance < total) return alert("Insufficient USDT balance.");
            setWalletBalance("USDT", usdtBalance - total);
            setWalletBalance(selectedCoin.symbol, coinBalance + amount);
        } else {
            if (coinBalance < amount) return alert(`Insufficient ${selectedCoin.symbol} balance.`);
            setWalletBalance(selectedCoin.symbol, coinBalance - amount);
            setWalletBalance("USDT", usdtBalance + total);
        }
        pushHistory("orders", {
            time: stamp(new Date()),
            pair: `${selectedCoin.symbol}/USDT`,
            type: "Market",
            side: side === "buy" ? "Buy" : "Sell",
            price: fmtMoney(price),
            amount: fmtAsset(amount),
            filled: "100%",
            status: "Filled",
        });
        pushHistory("trades", {
            time: stamp(new Date()),
            pair: `${selectedCoin.symbol}/USDT`,
            side: side === "buy" ? "Buy" : "Sell",
            price: fmtMoney(price),
            executed: fmtAsset(amount),
            fee: `${fmtAsset(amount * 0.001)} ${selectedCoin.symbol}`,
            total: `${fmtMoney(total)} USDT`,
        });
        pushHistory("transactions", {
            time: stamp(new Date()),
            asset: "USDT",
            type: "Trade",
            amount: `${side === "buy" ? "-" : "+"}${fmtMoney(total)}`,
            status: "Completed",
            details: `Spot ${side === "buy" ? "Buy" : "Sell"} ${fmtAsset(amount)} ${selectedCoin.symbol}`,
        });
        saveState();
        updateUi();
        amountInput.value = "";
        renderCurrentHistoryTab();
    }

    function initMarginTerminal() {
        const range = qs("marginRange");
        const levButton = qs("leverageBtn");
        if (range && levButton) {
            levButton.textContent = `${range.value}x`;
            const pill = qs("marginLeveragePill");
            if (pill) pill.textContent = `${range.value}x`;
            range.addEventListener("input", () => {
                levButton.textContent = `${range.value}x`;
                if (pill) pill.textContent = `${range.value}x`;
                updateMarginMetrics();
            });
        }
        document.querySelectorAll(".lev-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const lev = Number(btn.getAttribute("data-lev") || 20);
                if (range) range.value = String(lev);
                if (levButton) levButton.textContent = `${lev}x`;
                const pill = qs("marginLeveragePill");
                if (pill) pill.textContent = `${lev}x`;
                document.querySelectorAll(".lev-btn").forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                updateMarginMetrics();
            });
        });
        document.querySelectorAll("[data-margin-tab]").forEach((btn) => {
            btn.addEventListener("click", () => {
                document.querySelectorAll("[data-margin-tab]").forEach((b) => b.classList.remove("active"));
                btn.classList.add("active");
                const target = btn.getAttribute("data-margin-tab");
                const openPanel = qs("marginOpenOrdersPanel");
                const historyPanel = qs("marginOrderHistoryPanel");
                const tradePanel = qs("marginTradeHistoryPanel");
                const positionsPanel = qs("marginPositionsPanel");
                if (openPanel) openPanel.classList.toggle("active", target === "open");
                if (historyPanel) historyPanel.classList.toggle("active", target === "history");
                if (tradePanel) tradePanel.classList.toggle("active", target === "trades");
                if (positionsPanel) positionsPanel.classList.toggle("active", target === "positions");
            });
        });
        const marketSearch = qs("marginMarketSearch");
        if (marketSearch) {
            marketSearch.addEventListener("input", () => {
                renderMarginMarkets(marketSearch.value);
            });
        }
        const longBtn = qs("openLongBtn");
        const shortBtn = qs("openShortBtn");
        const closeAllBtn = qs("closeAllBtn");
        if (longBtn) longBtn.addEventListener("click", () => openMarginPosition("long"));
        if (shortBtn) shortBtn.addEventListener("click", () => openMarginPosition("short"));
        if (closeAllBtn) closeAllBtn.addEventListener("click", closeAllMarginPositions);

        const priceInput = qs("marginPriceInput");
        const amountInput = qs("marginAmountInput");
        if (priceInput) priceInput.addEventListener("input", updateMarginMetrics);
        if (amountInput) amountInput.addEventListener("input", updateMarginMetrics);
        renderMarginOrders();
        updateMarginMetrics();
    }

    function openMarginPosition(side) {
        const amount = Number((qs("marginAmountInput") || {}).value || 0);
        const entry = Number((qs("marginPriceInput") || {}).value || lastPrice);
        const leverage = Number((qs("marginRange") || {}).value || 20);
        if (!amount || amount <= 0 || !entry) return;
        const marginRequired = (amount * entry) / leverage;
        const usdtBalance = getWalletBalance("USDT");
        if (marginRequired > usdtBalance) return alert("Not enough USDT margin.");
        createMarginOrder(side, amount, entry, leverage);
    }

    function createMarginOrder(side, amount, entry, leverage) {
        const marginRequired = (amount * entry) / leverage;
        const usdtBalance = getWalletBalance("USDT");
        if (marginRequired > usdtBalance) return alert("Not enough USDT margin.");
        setWalletBalance("USDT", usdtBalance - marginRequired);
        const order = {
            id: `mo_${Date.now()}_${Math.random()}`,
            side,
            amount,
            entry,
            leverage,
            margin: marginRequired,
            time: stamp(new Date()),
            status: "Open",
        };
        if (!state.marginOpenOrders) state.marginOpenOrders = [];
        state.marginOpenOrders.push(order);
        renderMarginOrders();
        saveState();

        setTimeout(() => {
            fillMarginOrder(order.id);
        }, 1200 + Math.random() * 1200);
    }

    function fillMarginOrder(orderId) {
        if (!state.marginOpenOrders) state.marginOpenOrders = [];
        const idx = state.marginOpenOrders.findIndex((o) => o.id === orderId);
        if (idx === -1) return;
        const order = state.marginOpenOrders[idx];
        order.status = "Filled";
        state.marginOpenOrders.splice(idx, 1);
        state.positions.push({
            id: `m_${Date.now()}_${Math.random()}`,
            side: order.side,
            amount: order.amount,
            entry: order.entry,
            leverage: order.leverage,
            margin: order.margin,
        });
        pushHistory("orders", {
            time: order.time,
            pair: `${selectedCoin.symbol}/USDT`,
            type: `Margin ${order.leverage}x`,
            side: order.side === "long" ? "Buy" : "Sell",
            price: fmtMoney(order.entry),
            amount: fmtAsset(order.amount),
            filled: "100%",
            status: "Filled",
        });
        pushHistory("transactions", {
            time: order.time,
            asset: "USDT",
            type: "Transfer",
            amount: `${fmtMoney(order.margin)} (Margin Locked)`,
            status: "Completed",
            details: "Spot to Margin",
        });
        saveState();
        renderMarginOrders();
        updateUi();
        renderCurrentHistoryTab();
    }

    function closeAllMarginPositions() {
        let released = 0;
        state.positions.forEach((p) => {
            const diff = p.side === "long" ? lastPrice - p.entry : p.entry - lastPrice;
            const back = p.margin + (diff * p.amount);
            setWalletBalance("USDT", getWalletBalance("USDT") + back);
            released += back;
        });
        state.positions = [];
        pushHistory("transactions", {
            time: stamp(new Date()),
            asset: "USDT",
            type: "Transfer",
            amount: `+${fmtMoney(released)}`,
            status: "Completed",
            details: "Margin to Spot",
        });
        saveState();
        updateUi();
        renderCurrentHistoryTab();
    }

    function initFuturesTerminal() {
        const longBtn = qs("openFutLongBtn");
        const shortBtn = qs("openFutShortBtn");
        const closeBtn = qs("closeAllFuturesBtn");
        if (longBtn) longBtn.addEventListener("click", () => openFuturesPosition("long"));
        if (shortBtn) shortBtn.addEventListener("click", () => openFuturesPosition("short"));
        if (closeBtn) closeBtn.addEventListener("click", closeAllFuturesPositions);
        setInterval(updateFundingClock, 1000);
    }

    function openFuturesPosition(side, payload = {}) {
        const amount = Number(payload.amount ?? ((qs("futuresAmountInput") || {}).value || 0));
        const entry = Number(payload.entry ?? ((qs("futuresPriceInput") || {}).value || lastPrice));
        const leverage = Math.min(125, Math.max(1, Number(payload.leverage ?? ((qs("futuresLeverageInput") || {}).value || 20))));
        const tp = Number(payload.tp ?? ((qs("futuresTpInput") || {}).value || 0));
        const sl = Number(payload.sl ?? ((qs("futuresSlInput") || {}).value || 0));
        if (!amount || amount <= 0 || !entry) return;
        const marginRequired = (amount * entry) / leverage;
        const usdtBalance = getWalletBalance("USDT");
        if (marginRequired > usdtBalance) return alert("Not enough USDT for futures margin.");
        setWalletBalance("USDT", usdtBalance - marginRequired);
        state.futuresPositions.push({
            id: `f_${Date.now()}_${Math.random()}`,
            side,
            amount,
            entry,
            leverage,
            margin: marginRequired,
            tp: tp > 0 ? tp : null,
            sl: sl > 0 ? sl : null,
        });
        pushHistory("orders", {
            time: stamp(new Date()),
            pair: `${selectedCoin.symbol}/USDT`,
            type: `Futures ${leverage}x`,
            side: side === "long" ? "Buy" : "Sell",
            price: fmtMoney(entry),
            amount: fmtAsset(amount),
            filled: "100%",
            status: "Filled",
        });
        pushHistory("transactions", {
            time: stamp(new Date()),
            asset: "USDT",
            type: "Transfer",
            amount: `${fmtMoney(marginRequired)} (Futures Margin)`,
            status: "Completed",
            details: "Spot to Futures",
        });
        saveState();
        updateUi();
        renderCurrentHistoryTab();
    }

    function closeAllFuturesPositions() {
        let released = 0;
        state.futuresPositions.forEach((p) => {
            const diff = p.side === "long" ? lastPrice - p.entry : p.entry - lastPrice;
            const back = p.margin + (diff * p.amount);
            setWalletBalance("USDT", getWalletBalance("USDT") + back);
            released += back;
        });
        state.futuresPositions = [];
        pushHistory("transactions", {
            time: stamp(new Date()),
            asset: "USDT",
            type: "Transfer",
            amount: `+${fmtMoney(released)}`,
            status: "Completed",
            details: "Futures to Spot",
        });
        saveState();
        updateUi();
        renderCurrentHistoryTab();
    }

    function initEarnHub() {
        document.querySelectorAll(".earn-tab").forEach((btn) => {
            btn.addEventListener("click", () => {
                document.querySelectorAll(".earn-tab").forEach((x) => x.classList.remove("active"));
                btn.classList.add("active");
                earnState.tab = btn.getAttribute("data-earn-tab") || "flex";
                earnState.page = 1;
                renderEarnProducts();
            });
        });
        const sort = qs("earnSortSelect");
        if (sort) {
            sort.addEventListener("change", () => {
                earnState.sort = sort.value;
                earnState.page = 1;
                renderEarnProducts();
            });
        }
        const prev = qs("earnPrevBtn");
        const next = qs("earnNextBtn");
        if (prev) prev.addEventListener("click", () => {
            earnState.page = Math.max(1, earnState.page - 1);
            renderEarnProducts();
        });
        if (next) next.addEventListener("click", () => {
            earnState.page += 1;
            renderEarnProducts();
        });
        const grid = qs("earnProductsGrid");
        if (grid) {
            grid.addEventListener("click", (event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return;
                const btn = target.closest(".earn-subscribe-btn");
                if (!btn) return;
                const id = btn.getAttribute("data-earn-id");
                if (id) openEarnModal(id);
            });
        }
        const list = qs("earnPositionsList");
        if (list) {
            list.addEventListener("click", (event) => {
                const target = event.target;
                if (!(target instanceof HTMLElement)) return;
                const btn = target.closest(".earn-redeem-btn");
                if (!btn) return;
                const id = btn.getAttribute("data-earn-pos");
                if (id) redeemEarnPosition(id);
            });
        }
        const modal = qs("earnSubscribeModal");
        const closeBtn = qs("closeEarnModal");
        const cancelBtn = qs("cancelEarnModal");
        const confirmBtn = qs("confirmEarnModal");
        const amountInput = qs("earnAmountInput");
        if (closeBtn) closeBtn.addEventListener("click", closeEarnModal);
        if (cancelBtn) cancelBtn.addEventListener("click", closeEarnModal);
        if (confirmBtn) confirmBtn.addEventListener("click", confirmEarnSubscription);
        if (modal) {
            modal.addEventListener("click", (event) => {
                if (event.target === modal) closeEarnModal();
            });
        }
        if (amountInput) {
            amountInput.addEventListener("keydown", (event) => {
                if (event.key === "Enter") confirmEarnSubscription();
            });
        }
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                const active = qs("earnSubscribeModal");
                if (active && active.classList.contains("show")) closeEarnModal();
            }
        });
        renderEarnProducts();
        renderEarnPositions();
    }

    function buildEarnProducts() {
        const categories = ["flex", "fixed", "launchpool"];
        const items = [];
        categories.forEach((category, catIndex) => {
            for (let i = 1; i <= 72; i += 1) {
                const apy = Number((2 + catIndex * 3 + (i % 18) * 0.63).toFixed(2));
                items.push({
                    id: `${category}_${i}`,
                    category,
                    asset: `${category === "launchpool" ? "LP" : "E"}${i}`,
                    name: `${category.toUpperCase()} Product ${i}`,
                    apy,
                    lockDays: category === "flex" ? 0 : (30 + (i % 6) * 15),
                    min: Number((10 + (i % 9) * 25).toFixed(2)),
                });
            }
        });
        return items;
    }

    function buildEarnProductsFromCoins(universe) {
        const source = Array.isArray(universe) ? universe.filter((c) => c && c.symbol && c.name) : [];
        if (!source.length) return buildEarnProducts();
        const categories = ["flex", "fixed", "launchpool"];
        const items = [];
        const perCategory = 20;
        categories.forEach((category, catIndex) => {
            const slice = source.slice(catIndex * perCategory, (catIndex + 1) * perCategory);
            slice.forEach((coin, i) => {
                const apy = Number((3 + catIndex * 2 + (i % 10) * 0.45).toFixed(2));
                items.push({
                    id: `${category}_${coin.symbol}_${i}`,
                    category,
                    asset: String(coin.symbol || "").toUpperCase(),
                    name: `${coin.name} ${category === "launchpool" ? "Launchpool" : "Earn"}`,
                    apy,
                    lockDays: category === "flex" ? 0 : (30 + (i % 6) * 15),
                    min: Number((15 + (i % 7) * 20).toFixed(2)),
                });
            });
        });
        return items.length ? items : buildEarnProducts();
    }

    function renderEarnProducts() {
        const grid = qs("earnProductsGrid");
        const pageInfo = qs("earnPageInfo");
        const prev = qs("earnPrevBtn");
        const next = qs("earnNextBtn");
        if (!grid) return;

        let filtered = earnProducts.filter((p) => p.category === earnState.tab);
        if (earnState.sort === "apy_desc") filtered.sort((a, b) => b.apy - a.apy);
        if (earnState.sort === "apy_asc") filtered.sort((a, b) => a.apy - b.apy);
        if (earnState.sort === "name_asc") filtered.sort((a, b) => a.name.localeCompare(b.name));

        const totalPages = Math.max(1, Math.ceil(filtered.length / earnState.pageSize));
        if (earnState.page > totalPages) earnState.page = totalPages;
        const start = (earnState.page - 1) * earnState.pageSize;
        const pageItems = filtered.slice(start, start + earnState.pageSize);

        grid.innerHTML = "";
        pageItems.forEach((p) => {
            const card = document.createElement("div");
            card.className = "earn-card";
            card.innerHTML = `
                <div class="earn-card-top">
                    <div><strong>${p.asset}</strong><div class="search-item-meta">${p.name}</div></div>
                    <div class="apy-tag">${p.apy}% APY</div>
                </div>
                <p>${p.category === "flex" ? "Redeem anytime with daily interest." : "Higher rewards with lock period protection."}</p>
                <div class="earn-meta">
                    <span>Min: $${fmtMoney(p.min)}</span>
                    <span>${p.lockDays ? `${p.lockDays} days` : "Flexible"}</span>
                </div>
                <button class="gradient-btn earn-subscribe-btn" data-earn-id="${p.id}">Subscribe</button>
            `;
            grid.appendChild(card);
        });

        if (pageInfo) pageInfo.textContent = `Page ${earnState.page} of ${totalPages}`;
        if (prev) prev.disabled = earnState.page <= 1;
        if (next) next.disabled = earnState.page >= totalPages;
    }

    function openEarnModal(productId) {
        const product = earnProducts.find((p) => p.id === productId);
        if (!product) return;
        earnSelection = product;
        const modal = qs("earnSubscribeModal");
        const meta = qs("earnModalMeta");
        const amountInput = qs("earnAmountInput");
        const help = qs("earnAmountHelp");
        if (meta) {
            const lockLabel = product.lockDays ? `${product.lockDays}d lock` : "Flexible";
            meta.textContent = `${product.asset} - ${product.name} - ${product.apy}% APY - ${lockLabel}`;
        }
        if (amountInput) {
            amountInput.value = product.min.toFixed(2);
            amountInput.min = String(product.min);
        }
        if (help) {
            help.textContent = `Min $${fmtMoney(product.min)} - Available $${fmtMoney(getWalletBalance("USDT"))}`;
        }
        if (modal) {
            modal.classList.add("show");
            modal.setAttribute("aria-hidden", "false");
        }
    }

    function closeEarnModal() {
        const modal = qs("earnSubscribeModal");
        if (modal) {
            modal.classList.remove("show");
            modal.setAttribute("aria-hidden", "true");
        }
        earnSelection = null;
    }

    function confirmEarnSubscription() {
        if (!earnSelection) return;
        const input = qs("earnAmountInput");
        const raw = input ? Number(input.value) : 0;
        const ok = subscribeToEarn(earnSelection, raw);
        if (ok) closeEarnModal();
    }

    function subscribeToEarn(product, amountInput) {
        ensureEarnState();
        if (!product) return false;
        const amount = Math.max(0, Number(amountInput || 0));
        if (!amount || amount <= 0) return false;
        if (amount < product.min) {
            alert(`Minimum is $${fmtMoney(product.min)} for this product.`);
            return false;
        }
        const usdtBalance = getWalletBalance("USDT");
        if (usdtBalance < amount) {
            alert("Insufficient USDT balance for Earn subscription.");
            return false;
        }

        const position = {
            id: `earn_${Date.now()}_${Math.random()}`,
            category: product.category,
            asset: product.asset,
            name: product.name,
            apy: product.apy,
            lockDays: product.lockDays,
            amount,
            startedAt: Date.now(),
            claimed: 0,
            status: "active",
        };
        state.earn.positions.unshift(position);
        setWalletBalance("USDT", usdtBalance - amount);
        pushHistory("transactions", {
            time: stamp(new Date()),
            asset: "USDT",
            type: "Earn Subscribe",
            amount: `-${fmtMoney(amount)}`,
            status: "Completed",
            details: `${product.name} (${product.lockDays ? `${product.lockDays}d` : "Flexible"})`,
        });
        saveState();
        updateUi();
        renderEarnPositions();
        return true;
    }

    function redeemEarnPosition(positionId) {
        ensureEarnState();
        const pos = state.earn.positions.find((p) => p.id === positionId);
        if (!pos || pos.status !== "active") return;
        const now = Date.now();
        const elapsedDays = (now - pos.startedAt) / 86400000;
        const remaining = Math.max(0, pos.lockDays - elapsedDays);
        if (remaining > 0) return alert(`Locked for ${Math.ceil(remaining)} more day(s).`);

        const claimable = Math.max(0, calcEarnAccrued(pos, now) - pos.claimed);
        const totalReturn = pos.amount + claimable;
        setWalletBalance("USDT", getWalletBalance("USDT") + totalReturn);
        pos.claimed += claimable;
        pos.status = "redeemed";
        state.earn.claimedTotal = Math.max(0, Number(state.earn.claimedTotal || 0)) + claimable;
        pushHistory("transactions", {
            time: stamp(new Date()),
            asset: "USDT",
            type: "Earn Redeem",
            amount: `+${fmtMoney(totalReturn)}`,
            status: "Completed",
            details: `${pos.name} redeemed`,
        });
        saveState();
        updateUi();
        renderEarnPositions();
    }

    function calcEarnAccrued(position, nowMs) {
        const elapsedDays = Math.max(0, (nowMs - position.startedAt) / 86400000);
        return (position.amount * (position.apy / 100) * (elapsedDays / 365));
    }

    function getEarnTotals(nowMs) {
        ensureEarnState();
        const totals = {
            principal: 0,
            accrued: 0,
            claimable: 0,
            claimed: Number(state.earn.claimedTotal || 0),
        };
        state.earn.positions.forEach((p) => {
            totals.principal += p.amount;
            const accrued = Math.max(0, calcEarnAccrued(p, nowMs));
            totals.accrued += accrued;
            totals.claimable += Math.max(0, accrued - (p.claimed || 0));
        });
        return totals;
    }

    function renderEarnPositions() {
        ensureEarnState();
        const list = qs("earnPositionsList");
        const summary = qs("earnSummary");
        const totalEarnedText = qs("totalEarnedText");
        const now = Date.now();
        const totals = getEarnTotals(now);

        if (totalEarnedText) {
            totalEarnedText.textContent = `$${fmtMoney(totals.claimed + totals.claimable)}`;
        }
        if (summary) {
            summary.textContent = `Staked $${fmtMoney(totals.principal)} - Claimable $${fmtMoney(totals.claimable)}`;
        }
        if (!list) return;

        if (!state.earn.positions.length) {
            list.innerHTML = '<div class="earn-muted">No earn positions yet.</div>';
            return;
        }

        const rows = [...state.earn.positions].sort((a, b) => {
            if (a.status === b.status) return b.startedAt - a.startedAt;
            return a.status === "active" ? -1 : 1;
        });

        list.innerHTML = "";
        rows.forEach((p) => {
            const elapsedDays = (now - p.startedAt) / 86400000;
            const remaining = Math.max(0, p.lockDays - elapsedDays);
            const accrued = Math.max(0, calcEarnAccrued(p, now));
            const isActive = p.status === "active";
            const canRedeem = isActive && remaining <= 0;

            const row = document.createElement("div");
            row.className = `earn-position-row ${isActive ? "active" : "closed"}`;
            row.innerHTML = `
                <div class="earn-pos-main">
                    <strong>${p.asset}</strong>
                    <div class="earn-pos-meta">${p.name}</div>
                </div>
                <div class="earn-pos-chip">${p.apy}% APY</div>
                <div class="earn-pos-stat">Principal $${fmtMoney(p.amount)}</div>
                <div class="earn-pos-stat">Earned $${fmtMoney(accrued)}</div>
                <div class="earn-pos-stat">${p.lockDays ? `${Math.ceil(Math.max(0, remaining))}d left` : "Flexible"}</div>
                <div class="earn-pos-actions">
                    ${isActive ? `<button class="outline-btn earn-redeem-btn" data-earn-pos="${p.id}" ${canRedeem ? "" : "disabled"}>${canRedeem ? "Redeem" : "Locked"}</button>` : "<span class=\"earn-status\">Redeemed</span>"}
                </div>
            `;
            list.appendChild(row);
        });
    }

    function initCharts() {
        if (typeof Chart === "undefined") {
            reportError("chart.init", "Chart.js not available");
            return;
        }
        const canvas = qs("priceChartCanvas");
        if (canvas) {
            chart = new Chart(canvas, buildChartConfig("Spot Price"));
        }
        loadHistoricalData();
    }

    function buildChartConfig(label) {
        return {
            type: "line",
            data: {
                labels: [],
                datasets: [{
                    label,
                    data: [],
                    borderColor: lastChangePct >= 0 ? "#0ecb81" : "#f6465d",
                    backgroundColor: lastChangePct >= 0 ? "rgba(14, 203, 129, 0.15)" : "rgba(246, 70, 93, 0.15)",
                    borderWidth: 2,
                    tension: 0.1,
                    fill: true,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                }],
            },
            options: {
                animation: false,
                maintainAspectRatio: false,
                plugins: { 
                    legend: { display: false },
                    tooltip: {
                        mode: "index",
                        intersect: false,
                        backgroundColor: "#181a20",
                        titleColor: "#b7bdc6",
                        bodyColor: "#eaecef",
                        borderColor: "#2b3139",
                        borderWidth: 1,
                    }
                },
                scales: {
                    x: { ticks: { color: "#8b96a5", maxTicksLimit: 6 }, grid: { display: false, drawBorder: false } },
                    y: { ticks: { color: "#8b96a5" }, grid: { color: "rgba(255,255,255,0.03)", drawBorder: false } },
                },
                interaction: { mode: "nearest", axis: "x", intersect: false },
            },
        };
    }

    async function loadHistoricalData() {
        let points = [];
        try {
            if (dataProvider === "binance") {
                points = await fetchBinanceHistory();
            } else {
                points = await fetchCoingeckoHistory();
            }
        } catch (error) {
            reportError("history.load", error);
            points = [];
        }
        if (!points.length) {
            reportError("history.empty", "No historical data returned.");
            return;
        }
        updateChart(chart, points);
        markLive("Historical chart");
        lastPrice = Number(points[points.length - 1].close || lastPrice);
    }

    async function fetchBinanceHistory() {
        const cfg = getBinanceRangeConfig();
        const response = await fetch(`${BINANCE_API_BASE}/klines/?symbol=${selectedCoin.marketSymbol}&interval=${cfg.interval}&limit=${cfg.limit}`);
        if (!response.ok) {
            reportError("binance.klines", `HTTP ${response.status}`);
            return [];
        }
        const rows = await response.json();
        return Array.isArray(rows) ? rows.map((r) => ({ time: new Date(Number(r[0])), close: Number(r[4]) })).filter((r) => Number.isFinite(r.close)) : [];
    }

    async function fetchCoingeckoHistory() {
        const coinId = selectedCoin.id || resolveCoingeckoId(selectedCoin.symbol);
        if (!coinId) return [];
        const response = await fetch(`${COINGECKO_API_BASE}/market-chart/?id=${coinId}&vs_currency=usd&days=1&interval=minutely`);
        if (!response.ok) {
            reportError("coingecko.market-chart", `HTTP ${response.status}`);
            return [];
        }
        const payload = await response.json();
        const prices = Array.isArray(payload?.prices) ? payload.prices : [];
        if (!prices.length) return [];
        const points = prices.slice(-96).map((p) => ({
            time: new Date(Number(p[0])),
            close: Number(p[1]),
        })).filter((p) => Number.isFinite(p.close));
        return points;
    }

    function resolveCoingeckoId(symbol) {
        const coin = coinUniverse.find((c) => String(c.symbol || "").toUpperCase() === String(symbol || "").toUpperCase());
        return coin?.id || "";
    }

    function getBinanceRangeConfig() {
        return { interval: "15m", limit: 96 };
    }

    function updateChart(targetChart, points) {
        if (!targetChart) return;
        targetChart.data.labels = points.map((p) => timeLabel(p.time));
        
        const isPositive = lastChangePct >= 0;
        targetChart.data.datasets[0].borderColor = isPositive ? "#0ecb81" : "#f6465d";
        targetChart.data.datasets[0].backgroundColor = isPositive ? "rgba(14, 203, 129, 0.15)" : "rgba(246, 70, 93, 0.15)";
        targetChart.data.datasets[0].data = points.map((p) => p.close);
        targetChart.update("none");
    }

    function appendChartPoint(price) {
        [chart, futuresChart].forEach((targetChart) => {
            if (!targetChart || !Number.isFinite(price)) return;
            
            const isPositive = lastChangePct >= 0;
            targetChart.data.datasets[0].borderColor = isPositive ? "#0ecb81" : "#f6465d";
            targetChart.data.datasets[0].backgroundColor = isPositive ? "rgba(14, 203, 129, 0.15)" : "rgba(246, 70, 93, 0.15)";

            targetChart.data.labels.push(timeLabel(new Date()));
            targetChart.data.datasets[0].data.push(price);
            while (targetChart.data.labels.length > 120) {
                targetChart.data.labels.shift();
                targetChart.data.datasets[0].data.shift();
            }
            targetChart.update("none");
        });
    }

    function timeLabel(dateObj) {
        const d = dateObj instanceof Date ? dateObj : new Date(dateObj);
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }

    function restartMarketStreams() {
        if (marketLoops.ticker) clearInterval(marketLoops.ticker);
        if (marketLoops.depth) clearInterval(marketLoops.depth);
        if (tradeSocket && tradeSocket.readyState <= 1) tradeSocket.close();
        if (tradeFlushTimer) clearInterval(tradeFlushTimer);
        tradeFlushTimer = null;
        if (dataProvider === "binance") {
            connectTradeStream();
        }
        marketLoops.ticker = setInterval(refreshTicker, 10000);
        marketLoops.depth = setInterval(refreshDepth, 5000);
    }

    function refreshMarketDataNow() {
        refreshTicker();
        refreshDepth();
    }

    async function refreshTicker() {
        if (USE_SIM_MARKET) return;
        try {
            if (dataProvider === "binance") {
                const response = await fetch(`${BINANCE_API_BASE}/ticker-24hr/?symbol=${selectedCoin.marketSymbol}`);
                if (!response.ok) {
                    reportError("binance.ticker", `HTTP ${response.status}`);
                    return;
                }
                const data = await response.json();
                const price = Number(data.lastPrice);
                const change = Number(data.priceChangePercent);
                if (Number.isFinite(price)) {
                    applyPrice(price, change);
                    markLive("Binance ticker");
                }
            } else {
                const coinId = selectedCoin.id || resolveCoingeckoId(selectedCoin.symbol);
                if (!coinId) return;
                const response = await fetch(`${COINGECKO_API_BASE}/simple-price/?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`);
                if (!response.ok) {
                    reportError("coingecko.simple-price", `HTTP ${response.status}`);
                    return;
                }
                const data = await response.json();
                const row = data[coinId] || {};
                const price = Number(row.usd);
                const change = Number(row.usd_24h_change);
                if (Number.isFinite(price)) {
                    applyPrice(price, change);
                    markLive("CoinGecko ticker");
                }
            }
        } catch (error) {
            reportError("ticker.refresh", error);
        }
    }

    async function refreshDepth() {
        if (USE_SIM_MARKET) return;
        try {
            if (dataProvider === "binance") {
                const response = await fetch(`${BINANCE_API_BASE}/depth/?symbol=${selectedCoin.marketSymbol}&limit=6`);
                if (!response.ok) {
                    reportError("binance.depth", `HTTP ${response.status}`);
                    return;
                }
                const data = await response.json();
                renderBook("liveOrderAsks", data.asks || [], "sell");
                renderBook("liveOrderBids", data.bids || [], "buy");
                renderMarginBook("marginOrderAsks", data.asks || [], "sell");
                renderMarginBook("marginOrderBids", data.bids || [], "buy");
                renderBook("futOrderAsks", data.asks || [], "sell");
                renderBook("futOrderBids", data.bids || [], "buy");
            } else {
                const base = Number(lastPrice || 0) || 1;
                const asks = [];
                const bids = [];
                for (let i = 1; i <= 6; i += 1) {
                    const spread = base * 0.0006 * i;
                    asks.push([(base + spread).toFixed(2), (Math.random() * 0.8).toFixed(6)]);
                    bids.push([(base - spread).toFixed(2), (Math.random() * 0.8).toFixed(6)]);
                }
                renderBook("liveOrderAsks", asks, "sell");
                renderBook("liveOrderBids", bids, "buy");
                renderMarginBook("marginOrderAsks", asks, "sell");
                renderMarginBook("marginOrderBids", bids, "buy");
                renderBook("futOrderAsks", asks, "sell");
                renderBook("futOrderBids", bids, "buy");
            }
        } catch (error) {
            reportError("depth.refresh", error);
        }
    }

    function renderBook(containerId, rows, side) {
        const container = qs(containerId);
        if (!container) return;
        container.innerHTML = "";
        rows.slice(0, 5).forEach((item) => {
            const row = document.createElement("div");
            row.className = `ob-row ${side}`;
            row.innerHTML = `<span>${fmtMoney(item[0])}</span><span>${fmtAsset(item[1])}</span>`;
            row.addEventListener("click", () => {
                const priceInput = qs("spotPriceInput");
                if (priceInput) {
                    priceInput.value = Number(item[0]).toFixed(2);
                }
            });
            container.appendChild(row);
        });
    }

    function renderMarginBook(containerId, rows, side) {
        const container = qs(containerId);
        if (!container) return;
        const parsed = rows.slice(0, 10).map((item) => {
            const price = Number(item[0]);
            const amount = Number(item[1]);
            const total = price * amount;
            return { price, amount, total };
        });
        let cumulative = 0;
        const enriched = parsed.map((row) => {
            cumulative += row.total;
            return { ...row, cumulative };
        });
        const maxTotal = enriched.reduce((max, row) => Math.max(max, row.cumulative), 0) || 1;
        container.innerHTML = "";
        enriched.forEach((row, index) => {
            const el = document.createElement("div");
            el.className = `margin-ob-row ${side}${index === 0 ? " best" : ""}`;
            const depth = Math.min(100, (row.cumulative / maxTotal) * 100);
            el.style.setProperty("--depth", `${depth}%`);
            el.innerHTML = `
                <span>${fmtMoney(row.price)}</span>
                <span class="right">${fmtAsset(row.amount)}</span>
                <span class="right">${fmtMoney(row.cumulative)}</span>
            `;
            el.addEventListener("click", () => {
                const input = qs("marginPriceInput");
                if (input) input.value = Number(row.price).toFixed(2);
                updateMarginMetrics();
            });
            container.appendChild(el);
        });
    }

    function connectTradeStream() {
        if (USE_SIM_MARKET || dataProvider !== "binance") return;
        try {
            tradeSocket = new WebSocket(`wss://stream.binance.com:9443/ws/${selectedCoin.marketSymbol.toLowerCase()}@trade`);
            tradeSocket.onmessage = (event) => {
                const payload = JSON.parse(event.data || "{}");
                const price = Number(payload.p);
                const qty = Number(payload.q || 0);
                if (Number.isFinite(price)) {
                    pendingTradePrice = price;
                    pendingTradeQty = qty;
                }
            };
            tradeSocket.onclose = () => { tradeSocket = null; };
            tradeSocket.onerror = () => { reportError("binance.stream", "WebSocket error"); };
            if (!tradeFlushTimer) {
                tradeFlushTimer = setInterval(() => {
                    if (!Number.isFinite(pendingTradePrice)) return;
                    applyPrice(pendingTradePrice, null);
                    appendRecentTrade(pendingTradePrice, Number(pendingTradeQty || 0));
                    pendingTradePrice = null;
                    pendingTradeQty = null;
                }, 1000);
            }
        } catch (error) {
            tradeSocket = null;
            reportError("binance.stream", error);
        }
    }

    function appendRecentTrade(price, qty) {
        if (!Number.isFinite(price)) return;
        appendTradeRow("futuresTrades", price, qty);
        appendMarginTrade(price, qty);
    }

    function appendTradeRow(listId, price, qty) {
        const list = qs(listId);
        if (!list) return;
        const row = document.createElement("div");
        row.className = "future-trade-row";
        row.innerHTML = `<span>${timeLabel(new Date())}</span><span>$${fmtMoney(price)}</span><span>${fmtAsset(qty || 0)}</span>`;
        list.prepend(row);
        while (list.children.length > 18) list.removeChild(list.lastChild);
    }

    function appendMarginTrade(price, qty) {
        const list = qs("marginTrades");
        if (!list) return;
        const row = document.createElement("tr");
        const positive = lastChangePct >= 0;
        row.innerHTML = `
            <td style="color:${positive ? "var(--green)" : "var(--red)"}">${fmtMoney(price)}</td>
            <td class="right">${fmtAsset(qty || 0)}</td>
            <td class="right">${timeLabel(new Date())}</td>
        `;
        list.prepend(row);
        while (list.children.length > 18) list.removeChild(list.lastChild);
    }

    function applyPrice(price, changePercent) {
        lastPrice = price;
        if (Number.isFinite(changePercent)) lastChangePct = changePercent;
        const change = Number.isFinite(changePercent) ? Number(changePercent) : Number(lastChangePct || 0);
        const positive = change >= 0;
        const sign = positive ? "+" : "";
        flashPrice("marginLivePrice", positive);
        flashPrice("livePrice", positive);
        selectedCoin.price = price;
        const coinRef = coinUniverse.find((c) => c.symbol === selectedCoin.symbol);
        if (coinRef) {
            coinRef.price = price;
            if (Number.isFinite(changePercent)) coinRef.change24h = change;
        }

        setPrice("livePrice", `$${fmtMoney(price)} `, positive);
        const liveChange = qs("liveChange");
        if (liveChange) liveChange.textContent = `${sign}${change.toFixed(2)}%`;
        setText("livePairPrice", `$${fmtMoney(price)}`);
        setText("marginLivePrice", `$${fmtMoney(price)} (${sign}${change.toFixed(2)}%)`);
        setText("marginMidPrice", fmtMoney(price));
        setText("marginMarketBuy", fmtMoney(price));
        setText("marginMarketSell", fmtMoney(price));
        setText("futMarkPrice", `$${fmtMoney(price)}`);
        setText("futMidPrice", `$${fmtMoney(price)}`);
        setText("futuresPricePill", `$${fmtMoney(price)}`);

        const spotInput = qs("spotPriceInput");
        const marginInput = qs("marginPriceInput");
        if (spotInput) spotInput.value = price.toFixed(2);
        if (marginInput) marginInput.value = price.toFixed(2);

        appendChartPoint(price);
        updateMarginMarketRow();
        updateUi();
        updateFuturesMetrics(change);
        updateMarginMetrics();
    }

    function flashPrice(id, positive) {
        const el = qs(id);
        if (!el) return;
        el.classList.remove("price-flash-up", "price-flash-down");
        void el.offsetWidth;
        el.classList.add(positive ? "price-flash-up" : "price-flash-down");
    }

    function setPrice(id, text, positive) {
        const el = qs(id);
        if (!el) return;
        if (el.firstChild) el.firstChild.textContent = text;
        el.style.color = positive ? "var(--green)" : "var(--red)";
    }

    function updateFuturesMetrics(change) {
        const funding = (Math.sin(Date.now() / 600000) * 0.02).toFixed(4);
        const openInterest = 1200000000 + (state.futuresPositions.length * 3500000) + Math.round(lastPrice * 1200);
        setText("futFundingRate", `${funding}%`);
        setText("futOpenInterest", `$${fmtMoney(openInterest)}`);
    }

    function updateFundingClock() {
        const now = new Date();
        const remaining = (8 - (now.getUTCHours() % 8)) * 3600 - now.getUTCMinutes() * 60 - now.getUTCSeconds();
        const safe = Math.max(0, remaining);
        const h = String(Math.floor(safe / 3600)).padStart(2, "0");
        const m = String(Math.floor((safe % 3600) / 60)).padStart(2, "0");
        const s = String(safe % 60).padStart(2, "0");
        setText("futNextFunding", `${h}:${m}:${s}`);
    }

    function updateUi() {
        const usdtBalance = getWalletBalance("USDT");
        const selectedBalance = getWalletBalance(selectedCoin.symbol);
        state.usdt = usdtBalance;
        state.asset = selectedBalance;
        document.querySelectorAll("[data-balance-usdt]").forEach((el) => { el.textContent = fmtMoney(usdtBalance); });
        document.querySelectorAll("[data-balance-btc]").forEach((el) => { el.textContent = fmtAsset(selectedBalance); });
        const marginLocked = state.positions.reduce((sum, p) => sum + Number(p.margin || 0), 0);
        const futuresLocked = state.futuresPositions.reduce((sum, p) => sum + Number(p.margin || 0), 0);
        const spotAssetsValue = Object.entries(state.wallet || {}).reduce((sum, [symbol, amount]) => {
            if (symbol === "USDT") return sum;
            return sum + (Number(amount || 0) * getAssetMarkPrice(symbol));
        }, 0);
        const equity = usdtBalance + spotAssetsValue + marginLocked + futuresLocked + calcOpenPnl();
        const pnl = equity - openingEquity;
        setText("estimatedAssets", `$${fmtMoney(equity)}`);
        const pnlEl = qs("todaysPnl");
        if (pnlEl) {
            pnlEl.textContent = `Today PnL: ${pnl >= 0 ? "+" : ""}$${fmtMoney(pnl)}`;
            pnlEl.style.color = pnl >= 0 ? "var(--green)" : "var(--red)";
        }
        renderMarginPositions();
        renderFuturesPositions();
        renderEarnPositions();
        renderMarginOrders();
        publishOverviewData(equity, pnl, marginLocked, futuresLocked);
    }

    function publishOverviewData(equity, pnl, marginLocked, futuresLocked) {
        const safeEquity = Number.isFinite(equity) ? equity : STARTING_USDT;
        const safePnl = Number.isFinite(pnl) ? pnl : 0;
        const selectedBalance = getWalletBalance(selectedCoin.symbol);
        const allSpotValue = Object.entries(state.wallet || {}).reduce((sum, [symbol, amount]) => {
            if (symbol === "USDT") return sum;
            return sum + (Number(amount || 0) * getAssetMarkPrice(symbol));
        }, 0);
        const data = {
            initialInvestment: STARTING_USDT,
            totalEquity: safeEquity,
            totalPnl: safePnl,
            totalPnlPct: STARTING_USDT ? ((safePnl / STARTING_USDT) * 100) : 0,
            usdt: getWalletBalance("USDT"),
            spot: {
                symbol: selectedCoin.symbol,
                quantity: selectedBalance,
                markPrice: lastPrice,
                value: allSpotValue,
            },
            wallet: { ...(state.wallet || {}) },
            margin: {
                locked: marginLocked,
                pnl: state.positions.reduce((sum, p) => sum + ((p.side === "long" ? lastPrice - p.entry : p.entry - lastPrice) * p.amount), 0),
                positions: state.positions.map((p) => ({ ...p })),
            },
            futures: {
                locked: futuresLocked,
                pnl: state.futuresPositions.reduce((sum, p) => sum + ((p.side === "long" ? lastPrice - p.entry : p.entry - lastPrice) * p.amount), 0),
                positions: state.futuresPositions.map((p) => ({ ...p })),
            },
            history: {
                orders: [...state.history.orders],
                trades: [...state.history.trades],
                transactions: [...state.history.transactions],
            },
            selectedCoin: { ...selectedCoin },
            updatedAt: Date.now(),
        };

        window.nexusPortfolioSnapshot = data;
        document.dispatchEvent(new CustomEvent("nexus:portfolio:update", { detail: data }));
    }

    function calcOpenPnl() {
        const marginPnl = state.positions.reduce((sum, p) => sum + ((p.side === "long" ? lastPrice - p.entry : p.entry - lastPrice) * p.amount), 0);
        const futPnl = state.futuresPositions.reduce((sum, p) => sum + ((p.side === "long" ? lastPrice - p.entry : p.entry - lastPrice) * p.amount), 0);
        return marginPnl + futPnl;
    }

    function renderMarginPositions() {
        const list = qs("positionsList");
        if (!list) return;
        list.innerHTML = "";
        if (!state.positions.length) {
            list.innerHTML = '<div class="position-item">No open positions</div>';
            return;
        }
        state.positions.forEach((p) => {
            const pnl = (p.side === "long" ? lastPrice - p.entry : p.entry - lastPrice) * p.amount;
            const row = document.createElement("div");
            row.className = `position-item ${p.side}`;
            row.innerHTML = `<span>${p.side.toUpperCase()} ${fmtAsset(p.amount)} ${selectedCoin.symbol} @ ${fmtMoney(p.entry)} (${p.leverage}x)</span><span style="color:${pnl >= 0 ? "var(--green)" : "var(--red)"}">${pnl >= 0 ? "+" : ""}$${fmtMoney(pnl)}</span>`;
            list.appendChild(row);
        });
    }

    function renderMarginOrders() {
        const openList = qs("marginOpenOrders");
        const histList = qs("marginOrderHistory");
        const tradeList = qs("marginTradeHistory");
        const posList = qs("marginPositionsTable");
        const openTab = document.querySelector('[data-margin-tab="open"]');
        if (openTab) openTab.textContent = `Open Orders(${(state.marginOpenOrders || []).length})`;
        if (openList) {
            openList.innerHTML = "";
            (state.marginOpenOrders || []).forEach((o) => {
                const row = document.createElement("tr");
                row.innerHTML = `
                    <td>${o.time}</td>
                    <td>${selectedCoin.symbol}/USDT</td>
                    <td>${o.side === "long" ? "Buy" : "Sell"}</td>
                    <td class="right">${fmtMoney(o.entry)}</td>
                    <td class="right">${fmtAsset(o.amount)}</td>
                    <td class="right">${o.status}</td>
                    <td class="right"><button data-cancel="${o.id}">Cancel</button></td>
                `;
                row.querySelector("button").addEventListener("click", () => cancelMarginOrder(o.id));
                openList.appendChild(row);
            });
            if (!(state.marginOpenOrders || []).length) {
                openList.innerHTML = '<tr><td colspan="7" class="right">No open orders</td></tr>';
            }
        }
        if (histList) {
            histList.innerHTML = "";
            state.history.orders.slice(-20).forEach((o) => {
                const row = document.createElement("tr");
                row.innerHTML = `
                    <td>${o.time}</td>
                    <td>${o.pair}</td>
                    <td>${o.side}</td>
                    <td class="right">${o.price}</td>
                    <td class="right">${o.amount}</td>
                    <td class="right">${o.status}</td>
                `;
                histList.appendChild(row);
            });
            if (!state.history.orders.length) {
                histList.innerHTML = '<tr><td colspan="6" class="right">No order history</td></tr>';
            }
        }

        if (tradeList) {
            tradeList.innerHTML = "";
            state.history.trades.slice(-20).forEach((t) => {
                const row = document.createElement("tr");
                row.innerHTML = `
                    <td>${t.time}</td>
                    <td>${t.pair}</td>
                    <td>${t.side}</td>
                    <td class="right">${t.price}</td>
                    <td class="right">${t.executed}</td>
                    <td class="right">${t.fee}</td>
                `;
                tradeList.appendChild(row);
            });
            if (!state.history.trades.length) {
                tradeList.innerHTML = '<tr><td colspan="6" class="right">No trade history</td></tr>';
            }
        }

        if (posList) {
            posList.innerHTML = "";
            state.positions.forEach((p) => {
                const pnl = (p.side === "long" ? lastPrice - p.entry : p.entry - lastPrice) * p.amount;
                const row = document.createElement("tr");
                row.innerHTML = `
                    <td>${p.side === "long" ? "Long" : "Short"}</td>
                    <td>${fmtAsset(p.amount)} ${selectedCoin.symbol}</td>
                    <td class="right">$${fmtMoney(p.entry)}</td>
                    <td class="right">${p.leverage}x</td>
                    <td class="right" style="color:${pnl >= 0 ? "var(--green)" : "var(--red)"}">${pnl >= 0 ? "+" : ""}$${fmtMoney(pnl)}</td>
                `;
                posList.appendChild(row);
            });
            if (!state.positions.length) {
                posList.innerHTML = '<tr><td colspan="5" class="right">No open positions</td></tr>';
            }
        }
    }

    function cancelMarginOrder(orderId) {
        if (!state.marginOpenOrders) state.marginOpenOrders = [];
        const idx = state.marginOpenOrders.findIndex((o) => o.id === orderId);
        if (idx === -1) return;
        const order = state.marginOpenOrders[idx];
        state.marginOpenOrders.splice(idx, 1);
        setWalletBalance("USDT", getWalletBalance("USDT") + order.margin);
        saveState();
        renderMarginOrders();
        updateUi();
    }

    function renderMarginMarkets(keyword) {
        const list = qs("marginMarketList");
        if (!list) return;
        const term = String(keyword || "").trim().toLowerCase();
        list.innerHTML = "";
        coinUniverse
            .filter((coin) => !term || coin.symbol.toLowerCase().includes(term) || coin.name.toLowerCase().includes(term))
            .slice(0, 18)
            .forEach((coin) => {
                const row = document.createElement("tr");
                row.className = "margin-market-row";
                row.dataset.symbol = coin.symbol;
                const isSelected = coin.symbol === selectedCoin.symbol;
                const price = isSelected ? lastPrice : Number(coin.price || 0);
                const change = isSelected ? lastChangePct : Number(coin.change24h || 0);
                row.innerHTML = `
                    <td>${coin.symbol}/USDT ${isSelected ? '<span class="margin-pill">Active</span>' : ""}</td>
                    <td class="right">$${fmtMoney(price)}</td>
                    <td class="right" style="color:${change >= 0 ? "var(--green)" : "var(--red)"}">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</td>
                `;
                row.addEventListener("click", () => selectCoin(coin));
                list.appendChild(row);
            });
    }

    function updateMarginMetrics() {
        const leverage = Number((qs("marginRange") || {}).value || 20);
        const amount = Number((qs("marginAmountInput") || {}).value || 0);
        const entry = Number((qs("marginPriceInput") || {}).value || lastPrice);
        const notional = amount * entry;
        const marginRequired = leverage ? notional / leverage : 0;
        const borrowed = Math.max(0, notional - marginRequired);
        const ratio = notional ? (marginRequired / notional) * 100 : 0;
        const liq = leverage ? (entry * (1 - 1 / leverage)) : entry;
        const pnl = (lastPrice - entry) * amount;
        setText("marginRatio", `${ratio.toFixed(2)}%`);
        setText("marginLiq", `$${fmtMoney(Math.max(0, liq))}`);
        setText("marginBorrowed", `${fmtAsset(borrowed)} ${selectedCoin.symbol}`);
        const pnlEl = qs("marginEstPnl");
        if (pnlEl) {
            pnlEl.textContent = `${pnl >= 0 ? "+" : ""}$${fmtMoney(pnl)}`;
            pnlEl.style.color = pnl >= 0 ? "var(--green)" : "var(--red)";
        }
    }

    function startSimMarket() {
        if (marketLoops.sim) clearInterval(marketLoops.sim);
        if (tradeSocket && tradeSocket.readyState <= 1) tradeSocket.close();
        marketLoops.sim = setInterval(() => {
            const drift = (Math.random() - 0.5) * 0.6;
            const volatility = 1 + Math.random() * 0.5;
            const next = Math.max(1, lastPrice + drift * volatility * 50);
            const changePct = ((next - lastPrice) / Math.max(lastPrice, 1)) * 100;
            applyPrice(next, (Number.isFinite(lastChangePct) ? lastChangePct : 0) + changePct);
            renderSimOrderBook(next);
            renderSimTrades(next);
        }, 1000);
        renderSimOrderBook(lastPrice);
    }

    function renderSimOrderBook(basePrice) {
        const asks = [];
        const bids = [];
        for (let i = 1; i <= 12; i += 1) {
            const askPrice = basePrice + i * (0.5 + Math.random() * 1.5);
            const bidPrice = basePrice - i * (0.5 + Math.random() * 1.5);
            asks.push([askPrice.toFixed(2), (Math.random() * 0.8).toFixed(6)]);
            bids.push([bidPrice.toFixed(2), (Math.random() * 0.8).toFixed(6)]);
        }
        renderMarginBook("marginOrderAsks", asks, "sell");
        renderMarginBook("marginOrderBids", bids, "buy");
        renderBook("liveOrderAsks", asks, "sell");
        renderBook("liveOrderBids", bids, "buy");
        renderBook("futOrderAsks", asks, "sell");
        renderBook("futOrderBids", bids, "buy");
    }

    function renderSimTrades(price) {
        const qty = Math.random() * 0.4;
        appendMarginTrade(price, qty);
        appendTradeRow("futuresTrades", price, qty);
    }

    function updateMarginMarketRow() {
        const list = qs("marginMarketList");
        if (!list) return;
        const row = list.querySelector(`tr[data-symbol="${selectedCoin.symbol}"]`);
        if (!row) {
            const search = qs("marginMarketSearch");
            renderMarginMarkets(search ? search.value : "");
            return;
        }
        const cells = row.querySelectorAll("td");
        if (cells.length < 3) return;
        cells[1].textContent = `$${fmtMoney(lastPrice)}`;
        cells[2].textContent = `${lastChangePct >= 0 ? "+" : ""}${Number(lastChangePct || 0).toFixed(2)}%`;
        cells[2].style.color = lastChangePct >= 0 ? "var(--green)" : "var(--red)";
    }

    function renderFuturesPositions() {
        const list = qs("futuresPositions");
        const tab = qs("futuresPositionsTab");
        if (tab) tab.textContent = `Positions(${state.futuresPositions.length})`;
        if (!list) return;
        list.innerHTML = "";
        if (!state.futuresPositions.length) {
            list.innerHTML = '<div class="future-position-row">No open futures positions</div>';
            return;
        }
        state.futuresPositions.forEach((p) => {
            const pnl = (p.side === "long" ? lastPrice - p.entry : p.entry - lastPrice) * p.amount;
            const liq = p.side === "long" ? p.entry * (1 - (1 / p.leverage)) : p.entry * (1 + (1 / p.leverage));
            const row = document.createElement("div");
            row.className = `future-position-row ${p.side}`;
            row.innerHTML = `
                <span>${p.side.toUpperCase()} ${fmtAsset(p.amount)} ${selectedCoin.symbol} @ ${fmtMoney(p.entry)} (${p.leverage}x)</span>
                <span>TP:${p.tp ? fmtMoney(p.tp) : "-"} SL:${p.sl ? fmtMoney(p.sl) : "-"}</span>
                <span>Liq: ${fmtMoney(liq)}</span>
                <span style="color:${pnl >= 0 ? "var(--green)" : "var(--red)"}">${pnl >= 0 ? "+" : ""}$${fmtMoney(pnl)}</span>
            `;
            list.appendChild(row);
        });
    }

    function initHistoryView() {
        const tabs = document.querySelectorAll(".history-tab");
        if (!tabs.length) return;

        tabs.forEach((tab) => {
            tab.addEventListener("click", () => {
                tabs.forEach((t) => t.classList.remove("active"));
                tab.classList.add("active");
                const tabName = tab.getAttribute("data-history-tab") || "order";
                renderHistoryTable(tabName);
            });
        });

        renderHistoryTable("order");
    }

    function renderHistoryTable(tabName) {
        const head = qs("historyTableHead");
        const body = qs("historyTableBody");
        if (!head || !body) return;

        const rows = {
            order: state.history.orders.slice(0, 100),
            trade: state.history.trades.slice(0, 100),
            transaction: state.history.transactions.slice(0, 100),
        };

        if (tabName === "order") {
            head.innerHTML = "<th>Time</th><th>Pair</th><th>Type</th><th>Side</th><th>Price</th><th>Amount</th><th>Filled</th><th>Status</th>";
            if (!rows.order.length) {
                body.innerHTML = `<tr><td colspan="8" class="history-muted">No order history yet.</td></tr>`;
                return;
            }
            body.innerHTML = rows.order.map((r) => `
                <tr>
                    <td>${r.time}</td>
                    <td>${r.pair}</td>
                    <td>${r.type}</td>
                    <td class="${r.side === "Buy" ? "status-buy" : "status-sell"}">${r.side}</td>
                    <td>${r.price}</td>
                    <td>${r.amount}</td>
                    <td>${r.filled}</td>
                    <td>${r.status}</td>
                </tr>
            `).join("");
            return;
        }

        if (tabName === "trade") {
            head.innerHTML = "<th>Time</th><th>Pair</th><th>Side</th><th>Price</th><th>Executed</th><th>Fee</th><th>Total</th>";
            if (!rows.trade.length) {
                body.innerHTML = `<tr><td colspan="7" class="history-muted">No trade history yet.</td></tr>`;
                return;
            }
            body.innerHTML = rows.trade.map((r) => `
                <tr>
                    <td>${r.time}</td>
                    <td>${r.pair}</td>
                    <td class="${r.side === "Buy" ? "status-buy" : "status-sell"}">${r.side}</td>
                    <td>${r.price}</td>
                    <td>${r.executed}</td>
                    <td><span class="history-pill">${r.fee}</span></td>
                    <td>${r.total}</td>
                </tr>
            `).join("");
            return;
        }

        head.innerHTML = "<th>Time</th><th>Asset</th><th>Type</th><th>Amount</th><th>Status</th><th>Details</th>";
        if (!rows.transaction.length) {
            body.innerHTML = `<tr><td colspan="6" class="history-muted">No transaction history yet.</td></tr>`;
            return;
        }
        body.innerHTML = rows.transaction.map((r) => `
            <tr>
                <td>${r.time}</td>
                <td><strong>${r.asset}</strong></td>
                <td>${r.type}</td>
                <td class="${String(r.amount).startsWith('+') ? "amount-pos" : "amount-neutral"}">${r.amount}</td>
                <td>${r.status}</td>
                <td class="history-muted">${r.details}</td>
            </tr>
        `).join("");
    }

    function stamp(d) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const mi = String(d.getMinutes()).padStart(2, "0");
        const ss = String(d.getSeconds()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
    }

    function pushHistory(type, row) {
        if (!state.history) {
            state.history = { orders: [], trades: [], transactions: [] };
        }
        if (!Array.isArray(state.history[type])) return;
        state.history[type].unshift(row);
        if (state.history[type].length > 200) {
            state.history[type] = state.history[type].slice(0, 200);
        }
    }

    function renderCurrentHistoryTab() {
        const active = document.querySelector(".history-tab.active");
        const tabName = active ? (active.getAttribute("data-history-tab") || "order") : "order";
        renderHistoryTable(tabName);
    }

    window.nexusTradeApi = {
        openFuturesPosition,
        closeAllFuturesPositions,
        getLastPrice: () => lastPrice,
        getSelectedCoin: () => ({ ...selectedCoin }),
        renderFuturesPositions,
        getFuturesCount: () => state.futuresPositions.length,
        getWalletBalance: (symbol) => getWalletBalance(symbol),
        getFuturesPositions: () => [...state.futuresPositions],
        getMarginRatio: () => {
            const locked = state.futuresPositions.reduce((s, p) => s + Number(p.margin || 0), 0);
            const balance = getWalletBalance("USDT") + locked;
            if (balance <= 0) return 0;
            const maintenance = locked * 0.005;
            return (maintenance / balance) * 100;
        },
    };
})();

