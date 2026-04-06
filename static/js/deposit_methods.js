let currentAmount = 0;
let currentMethod = "";
let currentType = "";
const bootstrap = window.nexusBootstrap || {};
const userIdScope = String(bootstrap.userId || "").trim();
const userLabelScope = String(bootstrap.userLabel || "guest")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "guest";
const userScope = userIdScope || userLabelScope;
const STORAGE_KEY = `nexus.paper.state.v4.${userScope}`;
const STARTING_USDT = Number(bootstrap.initialUSDT || 1000000);

const overlay = document.getElementById("gatewayOverlay");
const customInput = document.getElementById("customInput");
const confirmAmountBtn = document.getElementById("confirmAmountBtn");
const payNowBtn = document.getElementById("payNowBtn");
const methodSearch = document.getElementById("methodSearch");
const withdrawalForm = document.getElementById("withdrawalForm");
const withdrawAmountInput = document.getElementById("withdrawAmount");
const withdrawWalletAddressInput = document.getElementById("withdrawWalletAddress");
const withdrawMessage = document.getElementById("withdrawMessage");
const availableBalanceEl = document.getElementById("availableBalance");

function getCookie(name) {
    let cookieValue = null;
    if (document.cookie && document.cookie !== '') {
        const cookies = document.cookie.split(';');
        for (let i = 0; i < cookies.length; i++) {
            const cookie = cookies[i].trim();
            if (cookie.substring(0, name.length + 1) === (name + '=')) {
                cookieValue = decodeURIComponent(cookie.substring(name.length + 1));
                break;
            }
        }
    }
    return cookieValue;
}

function showStep(id) {
    document.querySelectorAll(".step").forEach((step) => step.classList.remove("active"));
    const target = document.getElementById(id);
    if (target) {
        target.classList.add("active");
    }
}

function openGateway(name, type) {
    currentMethod = name;
    currentType = type;
    document.getElementById("activeMethod").innerText = name.toUpperCase();
    overlay.classList.add("show");
    overlay.setAttribute("aria-hidden", "false");
    showStep("stepAmount");
}

function closeGateway() {
    overlay.classList.remove("show");
    overlay.setAttribute("aria-hidden", "true");
    showStep("stepAmount");
    customInput.value = "";
    currentAmount = 0;
    document.querySelectorAll(".chip").forEach((chip) => chip.classList.remove("selected"));
    payNowBtn.textContent = "Pay Now";
}

function renderPaymentArea() {
    document.getElementById("dispAmt").innerText = Number(currentAmount).toLocaleString();
    const area = document.getElementById("dynamicArea");

    if (currentType === "qr") {
        const payload = `NEXUS_${currentMethod}_${currentAmount}`;
        area.innerHTML = `<div class="qr-wrap"><img src="https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(payload)}" alt="QR"></div>`;
        return;
    }

    area.innerHTML = `
        <div class="payment-box">
            <div class="payment-row"><span>A/C Number</span><b>990010045521</b></div>
            <div class="payment-row"><span>IFSC/Code</span><b>NEXS00001</b></div>
        </div>
    `;
}

async function verifyTransaction() {
    payNowBtn.innerHTML = '<div class="loader" style="width:18px;height:18px;border-width:2px;margin:0 auto;"></div>';
    payNowBtn.disabled = true;

    try {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        await recordDepositTransaction();
        document.getElementById("finalAmt").innerText = Number(currentAmount).toLocaleString();
        showStep("stepSuccess");
    } catch (error) {
        alert(error.message || "Deposit could not be completed.");
    } finally {
        payNowBtn.disabled = false;
        payNowBtn.textContent = "Pay Now";
    }
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

function fmtMoney(value) {
    return Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function setAvailableBalance(value) {
    if (!availableBalanceEl) return;
    availableBalanceEl.textContent = fmtMoney(value || 0);
}

function setWithdrawMessage(message, isSuccess) {
    if (!withdrawMessage) return;
    withdrawMessage.textContent = message || "";
    withdrawMessage.classList.remove("success", "error");
    if (!message) return;
    withdrawMessage.classList.add(isSuccess ? "success" : "error");
}

async function syncDepositToLocalState(payload) {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
        const state = JSON.parse(raw);
        if (!state || typeof state !== "object") return;
        const assets = payload?.wallet?.assets && typeof payload.wallet.assets === "object" ? payload.wallet.assets : {};
        state.wallet = { ...(state.wallet || {}), ...assets };
        state.usdt = Number(assets.USDT || payload?.wallet?.usdt || state.usdt || STARTING_USDT);
        if (!state.history || typeof state.history !== "object") {
            state.history = { orders: [], trades: [], transactions: [] };
        }
        if (!Array.isArray(state.history.transactions)) {
            state.history.transactions = [];
        }
        const historyRow = payload?.history_rows?.transaction;
        if (historyRow) {
            state.history.transactions.unshift({
                ...historyRow,
                time: stamp(new Date(historyRow.time || Date.now())),
            });
            state.history.transactions = state.history.transactions.slice(0, 200);
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (error) {
        console.error("Unable to sync local deposit cache.", error);
    }
}

async function recordDepositTransaction() {
    const amount = Number(currentAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error("Please enter a valid deposit amount.");
    }

    const methodText = String(currentMethod || "").toLowerCase();
    const depositAsset = methodText.includes("bitcoin")
        ? "BTC"
        : (methodText.includes("ethereum") ? "ETH" : "USDT");

    const response = await fetch("/api/deposit/simulate/", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-CSRFToken": getCookie("csrftoken"),
        },
        body: JSON.stringify({
            amount,
            asset: depositAsset,
            method: currentMethod,
        }),
    });
    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload?.message || payload?.error || "Deposit failed");
    }
    const newUsdt = payload?.wallet?.wallet?.usdt ?? payload?.wallet?.usdt;
    if (typeof newUsdt === "number") {
        setAvailableBalance(newUsdt);
    }
    await syncDepositToLocalState(payload);
}

