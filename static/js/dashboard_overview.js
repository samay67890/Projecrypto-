(function () {
    document.addEventListener("DOMContentLoaded", () => {
        const toggleBtn = document.getElementById("overviewToggleVisibility");
        const totalValue = document.getElementById("overviewTotalValue");
        const pnlLine = document.getElementById("overviewPnlLine");
        const pnlIcon = document.getElementById("overviewPnlIcon");
        const pnlText = document.getElementById("overviewPnlText");
        const lastUpdatedEl = document.getElementById("overviewLastUpdated");
        const investmentsBody = document.getElementById("overviewInvestmentsBody");
        const txBody = document.getElementById("overviewTransactionsBody");
        if (!toggleBtn || !totalValue || !investmentsBody || !txBody || !pnlLine || !pnlIcon || !pnlText) return;

        let hidden = false;

        function fmtMoney(value) {
            return `$${Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        }

        function fmtPct(value) {
            return `${Number(value || 0).toFixed(2)}%`;
        }

        function toNum(raw) {
            const clean = String(raw || "").replace(/[^0-9.+-]/g, "");
            const n = Number(clean);
            return Number.isFinite(n) ? n : 0;
        }

        function setSensitiveValue(id, valueText) {
            const el = document.getElementById(id);
            if (!el) return;
            el.classList.add("overview-sensitive");
            el.setAttribute("data-real-value", valueText);
            if (!hidden) el.textContent = valueText;
        }

        function refreshVisibility() {
            const icon = toggleBtn.querySelector("i");
            document.querySelectorAll(".overview-sensitive").forEach((el) => {
                const real = el.getAttribute("data-real-value") || "";
                el.textContent = hidden ? "****" : real;
            });
            if (icon) {
                icon.classList.toggle("fa-eye", !hidden);
                icon.classList.toggle("fa-eye-slash", hidden);
            }
        }

        function share(value, total) {
            if (!total) return "0.0% of Portfolio";
            return `${((value / total) * 100).toFixed(1)}% of Portfolio`;
        }

        function analyzeTrades(snapshot) {
            const trades = Array.isArray(snapshot?.history?.trades) ? [...snapshot.history.trades].reverse() : [];
            const books = {};
            let realizedPnl = 0;

            trades.forEach((t) => {
                const pair = String(t.pair || "Unknown");
                if (!books[pair]) books[pair] = { qty: 0, cost: 0 };
                const qty = Math.max(0, toNum(t.executed));
                const total = Math.max(0, toNum(t.total));
                const side = String(t.side || "").toLowerCase();
                const book = books[pair];

                if (side === "buy") {
                    book.qty += qty;
                    book.cost += total;
                    return;
                }

                const sellQty = Math.min(qty, book.qty);
                const avgCost = book.qty > 0 ? (book.cost / book.qty) : 0;
                const soldCost = avgCost * sellQty;
                realizedPnl += (total - soldCost);
                book.qty -= sellQty;
                book.cost -= soldCost;
                if (book.qty < 1e-12) {
                    book.qty = 0;
                    book.cost = 0;
                }
            });

            const rows = Object.entries(books).map(([pair, b]) => {
                const symbol = pair.split("/")[0];
                const isCurrent = symbol === snapshot?.selectedCoin?.symbol;
                const markPrice = isCurrent ? Number(snapshot?.spot?.markPrice || 0) : (b.qty > 0 ? b.cost / b.qty : 0);
                const current = b.qty * markPrice;
                const pnl = current - b.cost;
                return {
                    market: pair,
                    type: "Spot",
                    quantity: b.qty,
                    invested: b.cost,
                    current,
                    pnl,
                };
            }).filter((r) => r.quantity > 0 || r.invested > 0);

            return { rows, realizedPnl };
        }

        function buildMarginRows(snapshot) {
            const positions = Array.isArray(snapshot?.margin?.positions) ? snapshot.margin.positions : [];
            return positions.map((p) => {
                const symbol = String(p.symbol || snapshot?.selectedCoin?.symbol || "Asset").toUpperCase();
                const mark = Number(p.markPrice || snapshot?.spot?.markPrice || 0);
                const pnl = Number.isFinite(Number(p.pnl))
                    ? Number(p.pnl)
                    : ((p.side === "long" ? mark - p.entry : p.entry - mark) * p.amount);
                const current = Number.isFinite(Number(p.current))
                    ? Number(p.current)
                    : (Number(p.margin || 0) + pnl);
                return {
                    market: `${symbol}/USDT`,
                    type: `Margin ${p.leverage}x`,
                    quantity: Number(p.amount || 0),
                    invested: Number(p.margin || 0),
                    current,
                    pnl,
                };
            });
        }

        function buildFuturesRows(snapshot) {
            const positions = Array.isArray(snapshot?.futures?.positions) ? snapshot.futures.positions : [];
            return positions.map((p) => {
                const symbol = String(p.symbol || snapshot?.selectedCoin?.symbol || "Asset").toUpperCase();
                const mark = Number(p.markPrice || snapshot?.spot?.markPrice || 0);
                const pnl = Number.isFinite(Number(p.pnl))
                    ? Number(p.pnl)
                    : ((p.side === "long" ? mark - p.entry : p.entry - mark) * p.amount);
                const current = Number.isFinite(Number(p.current))
                    ? Number(p.current)
                    : (Number(p.margin || 0) + pnl);
                return {
                    market: `${symbol}/USDT`,
                    type: `Futures ${p.leverage}x`,
                    quantity: Number(p.amount || 0),
                    invested: Number(p.margin || 0),
                    current,
                    pnl,
                };
            });
        }

        function analyzeTransactions(snapshot) {
            const rows = Array.isArray(snapshot?.history?.transactions) ? snapshot.history.transactions : [];
            let capitalIn = 0;
            let capitalOut = 0;

            rows.forEach((tx) => {
                const amount = String(tx.amount || "");
                const details = String(tx.details || "").toLowerCase();
                const type = String(tx.type || "").toLowerCase();
                const value = Math.abs(toNum(amount));
                const isInternal = details.includes("spot to margin") || details.includes("margin to spot") || details.includes("spot to futures") || details.includes("futures to spot");
                const isDeposit = type.includes("deposit") || details.includes("deposit");
                const isWithdraw = type.includes("withdraw") || details.includes("withdraw");
                const isTradeFlow = type.includes("trade") || details.includes("spot buy") || details.includes("spot sell");

                if (isInternal) return;
                if (isTradeFlow) return;
                if (isDeposit || amount.trim().startsWith("+")) capitalIn += value;
                if (isWithdraw || amount.trim().startsWith("-")) capitalOut += value;
            });

            return { capitalIn, capitalOut, rows };
        }

        function renderInvestments(rows) {
            if (!rows.length) {
                investmentsBody.innerHTML = '<tr><td colspan="6" class="overview-empty-row">No investments yet. Start trading to populate this table.</td></tr>';
                return;
            }
            investmentsBody.innerHTML = rows.map((r) => {
                const pnlClass = r.pnl >= 0 ? "overview-pl-up" : "overview-pl-down";
                const pnlVal = `${r.pnl >= 0 ? "+" : ""}${fmtMoney(r.pnl)}`;
                return `
                    <tr>
                        <td>${r.market}</td>
                        <td><span class="overview-type-badge">${r.type}</span></td>
                        <td>${Number(r.quantity).toFixed(6)}</td>
                        <td class="overview-sensitive" data-real-value="${fmtMoney(r.invested)}">${hidden ? "****" : fmtMoney(r.invested)}</td>
                        <td class="overview-sensitive" data-real-value="${fmtMoney(r.current)}">${hidden ? "****" : fmtMoney(r.current)}</td>
                        <td class="${pnlClass} overview-sensitive" data-real-value="${pnlVal}">${hidden ? "****" : pnlVal}</td>
                    </tr>
                `;
            }).join("");
        }

        function renderTransactions(rows) {
            if (!rows.length) {
                txBody.innerHTML = '<tr><td colspan="5" class="overview-empty-row">No transaction records yet.</td></tr>';
                return;
            }
            txBody.innerHTML = rows.slice(0, 20).map((tx) => {
                const amountNum = toNum(tx.amount);
                const cls = amountNum > 0 ? "overview-type-inflow" : (amountNum < 0 ? "overview-type-outflow" : "");
                const amountText = tx.amount || "0.00";
                return `
                    <tr>
                        <td>${tx.time || "-"}</td>
                        <td>${tx.type || "-"}</td>
                        <td class="${cls}">${amountText}</td>
                        <td>${tx.status || "-"}</td>
                        <td>${tx.details || "-"}</td>
                    </tr>
                `;
            }).join("");
        }

        function renderSnapshot(snapshot) {
            if (!snapshot) return;
            const total = Number(snapshot.totalEquity || 0);
            const totalPnl = Number(snapshot.totalPnl || 0);
            const totalPnlPct = Number(snapshot.totalPnlPct || 0);

            const spotValue = Number(snapshot.usdt || 0) + Number(snapshot.spot?.value || 0);
            const marginValue = Number(snapshot.margin?.locked || 0) + Number(snapshot.margin?.pnl || 0);
            const futuresValue = Number(snapshot.futures?.locked || 0) + Number(snapshot.futures?.pnl || 0);
            const earnValue = 0;

            const tradeAnalysis = analyzeTrades(snapshot);
            const txAnalysis = analyzeTransactions(snapshot);

            const initialInvestment = Number(snapshot.initialInvestment || 0) + txAnalysis.capitalIn - txAnalysis.capitalOut;
            const netInvested = Math.max(0, tradeAnalysis.rows.reduce((sum, r) => sum + r.invested, 0) + marginValue + futuresValue);

            setSensitiveValue("overviewTotalValue", fmtMoney(total));
            setSensitiveValue("overviewFiatSpotValue", fmtMoney(spotValue));
            setSensitiveValue("overviewMarginValue", fmtMoney(marginValue));
            setSensitiveValue("overviewFuturesValue", fmtMoney(futuresValue));
            setSensitiveValue("overviewEarnValue", fmtMoney(earnValue));

            setSensitiveValue("overviewInitialInvestment", fmtMoney(initialInvestment));
            setSensitiveValue("overviewCurrentValue", fmtMoney(total));
            setSensitiveValue("overviewNetInvested", fmtMoney(netInvested));
            setSensitiveValue("overviewTotalPnl", `${totalPnl >= 0 ? "+" : ""}${fmtMoney(totalPnl)} (${fmtPct(totalPnlPct)})`);
            setSensitiveValue("overviewCapitalIn", fmtMoney(txAnalysis.capitalIn));
            setSensitiveValue("overviewCapitalOut", fmtMoney(txAnalysis.capitalOut));
            setSensitiveValue("overviewRealizedPnl", `${tradeAnalysis.realizedPnl >= 0 ? "+" : ""}${fmtMoney(tradeAnalysis.realizedPnl)}`);

            const fiatShare = document.getElementById("overviewFiatSpotShare");
            const marginShare = document.getElementById("overviewMarginShare");
            const futuresShare = document.getElementById("overviewFuturesShare");
            const earnShare = document.getElementById("overviewEarnShare");
            if (fiatShare) fiatShare.textContent = share(spotValue, total);
            if (marginShare) marginShare.textContent = share(marginValue, total);
            if (futuresShare) futuresShare.textContent = share(futuresValue, total);
            if (earnShare) earnShare.textContent = share(earnValue, total);

            const isUp = totalPnl >= 0;
            pnlLine.classList.toggle("is-up", isUp);
            pnlLine.classList.toggle("is-down", !isUp);
            pnlIcon.classList.toggle("fa-caret-up", isUp);
            pnlIcon.classList.toggle("fa-caret-down", !isUp);
            pnlText.textContent = `${totalPnl >= 0 ? "+" : ""}${fmtPct(totalPnlPct)} (${totalPnl >= 0 ? "+" : ""}${fmtMoney(totalPnl)})`;

            const totalPnlEl = document.getElementById("overviewTotalPnl");
            if (totalPnlEl) {
                totalPnlEl.classList.toggle("is-up", isUp);
                totalPnlEl.classList.toggle("is-down", !isUp);
            }

            const realizedEl = document.getElementById("overviewRealizedPnl");
            if (realizedEl) {
                realizedEl.classList.toggle("is-up", tradeAnalysis.realizedPnl >= 0);
                realizedEl.classList.toggle("is-down", tradeAnalysis.realizedPnl < 0);
            }

            renderInvestments([
                ...tradeAnalysis.rows,
                ...buildMarginRows(snapshot),
                ...buildFuturesRows(snapshot),
            ]);
            renderTransactions(txAnalysis.rows);
            if (lastUpdatedEl) {
                lastUpdatedEl.textContent = new Date(snapshot.updatedAt || Date.now()).toLocaleTimeString();
            }
            refreshVisibility();
        }

        toggleBtn.addEventListener("click", () => {
            hidden = !hidden;
            refreshVisibility();
        });

        document.addEventListener("nexus:portfolio:update", (event) => {
            renderSnapshot(event.detail || null);
        });

        if (window.nexusPortfolioSnapshot) {
            renderSnapshot(window.nexusPortfolioSnapshot);
        }

        setInterval(() => {
            if (window.nexusPortfolioSnapshot) {
                renderSnapshot(window.nexusPortfolioSnapshot);
            }
        }, 1000);
    });
})();
