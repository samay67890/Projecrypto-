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

function verifyTransaction() {
    payNowBtn.innerHTML = '<div class="loader" style="width:18px;height:18px;border-width:2px;margin:0 auto;"></div>';
    payNowBtn.disabled = true;

    setTimeout(() => {
        payNowBtn.disabled = false;
        payNowBtn.textContent = "Pay Now";
        recordDepositTransaction();
        document.getElementById("finalAmt").innerText = Number(currentAmount).toLocaleString();
        showStep("stepSuccess");
    }, 1800);
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

function loadDashboardState() {
    const fallback = {
        usdt: STARTING_USDT,
        asset: 0,
        wallet: { USDT: STARTING_USDT, BTC: 0 },
        positions: [],
        futuresPositions: [],
        history: { orders: [], trades: [], transactions: [] },
    };

    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;

    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return fallback;

        if (!parsed.wallet || typeof parsed.wallet !== "object") {
            parsed.wallet = { USDT: STARTING_USDT, BTC: 0 };
        }
        if (!Number.isFinite(Number(parsed.wallet.USDT))) {
            parsed.wallet.USDT = Number.isFinite(Number(parsed.usdt)) ? Number(parsed.usdt) : STARTING_USDT;
        }
        if (!parsed.history || typeof parsed.history !== "object") {
            parsed.history = { orders: [], trades: [], transactions: [] };
        }
        if (!Array.isArray(parsed.history.transactions)) {
            parsed.history.transactions = [];
        }

        return parsed;
    } catch (error) {
        return fallback;
    }
}

function saveDashboardState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function recordDepositTransaction() {
    const amount = Number(currentAmount);
    if (!Number.isFinite(amount) || amount <= 0) return;

    const state = loadDashboardState();
    const methodText = String(currentMethod || "").toLowerCase();
    const depositAsset = methodText.includes("bitcoin")
        ? "BTC"
        : (methodText.includes("ethereum") ? "ETH" : "USDT");

    if (!state.wallet || typeof state.wallet !== "object") state.wallet = {};
    const currentAssetBalance = Math.max(0, Number(state.wallet[depositAsset] || 0));
    state.wallet[depositAsset] = currentAssetBalance + amount;
    if (depositAsset === "USDT") {
        state.usdt = state.wallet.USDT;
    }

    if (!state.history || typeof state.history !== "object") {
        state.history = { orders: [], trades: [], transactions: [] };
    }
    if (!Array.isArray(state.history.transactions)) {
        state.history.transactions = [];
    }

    const txRef = `DP-${Date.now()}-${Math.floor(Math.random() * 1000000).toString().padStart(6, "0")}`;
    state.history.transactions.unshift({
        time: stamp(new Date()),
        asset: depositAsset,
        type: "Deposit",
        amount: `+${fmtMoney(amount)}`,
        status: "Completed",
        txRef,
        details: `${currentMethod} deposit credited to ${depositAsset} wallet (${txRef})`,
    });

    if (state.history.transactions.length > 200) {
        state.history.transactions = state.history.transactions.slice(0, 200);
    }

    saveDashboardState(state);
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
