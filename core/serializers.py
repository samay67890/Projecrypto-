from decimal import Decimal

import requests

from accounts.models import Position, Trade


_BINANCE_PRICE_URL = "https://api.binance.com/api/v3/ticker/price"


def _to_decimal_string(value):
    if value is None:
        return "0"
    if isinstance(value, Decimal):
        return str(value)
    return str(Decimal(str(value)))


class WalletSerializer:
    def __init__(self, wallet, user):
        self.wallet = wallet
        self.user = user

    @property
    def data(self):
        assets = {
            symbol: float(balance)
            for symbol, balance in self.wallet.asset_map().items()
        }
        return {
            "wallet": {
                "usdt": float(self.wallet.balance),
                "btc": float(self.wallet.btc_balance),
                "assets": assets,
                "wallet_address": self.wallet.wallet_address,
                "total_deposits": float(self.wallet.total_deposits),
                "total_withdrawals": float(self.wallet.total_withdrawals),
                "total_fees_paid": float(self.wallet.total_fees_paid),
            },
            "user": {
                "id": self.user.id,
                "email": self.user.email,
            },
            # Backward-compatible fields used by existing frontend code.
            "usdt": float(self.wallet.balance),
            "btc": float(self.wallet.btc_balance),
            "assets": assets,
        }


class TradeSerializer:
    def __init__(self, trade):
        self.trade = trade

    @property
    def data(self):
        return {
            "trade_id": self.trade.trade_id,
            "kind": "trade",
            "user": {
                "id": self.trade.user_id,
                "email": getattr(self.trade.user, "email", None),
            },
            "market_type": getattr(self.trade, "market_type", "spot"),
            "event_type": getattr(self.trade, "event_type", "spot_fill"),
            "coin": self.trade.coin,
            "side": self.trade.side,
            "price": _to_decimal_string(self.trade.price),
            "amount": _to_decimal_string(self.trade.amount),
            "total_value": _to_decimal_string(self.trade.total_value),
            "fee": _to_decimal_string(getattr(self.trade, 'fee', 0)),
            "profit_loss": _to_decimal_string(self.trade.profit_loss),
            "timestamp": self.trade.timestamp.isoformat() if self.trade.timestamp else None,
        }


class WalletTransactionSerializer:
    def __init__(self, tx):
        self.tx = tx

    @property
    def data(self):
        return {
            "kind": "wallet_transaction",
            "reference": self.tx.reference,
            "tx_type": self.tx.tx_type,
            "asset": self.tx.asset,
            "amount": _to_decimal_string(self.tx.amount),
            "fee": _to_decimal_string(getattr(self.tx, 'fee', 0)),
            "method": self.tx.method,
            "status": self.tx.status,
            "details": self.tx.details,
            "timestamp": self.tx.created_at.isoformat() if self.tx.created_at else None,
        }


class PositionSerializer:
    def __init__(self, position):
        self.position = position

    @property
    def data(self):
        return {
            "position_id": self.position.position_id,
            "symbol": self.position.symbol,
            "market_type": self.position.market_type,
            "side": self.position.side,
            "amount": _to_decimal_string(self.position.amount),
            "entry_price": _to_decimal_string(self.position.entry_price),
            "leverage": _to_decimal_string(self.position.leverage),
            "margin": _to_decimal_string(self.position.margin),
            "take_profit": _to_decimal_string(self.position.take_profit) if self.position.take_profit is not None else None,
            "stop_loss": _to_decimal_string(self.position.stop_loss) if self.position.stop_loss is not None else None,
            "status": self.position.status,
            "close_price": _to_decimal_string(self.position.close_price) if self.position.close_price is not None else None,
            "realized_pnl": _to_decimal_string(self.position.realized_pnl),
            "opened_at": self.position.opened_at.isoformat() if self.position.opened_at else None,
            "closed_at": self.position.closed_at.isoformat() if self.position.closed_at else None,
        }


class PortfolioSummarySerializer:
    def __init__(self, *, wallet, trade_count, total_volume):
        self.wallet = wallet
        self.trade_count = trade_count
        self.total_volume = total_volume
        self._price_cache = {"USDT": Decimal("1")}

    def _normalize_base_symbol(self, value):
        symbol = (value or "").upper().strip()
        if symbol.endswith("USDT") and len(symbol) > 4:
            return symbol[:-4]
        return symbol

    def _fetch_live_price_usdt(self, base_symbol):
        symbol = self._normalize_base_symbol(base_symbol)
        if not symbol:
            return Decimal("0")
        if symbol in self._price_cache:
            return self._price_cache[symbol]

        if symbol == "USDT":
            self._price_cache[symbol] = Decimal("1")
            return Decimal("1")

        price = Decimal("0")
        try:
            response = requests.get(
                _BINANCE_PRICE_URL,
                params={"symbol": f"{symbol}USDT"},
                timeout=5,
            )
            if response.ok:
                payload = response.json()
                price = Decimal(str(payload.get("price", "0")))
        except Exception:
            price = Decimal("0")

        # Fallback to latest traded price in local DB when exchange lookup is unavailable.
        if price <= 0:
            latest_trade = (
                Trade.objects
                .filter(user=self.wallet.user, coin=f"{symbol}USDT")
                .order_by("-timestamp")
                .first()
            )
            if latest_trade and latest_trade.price:
                price = Decimal(str(latest_trade.price))

        self._price_cache[symbol] = price
        return price

    def _compute_asset_value(self):
        asset_value = Decimal("0")

        # Include dedicated BTC balance field.
        if self.wallet.btc_balance > 0:
            asset_value += Decimal(str(self.wallet.btc_balance)) * self._fetch_live_price_usdt("BTC")

        # Include all dynamic wallet assets except USDT (already counted in usdt_balance).
        for asset in self.wallet.assets.all():
            base_symbol = self._normalize_base_symbol(asset.symbol)
            if not base_symbol or base_symbol == "USDT":
                continue
            asset_value += Decimal(str(asset.balance)) * self._fetch_live_price_usdt(base_symbol)

        return asset_value

    def _compute_unrealized_pnl(self):
        unrealized_pnl = Decimal("0")
        open_positions = Position.objects.filter(
            user=self.wallet.user,
            status="open",
            market_type__in=["margin", "futures"],
        )
        for position in open_positions:
            base_symbol = self._normalize_base_symbol(position.symbol)
            current_price = self._fetch_live_price_usdt(base_symbol)
            if current_price <= 0:
                continue

            entry_price = Decimal(str(position.entry_price))
            amount = Decimal(str(position.amount))
            side = (position.side or "").lower().strip()
            if side == "long":
                pnl = (current_price - entry_price) * amount
            elif side == "short":
                pnl = (entry_price - current_price) * amount
            else:
                pnl = Decimal("0")
            unrealized_pnl += pnl

        return unrealized_pnl

    @property
    def data(self):
        usdt_balance = Decimal(str(self.wallet.balance))
        asset_value = self._compute_asset_value()
        unrealized_pnl = self._compute_unrealized_pnl()
        equity = usdt_balance + asset_value + unrealized_pnl
        return {
            "equity": float(equity),
            "usdt_balance": float(usdt_balance),
            "asset_value": float(asset_value),
            "unrealized_pnl": float(unrealized_pnl),
            # Backward-compatible fields kept for existing frontend usage.
            "wallet_usdt": float(self.wallet.balance),
            "btc_balance": float(self.wallet.btc_balance),
            "trade_count": int(self.trade_count),
            "total_traded_volume": float(self.total_volume),
        }
