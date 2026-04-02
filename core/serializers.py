from decimal import Decimal


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

    @property
    def data(self):
        equity = self.wallet.balance
        return {
            "equity": float(equity),
            "wallet_usdt": float(self.wallet.balance),
            "btc_balance": float(self.wallet.btc_balance),
            "trade_count": int(self.trade_count),
            "total_traded_volume": float(self.total_volume),
        }