async function submitWithdrawal(event) {
    event.preventDefault();
    setWithdrawMessage("", false);

    const amount = Number(withdrawAmountInput?.value || 0);
    const destinationWalletAddress = String(withdrawWalletAddressInput?.value || "").trim();
    const minWithdrawalAmount = Number(bootstrap.minWithdrawalAmount || 10);

    if (!Number.isFinite(amount) || amount <= 0) {
        setWithdrawMessage("Please enter a valid withdrawal amount.", false);
        return;
    }
    if (amount < minWithdrawalAmount) {
        setWithdrawMessage(`Minimum withdrawal amount is ${minWithdrawalAmount} USDT.`, false);
        return;
    }
    if (!destinationWalletAddress) {
        setWithdrawMessage("Wallet address is required for withdrawal.", false);
        return;
    }

    try {
        const response = await fetch("/withdraw/", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-CSRFToken": getCookie("csrftoken"),
            },
            body: JSON.stringify({
                amount,
                wallet_address: destinationWalletAddress,
            }),
        });
        const payload = await response.json();
        if (!response.ok) {
            setWithdrawMessage(payload?.message || payload?.error || "Withdrawal failed.", false);
            return;
        }

        const newUsdt = payload?.wallet?.wallet?.usdt ?? payload?.wallet?.usdt;
        if (typeof newUsdt === "number") {
            setAvailableBalance(newUsdt);
        }
        withdrawAmountInput.value = "";
        setWithdrawMessage(payload?.message || "Withdrawal completed successfully.", true);
    } catch (error) {
        setWithdrawMessage(error?.message || "Unable to process withdrawal right now.", false);
    }
}

document.querySelectorAll(".method-card").forEach((card) => {
    card.addEventListener("click", () => {
        openGateway(card.dataset.name, card.dataset.type);
    });
});

document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
        const val = Number(chip.dataset.amt);
        currentAmount = val;
        customInput.value = val;
        document.querySelectorAll(".chip").forEach((c) => c.classList.remove("selected"));
        chip.classList.add("selected");
    });
});

confirmAmountBtn.addEventListener("click", () => {
    const value = Number(customInput.value);
    currentAmount = value > 0 ? value : 0;
    showStep("stepLoading");

    setTimeout(() => {
        renderPaymentArea();
        showStep("stepPay");
    }, 1200);
});

payNowBtn.addEventListener("click", verifyTransaction);

document.querySelectorAll("[data-close-overlay]").forEach((btn) => {
    btn.addEventListener("click", closeGateway);
});

overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
        closeGateway();
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && overlay.classList.contains("show")) {
        closeGateway();
    }
});

if (methodSearch) {
    methodSearch.addEventListener("input", () => {
        const query = methodSearch.value.trim().toLowerCase();
        document.querySelectorAll(".method-card").forEach((card) => {
            const label = card.innerText.toLowerCase();
            card.style.display = label.includes(query) ? "" : "none";
        });
    });
}

if (withdrawalForm) {
    withdrawalForm.addEventListener("submit", submitWithdrawal);
    setAvailableBalance(bootstrap.initialUSDT || 0);
}
